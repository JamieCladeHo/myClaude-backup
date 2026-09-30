#!/usr/bin/env python3
"""One-off history backfill from upstream git histories, so charts start with
years of data instead of one point.

    python scripts/backfill.py skypilot --since 2023-06-01 --step 7
    python scripts/backfill.py litellm  --since 2024-01-01 --step 7

- skypilot: skypilot-org/skypilot-catalog is updated by a bot several times a
  day, so its git history is a record of cloud GPU/CPU list prices.
- litellm: BerriAI/litellm's model_prices_and_context_window.json history is a
  record of LLM API price changes (sampled every --step days).

Both write the same files as collect.py and are safe to re-run.
"""
import argparse
import bisect
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from collect import CLOUDS, litellm_snapshot, ref_instance_rows  # noqa: E402
from common import (CPU_FIELDS, GPU_FIELDS, PRICE_FIELDS, REF_FIELDS, aggregate_catalog, http_get, market_rows,  # noqa: E402
                    path, price_events, read_csv, upsert_rows, write_csv, write_json)

REPOS = {"skypilot": "https://github.com/skypilot-org/skypilot-catalog.git",
         "litellm": "https://github.com/BerriAI/litellm.git"}
RAW_SKYPILOT = "https://raw.githubusercontent.com/skypilot-org/skypilot-catalog"


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout


def clone(name, workdir):
    dest = os.path.join(workdir, name)
    if not os.path.isdir(dest):
        # Blobless: history is cheap, file contents are fetched lazily on `git show`.
        subprocess.run(["git", "clone", "-q", "--filter=blob:none", "--no-checkout", REPOS[name], dest], check=True)
    return dest


def sample_dates(since, step):
    d, today = dt.date.fromisoformat(since), dt.date.today()
    while d < today:
        yield d
        d += dt.timedelta(days=step)
    yield today


def rev_at(repo, date, file):
    """Last commit touching `file` before the end of `date` (None if the file didn't exist yet)."""
    out = git(repo, "rev-list", "-1", f"--before={date}T23:59:59Z", "HEAD", "--", file).strip()
    return out or None


def file_history(repo, f):
    """[(commit_time, sha)] oldest→newest for every commit touching f."""
    out = git(repo, "log", "--format=%ct %H", "HEAD", "--", f).split("\n")
    return sorted((int(t), h) for t, h in (line.split() for line in out if line))


def backfill_skypilot(repo, dates):
    versions = sorted({p.split("/")[1] for p in git(repo, "ls-tree", "-d", "--name-only", "HEAD", "catalogs/").split()
                       if p.split("/")[1].startswith("v")}, key=lambda v: int(v[1:]), reverse=True)
    hist = {(c, v): file_history(repo, f"catalogs/{v}/{c}/vms.csv") for c in CLOUDS for v in versions}

    # 1) Decide which (sha, file) each (date, cloud) uses: the newest catalog
    #    schema that existed then, at its last commit before end of that day.
    plan = {}
    for d in dates:
        cutoff = dt.datetime.combine(d, dt.time(23, 59, 59), dt.timezone.utc).timestamp()
        for c in CLOUDS:
            for v in versions:
                i = bisect.bisect_right(hist[(c, v)], (cutoff, "~")) - 1
                if i >= 0:
                    plan[(d, c)] = (hist[(c, v)][i][1], f"catalogs/{v}/{c}/vms.csv")
                    break

    # 2) Download each distinct file version once, in parallel, from raw.githubusercontent.com
    #    (much faster than lazily fetching blobs one by one through a partial clone).
    def fetch(key):
        sha, f = key
        c = f.split("/")[2]
        g, cpu, inst = aggregate_catalog(c, http_get(f"{RAW_SKYPILOT}/{sha}/{f}", timeout=180))
        return key, (g, cpu, ref_instance_rows(c, inst, ""))  # keep only the few reference boxes

    parsed = {}
    todo = sorted(set(plan.values()))
    with ThreadPoolExecutor(8) as ex:
        for n, (key, res) in enumerate(ex.map(fetch, todo), 1):
            parsed[key] = res
            if n % 50 == 0:
                print(f"fetched {n}/{len(todo)} catalog versions", flush=True)

    for d in dates:
        gpu, cpu, refs = [], [], []
        for c in CLOUDS:
            if (d, c) not in plan:
                continue
            g, cr, rf = parsed[plan[(d, c)]]
            gpu += [dict(r) for r in g]
            if cr:
                cpu.append(dict(cr))
            refs += [dict(r, date=d.isoformat()) for r in rf]
        gpu += market_rows(gpu)
        for r in gpu + cpu:
            r.update(date=d.isoformat(), source="skypilot")
        upsert_rows(path("compute", "gpu_daily.csv"), GPU_FIELDS, gpu, ["date", "source"])
        upsert_rows(path("compute", "cpu_daily.csv"), CPU_FIELDS, cpu, ["date", "source"])
        upsert_rows(path("compute", "ref_instances.csv"), REF_FIELDS, refs, ["date"])
        print(d, len(gpu), "gpu rows", len(cpu), "cpu rows", flush=True)


def backfill_litellm(repo, dates):
    f = "model_prices_and_context_window.json"
    prev, events, last_rev = {}, [], None
    for d in dates:
        rev = rev_at(repo, d, f)
        if not rev or rev == last_rev:
            continue
        last_rev = rev
        try:
            snap = litellm_snapshot(json.loads(git(repo, "show", f"{rev}:{f}")))
        except (json.JSONDecodeError, subprocess.CalledProcessError) as e:
            print(d, "skip:", e)
            continue
        ev = price_events(d.isoformat(), "litellm", prev, snap)
        events += ev
        prev = snap
        print(d, len(snap), "models", len(ev), "events", flush=True)
    # Replace all litellm history with the rebuilt one; other sources untouched.
    hist_p = path("llm", "price_changes.csv")
    others = [r for r in read_csv(hist_p) if r["source"] != "litellm"]
    write_csv(hist_p, PRICE_FIELDS, sorted(others + events, key=lambda r: (r["date"], r["source"], r["model"])))
    write_json(path("llm", "latest_litellm.json"), prev)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["skypilot", "litellm", "all"])
    ap.add_argument("--since", default="2024-01-01")
    ap.add_argument("--step", type=int, default=7, help="days between samples")
    ap.add_argument("--workdir", default=os.path.join(tempfile.gettempdir(), "ai-tracker-backfill"))
    a = ap.parse_args()
    os.makedirs(a.workdir, exist_ok=True)
    dates = list(sample_dates(a.since, a.step))
    if a.what in ("skypilot", "all"):
        backfill_skypilot(clone("skypilot", a.workdir), dates)
    if a.what in ("litellm", "all"):
        backfill_litellm(clone("litellm", a.workdir), dates)


if __name__ == "__main__":
    main()

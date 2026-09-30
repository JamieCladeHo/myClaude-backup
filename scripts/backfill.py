#!/usr/bin/env python3
"""One-off history backfill, so charts start with history instead of one point.

    python scripts/backfill.py skypilot         --since 2024-01-01 --step 7
    python scripts/backfill.py litellm          --since 2023-06-01 --step 7
    python scripts/backfill.py openrouter-usage --since 2025-01-01

- skypilot: skypilot-org/skypilot-catalog is updated by a bot several times a
  day, so its git history is a record of cloud GPU/CPU list prices.
- litellm: BerriAI/litellm's model_prices_and_context_window.json history is a
  record of LLM API price changes (sampled every --step days).
- openrouter-usage: daily token totals. Uses OPENROUTER_API_KEY if set,
  otherwise imports a public CC BY 4.0 archive of the same endpoint.

All write the same files as collect.py and are safe to re-run.
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import compute  # noqa: E402
import usage  # noqa: E402
from collect import litellm_snapshot  # noqa: E402
from common import PRICE_FIELDS, path, price_events, read_csv, write_csv, write_json  # noqa: E402

LITELLM_REPO = "https://github.com/BerriAI/litellm.git"


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout


def sample_dates(since, step):
    d, today = dt.date.fromisoformat(since), dt.date.today()
    out = []
    while d < today:
        out.append(d)
        d += dt.timedelta(days=step)
    return out + [today]


def backfill_litellm(workdir, dates):
    repo = os.path.join(workdir, "litellm")
    if not os.path.isdir(repo):
        subprocess.run(["git", "clone", "-q", "--filter=blob:none", "--no-checkout", LITELLM_REPO, repo], check=True)
    f = "model_prices_and_context_window.json"
    prev, events, last_rev = {}, [], None
    for d in dates:
        rev = git(repo, "rev-list", "-1", f"--before={d}T23:59:59Z", "HEAD", "--", f).strip()
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
    ap.add_argument("what", choices=["skypilot", "litellm", "openrouter-usage", "all"])
    ap.add_argument("--since", default=None, help="default: 2024-01-01 (2025-01-01 for openrouter-usage)")
    ap.add_argument("--step", type=int, default=7, help="days between samples")
    ap.add_argument("--workdir", default=os.path.join(tempfile.gettempdir(), "ai-tracker-work"))
    a = ap.parse_args()
    os.makedirs(a.workdir, exist_ok=True)
    if a.what in ("skypilot", "all"):
        print(compute.run(sample_dates(a.since or "2024-01-01", a.step), a.workdir))
    if a.what in ("litellm", "all"):
        backfill_litellm(a.workdir, sample_dates(a.since or "2023-06-01", a.step))
    if a.what in ("openrouter-usage", "all"):
        usage.backfill_openrouter_usage(a.since or "2025-01-01", a.workdir)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Daily collector. Run by .github/workflows/collect.yml, or locally:

    python scripts/collect.py              # all collectors
    python scripts/collect.py skypilot     # just one

Each collector is independent: a failing source is logged in
docs/data/meta/status.json and the others still run.
"""
import datetime as dt
import json
import statistics
import sys
import traceback
import urllib.parse

from common import (CPU_FIELDS, GPU_FIELDS, PRICE_FIELDS, REF_FIELDS, aggregate_catalog, http_get, http_json,
                    market_rows, norm_gpu, path, price_events, r4, read_csv, read_json, upsert_rows, write_csv,
                    write_json)

TODAY = dt.datetime.now(dt.timezone.utc).date().isoformat()

# ------------------------------------------------------------------ LLM prices

LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
# Model vendors selling their own models; resellers (bedrock, azure, openrouter…) are left out.
FIRST_PARTY = {"openai", "anthropic", "gemini", "deepseek", "xai", "mistral", "dashscope", "moonshot",
               "zai", "minimax", "volcengine", "cohere_chat", "perplexity"}


def litellm_snapshot(raw):
    snap = {}
    for model, v in raw.items():
        if not isinstance(v, dict) or v.get("mode") not in ("chat", "responses"):
            continue
        if v.get("litellm_provider") not in FIRST_PARTY or model.startswith("ft:"):
            continue
        i, o = v.get("input_cost_per_token"), v.get("output_cost_per_token")
        if i is None or o is None:
            continue
        snap[model] = {"provider": v["litellm_provider"], "input": round(i * 1e6, 4), "output": round(o * 1e6, 4),
                       "context": v.get("max_input_tokens") or v.get("max_tokens") or ""}
    return snap


def openrouter_snapshot(data):
    snap = {}
    for m in data["data"]:
        pr = m.get("pricing") or {}
        try:
            i, o = float(pr.get("prompt")), float(pr.get("completion"))
        except (TypeError, ValueError):
            continue
        if i < 0 or o < 0:  # "-1" marks router/meta models with variable pricing
            continue
        snap[m["id"]] = {"provider": m["id"].split("/")[0], "input": round(i * 1e6, 4), "output": round(o * 1e6, 4),
                         "context": m.get("context_length") or "",
                         "created": dt.datetime.fromtimestamp(m.get("created") or 0, dt.timezone.utc).date().isoformat()}
    return snap


def record_prices(source, snap):
    latest_p = path("llm", f"latest_{source}.json")
    prev = read_json(latest_p, {})
    events = price_events(TODAY, source, prev, snap)
    if events:
        hist_p = path("llm", "price_changes.csv")
        rows = [r for r in read_csv(hist_p) if not (r["date"] == TODAY and r["source"] == source)]
        write_csv(hist_p, PRICE_FIELDS, rows + events)
    write_json(latest_p, snap)
    return {"models": len(snap), "events": len(events)}


def collect_litellm():
    return record_prices("litellm", litellm_snapshot(json.loads(http_get(LITELLM_URL))))


def collect_openrouter():
    return record_prices("openrouter", openrouter_snapshot(http_json("https://openrouter.ai/api/v1/models")))


# ------------------------------------------------------------ GPU / CPU rents

SKYPILOT = "https://raw.githubusercontent.com/skypilot-org/skypilot-catalog/master/catalogs/{ver}/{cloud}/vms.csv"
SKYPILOT_VERSION = "v8"
CLOUDS = ["aws", "gcp", "azure", "lambda", "runpod", "nebius", "vast", "cudo",
          "paperspace", "fluidstack", "do", "hyperbolic"]
# A fixed, comparable "4 vCPU / 16 GiB general purpose" box on each big cloud.
REF_INSTANCES = [("aws", "m7i.xlarge", "us-east-1"), ("aws", "m5.xlarge", "us-east-1"),
                 ("gcp", "n2-standard-4", "us-central1"), ("azure", "Standard_D4s_v5", "eastus")]


def ref_instance_rows(cloud, instances, date):
    rows = []
    for rc, itype, region in REF_INSTANCES:
        if rc == cloud and (itype, region) in instances:
            vcpus, mem, price, spot = instances[(itype, region)]
            rows.append({"date": date, "cloud": cloud, "instance": itype, "region": region, "vcpus": vcpus,
                         "memory_gib": mem, "usd_per_hr": price, "spot_usd_per_hr": spot or ""})
    return rows


def collect_skypilot():
    gpu_rows, cpu_rows, ref_rows, errors = [], [], [], {}
    for cloud in CLOUDS:
        try:
            text = http_get(SKYPILOT.format(ver=SKYPILOT_VERSION, cloud=cloud), timeout=120)
        except Exception as e:  # one missing catalog shouldn't sink the rest
            errors[cloud] = str(e)
            continue
        g, c, inst = aggregate_catalog(cloud, text)
        gpu_rows += g
        if c:
            cpu_rows.append(c)
        ref_rows += ref_instance_rows(cloud, inst, TODAY)
    gpu_rows += market_rows(gpu_rows)
    for r in gpu_rows + cpu_rows:
        r.update(date=TODAY, source="skypilot")
    upsert_rows(path("compute", "gpu_daily.csv"), GPU_FIELDS, gpu_rows, ["date", "source"])
    upsert_rows(path("compute", "cpu_daily.csv"), CPU_FIELDS, cpu_rows, ["date", "source"])
    upsert_rows(path("compute", "ref_instances.csv"), REF_FIELDS, ref_rows, ["date"])
    if not gpu_rows:
        raise RuntimeError(f"no catalogs fetched: {errors}")
    return {"gpu_rows": len(gpu_rows), "cpu_rows": len(cpu_rows), "catalog_errors": errors}


def collect_vast():
    """Live Vast.ai marketplace (peer-to-peer GPUs): the most market-driven price signal."""
    q = {"rentable": {"eq": True}, "rented": {"eq": False}, "type": "on-demand", "limit": 10000}
    url = "https://console.vast.ai/api/v0/bundles/?q=" + urllib.parse.quote(json.dumps(q))
    offers = http_json(url, timeout=120).get("offers", [])
    per = {}
    for o in offers:
        n, price = o.get("num_gpus") or 0, o.get("dph_total") or 0
        fam = norm_gpu(o.get("gpu_name", ""), (o.get("gpu_ram") or 0) / 1024)
        if fam and n >= 1 and price > 0:
            per.setdefault(fam, []).append(price / n)
    rows = [{"date": TODAY, "source": "vast_live", "cloud": "vast", "gpu": fam, "offers": len(v),
             "min_usd_per_gpu_hr": r4(min(v)), "median_usd_per_gpu_hr": r4(statistics.median(v)),
             "spot_min_usd_per_gpu_hr": ""} for fam, v in sorted(per.items()) if len(v) >= 3]
    if not rows:
        raise RuntimeError(f"no usable offers (got {len(offers)})")
    upsert_rows(path("compute", "gpu_daily.csv"), GPU_FIELDS, rows, ["date", "source"])
    return {"offers": len(offers), "gpu_types": len(rows)}


COLLECTORS = {"litellm": collect_litellm, "openrouter": collect_openrouter,
              "skypilot": collect_skypilot, "vast": collect_vast}


def main(names):
    status_p = path("meta", "status.json")
    status = read_json(status_p, {})
    failed = 0
    for name in names or COLLECTORS:
        try:
            info = COLLECTORS[name]()
            status[name] = {"ok": True, "last_success": TODAY, **info}
            print(f"[ok]   {name}: {info}")
        except Exception as e:
            failed += 1
            status.setdefault(name, {}).update(ok=False, last_error=f"{TODAY}: {e}")
            print(f"[fail] {name}: {e}")
            traceback.print_exc()
    status["_updated"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    write_json(status_p, status)
    # Only fail the job when everything failed; partial data is still worth committing.
    return 1 if failed == len(names or COLLECTORS) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

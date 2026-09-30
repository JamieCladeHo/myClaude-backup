"""Shared helpers: HTTP, CSV storage, GPU name normalization, aggregation.

Only the Python standard library is used so the GitHub Action needs no installs.
"""
import csv
import io
import json
import os
import re
import statistics
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data")

UA = "ai-cost-tracker/1.0 (+https://github.com)"


def http_get(url, timeout=60, headers=None, method="GET", body=None):
    data = None
    hdrs = {"User-Agent": UA, **(headers or {})}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")


def http_json(url, **kw):
    return json.loads(http_get(url, **kw))


def path(*parts):
    p = os.path.join(DATA, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


def read_csv(p):
    if not os.path.exists(p):
        return []
    with open(p, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(p, fields, rows):
    with open(p, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fields})


def upsert_rows(p, fields, new_rows, key_fields):
    """Replace rows sharing a key (e.g. same date+source) and keep the rest.

    Makes every collector idempotent: re-running on the same day overwrites
    that day's snapshot instead of duplicating it.
    """
    keys = {tuple(r[k] for k in key_fields) for r in new_rows}
    kept = [r for r in read_csv(p) if tuple(r[k] for k in key_fields) not in keys]
    rows = kept + [{k: str(v) for k, v in r.items()} for r in new_rows]
    rows.sort(key=lambda r: tuple(r[f] for f in fields[:4]))
    write_csv(p, fields, rows)


def read_json(p, default=None):
    if not os.path.exists(p):
        return default
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def write_json(p, obj):
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")


def fnum(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v == v else None  # drop NaN


def r4(x):
    return "" if x is None else round(x, 4)


# ---------------------------------------------------------------- GPU names

_SKIP = ("TPU", "INFERENTIA", "TRAINIUM", "VIRTEX", "MIG", "RADEON", "K80", "M60")
# Order matters: longer / more specific names first (L40S before L40 before L4).
_FAMILIES = [
    "GB300", "GB200", "GH200", "B300", "B200", "H200", "H100", "H800",
    "MI355X", "MI350X", "MI325X", "MI300X",
    "A100", "A10G", "A10", "A40", "L40S", "L40", "L4",
    "RTXPRO6000", "RTX6000ADA", "A6000", "RTX5090", "RTX4090", "RTX3090",
    "V100", "T4",
]


def norm_gpu(name, mem_gb=None):
    """Map provider-specific accelerator names onto a common family key."""
    if not name:
        return None
    n = re.sub(r"[^A-Z0-9]", "", name.upper())
    if any(s in n for s in _SKIP):
        return None
    for fam in _FAMILIES:
        if fam in n:
            if fam == "A100" and ("80GB" in n or (mem_gb or 0) > 50):
                return "A100-80GB"
            return fam
    return n or None


def gpu_mem_gb(gpu_info):
    m = re.search(r"SizeInMiB'?\"?:\s*(\d+)", gpu_info or "")
    return int(m.group(1)) / 1024 if m else None


# -------------------------------------------------------- catalog aggregation

def aggregate_catalog(cloud, csv_text):
    """Turn a SkyPilot vms.csv into per-GPU price summaries plus a CPU instance table.

    Returns (gpu_rows, instances) where instances maps CPU-only
    (instance_type, region) -> (vcpus, mem, price, spot).
    """
    # One row per (instance, region): on-demand is the same in every availability zone,
    # spot differs per zone, so keep the cheapest zone (what a buyer would pick).
    rows = {}
    for r in csv.DictReader(io.StringIO(csv_text)):
        key = (r.get("InstanceType", ""), r.get("Region", ""))
        spot = fnum(r.get("SpotPrice"))
        spot = spot if spot and spot > 0 else None
        if key in rows:
            old = rows[key][1]
            rows[key] = (rows[key][0], min(x for x in (old, spot) if x) if (old or spot) else None)
        else:
            rows[key] = (r, spot)

    per_gpu = {}   # family -> list of (on-demand $/GPU-hr, spot $/GPU-hr|None)
    instances = {}
    for (itype, region), (r, spot) in rows.items():
        price = fnum(r.get("Price"))
        price = price if price and price > 0 else None
        acc, cnt = r.get("AcceleratorName", ""), fnum(r.get("AcceleratorCount"))
        if acc:
            fam = norm_gpu(acc, gpu_mem_gb(r.get("GpuInfo")))
            if fam and cnt and cnt >= 1 and price:
                per_gpu.setdefault(fam, []).append((price / cnt, spot / cnt if spot else None))
        elif price or spot:
            instances[(itype, region)] = (fnum(r.get("vCPUs")), fnum(r.get("MemoryGiB")), price, spot)

    gpu_rows = [gpu_summary(cloud, fam, vals) for fam, vals in sorted(per_gpu.items())]
    return gpu_rows, instances


def gpu_summary(cloud, fam, vals):
    od = [v[0] for v in vals]
    sp = [v[1] for v in vals if v[1]]
    return {"cloud": cloud, "gpu": fam, "offers": len(od),
            "min_usd_per_gpu_hr": r4(min(od)),
            "median_usd_per_gpu_hr": r4(statistics.median(od)),
            "spot_min_usd_per_gpu_hr": r4(min(sp) if sp else None)}


def sane(prices):
    """Drop catalog errors: a provider under 1/4 of the cross-provider median (e.g. a $0.12 H100)."""
    if len(prices) < 3:
        return prices
    m = statistics.median(prices)
    return [p for p in prices if p >= m / 4]


def market_rows(gpu_rows):
    """Cross-provider index per GPU: cheapest provider and median of provider minima."""
    by = {}
    for r in gpu_rows:
        if r["cloud"] != "ALL":
            by.setdefault(r["gpu"], []).append(r)
    out = []
    for gpu, rs in sorted(by.items()):
        mins = sane([float(r["min_usd_per_gpu_hr"]) for r in rs])
        spots = sane([float(r["spot_min_usd_per_gpu_hr"]) for r in rs if r["spot_min_usd_per_gpu_hr"] != ""])
        out.append({
            "cloud": "ALL", "gpu": gpu, "offers": len(rs),
            "min_usd_per_gpu_hr": r4(min(mins)),
            "median_usd_per_gpu_hr": r4(statistics.median(mins)),
            "spot_min_usd_per_gpu_hr": r4(min(spots) if spots else None),
        })
    return out


# ------------------------------------------------------------ LLM prices

def price_events(date, source, prev, cur):
    """Diff two {model: {provider,input,output}} snapshots into change events."""
    events = []
    for m, v in cur.items():
        p = prev.get(m)
        if p is None:
            ev = "new"
        elif (p.get("input"), p.get("output")) != (v.get("input"), v.get("output")):
            ev = "change"
        else:
            continue
        events.append({"date": date, "source": source, "model": m, "provider": v.get("provider", ""),
                       "input_usd_per_mtok": v.get("input", ""), "output_usd_per_mtok": v.get("output", ""),
                       "event": ev})
    for m, p in prev.items():
        if m not in cur:
            events.append({"date": date, "source": source, "model": m, "provider": p.get("provider", ""),
                           "input_usd_per_mtok": "", "output_usd_per_mtok": "", "event": "removed"})
    return events


PRICE_FIELDS = ["date", "source", "model", "provider", "input_usd_per_mtok", "output_usd_per_mtok", "event"]
GPU_FIELDS = ["date", "source", "cloud", "gpu", "offers", "min_usd_per_gpu_hr",
              "median_usd_per_gpu_hr", "spot_min_usd_per_gpu_hr"]

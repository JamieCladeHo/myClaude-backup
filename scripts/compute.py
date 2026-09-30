"""GPU / CPU cloud prices from the SkyPilot catalog's git history (+ Azure retail API).

Daily runs and history backfills share one code path: pick, for every sample
date and cloud, the catalog version committed on or before that date, skip it
if it is stale (several SkyPilot catalogs are frozen, e.g. Azure since 2025-09),
and aggregate it.

Outputs (docs/data/compute/):
    gpu_daily.csv        per GPU family & cloud: min / median / spot-min $/GPU-hr
    cpu_index.csv        same-instance price index (chained), spot discount
    cpu_generations.csv  4 vCPU general-purpose box of each instance generation
"""
import bisect
import datetime as dt
import math
import os
import statistics
import subprocess
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

from common import (GPU_FIELDS, aggregate_catalog, gpu_summary, http_get, http_json, market_rows, path,
                    read_csv, upsert_rows)

REPO = "https://github.com/skypilot-org/skypilot-catalog.git"
RAW = "https://raw.githubusercontent.com/skypilot-org/skypilot-catalog"
# Azure, Paperspace and DigitalOcean are left out: their SkyPilot catalogs are static snapshots
# (Azure prices come from Azure's own retail API below).
CLOUDS = ["aws", "gcp", "lambda", "runpod", "nebius", "vast", "cudo", "fluidstack", "hyperbolic"]
# The catalog bot only commits when prices change, so a quiet period is normal. But a cloud
# whose last commit is this old has lost its fetcher: use its data only shortly past that commit.
ABANDONED_DAYS, GRACE_DAYS = 60, 30
INDEX_CLOUDS = ["aws", "gcp"]  # clouds whose SkyPilot CPU catalogs are maintained

INDEX_FIELDS = ["date", "cloud", "od_index", "spot_index", "od_changed_pct", "spot_discount_pct", "matched"]
GEN_FIELDS = ["date", "cloud", "region", "line", "generation", "instance", "vcpus", "memory_gib",
              "usd_per_hr", "spot_usd_per_hr"]

# (cloud, region, product line, [(generation label, instance type)]) — 4 vCPU boxes.
GENERATIONS = [
    ("aws", "us-east-1", "Intel 通用型 (m)", [("m4", "m4.xlarge"), ("m5", "m5.xlarge"), ("m6i", "m6i.xlarge"),
                                            ("m7i", "m7i.xlarge"), ("m8i", "m8i.xlarge")]),
    ("aws", "us-east-1", "AMD 通用型 (m-a)", [("m5a", "m5a.xlarge"), ("m6a", "m6a.xlarge"), ("m7a", "m7a.xlarge"),
                                             ("m8a", "m8a.xlarge")]),
    ("aws", "us-east-1", "Graviton ARM (m-g)", [("m6g", "m6g.xlarge"), ("m7g", "m7g.xlarge"), ("m8g", "m8g.xlarge")]),
    ("gcp", "us-central1", "Intel 通用型 (N)", [("N1", "n1-standard-4"), ("N2", "n2-standard-4"),
                                              ("N4", "n4-standard-4")]),
    ("gcp", "us-central1", "AMD 通用型 (N-D)", [("N2D", "n2d-standard-4"), ("N4D", "n4d-standard-4")]),
    ("gcp", "us-central1", "ARM 通用型", [("T2A", "t2a-standard-4"), ("N4A", "n4a-standard-4")]),
    ("azure", "eastus", "Intel 通用型 (Ds)", [("Dsv3", "Standard_D4s_v3"), ("Dsv4", "Standard_D4s_v4"),
                                            ("Dsv5", "Standard_D4s_v5"), ("Dsv6", "Standard_D4s_v6")]),
    ("azure", "eastus", "AMD 通用型 (Das)", [("Dasv4", "Standard_D4as_v4"), ("Dasv5", "Standard_D4as_v5"),
                                           ("Dasv6", "Standard_D4as_v6")]),
    ("azure", "eastus", "ARM 通用型 (Dps)", [("Dpsv5", "Standard_D4ps_v5"), ("Dpsv6", "Standard_D4ps_v6")]),
]


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout


def clone(workdir):
    dest = os.path.join(workdir, "skypilot")
    if os.path.isdir(dest):
        subprocess.run(["git", "-C", dest, "fetch", "-q", "origin"], check=True)
        subprocess.run(["git", "-C", dest, "update-ref", "HEAD", "FETCH_HEAD"], check=True)
    else:
        # Blobless: commit history only; file contents are downloaded per needed version.
        subprocess.run(["git", "clone", "-q", "--filter=blob:none", "--no-checkout", REPO, dest], check=True)
    return dest


def plan_versions(repo, dates):
    """{(date, cloud): (sha, file)}: newest schema version with a commit on/before that date."""
    versions = sorted({p.split("/")[1] for p in git(repo, "ls-tree", "-d", "--name-only", "HEAD", "catalogs/").split()
                       if p.split("/")[1].startswith("v")}, key=lambda v: int(v[1:]), reverse=True)
    hist = {}
    for c in CLOUDS:
        for v in versions:
            f = f"catalogs/{v}/{c}/vms.csv"
            out = git(repo, "log", "--format=%ct %H", "HEAD", "--", f).split("\n")
            hist[(c, v)] = sorted((int(t), h) for t, h in (line.split() for line in out if line))
    now = dt.datetime.now(dt.timezone.utc).timestamp()
    valid_until = {}
    for c in CLOUDS:
        last = max((h[-1][0] for (cc, _), h in hist.items() if cc == c and h), default=0)
        valid_until[c] = last + GRACE_DAYS * 86400 if now - last > ABANDONED_DAYS * 86400 else float("inf")
    plan = {}
    for d in dates:
        cutoff = dt.datetime.combine(d, dt.time(23, 59, 59), dt.timezone.utc).timestamp()
        for c in CLOUDS:
            if cutoff > valid_until[c]:
                continue
            for v in versions:
                h = hist[(c, v)]
                i = bisect.bisect_right(h, (cutoff, "~")) - 1
                if i >= 0:
                    plan[(d, c)] = (h[i][1], f"catalogs/{v}/{c}/vms.csv")
                    break
    return plan


def fetch_catalog(key):
    sha, f = key
    return aggregate_catalog(f.split("/")[2], http_get(f"{RAW}/{sha}/{f}", timeout=180))


def ratio_stats(prev, cur):
    """Mean log price ratio over instances present (and priced) in both snapshots."""
    od, sp, changed = [], [], 0
    for k, (_, _, p, ps) in cur.items():
        q = prev.get(k)
        if not q:
            continue
        if p and q[2]:
            r = math.log(p / q[2])
            if abs(r) < math.log(3):  # ignore obvious catalog glitches
                od.append(r)
                changed += abs(r) > 1e-6
        if ps and q[3]:
            r = math.log(ps / q[3])
            if abs(r) < math.log(3):
                sp.append(r)
    return (statistics.fmean(od) if od else 0.0, statistics.fmean(sp) if sp else 0.0,
            100 * changed / len(od) if od else 0.0, len(od))


def spot_discount(cur):
    d = [1 - s / p for (_, _, p, s) in cur.values() if p and s and s < p]
    return 100 * statistics.median(d) if d else None


def generation_rows(cloud, instances, date):
    rows = []
    for c, region, line, gens in GENERATIONS:
        if c != cloud:
            continue
        for label, itype in gens:
            v = instances.get((itype, region))
            if v:
                vcpus, mem, price, spot = v
                rows.append({"date": date, "cloud": c, "region": region, "line": line, "generation": label,
                             "instance": itype, "vcpus": vcpus, "memory_gib": mem, "usd_per_hr": price,
                             "spot_usd_per_hr": spot or ""})
    return rows


def run(dates, workdir, log=print):
    """Aggregate SkyPilot catalogs for the given dates (ascending) and upsert all outputs."""
    repo = clone(workdir)
    idx_p = path("compute", "cpu_index.csv")
    idx_rows = read_csv(idx_p)
    # Chain from the last index row before our first date (daily runs extend yesterday's value).
    last = {}
    for r in idx_rows:
        if r["date"] < dates[0].isoformat():
            last[r["cloud"]] = r
    prev_dates = {c: dt.date.fromisoformat(r["date"]) for c, r in last.items()}
    plan = plan_versions(repo, sorted(set(dates) | set(prev_dates.values())))

    state = {}  # cloud -> (index_od, index_spot, instances) of the previous sample
    for c, r in last.items():
        key = plan.get((prev_dates[c], c))
        if key:
            state[c] = (float(r["od_index"]), float(r["spot_index"]), fetch_catalog(key)[1])

    parsed, stats = {}, {"dates": 0, "stale_skipped": 0}
    with ThreadPoolExecutor(8) as ex:
        for i in range(0, len(dates), 12):  # bounded memory: parse a dozen dates at a time
            chunk = dates[i:i + 12]
            need = sorted({plan[(d, c)] for d in chunk for c in CLOUDS if (d, c) in plan} - set(parsed))
            parsed.update(zip(need, ex.map(fetch_catalog, need)))
            for d in chunk:
                ds = d.isoformat()
                gpu, idx, gens = [], [], []
                for c in CLOUDS:
                    key = plan.get((d, c))
                    if not key:
                        stats["stale_skipped"] += 1
                        continue
                    g, inst = parsed[key]
                    gpu += [dict(r) for r in g]
                    gens += generation_rows(c, inst, ds)
                    if c in INDEX_CLOUDS:
                        if c in state:
                            od, sp, chg, n = ratio_stats(state[c][2], inst)
                            io, isp = state[c][0] * math.exp(od), state[c][1] * math.exp(sp)
                        else:
                            io, isp, chg, n = 100.0, 100.0, 0.0, len(inst)
                        state[c] = (io, isp, inst)
                        disc = spot_discount(inst)
                        idx.append({"date": ds, "cloud": c, "od_index": round(io, 3), "spot_index": round(isp, 3),
                                    "od_changed_pct": round(chg, 2),
                                    "spot_discount_pct": "" if disc is None else round(disc, 1), "matched": n})
                gpu += market_rows(gpu)
                for r in gpu:
                    r.update(date=ds, source="skypilot")
                upsert_rows(path("compute", "gpu_daily.csv"), GPU_FIELDS, gpu, ["date", "source"])
                upsert_rows(idx_p, INDEX_FIELDS, idx, ["date", "cloud"])
                upsert_rows(path("compute", "cpu_generations.csv"), GEN_FIELDS, gens, ["date", "cloud"])
                stats["dates"] += 1
                log(ds, len(gpu), "gpu rows", len(idx), "index rows", len(gens), "generation rows")
            # Drop parsed catalogs no longer needed by later dates.
            keep = {plan[(d, c)] for d in dates[i + 12:] for c in CLOUDS if (d, c) in plan}
            parsed = {k: v for k, v in parsed.items() if k in keep}
    return stats


# ------------------------------------------------------------- Azure retail

AZURE_API = "https://prices.azure.com/api/retail/prices"
# (armSkuName, GPU family, GPUs per VM)
AZURE_GPU_SKUS = [
    ("Standard_ND96isr_H200_v5", "H200", 8), ("Standard_ND96isr_H100_v5", "H100", 8),
    ("Standard_NC40ads_H100_v5", "H100", 1), ("Standard_ND96isr_MI300X_v5", "MI300X", 8),
    ("Standard_ND96amsr_A100_v4", "A100-80GB", 8), ("Standard_NC24ads_A100_v4", "A100-80GB", 1),
    ("Standard_ND96asr_v4", "A100", 8), ("Standard_NV36ads_A10_v5", "A10", 1), ("Standard_NC4as_T4_v3", "T4", 1),
]


def azure_prices(sku, region=None):
    """{region: (on-demand, spot)} Linux pay-as-you-go hourly prices for one VM size."""
    flt = f"serviceName eq 'Virtual Machines' and armSkuName eq '{sku}' and priceType eq 'Consumption'"
    if region:
        flt += f" and armRegionName eq '{region}'"
    url, items = AZURE_API + "?$filter=" + urllib.parse.quote(flt), []
    for _ in range(10):  # follow pagination
        page = http_json(url, timeout=60)
        items += page.get("Items", [])
        url = page.get("NextPageLink")
        if not url:
            break
    out = {}
    for i in items:
        if "Windows" in i.get("productName", "") or "Low Priority" in i.get("skuName", "") \
                or i.get("unitOfMeasure") != "1 Hour" or not i.get("retailPrice"):
            continue
        od, sp = out.get(i["armRegionName"], (None, None))
        if "Spot" in i.get("skuName", ""):
            sp = min(sp or 1e9, i["retailPrice"])
        else:
            od = min(od or 1e9, i["retailPrice"])
        out[i["armRegionName"]] = (od, sp)
    return out


def collect_azure(date):
    """SkyPilot's Azure catalog is frozen, so read Azure's public retail price API directly."""
    gens = []
    for c, region, line, glist in GENERATIONS:
        if c != "azure":
            continue
        for label, sku in glist:
            od, sp = azure_prices(sku, region).get(region, (None, None))
            if od:
                gens.append({"date": date, "cloud": "azure", "region": region, "line": line, "generation": label,
                             "instance": sku, "vcpus": 4, "memory_gib": 16, "usd_per_hr": od,
                             "spot_usd_per_hr": sp or ""})
    per_gpu = {}
    for sku, fam, n in AZURE_GPU_SKUS:
        for od, sp in azure_prices(sku).values():
            if od:
                per_gpu.setdefault(fam, []).append((od / n, sp / n if sp else None))
    gpu = [dict(gpu_summary("azure", fam, v), date=date, source="azure_retail") for fam, v in sorted(per_gpu.items())]
    if not gens and not gpu:
        raise RuntimeError("Azure retail API returned no prices")
    upsert_rows(path("compute", "cpu_generations.csv"), GEN_FIELDS, gens, ["date", "cloud"])
    upsert_rows(path("compute", "gpu_daily.csv"), GPU_FIELDS, gpu, ["date", "source"])
    return {"generations": len(gens), "gpu_types": len(gpu)}

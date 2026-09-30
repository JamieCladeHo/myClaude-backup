"""OpenRouter platform token usage (the only public, high-frequency usage series).

Source: OpenRouter's official dataset endpoint
    GET https://openrouter.ai/api/v1/datasets/rankings-daily?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
which returns, per day, the top-50 models' token totals plus an "other" row
(so the day's rows sum to the platform total). Needs a free API key in the
OPENROUTER_API_KEY repository secret. Data licensed CC BY 4.0 by OpenRouter.

Stored:
    token_usage/openrouter_daily.csv          date, model, tokens        (raw archive)
    token_usage/openrouter_weekly_vendor.csv  week, vendor, region, tokens, days, complete
    token_usage/openrouter_weekly_model.csv   week, model, vendor, tokens (top 30 / week)
"""
import datetime as dt
import glob
import json
import os
import subprocess
import urllib.parse

from common import http_json, path, read_csv, write_csv

API = "https://openrouter.ai/api/v1/datasets/rankings-daily"
ARCHIVE_REPO = "https://github.com/harni555/agent-token-index.git"  # CC BY 4.0 snapshots of the same endpoint
DAILY_FIELDS = ["date", "model", "tokens"]

VENDOR = {
    "openai": ("OpenAI", "美国"), "anthropic": ("Anthropic", "美国"), "google": ("Google", "美国"),
    "x-ai": ("xAI", "美国"), "meta-llama": ("Meta", "美国"), "meta": ("Meta", "美国"),
    "nvidia": ("NVIDIA", "美国"), "microsoft": ("Microsoft", "美国"), "amazon": ("Amazon", "美国"),
    "deepseek": ("DeepSeek", "中国"), "qwen": ("通义千问", "中国"), "moonshotai": ("Kimi", "中国"),
    "z-ai": ("智谱 GLM", "中国"), "thudm": ("智谱 GLM", "中国"), "minimax": ("MiniMax", "中国"),
    "xiaomi": ("小米", "中国"), "tencent": ("腾讯", "中国"), "stepfun": ("阶跃星辰", "中国"),
    "bytedance": ("字节跳动", "中国"), "bytedance-seed": ("字节跳动", "中国"), "baidu": ("百度", "中国"),
    "inclusionai": ("蚂蚁 inclusionAI", "中国"), "meituan": ("美团", "中国"), "kwaipilot": ("快手", "中国"),
    "mistralai": ("Mistral", "欧洲"), "stealth": ("匿名测试模型", "未归类"), "other": ("前 50 名以外", "未归类"),
}


def vendor_of(model):
    prefix = model.split("/")[0]
    return VENDOR.get(prefix, (prefix, "其他"))


def week_start(date):
    d = dt.date.fromisoformat(date)
    return (d - dt.timedelta(days=d.weekday())).isoformat()  # Monday


def merge_daily(rows):
    """Upsert (date, model) rows into the archive; the newest fetch wins."""
    p = path("token_usage", "openrouter_daily.csv")
    merged = {(r["date"], r["model"]): r["tokens"] for r in read_csv(p)}
    dates = {r["date"] for r in rows}
    merged = {k: v for k, v in merged.items() if k[0] not in dates}  # replace whole days
    for r in rows:
        merged[(r["date"], r["model"])] = str(int(r["tokens"]))
    out = [{"date": d, "model": m, "tokens": t} for (d, m), t in sorted(merged.items())]
    write_csv(p, DAILY_FIELDS, out)
    return out


def rebuild_weekly(daily):
    days_per_week, by_vendor, by_model = {}, {}, {}
    for r in daily:
        w, t = week_start(r["date"]), int(r["tokens"])
        days_per_week.setdefault(w, set()).add(r["date"])
        v, region = vendor_of(r["model"])
        by_vendor[(w, v, region)] = by_vendor.get((w, v, region), 0) + t
        if r["model"] != "other":
            by_model[(w, r["model"])] = by_model.get((w, r["model"]), 0) + t
    # A week with one missing day is scaled up to 7 days; shorter ones are marked incomplete.
    days = {w: len(d) for w, d in days_per_week.items()}
    scale = {w: 7 / n for w, n in days.items()}
    write_csv(path("token_usage", "openrouter_weekly_vendor.csv"),
              ["week", "vendor", "region", "tokens", "days", "complete"],
              [{"week": w, "vendor": v, "region": g, "tokens": round(t * scale[w]), "days": days[w],
                "complete": int(days[w] >= 6)} for (w, v, g), t in sorted(by_vendor.items())])
    top = []
    for w in sorted(days_per_week):
        ms = sorted(((t, m) for (wk, m), t in by_model.items() if wk == w), reverse=True)[:30]
        top += [{"week": w, "model": m, "vendor": vendor_of(m)[0], "tokens": round(t * scale[w])} for t, m in ms]
    write_csv(path("token_usage", "openrouter_weekly_model.csv"), ["week", "model", "vendor", "tokens"], top)
    return len(days_per_week)


def fetch(start, end, key):
    url = API + "?" + urllib.parse.urlencode({"start_date": start, "end_date": end})
    data = http_json(url, timeout=120, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
    return [{"date": r["date"], "model": r["model_permaslug"], "tokens": r["total_tokens"]} for r in data["data"]]


def collect_openrouter_usage(today, workdir):
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        # No key: fall back to the public archive (updated weekly, a few days behind).
        since = (dt.date.fromisoformat(today) - dt.timedelta(days=60)).isoformat()
        backfill_openrouter_usage(since, workdir, use_key=False)
        latest = max(r["date"] for r in read_csv(path("token_usage", "openrouter_daily.csv")))
        return {"source": "archive (未设置 OPENROUTER_API_KEY)", "through": latest}
    end = dt.date.fromisoformat(today) - dt.timedelta(days=1)
    # Re-fetch the last 10 days: the latest day is often still being finalised.
    rows = fetch((end - dt.timedelta(days=9)).isoformat(), end.isoformat(), key)
    if not rows:
        raise RuntimeError("接口返回为空")
    daily = merge_daily(rows)
    weeks = rebuild_weekly(daily)
    return {"days_fetched": len({r["date"] for r in rows}), "weeks": weeks, "through": max(r["date"] for r in rows)}


def backfill_openrouter_usage(since, workdir, use_key=True):
    """History: with a key, query month by month; without one, import the CC BY 4.0 archive."""
    key = os.environ.get("OPENROUTER_API_KEY") if use_key else None
    rows = []
    if key:
        d = dt.date.fromisoformat(since)
        today = dt.date.today()
        while d < today:
            nxt = (d.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
            rows += fetch(d.isoformat(), min(nxt - dt.timedelta(days=1), today).isoformat(), key)
            print("fetched", d.strftime("%Y-%m"), flush=True)
            d = nxt
    else:
        dest = os.path.join(workdir, "agent-token-index")
        if os.path.isdir(dest):
            subprocess.run(["git", "-C", dest, "pull", "-q", "--ff-only"], check=False)
        else:
            subprocess.run(["git", "clone", "-q", "--depth", "1", ARCHIVE_REPO, dest], check=True)
        snaps = []
        for f in glob.glob(os.path.join(dest, "data", "raw", "*", "*.json")):
            with open(f, encoding="utf-8") as fh:
                item = json.load(fh)
            if item.get("endpoint") == "datasets/rankings-daily":
                snaps.append(item)
        # Oldest fetch first so newer snapshots of the same day overwrite older ones.
        for item in sorted(snaps, key=lambda x: x.get("fetchedAt", "")):
            rows += [{"date": r["date"], "model": r["model_permaslug"], "tokens": r["total_tokens"]}
                     for r in item["payload"]["data"] if r["date"] >= since]
    dedup = {}
    for r in rows:
        dedup[(r["date"], r["model"])] = r
    daily = merge_daily(list(dedup.values()))
    weeks = rebuild_weekly(daily)
    print("days:", len({r["date"] for r in daily}), "weeks:", weeks)

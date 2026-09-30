"""Refresh the valuation dashboard's price data.

1. Scans docs/valuation/companies/*/valuation.json and rewrites companies/index.json
   (so adding a company = adding a folder; no manifest to edit by hand).
2. Pulls the latest quote + 1 year of daily closes from Yahoo Finance via yfinance,
   falling back to Stooq for the quote if Yahoo fails.
3. Writes docs/valuation/data/prices.json and docs/valuation/data/history/<TICKER>.json.
   A ticker whose fetch fails keeps its previous quote (marked stale) instead of vanishing.

Usage: python valuation/fetch_prices.py [--no-fetch]   (--no-fetch only rebuilds the index)
"""
from __future__ import annotations

import csv
import io
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "docs" / "valuation"
COMPANIES = SITE / "companies"
DATA = SITE / "data"
HISTORY = DATA / "history"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_companies() -> list[dict]:
    out = []
    for f in sorted(COMPANIES.glob("*/valuation.json")):
        if f.parent.name.startswith(("_", ".")):
            continue
        try:
            v = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"!! {f}: invalid JSON ({e}); skipped", file=sys.stderr)
            continue
        out.append({
            "dir": f.parent.name,
            "ticker": v.get("ticker", f.parent.name),
            "symbol": v.get("yf_symbol") or v.get("ticker", f.parent.name),
            "report_date": v.get("report_date", ""),
        })
    return out


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def fetch_yahoo(symbol: str) -> tuple[dict, dict]:
    import yfinance as yf

    t = yf.Ticker(symbol)
    hist = t.history(period="1y", interval="1d", auto_adjust=False)
    if hist.empty:
        raise RuntimeError("empty history")
    closes = hist["Close"].dropna()
    history = {
        "dates": [d.strftime("%Y-%m-%d") for d in closes.index],
        "close": [round(float(x), 4) for x in closes.values],
    }
    fi = t.fast_info
    price = fi.get("lastPrice") or float(closes.iloc[-1])
    prev = fi.get("previousClose") or (float(closes.iloc[-2]) if len(closes) > 1 else None)
    quote = {
        "price": round(float(price), 4),
        "prev_close": round(float(prev), 4) if prev else None,
        "currency": fi.get("currency"),
        "high_52w": round(float(closes.max()), 4),
        "low_52w": round(float(closes.min()), 4),
        "source": "yfinance",
    }
    return quote, history


def fetch_stooq(symbol: str) -> dict:
    s = symbol.lower() if "." in symbol else symbol.lower() + ".us"
    url = f"https://stooq.com/q/l/?s={s}&f=sd2t2ohlcp&h&e=csv"
    with urllib.request.urlopen(url, timeout=20) as r:
        row = next(csv.DictReader(io.StringIO(r.read().decode())))
    price = float(row["Close"])
    prev = row.get("Prev")
    return {"price": price, "prev_close": float(prev) if prev not in (None, "", "N/D") else None,
            "source": "stooq"}


def main() -> int:
    companies = load_companies()
    write_json(COMPANIES / "index.json",
               {"companies": [{"dir": c["dir"], "ticker": c["ticker"]} for c in companies]})
    print(f"index: {len(companies)} companies")
    if "--no-fetch" in sys.argv:
        return 0

    prices_path = DATA / "prices.json"
    old = json.loads(prices_path.read_text()) if prices_path.exists() else {}
    quotes = {}
    ok = 0
    for c in companies:
        sym, stamp = c["symbol"], now_iso()
        try:
            quote, history = fetch_yahoo(sym)
            write_json(HISTORY / f"{c['ticker']}.json", {"symbol": sym, **history})
        except Exception as e:  # noqa: BLE001 - any upstream failure falls through to Stooq
            print(f"yahoo {sym}: {e}", file=sys.stderr)
            try:
                quote = fetch_stooq(sym)
            except Exception as e2:  # noqa: BLE001
                print(f"stooq {sym}: {e2}", file=sys.stderr)
                prev = old.get("quotes", {}).get(c["ticker"])
                if prev:
                    quotes[c["ticker"]] = {**prev, "stale": True}
                continue
        quote["time"] = stamp
        if quote.get("prev_close"):
            quote["change_pct"] = round(quote["price"] / quote["prev_close"] - 1, 5)
        quotes[c["ticker"]] = quote
        ok += 1
        print(f"{c['ticker']}: {quote['price']} ({quote['source']})")

    write_json(prices_path, {"updated": now_iso() if ok else old.get("updated"), "quotes": quotes})
    print(f"prices: {ok}/{len(companies)} fetched")
    return 0 if ok or not companies else 1


if __name__ == "__main__":
    sys.exit(main())

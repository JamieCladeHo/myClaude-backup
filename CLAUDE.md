# Repo notes

Two static dashboards share one GitHub Pages site served from `docs/`:

- `docs/index.html` — AI 成本追踪 (see `README.md`; data collected by `scripts/` + `.github/workflows/collect.yml`).
- `docs/valuation/` — 个股估值看板 (see `valuation/README.md`; prices via `valuation/fetch_prices.py` + `.github/workflows/valuation-prices.yml`).

Adding a company to the valuation dashboard: follow `valuation/README.md` → create
`docs/valuation/companies/<TICKER>/valuation.json` and `analysis.md` from `valuation/template/`.
Keep only the company's own valuation logic and conclusions; drop sell-side / broker comparisons.
Scenario keys are `bear` / `base` / `bull` (reports may call Base "Fair"). Don't hand-edit
`companies/index.json` or `data/` — run `python valuation/fetch_prices.py --no-fetch` to rebuild the index.

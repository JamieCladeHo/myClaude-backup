# 个股估值看板

网址：`https://<你的 GitHub 用户名>.github.io/<仓库名>/valuation/`（与「AI 成本追踪」同一个 GitHub Pages 站点）。

- **总览**：每家公司一张卡片——现价、距 Base 的空间、Bear/Base/Bull 区间条。可切换对比口径（12 个月目标价 / 今日合理价）和排序。
- **详情**（点卡片进入）：左边是现价 vs Base、区间条和一年股价走势（带三档价格线）；右边是三档价格、概率、3–5 个核心假设和推导结果；下面是核心结论和可折叠的估值分析。

```
docs/valuation/                     网页（index.html / app.js / valuation.css）
docs/valuation/companies/<TICKER>/  每家公司一个文件夹
    valuation.json                  结构化数据：三档价格、概率、核心假设、结论
    analysis.md                     估值逻辑全文（按 ## 标题自动分成折叠段落）
docs/valuation/companies/index.json 公司列表（由脚本自动生成，不用手改）
docs/valuation/data/prices.json     最新价格（脚本自动生成）
docs/valuation/data/history/        一年日线（脚本自动生成）
valuation/fetch_prices.py           用 yfinance 抓价格 + 重建公司列表
valuation/template/                 新公司模板
.github/workflows/valuation-prices.yml
```

## 价格怎么更新

浏览器不能直接调用 yfinance（它是 Python 库，Yahoo 也不允许网页跨域读取），所以由 GitHub Actions 运行 `fetch_prices.py`：

- 美股交易日 UTC 14:05–21:05 每小时一次（北京时间 22:05–次日 05:05），收盘后再跑一次；
- 推送新公司 / 修改公司资料时也会立刻跑一次；
- 也可以在 **Actions → valuation-prices → Run workflow** 手动触发。

Yahoo 抓取失败时改用 Stooq 报价；两者都失败则沿用上次价格并在网页上标注。网页打开期间每 10 分钟重新读取一次价格文件。GitHub 的定时任务本身可能延迟几分钟到几十分钟。

想改频率：编辑 workflow 里的 `cron`。非美股代码用 Yahoo 格式写在 `yf_symbol`，例如 `0700.HK`、`2330.TW`、`600519.SS`，并把 `currency` 改为 `HKD` / `TWD` / `CNY`。

## 新增一家公司

1. 复制 `valuation/template/` 到 `docs/valuation/companies/<TICKER>/`。
2. 填 `valuation.json`：
   - `scenarios.{bear,base,bull}`：`target` ＝ 12 个月目标价，`today` ＝ 折现到今天的合理价（没有就省略，网页会改用 12 个月目标价），`prob` ＝ 概率，`narrative` ＝ 一句话情景。
   - `assumptions`：3–5 个核心假设，每档填字符串（如 `"4.5GW"`、`"+38%"`），`note` 写依据。
   - `outputs`：由假设推出的结果（EPS、倍数等），可选。
   - `weighted`：概率加权值；省略时网页自动按概率计算。
   - `summary`：3–5 条核心结论。
3. 写 `analysis.md`：估值逻辑全文，每个 `##` 成为一个折叠段落。只放对公司本身的评价和估值逻辑，卖方对比部分不放。
4. 提交并推送到默认分支，Actions 会自动重建公司列表并抓价格。

更新已有公司的研究：直接覆盖该文件夹的两个文件（旧版本留在 git 历史里）。

也可以把新报告交给 Claude，说「按 `valuation/README.md` 把这份报告加进估值看板」。

## 本地预览

```bash
python valuation/fetch_prices.py --no-fetch   # 只重建公司列表（需要网络的话去掉 --no-fetch）
python -m http.server -d docs 8000             # 打开 http://localhost:8000/valuation/
```

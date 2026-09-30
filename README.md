# AI 成本追踪（Token 用量 / Token 价格 / GPU 与云服务器租金）

> 同一站点还有 **个股估值看板**（`docs/valuation/`），说明见 [`valuation/README.md`](valuation/README.md)。

一个零服务器、零费用的追踪站：

- **GitHub Actions** 每天定时运行 `scripts/collect.py`，从公开数据源抓取数据；
- 结果以 **CSV / JSON 累积提交**到仓库的 `docs/data/`（git 历史本身就是完整的时间序列存档）；
- **GitHub Pages** 直接发布 `docs/` 目录，页面在浏览器里读取这些 CSV 画图。

```
.github/workflows/collect.yml   每日定时任务（也可手动触发并回填历史）
scripts/collect.py              每日采集入口（仅用 Python 标准库）
scripts/usage.py                OpenRouter 用量：采集 + 周度汇总
scripts/compute.py              GPU / CPU 云价格：SkyPilot 目录 + Azure 零售价 API
scripts/backfill.py             回填历史
scripts/common.py               共用：GPU 名称归一、聚合、CSV 读写
docs/index.html, app.js, style.css   网页（Chart.js 已放在 docs/vendor/，不依赖 CDN）
docs/data/                      数据（见下表）
```

## 看板内容

| 板块 | 看什么 | 数据源 | 文件 |
|---|---|---|---|
| **Token 用量（周度）** | 全平台周总量、周环比、厂商份额、中国厂商份额、每周 Top 模型 | [OpenRouter 官方 `rankings-daily` 数据集](https://openrouter.ai/rankings)（CC BY 4.0，每天前 50 模型 + 其余合计 = 全平台）；历史从 2025-01 起 | `token_usage/openrouter_daily.csv`（逐日原始）、`openrouter_weekly_vendor.csv`、`openrouter_weekly_model.csv` |
| 官方披露用量（低频） | 国家数据局 / Google / 豆包等发布会、财报数字 | 手工维护 | `token_usage/milestones.csv` |
| **大模型 API 价格** | 按厂商产品线（如 Opus / Sonnet / Haiku、GPT 旗舰 / mini / nano）看**每一代发布时的价格**以及之后的调价；美国 vs 中国旗舰对比 | [LiteLLM 价格表](https://github.com/BerriAI/litellm)（厂商官方价，2023 年起）+ [OpenRouter Models API](https://openrouter.ai/api/v1/models) | `llm/price_changes.csv`（只记变化）、`llm/lineages.json`（产品线定义） |
| **GPU 租金** | 各型号市场指数与同比、各云厂商最低价 / 中位价 / Spot | [SkyPilot 云价格目录](https://github.com/skypilot-org/skypilot-catalog) 的 git 历史（2024 年起）、Azure 零售价 API、Vast.ai 实时市场 | `compute/gpu_daily.csv` |
| **云服务器 (CPU)** | 同款机型价格指数（按需 vs Spot）、Spot 平均折扣、每一代机型的价格阶梯 | SkyPilot 目录（AWS / GCP）、Azure 零售价 API | `compute/cpu_index.csv`、`compute/cpu_generations.csv` |

### 几个口径说明

- **OpenRouter 用量**：OpenRouter 是唯一公开逐日用量的大型模型聚合平台，适合看趋势与份额，但它只是 API 开发者市场的一部分，不等于全球总量。周 = 周一至周日；缺 1 天的周按 7 天折算。
- **模型代际价格**：日期是 LiteLLM 价格表收录该模型的日期，通常比官方发布晚几天。价格只维持不到 10 天就被改掉的，视为录入错误并忽略。新模型发布后，在 `docs/data/llm/lineages.json` 对应产品线末尾加一行即可。
- **同款机型价格指数**：每次采样只拿前后两期都存在的同一批实例（同机型、同区域）比价，取对数均值后连乘（2024-01-01 = 100），避免新机型上架带来的结构偏差。Spot 价取同区域内最便宜的可用区。
- **GPU 市场指数** = 各云厂商按需最低价的中位数；低于中位数 1/4 的报价视为目录错误，不计入。
- **停更的目录会被剔除**：SkyPilot 的部分目录已不再更新（Azure、Paperspace、DigitalOcean 是静态快照；Vast、FluidStack、Hyperbolic、Cudo 的抓取已停止），这些厂商只保留仍在更新时期的数据。Azure 改为直接读取 Azure 官方零售价 API。

## 部署

1. 这些文件需要在仓库的**默认分支**上（定时任务只在默认分支运行）。
2. **Settings → Pages**：Source 选 *Deploy from a branch*，分支选默认分支，目录选 `/docs`。
3. **Settings → Actions → General → Workflow permissions**：选 *Read and write permissions*。
4. （推荐）**Settings → Secrets and variables → Actions → New repository secret**：名称 `OPENROUTER_API_KEY`，值为在 [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) 免费创建的 key。
   有 key 时每天直接读 OpenRouter 官方接口（数据只晚 1 天）；没有 key 时改用公开存档，每周更新、晚几天。
5. **Actions → collect-data → Run workflow** 手动跑一次；之后每天 UTC 01:17 自动运行，脚本有改动时也会自动运行。

本地预览：

```bash
python scripts/collect.py            # 采集今天的数据（可只跑某一个：python scripts/collect.py skypilot）
python -m http.server -d docs 8000   # 打开 http://localhost:8000
```

## 回填 / 重建历史

```bash
python scripts/backfill.py skypilot                           # GPU / CPU（默认 2024-01-01 起，每周一个点）
python scripts/backfill.py litellm                            # 大模型价格（默认 2023-06-01 起）
python scripts/backfill.py openrouter-usage                   # OpenRouter 逐日用量（2025-01-01 起）
```

SkyPilot 目录和 LiteLLM 价格表都由机器人持续更新并保存在 git 里，所以它们的**提交历史就是价格历史**。也可以在 Actions 手动触发时选 `backfill` 选项在云端执行。

## 更新官方披露的用量

在 `docs/data/token_usage/milestones.csv` 追加一行：

```csv
date,entity,tokens,period,note,source_url
2026-09-15,Google,4.0e15,month,示例：月处理 4 千万亿 tokens,https://...
```

`period` 取 `day` / `week` / `month` / `quarter`。部分早期记录标注了「待核实链接」，建议补上原始出处。

## 可以继续扩展的数据源

- **Artificial Analysis API**（免费 key）：模型「能力指数 vs 价格」，画「同等能力的价格随时间下降」。
- **OpenRouter `datasets/app-rankings`**（同一个 key）：按应用 / 场景（编程、Agent 等）拆分的周度用量。
- **AWS Price List API**：比 SkyPilot 更细的官方全量价格（文件很大）。
- **GPU 租金指数**：Silicon Data（SDH100RT）、Ornn 等，多为付费。

## 注意

所有价格均为**公开标价**，不含企业折扣、预留实例 / 长约、Batch 折扣和缓存命中价。

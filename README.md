# AI 成本追踪（Token 用量 / Token 价格 / GPU 与云服务器租金）

一个零服务器、零费用的追踪站：

- **GitHub Actions** 每天定时运行 `scripts/collect.py`，从公开数据源抓取价格；
- 结果以 **CSV / JSON 累积提交**到仓库的 `docs/data/`（git 历史本身就是完整的时间序列存档）；
- **GitHub Pages** 直接发布 `docs/` 目录，页面在浏览器里读取这些 CSV 画图。

```
.github/workflows/collect.yml   每日定时任务（也可手动触发并回填历史）
scripts/collect.py              每日采集（仅用 Python 标准库，无需安装依赖）
scripts/backfill.py             从上游 git 历史回填过去数据
scripts/common.py               共用：GPU 名称归一、聚合、CSV 读写
docs/index.html, app.js, style.css   网页（Chart.js 已放在 docs/vendor/，不依赖 CDN）
docs/data/                      数据（见下表）
```

## 数据源与指标

| 板块 | 来源 | 频率 | 文件 | 说明 |
|---|---|---|---|---|
| 大模型 API 价格 | [LiteLLM 价格表](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) | 每日 | `llm/price_changes.csv`、`llm/latest_litellm.json` | 只保留模型厂商自营（OpenAI、Anthropic、Gemini、DeepSeek、xAI、Mistral、通义、Kimi、智谱、MiniMax、火山等）的对话模型；**只记录变化**（新上线/调价/下架），体积很小 |
| 大模型 API 价格 | [OpenRouter Models API](https://openrouter.ai/api/v1/models)（免密钥） | 每日 | 同上，`source=openrouter` | 覆盖开源模型在各推理商的价格，含模型上线时间 |
| GPU 租金 | [SkyPilot 云价格目录](https://github.com/skypilot-org/skypilot-catalog) | 每日 | `compute/gpu_daily.csv` | AWS / GCP / Azure / Lambda / RunPod / Nebius / Vast / Cudo / Paperspace / FluidStack / DigitalOcean / Hyperbolic；按 GPU 型号统计每 GPU·小时的最低价、中位价、Spot 最低价，另有跨厂商「市场指数」行（`cloud=ALL`） |
| GPU 租金（实时市场） | [Vast.ai 公开搜索 API](https://vast.ai) | 每日 | `compute/gpu_daily.csv`，`source=vast_live` | 点对点 GPU 市场的实时挂单，最能反映供需 |
| 云服务器 (CPU) | SkyPilot 云价格目录 | 每日 | `compute/cpu_daily.csv`、`compute/ref_instances.csv` | 通用型 x86（≈4 GiB/vCPU）每 vCPU·小时中位价；外加 4 台固定参考机型（AWS m7i/m5.xlarge、GCP n2-standard-4、Azure D4s_v5）的按需与 Spot 价 |
| 全球 Token 用量 | 新闻稿 / 财报（手工维护） | 不定期 | `token_usage/milestones.csv` | 国家数据局、Google、字节豆包、OpenRouter 等公开披露的调用量，页面统一换算成日均 tokens |

仓库里已经预置了回填好的历史：LLM 价格从 2023 年起、GPU/CPU 价格从 2024-01 起（每周一个采样点），之后由 Action 每天追加。

## 部署（约 3 分钟）

1. 确保这些文件在仓库的**默认分支**上（定时任务只在默认分支运行）。
2. **Settings → Pages → Build and deployment**：Source 选 *Deploy from a branch*，分支选默认分支，目录选 `/docs`，保存。
3. **Settings → Actions → General → Workflow permissions**：选 *Read and write permissions*（让 Action 能提交数据）。
4. 到 **Actions → collect-data → Run workflow** 手动跑一次验证；之后每天 UTC 01:17 自动运行。

本地预览：

```bash
python scripts/collect.py            # 采集今天的数据（可只跑某一个：python scripts/collect.py skypilot）
python -m http.server -d docs 8000   # 打开 http://localhost:8000
```

## 回填 / 重建历史

```bash
python scripts/backfill.py skypilot --since 2024-01-01 --step 7   # GPU / CPU 价格
python scripts/backfill.py litellm  --since 2023-06-01 --step 7   # 大模型价格
```

原理：SkyPilot 目录由机器人每天多次更新，LiteLLM 价格表也在 git 里维护，所以它们的 **git 提交历史就是价格历史**。脚本按日期找到当时的版本并聚合。也可以在 Actions 手动触发时选择 `backfill` 选项在云端执行。

## 更新 Token 用量

Token 用量没有统一的公开 API，只能跟踪公开披露。看到新数据时，在 `docs/data/token_usage/milestones.csv` 追加一行即可：

```csv
date,entity,tokens,period,note,source_url
2026-09-15,OpenRouter,1.15e14,week,示例：周处理 115 万亿 tokens,https://...
```

`period` 取 `day` / `week` / `month` / `quarter`。部分早期记录标注了「待核实链接」，建议补上原始出处。

值得关注的披露来源：国家数据局发布会、Alphabet / Microsoft 财报电话会、Google I/O、火山引擎 Force 大会、OpenAI DevDay、OpenRouter 排行榜（[openrouter.ai/rankings](https://openrouter.ai/rankings)）。

## 可以继续扩展的数据源

- **Artificial Analysis API**（需免费 API key，放进仓库 Secrets）：模型「智能指数 vs 价格」，可以画「同等能力的价格随时间下降」曲线。
- **AWS Price List API / Azure Retail Prices API**：官方全量价格，比 SkyPilot 更细（但文件很大）。
- **GPU 租金指数**：Silicon Data（SDH100RT）、Ornn 等提供 H100 租金指数，多为付费。
- **中国市场**：阿里云、火山引擎、DeepSeek 的人民币定价页面（需要写 HTML 抓取，易随改版失效）。

## 注意

- 所有价格均为**公开标价**，不含企业折扣、预留实例 / 长约价格、Batch 折扣和缓存命中价。
- GPU「最低价」对单个异常挂单比较敏感，看趋势时建议同时对照「中位价」。
- 不同厂商对 GPU 的命名不一致（H100 SXM / NVL / PCIe 等），`scripts/common.py` 的 `norm_gpu` 会把它们归为同一族；需要区分时可改那里。

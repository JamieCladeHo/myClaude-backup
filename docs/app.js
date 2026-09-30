/* AI 成本追踪 — static dashboard reading CSV/JSON from ./data */
"use strict";

const $ = (s) => document.querySelector(s);
const TODAY = new Date().toISOString().slice(0, 10);
const charts = {};

// ------------------------------------------------------------------ data

function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

async function load(url, kind = "csv") {
  try {
    const r = await fetch(`data/${url}`, { cache: "no-cache" });
    if (!r.ok) return kind === "csv" ? [] : null;
    return kind === "csv" ? parseCSV(await r.text()) : r.json();
  } catch { return kind === "csv" ? [] : null; }
}

// ---------------------------------------------------------------- styling

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const slot = (i) => css(`--s${(i % 8) + 1}`);

// Colour follows the entity everywhere on the page (never its rank).
const CLOUD_ORDER = ["aws", "gcp", "azure", "lambda", "runpod", "nebius", "vast", "vast (实时市场)"];
const cloudColor = (c) => (CLOUD_ORDER.includes(c) ? slot(CLOUD_ORDER.indexOf(c)) : css("--muted"));
const CLOUD_LABEL = { aws: "AWS", gcp: "Google Cloud", azure: "Azure", lambda: "Lambda", runpod: "RunPod",
  nebius: "Nebius", vast: "Vast.ai (目录)", "vast (实时市场)": "Vast.ai (实时市场)", cudo: "Cudo",
  paperspace: "Paperspace", fluidstack: "FluidStack", do: "DigitalOcean", hyperbolic: "Hyperbolic" };
const MINOR_CLOUDS = new Set(["cudo", "paperspace", "fluidstack", "do", "hyperbolic"]);

function fmtUSD(v) {
  if (v == null || isNaN(v)) return "–";
  const a = Math.abs(v);
  return "$" + (a >= 100 ? v.toFixed(0) : a >= 1 ? v.toFixed(2) : a >= 0.01 ? v.toFixed(3) : v.toPrecision(2));
}
const fmtUSDTick = (v) => "$" + +(+v).toPrecision(3);
function fmtTok(v) {
  if (v >= 1e16) return (v / 1e16).toPrecision(3) + " 亿亿";
  if (v >= 1e12) return +(v / 1e12).toPrecision(3) + " 万亿";
  if (v >= 1e8) return +(v / 1e8).toPrecision(3) + " 亿";
  return v.toLocaleString();
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function baseOptions({ logY = false, yFmt = fmtUSD, tickFmt = fmtUSDTick, tipFmt, legend = true } = {}) {
  const ink2 = css("--ink-2"), muted = css("--muted"), grid = css("--grid"), axis = css("--axis");
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "nearest", axis: "x", intersect: false },
    scales: {
      x: { type: "time", time: { tooltipFormat: "yyyy-MM-dd", minUnit: "day" },
        grid: { display: false }, border: { color: axis }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 16 } },
      y: { type: logY ? "logarithmic" : "linear", beginAtZero: !logY, grid: { color: grid }, border: { display: false },
        ticks: { color: muted, callback: (v) => (logY && !isNiceLog(v) ? "" : (tickFmt || yFmt)(v)) } },
    },
    plugins: {
      legend: { display: legend, position: "bottom", labels: { color: ink2, usePointStyle: true, boxHeight: 7, padding: 14 } },
      tooltip: { callbacks: { label: tipFmt || ((c) => ` ${c.dataset.label}: ${yFmt(c.parsed.y)}`) } },
    },
    elements: { line: { borderWidth: 2 }, point: { radius: 0, hoverRadius: 5, hitRadius: 8 } },
  };
}
const isNiceLog = (v) => { const m = v / 10 ** Math.floor(Math.log10(v)); return [1, 2, 5].some((n) => Math.abs(m - n) < 1e-9); };

function draw(id, config) {
  charts[id]?.destroy();
  charts[id] = new Chart(document.getElementById(id), config);
}

function table(el, head, rows) {
  el.innerHTML = `<thead><tr>${head.map((h) => `<th class="${h.cls || ""}">${h.t}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${head[i].cls || ""}">${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
}

// ------------------------------------------------------------ token usage

const PERIOD_DAYS = { day: 1, week: 7, month: 30.44, quarter: 91.3 };

function renderUsage(rows) {
  const entities = [...new Set(rows.map((r) => r.entity))];
  const datasets = entities.map((e, i) => ({
    label: e, borderColor: slot(i), backgroundColor: slot(i), pointRadius: 4, pointHoverRadius: 6,
    pointBorderColor: css("--surface"), pointBorderWidth: 2,
    data: rows.filter((r) => r.entity === e).sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({ x: r.date, y: +r.tokens / PERIOD_DAYS[r.period], note: r.note })),
  }));
  const o = baseOptions({ logY: true, yFmt: fmtTok, tickFmt: fmtTok,
    tipFmt: (c) => [` ${c.dataset.label}: ${fmtTok(c.parsed.y)} tokens/日`, ` ${c.raw.note}`] });
  draw("usageChart", { type: "line", data: { datasets }, options: o });
  table($("#usageTable"),
    [{ t: "日期" }, { t: "机构" }, { t: "日均 tokens", cls: "num" }, { t: "原始口径" }, { t: "说明" }],
    [...rows].sort((a, b) => b.date.localeCompare(a.date)).map((r) => [
      r.date, esc(r.entity), fmtTok(+r.tokens / PERIOD_DAYS[r.period]), `${fmtTok(+r.tokens)} / ${r.period}`,
      r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(r.note)}</a>` : esc(r.note)]));
}

// ------------------------------------------------------------- LLM prices

const DEFAULT_MODELS = ["gpt-4", "gpt-4o", "gpt-5", "claude-3-opus-20240229", "claude-sonnet-4-5",
  "gemini/gemini-2.5-pro", "deepseek/deepseek-chat", "anthropic/claude-sonnet-4.5", "openai/gpt-5"];
const llm = { changes: [], latest: {}, selected: [], colorOf: {} };

function llmSeries(model, source, kind) {
  const ev = llm.changes.filter((r) => r.model === model && r.source === source).sort((a, b) => a.date.localeCompare(b.date));
  const pts = [];
  for (const r of ev) {
    const v = r.event === "removed" ? null : +r[`${kind}_usd_per_mtok`];
    pts.push({ x: r.date, y: v > 0 ? v : null });
  }
  const last = pts[pts.length - 1];
  if (last && last.y != null && last.x < TODAY) pts.push({ x: TODAY, y: last.y });
  return pts;
}

function renderLLM() {
  const source = $("#llmSource").value, kind = $("#llmKind").value;
  const datasets = llm.selected.map((m) => ({
    label: m, data: llmSeries(m, source, kind), stepped: "before", spanGaps: false,
    borderColor: slot(llm.colorOf[m]), backgroundColor: slot(llm.colorOf[m]),
  }));
  draw("llmChart", { type: "line", data: { datasets }, options: baseOptions({ logY: true,
    tipFmt: (c) => ` ${c.dataset.label}: ${fmtUSD(c.parsed.y)} / 1M tokens` }) });

  $("#llmChips").innerHTML = llm.selected.map((m) =>
    `<span class="chip"><i style="background:${slot(llm.colorOf[m])}"></i>${esc(m)}<button data-m="${esc(m)}" aria-label="移除">×</button></span>`).join("");

  // Recent changes (price moves only, plus launches) for this source.
  const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const bySrc = llm.changes.filter((r) => r.source === source);
  const recent = bySrc.filter((r) => r.date >= since && r.event !== "removed").sort((a, b) => b.date.localeCompare(a.date));
  table($("#llmChanges"), [{ t: "日期" }, { t: "模型" }, { t: "事件" }, { t: "输入 $/1M", cls: "num" }, { t: "输出 $/1M", cls: "num" }],
    recent.slice(0, 200).map((r) => {
      let tag = "新上线";
      if (r.event === "change") {
        const prev = bySrc.filter((p) => p.model === r.model && p.date < r.date && p.event !== "removed").pop();
        const d = prev && +prev.output_usd_per_mtok ? (+r.output_usd_per_mtok / +prev.output_usd_per_mtok - 1) * 100 : null;
        tag = d == null ? "调价" : d < 0 ? `<span class="down">↓ 降价 ${d.toFixed(0)}%</span>` : `<span class="up">↑ 涨价 +${d.toFixed(0)}%</span>`;
      }
      return [r.date, esc(r.model), tag, fmtUSD(+r.input_usd_per_mtok), fmtUSD(+r.output_usd_per_mtok)];
    }));
  renderLLMLatest();
}

function renderLLMLatest() {
  const latest = llm.latest[$("#llmSource").value] || {};
  const f = $("#llmFilter").value.trim().toLowerCase();
  const rows = Object.entries(latest).filter(([m, v]) => !f || m.toLowerCase().includes(f) || v.provider.includes(f))
    .sort((a, b) => b[1].output - a[1].output);
  table($("#llmLatest"), [{ t: "模型" }, { t: "厂商" }, { t: "输入 $/1M", cls: "num" }, { t: "输出 $/1M", cls: "num" }],
    rows.slice(0, 300).map(([m, v]) => [esc(m), esc(v.provider), fmtUSD(v.input), fmtUSD(v.output)]));
}

function addModel(m) {
  if (!m || llm.selected.includes(m) || llm.selected.length >= 8) return;
  const used = new Set(llm.selected.map((x) => llm.colorOf[x]));
  llm.colorOf[m] = [...Array(8).keys()].find((i) => !used.has(i)); // keep survivors' colours stable
  llm.selected.push(m);
}

function initLLM(changes, latestLite, latestOR) {
  llm.changes = changes;
  llm.latest = { litellm: latestLite || {}, openrouter: latestOR || {} };
  const sources = [["litellm", "LiteLLM（厂商官方价）"], ["openrouter", "OpenRouter"]].filter(([s]) => changes.some((r) => r.source === s));
  $("#llmSource").innerHTML = sources.map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
  const setSource = () => {
    const src = $("#llmSource").value;
    const models = [...new Set(changes.filter((r) => r.source === src).map((r) => r.model))].sort();
    $("#llmModels").innerHTML = models.map((m) => `<option value="${esc(m)}">`).join("");
    llm.selected = []; llm.colorOf = {};
    DEFAULT_MODELS.filter((m) => models.includes(m)).slice(0, 8).forEach(addModel);
    renderLLM();
  };
  $("#llmSource").onchange = setSource;
  $("#llmKind").onchange = renderLLM;
  $("#llmFilter").oninput = renderLLMLatest;
  $("#llmSearch").onchange = (e) => {
    const m = e.target.value.trim();
    if (changes.some((r) => r.model === m && r.source === $("#llmSource").value)) { addModel(m); renderLLM(); }
    e.target.value = "";
  };
  $("#llmChips").onclick = (e) => {
    const m = e.target.dataset?.m;
    if (m) { llm.selected = llm.selected.filter((x) => x !== m); delete llm.colorOf[m]; renderLLM(); }
  };
  setSource();
}

// ------------------------------------------------------------------ GPUs

const GPU_ORDER = ["B300", "B200", "GB200", "H200", "H100", "GH200", "MI300X", "A100-80GB", "A100", "L40S",
  "RTXPRO6000", "RTX5090", "RTX4090", "L4", "A10G", "A10", "V100", "T4"];

function gpuEntity(r) { return r.source === "vast_live" ? "vast (实时市场)" : r.cloud; }

function renderGPU(rows) {
  const gpu = $("#gpuType").value, metric = $("#gpuMetric").value;
  const sel = rows.filter((r) => r.gpu === gpu && r[metric] !== "");
  const ents = [...new Set(sel.map(gpuEntity))].filter((e) => e !== "ALL")
    .sort((a, b) => (CLOUD_ORDER.indexOf(a) + 1 || 99) - (CLOUD_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  const series = (e) => sel.filter((r) => gpuEntity(r) === e).sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({ x: r.date, y: +r[metric] }));
  const datasets = [
    { label: "全市场", data: series("ALL"), borderColor: css("--ink"), backgroundColor: css("--ink"), borderWidth: 3 },
    ...ents.map((e) => ({ label: CLOUD_LABEL[e] || e, data: series(e), borderColor: cloudColor(e), backgroundColor: cloudColor(e),
      borderDash: CLOUD_ORDER.includes(e) ? [] : [5, 4], hidden: MINOR_CLOUDS.has(e) })),
  ];
  draw("gpuChart", { type: "line", data: { datasets }, options: baseOptions({
    tipFmt: (c) => ` ${c.dataset.label}: ${fmtUSD(c.parsed.y)} / GPU·时` }) });
}

function initGPU(rows) {
  if (!rows.length) return;
  const lastDate = rows.reduce((m, r) => (r.date > m ? r.date : m), "");
  const present = [...new Set(rows.filter((r) => r.date === lastDate).map((r) => r.gpu))];
  const gpus = [...GPU_ORDER.filter((g) => present.includes(g)), ...present.filter((g) => !GPU_ORDER.includes(g)).sort()];
  $("#gpuType").innerHTML = gpus.map((g) => `<option${g === "H100" ? " selected" : ""}>${g}</option>`).join("");
  $("#gpuType").onchange = $("#gpuMetric").onchange = () => renderGPU(rows);
  renderGPU(rows);

  const latest = rows.filter((r) => r.date === lastDate || (r.source === "vast_live" && r.date === lastDate));
  const cols = ["ALL", ...CLOUD_ORDER.filter((c) => latest.some((r) => gpuEntity(r) === c)),
    ...[...MINOR_CLOUDS].filter((c) => latest.some((r) => r.cloud === c))];
  table($("#gpuTable"), [{ t: `GPU（${lastDate}）` }, ...cols.map((c) => ({ t: c === "ALL" ? "市场指数*" : CLOUD_LABEL[c] || c, cls: "num" }))],
    gpus.map((g) => [g, ...cols.map((c) => {
      const r = latest.find((x) => x.gpu === g && gpuEntity(x) === c);
      return r ? fmtUSD(+(c === "ALL" ? r.median_usd_per_gpu_hr : r.min_usd_per_gpu_hr)) : "";
    })]));
}

// ------------------------------------------------------------------- CPU

function renderCPU(rows, refs) {
  const clouds = [...new Set(rows.map((r) => r.cloud))]
    .sort((a, b) => (CLOUD_ORDER.indexOf(a) + 1 || 99) - (CLOUD_ORDER.indexOf(b) + 1 || 99));
  draw("cpuChart", { type: "line", data: { datasets: clouds.map((c) => ({
    label: CLOUD_LABEL[c] || c, borderColor: cloudColor(c), backgroundColor: cloudColor(c),
    borderDash: CLOUD_ORDER.includes(c) ? [] : [5, 4], hidden: MINOR_CLOUDS.has(c),
    data: rows.filter((r) => r.cloud === c).sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({ x: r.date, y: +r.median_usd_per_vcpu_hr })),
  })) }, options: baseOptions({ tipFmt: (c) => ` ${c.dataset.label}: ${fmtUSD(c.parsed.y)} / vCPU·时` }) });

  const kind = $("#refKind").value;
  const keys = [...new Set(refs.map((r) => `${r.cloud}|${r.instance}`))];
  draw("refChart", { type: "line", data: { datasets: keys.map((k) => {
    const [cloud, inst] = k.split("|");
    const pts = refs.filter((r) => `${r.cloud}|${r.instance}` === k).sort((a, b) => a.date.localeCompare(b.date))
      .filter((r) => r[kind] !== "").map((r) => ({ x: r.date, y: +r[kind] }));
    const dashed = keys.filter((x) => x.startsWith(cloud + "|")).indexOf(k) > 0; // 2nd instance on the same cloud
    return { label: `${CLOUD_LABEL[cloud]} ${inst}`, data: pts, borderColor: cloudColor(cloud), backgroundColor: cloudColor(cloud),
      borderDash: dashed ? [5, 4] : [], pointRadius: pts.length < 30 ? 3 : 0 };
  }) }, options: baseOptions({ tipFmt: (c) => ` ${c.dataset.label}: ${fmtUSD(c.parsed.y)} / 时` }) });
}

// ---------------------------------------------------------------- status

function renderStatus(st) {
  if (!st) return;
  const names = { litellm: "LiteLLM 价格表", openrouter: "OpenRouter", skypilot: "SkyPilot 云价格目录", vast: "Vast.ai 实时市场" };
  table($("#statusTable"), [{ t: "数据源" }, { t: "状态" }, { t: "最近成功" }, { t: "最近错误" }],
    Object.entries(names).map(([k, n]) => {
      const s = st[k] || {};
      return [n, s.ok ? '<span class="ok">✓ 正常</span>' : s.last_error ? '<span class="fail">✕ 失败</span>' : "—",
        s.last_success || "—", esc(s.ok ? "" : s.last_error || "")];
    }));
}

// ------------------------------------------------------------------ boot

async function main() {
  const [usage, changes, lite, or, gpu, cpu, refs, status] = await Promise.all([
    load("token_usage/milestones.csv"), load("llm/price_changes.csv"), load("llm/latest_litellm.json", "json"),
    load("llm/latest_openrouter.json", "json"), load("compute/gpu_daily.csv"), load("compute/cpu_daily.csv"),
    load("compute/ref_instances.csv"), load("meta/status.json", "json"),
  ]);
  const renderAll = () => {
    renderUsage(usage); initLLM(changes, lite, or); initGPU(gpu); renderCPU(cpu, refs); renderStatus(status);
  };
  $("#refKind").onchange = () => renderCPU(cpu, refs);
  renderAll();
  // Re-read CSS tokens when the OS theme flips so the charts follow.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderAll);
}
main();

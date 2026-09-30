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

const byDate = (a, b) => (a.date || a.week).localeCompare(b.date || b.week);
const uniq = (xs) => [...new Set(xs)];
const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 864e5;

// ---------------------------------------------------------------- styling

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const slot = (i) => css(`--s${(i % 8) + 1}`);
const MUTED = () => css("--muted");

// Colour follows the entity everywhere on the page (never its rank).
const VENDOR_ORDER = ["OpenAI", "Anthropic", "Google", "xAI", "DeepSeek", "通义千问", "Kimi", "智谱 GLM"];
const vendorColor = (v) => (VENDOR_ORDER.includes(v) ? slot(VENDOR_ORDER.indexOf(v)) : MUTED());
const CLOUD_ORDER = ["aws", "gcp", "azure", "lambda", "runpod", "nebius", "vast (实时市场)", "vast"];
const cloudColor = (c) => (CLOUD_ORDER.includes(c) ? slot(CLOUD_ORDER.indexOf(c)) : MUTED());
const CLOUD_LABEL = { aws: "AWS", gcp: "Google Cloud", azure: "Azure", lambda: "Lambda", runpod: "RunPod",
  nebius: "Nebius", vast: "Vast.ai (目录)", "vast (实时市场)": "Vast.ai (实时市场)", cudo: "Cudo",
  fluidstack: "FluidStack", hyperbolic: "Hyperbolic" };
const MINOR_CLOUDS = new Set(["cudo", "fluidstack", "hyperbolic"]);

function fmtUSD(v) {
  if (v == null || isNaN(v)) return "–";
  const a = Math.abs(v);
  return "$" + (a >= 100 ? v.toFixed(0) : a >= 1 ? v.toFixed(2) : a >= 0.01 ? v.toFixed(3) : v.toPrecision(2));
}
const fmtUSDTick = (v) => "$" + +(+v).toPrecision(3);
function fmtTok(v) {
  if (v >= 1e16) return +(v / 1e16).toPrecision(3) + " 亿亿";
  if (v >= 1e12) return +(v / 1e12).toPrecision(3) + " 万亿";
  if (v >= 1e8) return +(v / 1e8).toPrecision(3) + " 亿";
  return (+v).toLocaleString();
}
const fmtPct = (v, digits = 0) => (v == null || !isFinite(v) ? "–" : (v > 0 ? "+" : "") + v.toFixed(digits) + "%");
// Price going down is good (green ↓); up is bad (red ↑). Arrow + sign, never colour alone.
function deltaPrice(p) {
  if (p == null || !isFinite(p)) return "–";
  if (Math.abs(p) < 0.5) return "持平";
  return p < 0 ? `<span class="down">↓ ${p.toFixed(0)}%</span>` : `<span class="up">↑ +${p.toFixed(0)}%</span>`;
}
function deltaGrowth(p, digits = 0) {
  if (p == null || !isFinite(p)) return "–";
  return p >= 0 ? `<span class="down">↑ +${p.toFixed(digits)}%</span>` : `<span class="up">↓ ${p.toFixed(digits)}%</span>`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const isNiceLog = (v) => { const m = v / 10 ** Math.floor(Math.log10(v)); return [1, 2, 5].some((n) => Math.abs(m - n) < 1e-9); };

function baseOptions({ logY = false, yFmt = fmtUSD, tickFmt = fmtUSDTick, tipFmt, legend = true, stacked = false,
  xType = "time", yMax, zero = true } = {}) {
  const ink2 = css("--ink-2"), muted = css("--muted"), grid = css("--grid"), axis = css("--axis");
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: stacked ? "index" : "nearest", axis: "x", intersect: false },
    scales: {
      x: { type: xType, ...(xType === "time" ? { time: { tooltipFormat: "yyyy-MM-dd", minUnit: "day" } } : {}),
        stacked, grid: { display: false }, border: { color: axis },
        ticks: { color: muted, maxRotation: 0, autoSkipPadding: 16 } },
      y: { type: logY ? "logarithmic" : "linear", beginAtZero: zero && !logY, stacked, max: yMax,
        grid: { color: grid }, border: { display: false },
        ticks: { color: muted, callback: (v) => (logY && !isNiceLog(v) ? "" : tickFmt(v)) } },
    },
    plugins: {
      legend: { display: legend, position: "bottom", labels: { color: ink2, usePointStyle: true, boxHeight: 7, padding: 14 } },
      tooltip: { callbacks: { label: tipFmt || ((c) => ` ${c.dataset.label}: ${yFmt(c.parsed.y)}`) } },
    },
    elements: { line: { borderWidth: 2 }, point: { radius: 0, hoverRadius: 5, hitRadius: 8 },
      bar: { borderRadius: 3, borderSkipped: "bottom" } },
  };
}

function draw(id, config) {
  charts[id]?.destroy();
  charts[id] = new Chart(document.getElementById(id), config);
}

function table(el, head, rows) {
  el.innerHTML = `<thead><tr>${head.map((h) => `<th class="${h.cls || ""}">${h.t}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${head[i].cls || ""}">${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
}

function tiles(el, items) {
  el.innerHTML = items.map((t) => `<div class="tile"><div class="k">${t.k}</div><div class="v">${t.v}</div><div class="d">${t.d || ""}</div></div>`).join("");
}

// ------------------------------------------------------------ token usage

const REGION_ORDER = ["中国", "美国", "欧洲", "其他"];

function renderUsage(vendorRows, modelRows) {
  if (!vendorRows.length) { $("#usageTiles").innerHTML = '<p class="hint">暂无 OpenRouter 用量数据。</p>'; return; }
  const done = vendorRows.filter((r) => r.complete === "1");
  const weeks = uniq(done.map((r) => r.week)).sort();
  // Highlight the 8 biggest vendors of the last 12 weeks. Vendors in the page-wide map keep
  // their colour; newcomers take the slots left free.
  const recent = new Set(weeks.slice(-12)), vol = {};
  for (const r of done) if (recent.has(r.week) && r.region !== "未归类") vol[r.vendor] = (vol[r.vendor] || 0) + +r.tokens;
  const top = Object.keys(vol).sort((a, b) => vol[b] - vol[a]).slice(0, 8);
  const free = [...Array(8).keys()].filter((i) => !top.some((v) => VENDOR_ORDER.indexOf(v) === i));
  const topColor = Object.fromEntries(top.map((v) => [v, VENDOR_ORDER.includes(v) ? vendorColor(v) : slot(free.shift())]));
  const OTHER_V = "其他厂商", OUTSIDE = "前 50 名以外";
  const total = {}, byVendor = {}, byRegion = {};
  for (const r of done) {
    const t = +r.tokens;
    total[r.week] = (total[r.week] || 0) + t;
    const v = top.includes(r.vendor) ? r.vendor : r.vendor === OUTSIDE ? OUTSIDE : OTHER_V;
    (byVendor[v] ||= {})[r.week] = (byVendor[v][r.week] || 0) + t;
    const g = r.region === "未归类" ? "未归类" : REGION_ORDER.includes(r.region) ? r.region : "其他";
    (byRegion[g] ||= {})[r.week] = (byRegion[g][r.week] || 0) + t;
  }
  const n = weeks.length, w = weeks[n - 1], w1 = weeks[n - 2], w4 = weeks[n - 5];
  const w52 = weeks.find((x) => daysBetween(x, w) <= 364);
  const cn = (x) => ((byRegion["中国"]?.[x] || 0) / total[x]) * 100;
  tiles($("#usageTiles"), [
    { k: `最近一周（${w} 起）`, v: fmtTok(total[w]), d: `日均 ${fmtTok(total[w] / 7)}` },
    { k: "周环比", v: deltaGrowth((total[w] / total[w1] - 1) * 100, 1), d: `上周 ${fmtTok(total[w1])}` },
    { k: "近 4 周增长", v: deltaGrowth((total[w] / total[w4] - 1) * 100), d: `4 周前 ${fmtTok(total[w4])}` },
    { k: "一年增长", v: w52 ? (total[w] / total[w52]).toFixed(1) + " 倍" : "–", d: w52 ? `对比 ${w52} 当周` : "" },
    { k: "中国厂商模型份额", v: cn(w).toFixed(0) + "%", d: `4 周前 ${cn(w4).toFixed(0)}%；一年前 ${w52 ? cn(w52).toFixed(0) + "%" : "–"}` },
  ]);

  const logY = $("#usageScale").value === "log";
  draw("usageTotalChart", { type: "bar", data: { datasets: [{
    label: "OpenRouter 周总量", data: weeks.map((x) => ({ x, y: total[x] })), backgroundColor: slot(0),
    barPercentage: 0.9, categoryPercentage: 1,
  }] }, options: baseOptions({ logY, legend: false, yFmt: fmtTok, tickFmt: fmtTok,
    tipFmt: (c) => {
      const prev = c.dataIndex > 0 ? weeks[c.dataIndex - 1] : null;
      return [` 周总量: ${fmtTok(c.parsed.y)} tokens`, prev ? ` 周环比: ${fmtPct((c.parsed.y / total[prev] - 1) * 100, 1)}` : ""];
    } }) });

  const by = $("#shareBy").value;
  const groups = by === "vendor" ? [...top, OTHER_V, OUTSIDE] : [...REGION_ORDER, "未归类"];
  const src = by === "vendor" ? byVendor : byRegion;
  const color = (g, i) => (g === OUTSIDE || g === "未归类" ? css("--axis") : g === OTHER_V || g === "其他" ? MUTED()
    : by === "vendor" ? topColor[g] : slot(i));
  draw("usageShareChart", { type: "bar", data: { datasets: groups.filter((g) => src[g]).map((g, i) => ({
    label: g, backgroundColor: color(g, i), borderRadius: 0, barPercentage: 1, categoryPercentage: 1,
    data: weeks.map((x) => ({ x, y: ((src[g][x] || 0) / total[x]) * 100 })),
  })) }, options: baseOptions({ stacked: true, yMax: 100, yFmt: (v) => v.toFixed(0) + "%", tickFmt: (v) => v + "%",
    tipFmt: (c) => ` ${c.dataset.label}: ${c.parsed.y.toFixed(1)}%` }) });

  // Top models this week vs last week.
  const mw = uniq(modelRows.map((r) => r.week)).filter((x) => weeks.includes(x)).sort();
  const last = mw[mw.length - 1], prevW = mw[mw.length - 2];
  const prevTok = Object.fromEntries(modelRows.filter((r) => r.week === prevW).map((r) => [r.model, +r.tokens]));
  $("#topModelsTitle").textContent = `最近一周（${last} 起）Top 15 模型`;
  table($("#topModels"), [{ t: "#" }, { t: "模型" }, { t: "厂商" }, { t: "周 tokens", cls: "num" }, { t: "占全平台", cls: "num" }, { t: "周环比", cls: "num" }],
    modelRows.filter((r) => r.week === last).slice(0, 15).map((r, i) => [i + 1, esc(r.model), esc(r.vendor), fmtTok(+r.tokens),
      ((+r.tokens / total[last]) * 100).toFixed(1) + "%",
      prevTok[r.model] ? deltaGrowth((+r.tokens / prevTok[r.model] - 1) * 100) : "新进榜"]));
}

const PERIOD_DAYS = { day: 1, week: 7, month: 30.44, quarter: 91.3 };

function renderMilestones(rows) {
  const entities = uniq(rows.map((r) => r.entity));
  const datasets = entities.map((e, i) => ({
    label: e, borderColor: slot(i), backgroundColor: slot(i), pointRadius: 4, pointHoverRadius: 6,
    pointBorderColor: css("--surface"), pointBorderWidth: 2,
    data: rows.filter((r) => r.entity === e).sort(byDate)
      .map((r) => ({ x: r.date, y: +r.tokens / PERIOD_DAYS[r.period], note: r.note })),
  }));
  draw("usageChart", { type: "line", data: { datasets }, options: baseOptions({ logY: true, yFmt: fmtTok, tickFmt: fmtTok,
    tipFmt: (c) => [` ${c.dataset.label}: ${fmtTok(c.parsed.y)} tokens/日`, ` ${c.raw.note}`] }) });
  table($("#usageTable"), [{ t: "日期" }, { t: "机构" }, { t: "日均 tokens", cls: "num" }, { t: "说明" }],
    [...rows].sort((a, b) => b.date.localeCompare(a.date)).map((r) => [
      r.date, esc(r.entity), fmtTok(+r.tokens / PERIOD_DAYS[r.period]),
      r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(r.note)}</a>` : esc(r.note)]));
}

// ------------------------------------------------------------- LLM prices

const US_VENDORS = ["OpenAI", "Anthropic", "Google", "xAI"];
const CN_VENDORS = ["DeepSeek", "通义千问", "Kimi", "智谱 GLM", "MiniMax"];
const llm = { events: {}, lineages: null };

function priceOf(ev, kind) {
  const i = +ev.input_usd_per_mtok, o = +ev.output_usd_per_mtok;
  return kind === "input" ? i : kind === "output" ? o : (3 * i + o) / 4;
}

// The price table occasionally carries a typo for a few days before it is fixed. A price that
// lasted under 10 days is treated as such a glitch: the corrected price takes over its date.
function dropGlitches(evs) {
  const out = [];
  for (const e of evs) {
    const prev = out[out.length - 1];
    if (prev && e.event !== "removed" && prev.event !== "removed" && daysBetween(prev.date, e.date) < 10) {
      out[out.length - 1] = { ...e, date: prev.date, event: prev.event };
    } else out.push(e);
  }
  return out;
}

// Resolve a generation to its launch date and its own price events.
function genEvents(g) {
  const own = (llm.events[g.model] || []).filter((e) => e.event !== "removed");
  const start = own.length ? own[0].date : null;
  const early = (g.aliases || []).flatMap((a) => llm.events[a] || [])
    .filter((e) => e.event !== "removed" && (!start || e.date < start)).sort(byDate);
  const evs = [...early, ...own];
  return evs.length ? { start: evs[0].date, evs } : null;
}

// Stepped series for a product line: each generation's price holds until the next one launches.
function lineSeries(line, kind) {
  const gens = line.generations.map((g) => ({ ...g, ...genEvents(g) })).filter((g) => g.start)
    .sort((a, b) => a.start.localeCompare(b.start));
  const pts = [];
  gens.forEach((g, i) => {
    const end = gens[i + 1]?.start || "9999";
    g.evs.filter((e) => e.date < end).forEach((e, j) => {
      const y = priceOf(e, kind);
      if (y > 0) pts.push({ x: j === 0 ? g.start : e.date, y, gen: g.label, launch: j === 0 });
    });
  });
  const last = pts[pts.length - 1];
  if (last && last.x < TODAY) pts.push({ x: TODAY, y: last.y, gen: last.gen, launch: false });
  return { gens, pts };
}

function stepDataset(label, pts, color) {
  return { label, data: pts, stepped: "before", borderColor: color, backgroundColor: color,
    pointRadius: pts.map((p) => (p.launch ? 4 : 0)), pointBorderColor: css("--surface"), pointBorderWidth: 2 };
}

const llmTip = (c) => ` ${c.dataset.label} · ${c.raw.gen}: ${fmtUSD(c.parsed.y)} / 1M`;

function renderLLM() {
  const kind = $("#llmKind").value;
  const V = llm.lineages.vendors;
  const flag = (names) => V.filter((v) => names.includes(v.vendor)).map((v) => {
    const line = v.lines.find((l) => l.flagship) || v.lines[0];
    return stepDataset(v.vendor, lineSeries(line, kind).pts, vendorColor(v.vendor));
  });
  draw("flagUS", { type: "line", data: { datasets: flag(US_VENDORS) }, options: baseOptions({ logY: true, tipFmt: llmTip }) });
  draw("flagCN", { type: "line", data: { datasets: flag(CN_VENDORS) }, options: baseOptions({ logY: true, tipFmt: llmTip }) });

  const vendor = V.find((v) => v.vendor === $("#llmVendor").value);
  const series = vendor.lines.map((l) => ({ line: l, ...lineSeries(l, kind) }));
  draw("lineChart", { type: "line", data: { datasets: series.map((s, i) => stepDataset(s.line.line, s.pts, slot(i))) },
    options: baseOptions({ logY: true, tipFmt: llmTip }) });

  const rows = [];
  for (const s of series) {
    s.gens.forEach((g, i) => {
      const p0 = priceOf(g.evs[0], kind);
      const prev = i > 0 ? priceOf(s.gens[i - 1].evs[0], kind) : null;
      const cur = g.evs.filter((e) => e.date < (s.gens[i + 1]?.start || "9999")).pop();
      rows.push([esc(s.line.line), esc(g.label), g.start, fmtUSD(+g.evs[0].input_usd_per_mtok), fmtUSD(+g.evs[0].output_usd_per_mtok),
        prev ? deltaPrice((p0 / prev - 1) * 100) : "—",
        Math.abs(priceOf(cur, kind) - p0) > 1e-9 ? `之后调价至 ${fmtUSD(priceOf(cur, kind))}` : ""]);
    });
  }
  table($("#genTable"), [{ t: "产品线" }, { t: "代际" }, { t: "收录日期" }, { t: "输入 $/1M", cls: "num" }, { t: "输出 $/1M", cls: "num" },
    { t: "较上一代（所选口径）", cls: "num" }, { t: "备注" }], rows);
}

function renderChanges(changes) {
  const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const lite = changes.filter((r) => r.source === "litellm");
  const recent = lite.filter((r) => r.date >= since && r.event === "change").sort((a, b) => b.date.localeCompare(a.date));
  table($("#llmChanges"), [{ t: "日期" }, { t: "模型" }, { t: "变动（输出价）" }, { t: "输入 $/1M", cls: "num" }, { t: "输出 $/1M", cls: "num" }],
    recent.map((r) => {
      const prev = lite.filter((p) => p.model === r.model && p.date < r.date && p.event !== "removed").pop();
      const d = prev && +prev.output_usd_per_mtok ? (+r.output_usd_per_mtok / +prev.output_usd_per_mtok - 1) * 100 : null;
      return [r.date, esc(r.model), deltaPrice(d), fmtUSD(+r.input_usd_per_mtok), fmtUSD(+r.output_usd_per_mtok)];
    }));
}

function renderLLMLatest(latest) {
  const src = latest[$("#llmSource").value] || {};
  const f = $("#llmFilter").value.trim().toLowerCase();
  const rows = Object.entries(src).filter(([m, v]) => !f || m.toLowerCase().includes(f) || v.provider.includes(f))
    .sort((a, b) => b[1].output - a[1].output);
  table($("#llmLatest"), [{ t: "模型" }, { t: "厂商" }, { t: "输入 $/1M", cls: "num" }, { t: "输出 $/1M", cls: "num" }],
    rows.slice(0, 300).map(([m, v]) => [esc(m), esc(v.provider), fmtUSD(v.input), fmtUSD(v.output)]));
}

function initLLM(changes, lineages, latest) {
  llm.lineages = lineages;
  llm.events = {};
  for (const r of changes) if (r.source === "litellm") (llm.events[r.model] ||= []).push(r);
  for (const k in llm.events) llm.events[k] = dropGlitches(llm.events[k].sort(byDate));
  if (!$("#llmVendor").options.length) {
    $("#llmVendor").innerHTML = lineages.vendors.map((v) => `<option>${esc(v.vendor)}</option>`).join("");
    $("#llmSource").innerHTML = [["litellm", "LiteLLM（厂商官方价）"], ["openrouter", "OpenRouter"]]
      .filter(([s]) => latest[s]).map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
  }
  $("#llmVendor").onchange = $("#llmKind").onchange = renderLLM;
  $("#llmSource").onchange = $("#llmFilter").oninput = () => renderLLMLatest(latest);
  renderLLM();
  renderChanges(changes);
  renderLLMLatest(latest);
}

// ------------------------------------------------------------------ GPUs

const GPU_ORDER = ["B300", "B200", "GB200", "H200", "H100", "GH200", "MI300X", "A100-80GB", "A100", "L40S",
  "RTXPRO6000", "RTX5090", "RTX4090", "L4", "A10G", "A10", "V100", "T4"];

function gpuEntity(r) { return r.source === "vast_live" ? "vast (实时市场)" : r.cloud; }

function renderGPU(rows) {
  const gpu = $("#gpuType").value, metric = $("#gpuMetric").value;
  const sel = rows.filter((r) => r.gpu === gpu && r[metric] !== "");
  const ents = uniq(sel.map(gpuEntity)).filter((e) => e !== "ALL")
    .sort((a, b) => (CLOUD_ORDER.indexOf(a) + 1 || 99) - (CLOUD_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  const series = (e) => sel.filter((r) => gpuEntity(r) === e).sort(byDate).map((r) => ({ x: r.date, y: +r[metric] }));
  const datasets = [
    { label: "全市场", data: series("ALL"), borderColor: css("--ink"), backgroundColor: css("--ink"), borderWidth: 3 },
    ...ents.map((e) => { const d = series(e); return { label: CLOUD_LABEL[e] || e, data: d, borderColor: cloudColor(e),
      backgroundColor: cloudColor(e), borderDash: CLOUD_ORDER.includes(e) ? [] : [5, 4], hidden: MINOR_CLOUDS.has(e),
      pointRadius: d.length < 5 ? 3 : 0 }; }),
  ];
  draw("gpuChart", { type: "line", data: { datasets }, options: baseOptions({
    tipFmt: (c) => ` ${c.dataset.label}: ${fmtUSD(c.parsed.y)} / GPU·时` }) });
}

function initGPU(rows) {
  if (!rows.length) return;
  const index = rows.filter((r) => r.cloud === "ALL").sort(byDate);
  const lastDate = index[index.length - 1].date;
  const present = uniq(rows.filter((r) => daysBetween(r.date, lastDate) < 7).map((r) => r.gpu));
  const gpus = [...GPU_ORDER.filter((g) => present.includes(g)), ...present.filter((g) => !GPU_ORDER.includes(g)).sort()];

  tiles($("#gpuTiles"), ["B200", "H200", "H100", "A100-80GB", "RTX4090"].filter((g) => index.some((r) => r.gpu === g)).map((g) => {
    const s = index.filter((r) => r.gpu === g);
    const now = s[s.length - 1], ago = s.filter((r) => daysBetween(r.date, now.date) >= 350).pop();
    return { k: `${g} 市场指数`, v: fmtUSD(+now.median_usd_per_gpu_hr) + "/时",
      d: ago ? `一年前 ${fmtUSD(+ago.median_usd_per_gpu_hr)}，${deltaPrice((now.median_usd_per_gpu_hr / ago.median_usd_per_gpu_hr - 1) * 100)}` : "历史不足一年" };
  }));

  if (!$("#gpuType").options.length) {
    $("#gpuType").innerHTML = gpus.map((g) => `<option${g === "H100" ? " selected" : ""}>${g}</option>`).join("");
  }
  $("#gpuType").onchange = $("#gpuMetric").onchange = () => renderGPU(rows);
  renderGPU(rows);

  // Latest row per (entity, gpu) within the last week.
  const latest = {};
  for (const r of rows.filter((x) => daysBetween(x.date, lastDate) < 7).sort(byDate)) latest[`${gpuEntity(r)}|${r.gpu}`] = r;
  const cols = ["ALL", ...CLOUD_ORDER, ...MINOR_CLOUDS].filter((c) => gpus.some((g) => latest[`${c}|${g}`]));
  table($("#gpuTable"), [{ t: `GPU（${lastDate}）` }, ...cols.map((c) => ({ t: c === "ALL" ? "市场指数" : CLOUD_LABEL[c] || c, cls: "num" }))],
    gpus.map((g) => [g, ...cols.map((c) => {
      const r = latest[`${c}|${g}`];
      return r ? fmtUSD(+(c === "ALL" ? r.median_usd_per_gpu_hr : r.min_usd_per_gpu_hr)) : "";
    })]));
}

// ------------------------------------------------------------------- CPU

function renderCPU(idx, gens) {
  const clouds = uniq(idx.map((r) => r.cloud));
  const t = [];
  for (const c of clouds) {
    const r = idx.filter((x) => x.cloud === c).sort(byDate).pop();
    t.push({ k: `${CLOUD_LABEL[c]} 按需标价指数`, v: (+r.od_index).toFixed(1), d: `2024-01 以来 ${fmtPct(r.od_index - 100, 1)}` });
    t.push({ k: `${CLOUD_LABEL[c]} Spot 价格指数`, v: (+r.spot_index).toFixed(1), d: `2024-01 以来 ${fmtPct(r.spot_index - 100, 0)}；当前平均折扣 ${r.spot_discount_pct}%` });
  }
  tiles($("#cpuTiles"), t);

  const ds = [];
  clouds.forEach((c) => {
    const s = idx.filter((r) => r.cloud === c).sort(byDate);
    ds.push({ label: `${CLOUD_LABEL[c]} 按需`, data: s.map((r) => ({ x: r.date, y: +r.od_index })),
      borderColor: cloudColor(c), backgroundColor: cloudColor(c) });
    ds.push({ label: `${CLOUD_LABEL[c]} Spot`, data: s.map((r) => ({ x: r.date, y: +r.spot_index, disc: r.spot_discount_pct })),
      borderColor: cloudColor(c), backgroundColor: cloudColor(c), borderDash: [5, 4] });
  });
  const opt = baseOptions({ zero: false, yFmt: (v) => v.toFixed(1), tickFmt: (v) => v,
    tipFmt: (c) => ` ${c.dataset.label}: ${c.parsed.y.toFixed(1)}${c.raw.disc ? `（Spot 平均折扣 ${c.raw.disc}%）` : ""}` });
  // Line swatches (not dots) so the legend shows solid = on-demand, dashed = spot.
  Object.assign(opt.plugins.legend.labels, { usePointStyle: false, boxWidth: 28, boxHeight: 0 });
  draw("cpuIndexChart", { type: "line", data: { datasets: ds }, options: opt });

  // Generation ladder: latest snapshot of the chosen cloud.
  if (!$("#genCloud").options.length) {
    const gClouds = uniq(gens.map((r) => r.cloud)).sort((a, b) => CLOUD_ORDER.indexOf(a) - CLOUD_ORDER.indexOf(b));
    $("#genCloud").innerHTML = gClouds.map((c) => `<option value="${c}">${CLOUD_LABEL[c]}</option>`).join("");
  }
  $("#genCloud").onchange = () => renderCPU(idx, gens);
  const cloud = $("#genCloud").value;
  const rows = gens.filter((r) => r.cloud === cloud);
  const lastD = rows.map((r) => r.date).sort().pop();
  const snap = rows.filter((r) => r.date === lastD).sort((a, b) => a.line.localeCompare(b.line));
  draw("genChart", { type: "bar", data: { labels: snap.map((r) => r.generation), datasets: [
    { label: "按需", data: snap.map((r) => +r.usd_per_hr), backgroundColor: cloudColor(cloud) },
    { label: "Spot", data: snap.map((r) => (r.spot_usd_per_hr ? +r.spot_usd_per_hr : null)), backgroundColor: css("--axis") },
  ] }, options: baseOptions({ xType: "category",
    tipFmt: (c) => ` ${snap[c.dataIndex].line} · ${snap[c.dataIndex].instance} ${c.dataset.label}: ${fmtUSD(c.parsed.y)} / 时` }) });

  const trs = [];
  for (const l of uniq(snap.map((r) => r.line))) {
    const g = snap.filter((r) => r.line === l);
    g.forEach((r, i) => {
      const hist = rows.filter((x) => x.instance === r.instance && x.spot_usd_per_hr).sort(byDate);
      const yearAgo = hist.filter((x) => daysBetween(x.date, lastD) >= 350).pop();
      trs.push([esc(l), esc(r.generation), esc(r.instance), fmtUSD(+r.usd_per_hr),
        i ? deltaPrice((r.usd_per_hr / g[i - 1].usd_per_hr - 1) * 100) : "—",
        r.spot_usd_per_hr ? fmtUSD(+r.spot_usd_per_hr) : "–",
        yearAgo && r.spot_usd_per_hr ? deltaPrice((r.spot_usd_per_hr / yearAgo.spot_usd_per_hr - 1) * 100) : "–"]);
    });
  }
  table($("#cpuGenTable"), [{ t: "产品线" }, { t: "代际" }, { t: "机型" }, { t: "按需 $/时", cls: "num" }, { t: "较上一代", cls: "num" },
    { t: "Spot $/时", cls: "num" }, { t: "Spot 同比", cls: "num" }], trs);
}

// ---------------------------------------------------------------- status

function renderStatus(st) {
  if (!st) return;
  const names = { openrouter_usage: "OpenRouter 用量", litellm: "LiteLLM 价格表", openrouter: "OpenRouter 价格",
    skypilot: "SkyPilot 云价格目录", azure: "Azure 零售价 API", vast: "Vast.ai 实时市场" };
  table($("#statusTable"), [{ t: "数据源" }, { t: "状态" }, { t: "最近成功" }, { t: "最近错误" }],
    Object.entries(names).map(([k, n]) => {
      const s = st[k] || {};
      return [n, s.ok ? '<span class="ok">✓ 正常</span>' : s.last_error ? '<span class="fail">✕ 失败</span>' : "—",
        s.last_success || "—", esc(s.ok ? "" : s.last_error || "")];
    }));
}

// ------------------------------------------------------------------ boot

async function main() {
  const [wv, wm, milestones, changes, lineages, lite, or, gpu, cpuIdx, cpuGen, status] = await Promise.all([
    load("token_usage/openrouter_weekly_vendor.csv"), load("token_usage/openrouter_weekly_model.csv"),
    load("token_usage/milestones.csv"), load("llm/price_changes.csv"), load("llm/lineages.json", "json"),
    load("llm/latest_litellm.json", "json"), load("llm/latest_openrouter.json", "json"),
    load("compute/gpu_daily.csv"), load("compute/cpu_index.csv"), load("compute/cpu_generations.csv"),
    load("meta/status.json", "json"),
  ]);
  const renderAll = () => {
    renderUsage(wv, wm); renderMilestones(milestones);
    initLLM(changes, lineages, { litellm: lite, openrouter: or });
    initGPU(gpu); renderCPU(cpuIdx, cpuGen); renderStatus(status);
  };
  $("#usageScale").onchange = $("#shareBy").onchange = () => renderUsage(wv, wm);
  renderAll();
  // Re-read CSS tokens when the OS theme flips so the charts follow.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderAll);
}
main();

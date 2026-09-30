/* 个股估值看板 — static page; data comes from companies/<T>/valuation.json + analysis.md
   and data/prices.json (written by valuation/fetch_prices.py in GitHub Actions). */
"use strict";

const SCN = ["bear", "base", "bull"];
const SCN_LABEL = { bear: "Bear", base: "Base", bull: "Bull" };
const REF_LABEL = { target: "12 个月目标", today: "今日合理价" };
const PRICE_REFRESH_MS = 10 * 60 * 1000;

const state = { companies: [], prices: { quotes: {} }, history: {}, charts: [], mdCache: {} };
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

async function getJSON(url, bust) {
  const r = await fetch(bust ? `${url}?t=${Date.now()}` : url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

// ------------------------------------------------------------------ formatting
function money(v, cur = "USD") {
  if (v == null || isNaN(v)) return "—";
  const digits = Math.abs(v) >= 1000 ? 0 : 2;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v);
  } catch { return `${cur} ${v.toFixed(digits)}`; }
}
const moneyShort = (v, cur) => money(v, cur).replace(/\.00$/, "");
function pct(x, digits = 1) {
  if (x == null || isNaN(x)) return "—";
  const s = (Math.abs(x) * 100).toFixed(digits) + "%";
  return x > 0 ? "+" + s : x < 0 ? "−" + s : s;
}
const arrow = (x) => (x > 0 ? '<span class="arrow-pos">▲</span>' : x < 0 ? '<span class="arrow-neg">▼</span>' : "");
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ------------------------------------------------------------------ model helpers
const ref = () => store.get("val.ref", "target");
function quote(c) {
  const q = state.prices.quotes?.[c.ticker];
  if (q && q.price) return { ...q, live: true };
  return { price: c.price_at_report, time: c.price_date, source: "report", live: false };
}
// Companies without a discounted "today" value fall back to the 12-month target.
const refFor = (c) => (ref() === "today" && SCN.every((k) => c.scenarios?.[k]?.today != null) ? "today" : "target");
const refLabel = (c) => REF_LABEL[refFor(c)] + (refFor(c) !== ref() ? "，该公司无折现值" : "");
const scnValue = (c, k, r = refFor(c)) => c.scenarios?.[k]?.[r];
const gapOf = (c) => { const b = scnValue(c, "base"); const p = quote(c).price; return b && p ? b / p - 1 : null; };
function weighted(c, r = refFor(c)) {
  if (c.weighted?.[r] != null) return c.weighted[r];
  let s = 0;
  for (const k of SCN) { const sc = c.scenarios[k]; if (sc?.[r] == null || sc.prob == null) return null; s += sc[r] * sc.prob; }
  return s;
}
function gapWords(g) {
  if (g == null) return "";
  if (Math.abs(g) < 0.005) return "≈ Base";
  return g > 0 ? "上行空间" : "现价高于 Base";
}
function zoneWords(c, p) {
  const [be, ba, bu] = SCN.map((k) => scnValue(c, k));
  if (p < be) return "低于 Bear";
  if (p < ba) return "介于 Bear 与 Base";
  if (p <= bu) return "介于 Base 与 Bull";
  return "高于 Bull";
}

// ------------------------------------------------------------------ 3-month range
function range3m(c, q = quote(c)) {
  if (!q.live || q.high_3m == null || q.low_3m == null) return "";
  const cur = c.currency, md = (d) => (d ? d.slice(5).replace("-", "/") : "");
  const line = (lbl, v, d) => `<span class="l">${lbl}</span><b class="num">${money(v, cur)}</b><i>${md(d)}</i>
    <span class="d num">距${lbl} ${pct(q.price / v - 1)}</span>`;
  return `<div class="r3m"><span class="k">近 3 个月</span>
    ${line("最高", q.high_3m, q.high_3m_date)}${line("最低", q.low_3m, q.low_3m_date)}</div>`;
}

// ------------------------------------------------------------------ range bar
function rangeBar(c) {
  const cur = c.currency;
  const p = quote(c).price;
  const v = Object.fromEntries(SCN.map((k) => [k, scnValue(c, k)]));
  if (SCN.some((k) => v[k] == null) || !p) return "";
  const lo0 = Math.min(v.bear, p), hi0 = Math.max(v.bull, p), pad = (hi0 - lo0) * 0.04;
  const lo = lo0 - pad, hi = hi0 + pad;
  const x = (val) => ((val - lo) / (hi - lo)) * 100;
  const edge = (pos) => (pos < 8 ? " edge-l" : pos > 92 ? " edge-r" : "");
  let h = `<div class="rb" role="img" aria-label="Bear ${moneyShort(v.bear, cur)}，Base ${moneyShort(v.base, cur)}，Bull ${moneyShort(v.bull, cur)}，现价 ${money(p, cur)}">`;
  h += `<div class="rb-track"></div>`;
  h += `<div class="rb-zone lo" style="left:${x(v.bear)}%;width:${x(v.base) - x(v.bear)}%"></div>`;
  h += `<div class="rb-zone hi" style="left:${x(v.base)}%;width:${x(v.bull) - x(v.base)}%"></div>`;
  for (const k of SCN) {
    const pos = x(v[k]);
    h += `<div class="rb-tick ${k}" style="left:${pos}%"></div>`;
    h += `<div class="rb-lab${edge(pos)}" style="left:${pos}%">${SCN_LABEL[k]} ${moneyShort(v[k], cur)}</div>`;
  }
  const pp = x(p);
  h += `<div class="rb-dot" style="left:${pp}%"></div><div class="rb-plab${edge(pp)}" style="left:${pp}%">现价 ${money(p, cur)}</div>`;
  return h + "</div>";
}

function priceStamp() {
  const u = state.prices.updated;
  const el = $("#priceStamp");
  if (!u) { el.textContent = "尚未抓取实时价格，暂用研究报告日的股价"; return; }
  const stale = Object.values(state.prices.quotes || {}).some((q) => q.stale);
  el.textContent = `价格更新于 ${fmtTime(u)}${stale ? "（部分沿用上次价格）" : ""}`;
}

// ------------------------------------------------------------------ overview
function renderOverview() {
  $("#sortWrap").hidden = false;
  document.title = "个股估值看板";
  const by = store.get("val.sort", "gap");
  const list = [...state.companies];
  if (by === "gap") list.sort((a, b) => (gapOf(b) ?? -9) - (gapOf(a) ?? -9));
  else if (by === "date") list.sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)));
  else list.sort((a, b) => a.ticker.localeCompare(b.ticker));

  if (!list.length) { $("#app").innerHTML = `<p class="hint">还没有公司。在 <code>docs/valuation/companies/</code> 下新建文件夹即可。</p>`; return; }
  const cards = list.map((c) => {
    const q = quote(c), g = gapOf(c), cur = c.currency;
    const cells = SCN.map((k) => {
      const v = scnValue(c, k);
      return `<div class="${k}"><div class="l">${SCN_LABEL[k]} · ${Math.round((c.scenarios[k].prob ?? 0) * 100)}%</div>
        <div class="p num">${moneyShort(v, cur)}</div><div class="d num">${pct(v / q.price - 1, 0)}</div></div>`;
    }).join("");
    return `<a class="co" href="#/${encodeURIComponent(c.dir)}">
      <div class="co-head"><div><span class="tk">${esc(c.ticker)}</span> <span class="nm">${esc(c.full_name || c.name || "")}</span></div>
        <span class="co-date">研究于 ${esc(c.report_date)}</span></div>
      <div class="co-px"><span class="px num">${money(q.price, cur)}</span>
        <span class="chg num">${q.live ? `${arrow(q.change_pct)} ${pct(q.change_pct, 2)} 今日` : "报告日价格"}</span></div>
      ${range3m(c, q)}
      <div class="gap"><span class="v num">${arrow(g)} ${pct(g)}</span>
        <span class="k">${gapWords(g)} · Base ${moneyShort(scnValue(c, "base"), cur)}（${refLabel(c)}）</span></div>
      ${rangeBar(c)}
      <div class="scn">${cells}</div>
      ${c.stance ? `<div class="stance">${esc(c.stance)}</div>` : ""}
    </a>`;
  }).join("");
  $("#app").innerHTML = `<div class="grid">${cards}</div>`;
}

// ------------------------------------------------------------------ detail
function scenarioTable(c) {
  const cur = c.currency, p = quote(c).price, r = refFor(c);
  const head = `<tr><th></th>${SCN.map((k) => `<th class="c ${k}">${SCN_LABEL[k]}</th>`).join("")}</tr>`;
  const row = (name, f, cls = "") => `<tr class="${cls}"><td>${name}</td>${SCN.map((k) => `<td class="c ${k}">${f(k)}</td>`).join("")}</tr>`;
  const sc = (k) => c.scenarios[k];
  let body = "";
  body += row(`12 个月目标价${c.horizon ? `<span class="note">${esc(c.horizon)}</span>` : ""}`, (k) => moneyShort(sc(k).target, cur), r === "target" ? "hl" : "");
  if (SCN.some((k) => sc(k).today != null)) body += row("今日合理价<span class=\"note\">目标价折现</span>", (k) => moneyShort(sc(k).today, cur), r === "today" ? "hl" : "");
  body += row(`vs 现价<span class="note">按${refLabel(c)}</span>`, (k) => `${arrow(sc(k)[r] / p - 1)} ${pct(sc(k)[r] / p - 1, 0)}`);
  body += row("概率", (k) => `${Math.round((sc(k).prob ?? 0) * 100)}%`);
  body += `<tr class="narr"><td>情景</td>${SCN.map((k) => `<td class="${k}">${esc(sc(k).narrative || "")}</td>`).join("")}</tr>`;
  if (c.assumptions?.length) {
    body += `<tr class="sec"><td colspan="4">核心假设</td></tr>`;
    for (const a of c.assumptions) {
      body += row(`${esc(a.name)}${a.note ? `<span class="note">${esc(a.note)}</span>` : ""}`, (k) => esc(a[k]), a.note ? "has-note" : "");
      if (a.note) body += `<tr class="noterow"><td colspan="4">${esc(a.note)}</td></tr>`;
    }
  }
  if (c.outputs?.length) {
    body += `<tr class="sec"><td colspan="4">推导结果</td></tr>`;
    for (const o of c.outputs) body += row(esc(o.name), (k) => esc(o[k]));
  }
  const w = weighted(c, r);
  return `<h2>情景与核心假设</h2>
    <div class="scroll-x"><table class="st"><thead>${head}</thead><tbody>${body}</tbody></table></div>
    ${w != null ? `<p class="hint">概率加权（${refLabel(c)}）：<b>${moneyShort(w, cur)}</b>，${pct(w / p - 1)} vs 现价。</p>` : ""}
    ${c.notes ? `<p class="hint">${esc(c.notes)}</p>` : ""}`;
}

function pricePanel(c) {
  const q = quote(c), g = gapOf(c), cur = c.currency;
  const since = q.live && c.price_at_report ? q.price / c.price_at_report - 1 : null;
  const src = q.live ? `${q.source === "stooq" ? "Stooq" : "Yahoo Finance"} · ${fmtTime(q.time)}${q.stale ? " · 抓取失败，沿用上次价格" : ""}`
    : `研究报告日（${esc(c.price_date || c.report_date)}）股价，等待首次抓取`;
  return `<h2>现价 vs Base</h2>
    <div class="co-px"><span class="big-px num">${money(q.price, cur)}</span>
      ${q.live ? `<span class="chg num">${arrow(q.change_pct)} ${pct(q.change_pct, 2)} 今日</span>` : ""}
      ${since != null ? `<span class="chg num">研究以来 ${pct(since)}</span>` : ""}</div>
    ${range3m(c, q)}
    <div class="gap"><span class="v num">${arrow(g)} ${pct(g)}</span>
      <span class="k">${gapWords(g)} · Base ${moneyShort(scnValue(c, "base"), cur)}（${refLabel(c)}）· 现价${zoneWords(c, q.price)}</span></div>
    ${rangeBar(c)}
    <div class="chart price" id="pxChartBox"><canvas id="pxChart"></canvas></div>
    <p class="hint">${src}</p>`;
}

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

async function drawPriceChart(c) {
  state.charts.forEach((ch) => ch.destroy());
  state.charts = [];
  const box = $("#pxChartBox");
  if (!box) return;
  let h = state.history[c.ticker];
  if (h === undefined) {
    try { h = await getJSON(`data/history/${c.ticker}.json`, true); } catch { h = null; }
    state.history[c.ticker] = h;
  }
  if (!$("#pxChartBox") || location.hash !== `#/${encodeURIComponent(c.dir)}`) return;
  if (!h?.dates?.length || !window.Chart) {
    box.classList.add("chart-empty");
    box.innerHTML = "价格走势图会在 GitHub Actions 首次抓取 yfinance 数据后出现";
    return;
  }
  const cur = c.currency;
  const pts = h.dates.map((d, i) => ({ x: d, y: h.close[i] }));
  const q = quote(c);
  if (q.live && q.time && q.time.slice(0, 10) > h.dates[h.dates.length - 1]) pts.push({ x: q.time.slice(0, 10), y: q.price });
  const x0 = pts[0].x, x1 = pts[pts.length - 1].x;
  const lines = SCN.map((k) => ({ k, v: scnValue(c, k) }));
  const refDs = lines.map(({ k, v }) => ({
    label: `${SCN_LABEL[k]} ${moneyShort(v, cur)}`, data: [{ x: x0, y: v }, { x: x1, y: v }], _ref: k,
    borderColor: css(`--${k}`), borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, pointHitRadius: 0,
  }));
  const report = c.report_date && c.report_date >= x0 ? [{ x: c.report_date, y: c.price_at_report }] : [];
  const ink2 = css("--ink-2"), grid = css("--grid"), surface = css("--surface");

  const directLabels = {
    id: "directLabels",
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "right";
      chart.data.datasets.forEach((ds, i) => {
        if (!ds._ref) return;
        const y = chart.getDatasetMeta(i).data[1]?.y;
        if (y == null) return;
        const text = ds.label, w = ctx.measureText(text).width;
        ctx.fillStyle = surface; ctx.fillRect(chartArea.right - w - 6, y - 8, w + 6, 16);
        ctx.fillStyle = ink2; ctx.fillText(text, chartArea.right - 3, y + 4);
      });
      ctx.restore();
    },
  };
  const crosshair = {
    id: "crosshair",
    afterDatasetsDraw(chart) {
      const a = chart.tooltip?.getActiveElements?.();
      if (!a?.length) return;
      const { ctx, chartArea } = chart, x = a[0].element.x;
      ctx.save(); ctx.strokeStyle = css("--axis"); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke(); ctx.restore();
    },
  };

  const chart = new Chart($("#pxChart"), {
    type: "line",
    data: {
      datasets: [
        { label: "收盘价", data: pts, borderColor: css("--price"), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0 },
        ...refDs,
        ...(report.length ? [{ label: "研究日", data: report, _report: true, showLine: false, pointRadius: 5, pointHoverRadius: 6,
          pointBackgroundColor: css("--ink"), pointBorderColor: surface, pointBorderWidth: 2 }] : []),
      ],
    },
    options: {
      maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { type: "time", time: { unit: "month", tooltipFormat: "yyyy-MM-dd" }, grid: { display: false }, ticks: { color: ink2, maxRotation: 0 } },
        y: { grid: { color: grid }, border: { display: false }, ticks: { color: ink2, callback: (v) => moneyShort(v, cur) } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (it) => it.datasetIndex === 0 || it.dataset._report,
          callbacks: { label: (it) => `${it.dataset._report ? "研究日股价" : "收盘价"} ${money(it.parsed.y, cur)}` },
        },
      },
    },
    plugins: [directLabels, crosshair],
  });
  state.charts.push(chart);
}

function splitSections(md) {
  const parts = md.split(/^##\s+/m);
  const out = [];
  if (parts[0].trim()) out.push({ title: "概述", body: parts[0] });
  for (const p of parts.slice(1)) {
    const nl = p.indexOf("\n");
    out.push({ title: (nl < 0 ? p : p.slice(0, nl)).trim(), body: nl < 0 ? "" : p.slice(nl + 1) });
  }
  return out;
}
function mdToHtml(md) {
  // CommonMark won't close **bold** after CJK punctuation when a letter/digit follows
  // (e.g. "**结论：**FY28"), so convert bold spans to <strong> up front.
  md = md.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  const html = window.marked ? marked.parse(md) : `<pre>${esc(md)}</pre>`;
  return html.replace(/<table>/g, '<div class="tbl"><table>').replace(/<\/table>/g, "</table></div>");
}

async function renderDetail(dir) {
  const c = state.companies.find((x) => x.dir === dir);
  if (!c) { $("#app").innerHTML = `<a class="back" href="#/">← 全部公司</a><p>找不到 ${esc(dir)}。</p>`; return; }
  $("#sortWrap").hidden = true;
  document.title = `${c.ticker} · 个股估值看板`;
  $("#app").innerHTML = `
    <a class="back" href="#/">← 全部公司</a>
    <div class="d-head">
      <h2>${esc(c.ticker)} <span class="nm">${esc(c.full_name || c.name || "")}</span>${c.stance ? `<span class="chip">${esc(c.stance)}</span>` : ""}</h2>
      <p class="meta">${[c.sector, `研究日期 ${c.report_date}`, c.price_at_report ? `研究时股价 ${money(c.price_at_report, c.currency)}（${c.price_date || c.report_date}）` : "", c.method ? `估值方法：${c.method}` : ""].filter(Boolean).map(esc).join(" · ")}</p>
    </div>
    <div class="d-grid">
      <section class="card" id="dPrice"></section>
      <section class="card" id="dScn"></section>
    </div>
    ${c.summary?.length ? `<section class="card" style="margin-top:20px"><h2>核心结论</h2><ol class="summary">${c.summary.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></section>` : ""}
    <section class="card" id="dAnalysis" style="margin-top:20px"><h2>估值逻辑与分析</h2><p class="hint">加载中…</p></section>`;
  updateDetailPrices(c);

  let md = state.mdCache[dir];
  if (md === undefined) {
    try { const r = await fetch(`companies/${encodeURIComponent(dir)}/analysis.md`, { cache: "no-cache" }); md = r.ok ? await r.text() : null; }
    catch { md = null; }
    state.mdCache[dir] = md;
  }
  const box = $("#dAnalysis");
  if (!box) return;
  if (!md) { box.innerHTML = `<h2>估值逻辑与分析</h2><p class="hint">暂无 analysis.md。</p>`; return; }
  const secs = splitSections(md);
  box.innerHTML = `<h2>估值逻辑与分析</h2>
    <div class="sec-tools"><button type="button" data-open="1">全部展开</button><button type="button" data-open="0">全部收起</button></div>
    ${secs.map((s, i) => `<details class="sec"${i === 0 ? " open" : ""}><summary>${esc(s.title)}</summary><div class="md">${mdToHtml(s.body)}</div></details>`).join("")}`;
  box.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => {
    box.querySelectorAll("details.sec").forEach((d) => (d.open = b.dataset.open === "1"));
  }));
}

function updateDetailPrices(c) {
  if (!$("#dPrice")) return;
  $("#dPrice").innerHTML = pricePanel(c);
  $("#dScn").innerHTML = scenarioTable(c);
  drawPriceChart(c);
}

// ------------------------------------------------------------------ router & boot
function currentDir() {
  const m = location.hash.match(/^#\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}
function render() {
  priceStamp();
  const dir = currentDir();
  if (dir) renderDetail(dir); else { state.charts.forEach((ch) => ch.destroy()); state.charts = []; renderOverview(); }
}
function rerenderPrices() {
  priceStamp();
  const dir = currentDir();
  if (!dir) return renderOverview();
  const c = state.companies.find((x) => x.dir === dir);
  if (c) updateDetailPrices(c);
}

async function loadPrices() {
  try { state.prices = await getJSON("data/prices.json", true); } catch { state.prices = { quotes: {} }; }
}

async function boot() {
  $("#refMode").value = ref();
  $("#sortBy").value = store.get("val.sort", "gap");
  $("#refMode").addEventListener("change", (e) => { store.set("val.ref", e.target.value); rerenderPrices(); });
  $("#sortBy").addEventListener("change", (e) => { store.set("val.sort", e.target.value); renderOverview(); });

  try {
    const idx = await getJSON("companies/index.json", true);
    const [vals] = await Promise.all([
      Promise.all(idx.companies.map((e) => getJSON(`companies/${encodeURIComponent(e.dir)}/valuation.json`, true)
        .then((v) => ({ ...v, dir: e.dir, ticker: v.ticker || e.ticker }))
        .catch((err) => { console.warn(err); return null; }))),
      loadPrices(),
    ]);
    state.companies = vals.filter(Boolean);
  } catch (e) {
    $("#app").innerHTML = `<p class="hint">加载失败：${esc(e.message)}</p>`;
    return;
  }
  window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });
  render();
  setInterval(async () => { await loadPrices(); state.history = {}; rerenderPrices(); }, PRICE_REFRESH_MS);
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => { const dir = currentDir(); const c = dir && state.companies.find((x) => x.dir === dir); if (c) drawPriceChart(c); });
}

boot();

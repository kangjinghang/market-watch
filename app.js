// app.js — 纯原生 JS，fetch 本地 JSON 渲染。无框架依赖。
//
// 用法：直接打开 index.html（需 http server，因为 fetch 受 file:// 限制）。
//   python3 -m http.server 8000 -d reports/out
//   然后浏览器开 http://localhost:8000
//
// URL 参数：
//   无参数     → 显示最新日期
//   ?date=YYYY-MM-DD → 显示指定日期

const $ = (sel) => document.querySelector(sel);

/** 从 URL 拿 date 参数，没有则用 meta 里的 latest_date */
function getTargetDate(meta) {
  const params = new URLSearchParams(location.search);
  return params.get("date") || meta.latest_date;
}

/** fetch JSON 的封装，带错误处理 */
async function fetchJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

/** 渲染密度区：大数字 + sparkline */
function renderDensity(density) {
  const ratioPct = (density.candidates / density.universe * 100).toFixed(1);
  return `
    <section>
      <h2>异动密度</h2>
      <div class="density-main">
        <span class="density-pct">${ratioPct}%</span>
        <span class="density-detail">${density.candidates} / ${density.universe} 只入选</span>
      </div>
      <svg class="sparkline" id="sparkline"></svg>
      <div class="density-detail" id="density-daily">
        单日异动榜 ${density.daily_candidates} 只
      </div>
    </section>`;
}

/** 用历史密度序列画 sparkline（渐变发光 + 脉冲） */
function renderSparkline(series) {
  const svg = $("#sparkline");
  if (!svg || series.points.length < 2) return;

  const w = svg.clientWidth || 320;
  const h = 64;
  const pad = 6;
  const ratios = series.points.map((p) => p.ratio);
  const min = Math.min(...ratios);
  const max = Math.max(...ratios);
  const range = max - min || 1;

  const stepX = (w - pad * 2) / (ratios.length - 1);
  const pts = ratios.map((r, i) => ({
    x: pad + i * stepX,
    y: pad + (1 - (r - min) / range) * (h - pad * 2)
  }));
  const line = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const fill = [...pts, { x: pts[pts.length-1].x, y: h }, { x: pts[0].x, y: h }]
    .map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];

  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.15"/>
        <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="sparkLine" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.9"/>
      </linearGradient>
      <filter id="glow">
        <feGaussianBlur stdDeviation="2.5" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <polygon points="${fill}" fill="url(#sparkFill)"/>
    <polyline points="${line}" fill="none" stroke="url(#sparkLine)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4" fill="#38bdf8" filter="url(#glow)" opacity="0.6"/>
    <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2" fill="#fff" opacity="0.95"/>
  `;
}

/** 渲染板块温度表 */
function renderSectors(sectors) {
  if (!sectors || sectors.length === 0) {
    return `<section><h2>板块温度</h2><div class="density-detail">暂无行业数据</div></section>`;
  }
  const maxCount = sectors[0].count;  // 已按 count 降序
  const rows = sectors.slice(0, 12).map((s) => {
    const barWidth = (s.count / maxCount * 100).toFixed(0);
    return `
      <div class="sector-row">
        <span class="sector-name">${s.name}</span>
        <div class="sector-bar-track"><div class="sector-bar" style="width:${barWidth}%"></div></div>
        <span class="sector-meta">${s.count}只<br>${s.avg_pct > 0 ? "+" : ""}${s.avg_pct}%</span>
      </div>`;
  }).join("");
  return `<section><h2>板块温度（区间异动 Top 12）</h2>${rows}</section>`;
}

/** 渲染候选榜 */
function renderCandidates(candidates, title) {
  if (!candidates || candidates.length === 0) return "";
  const rows = candidates.map((c) => {
    const tag = c.kind === "continued"
      ? '<span class="tag tag-continued">延续</span>'
      : '<span class="tag tag-new">新出</span>';
    const pct = c.pct > 0 ? `+${c.pct}%` : `${c.pct}%`;
    const meta = c.days != null ? `${c.days}天` : "";
    const summary = c.summary ? `<div class="cand-summary">${c.summary}</div>` : "";
    const reason = c.reason ? `<div class="cand-summary">${c.reason}</div>` : "";
    return `
      <div class="cand-row">
        <div>
          <div><span class="cand-name">${c.name}</span>${tag}</div>
          <div class="cand-ticker">${c.ticker}</div>
        </div>
        <div>
          <div class="cand-pct">${pct}</div>
          <div class="cand-meta">${meta}</div>
        </div>
        ${summary}${reason}
      </div>`;
  }).join("");
  return `<section><h2>${title}</h2>${rows}</section>`;
}

/** 渲染历史日期导航 */
function renderHistory(allDates, currentDate) {
  const links = allDates.map((d) => {
    const cls = d === currentDate ? "active" : "";
    return `<a href="?date=${d}" class="${cls}">${d.slice(5)}</a>`;
  }).join("");
  return `<div class="history"><span class="history-label">历史数据</span>${links}</div>`;
}

async function main() {
  try {
    const meta = await fetchJson("meta.json");
    const series = await fetchJson("series/density.json");
    const targetDate = getTargetDate(meta);
    const daily = await fetchJson(`daily/${targetDate}.json`);

    $("#title").textContent = `市场体检 · ${targetDate}`;
    $("#subtitle").textContent = `数据 ${meta.total_days} 天 · ${meta.earliest_date.slice(5)} ~ ${meta.latest_date.slice(5)}`;

    const html =
      renderDensity(daily.density) +
      renderSectors(daily.sectors) +
      renderCandidates(daily.top_candidates, "区间异动 Top 20") +
      renderCandidates(daily.daily_top, "单日异动 Top 20") +
      renderHistory(series.points.map((p) => p.date), targetDate);

    $("#app").innerHTML = html;
    $("#app").className = "";

    // sparkline 需要在 DOM 渲染后画
    renderSparkline(series);
  } catch (e) {
    $("#app").className = "error";
    $("#app").textContent = `加载失败: ${e.message}`;
    console.error(e);
  }
}

main();

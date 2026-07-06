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
    const flags = (c.risk_flags && c.risk_flags.length > 0)
      ? '<span class="risk-flags">' + c.risk_flags.map(f => `<span class="risk-tag">${f}</span>`).join("") + '</span>'
      : "";
    return `
      <div class="cand-row">
        <div>
          <div><span class="cand-name">${c.name}</span>${tag}${flags}</div>
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

/** 渲染趋势死亡模式 */
function renderDeathPatterns(data) {
  if (!data || data.total_deaths === 0) return "";
  const p = data.patterns;
  const total = data.total_deaths;

  const bars = [
    { label: "高位回落", count: p["高位回落"] || 0, color: "#f97316" },
    { label: "利空+下跌", count: (p["利空+下跌"] || 0) + (p["利空事件"] || 0), color: "#ef4444" },
    { label: "闪崩", count: p["闪崩"] || 0, color: "#dc2626" },
    { label: "自然退潮", count: p["自然退潮"] || 0, color: "#6b7280" },
  ].filter(b => b.count > 0);

  const barHtml = bars.map(b => {
    const pct = (b.count / total * 100).toFixed(1);
    return `
      <div class="death-bar-row">
        <span class="death-bar-label">${b.label}</span>
        <div class="death-bar-track">
          <div class="death-bar" style="width:${pct}%;background:${b.color}"></div>
        </div>
        <span class="death-bar-count">${b.count} <span class="death-bar-pct">(${pct}%)</span></span>
      </div>`;
  }).join("");

  // Recent notable deaths
  const recent = (data.recent_deaths || []).slice(0, 5);
  const recentHtml = recent.map(d => {
    const flag = d.pattern !== "自然退潮" ? `<span class="death-pattern-tag death-${d.pattern === "闪崩" ? "crash" : d.pattern.includes("利空") ? "negative" : "drop"}">${d.pattern}</span>` : "";
    return `
      <div class="death-item">
        <span class="death-name">${d.name}</span>
        <span class="death-ticker">${d.ticker}</span>
        ${flag}
        <span class="death-pct">+${d.peak_pct.toFixed(1)}%</span>
        <span class="death-date">${d.death_date.slice(5)}</span>
      </div>`;
  }).join("");

  return `
    <section>
      <h2>趋势死亡模式 · ${data.date_range}</h2>
      <div class="death-summary">共 ${total} 次趋势终止</div>
      ${barHtml}
      ${recentHtml ? `<div class="death-recent-title">近期退场</div>${recentHtml}` : ""}
    </section>`;
}

/** 渲染沉默-火山爆发候选 */
function renderSilenceVolcano(data) {
  if (!data || data.total_candidates === 0) return "";

  const rows = data.candidates.map(c => {
    const statusClass = c.status.includes("极度") ? "sv-hot" : c.status.includes("逼近") ? "sv-warn" : "sv-ok";
    return `
      <div class="sv-row">
        <div class="sv-left">
          <span class="sv-name">${c.name}</span>
          <span class="sv-ticker">${c.ticker}</span>
          <span class="sv-status ${statusClass}">${c.status}</span>
        </div>
        <div class="sv-right">
          <div class="sv-stats">
            <span class="sv-stat">前波 <b>+${c.peak_pct.toFixed(0)}%</b></span>
            <span class="sv-stat">沉默 ${c.silence_days}天</span>
            <span class="sv-stat">量比 ${c.volume_ratio.toFixed(2)}</span>
          </div>
          <div class="sv-price">
            <span>现价 ${c.current_price}</span>
            <span class="sv-fib">0.382=${c.fib_0382}</span>
          </div>
        </div>
      </div>`;
  }).join("");

  return `
    <section>
      <h2>沉默 · 火山爆发</h2>
      <div class="sv-summary">扫描 ${data.total_silent} 个沉默 ticker → ${data.total_candidates} 个通过全部筛选</div>
      ${rows}
    </section>`;
}

/** 渲染概念共现网络 */
function renderConceptCooccurrence(data) {
  if (!data || data.total_concepts === 0) return "";

  // 取 top 20 概念做热力矩阵（太多会看不清）
  const topNodes = data.nodes.slice(0, 20);
  const nodeIds = topNodes.map(n => n.id);

  // 构建边的权重查找表
  const edgeMap = new Map();
  for (const e of data.edges) {
    edgeMap.set(`${e.source}|${e.target}`, e.weight);
    edgeMap.set(`${e.target}|${e.source}`, e.weight);
  }

  // 最大权重（用于颜色映射）
  const maxWeight = Math.max(...data.edges.map(e => e.weight), 1);

  // ── 热力矩阵 ──
  const cellSize = 28;
  const labelW = 72;
  const labelH = 72;
  const matrixW = labelW + nodeIds.length * cellSize + 10;
  const matrixH = labelH + nodeIds.length * cellSize + 10;

  let matrixHtml = `<div class="cc-matrix-wrap"><svg class="cc-matrix" viewBox="0 0 ${matrixW} ${matrixH}">`;

  // 列标签（顶部，旋转 45°）
  for (let j = 0; j < nodeIds.length; j++) {
    const x = labelW + j * cellSize + cellSize / 2;
    const y = labelH - 4;
    matrixHtml += `<text x="${x}" y="${y}" transform="rotate(-45 ${x} ${y})" class="cc-label-vert">${nodeIds[j]}</text>`;
  }

  // 行标签 + 格子
  for (let i = 0; i < nodeIds.length; i++) {
    const y = labelH + i * cellSize;
    matrixHtml += `<text x="${labelW - 4}" y="${y + cellSize / 2 + 4}" class="cc-label-horiz">${nodeIds[i]}</text>`;
    for (let j = 0; j < nodeIds.length; j++) {
      const x = labelW + j * cellSize;
      if (i === j) {
        // 对角线：自身
        matrixHtml += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" class="cc-cell-diag"/>`;
      } else {
        const w = edgeMap.get(`${nodeIds[i]}|${nodeIds[j]}`) ?? 0;
        if (w > 0) {
          const opacity = 0.15 + (w / maxWeight) * 0.85;
          matrixHtml += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" class="cc-cell" fill-opacity="${opacity.toFixed(2)}" data-source="${nodeIds[i]}" data-target="${nodeIds[j]}" data-weight="${w}"><title>${nodeIds[i]} ↔ ${nodeIds[j]}: ${w}</title></rect>`;
        } else {
          matrixHtml += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" class="cc-cell-empty"/>`;
        }
      }
    }
  }

  matrixHtml += `</svg></div>`;

  // ── 力导向图 ──
  // 简易布局：圆形排列节点，边按权重画线
  const graphR = 160;
  const graphCX = 200;
  const graphCY = 180;
  const graphW = 400;
  const graphH = 360;

  // 节点位置（圆形）
  const nodePos = new Map();
  for (let i = 0; i < topNodes.length; i++) {
    const angle = (i / topNodes.length) * Math.PI * 2 - Math.PI / 2;
    nodePos.set(topNodes[i].id, {
      x: graphCX + graphR * Math.cos(angle),
      y: graphCY + graphR * Math.sin(angle),
    });
  }

  let graphHtml = `<svg class="cc-graph" viewBox="0 0 ${graphW} ${graphH}">`;
  // 画边
  for (const e of data.edges) {
    const p1 = nodePos.get(e.source);
    const p2 = nodePos.get(e.target);
    if (!p1 || !p2) continue;
    const strokeWidth = 0.5 + (e.weight / maxWeight) * 4;
    const opacity = 0.1 + (e.weight / maxWeight) * 0.5;
    graphHtml += `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" class="cc-edge" stroke-width="${strokeWidth.toFixed(1)}" opacity="${opacity.toFixed(2)}"><title>${e.source} ↔ ${e.target}: ${e.weight}</title></line>`;
  }
  // 画节点
  const maxNodeCount = topNodes[0]?.count ?? 1;
  for (const n of topNodes) {
    const pos = nodePos.get(n.id);
    if (!pos) continue;
    const r = 4 + (n.count / maxNodeCount) * 10;
    const typeClass = n.type === "technology" ? "cc-node-tech" : n.type === "event" ? "cc-node-event" : "cc-node-sector";
    graphHtml += `<circle cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="${r.toFixed(1)}" class="cc-node ${typeClass}"><title>${n.id}: ${n.count}次</title></circle>`;
    graphHtml += `<text x="${pos.x.toFixed(1)}" y="${(pos.y - r - 3).toFixed(1)}" class="cc-node-label">${n.id}</text>`;
  }
  graphHtml += `</svg>`;

  // ── 图例 + 切换 ──
  const legendHtml = `
    <div class="cc-legend">
      <span class="cc-legend-item"><span class="cc-dot cc-node-sector"></span>行业板块</span>
      <span class="cc-legend-item"><span class="cc-dot cc-node-tech"></span>技术概念</span>
      <span class="cc-legend-item"><span class="cc-dot cc-node-event"></span>事件</span>
    </div>`;

  return `
    <section>
      <h2>概念共现网络 · ${data.date_range}</h2>
      <div class="cc-summary">从 ${data.total_reasons} 条归因文本提取 ${data.total_concepts} 个概念，${data.total_pairs} 个共现对</div>
      <div class="cc-tabs">
        <button class="cc-tab cc-tab-active" onclick="document.getElementById('cc-matrix').style.display='block';document.getElementById('cc-graph').style.display='none';this.classList.add('cc-tab-active');this.nextElementSibling.classList.remove('cc-tab-active')">热力矩阵</button>
        <button class="cc-tab" onclick="document.getElementById('cc-matrix').style.display='none';document.getElementById('cc-graph').style.display='block';this.classList.add('cc-tab-active');this.previousElementSibling.classList.remove('cc-tab-active')">关系图</button>
      </div>
      ${legendHtml}
      <div id="cc-matrix">${matrixHtml}</div>
      <div id="cc-graph" style="display:none">${graphHtml}</div>
    </section>`;
}

/** 渲染排头兵-补涨梯队 */
function renderCatchUpBand(data) {
  if (!data || data.leaders.length === 0) return "";

  // 热门概念 (heat_score >= 10)
  const hotConcepts = data.hot_concepts.filter(c => c.heat_score >= 10).slice(0, 12);
  const maxHeat = hotConcepts[0]?.heat_score ?? 1;

  const heatRows = hotConcepts.map(c => {
    const barPct = (c.heat_score / maxHeat * 100).toFixed(0);
    return `
      <div class="cub-heat-row">
        <span class="cub-heat-concept">${c.concept}</span>
        <span class="cub-heat-count">${c.leader_count}只</span>
        <span class="cub-heat-days">${c.active_days}天</span>
        <div class="cub-heat-bar-track"><div class="cub-heat-bar" style="width:${barPct}%"></div></div>
      </div>`;
  }).join("");

  // 补涨候选
  const catchupRows = data.catchup_candidates.slice(0, 15).map(c => {
    const tags = c.shared_concepts.slice(0, 3).map(ct =>
      `<span class="cub-catchup-tag">${ct}</span>`
    ).join("");
    const pct = c.trend_pct > 0 ? `+${c.trend_pct.toFixed(1)}%` : `${c.trend_pct.toFixed(1)}%`;
    return `
      <div class="cub-catchup-row">
        <div class="cub-catchup-left">
          <span class="cub-catchup-name">${c.name}</span>
          <span class="cub-catchup-ticker">${c.ticker}</span>
          <div class="cub-catchup-concepts">${tags}</div>
        </div>
        <div class="cub-catchup-right">
          <div class="cub-catchup-pct">${pct}</div>
          <div class="cub-catchup-meta">${c.trend_days}天趋势</div>
          <div class="cub-catchup-last">末次 ${c.last_seen.slice(5)}</div>
        </div>
      </div>`;
  }).join("");

  return `
    <section>
      <h2>排头兵 · 补涨梯队 · ${data.date}</h2>
      <div class="cub-summary">近 ${data.lookback_days} 天 ${data.leaders.length} 个排头兵，${data.hot_concepts.length} 个热门概念</div>
      <div class="cub-section-title">热门概念（涨停密度 × 持续天数）</div>
      ${heatRows}
      <div class="cub-section-title">补涨梯队（同概念 + 趋势中 + 今日未涨停）</div>
      ${catchupRows}
    </section>`;
}

/** 渲染市场叙事周报 */
function renderNarrativeWeekly(data) {
  if (!data || !data.weeks || data.weeks.length === 0) return "";

  // 只展示最近 6 周
  const recentWeeks = data.weeks.slice(-6).reverse();

  const cards = recentWeeks.map(w => {
    // Top concepts
    const topTags = w.top_concepts.slice(0, 8).map(c =>
      `<span class="nw-concept-tag">${c.concept}<span class="nw-concept-count">${c.count}</span></span>`
    ).join("");

    // Emerging
    const emergingTags = w.emerging.slice(0, 5).map(c =>
      `<span class="nw-concept-tag nw-emerging-tag">${c.concept}<span class="nw-concept-count">${c.prev_count}→${c.count}</span></span>`
    ).join("");

    // Fading
    const fadingTags = w.fading.slice(0, 5).map(c =>
      `<span class="nw-concept-tag nw-fading-tag">${c.concept}<span class="nw-concept-count nw-fading-count">${c.prev_count}→${c.count}</span></span>`
    ).join("");

    return `
      <div class="nw-card">
        <div class="nw-header">
          <span class="nw-week">${w.week}</span>
          <span class="nw-dates">${w.date_range}</span>
        </div>
        <div class="nw-reasons">${w.total_reasons} 条归因</div>
        <div class="nw-section-label">主线</div>
        <div class="nw-concepts">${topTags}</div>
        ${emergingTags ? `<div class="nw-section-label">新兴热点</div><div class="nw-concepts">${emergingTags}</div>` : ""}
        ${fadingTags ? `<div class="nw-section-label">退潮</div><div class="nw-concepts">${fadingTags}</div>` : ""}
      </div>`;
  }).join("");

  return `
    <section>
      <h2>市场叙事周报</h2>
      ${cards}
    </section>`;
}

/** 渲染概念热度生命周期 */
function renderConceptLifecycle(data) {
  if (!data || !data.concepts || data.concepts.length === 0) return "";

  // Stage filter tabs
  const stages = ["高峰", "升温", "降温", "退潮"];
  const stageCounts = {};
  for (const c of data.concepts) {
    stageCounts[c.stage] = (stageCounts[c.stage] || 0) + 1;
  }

  // 默认显示全部，点击 tab 过滤
  const tabsHtml = stages.map(s => {
    const count = stageCounts[s] || 0;
    if (count === 0) return "";
    return `<button class="cl-tab cl-tab-active" onclick="filterLifecycle('${s}', this)">${s} (${count})</button>`;
  }).join("") + `<button class="cl-tab" onclick="filterLifecycle('all', this)">全部 (${data.concepts.length})</button>`;

  // 构建每行的 mini sparkline
  function makeSparkline(freqSeries, weeks) {
    const w = 200;
    const h = 24;
    const max = Math.max(...freqSeries, 1);
    const stepX = w / (freqSeries.length - 1 || 1);
    const pts = freqSeries.map((f, i) => ({
      x: i * stepX,
      y: h - (f / max) * (h - 4) - 2
    }));
    const line = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const last = pts[pts.length - 1];
    return `<svg class="cl-sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round" opacity="0.7"/>
      <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.5" fill="var(--accent)"/>
    </svg>`;
  }

  const rows = data.concepts.map(c => {
    const stageClass = c.stage === "高峰" ? "cl-stage-peak"
      : c.stage === "升温" ? "cl-stage-heating"
      : c.stage === "退潮" ? "cl-stage-gone"
      : "cl-stage-cooling";
    const sparkline = makeSparkline(c.freq_series, c.weeks);
    return `
      <div class="cl-row" data-stage="${c.stage}">
        <span class="cl-concept">${c.concept}</span>
        ${sparkline}
        <span class="cl-stage ${stageClass}">${c.stage}</span>
        <span class="cl-peak">峰值 ${c.peak_freq}</span>
      </div>`;
  }).join("");

  return `
    <section>
      <h2>概念热度生命周期 · ${data.date_range}</h2>
      <div class="cl-summary">${data.concepts.length} 个概念，追踪 ${data.total_weeks} 周频次变化</div>
      <div class="cl-tabs" id="cl-tabs">${tabsHtml}</div>
      <div id="cl-list">${rows}</div>
    </section>
    <script>
    function filterLifecycle(stage, btn) {
      document.querySelectorAll('.cl-tab').forEach(t => t.classList.remove('cl-tab-active'));
      btn.classList.add('cl-tab-active');
      document.querySelectorAll('.cl-row').forEach(r => {
        r.style.display = (stage === 'all' || r.dataset.stage === stage) ? '' : 'none';
      });
    }
    </script>`;
}

async function main() {
  try {
    const meta = await fetchJson("meta.json");
    const series = await fetchJson("series/density.json");
    const deathPatterns = await fetchJson("death-patterns.json").catch(() => null);
    const silenceVolcano = await fetchJson("silence-volcano.json").catch(() => null);
    const conceptCooccur = await fetchJson("concept-cooccurrence.json").catch(() => null);
    const catchUpBand = await fetchJson("catch-up-band.json").catch(() => null);
    const narrativeWeekly = await fetchJson("narrative-weekly.json").catch(() => null);
    const conceptLifecycle = await fetchJson("concept-lifecycle.json").catch(() => null);
    const targetDate = getTargetDate(meta);
    const daily = await fetchJson(`daily/${targetDate}.json`);

    $("#title").textContent = `市场体检 · ${targetDate}`;
    $("#subtitle").textContent = `数据 ${meta.total_days} 天 · ${meta.earliest_date.slice(5)} ~ ${meta.latest_date.slice(5)}`;

    const html =
      renderDensity(daily.density) +
      renderSectors(daily.sectors) +
      renderCandidates(daily.top_candidates, "区间异动 Top 20") +
      renderCandidates(daily.daily_top, "单日异动 Top 20") +
      renderDeathPatterns(deathPatterns) +
      renderSilenceVolcano(silenceVolcano) +
      renderConceptCooccurrence(conceptCooccur) +
      renderCatchUpBand(catchUpBand) +
      renderNarrativeWeekly(narrativeWeekly) +
      renderConceptLifecycle(conceptLifecycle) +
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

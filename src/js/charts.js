/* ═══════════════════════════════════════════════════════════
   FILL PROTOCOL — Charts
   Dependency-free interactive canvas charts:
   - Live stock market grid (hover crosshair + tooltip)
   - Modal chart with range tabs (1D / 5D / 1M / 6M)
   Data comes from the backend chart proxy. When the backend is
   offline the cards show an explicit OFFLINE state — never fake data.
   ═══════════════════════════════════════════════════════════ */

const MARKET_GRID_SYMBOLS = ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'HOOD', 'COIN'];

const GREEN = '#00C805';
const RED = '#ff4d5e';

// ---------------------------------------------------------------------------
// Interactive chart engine
// Each canvas gets a chart instance: area render + crosshair + tooltip.
// ---------------------------------------------------------------------------
const _charts = new WeakMap();

export function mountChart(canvas) {
  if (_charts.has(canvas)) return _charts.get(canvas);

  const parent = canvas.parentElement;
  if (parent && getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.hidden = true;
  parent?.appendChild(tooltip);

  const state = {
    points: [],      // [{t, c}]
    color: GREEN,
    hoverIdx: -1,
    setData(points, { color = GREEN } = {}) {
      state.points = points || [];
      state.color = color;
      state.hoverIdx = -1;
      tooltip.hidden = true;
      draw();
    },
  };

  function metrics() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    return { dpr, w: Math.max(10, rect.width), h: Math.max(10, rect.height) };
  }

  function scales() {
    const { w, h } = metrics();
    const vals = state.points.map(p => p.c);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const padY = 5;
    return {
      x: (i) => (i / (state.points.length - 1)) * w,
      y: (v) => h - padY - ((v - min) / span) * (h - padY * 2),
      w, h,
    };
  }

  function draw() {
    const { dpr, w, h } = metrics();
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (state.points.length < 2) return;

    const { x, y } = scales();
    const color = state.color;

    // Gradient fill under the line
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color + '2e');
    grad.addColorStop(1, color + '00');

    ctx.beginPath();
    ctx.moveTo(x(0), y(state.points[0].c));
    for (let i = 1; i < state.points.length; i++) ctx.lineTo(x(i), y(state.points[i].c));
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.moveTo(x(0), y(state.points[0].c));
    for (let i = 1; i < state.points.length; i++) ctx.lineTo(x(i), y(state.points[i].c));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    if (state.hoverIdx >= 0 && state.hoverIdx < state.points.length) {
      const hx = x(state.hoverIdx);
      const hy = y(state.points[state.hoverIdx].c);

      // Crosshair
      ctx.beginPath();
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Hover dot
      ctx.beginPath();
      ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hx, hy, 7, 0, Math.PI * 2);
      ctx.fillStyle = color + '33';
      ctx.fill();
    } else {
      // Idle: last-price dot
      ctx.beginPath();
      ctx.arc(x(state.points.length - 1), y(state.points[state.points.length - 1].c), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  function onMove(e) {
    if (state.points.length < 2) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const idx = Math.round((px / rect.width) * (state.points.length - 1));
    state.hoverIdx = Math.max(0, Math.min(state.points.length - 1, idx));
    draw();

    const p = state.points[state.hoverIdx];
    tooltip.hidden = false;
    tooltip.innerHTML = `<span class="chart-tooltip-price">$${fmtPrice(p.c)}</span><span class="chart-tooltip-time">${fmtTime(p.t)}</span>`;

    // Position tooltip near the crosshair, clamped inside the parent
    const parentRect = parent.getBoundingClientRect();
    const canvasLeft = rect.left - parentRect.left;
    const tw = tooltip.offsetWidth || 90;
    let left = canvasLeft + px - tw / 2;
    left = Math.max(4, Math.min(parentRect.width - tw - 4, left));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${rect.top - parentRect.top - 6}px`;
  }

  function onLeave() {
    state.hoverIdx = -1;
    tooltip.hidden = true;
    draw();
  }

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);

  _charts.set(canvas, state);
  return state;
}

function fmtPrice(v) {
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(4);
  return v.toPrecision(3);
}

function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}



// ---------------------------------------------------------------------------
// Live Markets grid
// ---------------------------------------------------------------------------
export function initMarketCharts() {
  const grid = document.getElementById('market-charts');
  if (!grid) return;

  renderGrid(grid, null); // offline skeleton until real data lands
  refreshGrid(grid);
  setInterval(() => refreshGrid(grid), 120_000);
}

async function fetchStockChart(symbol, range = '1d') {
  try {
    const res = await fetch(`/api/v1/chart/stock/${symbol}?range=${range}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.candles || data.candles.length < 2) return null;
    return data;
  } catch {
    return null;
  }
}

async function refreshGrid(grid) {
  const results = await Promise.all(MARKET_GRID_SYMBOLS.map(s => fetchStockChart(s)));
  const live = results.some(Boolean);
  renderGrid(grid, live ? results : null);
}

function renderGrid(grid, results) {
  grid.innerHTML = MARKET_GRID_SYMBOLS.map((sym, i) => {
    const data = results?.[i];
    const offline = !data;
    const change = data?.change ?? 0;
    const up = change >= 0;
    const dirClass = offline ? '' : (up ? 'is-up' : 'is-down');
    const changeStr = offline ? 'OFFLINE' : `${up ? '▲' : '▼'} ${Math.abs(change).toFixed(2)}%`;
    const candles = data?.candles;
    const hi = candles ? Math.max(...candles.map(c => c.h ?? c.c)) : null;
    const lo = candles ? Math.min(...candles.map(c => c.l ?? c.c)) : null;

    return `
      <div class="market-chart-card ${dirClass}">
        <div class="market-chart-head">
          <span class="market-chart-symbol">${sym}<em>PERP · 50x</em></span>
          <span class="market-chart-change" style="${offline ? 'color:var(--text-tertiary);' : ''}">${changeStr}</span>
        </div>
        <div class="market-chart-price">${offline ? '—' : '$' + fmtPrice(data.price)}</div>
        <div class="market-chart-canvas-wrap">
          <canvas data-chart="${sym}"></canvas>
          ${offline ? '<div class="chart-offline-note">waiting for market data</div>' : ''}
        </div>
        <div class="market-chart-range">
          <span>L ${lo != null ? '$' + fmtPrice(lo) : '—'}</span>
          <span>24H</span>
          <span>H ${hi != null ? '$' + fmtPrice(hi) : '—'}</span>
        </div>
      </div>`;
  }).join('');

  MARKET_GRID_SYMBOLS.forEach((sym, i) => {
    const canvas = grid.querySelector(`canvas[data-chart="${sym}"]`);
    if (!canvas) return;
    const data = results?.[i];
    if (!data) return; // offline: empty canvas, no invented curves
    const points = data.candles.map(c => ({ t: c.t, c: c.c }));
    const up = (data.change ?? 0) >= 0;
    mountChart(canvas).setData(points, { color: up ? GREEN : RED });
  });
}

// ---------------------------------------------------------------------------
// Modal chart — pegged stock with range tabs + Pons token market data
// ---------------------------------------------------------------------------
let _modalMarket = 'AAPL';
let _modalRange = '1d';
let _modalTabsWired = false;

export async function loadModalChart(market, tokenAddress) {
  _modalMarket = market;
  wireModalTabs();
  await renderModalChart();
  loadTokenMarketData(tokenAddress);
}

function wireModalTabs() {
  if (_modalTabsWired) return;
  const tabs = document.getElementById('modal-range-tabs');
  if (!tabs) return;
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range]');
    if (!btn) return;
    _modalRange = btn.getAttribute('data-range');
    tabs.querySelectorAll('[data-range]').forEach(b => b.classList.toggle('active', b === btn));
    renderModalChart();
  });
  _modalTabsWired = true;
}

const RANGE_LABEL = { '1d': '24H', '5d': '5D', '1mo': '1M', '6mo': '6M' };

async function renderModalChart() {
  const canvas = document.getElementById('modal-chart-canvas');
  const label = document.getElementById('modal-chart-label');
  if (!canvas) return;

  if (label) label.textContent = `${_modalMarket} — ${RANGE_LABEL[_modalRange]}`;
  const data = await fetchStockChart(_modalMarket, _modalRange);

  if (!data) {
    mountChart(canvas).setData([], {});
    if (label) label.textContent = `${_modalMarket} — ${RANGE_LABEL[_modalRange]} (no data)`;
    return;
  }

  const points = data.candles.map(c => ({ t: c.t, c: c.c }));
  const first = points[0]?.c || 0;
  const last = points[points.length - 1]?.c || 0;
  const rangeChange = first > 0 ? ((last - first) / first) * 100 : 0;
  const up = rangeChange >= 0;

  mountChart(canvas).setData(points, { color: up ? GREEN : RED });

  if (label) {
    const chStr = `${up ? '+' : ''}${rangeChange.toFixed(2)}%`;
    label.innerHTML = `${_modalMarket} — ${RANGE_LABEL[_modalRange]} · $${fmtPrice(data.price)} <span style="color:${up ? GREEN : RED};">${chStr}</span>`;
  }
}

async function loadTokenMarketData(tokenAddress) {
  const priceEl = document.getElementById('modal-token-price');
  const fdvEl = document.getElementById('modal-token-fdv');
  const volEl = document.getElementById('modal-token-vol');
  if (priceEl) priceEl.textContent = '--';
  if (fdvEl) fdvEl.textContent = '--';
  if (volEl) volEl.textContent = '--';

  if (!tokenAddress || !/^0x/.test(tokenAddress)) return;
  try {
    const res = await fetch(`/api/v1/tokens/${tokenAddress}/marketdata`);
    if (!res.ok) return;
    const md = await res.json();
    if (priceEl && md.priceUsd) priceEl.textContent = `$${fmtPrice(md.priceUsd)}`;
    if (fdvEl && md.fdvUsd) fdvEl.textContent = compactUsd(md.fdvUsd);
    if (volEl && md.volume24hUsd) volEl.textContent = compactUsd(md.volume24hUsd);
  } catch {
    // market data just stays --
  }
}

function compactUsd(n) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

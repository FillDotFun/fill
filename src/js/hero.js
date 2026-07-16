/* ═══════════════════════════════════════════════════════════
   FILL PROTOCOL — Hero live watchlist
   Fills the terminal window's watchlist with real quotes from
   the backend ticker proxy. No data → rows stay as dashes.
   Never invents prices.
   ═══════════════════════════════════════════════════════════ */

const WATCH_SYMBOLS = ['AAPL', 'TSLA', 'NVDA', 'HOOD'];

export function initHeroWatchlist() {
  const host = document.getElementById('hero-watchlist');
  if (!host) return;

  const refresh = async () => {
    const prices = await fetchPrices();
    if (!prices) return; // keep skeleton rows
    host.innerHTML = WATCH_SYMBOLS.map(sym => {
      const d = prices[sym];
      if (!d) {
        return `<div class="watch-row skeleton"><span class="sym">${sym}</span><span class="px">—</span><span class="chg">—</span></div>`;
      }
      const up = d.change >= 0;
      const chg = `${up ? '▲' : '▼'} ${Math.abs(d.change).toFixed(2)}%`;
      return `<div class="watch-row">
        <span class="sym">${sym}</span>
        <span class="px">$${fmt(d.price)}</span>
        <span class="chg ${up ? 'up' : 'down'}">${chg}</span>
      </div>`;
    }).join('');
  };

  refresh();
  setInterval(refresh, 60_000);
}

function fmt(p) {
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1) return p.toFixed(2);
  return p.toFixed(4);
}

async function fetchPrices() {
  try {
    const res = await fetch('/api/v1/ticker');
    if (!res.ok) return null;
    const data = await res.json();
    const out = {};
    for (const e of (data.ticker || [])) {
      out[e.symbol] = { price: e.price || 0, change: e.change || 0 };
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

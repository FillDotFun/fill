/* ═══════════════════════════════════════════════════════════
   FILL PROTOCOL — Live Stock Ticker
   Streams real quotes via the backend Yahoo Finance proxy.
   No data, no ticker — never shows made-up prices.
   ═══════════════════════════════════════════════════════════ */

export function initTicker() {
  const tickerBar = document.getElementById('ticker-bar');
  if (!tickerBar) return;

  tickerBar.style.display = 'none'; // hidden until real data arrives

  const refresh = async () => {
    const prices = await fetchPrices();
    if (prices && Object.keys(prices).length > 0) {
      tickerBar.style.display = '';
      renderTicker(tickerBar, prices);
    }
  };

  refresh();
  setInterval(refresh, 60_000);
}

function renderTicker(container, prices) {
  const items = Object.entries(prices).map(([sym, data]) => {
    const priceStr = formatTickerPrice(data.price);
    const changeStr = data.change >= 0
      ? `+${data.change.toFixed(1)}%`
      : `${data.change.toFixed(1)}%`;
    const changeClass = data.change >= 0 ? 'ticker-up' : 'ticker-down';

    return `<span class="ticker-item">
      <span class="ticker-symbol">${sym}</span>
      <span class="ticker-price">$${priceStr}</span>
      <span class="ticker-change ${changeClass}">${changeStr}</span>
    </span>`;
  }).join('');

  // Duplicate content for seamless loop
  container.innerHTML = `
    <div class="ticker-track">
      <div class="ticker-content">${items}</div>
      <div class="ticker-content" aria-hidden="true">${items}</div>
    </div>
  `;
}

function formatTickerPrice(price) {
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(4);
}

async function fetchPrices() {
  try {
    const res = await fetch('/api/v1/ticker');
    if (!res.ok) return null;

    const data = await res.json();
    const result = {};

    for (const entry of (data.ticker || [])) {
      result[entry.symbol] = {
        price: entry.price || 0,
        change: entry.change || 0,
      };
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════
   FILL PROTOCOL — On-chain stocks (tokenized equities)
   Fetches /api/v1/onchain-stocks (Birdeye xStocks) and shows the
   on-chain price next to the NYSE quote with the premium/discount.
   The section stays hidden unless the backend returns live data —
   no key / no data → nothing shown. Never invents a price.
   ═══════════════════════════════════════════════════════════ */

export function initOnchainStocks() {
  const section = document.getElementById('onchain');
  const body = document.getElementById('onchain-body');
  if (!section || !body) return;

  const load = async () => {
    try {
      const res = await fetch('/api/v1/onchain-stocks');
      if (!res.ok) { section.hidden = true; return; }
      const { enabled, stocks } = await res.json();
      if (!enabled || !stocks || stocks.length === 0) { section.hidden = true; return; }

      body.innerHTML = stocks.map(s => {
        const prem = s.premiumPct;
        const premStr = prem == null ? '—' : `${prem >= 0 ? '+' : ''}${prem.toFixed(2)}%`;
        const premColor = prem == null ? 'var(--text-tertiary)' : (prem >= 0 ? 'var(--green)' : 'var(--red)');
        return `<tr>
          <td class="token-name">${s.symbol}<span style="color:var(--text-tertiary);font-weight:400;"> · ${s.xSymbol}</span></td>
          <td style="text-align:right;">${s.equityPriceUsd != null ? '$' + fmt(s.equityPriceUsd) : '—'}</td>
          <td style="text-align:right;color:var(--text);">$${fmt(s.onchainPriceUsd)}</td>
          <td style="text-align:right;color:${premColor};">${premStr}</td>
        </tr>`;
      }).join('');

      section.hidden = false;
      section.querySelectorAll('.reveal').forEach(e => e.classList.add('visible'));
    } catch {
      section.hidden = true;
    }
  };

  load();
  setInterval(load, 60_000);
}

function fmt(n) {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

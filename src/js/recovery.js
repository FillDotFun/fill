/* ═══════════════════════════════════════════════════════════
   FILL PROTOCOL — Recovery pool section
   The make-good ledger for the retired first token: 10% of all
   protocol fees repay everyone who lost on it, automatically,
   until the debt is cleared. Section stays hidden unless the
   backend reports an active (or completed) ledger — never
   renders placeholder promises.
   ═══════════════════════════════════════════════════════════ */

const EXPLORER = 'https://robinhoodchain.blockscout.com';

export function initRecovery() {
  const section = document.getElementById('recovery');
  if (!section) return;

  const refresh = async () => {
    try {
      const res = await fetch('/api/v1/recovery');
      if (!res.ok) return;
      const d = await res.json();
      if (!d || (!d.active && !d.complete)) return; // no ledger -> stay hidden

      section.style.display = '';
      render(d);
    } catch { /* stay hidden */ }
  };

  const render = (d) => {
    const paidPct = d.liabilityEth > 0 ? Math.min(100, (d.paidEth / d.liabilityEth) * 100) : 0;
    const wholeCt = d.victims.filter(v => v.madeWhole).length;

    const el = (id) => document.getElementById(id);
    if (el('rec-liability')) el('rec-liability').textContent = `${d.liabilityEth.toFixed(5)} ETH`;
    if (el('rec-paid')) el('rec-paid').textContent = `${d.paidEth.toFixed(5)} ETH`;
    if (el('rec-accrued')) el('rec-accrued').textContent = `${d.accruedEth.toFixed(5)} ETH`;
    if (el('rec-wallets')) el('rec-wallets').textContent = `${wholeCt} / ${d.victims.length}`;
    if (el('rec-bar')) el('rec-bar').style.width = `${paidPct.toFixed(1)}%`;
    if (el('rec-pct')) el('rec-pct').textContent = `${paidPct.toFixed(1)}%`;

    const badge = el('rec-status');
    if (badge) {
      badge.textContent = d.complete ? '✓ COMPLETE — EVERYONE MADE WHOLE' : 'ACTIVE — 10% OF ALL FEES';
      badge.style.color = d.complete ? 'var(--accent)' : 'var(--yellow, #ffcc00)';
    }

    const tbody = el('rec-victims');
    if (tbody) {
      tbody.innerHTML = d.victims.map(v => `
        <tr>
          <td style="font-family:var(--font-mono);">${v.wallet}</td>
          <td style="font-family:var(--font-mono);">${v.lostEth.toFixed(5)}</td>
          <td style="font-family:var(--font-mono);">${v.paidEth.toFixed(5)}</td>
          <td>${v.madeWhole
            ? '<span style="color:var(--accent);">✓ made whole</span>'
            : '<span style="color:var(--text-tertiary);">repaying…</span>'}</td>
        </tr>`).join('');
    }

    const pl = el('rec-payouts');
    if (pl) {
      pl.innerHTML = d.payouts.length
        ? d.payouts.map(p => `
            <div style="display:flex;gap:10px;align-items:center;font-family:var(--font-mono);font-size:0.72rem;padding:6px 0;border-bottom:1px solid var(--border);">
              <span style="color:var(--accent);">→</span>
              <span>${p.to}</span>
              <span>${p.amountEth.toFixed(5)} ETH</span>
              <a href="${EXPLORER}/tx/${p.hash}" target="_blank" rel="noopener" style="color:var(--cyan,#7dd);text-decoration:none;">tx ↗</a>
              <span style="color:var(--text-tertiary);margin-left:auto;">${timeAgo(p.at)}</span>
            </div>`).join('')
        : '<div style="font-family:var(--font-mono);font-size:0.72rem;color:var(--text-tertiary);">No payouts yet — the pool is accruing from fees.</div>';
    }
  };

  refresh();
  setInterval(refresh, 60_000);
}

function timeAgo(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

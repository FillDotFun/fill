/* ═══════════════════════════════════════════════════════════
   FILL — Perp venue banner
   Fetches /api/v1/venues and shows which venue the engine is
   trading on, plus an honest note when a venue is paused
   (e.g. Ostium's 2026 exploit halt). Renders into #venue-banner.
   No data → stays hidden. Never invents a state.
   ═══════════════════════════════════════════════════════════ */

export function initVenueBanner() {
  const host = document.getElementById('venue-banner');
  if (!host) return;

  const load = async () => {
    try {
      const res = await fetch('/api/v1/venues');
      if (!res.ok) { host.hidden = true; return; }
      const { venues } = await res.json();
      if (!venues || !venues.length) { host.hidden = true; return; }

      const active = venues.find(v => v.active);
      const paused = venues.filter(v => v.paused);
      if (!active) { host.hidden = true; return; }

      const pausedNote = paused.length
        ? ` · <span style="color:var(--yellow);">${paused.map(p => p.name).join(', ')} paused — auto-resumes when the venue is back</span>`
        : '';

      host.innerHTML = `
        <span class="vb-dot"></span>
        <span>Trading on <strong>${active.name}</strong> <span class="vb-dim">(${active.dex})</span>${pausedNote}</span>`;
      host.hidden = false;
    } catch {
      host.hidden = true;
    }
  };

  load();
  setInterval(load, 60_000);
}

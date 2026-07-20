/* ═══════════════════════════════════════════════════════════
   FILL — Home page entry
   ═══════════════════════════════════════════════════════════ */

import { initParticles } from './js/particles.js';
import { initTypewriter } from './js/typewriter.js';
import { initScroll } from './js/scroll.js';
import { initStats } from './js/stats.js';
import { initToast } from './js/toast.js';
import { initTicker } from './js/ticker.js';
import { initMarketCharts } from './js/charts.js';
import { renderLaunchpadStrip } from './js/launcher.js';
import { initHeroWatchlist } from './js/hero.js';
import { initOnchainStocks } from './js/onchain.js';
import { initRecovery } from './js/recovery.js';

// Token deep links moved to the dashboard page — forward old links
if (/^#token\/0x[0-9a-fA-F]{40}$/.test(location.hash)) {
  location.replace('/dashboard.html' + location.hash);
}

document.addEventListener('DOMContentLoaded', () => {
  initTicker();
  initParticles();
  initTypewriter();
  initHeroWatchlist();
  initScroll();
  initStats();
  initToast();
  initMarketCharts();
  initOnchainStocks();
  initRecovery();
  renderLaunchpadStrip();
});

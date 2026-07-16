/* ═══════════════════════════════════════════════════════════
   FILL — Dashboard page entry (the live app)
   ═══════════════════════════════════════════════════════════ */

import { initScroll } from './js/scroll.js';
import { initToast } from './js/toast.js';
import { initTicker } from './js/ticker.js';
import { initStats } from './js/stats.js';
import { initDashboard, initModal, initActivityFeed } from './js/dashboard.js';
import { initTradeHistory } from './js/trades.js';

document.addEventListener('DOMContentLoaded', () => {
  initTicker();
  initScroll();
  initToast();
  initStats();
  initDashboard();
  initModal();
  initActivityFeed();
  initTradeHistory();
});

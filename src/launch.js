/* ═══════════════════════════════════════════════════════════
   FILL — Launch page entry (the wizard)
   ═══════════════════════════════════════════════════════════ */

import { initScroll } from './js/scroll.js';
import { initToast } from './js/toast.js';
import { initTicker } from './js/ticker.js';
import { initLauncher } from './js/launcher.js';

document.addEventListener('DOMContentLoaded', () => {
  initTicker();
  initScroll();
  initToast();
  initLauncher();
});

#!/usr/bin/env node
/*
 * Build (or rebuild) the recovery ledger for the retired first $FILL token.
 *
 * Computes every wallet's net ETH loss on the old token from chain data:
 *   loss = ETH sent to the bonding curve (buys) − ETH received back (sells)
 * and writes the ledger to Firestore. The fee-claimer then routes 10% of
 * all protocol fees into the pool and pays victims automatically until
 * everyone is made whole.
 *
 * Idempotent: re-running refreshes losses but NEVER lowers a wallet's
 * already-paid amount. Run it one final time right before the relaunch
 * post so late buyers are included.
 *
 *   node scripts/build-recovery-ledger.js          # preview only
 *   node scripts/build-recovery-ledger.js --write  # write to Firestore
 */
import config from '../config.js';
import * as db from '../db/firebase.js';

const OLD_TOKEN = '0xfcaee2abed4a4e5cab9c12089d14e8963f7f2042';
const CURVE = '0xdAF8F478C1cFC6241303b108A1D82B4246E13b18'.toLowerCase();
const DUST_ETH = 0.00005; // ignore losses below this
const API = `${config.EXPLORER_URL}/api/v2`;

async function pageAll(path, pick) {
  const out = [];
  let url = `${API}${path}`;
  for (let page = 0; page < 40 && url; page++) {
    const res = await fetch(url);
    if (!res.ok) break;
    const d = await res.json();
    for (const it of d.items || []) out.push(pick(it));
    const np = d.next_page_params;
    url = np ? `${API}${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams(np)}` : null;
  }
  return out;
}

const flows = new Map(); // wallet -> { in: ethSpent, out: ethReceived }
const flow = (w) => {
  const k = w.toLowerCase();
  if (!flows.has(k)) flows.set(k, { in: 0, out: 0 });
  return flows.get(k);
};

// Trades route through a router, so ETH flows are only visible per-trade:
// walk the token's transfers (curve->wallet = buy, wallet->curve = sell),
// then pull each parent transaction for the real ETH amounts.
const transfers = await pageAll(`/tokens/${OLD_TOKEN}/transfers`, (t) => ({
  from: (t.from?.hash || '').toLowerCase(),
  to: (t.to?.hash || '').toLowerCase(),
  hash: t.transaction_hash || t.tx_hash || '',
}));
const buyTx = new Map();   // hash -> buyer (token receiver)
const sellTx = new Map();  // hash -> seller (token sender)
for (const t of transfers) {
  if (!t.hash) continue;
  if (t.from === CURVE) buyTx.set(t.hash, t.to);
  if (t.to === CURVE) sellTx.set(t.hash, t.from);
}
console.log(`trade txs: ${buyTx.size} buys, ${sellTx.size} sells`);

async function mapLimit(items, limit, fn) {
  const arr = [...items]; let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < arr.length) { const idx = i++; await fn(arr[idx]).catch(() => {}); }
  }));
}
const get = async (path) => {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try { return await (await fetch(`${API}${path}`, { signal: ctl.signal })).json(); }
  finally { clearTimeout(t); }
};

await mapLimit(buyTx, 8, async ([hash, buyer]) => {
  const tx = await get(`/transactions/${hash}`);
  if (tx?.status !== 'ok') return;
  const value = parseFloat(tx.value || 0) / 1e18;
  const sender = (tx.from?.hash || buyer).toLowerCase();
  if (value > 0) flow(sender).in += value;
});
await mapLimit(sellTx, 8, async ([hash, seller]) => {
  const itx = await get(`/transactions/${hash}/internal-transactions`);
  // ETH the seller actually received back in this tx
  for (const it of itx?.items || []) {
    const to = (it.to?.hash || '').toLowerCase();
    const v = parseFloat(it.value || 0) / 1e18;
    if (to === seller && v > 0) flow(seller).out += v;
  }
});

// Victims = net losers, excluding protocol machinery
const exclude = new Set([CURVE, config.PROTOCOL_ADDRESS.toLowerCase(), OLD_TOKEN]);
const victims = {};
let liabilityEth = 0;
for (const [wallet, f] of flows) {
  if (exclude.has(wallet)) continue;
  const lost = Math.round((f.in - f.out) * 1e8) / 1e8;
  if (lost < DUST_ETH) continue;
  victims[wallet] = { lostEth: lost, paidEth: 0 };
  liabilityEth += lost;
}
liabilityEth = Math.round(liabilityEth * 1e8) / 1e8;

console.log(`victims: ${Object.keys(victims).length} | total liability: ${liabilityEth} ETH`);
for (const [w, v] of Object.entries(victims).sort((a, b) => b[1].lostEth - a[1].lostEth)) {
  console.log(`  ${w}  lost ${v.lostEth} ETH`);
}

if (process.argv.includes('--write')) {
  const existing = await db.getConfig('recovery-ledger').catch(() => null);
  // never lose payment history on rebuild
  if (existing?.victims) {
    for (const [w, v] of Object.entries(existing.victims)) {
      if (victims[w]) victims[w].paidEth = v.paidEth || 0;
      else if ((v.paidEth || 0) > 0) victims[w] = v; // paid wallet dropped from recompute — keep it
    }
  }
  await db.setConfig('recovery-ledger', {
    token: OLD_TOKEN,
    curve: CURVE,
    victims,
    liabilityEth,
    accruedEth: existing?.accruedEth || 0,
    paidEth: existing?.paidEth || 0,
    complete: false,
    snapshotAt: Date.now(),
    createdAt: existing?.createdAt || Date.now(),
  });
  console.log('ledger written to Firestore ✓');
} else {
  console.log('(preview only — pass --write to store)');
}
process.exit(0);

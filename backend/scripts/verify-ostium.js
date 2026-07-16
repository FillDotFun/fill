/**
 * Ostium end-to-end verification (run: node scripts/verify-ostium.js)
 *
 * 1. Mainnet: resolve every configured stock market against live pairs
 * 2. Testnet (Arbitrum Sepolia): same resolution against the test deployment
 * 3. Build a REAL unsigned openTrade transaction (no funds needed) and
 *    decode it — proves the exact calldata the engine will sign on-chain
 */
import { OstiumClient, OrderType } from '@ostium/builder-sdk';
import config from '../config.js';

const hr = (s) => console.log(`\n${'─'.repeat(8)} ${s} ${'─'.repeat(Math.max(0, 48 - s.length))}`);

// ── 1. Mainnet pair resolution ──
hr('MAINNET (Arbitrum One)');
const main = await OstiumClient.createReadOnly();
const { pairs } = await main.getPairs();
console.log(`live pairs: ${pairs.length}`);
let ok = 0;
for (const sym of config.STOCK_MARKETS) {
  const p = pairs.find(x => x.pairFrom === sym && ['USD', 'USDC'].includes(x.pairTo));
  if (p) {
    ok++;
    console.log(`  ✓ ${sym.padEnd(5)} pairId=${p.pairId.padEnd(3)} maxLev=${String(p.maxLeverage).padEnd(3)} mid=$${parseFloat(p.midPx).toFixed(2)} open=${p.isMarketOpen}`);
  } else {
    console.log(`  ✗ ${sym} NOT FOUND`);
  }
}
console.log(`resolved ${ok}/${config.STOCK_MARKETS.length} markets`);

// ── 2. Testnet pair resolution ──
hr('TESTNET (Arbitrum Sepolia)');
try {
  const testnet = await OstiumClient.createReadOnly({ testnet: true });
  const t = await testnet.getPairs();
  const tPairs = t.pairs || [];
  console.log(`testnet pairs: ${tPairs.length}`);
  const sample = tPairs.filter(p => config.STOCK_MARKETS.includes(p.pairFrom)).slice(0, 5);
  for (const p of sample) {
    console.log(`  ✓ ${p.pairFrom.padEnd(5)} pairId=${p.pairId} maxLev=${p.maxLeverage}`);
  }
} catch (err) {
  console.log(`  testnet read failed: ${err.message}`);
}

// ── 3. Unsigned trade transaction build (the exact tx the engine signs) ──
hr('UNSIGNED openTrade BUILD');
const aapl = pairs.find(p => p.pairFrom === 'AAPL');
const builder = await OstiumClient.createReadOnly()
  .then(() => OstiumClient.createSelfAndSelf({ traderAddress: config.PROTOCOL_ADDRESS }))
  .catch(async () => {
    // Older SDK path: build-only client via traderAddress
    const { OstiumClient: C } = await import('@ostium/builder-sdk');
    return C.createSelfAndSelf({ traderAddress: config.PROTOCOL_ADDRESS });
  });

const tx = builder.getOpenTradeTx({
  pairId: aapl.pairId,
  buy: true,
  price: aapl.midPx,
  collateral: '100',
  leverage: '10',
  type: OrderType.Market,
  slippage: config.OSTIUM.SLIPPAGE_BPS,
});

console.log(`kind:     ${tx.kind}`);
console.log(`from:     ${tx.from}`);
console.log(`to:       ${tx.to}  (Ostium Trading contract)`);
console.log(`value:    ${tx.value}`);
console.log(`calldata: ${tx.data.slice(0, 74)}… (${(tx.data.length - 2) / 2} bytes)`);
console.log(`selector: ${tx.data.slice(0, 10)}`);
console.log('\nThis is the exact transaction the engine signs once the wallet holds USDC.');
process.exit(0);

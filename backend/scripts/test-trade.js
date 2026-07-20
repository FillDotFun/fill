#!/usr/bin/env node
/*
 * Manual test trade on the ACTIVE venue (Hyperliquid).
 *
 * YOU run this. It signs with the protocol wallet in backend/.env and places
 * ONE real, minimal order — nothing here runs on a schedule or loops.
 *
 *   node scripts/test-trade.js status              # collateral + open positions (read-only)
 *   node scripts/test-trade.js open COIN long       # open a ~$15-notional position
 *   node scripts/test-trade.js open AAPL short      # (any listed ticker / side)
 *   node scripts/test-trade.js close COIN           # close it, print realized PnL
 *
 * Defaults are intentionally tiny: ~$15 order value (safely over HL's $10
 * minimum) on ~$3 collateral → ~5x, clamped to the market's real cap.
 */
import config from '../config.js';
import * as hl from '../services/hyperliquid.js';

const NOTIONAL_USD = 15;   // order value — safely above Hyperliquid's $10 minimum
const COLLATERAL_USD = 3;  // margin posted → ~5x (auto-clamped to the market cap)

const [, , cmd = 'status', marketArg, sideArg] = process.argv;
const market = (marketArg || 'COIN').toUpperCase();
const side = (sideArg || 'long').toLowerCase();

async function showStatus() {
  const [free, positions] = await Promise.all([hl.getFreeCollateral(), hl.getAllPositions()]);
  console.log(`\nHyperliquid account ${config.PROTOCOL_ADDRESS}`);
  console.log(`  free collateral: $${free.toFixed(2)}`);
  if (!positions.length) {
    console.log('  open positions: none');
  } else {
    for (const p of positions) {
      console.log(
        `  • ${p.market} ${p.side} size=$${p.sizeUsd.toFixed(2)} @ $${p.entryPrice.toFixed(2)} ` +
        `lev=${p.leverage}x pnl=$${p.unrealisedPnl.toFixed(2)} liq=$${p.liquidationPrice.toFixed(2)}`,
      );
    }
  }
  return { free, positions };
}

async function main() {
  if (cmd === 'status') {
    await showStatus();
    return;
  }

  if (!config.protocolWallet) {
    console.error('❌ No protocol wallet loaded — is PROTOCOL_PRIVATE_KEY set in backend/.env?');
    process.exit(1);
  }

  if (cmd === 'open') {
    const pair = await hl.findPair(market);
    if (!pair) { console.error(`❌ ${market} is not tradeable on Hyperliquid right now`); process.exit(1); }
    const { free } = await showStatus();
    if (free < COLLATERAL_USD) {
      console.error(`❌ Only $${free.toFixed(2)} free collateral — need at least $${COLLATERAL_USD}`);
      process.exit(1);
    }
    console.log(
      `\n⏳ Opening ${side.toUpperCase()} ${market}: ~$${NOTIONAL_USD} notional on ` +
      `$${COLLATERAL_USD} collateral, mark $${pair.markPx.toFixed(2)} …`,
    );
    const res = await hl.openPosition(market, NOTIONAL_USD, COLLATERAL_USD, side);
    console.log('✅ order result:', JSON.stringify(res));
    await new Promise((r) => setTimeout(r, 2500));
    await showStatus();
    return;
  }

  if (cmd === 'close') {
    console.log(`\n⏳ Closing ${market} …`);
    const res = await hl.closePosition(market);
    console.log('✅ close result:', JSON.stringify(res));
    await new Promise((r) => setTimeout(r, 2500));
    const fills = await hl.getFills(3);
    if (fills.length) {
      console.log('\nrecent fills:');
      for (const f of fills) {
        console.log(`  ${f.market} ${f.side} ${f.size} @ $${f.price} pnl=$${f.pnl.toFixed(2)} fee=$${f.fee.toFixed(4)}`);
      }
    }
    await showStatus();
    return;
  }

  console.error(`Unknown command "${cmd}". Use: status | open <MKT> <long|short> | close <MKT>`);
  process.exit(1);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });

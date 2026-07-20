import config from '../config.js';
import logger from '../utils/logger.js';
import { getProvider } from './chain.js';
import { getLedger } from './recovery.js';
import * as db from '../db/firebase.js';
import { isAddress } from 'ethers';

// ---------------------------------------------------------------------------
// Capital bridge — moves idle fee ETH from Robinhood Chain to Arbitrum USDC
// via Relay (relay.link), completing the capital pipeline:
//   fees (RHC ETH) → [THIS] → Arbitrum USDC → Bridge2 → HL main → xyz margin
// Runs once per position-manager cycle. Hard reserves stay behind on RHC:
// gas, the recovery pool's outstanding ETH obligations (payouts are RHC
// ETH), and a buyback float. Kill switch: AUTO_BRIDGE=off.
// ---------------------------------------------------------------------------

const RELAY_API = 'https://api.relay.link';
const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const GAS_RESERVE_ETH = 0.02;
const BUYBACK_FLOAT_ETH = parseFloat(process.env.BRIDGE_RESERVE_ETH) || 0.10;
const BRIDGE_MIN_ETH = 0.1;   // don't bother below this
const BRIDGE_MAX_ETH = parseFloat(process.env.BRIDGE_MAX_ETH) || 0.5; // per cycle
const MAX_IMPACT_PCT = 3;     // refuse quotes worse than this

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Pure sizing rule (unit-tested): bridge what's above the reserves,
 * clamped to [min, max]. Reserves = gas + recovery outstanding + buyback
 * float. Returns 0 when there's nothing safe to move.
 */
export function computeBridgeable(rhcEth, recoveryOutstandingEth, {
  gasReserve = GAS_RESERVE_ETH, buybackFloat = BUYBACK_FLOAT_ETH,
  min = BRIDGE_MIN_ETH, max = BRIDGE_MAX_ETH,
} = {}) {
  const reserves = gasReserve + Math.max(0, recoveryOutstandingEth) + buybackFloat;
  const spendable = round6(rhcEth - reserves);
  if (spendable < min) return 0;
  return Math.min(spendable, max);
}

// Unspent buyback allocations (EVM-era only — legacy Solana docs excluded).
// This ETH is owed to burns and must stay on Robinhood Chain until spent.
async function getBuybackBacklogEth() {
  try {
    const [splits, buybacks] = await Promise.all([
      db.queryDocs('splits', [], null, 1000),
      db.queryDocs('buybacks', [], null, 1000),
    ]);
    const isEvm = (a) => typeof a === 'string' && a.startsWith('0x') && isAddress(a);
    const alloc = splits.filter((x) => isEvm(x.tokenAddress)).reduce((s, x) => s + (x.buybackAmount || 0), 0);
    const spent = buybacks.filter((x) => isEvm(x.tokenAddress)).reduce((s, x) => s + (x.amountEth || 0), 0);
    return Math.max(0, alloc - spent);
  } catch {
    // If we can't compute the backlog, err on the side of not bridging
    return Infinity;
  }
}

async function relayQuote(amountEth) {
  const res = await fetch(`${RELAY_API}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: config.PROTOCOL_ADDRESS,
      recipient: config.PROTOCOL_ADDRESS,
      originChainId: config.CHAIN_ID,
      destinationChainId: 42161,
      originCurrency: '0x0000000000000000000000000000000000000000',
      destinationCurrency: ARB_USDC,
      amount: BigInt(Math.round(amountEth * 1e18)).toString(),
      tradeType: 'EXACT_INPUT',
    }),
  });
  if (!res.ok) throw new Error(`Relay quote ${res.status}`);
  return res.json();
}

/**
 * Bridge idle RHC fee ETH to Arbitrum USDC. Called once per cycle; the
 * existing ensureCollateral pipeline carries the USDC onward to the venue.
 */
export async function bridgeIdleFees() {
  try {
    if ((process.env.AUTO_BRIDGE || 'on') === 'off') return null;
    if (!config.protocolWallet) return null;

    const provider = getProvider();
    const { formatEther } = await import('ethers');
    const rhcEth = parseFloat(formatEther(await provider.getBalance(config.PROTOCOL_ADDRESS)));

    // The recovery pool pays victims in RHC ETH — its outstanding balance
    // must never leave the chain.
    const ledger = await getLedger();
    const recoveryOutstanding = ledger && !ledger.complete
      ? Math.max(0, (ledger.accruedEth || 0) - (ledger.paidEth || 0))
      : 0;

    // Burns come first: ETH owed to unspent buyback allocations never
    // bridges away — the flat float only covers rounding/gas drift.
    const buybackBacklog = await getBuybackBacklogEth();
    const amount = computeBridgeable(rhcEth, recoveryOutstanding, {
      buybackFloat: Math.min(buybackBacklog, 2) + 0.02,
    });
    if (amount <= 0) return null;

    const quote = await relayQuote(amount);
    const step = quote?.steps?.[0];
    const tx = step?.items?.[0]?.data;
    const det = quote?.details || {};
    const outUsdc = parseFloat(det.currencyOut?.amount || 0) / 1e6;
    const impact = Math.abs(parseFloat(det.totalImpact?.percent || 0));

    // Sanity rails — refuse anything that doesn't look exactly right
    if (!tx?.to || tx.chainId !== config.CHAIN_ID) throw new Error('quote tx not on origin chain');
    if (BigInt(tx.value || 0) !== BigInt(Math.round(amount * 1e18))) throw new Error('quote value mismatch');
    if ((quote?.details?.recipient || config.PROTOCOL_ADDRESS).toLowerCase() !== config.PROTOCOL_ADDRESS.toLowerCase()) {
      throw new Error('quote recipient mismatch');
    }
    if (!(outUsdc > 0) || impact > MAX_IMPACT_PCT) throw new Error(`quote impact too high (${impact}%)`);

    logger.info('Bridging idle fee ETH to Arbitrum USDC', {
      amountEth: amount.toFixed(4), expectUsdc: outUsdc.toFixed(2),
      impactPct: impact, rhcEth: rhcEth.toFixed(4),
      reservedForRecovery: recoveryOutstanding.toFixed(4),
    });

    const signer = config.protocolWallet.connect(provider);
    const sent = await signer.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
    const receipt = await sent.wait();
    logger.info('Bridge deposit confirmed on RHC — USDC arriving on Arbitrum', {
      hash: receipt.hash, amountEth: amount.toFixed(4),
    });
    return { amountEth: amount, expectUsdc: outUsdc, hash: receipt.hash };
  } catch (err) {
    logger.error('bridgeIdleFees failed', { error: err.message });
    return null;
  }
}

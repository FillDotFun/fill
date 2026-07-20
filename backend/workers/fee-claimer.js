import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import { getAllTokens } from '../db/firebase.js';
import * as pons from '../services/pons.js';
import * as notifier from '../services/notifier.js';
import { unwrapAllWeth } from '../services/chain.js';
import { sleep } from '../utils/helpers.js';
import * as recovery from '../services/recovery.js';

// ---------------------------------------------------------------------------
// Fee claiming for Pons launchpad tokens (Robinhood Chain).
//
// Pons tokens route creator fees to their designated creator wallet — for
// Fill tokens that wallet is the protocol wallet. Fees accrue in two
// places:
//   1. Locked Uniswap V3 LP in the Pons locker — post-graduation trading
//      fees (the big money)
//   2. Pons factory — pre-graduation bonding curve fees (small)
//
// pons.claimFees() tries both and reports the ETH actually received.
// ---------------------------------------------------------------------------

// Minimum claim threshold (ETH) — below this, gas isn't worth it
const MIN_CLAIM_ETH = 0.0005;

/**
 * Run a fee-claiming cycle for a single token.
 */
export async function claimFeesForToken(tokenAddress, launchpadId = null) {
  try {
    if (!config.protocolWallet) {
      logger.debug('No protocol wallet loaded, skipping claims');
      return null;
    }

    // Check claimable balance first (view call, free)
    const claimable = await pons.getUnclaimedBalance(tokenAddress, launchpadId);
    if (claimable > 0 && claimable < MIN_CLAIM_ETH) {
      logger.debug('Fees below threshold', { token: tokenAddress, claimable: claimable.toFixed(6) });
      return null;
    }

    // Claim (the service static-calls first, so nothing is wasted if empty)
    const result = await pons.claimFees(tokenAddress, launchpadId);
    if (!result) return null;

    const { txHash, feesClaimed } = result;

    if (feesClaimed <= 0) {
      logger.info('Claim tx sent but 0 fees received', { token: tokenAddress, txHash });
      return null;
    }

    // Recovery pool first: while the make-good for the retired first token
    // is active, 10% of every claim goes to repaying its victims. The
    // normal 70/30 split then applies to the remainder. Once the debt is
    // cleared the cut returns 0 forever.
    const recoveryCut = await recovery.takeRecoveryCut(feesClaimed);
    const splittable = feesClaimed - recoveryCut;

    // Compute split (70% perps, 30% buyback)
    const split = {
      positionAmount: splittable * config.FEE_SPLIT.positionFund,
      buybackAmount: splittable * config.FEE_SPLIT.buyback,
      recoveryAmount: recoveryCut,
    };

    // Persist run
    const runId = await db.addRun({
      tokenAddress,
      feesClaimed,
      txHash,
    });

    // Persist split
    await db.addSplit({
      runId,
      tokenAddress,
      ...split,
    });

    // Per-token fee ledger on the token doc itself: cumulative fees earned
    // and the trading budget (the 70% share, kept in ETH — converted to USD
    // at entry time so no price dependency here). This is what caps how
    // much capital this token's positions may use.
    try {
      const tokenDoc = await db.getToken(tokenAddress);
      await db.setToken(tokenAddress, {
        ...tokenDoc,
        feesClaimedEth: (tokenDoc?.feesClaimedEth || 0) + feesClaimed,
        feeBudgetEth: (tokenDoc?.feeBudgetEth || 0) + split.positionAmount,
      });
    } catch (ledgerErr) {
      logger.warn('Per-token fee ledger update failed', { token: tokenAddress, error: ledgerErr.message });
    }

    logger.info('Fees claimed and recorded', {
      token: tokenAddress,
      feesClaimed: feesClaimed.toFixed(6),
      positionAmount: split.positionAmount.toFixed(6),
      buybackAmount: split.buybackAmount.toFixed(6),
      runId, txHash,
    });

    notifier.notifyFeesClaimed({ token: tokenAddress, feesClaimed, txHash });

    return { runId, feesClaimed, split, txHash };
  } catch (err) {
    logger.error('Fee claim failed', { token: tokenAddress, error: err.message, stack: err.stack });
    return null;
  }
}

/**
 * Run fee claiming for ALL active tokens.
 */
export async function claimAllFees() {
  // Sweep any stray WETH first (Pons pays fees in WETH; claims unwrap
  // inline, but direct transfers or a previously failed unwrap land here)
  if (config.protocolWallet) {
    try {
      const swept = await unwrapAllWeth();
      if (swept > 0) logger.info('Cycle sweep unwrapped stray WETH', { amount: swept.toFixed(6) });
    } catch (err) {
      logger.warn('Cycle WETH sweep failed', { error: err.message });
    }
  }

  const tokens = await getAllTokens();
  const active = tokens.filter((t) => t.status === 'active');

  if (active.length === 0) {
    logger.info('No active tokens to claim fees for');
    return [];
  }

  const results = [];
  for (let i = 0; i < active.length; i++) {
    const token = active[i];
    const result = await claimFeesForToken(token.id || token.address, token.launchpad || null);
    if (result) results.push(result);

    // Rate limit: 1s delay between tokens to avoid RPC throttling
    if (i < active.length - 1) {
      await sleep(1000);
    }
  }

  logger.info(`Fee claim cycle complete: ${results.length}/${active.length} tokens claimed`);

  // Recovery pool payouts: pay victims of the retired first token from the
  // accrued 10% carve-out. No-ops instantly once the ledger is complete.
  try {
    const paid = await recovery.processRecoveryPayouts();
    if (paid?.paidNow) {
      notifier.notify?.(`🩹 Recovery pool paid ${paid.paidNow.toFixed(5)} ETH to old-token holders${paid.complete ? ' — EVERYONE MADE WHOLE ✅' : ''}`);
    }
  } catch (recErr) {
    logger.warn('Recovery payout step failed', { error: recErr.message });
  }

  return results;
}

import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import * as perps from '../services/ostium.js';
import { getAllTokens } from '../db/firebase.js';
import * as notifier from '../services/notifier.js';
import { retry } from '../utils/helpers.js';

/**
 * Risk manager — monitors positions and enforces:
 *
 * 1. Liquidation proximity — auto-reduce if within warning threshold
 * 2. Max drawdown (configurable) — auto-reduce position
 * 3. Circuit breaker (underlying crash) — auto-close + pause token
 * 4. Stale position detection — flag positions with no updates
 */
export async function runRiskCheck() {
  logger.info('Running risk check cycle');

  const tokens = await getAllTokens();
  const active = tokens.filter((t) => t.status === 'active');

  if (active.length === 0) {
    logger.info('No active tokens to risk-check');
    return [];
  }

  // Check overall collateral (USDC on Arbitrum via Ostium)
  let freeCollateral = 0;
  try {
    freeCollateral = await perps.getFreeCollateral();
    logger.info('Free trading collateral (USDC)', { freeCollateral: freeCollateral.toFixed(2) });

    if (freeCollateral < config.RISK.minDeployUsd) {
      logger.warn('LOW USDC BALANCE — top up Arbitrum trading collateral', { freeCollateral });
    }
  } catch (err) {
    logger.warn('Could not fetch free collateral', { error: err.message });
  }

  const alerts = [];
  const checkedMarkets = new Set();

  for (const token of active) {
    try {
      const result = await checkTokenRisk(token, freeCollateral);
      if (token.underlying) checkedMarkets.add(token.underlying.toUpperCase());
      if (result) alerts.push(result);
    } catch (err) {
      logger.error('Risk check failed for token', {
        token: token.address || token.id,
        error: err.message,
      });
    }
  }

  // Sweep position docs the token loop didn't cover (engine extra markets,
  // adopted orphans) — no deployed capital escapes risk checks
  try {
    const allPositions = await db.getAllPositions();
    for (const pos of allPositions) {
      const market = pos.market?.toUpperCase();
      if (!market || (pos.deployedUsd || 0) <= 0) continue;
      if (checkedMarkets.has(market)) continue;
      checkedMarkets.add(market);
      try {
        const result = await checkTokenRisk(
          { id: pos.id, address: pos.tokenAddress || pos.id, underlying: market, side: pos.side, status: 'active' },
          freeCollateral,
        );
        if (result) alerts.push(result);
      } catch (err) {
        logger.error('Risk check failed for orphan position', { position: pos.id, error: err.message });
      }
    }
  } catch (sweepErr) {
    logger.warn('Orphan position sweep failed', { error: sweepErr.message });
  }

  if (alerts.length > 0) {
    logger.warn(`Risk alerts triggered: ${alerts.length}`, { alerts });
    for (const a of alerts) {
      notifier.notifyRiskAlert({ market: a.market, alert: a.alert, action: a.action });
    }
  } else {
    logger.info('Risk check passed — no alerts');
  }

  return alerts;
}

async function checkTokenRisk(token, freeCollateral) {
  const tokenAddress = token.id || token.address;
  const position = await db.getPosition(tokenAddress);

  // Resolve market from token underlying
  const underlying = token.underlying?.toUpperCase();
  const market = underlying && config.STOCK_MARKETS.includes(underlying)
    ? underlying
    : null;

  if (!market || !position || position.deployedUsd <= 0) return null;

  // Get live PnL from Ostium (with retry)
  const pnlInfo = await retry(
    () => perps.getPositionPnl(market),
    { retries: 2, delayMs: 2000, label: `riskCheck-pnl(${market})` }
  );

  if (!pnlInfo.exists) {
    // Position may have been liquidated or closed externally
    if (position.deployedUsd > 0) {
      logger.warn('Position no longer exists on Ostium but DB shows deployed capital', {
        token: tokenAddress,
        market,
        deployedUsd: position.deployedUsd,
      });

      await db.setPosition(tokenAddress, {
        ...position,
        deployedUsd: 0,
        lastAction: 'external-close-detected',
        lastActionAt: Date.now(),
        pnl: 0,
        riskAlert: 'position-missing',
      });

      return {
        token: tokenAddress,
        market,
        alert: 'position-missing',
        action: 'marked-as-closed',
        detail: 'Position no longer exists on Ostium — may have been liquidated',
      };
    }
    return null;
  }

  const deployedUsd = position.deployedUsd || 0;
  if (deployedUsd <= 0) return null;

  // -----------------------------------------------------------------------
  // Check 1: Liquidation proximity
  // If collateral ratio is dangerously low relative to position size
  // -----------------------------------------------------------------------
  if (pnlInfo.collateralUsd > 0 && pnlInfo.size !== 0) {
    const positionNotional = Math.abs(pnlInfo.size);
    const marginRatio = pnlInfo.collateralUsd / positionNotional;

    if (marginRatio < config.RISK.liquidationWarningPct) {
      logger.warn('LIQUIDATION PROXIMITY WARNING', {
        token: tokenAddress,
        market,
        marginRatio: (marginRatio * 100).toFixed(1) + '%',
        collateral: pnlInfo.collateralUsd.toFixed(2),
        positionNotional: positionNotional.toFixed(2),
      });

      // Emergency reduce 50%
      try {
        const result = await retry(
          () => perps.reducePosition(market, 0.5),
          { retries: 3, delayMs: 1000, label: `emergencyReduce(${market})` }
        );

        await db.setPosition(tokenAddress, {
          ...position,
          deployedUsd: deployedUsd * 0.5,
          lastAction: 'liquidation-reduce',
          lastActionAt: Date.now(),
          pnl: pnlInfo.pnl,
          riskAlert: 'liquidation-proximity',
          marginRatio,
        });

        return {
          token: tokenAddress,
          market,
          alert: 'liquidation-proximity',
          marginRatio,
          action: 'reduced-50%',
          txSig: result?.txSig,
        };
      } catch (err) {
        logger.error('FAILED TO REDUCE ON LIQUIDATION WARNING', {
          token: tokenAddress,
          market,
          error: err.message,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Check 2: Max drawdown
  // -----------------------------------------------------------------------
  const unrealizedLoss = Math.min(0, pnlInfo.pnl);
  const drawdownPct = deployedUsd > 0 ? Math.abs(unrealizedLoss) / deployedUsd : 0;

  if (drawdownPct >= config.RISK.maxDrawdownPct) {
    logger.warn('MAX DRAWDOWN TRIGGERED', {
      token: tokenAddress,
      market,
      drawdownPct: (drawdownPct * 100).toFixed(1) + '%',
      pnl: pnlInfo.pnl,
    });

    try {
      const reducePct = config.RISK.drawdownReducePct;
      const result = await retry(
        () => perps.reducePosition(market, reducePct),
        { retries: 2, delayMs: 3000, label: `drawdownReduce(${market})` }
      );

      await db.setPosition(tokenAddress, {
        ...position,
        deployedUsd: deployedUsd * (1 - reducePct),
        lastAction: 'risk-reduce',
        lastActionAt: Date.now(),
        pnl: pnlInfo.pnl,
        riskAlert: 'max-drawdown',
        drawdownPct,
      });

      return {
        token: tokenAddress,
        market,
        alert: 'max-drawdown',
        drawdownPct,
        action: `reduced-${(reducePct * 100).toFixed(0)}%`,
        txSig: result?.txSig,
      };
    } catch (err) {
      logger.error('Failed to reduce position on drawdown', {
        token: tokenAddress,
        market,
        error: err.message,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Check 3: Circuit breaker (extreme adverse move)
  // For longs: triggers on severe price crash
  // For shorts: triggers on severe price surge
  // -----------------------------------------------------------------------
  if (pnlInfo.entry > 0 && pnlInfo.size !== 0) {
    const side = position.side || token.side || 'long';
    const isLong = side === 'long';
    // Fallback price derivation is direction-aware: positive PnL means
    // price ABOVE entry for longs but BELOW entry for shorts
    const pnlPerUnit = (pnlInfo.pnl / Math.abs(pnlInfo.size)) * pnlInfo.entry;
    const currentPrice = pnlInfo.currentPrice
      || (isLong ? pnlInfo.entry + pnlPerUnit : pnlInfo.entry - pnlPerUnit);

    // For longs: adverse move = price drops. For shorts: adverse move = price rises.
    const adverseMove = isLong
      ? (pnlInfo.entry - currentPrice) / pnlInfo.entry   // price crash (positive = bad for longs)
      : (currentPrice - pnlInfo.entry) / pnlInfo.entry;   // price surge (positive = bad for shorts)

    if (adverseMove >= config.RISK.circuitBreakerPct) {
      logger.warn('CIRCUIT BREAKER TRIGGERED', {
        token: tokenAddress,
        market,
        side,
        adverseMove: (adverseMove * 100).toFixed(1) + '%',
        entryPrice: pnlInfo.entry,
        currentPrice,
      });

      try {
        const result = await retry(
          () => perps.closePosition(market),
          { retries: 3, delayMs: 1000, label: `circuitBreaker(${market})` }
        );

        await db.setPosition(tokenAddress, {
          ...position,
          deployedUsd: 0,
          lastAction: 'circuit-breaker-close',
          lastActionAt: Date.now(),
          pnl: pnlInfo.pnl,
          riskAlert: 'circuit-breaker',
        });

        // Mark token as paused
        await db.setToken(tokenAddress, { ...token, status: 'paused' });

        return {
          token: tokenAddress,
          market,
          alert: 'circuit-breaker',
          adverseMove,
          side,
          action: 'closed-position',
          txSig: result?.txSig,
        };
      } catch (err) {
        logger.error('Failed to close position on circuit breaker', {
          token: tokenAddress,
          market,
          error: err.message,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Check 4: Update PnL + health metrics in DB
  // -----------------------------------------------------------------------
  await db.setPosition(tokenAddress, {
    ...position,
    pnl: pnlInfo.pnl,
    entry: pnlInfo.entry,
    size: pnlInfo.size,
    market,
    lastRiskCheck: Date.now(),
  });

  return null;
}

export { checkTokenRisk };

// ---------------------------------------------------------------------------
// Trading strategy modes
//
// Every registered token picks how the engine trades its fee income.
// Existing positions are ALWAYS risk-managed regardless of mode — the mode
// only gates new entries and their sizing.
// ---------------------------------------------------------------------------

export const STRATEGY_MODES = {
  off: {
    id: 'off',
    label: 'Off',
    description: 'No trading — fees accrue to buybacks only',
    trade: false,
  },
  conservative: {
    id: 'conservative',
    label: 'Conservative',
    description: 'Low leverage (3-10x), regular US market hours only, strong signals only, tight stop',
    trade: true,
    minLev: 3,
    maxLev: 10,
    entryBonus: 15,               // added to the adaptive entry threshold
    stopLossCollateralPct: -0.25, // exit at -25% of collateral
    rthOnly: true,                // only enter during regular trading hours
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: 'Medium leverage (5-25x), trades regular + extended US sessions, standard stop',
    trade: true,
    minLev: 5,
    maxLev: 25,
    entryBonus: 5,
    stopLossCollateralPct: -0.40,
    rthOnly: false,
  },
  degen: {
    id: 'degen',
    label: 'Degen',
    description: 'Signal-driven leverage up to 50x, trades every US market session',
    trade: true,
    minLev: 10,
    maxLev: 50,
    entryBonus: 0,
    stopLossCollateralPct: -0.40,
    rthOnly: false,
  },
};

export const DEFAULT_STRATEGY = process.env.TRADING_MODE && STRATEGY_MODES[process.env.TRADING_MODE]
  ? process.env.TRADING_MODE
  : 'degen';

export function resolveStrategy(id) {
  return STRATEGY_MODES[id] || STRATEGY_MODES[DEFAULT_STRATEGY];
}

export function isValidStrategy(id) {
  return Boolean(STRATEGY_MODES[id]);
}

// ---------------------------------------------------------------------------
// Trailing-stop math (pure helpers, direction-aware)
//
// A long's best point is the HIGHEST price seen; a short's best point is
// the LOWEST. "Pullback" is how far price has retraced from that favorable
// extreme — always ≥ 0 when moving against the position.
// ---------------------------------------------------------------------------

/** The most favorable price seen so far for this position. */
export function favorableExtreme(direction, previousExtreme, currentPrice) {
  if (!previousExtreme) return currentPrice;
  return direction === 'short'
    ? Math.min(previousExtreme, currentPrice)
    : Math.max(previousExtreme, currentPrice);
}

/** Fractional retrace from the favorable extreme (≥ 0 means giving back profit). */
export function pullbackFrom(direction, extreme, currentPrice) {
  if (!extreme || extreme <= 0) return 0;
  return direction === 'short'
    ? (currentPrice - extreme) / extreme
    : (extreme - currentPrice) / extreme;
}

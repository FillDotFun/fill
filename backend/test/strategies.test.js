import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGY_MODES, DEFAULT_STRATEGY, resolveStrategy, isValidStrategy } from '../services/strategies.js';

test('strategy modes are well-formed', () => {
  const ids = Object.keys(STRATEGY_MODES);
  for (const required of ['off', 'conservative', 'balanced', 'degen']) {
    assert.ok(ids.includes(required), `${required} mode exists`);
  }

  for (const mode of Object.values(STRATEGY_MODES)) {
    assert.ok(mode.id && mode.label && mode.description, `${mode.id} has metadata`);
    assert.equal(typeof mode.trade, 'boolean');
    if (mode.trade) {
      assert.ok(mode.minLev >= 1, `${mode.id} minLev >= 1`);
      assert.ok(mode.maxLev <= 50, `${mode.id} maxLev <= 50 (Ostium equities cap)`);
      assert.ok(mode.minLev <= mode.maxLev, `${mode.id} lev range coherent`);
      assert.ok(mode.stopLossCollateralPct < 0 && mode.stopLossCollateralPct > -1, `${mode.id} stop loss sane`);
    }
  }
});

test('off mode never trades', () => {
  assert.equal(STRATEGY_MODES.off.trade, false);
});

test('conservative is strictly tighter than degen', () => {
  const c = STRATEGY_MODES.conservative;
  const d = STRATEGY_MODES.degen;
  assert.ok(c.maxLev < d.maxLev);
  assert.ok(c.entryBonus > d.entryBonus);
  assert.ok(c.stopLossCollateralPct > d.stopLossCollateralPct); // closer to zero = tighter
  assert.equal(c.rthOnly, true);
});

test('resolveStrategy falls back to the default', () => {
  assert.equal(resolveStrategy('nonsense').id, DEFAULT_STRATEGY);
  assert.equal(resolveStrategy(null).id, DEFAULT_STRATEGY);
  assert.equal(resolveStrategy('conservative').id, 'conservative');
});

test('isValidStrategy', () => {
  assert.equal(isValidStrategy('degen'), true);
  assert.equal(isValidStrategy('yolo'), false);
});

// ---------------------------------------------------------------------------
// Trailing-stop math — the old max-only tracking meant shorts never trailed
// ---------------------------------------------------------------------------
import { favorableExtreme, pullbackFrom } from '../services/strategies.js';

test('favorableExtreme tracks highs for longs and lows for shorts', () => {
  // long: price ran to 110, now 105 → extreme stays 110
  assert.equal(favorableExtreme('long', 110, 105), 110);
  assert.equal(favorableExtreme('long', 100, 112), 112);
  // short: price fell to 90, now 95 → extreme stays 90 (the low)
  assert.equal(favorableExtreme('short', 90, 95), 90);
  assert.equal(favorableExtreme('short', 100, 88), 88);
  // first observation seeds the extreme for both directions
  assert.equal(favorableExtreme('long', 0, 100), 100);
  assert.equal(favorableExtreme('short', 0, 100), 100);
});

test('pullbackFrom is positive when giving back profit — both directions', () => {
  // long: high 110, now 105 → gave back ~4.5%
  assert.ok(Math.abs(pullbackFrom('long', 110, 105) - 0.04545) < 0.001);
  // short: low 90, now 95 → gave back ~5.6% (this was ALWAYS ≤ 0 before the fix)
  assert.ok(Math.abs(pullbackFrom('short', 90, 95) - 0.05555) < 0.001);
  // moving favourably → pullback ≤ 0, trailing never fires
  assert.ok(pullbackFrom('long', 110, 115) < 0);
  assert.ok(pullbackFrom('short', 90, 85) < 0);
  // guard rails
  assert.equal(pullbackFrom('long', 0, 100), 0);
});

test('a shorts trailing stop can actually trigger now', () => {
  // simulate: short entered at 100, price fell to 90 (profit), bounced to 91
  let extreme = 0;
  for (const px of [100, 97, 93, 90]) extreme = favorableExtreme('short', extreme, px);
  assert.equal(extreme, 90);
  const pullback = pullbackFrom('short', extreme, 91);
  assert.ok(pullback >= 0.005, 'exceeds the 0.5% trailing callback → close fires');
});

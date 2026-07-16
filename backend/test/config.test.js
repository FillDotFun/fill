import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAddress } from 'ethers';
import config from '../config.js';

test('launchpad registry is well-formed', () => {
  const pads = Object.values(config.LAUNCHPADS);
  assert.ok(pads.length >= 4, 'at least 4 launchpads registered');

  for (const lp of pads) {
    assert.ok(lp.id, `${lp.name} has an id`);
    assert.ok(lp.name, `${lp.id} has a name`);
    assert.match(lp.url, /^https:\/\//, `${lp.id} has an https url`);
    assert.ok(['full', 'partial', 'coming-soon'].includes(lp.support), `${lp.id} support level valid`);
    if (lp.support !== 'coming-soon') {
      assert.ok(isAddress(lp.factory), `${lp.id} factory is a valid address`);
    }
  }
});

test('pons has full support with locker', () => {
  const pons = config.LAUNCHPADS.pons;
  assert.equal(pons.support, 'full');
  assert.ok(isAddress(pons.factory));
  assert.ok(isAddress(pons.locker));
});

test('launchpad factories are unique', () => {
  const factories = Object.values(config.LAUNCHPADS)
    .map(lp => lp.factory?.toLowerCase())
    .filter(Boolean);
  assert.equal(new Set(factories).size, factories.length);
});

test('stock market list is sane', () => {
  assert.ok(config.STOCK_MARKETS.length >= 10);
  for (const m of config.STOCK_MARKETS) {
    assert.match(m, /^[A-Z]{1,5}$/, `${m} looks like a ticker`);
  }
  assert.ok(config.STOCK_MARKETS.includes(config.DEFAULT_MARKET), 'default market is tradeable');
  for (const m of config.EXTRA_MARKETS) {
    assert.ok(config.STOCK_MARKETS.includes(m), `extra market ${m} is tradeable`);
  }
});

test('risk parameters are coherent', () => {
  assert.ok(config.RISK.leverage >= 1 && config.RISK.leverage <= config.OSTIUM.MAX_LEVERAGE);
  assert.ok(config.RISK.minDeployUsd > 0);
  assert.ok(config.RISK.maxTradingCapitalUsd >= config.RISK.minDeployUsd);
  assert.ok(config.RISK.maxDrawdownPct > 0 && config.RISK.maxDrawdownPct <= 1);
  assert.ok(config.RISK.circuitBreakerPct > 0 && config.RISK.circuitBreakerPct <= 1);
  assert.ok(config.FEE_SPLIT.positionFund + config.FEE_SPLIT.buyback === 1);
  assert.ok(config.PROFIT_SPLIT.sourceToken + config.PROFIT_SPLIT.fill === 1);
});

test('chain configuration', () => {
  assert.equal(config.CHAIN_ID, 4663);
  assert.match(config.RPC_URL, /^https:\/\//);
  assert.match(config.ARBITRUM_RPC_URL, /^https:\/\//);
  assert.ok(isAddress(config.WETH_ADDRESS));
});

// ---------------------------------------------------------------------------
// Legacy-token guard: old Solana mint docs must never survive getAllTokens
// (they'd otherwise reach the EVM trade/claim path in production)
// ---------------------------------------------------------------------------
import { getAllTokens, setToken, _mockMode } from '../db/firebase.js';

test('getAllTokens filters out non-EVM (legacy Solana) token docs', async (t) => {
  if (!_mockMode) return t.skip('only meaningful in mock mode');
  await setToken('2Ymo8SHM4yhhjvnjvZue6qXfQHUJXtZt2wUCgsMZpump', { symbol: 'OLD', status: 'active' });
  await setToken('0x39dBED3a2bd333467115dE45665cC57F813C4571', { symbol: 'NEW', status: 'active' });
  const tokens = await getAllTokens();
  const ids = tokens.map(t => t.id || t.address);
  assert.ok(ids.includes('0x39dBED3a2bd333467115dE45665cC57F813C4571'), 'EVM token kept');
  assert.ok(!ids.some(id => id.endsWith('pump')), 'Solana mint filtered out');
});

// ---------------------------------------------------------------------------
// Uniswap router — buybacks depend on it; default must be the verified
// SwapRouter02 deployment on Robinhood Chain (checksummed)
// ---------------------------------------------------------------------------
test('UNISWAP_ROUTER defaults to the verified SwapRouter02 and is checksummed', () => {
  assert.ok(isAddress(config.UNISWAP_ROUTER), 'router is a valid address');
  if (!process.env.UNISWAP_ROUTER) {
    assert.equal(
      config.UNISWAP_ROUTER.toLowerCase(),
      '0xcaf681a66d020601342297493863e78c959e5cb2',
      'default router matches the on-chain-verified deployment',
    );
  }
});

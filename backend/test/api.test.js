import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Boots the real server (mock DB, random port) and exercises every endpoint.
const PORT = 3900 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}/api/v1`;
let server;

before(async () => {
  server = spawn('node', ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), FIREBASE_SERVICE_ACCOUNT: '', NODE_ENV: 'test' },
    stdio: 'ignore',
  });

  // Wait for the server to accept connections
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not boot');
});

after(() => {
  server?.kill('SIGTERM');
});

test('GET /health', async () => {
  const r = await fetch(`${BASE}/health`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.status, 'ok');
  assert.equal(d.dbMode, 'mock');
});

test('GET /markets lists stock perps on the active venue', async () => {
  const r = await fetch(`${BASE}/markets`);
  const d = await r.json();
  assert.ok(d.markets.length >= 10);
  assert.ok(['hyperliquid', 'ostium'].includes(d.venue), 'names the active venue');
  // Leverage caps are the ACTIVE venue's real numbers (HL: 20x majors /
  // 10x rest; Ostium: up to 50x) — never a hardcoded 50
  assert.ok(d.markets.every(m => m.provider === d.venue));
  assert.ok(d.markets.every(m => typeof m.available === 'boolean'));
  assert.ok(d.markets.every(m => Number.isFinite(m.maxLeverage) && m.maxLeverage >= 0 && m.maxLeverage <= 50));
  assert.ok(d.markets.some(m => m.available && m.maxLeverage > 0), 'at least one tradeable market');
  assert.ok(Number.isFinite(d.venueMaxLeverage) && d.venueMaxLeverage > 0);
});

test('GET /venues reports active venue + per-venue state', async () => {
  const r = await fetch(`${BASE}/venues`);
  const d = await r.json();
  assert.ok(['hyperliquid', 'ostium'].includes(d.active));
  assert.ok(Array.isArray(d.venues) && d.venues.length >= 2);
  assert.ok(d.venues.some(v => v.active), 'one venue is marked active');
});

test('GET /launchpads lists the registry', async () => {
  const r = await fetch(`${BASE}/launchpads`);
  const d = await r.json();
  const ids = d.launchpads.map(l => l.id);
  for (const id of ['pons', 'launchhood', 'noxa']) {
    assert.ok(ids.includes(id), `${id} present`);
  }
  assert.match(d.protocolWallet, /^0x[0-9a-fA-F]{40}$/);
});

test('GET /stats returns coherent shape', async () => {
  const r = await fetch(`${BASE}/stats`);
  const d = await r.json();
  for (const key of ['totalTokens', 'netPerpPnlUsd', 'walletBalanceEth', 'tradingBalanceUsd', 'totalBuybackEth']) {
    assert.ok(key in d.stats, `stats.${key}`);
  }
});

test('GET /status reports chain + workers', async () => {
  const r = await fetch(`${BASE}/status`);
  const d = await r.json();
  assert.equal(d.chain.chainId, 4663);
  assert.ok(Object.keys(d.engine.workers).length >= 5);
});

test('GET /tokens and /positions start empty in mock mode', async () => {
  const t = await (await fetch(`${BASE}/tokens`)).json();
  const p = await (await fetch(`${BASE}/positions`)).json();
  assert.deepEqual(t.tokens, []);
  assert.deepEqual(p.positions, []);
});

test('POST /tokens/register rejects invalid addresses', async () => {
  const r = await fetch(`${BASE}/tokens/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: 'not-an-address' }),
  });
  assert.equal(r.status, 400);
});

test('GET /strategies lists trading modes', async () => {
  const r = await fetch(`${BASE}/strategies`);
  const d = await r.json();
  const ids = d.strategies.map(s => s.id);
  for (const id of ['off', 'conservative', 'balanced', 'degen']) {
    assert.ok(ids.includes(id), `${id} present`);
  }
  assert.ok(ids.includes(d.default));
});

test('POST /tokens/register rejects unknown strategies', async () => {
  const r = await fetch(`${BASE}/tokens/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: '0x39dBED3a2bd333467115dE45665cC57F813C4571', strategy: 'yolo' }),
  });
  assert.equal(r.status, 400);
  const d = await r.json();
  assert.match(d.reason, /degen/);
});

test('POST /tokens/register rejects unknown launchpads', async () => {
  const r = await fetch(`${BASE}/tokens/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: '0x39dBED3a2bd333467115dE45665cC57F813C4571', launchpad: 'wrongpad' }),
  });
  assert.equal(r.status, 400);
  const d = await r.json();
  assert.match(d.reason, /pons/);
});

test('POST /tokens/register rejects tokens whose fees do not route to the protocol (live on-chain check)', async () => {
  // PONS token itself — real Pons launch, but its creator is not our wallet
  const r = await fetch(`${BASE}/tokens/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: '0x39dBED3a2bd333467115dE45665cC57F813C4571', underlying: 'AAPL' }),
  });
  assert.equal(r.status, 400);
  const d = await r.json();
  assert.equal(d.error, 'On-chain verification failed');
});

test('POST /admin/trigger rejects unauthenticated calls', async () => {
  const r = await fetch(`${BASE}/admin/trigger/fee-claimer`, { method: 'POST' });
  // 403 = fail-closed (no ADMIN_API_KEY configured); 401 = key configured
  // but caller unauthenticated. Both are correct rejections — what must
  // never happen is a 2xx without the key.
  assert.ok([401, 403].includes(r.status), `expected 401/403, got ${r.status}`);
});

test('POST /admin/trigger rejects a WRONG key', async () => {
  const r = await fetch(`${BASE}/admin/trigger/fee-claimer`, {
    method: 'POST',
    headers: { 'x-admin-key': 'definitely-not-the-key' },
  });
  assert.ok([401, 403].includes(r.status), `expected 401/403, got ${r.status}`);
});

test('GET /chart/stock validates symbols', async () => {
  const bad = await fetch(`${BASE}/chart/stock/NOTREAL`);
  assert.equal(bad.status, 400);
});

test('GET /chart/token validates addresses', async () => {
  const bad = await fetch(`${BASE}/chart/token/xyz`);
  assert.equal(bad.status, 400);
});

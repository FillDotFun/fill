import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retry, sleep, shortenKey, ethToWei, weiToEth, nowISO, nowUnix } from '../utils/helpers.js';

test('ethToWei / weiToEth round-trip', () => {
  assert.equal(weiToEth(ethToWei(1)), 1);
  assert.equal(weiToEth(ethToWei(0.0005)), 0.0005);
  assert.equal(weiToEth(1_000_000_000_000_000_000n), 1);
});

test('shortenKey shortens addresses', () => {
  const addr = '0x190A656632525803b4a6be64b5B6bc4b3E9323b7';
  const short = shortenKey(addr);
  assert.ok(short.length < addr.length);
  assert.ok(short.startsWith('0x190A'));
  assert.ok(short.endsWith('23b7'));
});

test('retry succeeds after transient failures', async () => {
  let attempts = 0;
  const result = await retry(async () => {
    attempts++;
    if (attempts < 3) throw new Error('transient');
    return 'ok';
  }, { retries: 3, delayMs: 1, label: 'test' });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('retry throws after exhausting attempts', async () => {
  await assert.rejects(
    retry(async () => { throw new Error('permanent'); }, { retries: 2, delayMs: 1, label: 'test' }),
    /permanent/,
  );
});

test('sleep resolves', async () => {
  const start = Date.now();
  await sleep(15);
  assert.ok(Date.now() - start >= 10);
});

test('timestamps', () => {
  assert.ok(!Number.isNaN(Date.parse(nowISO())));
  assert.ok(Math.abs(nowUnix() - Date.now() / 1000) < 2);
});

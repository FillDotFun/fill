import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retry, sleep, shortenKey, ethToWei, weiToEth, nowISO, nowUnix } from '../utils/helpers.js';

test('ethToWei / weiToEth round-trip', () => {
  assert.equal(weiToEth(ethToWei(1)), 1);
  assert.equal(weiToEth(ethToWei(0.0005)), 0.0005);
  assert.equal(weiToEth(1_000_000_000_000_000_000n), 1);
});

test('shortenKey shortens addresses', () => {
  const addr = '0x2cdE129778a416279d9f6F1E9B5c3abb302D1CD7';
  const short = shortenKey(addr);
  assert.ok(short.length < addr.length);
  assert.ok(short.startsWith('0x2cdE'));
  assert.ok(short.endsWith('1CD7'));
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

// ---------------------------------------------------------------------------
// Launch-calldata verification helper — regression for the false rejection
// of correctly-configured Pons launches (Creator wallet set, but Pons has
// no on-chain getter; the proof lives in the launch tx calldata/events).
// ---------------------------------------------------------------------------
import { hexMentionsAddress } from '../services/pons.js';

test('hexMentionsAddress matches ABI-encoded address words only', () => {
  const addr = '0x2cdE129778a416279d9f6F1E9B5c3abb302D1CD7';
  const padded = '0'.repeat(24) + addr.slice(2).toLowerCase();
  assert.equal(hexMentionsAddress('0x1234' + padded + 'beef', addr), true, 'padded word matches');
  assert.equal(hexMentionsAddress('0x' + addr.slice(2).toLowerCase(), addr), false, 'unpadded raw hex is not a parameter');
  assert.equal(hexMentionsAddress('', addr), false);
  assert.equal(hexMentionsAddress(null, addr), false);
  assert.equal(hexMentionsAddress('0xdead', null), false);
});

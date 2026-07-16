import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  xStockSymbol,
  XSTOCK_ALIAS,
  pickXStockFromSearch,
  parsePriceResponse,
  isEnabled,
} from '../services/birdeye.js';

test('xStockSymbol maps tickers to the on-chain symbol', () => {
  assert.equal(xStockSymbol('AAPL'), 'AAPLX');
  assert.equal(xStockSymbol('TSLA'), 'TSLAX');
  // Alphabet trades as GOOGLx on-chain, not GOOGx
  assert.equal(XSTOCK_ALIAS.GOOG, 'GOOGL');
  assert.equal(xStockSymbol('GOOG'), 'GOOGLX');
});

test('isEnabled reflects the BIRDEYE_API_KEY env (dormant by default)', () => {
  // No key in the test env → feature stays off, never fabricates
  assert.equal(isEnabled(), false);
});

test('pickXStockFromSearch picks the exact-symbol, verified, most-liquid match', () => {
  const json = {
    data: {
      items: [
        {
          type: 'token',
          result: [
            // wrong symbol — ignored
            { address: 'WRONG', symbol: 'AAPL', liquidity: 9_000_000, verified: true },
            // right symbol but unverified + low liquidity
            { address: 'LOWLIQ', symbol: 'AAPLx', liquidity: 100, verified: false },
            // right symbol, verified, highest liquidity → winner
            { address: 'REALMINT', symbol: 'AAPLx', liquidity: 5_000_000, verified: true },
          ],
        },
      ],
    },
  };
  const hit = pickXStockFromSearch(json, 'AAPLX');
  assert.ok(hit);
  assert.equal(hit.address, 'REALMINT');
  assert.equal(hit.liquidity, 5_000_000);
});

test('pickXStockFromSearch handles a flat tokens[] shape and no-match', () => {
  const flat = { data: { tokens: [{ mint: 'M1', symbol: 'TSLAx', liquidity_usd: 42 }] } };
  const hit = pickXStockFromSearch(flat, 'TSLAX');
  assert.equal(hit.address, 'M1');
  assert.equal(hit.liquidity, 42);

  assert.equal(pickXStockFromSearch({ data: { items: [] } }, 'NVDAX'), null);
  assert.equal(pickXStockFromSearch({}, 'NVDAX'), null);
});

test('parsePriceResponse extracts a positive USD price, else null', () => {
  assert.equal(parsePriceResponse({ data: { value: 231.44 } }), 231.44);
  assert.equal(parsePriceResponse({ data: { price: 10 } }), 10);
  assert.equal(parsePriceResponse({ data: { value: 0 } }), null);
  assert.equal(parsePriceResponse({ data: {} }), null);
  assert.equal(parsePriceResponse({}), null);
});

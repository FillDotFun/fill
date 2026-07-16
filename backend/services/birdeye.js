import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Birdeye service — on-chain (tokenized) stock prices
//
// Birdeye indexes Solana DEX tokens, including "xStocks" (Backed Finance):
// 1:1 tokenized US equities that trade on-chain — AAPLx, TSLAx, NVDAx, …
// These are the DeFi-native twins of the exact tickers the FILL engine
// trades as perps on Ostium. We surface their live on-chain price next to
// the real NYSE quote so you can see the on-chain premium/discount.
//
// Birdeye does NOT index Robinhood Chain, so it is not used for Pons/FILL
// token pricing (that stays on GeckoTerminal). This module is purely the
// on-chain-equities feed and stays dormant until BIRDEYE_API_KEY is set.
// ---------------------------------------------------------------------------

const API_KEY = process.env.BIRDEYE_API_KEY || '';
const BASE_URL = process.env.BIRDEYE_API_URL || 'https://public-api.birdeye.so';
const CHAIN = process.env.BIRDEYE_CHAIN || 'solana';

// Our engine tickers → xStocks base ticker. Almost all are identical; the
// exceptions are spelled out (Alphabet trades as GOOGLx on-chain).
export const XSTOCK_ALIAS = {
  GOOG: 'GOOGL',
};

// Optional manual override: BIRDEYE_XSTOCK_MAP='{"AAPL":"<mint>","TSLA":"<mint>"}'
function overrideMap() {
  try {
    return JSON.parse(process.env.BIRDEYE_XSTOCK_MAP || '{}');
  } catch {
    return {};
  }
}

export function isEnabled() {
  return !!API_KEY;
}

/** The xStock symbol we expect for one of our tickers, e.g. AAPL → "AAPLX". */
export function xStockSymbol(symbol) {
  const base = XSTOCK_ALIAS[symbol] || symbol;
  return `${base}X`.toUpperCase();
}

// ── Pure parsers (unit-tested without the network) ──────────────────────────

/**
 * Pick the best xStock match out of a Birdeye /defi/v3/search response.
 * Defensive against Birdeye's grouped shape: data.items[].result[] or a flat
 * data.tokens[]. Requires an exact symbol match, prefers verified tokens,
 * then highest liquidity.
 * @returns {{address:string, symbol:string, liquidity:number}|null}
 */
export function pickXStockFromSearch(json, wantSymbol) {
  const want = String(wantSymbol || '').toUpperCase();
  const candidates = [];

  const push = (t) => {
    if (t && (t.address || t.mint) && t.symbol) candidates.push(t);
  };

  const items = json?.data?.items;
  if (Array.isArray(items)) {
    for (const it of items) {
      if (Array.isArray(it?.result)) it.result.forEach(push);
      else push(it);
    }
  }
  if (Array.isArray(json?.data?.tokens)) json.data.tokens.forEach(push);

  const liq = (t) => Number(t.liquidity ?? t.liquidity_usd ?? t.liquidityUsd ?? 0) || 0;
  const isVerified = (t) => t.verified === true || t.verify_token === true || t.is_verified === true;

  const matches = candidates
    .filter((t) => String(t.symbol).toUpperCase() === want)
    .sort((a, b) => (isVerified(b) - isVerified(a)) || (liq(b) - liq(a)));

  const best = matches[0];
  if (!best) return null;
  return { address: best.address || best.mint, symbol: best.symbol, liquidity: liq(best) };
}

/** Extract a USD price out of a Birdeye /defi/price response. */
export function parsePriceResponse(json) {
  const v = json?.data?.value ?? json?.data?.price;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Network calls ───────────────────────────────────────────────────────────

const HEADERS = () => ({ accept: 'application/json', 'x-chain': CHAIN, 'X-API-KEY': API_KEY });

const _addrCache = new Map();   // symbol -> { address, at }
const _priceCache = new Map();  // symbol -> { data, at }
const ADDR_TTL = 6 * 60 * 60_000; // xStock mints are stable — cache 6h
const PRICE_TTL = 60_000;

async function beFetch(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: HEADERS() });
  if (!res.ok) throw new Error(`Birdeye ${res.status}`);
  return res.json();
}

/** Resolve one of our tickers to its xStock mint address on Solana. */
export async function resolveXStockAddress(symbol) {
  if (!isEnabled()) return null;

  const override = overrideMap()[symbol];
  if (override) return override;

  const cached = _addrCache.get(symbol);
  if (cached && Date.now() - cached.at < ADDR_TTL) return cached.address;

  const want = xStockSymbol(symbol);
  try {
    const q = new URLSearchParams({
      chain: CHAIN,
      keyword: want,
      target: 'token',
      search_by: 'symbol',
      verify_token: 'true',
      sort_by: 'liquidity',
      sort_type: 'desc',
      offset: '0',
      limit: '10',
    });
    const json = await beFetch(`/defi/v3/search?${q.toString()}`);
    const hit = pickXStockFromSearch(json, want);
    const address = hit?.address || null;
    if (address) _addrCache.set(symbol, { address, at: Date.now() });
    return address;
  } catch (err) {
    logger.debug('Birdeye resolve failed', { symbol, error: err.message });
    return cached?.address || null;
  }
}

/**
 * Live on-chain price for a tokenized stock.
 * @returns {{symbol, xSymbol, address, priceUsd}|null}
 */
export async function getOnchainStockPrice(symbol) {
  if (!isEnabled()) return null;

  const cached = _priceCache.get(symbol);
  if (cached && Date.now() - cached.at < PRICE_TTL) return cached.data;

  const address = await resolveXStockAddress(symbol);
  if (!address) return null;

  try {
    const json = await beFetch(`/defi/price?address=${address}&include_liquidity=true`);
    const priceUsd = parsePriceResponse(json);
    if (priceUsd == null) return cached?.data || null;
    const data = { symbol, xSymbol: xStockSymbol(symbol), address, priceUsd };
    _priceCache.set(symbol, { data, at: Date.now() });
    return data;
  } catch (err) {
    logger.debug('Birdeye price failed', { symbol, error: err.message });
    return cached?.data || null;
  }
}

/** Batch on-chain prices; returns only the tickers that resolved. */
export async function getOnchainStockPrices(symbols) {
  if (!isEnabled()) return [];
  const out = await Promise.all(symbols.map((s) => getOnchainStockPrice(s).catch(() => null)));
  return out.filter(Boolean);
}

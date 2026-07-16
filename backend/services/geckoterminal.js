import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// GeckoTerminal service — Robinhood Chain market data
//
// GeckoTerminal indexes Robinhood Chain (network id: "robinhood"), which
// makes it the market-data source for Pons tokens once they trade on
// Uniswap: price, FDV, volume, pools, and OHLCV candles. Free API,
// ~30 req/min — everything here is cached hard.
// ---------------------------------------------------------------------------

const GT_API = process.env.GECKOTERMINAL_API_URL || 'https://api.geckoterminal.com/api/v2';
const NETWORK = process.env.GECKOTERMINAL_NETWORK || 'robinhood';
const HEADERS = { accept: 'application/json' };

// token address -> { data, at }
const _tokenCache = new Map();
// token address -> { poolAddress, at }
const _poolCache = new Map();
// `${pool}:${timeframe}` -> { candles, at }
const _ohlcvCache = new Map();

const TOKEN_TTL = 60_000;
const POOL_TTL = 10 * 60_000;
const OHLCV_TTL = 60_000;

async function gtFetch(path) {
  const res = await fetch(`${GT_API}${path}`, { headers: HEADERS });
  if (res.status === 429) throw new Error('GeckoTerminal rate limit');
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`);
  return res.json();
}

/**
 * Live token stats for a Robinhood Chain token:
 * { priceUsd, fdvUsd, volume24hUsd, reserveUsd, name, symbol, imageUrl }
 */
export async function getTokenStats(tokenAddress) {
  const key = tokenAddress.toLowerCase();
  const cached = _tokenCache.get(key);
  if (cached && Date.now() - cached.at < TOKEN_TTL) return cached.data;

  try {
    const json = await gtFetch(`/networks/${NETWORK}/tokens/${key}`);
    const a = json?.data?.attributes || {};
    const data = {
      priceUsd: parseFloat(a.price_usd) || 0,
      fdvUsd: parseFloat(a.fdv_usd) || 0,
      volume24hUsd: parseFloat(a.volume_usd?.h24) || 0,
      reserveUsd: parseFloat(a.total_reserve_in_usd) || 0,
      name: a.name || null,
      symbol: a.symbol || null,
      imageUrl: a.image_url || null,
    };

    // Stash the top pool for OHLCV lookups
    const topPool = json?.data?.relationships?.top_pools?.data?.[0]?.id;
    if (topPool) {
      _poolCache.set(key, { poolAddress: topPool.replace(`${NETWORK}_`, ''), at: Date.now() });
    }

    _tokenCache.set(key, { data, at: Date.now() });
    return data;
  } catch (err) {
    logger.debug('GeckoTerminal token stats failed', { token: key, error: err.message });
    return cached?.data || null;
  }
}

/**
 * The token's most liquid pool address (needed for OHLCV).
 */
export async function getTopPool(tokenAddress) {
  const key = tokenAddress.toLowerCase();
  const cached = _poolCache.get(key);
  if (cached && Date.now() - cached.at < POOL_TTL) return cached.poolAddress;

  // getTokenStats populates the pool cache as a side effect
  await getTokenStats(key);
  return _poolCache.get(key)?.poolAddress || null;
}

/**
 * OHLCV candles for a token's top pool.
 *
 * @param {string} tokenAddress
 * @param {'minute'|'hour'|'day'} timeframe
 * @param {number} aggregate — e.g. 5 for 5-minute candles
 * @param {number} limit
 * @returns {Array<{t, o, h, l, c, v}>} oldest → newest
 */
export async function getTokenOhlcv(tokenAddress, timeframe = 'hour', aggregate = 1, limit = 100) {
  const pool = await getTopPool(tokenAddress);
  if (!pool) return [];

  const cacheKey = `${pool}:${timeframe}:${aggregate}`;
  const cached = _ohlcvCache.get(cacheKey);
  if (cached && Date.now() - cached.at < OHLCV_TTL) return cached.candles;

  try {
    const json = await gtFetch(
      `/networks/${NETWORK}/pools/${pool}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}`,
    );
    const list = json?.data?.attributes?.ohlcv_list || [];
    // GeckoTerminal returns newest-first [ts, o, h, l, c, v]
    const candles = list
      .map(([t, o, h, l, c, v]) => ({ t: t * 1000, o, h, l, c, v }))
      .reverse();
    _ohlcvCache.set(cacheKey, { candles, at: Date.now() });
    return candles;
  } catch (err) {
    logger.debug('GeckoTerminal OHLCV failed', { token: tokenAddress, error: err.message });
    return cached?.candles || [];
  }
}

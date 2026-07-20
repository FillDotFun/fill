import config from '../config.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Hyperliquid perps service — trade[XYZ] HIP-3 equity dex ("xyz")
//
// A drop-in alternative to Ostium (which halted after the 2026-07-15 oracle
// exploit). Hyperliquid's builder-deployed "xyz" dex lists single-name US
// equity perps (AAPL, TSLA, NVDA, HOOD, COIN, MSTR, …) — the same tickers
// FILL trades — with USDC margin, deep liquidity, and near-24/7 trading.
//
// Interface mirrors services/ostium.js so the venue router (services/venue.js)
// can dispatch to either venue transparently. Trades sign with the same
// protocol EOA via the official `hyperliquid` SDK. Collateral is USDC on
// the Hyperliquid L1 (bridged from Arbitrum) — SEPARATE from the Ostium
// USDC pool, so switching venues needs a one-time deposit to Hyperliquid.
// ---------------------------------------------------------------------------

const DEX = 'xyz';
const SLIPPAGE = (config.OSTIUM.SLIPPAGE_BPS || 50) / 10_000; // fraction, e.g. 0.005

// FILL ticker -> Hyperliquid xyz symbol. Almost all identical; Alphabet is GOOGL.
const SYMBOL_ALIAS = { GOOG: 'GOOGL' };
const hlSymbol = (market) => `${DEX}:${(SYMBOL_ALIAS[market] || market).toUpperCase()}`;

let _sdk = null;
let _client = null;
let _metaCache = { at: 0, byName: new Map() };

async function loadSdk() {
  if (!_sdk) _sdk = await import('hyperliquid');
  return _sdk;
}

async function getClient() {
  if (_client) return _client;
  const { Hyperliquid } = await loadSdk();
  _client = new Hyperliquid({
    privateKey: config.protocolWallet?.privateKey,   // read-only if undefined
    testnet: false,
    enableWs: false,
  });
  await _client.connect().catch(() => {});
  logger.info('Hyperliquid client created', {
    trader: config.PROTOCOL_ADDRESS,
    mode: config.protocolWallet ? 'signer' : 'read-only',
  });
  return _client;
}

// Raw info POST (no auth) — used for market data so it works read-only.
async function info(body) {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid info ${res.status}`);
  return res.json();
}

// Cache the xyz universe + live asset contexts (price/OI) for 30s.
async function getMeta() {
  if (Date.now() - _metaCache.at < 30_000 && _metaCache.byName.size) return _metaCache;
  const [meta, ctxs] = await info({ type: 'metaAndAssetCtxs', dex: DEX });
  const byName = new Map();
  meta.universe.forEach((a, i) => {
    byName.set(a.name, {
      name: a.name,
      market: a.name.replace(`${DEX}:`, ''),
      maxLeverage: a.maxLeverage,
      szDecimals: a.szDecimals,
      onlyIsolated: a.onlyIsolated === true,
      isDelisted: a.isDelisted === true,
      markPx: parseFloat(ctxs[i]?.markPx) || parseFloat(ctxs[i]?.midPx) || 0,
      oraclePx: parseFloat(ctxs[i]?.oraclePx) || 0,
    });
  });
  _metaCache = { at: Date.now(), byName };
  return _metaCache;
}

// ── Market data (interface parity with ostium) ──────────────────────────────

export async function getPairs() {
  const { byName } = await getMeta();
  return [...byName.values()];
}

export async function findPair(market) {
  const { byName } = await getMeta();
  const p = byName.get(hlSymbol(market));
  if (!p || p.isDelisted) return null;
  return {
    ...p,
    pairId: p.name,
    midPx: p.markPx,
    // Hyperliquid equity perps trade near-24/7 with funding; "open" == live price
    isMarketOpen: p.markPx > 0,
  };
}

export async function getMidPrice(market) {
  const p = await findPair(market);
  return p?.markPx || 0;
}

export function getMaxLeverage(_market) {
  return config.OSTIUM.MAX_LEVERAGE;
}

export async function getSafeMaxLeverage(market) {
  const p = await findPair(market);
  return Math.min(p?.maxLeverage || 10, config.OSTIUM.MAX_LEVERAGE);
}

// Hyperliquid has no venue-wide halt equivalent to Ostium's incident.
export async function isVenuePaused() {
  return false;
}

// Equity perps trade near-24/7 on HL; treat "open" as "has a live mark".
export async function isStockMarketOpen() {
  try {
    const p = await findPair(config.DEFAULT_MARKET || 'AAPL');
    return !!p?.isMarketOpen;
  } catch {
    return false;
  }
}

// ── Account state ───────────────────────────────────────────────────────────

async function clearinghouse() {
  const client = await getClient();
  return client.info.getClearinghouseState(config.PROTOCOL_ADDRESS);
}

export async function getFreeCollateral() {
  try {
    const st = await clearinghouse();
    // withdrawable = free USDC not backing any margin
    return parseFloat(st?.withdrawable ?? st?.marginSummary?.accountValue ?? 0) || 0;
  } catch (err) {
    logger.debug('HL getFreeCollateral failed', { error: err.message });
    return 0;
  }
}

// Shape matches ostium.getAllPositions exactly — getLivePositions and the
// dashboard consume this contract.
export async function getAllPositions() {
  try {
    const st = await clearinghouse();
    const out = [];
    for (const ap of (st?.assetPositions || [])) {
      const p = ap.position;
      const szi = parseFloat(p?.szi || 0);
      if (!szi) continue;
      const entry = parseFloat(p.entryPx) || 0;
      const sizeUsd = Math.abs(parseFloat(p.positionValue)) || Math.abs(szi) * entry;
      out.push({
        market: (p.coin || '').replace(`${DEX}:`, ''),
        side: szi > 0 ? 'long' : 'short',
        sizeUsd,
        collateralUsd: parseFloat(p.marginUsed) || 0,
        entryPrice: entry,
        currentPrice: szi !== 0 ? sizeUsd / Math.abs(szi) : entry,
        unrealisedPnl: parseFloat(p.unrealizedPnl) || 0,
        leverage: parseFloat(p.leverage?.value) || 0,
        liquidationPrice: parseFloat(p.liquidationPx) || 0,
        sizeShares: Math.abs(szi),
      });
    }
    return out;
  } catch (err) {
    logger.debug('HL getAllPositions failed', { error: err.message });
    return [];
  }
}

// Shape matches ostium.getPositionPnl exactly — the workers' double-open
// guard (live.exists) and risk-manager math (pnl/size/entry/collateralUsd/
// currentPrice) rely on this contract.
export async function getPositionPnl(market) {
  try {
    const want = (SYMBOL_ALIAS[market] || market).toUpperCase();
    const positions = await getAllPositions();
    const p = positions.find((x) => x.market === want);
    if (!p) return { exists: false, pnl: 0, size: 0, entry: 0 };

    let currentPrice = p.currentPrice;
    try { currentPrice = (await getMidPrice(market)) || currentPrice; } catch {}

    return {
      exists: true,
      pnl: p.unrealisedPnl,
      size: p.sizeUsd,
      entry: p.entryPrice,
      collateralUsd: p.collateralUsd,
      side: p.side,
      currentPrice,
      liquidationPrice: p.liquidationPrice,
      leverage: p.leverage,
    };
  } catch (err) {
    logger.error('HL getPositionPnl error', { market, error: err.message });
    return { exists: false, pnl: 0, size: 0, entry: 0, error: err.message };
  }
}

export async function getFills(limit = 60) {
  try {
    const client = await getClient();
    const fills = await client.info.getUserFills(config.PROTOCOL_ADDRESS);
    return (fills || []).slice(0, limit).map((f) => ({
      market: (f.coin || '').replace(`${DEX}:`, ''),
      side: f.dir || (f.side === 'B' ? 'buy' : 'sell'),
      price: parseFloat(f.px) || 0,
      size: parseFloat(f.sz) || 0,
      pnl: parseFloat(f.closedPnl) || 0,
      fee: parseFloat(f.fee) || 0,
      time: f.time,
      hash: f.hash,
    }));
  } catch {
    return [];
  }
}

// ── Trading (write path) ────────────────────────────────────────────────────

function roundSize(sizeShares, szDecimals) {
  const f = 10 ** szDecimals;
  return Math.floor(sizeShares * f) / f;
}

export async function openPosition(market, sizeUsd, collateralUsd, side = 'long') {
  try {
    if (!config.protocolWallet) throw new Error('Protocol wallet not loaded');
    const pair = await findPair(market);
    if (!pair) throw new Error(`No Hyperliquid market for ${market}`);
    if (!pair.isMarketOpen) return { success: false, skipped: 'market-closed' };

    const price = pair.markPx;
    if (!price) throw new Error(`No price for ${market}`);

    const maxLev = Math.min(pair.maxLeverage, config.OSTIUM.MAX_LEVERAGE);
    const leverage = Math.min(Math.max(1, Math.round((sizeUsd / collateralUsd))), maxLev);
    const sizeShares = roundSize((collateralUsd * leverage) / price, pair.szDecimals);
    if (sizeShares <= 0) return { success: false, skipped: 'size-too-small' };

    const client = await getClient();
    const symbol = pair.name;                       // e.g. "xyz:AAPL"
    const marginMode = pair.onlyIsolated ? 'isolated' : 'cross';

    // Set leverage/margin mode first (idempotent), then market order.
    await client.exchange.updateLeverage(symbol, marginMode, leverage).catch((e) =>
      logger.debug('HL updateLeverage note', { market, error: e.message }));

    logger.info('Opening position on Hyperliquid', {
      market, side, leverage: leverage + 'x',
      collateralUsd: collateralUsd.toFixed(2), sizeShares,
    });

    const result = await client.custom.marketOpen(symbol, side !== 'short', sizeShares, undefined, SLIPPAGE);
    const status = result?.response?.data?.statuses?.[0];
    const txSig = status?.filled?.oid || status?.resting?.oid || result?.status || 'submitted';
    if (status?.error) throw new Error(status.error);

    logger.info('Hyperliquid order placed', { market, side, leverage: leverage + 'x', txSig });
    return { txSig: String(txSig), success: true };
  } catch (err) {
    logger.error('HL openPosition failed', { market, side, sizeUsd, error: err.message });
    throw err;
  }
}

export async function openLong(market, sizeUsd, collateralUsd) {
  return openPosition(market, sizeUsd, collateralUsd, 'long');
}
export async function openShort(market, sizeUsd, collateralUsd) {
  return openPosition(market, sizeUsd, collateralUsd, 'short');
}

export async function closePosition(market) {
  if (!config.protocolWallet) throw new Error('Protocol wallet not loaded');
  const client = await getClient();
  const result = await client.custom.marketClose(hlSymbol(market));
  const status = result?.response?.data?.statuses?.[0];
  return { txSig: String(status?.filled?.oid || 'closed'), success: true };
}

export async function reducePosition(market, pct) {
  const positions = await getAllPositions();
  const p = positions.find((x) => x.market === (SYMBOL_ALIAS[market] || market).toUpperCase());
  if (!p) return { success: false, skipped: 'no-position' };
  const client = await getClient();
  const pair = await findPair(market);
  // partial close via marketClose(symbol, size) — SDK handles reduce
  // semantics, so a rounding overshoot can never flip the position
  const closeSize = roundSize(p.sizeShares * Math.min(Math.max(pct, 0), 1), pair.szDecimals);
  if (closeSize <= 0) return { success: false, skipped: 'size-too-small' };
  const result = await client.custom.marketClose(pair.name, closeSize, undefined, SLIPPAGE);
  const status = result?.response?.data?.statuses?.[0];
  return { txSig: String(status?.filled?.oid || 'reduced'), success: true };
}

export function getAvailableMarkets() {
  return config.STOCK_MARKETS;
}

export async function shutdown() {
  try { await _client?.disconnect?.(); } catch {}
  _client = null;
}

import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Market Signal Engine v3 — Stocks Edition
//
// Analyzes stock price action for entry/exit timing on Ostium stock perps.
//
// Signals:
//   1. Momentum (EMA crossovers on 1m candles)
//   2. RSI (context-aware: overbought only bearish if HTF trend is weak)
//   3. MACD (trend confirmation)
//   4. Higher timeframe trend (15m + 1H EMA)
//   5. Volatility (ATR-based)
//   6. Session timing (regular trading hours >> pre/post market >> overnight)
//   7. Volume confirmation (high volume validates moves)
//   8. Recent price action
//
// Candle data comes from Yahoo Finance (no API key needed). Note the perps
// trade nearly 24/7 on Ostium but price discovery happens during US market hours —
// the session score reflects that.
//
// Returns a score from -100 to +100 and recommended leverage (max 50x).
// ---------------------------------------------------------------------------

const YAHOO_API = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };

// Per-market caches
const caches = {};
function getCache(market) {
  if (!caches[market]) {
    caches[market] = {
      c1m: { data: null, at: 0 },
      c15m: { data: null, at: 0 },
      c1h: { data: null, at: 0 },
    };
  }
  return caches[market];
}
const CACHE_TTL = 30_000;

// ---------------------------------------------------------------------------
// Data Fetchers (Yahoo Finance chart API)
// ---------------------------------------------------------------------------

async function fetchCandles(symbol, interval, range, cache) {
  if (cache.data && Date.now() - cache.at < CACHE_TTL) return cache.data;
  try {
    const url = `${YAHOO_API}/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=true`;
    const r = await fetch(url, { headers: YAHOO_HEADERS });
    if (!r.ok) throw new Error(`${r.status}`);
    const raw = await r.json();
    const result = raw?.chart?.result?.[0];
    if (!result) throw new Error('empty chart result');

    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close?.[i] == null) continue; // skip empty buckets (halts, gaps)
      candles.push({
        openTime: ts[i] * 1000,
        open: q.open[i], high: q.high[i], low: q.low[i],
        close: q.close[i], volume: q.volume?.[i] || 0,
      });
    }
    if (candles.length === 0) throw new Error('no candles');
    cache.data = candles;
    cache.at = Date.now();
    return candles;
  } catch (e) {
    logger.warn('Candle fetch failed', { symbol, interval, error: e.message });
    return cache.data || [];
  }
}

function getCandles1m(market) { const c = getCache(market); return fetchCandles(market, '1m', '1d', c.c1m); }
function getCandles15m(market) { const c = getCache(market); return fetchCandles(market, '15m', '5d', c.c15m); }
function getCandles1h(market) { const c = getCache(market); return fetchCandles(market, '1h', '3mo', c.c1h); }

// ---------------------------------------------------------------------------
// Technical Indicators
// ---------------------------------------------------------------------------

function sma(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  return values.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function ema(values, period) {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function atr(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ));
  }
  return sma(trs, Math.min(period, trs.length));
}

function macd(closes) {
  return ema(closes, 12) - ema(closes, 26);
}

// ---------------------------------------------------------------------------
// Session & Volume Helpers
//
// US equities: regular trading hours are 13:30-20:00 UTC (9:30-16:00 ET).
// The open (first 90 min) and the close (last hour) carry the most volume.
// Overnight, tokenized-stock perps drift on thin flow — worst time to enter.
// ---------------------------------------------------------------------------

export function getSession() {
  const now = new Date();
  const day = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();

  if (day === 0 || day === 6) return 'weekend';
  if (mins >= 810 && mins < 900) return 'market-open';      // 13:30-15:00 UTC
  if (mins >= 1140 && mins < 1200) return 'power-hour';     // 19:00-20:00 UTC
  if (mins >= 810 && mins < 1200) return 'regular-hours';   // 13:30-20:00 UTC
  if (mins >= 480 && mins < 810) return 'pre-market';       // 08:00-13:30 UTC
  if (mins >= 1200 && mins < 1440) return 'after-hours';    // 20:00-24:00 UTC
  return 'overnight';
}

function sessionScore() {
  switch (getSession()) {
    case 'market-open':   return 25;
    case 'power-hour':    return 20;
    case 'regular-hours': return 15;
    case 'pre-market':    return 5;
    case 'after-hours':   return 5;
    case 'weekend':       return -10;  // thin 24/7 perp flow only
    default:              return 0;    // overnight
  }
}

/**
 * Volume score: compare recent volume to average.
 * High volume on a move confirms it's real.
 */
function volumeScore(candles) {
  if (candles.length < 30) return 0;
  const volumes = candles.map(c => c.volume);
  const avgVol = sma(volumes, 20);
  const recentVol = sma(volumes.slice(-5), 5);
  const ratio = avgVol > 0 ? recentVol / avgVol : 1;

  // Recent candle direction (are volume candles bullish or bearish?)
  const last5 = candles.slice(-5);
  const bullishVol = last5.filter(c => c.close > c.open).reduce((s, c) => s + c.volume, 0);
  const bearishVol = last5.filter(c => c.close <= c.open).reduce((s, c) => s + c.volume, 0);
  const volBias = bullishVol > bearishVol ? 1 : -1;

  if (ratio > 2.0) return 15 * volBias;   // very high volume
  if (ratio > 1.5) return 10 * volBias;   // above average
  if (ratio > 1.0) return 5 * volBias;    // slightly above
  return 0;                                 // below average = no confirmation
}

// ---------------------------------------------------------------------------
// Main Signal Generation
// ---------------------------------------------------------------------------

/**
 * Generate a comprehensive market signal for a stock.
 *
 * @returns {{ score, direction, confidence, leverage, details }}
 */
export async function getMarketSignal(market = 'AAPL') {
  try {
    const [c1m, c15m, c1h] = await Promise.all([
      getCandles1m(market),
      getCandles15m(market),
      getCandles1h(market),
    ]);

    if (c1m.length < 50 || c15m.length < 10) {
      return { score: 0, direction: 'wait', confidence: 0, leverage: 20, details: { error: 'insufficient data' }, market };
    }

    const closes1m = c1m.map(c => c.close);
    const closes15m = c15m.map(c => c.close);
    const closes1h = c1h.map(c => c.close);
    const price = closes1m[closes1m.length - 1];

    // === 1. Momentum (EMA crossovers on 1m) ===
    const ema5 = ema(closes1m, 5);
    const ema20 = ema(closes1m, 20);
    const ema50 = ema(closes1m, 50);

    let momentumScore = 0;
    if (ema5 > ema20) momentumScore += 15; else momentumScore -= 15;
    if (ema20 > ema50) momentumScore += 10; else momentumScore -= 10;
    if (price > ema20) momentumScore += 5; else momentumScore -= 5;

    // === 2. RSI (context-aware) ===
    const rsiVal = rsi(closes1m, 14);
    let rsiScore = 0;

    // Check if we're in a strong HTF uptrend
    const htfBullish = closes1h.length >= 50 && ema(closes1h, 10) > ema(closes1h, 50);

    if (rsiVal < 30) rsiScore = 20;          // oversold = strong buy
    else if (rsiVal < 40) rsiScore = 10;
    else if (rsiVal > 70 && !htfBullish) rsiScore = -20;  // overbought + weak trend = bearish
    else if (rsiVal > 70 && htfBullish) rsiScore = 5;     // overbought but strong trend = still ok
    else if (rsiVal > 60) rsiScore = -5;

    // === 3. MACD ===
    const macdVal = macd(closes1m);
    const macdScore = macdVal > 0 ? 10 : -10;

    // === 4. Higher Timeframe Trend ===
    // 15m trend
    let htfScore = 0;
    if (closes15m.length >= 20) {
      if (ema(closes15m, 10) > ema(closes15m, 20)) htfScore += 10;
      else htfScore -= 10;
    }

    // 1H EMA200 -- the big trend filter
    if (closes1h.length >= 200) {
      const ema200_1h = ema(closes1h, 200);
      if (price > ema200_1h) htfScore += 10;  // above 1H EMA200 = bullish
      else htfScore -= 10;                     // below = bearish
    } else if (closes1h.length >= 50) {
      // Fallback to 1H EMA50
      const ema50_1h = ema(closes1h, 50);
      if (price > ema50_1h) htfScore += 5;
      else htfScore -= 5;
    }

    // === 5. Volatility ===
    // Stocks move less than crypto: a 0.02-0.15% ATR on 1m is a healthy
    // scalping band; above that is earnings/news chaos.
    const atrVal = atr(c1m, 14);
    const atrPct = price > 0 ? (atrVal / price) * 100 : 0;
    let volScore = 0;
    if (atrPct > 0.02 && atrPct < 0.15) volScore = 10;
    else if (atrPct >= 0.15) volScore = -5;
    else volScore = -10;

    // === 6. Session ===
    const sessScore = sessionScore();

    // === 7. Volume Confirmation ===
    const volConfirm = volumeScore(c1m);

    // === 8. Recent Price Action ===
    const last5 = closes1m.slice(-5);
    const recentMove = (last5[last5.length - 1] - last5[0]) / last5[0] * 100;
    let recentScore = 0;
    if (recentMove > 0.05) recentScore = 10;
    else if (recentMove > 0.02) recentScore = 5;
    else if (recentMove < -0.05) recentScore = -10;
    else if (recentMove < -0.02) recentScore = -5;

    // === Combine ===
    const raw = momentumScore + rsiScore + macdScore + htfScore +
                volScore + sessScore + volConfirm + recentScore;
    const score = Math.max(-100, Math.min(100, raw));

    // Direction
    let direction = 'wait';
    if (score >= 25) direction = 'long';
    else if (score <= -25) direction = 'short';

    const confidence = Math.abs(score);

    // === Leverage scaling based on score (Ostium max 50x) ===
    let leverage;
    if (confidence >= 80) leverage = 50;
    else if (confidence >= 60) leverage = 40;
    else if (confidence >= 40) leverage = 30;
    else leverage = 20;

    const session = getSession();

    const details = {
      currentPrice: price.toFixed(2),
      momentum: momentumScore,
      rsi: { value: rsiVal.toFixed(1), score: rsiScore, htfBullish },
      macd: { value: macdVal.toFixed(4), score: macdScore },
      htf: htfScore,
      volatility: { atrPct: atrPct.toFixed(4), score: volScore },
      session: { name: session, score: sessScore },
      volume: volConfirm,
      recentMove: { pct: recentMove.toFixed(3) + '%', score: recentScore },
      ema: { ema5: ema5.toFixed(2), ema20: ema20.toFixed(2), ema50: ema50.toFixed(2) },
    };

    logger.info('Market signal v3 (stocks)', {
      market, score, direction, confidence, leverage,
      price: price.toFixed(2), rsi: rsiVal.toFixed(1), session,
    });

    return { score, direction, confidence, leverage, details, market };
  } catch (err) {
    logger.error('Market signal error', { market, error: err.message });
    return { score: 0, direction: 'wait', confidence: 0, leverage: 20, details: { error: err.message }, market };
  }
}

/**
 * Check if we should enter a position right now.
 * Returns entry decision + recommended leverage + direction.
 *
 * @param {string} market — stock symbol
 * @param {{allowShort?: boolean}} opts — allow bearish entries (engine-owned
 *   markets can short; creator-pegged tokens follow their configured side)
 */
export async function shouldEnterNow(market = 'AAPL', { allowShort = false } = {}) {
  const signal = await getMarketSignal(market);

  // Only enter on strong conviction (|score| >= 25)
  if (signal.direction === 'long' && signal.score >= 25) {
    return { enter: true, direction: 'long', signal };
  }
  if (allowShort && signal.direction === 'short' && signal.score <= -25) {
    return { enter: true, direction: 'short', signal };
  }

  return { enter: false, direction: 'wait', signal };
}

/**
 * Check if we should EXIT an existing position.
 * Called while a position is open to detect momentum reversal.
 *
 * @param {'long'|'short'} positionSide - current position direction
 * @returns {{ shouldExit: boolean, reason: string, signal: object }}
 */
export async function shouldExitNow(positionSide = 'long', market = 'AAPL') {
  const signal = await getMarketSignal(market);

  // For longs: exit if signal goes strongly negative (momentum reversal)
  if (positionSide === 'long') {
    if (signal.score <= -30) {
      return { shouldExit: true, reason: 'momentum-reversal', signal };
    }
  }

  // For shorts: exit if signal goes strongly positive
  if (positionSide === 'short') {
    if (signal.score >= 30) {
      return { shouldExit: true, reason: 'momentum-reversal', signal };
    }
  }

  return { shouldExit: false, reason: 'hold', signal };
}

import { parseEther, formatEther } from 'ethers';
import config from '../config.js';
import logger from './logger.js';

// ---------------------------------------------------------------------------
// ETH ↔ wei
// ---------------------------------------------------------------------------
export function ethToWei(eth) {
  return parseEther(eth.toFixed(18));
}

export function weiToEth(wei) {
  return parseFloat(formatEther(wei));
}

// ---------------------------------------------------------------------------
// Random interval (with jitter)
// ---------------------------------------------------------------------------
export function randomIntervalMs(
  minSec = config.INTERVALS.minSeconds,
  maxSec = config.INTERVALS.maxSeconds,
) {
  const sec = minSec + Math.random() * (maxSec - minSec);
  return Math.round(sec * 1000);
}

// ---------------------------------------------------------------------------
// Retry wrapper with exponential backoff
// ---------------------------------------------------------------------------
export async function retry(fn, {
  retries = 3,
  delayMs = 1000,
  factor = 2,
  label = 'operation',
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const wait = delayMs * factor ** (attempt - 1);
      logger.warn(`Retry ${attempt}/${retries} for ${label} — waiting ${wait}ms`, {
        error: err.message,
      });
      if (attempt < retries) {
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Sleep
// ---------------------------------------------------------------------------
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Shorten an address for display
// ---------------------------------------------------------------------------
export function shortenKey(address, len = 4) {
  const s = String(address);
  return `${s.slice(0, len + 2)}…${s.slice(-len)}`;
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------
export function nowISO() {
  return new Date().toISOString();
}

export function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Telegram notifier — trade alerts for the engine.
//
// Same pattern as the other bots (trador-bot, meta-radar): set
// TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env and every meaningful engine
// event lands in your chat. No-ops silently when unconfigured.
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

export const enabled = Boolean(BOT_TOKEN && CHAT_ID);

// Simple queue so bursts of alerts don't hit Telegram's rate limit
const _queue = [];
let _draining = false;

async function drain() {
  if (_draining) return;
  _draining = true;
  while (_queue.length > 0) {
    const text = _queue.shift();
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        logger.warn('Telegram send failed', { status: res.status, body: body.slice(0, 200) });
      }
    } catch (err) {
      logger.warn('Telegram send error', { error: err.message });
    }
    // ~1 msg/sec keeps us comfortably under Telegram limits
    if (_queue.length > 0) await new Promise(r => setTimeout(r, 1100));
  }
  _draining = false;
}

export function notify(text) {
  if (!enabled) return;
  _queue.push(text);
  drain();
}

// ---------------------------------------------------------------------------
// Formatted event helpers
// ---------------------------------------------------------------------------

const fmtUsd = (n) => `$${Math.abs(n).toFixed(2)}`;
const sign = (n) => (n >= 0 ? '+' : '-');

export function notifyPositionOpened({ market, side, leverage, collateralUsd, sizeUsd, score }) {
  notify(
    `🟢 <b>OPENED</b> ${market} ${side.toUpperCase()} ${leverage}x on Ostium\n` +
    `collateral: ${fmtUsd(collateralUsd)} USDC · size: ${fmtUsd(sizeUsd)}` +
    (score != null ? `\nsignal score: ${score}` : ''),
  );
}

export function notifyPositionClosed({ market, reason, pnl }) {
  const emoji = pnl >= 0 ? '✅' : '🔴';
  notify(
    `${emoji} <b>CLOSED</b> ${market}-PERP — ${reason}\n` +
    `PnL: ${sign(pnl)}${fmtUsd(pnl)}`,
  );
}

export function notifyTakeProfit({ market, stage, pnl }) {
  notify(`💰 <b>TAKE PROFIT</b> ${market}-PERP (${stage})\nbanked: ${sign(pnl)}${fmtUsd(pnl)}`);
}

export function notifyFeesClaimed({ token, feesClaimed, txHash }) {
  notify(
    `🪙 <b>FEES CLAIMED</b> ${feesClaimed.toFixed(6)} ETH\n` +
    `token: <code>${token}</code>\n` +
    `<a href="https://robinhoodchain.blockscout.com/tx/${txHash}">tx</a>`,
  );
}

export function notifyBuyback({ token, amountEth, tokensBurned, type }) {
  notify(
    `🔥 <b>BUYBACK & BURN</b> (${type})\n` +
    `${amountEth.toFixed(4)} ETH → ${Math.round(tokensBurned).toLocaleString()} tokens burned\n` +
    `token: <code>${token}</code>`,
  );
}

export function notifyRiskAlert({ market, alert, action }) {
  notify(`⚠️ <b>RISK ALERT</b> ${market}-PERP — ${alert}\naction: ${action}`);
}

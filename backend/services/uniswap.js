import { Contract, parseEther, parseUnits } from 'ethers';
import config from '../config.js';
import logger from '../utils/logger.js';
import { getSigner, getErc20 } from './chain.js';

// ---------------------------------------------------------------------------
// Uniswap service — Robinhood Chain
//
// Pons tokens graduate to locked Uniswap V3 pools paired with WETH, so
// buybacks are ETH → token swaps through the Uniswap V3 SwapRouter02.
// Burns are plain ERC-20 transfers to the dead address (Pons tokens don't
// expose a burn() we can rely on).
// ---------------------------------------------------------------------------

const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD';

const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];

// Pons pools are created at a fixed fee tier; probe the common V3 tiers
const FEE_TIERS = [10000, 3000, 500];

/**
 * Execute an ETH → token swap via Uniswap V3 and return the tx hash.
 *
 * @param {string} tokenAddress — token to buy
 * @param {number} ethAmount — amount of ETH to swap
 */
export async function swapEthForToken(tokenAddress, ethAmount) {
  if (!config.protocolWallet) {
    throw new Error('Protocol wallet not loaded');
  }
  if (!config.UNISWAP_ROUTER) {
    throw new Error('UNISWAP_ROUTER not configured — set it in .env');
  }

  const signer = getSigner();
  const router = new Contract(config.UNISWAP_ROUTER, SWAP_ROUTER_ABI, signer);
  const amountIn = parseEther(ethAmount.toFixed(18));

  let lastErr = null;
  for (const fee of FEE_TIERS) {
    const params = {
      tokenIn: config.PONS.WETH,
      tokenOut: tokenAddress,
      fee,
      recipient: config.PROTOCOL_ADDRESS,
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    };

    try {
      // Static-call first to find the live fee tier without burning gas,
      // then use that quote as a 5% slippage floor so the real swap can't
      // be sandwiched below it.
      const quoted = await router.exactInputSingle.staticCall(params, { value: amountIn });
      const guarded = { ...params, amountOutMinimum: (quoted * 95n) / 100n };
      const resp = await router.exactInputSingle(guarded, { value: amountIn });
      const receipt = await resp.wait();
      logger.info('Uniswap swap executed', {
        tokenAddress, ethAmount, feeTier: fee, hash: receipt.hash,
      });
      return { signature: receipt.hash, outAmount: quoted.toString() };
    } catch (err) {
      lastErr = err;
    }
  }

  logger.error('swapEthForToken failed on all fee tiers', { tokenAddress, error: lastErr?.message });
  throw lastErr || new Error('Swap failed');
}

// ---------------------------------------------------------------------------
// Burn ERC-20 tokens (transfer to dead address)
// ---------------------------------------------------------------------------

/**
 * Burn tokens from the protocol wallet.
 *
 * @param {string} tokenAddress — token contract address
 * @param {number} amount       — UI amount to burn
 * @param {number} decimals     — token decimals (default 18)
 */
export async function burnTokens(tokenAddress, amount, decimals = 18) {
  if (!config.protocolWallet) {
    throw new Error('Protocol wallet not loaded');
  }

  const signer = getSigner();
  const token = getErc20(tokenAddress, signer);
  const rawAmount = parseUnits(amount.toFixed(Math.min(decimals, 18)), decimals);

  const resp = await token.transfer(DEAD_ADDRESS, rawAmount);
  const receipt = await resp.wait();
  logger.info('Tokens burned (sent to dead address)', { tokenAddress, amount, hash: receipt.hash });
  return receipt.hash;
}

// ---------------------------------------------------------------------------
// ETH price in USD (with fallbacks)
// ---------------------------------------------------------------------------

let _ethPriceCache = { price: 0, at: 0 };

export async function getEthPrice() {
  if (_ethPriceCache.price > 0 && Date.now() - _ethPriceCache.at < 60_000) {
    return _ethPriceCache.price;
  }

  // Primary: CoinGecko
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    if (res.ok) {
      const data = await res.json();
      const price = data?.ethereum?.usd || 0;
      if (price > 0) {
        _ethPriceCache = { price, at: Date.now() };
        return price;
      }
    }
  } catch {}

  // Fallback: Binance
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
    if (res.ok) {
      const data = await res.json();
      const price = parseFloat(data?.price) || 0;
      if (price > 0) {
        _ethPriceCache = { price, at: Date.now() };
        return price;
      }
    }
  } catch {}

  logger.error('Failed to fetch ETH price from all sources');
  return _ethPriceCache.price || 0;
}

export { DEAD_ADDRESS };

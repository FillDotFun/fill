import { JsonRpcProvider, Contract, formatEther, formatUnits } from 'ethers';
import config from '../config.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Robinhood Chain provider singleton
// ---------------------------------------------------------------------------
let _provider = null;

export function getProvider() {
  if (!_provider) {
    _provider = new JsonRpcProvider(config.RPC_URL, config.CHAIN_ID, {
      staticNetwork: true,
    });
    logger.info('Robinhood Chain RPC connection created', { rpc: config.RPC_URL, chainId: config.CHAIN_ID });
  }
  return _provider;
}

export function getSigner() {
  if (!config.protocolWallet) {
    throw new Error('Protocol wallet not loaded -- cannot sign transactions');
  }
  return config.protocolWallet.connect(getProvider());
}

// ---------------------------------------------------------------------------
// Balance helpers
// ---------------------------------------------------------------------------
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
];

export async function getEthBalance(address) {
  try {
    const provider = getProvider();
    const wei = await provider.getBalance(address);
    return parseFloat(formatEther(wei));
  } catch (err) {
    logger.error('getEthBalance failed', { error: err.message });
    throw err;
  }
}

export async function getTokenBalance(ownerAddress, tokenAddress) {
  try {
    const provider = getProvider();
    const token = new Contract(tokenAddress, ERC20_ABI, provider);
    const [raw, decimals] = await Promise.all([
      token.balanceOf(ownerAddress),
      token.decimals(),
    ]);
    return parseFloat(formatUnits(raw, decimals));
  } catch (err) {
    logger.error('getTokenBalance failed', { error: err.message });
    throw err;
  }
}

export function getErc20(tokenAddress, signerOrProvider = null) {
  return new Contract(tokenAddress, ERC20_ABI, signerOrProvider || getProvider());
}

// ---------------------------------------------------------------------------
// Transaction helpers
// ---------------------------------------------------------------------------

/**
 * Send a transaction and wait for confirmation.
 * Accepts either a populated tx request ({ to, data, value }) or a
 * contract-method promise that resolves to a TransactionResponse.
 */
export async function sendTx(txRequest) {
  const signer = getSigner();
  try {
    const resp = await signer.sendTransaction(txRequest);
    const receipt = await resp.wait();
    logger.info('Transaction confirmed', { hash: receipt.hash, block: receipt.blockNumber });
    return receipt.hash;
  } catch (err) {
    logger.error('Transaction failed', { error: err.message });
    throw err;
  }
}

/**
 * Fetch recent logs (used by token discovery).
 */
export async function getLogs(filter) {
  const provider = getProvider();
  return provider.getLogs(filter);
}

export { Contract, formatEther, formatUnits };

// ---------------------------------------------------------------------------
// WETH unwrap — Pons pays creator fees in WETH (ERC-20), but everything
// downstream (buyback swaps via msg.value, gas-reserve checks) spends native
// ETH. Unwrapping the full balance is always safe: WETH:ETH is 1:1 and the
// protocol has no reason to hold wrapped ETH.
// ---------------------------------------------------------------------------
const WETH_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function withdraw(uint256 wad)',
];

/**
 * Unwrap the protocol wallet's entire WETH balance to native ETH.
 * @param {number} minEth — skip below this (gas isn't worth dust)
 * @returns {number} amount unwrapped in ETH (0 if skipped)
 */
export async function unwrapAllWeth(minEth = 0.0001) {
  const signer = getSigner();
  const weth = new Contract(config.WETH_ADDRESS, WETH_ABI, signer);
  const raw = await weth.balanceOf(config.PROTOCOL_ADDRESS);
  const balEth = parseFloat(formatEther(raw));
  if (balEth < minEth) return 0;

  const resp = await weth.withdraw(raw);
  const receipt = await resp.wait();
  logger.info('Unwrapped WETH -> native ETH', { amount: balEth.toFixed(6), hash: receipt.hash });
  return balEth;
}

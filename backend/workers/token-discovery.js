import logger from '../utils/logger.js';
import config from '../config.js';
import * as db from '../db/firebase.js';
import { getProvider } from '../services/chain.js';
import { getTokenMetadata, detectLaunchpad } from '../services/pons.js';

/**
 * Scans recent Pons factory launch events for tokens whose creator wallet is
 * the protocol wallet but that aren't registered in the DB yet.
 * Auto-registers any new ones found.
 *
 * The factory emits a launch event per token; we don't rely on the exact
 * event signature — instead we scan factory logs for entries that reference
 * the protocol wallet and pull the token address out of the indexed topics.
 */

// How far back to scan each cycle (~30 min of Robinhood Chain blocks)
const SCAN_BLOCKS = 7200;

export async function discoverNewTokens() {
  logger.info('Running token auto-discovery');

  // The zero address appears in every mint/burn event — never scan with it
  if (!config.PROTOCOL_ADDRESS || /^0x0{40}$/i.test(config.PROTOCOL_ADDRESS)) {
    logger.warn('PROTOCOL_ADDRESS not configured — skipping token discovery');
    return { discovered: 0 };
  }

  try {
    const provider = getProvider();
    const walletTopic = '0x' + config.PROTOCOL_ADDRESS.slice(2).toLowerCase().padStart(64, '0');

    // Get existing tokens
    const existingTokens = await db.getAllTokens();
    const existingAddresses = new Set(
      existingTokens.map(t => (t.id || t.address || '').toLowerCase()),
    );

    const latest = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latest - SCAN_BLOCKS);

    // Factory logs from every supported launchpad in the window
    const factories = Object.values(config.LAUNCHPADS)
      .map(lp => lp.factory)
      .filter(Boolean);
    const logs = [];
    for (const factory of factories) {
      try {
        const batch = await provider.getLogs({ address: factory, fromBlock, toBlock: latest });
        logs.push(...batch);
      } catch (logErr) {
        logger.debug('Factory log scan failed', { factory, error: logErr.message });
      }
    }

    const newAddresses = new Set();

    for (const log of logs) {
      // Only logs that reference the protocol wallet (creator / recipient)
      const mentionsWallet =
        log.topics.some(t => t.toLowerCase() === walletTopic) ||
        log.data.toLowerCase().includes(config.PROTOCOL_ADDRESS.slice(2).toLowerCase());
      if (!mentionsWallet) continue;

      // Pull candidate token addresses out of the indexed topics
      for (const topic of log.topics.slice(1)) {
        if (topic.toLowerCase() === walletTopic) continue;
        // Address-shaped topic: 12 zero bytes then 20 bytes of address
        if (!topic.startsWith('0x000000000000000000000000')) continue;
        const candidate = ('0x' + topic.slice(26)).toLowerCase();
        if (candidate === config.WETH_ADDRESS.toLowerCase()) continue;
        if (candidate === config.FILL_TOKEN_ADDRESS.toLowerCase()) continue;
        if (existingAddresses.has(candidate) || newAddresses.has(candidate)) continue;

        // Confirm it's an ERC-20 contract before registering
        try {
          const code = await provider.getCode(candidate);
          if (code && code !== '0x') newAddresses.add(candidate);
        } catch {}
      }
    }

    if (newAddresses.size === 0) {
      logger.info('No new tokens discovered');
      return { discovered: 0 };
    }

    logger.info('Found new tokens to register', { count: newAddresses.size });

    let registered = 0;
    for (const address of newAddresses) {
      try {
        const meta = await getTokenMetadata(address);
        if (!meta?.symbol) {
          logger.warn('No metadata for discovered token, skipping', { token: address.slice(0, 16) });
          continue;
        }

        const lp = await detectLaunchpad(address);
        const tokenData = {
          address,
          name: meta.name || 'Unknown',
          symbol: meta.symbol || 'UNK',
          image: meta.image || '',
          launchpad: lp?.id || 'pons',
          underlying: config.DEFAULT_MARKET,
          perpsMarket: config.DEFAULT_MARKET,
          provider: 'ostium',
          side: 'long',
          leverage: config.RISK.leverage,
          createdAt: Date.now(),
          status: 'active',
          autoDiscovered: true,
        };

        await db.setToken(address, tokenData);
        registered++;
        logger.info('Auto-registered new token', {
          token: address.slice(0, 16),
          symbol: meta.symbol,
          name: meta.name,
        });
      } catch (e) {
        logger.warn('Failed to auto-register token', { token: address.slice(0, 16), error: e.message });
      }
    }

    logger.info('Token discovery complete', { discovered: newAddresses.size, registered });
    return { discovered: newAddresses.size, registered };
  } catch (err) {
    logger.error('Token discovery failed', { error: err.message });
    throw err;
  }
}

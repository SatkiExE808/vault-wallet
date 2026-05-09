// Tracks pending sends and recent receives per coin and exposes a small
// progress pill (e.g. "Confirming 2/3") rendered next to each asset on
// the Home view. State is persisted in localStorage so it survives reloads.
const TxProgress = (() => {
  const STORE_KEY = 'vault.txProgress.v1';
  const POLL_MS = 20_000;
  // 4-minute incoming-tx sweep cadence. Each tick fans out an history()
  // call per enabled tracked coin (BTC/LTC/DOGE/EVM*) and the public
  // explorers' free tiers throttle aggressively — anything more frequent
  // burns through BlockCypher's 200/h DOGE quota.
  const SCAN_MS = 240_000;
  const MAX_AGE_MS = 24 * 60 * 60 * 1000; // drop entries that never resolve after a day

  // Required confirmations per coin/chain. Tuned for UX, not full-finality.
  const REQUIRED = {
    BTC: 3, LTC: 6, DOGE: 6,
    ETH: 12, BSC: 15, POLYGON: 30, AVALANCHE: 5,
    ARBITRUM: 5, OPTIMISM: 5, BASE: 5,
  };

  // coinId → chain key (matches REQUIRED)
  const COIN_CHAIN = {
    BTC: 'BTC', LTC: 'LTC', DOGE: 'DOGE',
    ETH: 'ETH', USDT_ERC20: 'ETH', USDC_ERC20: 'ETH', DAI: 'ETH',
    BNB: 'BSC', USDT_BEP20: 'BSC', USDC_BEP20: 'BSC',
    POL: 'POLYGON', USDT_POLY: 'POLYGON', USDC_POLY: 'POLYGON',
    AVAX: 'AVALANCHE', USDT_AVAX: 'AVALANCHE', USDC_AVAX: 'AVALANCHE',
    ARB: 'ARBITRUM', ARB_ETH: 'ARBITRUM', USDT_ARB: 'ARBITRUM', USDC_ARB: 'ARBITRUM',
    OP: 'OPTIMISM', OP_ETH: 'OPTIMISM', USDT_OPT: 'OPTIMISM', USDC_OPT: 'OPTIMISM',
    BASE_ETH: 'BASE', USDT_BASE: 'BASE', USDC_BASE: 'BASE',
  };

  // Single RPC per EVM chain — confirmation lookup is non-critical so no fallback.
  const EVM_RPC = {
    ETH:       'https://eth.llamarpc.com',
    BSC:       'https://bsc-dataseed.binance.org/',
    POLYGON:   'https://polygon-rpc.com/',
    AVALANCHE: 'https://api.avax.network/ext/bc/C/rpc',
    ARBITRUM:  'https://arb1.arbitrum.io/rpc',
    OPTIMISM:  'https://mainnet.optimism.io',
    BASE:      'https://mainnet.base.org',
  };

  const MEMPOOL_API = {
    BTC: 'https://blockstream.info/api',
    LTC: 'https://litecoinspace.org/api',
  };

  // entries: array of { coinId, hash, dir, amount, symbol, confs, required, ts, status }
  let entries = load();
  let pollTimer = null;
  let scanTimer = null;
  const subs = new Set();

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      const cutoff = Date.now() - MAX_AGE_MS;
      return Array.isArray(parsed) ? parsed.filter(e => e && e.ts >= cutoff) : [];
    } catch { return []; }
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(entries)); } catch {}
  }

  function notify() { subs.forEach(fn => { try { fn(); } catch {} }); }

  function track(coinId, hash, dir, amount) {
    if (!hash || !COIN_CHAIN[coinId]) return; // unsupported coin (TRX/XMR) — silently skip
    const chain = COIN_CHAIN[coinId];
    const required = REQUIRED[chain] || 6;
    // Replace any prior entry for the same hash on the same coin
    entries = entries.filter(e => !(e.coinId === coinId && e.hash === hash));
    entries.push({
      coinId, hash, dir, amount: amount ?? null,
      confs: 0, required, ts: Date.now(), status: 'pending',
    });
    save();
    notify();
    // Kick an immediate refresh for this entry
    refreshOne(entries[entries.length - 1]).then(notify).catch(() => {});
  }

  function getForCoin(coinId) {
    return entries.filter(e => e.coinId === coinId && e.status !== 'done');
  }

  function clearDone() {
    const before = entries.length;
    entries = entries.filter(e => e.status !== 'done');
    if (entries.length !== before) save();
  }

  // ── Per-coin confirmation lookup ────────────────────────────────────────
  async function getConfirmations(coinId, hash) {
    const chain = COIN_CHAIN[coinId];
    if (chain === 'BTC' || chain === 'LTC') return mempoolConfs(chain, hash);
    if (chain === 'DOGE') return dogeConfs(hash);
    if (EVM_RPC[chain]) return evmConfs(chain, hash);
    return { confs: 0, status: 'pending' };
  }

  async function mempoolConfs(chain, hash) {
    const base = MEMPOOL_API[chain];
    const [statusRes, tipRes] = await Promise.all([
      fetch(`${base}/tx/${hash}/status`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${base}/blocks/tip/height`, { signal: AbortSignal.timeout(8000) }),
    ]);
    if (!statusRes.ok) {
      // 404 → tx unknown to the indexer (still propagating, or wrong network)
      if (statusRes.status === 404) return { confs: 0, status: 'pending' };
      throw new Error(`HTTP ${statusRes.status}`);
    }
    const s = await statusRes.json();
    if (!s.confirmed) return { confs: 0, status: 'pending' };
    const tip = parseInt(await tipRes.text(), 10);
    return { confs: Math.max(1, tip - s.block_height + 1), status: 'confirmed' };
  }

  async function dogeConfs(hash) {
    const r = await fetch(`https://api.blockcypher.com/v1/doge/main/txs/${hash}?limit=1`,
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      if (r.status === 404) return { confs: 0, status: 'pending' };
      throw new Error(`HTTP ${r.status}`);
    }
    const j = await r.json();
    const confs = Number(j.confirmations || 0);
    return { confs, status: confs > 0 ? 'confirmed' : 'pending' };
  }

  async function evmRpc(chain, method, params) {
    const r = await fetch(EVM_RPC[chain], {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'RPC error');
    return j.result;
  }

  async function evmConfs(chain, hash) {
    const [tx, tipHex] = await Promise.all([
      evmRpc(chain, 'eth_getTransactionByHash', [hash]),
      evmRpc(chain, 'eth_blockNumber', []),
    ]);
    if (!tx || tx.blockNumber == null) return { confs: 0, status: 'pending' };
    const tip   = parseInt(tipHex, 16);
    const block = parseInt(tx.blockNumber, 16);
    return { confs: Math.max(1, tip - block + 1), status: 'confirmed' };
  }

  async function refreshOne(entry) {
    try {
      const { confs, status } = await getConfirmations(entry.coinId, entry.hash);
      entry.confs = confs;
      if (confs >= entry.required) entry.status = 'done';
      else entry.status = status;
    } catch { /* leave as-is — try again next tick */ }
  }

  async function refreshAll() {
    if (!entries.length) return;
    const active = entries.filter(e => e.status !== 'done');
    await Promise.all(active.map(refreshOne));
    clearDone();
    save();
    notify();
  }

  // Lightweight history sweep: pick up new pending receives (and any pending
  // sends we missed) by reading each enabled coin's existing history() endpoint.
  async function scanIncoming() {
    if (typeof getActiveCoins !== 'function' || typeof state === 'undefined' || !state.mnemonic) return;
    const coins = getActiveCoins().filter(c => COIN_CHAIN[c.id] && typeof c.history === 'function');
    const known = new Set(entries.map(e => `${e.coinId}:${e.hash.toLowerCase()}`));
    let added = false;
    for (const coin of coins) {
      const addr = state.addresses[coin.id];
      if (!addr || addr === '—') continue;
      try {
        const txs = await coin.history(addr);
        for (const tx of (txs || []).slice(0, 5)) {
          if (!tx || !tx.hash || tx.status !== 'pending') continue;
          const key = `${coin.id}:${String(tx.hash).toLowerCase()}`;
          if (known.has(key)) continue;
          const dir = tx.type === 'send' ? 'send' : 'receive';
          track(coin.id, tx.hash, dir, tx.amount);
          // New incoming tx — notify the user via the inbox.
          if (dir === 'receive' && typeof Inbox !== 'undefined') {
            Inbox.add({
              type: 'receive',
              title: `${coin.symbol} deposit received`,
              network: coin.category,
              subtitle: `Your funds are now ready to use`,
            });
          }
          known.add(key);
          added = true;
        }
      } catch { /* network blip — skip this coin this round */ }
    }
    if (added) notify();
  }

  function start() {
    if (pollTimer) return;
    refreshAll().catch(() => {});
    scanIncoming().catch(() => {});
    pollTimer = setInterval(() => refreshAll().catch(() => {}), POLL_MS);
    scanTimer = setInterval(() => scanIncoming().catch(() => {}), SCAN_MS);
  }

  function stop() {
    clearInterval(pollTimer); pollTimer = null;
    clearInterval(scanTimer); scanTimer = null;
  }

  function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

  return { track, getForCoin, start, stop, subscribe, refreshAll };
})();

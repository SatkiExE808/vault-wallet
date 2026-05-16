const BitcoinWallet = (() => {
  const API = 'https://blockstream.info/api';

  // ── Multi-address (BIP84) state ──────────────────────────────
  // localStorage `vault.btc.nextIndex` = number of receive addresses the user
  // has generated so far. When scanning balance, we always look at
  // [0, nextIndex + GAP) so funds sent to a slightly-ahead address (e.g.
  // by importing into another wallet) still show up.
  const NEXT_IDX_KEY = 'vault.btc.nextIndex';
  const GAP = 20;

  function getNextIndex() {
    const v = parseInt(localStorage.getItem(NEXT_IDX_KEY) || '0', 10);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  }
  function setNextIndex(n) { localStorage.setItem(NEXT_IDX_KEY, String(n)); }
  function scanCount() { return Math.max(getNextIndex() + 1, GAP); }
  function generateNewAddress() { setNextIndex(getNextIndex() + 1); }

  async function _fetchAddressInfo(addr) {
    try {
      const r = await fetch(`${API}/address/${addr}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return { balanceSat: 0, txCount: 0 };
      const d = await r.json();
      const balanceSat = (d.chain_stats?.funded_txo_sum || 0) - (d.chain_stats?.spent_txo_sum || 0);
      const txCount    = (d.chain_stats?.tx_count       || 0) + (d.mempool_stats?.tx_count || 0);
      return { balanceSat, txCount };
    } catch { return { balanceSat: 0, txCount: 0 }; }
  }

  // Balance: sum across the full scan window [0, nextIndex + GAP).
  // We can't derive without the mnemonic, so the caller passes the
  // pre-derived address list. Falls back to single-address lookup
  // for backward compat when called with a string.
  async function getBalance(addressOrList) {
    if (typeof addressOrList === 'string') {
      const info = await _fetchAddressInfo(addressOrList);
      return (info.balanceSat / 1e8).toFixed(8);
    }
    const infos = await Promise.all(addressOrList.map(_fetchAddressInfo));
    const sat = infos.reduce((s, x) => s + x.balanceSat, 0);
    return (sat / 1e8).toFixed(8);
  }

  // Returns the active "fresh receive" address — the highest-index derived.
  async function deriveAddress(mnemonic) {
    try { return await UTXOCrypto.deriveP2WPKH(mnemonic, 0, 'bc', getNextIndex()); }
    catch(e) { console.error('BTC derive:', e); return null; }
  }

  // Returns all addresses in the scan window [0, scanCount).
  async function deriveAllAddresses(mnemonic) {
    try {
      const list = await UTXOCrypto.deriveP2WPKHList(mnemonic, 0, 'bc', scanCount());
      return list.map(a => a.address);
    } catch(e) { console.error('BTC derive list:', e); return []; }
  }

  async function sendBTC(mnemonic, toAddress, amountBTC) {
    return UTXOCrypto.buildAndSendP2WPKHMulti({
      mnemonic, coinType: 0, hrp: 'bc',
      count: scanCount(),
      toAddress, amount: amountBTC,
      fetchUTXOs: async addr => {
        const r = await fetch(`${API}/address/${addr}/utxo`, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error('Failed to fetch UTXOs');
        const utxos = await r.json();
        // Skip unconfirmed UTXOs — spending unconfirmed change can produce
        // 'missing inputs' rejections if the parent tx hasn't propagated.
        return utxos.filter(u => u.status?.confirmed === true);
      },
      getFeeRate: async () => {
        try {
          const f = await fetch('https://mempool.space/api/v1/fees/recommended',
            { signal: AbortSignal.timeout(10000) }).then(r => r.json());
          // Coerce + sanity-clamp: a non-number from the API (string,
          // null, undefined) used to propagate NaN through Math.ceil
          // and crash the BigInt fee math in writeLE64 (L-T2).
          const raw = Number(f?.halfHourFee);
          const rate = Number.isFinite(raw) && raw > 0 ? raw : 5;
          return Math.min(500, Math.max(1, rate));
        }
        catch { return 5; }
      },
      broadcastTx: async hex => {
        const r = await fetch(`${API}/tx`, { method: 'POST', body: hex });
        if (!r.ok) throw new Error('Broadcast failed: ' + await r.text());
        return r.text();
      },
    });
  }

  async function getHistory(addressOrList) {
    const addrs = typeof addressOrList === 'string' ? [addressOrList] : addressOrList;
    const set = new Set(addrs);
    const allTxs = (await Promise.all(addrs.map(async a => {
      const r = await fetch(`https://mempool.space/api/address/${a}/txs`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return [];
      return r.json();
    }))).flat();
    // Dedupe by txid (same tx can touch multiple of our addresses)
    const seen = new Set();
    const unique = [];
    for (const tx of allTxs) {
      if (seen.has(tx.txid)) continue;
      seen.add(tx.txid); unique.push(tx);
    }
    return unique
      .sort((a, b) => (b.status?.block_time || 0) - (a.status?.block_time || 0))
      .slice(0, 25)
      .map(tx => {
        const recv  = tx.vout.filter(o => set.has(o.scriptpubkey_address)).reduce((s, o) => s + o.value, 0);
        const spent = tx.vin.filter(i => set.has(i.prevout?.scriptpubkey_address)).reduce((s, i) => s + i.prevout.value, 0);
        const isSend = spent > 0;
        const amount = isSend ? spent - recv : recv;
        return {
          hash: tx.txid, type: isSend ? 'send' : 'receive',
          amount: (Math.abs(amount) / 1e8).toFixed(8),
          time: tx.status.block_time ? tx.status.block_time * 1000 : null,
          confirmed: tx.status.confirmed,
          status: tx.status.confirmed ? 'ok' : 'pending',
          explorerUrl: `https://mempool.space/tx/${tx.txid}`,
        };
      });
  }

  return {
    getBalance, deriveAddress, deriveAllAddresses,
    sendBTC, getHistory,
    getNextIndex, generateNewAddress, scanCount,
  };
})();

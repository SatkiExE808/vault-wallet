const LitecoinWallet = (() => {
  const API = 'https://litecoinspace.org/api';

  const NEXT_IDX_KEY = 'vault.ltc.nextIndex';
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
      if (!r.ok) return { balanceSat: 0 };
      const d = await r.json();
      return { balanceSat: (d.chain_stats?.funded_txo_sum || 0) - (d.chain_stats?.spent_txo_sum || 0) };
    } catch { return { balanceSat: 0 }; }
  }

  async function getBalance(addressOrList) {
    if (typeof addressOrList === 'string') {
      const info = await _fetchAddressInfo(addressOrList);
      return (info.balanceSat / 1e8).toFixed(8);
    }
    const infos = await Promise.all(addressOrList.map(_fetchAddressInfo));
    const sat = infos.reduce((s, x) => s + x.balanceSat, 0);
    return (sat / 1e8).toFixed(8);
  }

  async function deriveAddress(mnemonic) {
    try { return await UTXOCrypto.deriveP2WPKH(mnemonic, 2, 'ltc', getNextIndex()); }
    catch(e) { console.error('LTC derive:', e); return null; }
  }

  async function deriveAllAddresses(mnemonic) {
    try {
      const list = await UTXOCrypto.deriveP2WPKHList(mnemonic, 2, 'ltc', scanCount());
      return list.map(a => a.address);
    } catch(e) { console.error('LTC derive list:', e); return []; }
  }

  async function sendLTC(mnemonic, toAddress, amountLTC) {
    return UTXOCrypto.buildAndSendP2WPKHMulti({
      mnemonic, coinType: 2, hrp: 'ltc',
      count: scanCount(),
      toAddress, amount: amountLTC,
      fetchUTXOs: async addr => {
        const r = await fetch(`${API}/address/${addr}/utxo`, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error('Failed to fetch UTXOs');
        const utxos = await r.json();
        return utxos.filter(u => u.status?.confirmed === true);
      },
      getFeeRate: async () => {
        try {
          const f = await fetch(`${API}/v1/fees/recommended`,
            { signal: AbortSignal.timeout(10000) }).then(r => r.json());
          return Math.min(500, Math.max(1, f.halfHourFee || 1));
        }
        catch { return 1; }
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
      const r = await fetch(`${API}/address/${a}/txs`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return [];
      return r.json();
    }))).flat();
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
          explorerUrl: `https://litecoinspace.org/tx/${tx.txid}`,
        };
      });
  }

  return {
    getBalance, deriveAddress, deriveAllAddresses,
    sendLTC, getHistory,
    getNextIndex, generateNewAddress, scanCount,
  };
})();

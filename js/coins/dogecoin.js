const DogecoinWallet = (() => {
  const API = 'https://api.blockcypher.com/v1/doge/main';

  // DOGE uses legacy P2PKH (BIP44), no SegWit. Same multi-address pattern
  // as BTC/LTC but signing path goes through buildAndSendTxMulti.
  const NEXT_IDX_KEY = 'vault.doge.nextIndex';
  const GAP = 20;
  function getNextIndex() {
    const v = parseInt(localStorage.getItem(NEXT_IDX_KEY) || '0', 10);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  }
  function setNextIndex(n) { localStorage.setItem(NEXT_IDX_KEY, String(n)); }
  function scanCount() { return Math.max(getNextIndex() + 1, GAP); }
  function generateNewAddress() { setNextIndex(getNextIndex() + 1); }

  async function _fetchBalanceSat(addr) {
    try {
      const r = await fetch(`${API}/addrs/${addr}/balance`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return 0;
      const d = await r.json();
      return d.balance ?? 0;
    } catch { return 0; }
  }

  async function getBalance(addressOrList) {
    if (typeof addressOrList === 'string') {
      const sat = await _fetchBalanceSat(addressOrList);
      return (sat / 1e8).toFixed(8);
    }
    // BlockCypher free tier is 200 req/hour. Scanning 20 addresses every
    // refresh would burn through that fast — so we serialize the requests
    // with a tiny delay rather than blasting in parallel. Acceptable since
    // most users will have funds in the first few indices.
    let total = 0;
    for (const a of addressOrList) {
      total += await _fetchBalanceSat(a);
      await new Promise(r => setTimeout(r, 60));
    }
    return (total / 1e8).toFixed(8);
  }

  async function deriveAddress(mnemonic) {
    try { return await UTXOCrypto.deriveP2PKH(mnemonic, 3, 0x1e, getNextIndex()); }
    catch(e) { console.error('DOGE derive:', e); return null; }
  }

  async function deriveAllAddresses(mnemonic) {
    try {
      const list = await UTXOCrypto.deriveP2PKHList(mnemonic, 3, 0x1e, scanCount());
      return list.map(a => a.address);
    } catch(e) { console.error('DOGE derive list:', e); return []; }
  }

  async function sendDOGE(mnemonic, toAddress, amountDOGE) {
    return UTXOCrypto.buildAndSendTxMulti({
      mnemonic, coinType: 3, versionByte: 0x1e, bech32Prefix: null,
      count: scanCount(),
      toAddress, amount: amountDOGE,
      fetchUTXOs: async addr => {
        const r = await fetch(`${API}/addrs/${addr}?unspentOnly=true&confirmations=1`, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error('Failed to fetch UTXOs');
        const d = await r.json();
        return (d.txrefs || [])
          .filter(u => Number(u.confirmations || 0) >= 1)
          .map(u => ({ txid: u.tx_hash, vout: u.tx_output_n, value: u.value }));
      },
      getFeeRate: async () => {
        try {
          const d = await fetch(API, { signal: AbortSignal.timeout(10000) }).then(r => r.json());
          const satPerKb = d.medium_fee_per_kb || 1000;
          return Math.min(5000, Math.max(1, Math.ceil(satPerKb / 1000)));
        } catch { return 1; }
      },
      broadcastTx: async hex => {
        const r = await fetch(`${API}/txs/push`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tx: hex }),
          signal: AbortSignal.timeout(20000),
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        return d.tx?.hash;
      },
    });
  }

  async function getHistory(addressOrList) {
    const addrs = typeof addressOrList === 'string' ? [addressOrList] : addressOrList;
    const set = new Set(addrs);
    const all = [];
    for (const a of addrs) {
      try {
        const r = await fetch(`${API}/addrs/${a}/full?limit=20`, { signal: AbortSignal.timeout(10000) });
        if (r.ok) {
          const d = await r.json();
          all.push(...(d.txs || []));
        }
      } catch {}
      await new Promise(r => setTimeout(r, 60));
    }
    const seen = new Set();
    const unique = [];
    for (const tx of all) {
      if (seen.has(tx.hash)) continue;
      seen.add(tx.hash); unique.push(tx);
    }
    return unique
      .sort((a, b) => (b.confirmed ? new Date(b.confirmed).getTime() : 0) - (a.confirmed ? new Date(a.confirmed).getTime() : 0))
      .slice(0, 25)
      .map(tx => {
        const recv   = (tx.outputs || []).filter(o => o.addresses?.some(a => set.has(a))).reduce((s, o) => s + (o.value || 0), 0);
        const spent  = (tx.inputs  || []).filter(i => i.addresses?.some(a => set.has(a))).reduce((s, i) => s + (i.output_value || 0), 0);
        const isSend = spent > 0;
        const amount = isSend ? spent - recv : recv;
        return {
          hash: tx.hash, type: isSend ? 'send' : 'receive',
          amount: (Math.abs(amount) / 1e8).toFixed(8),
          time: tx.confirmed ? new Date(tx.confirmed).getTime() : null,
          confirmed: !!tx.confirmed,
          status: tx.confirmed ? 'ok' : 'pending',
          explorerUrl: `https://dogechain.info/tx/${tx.hash}`,
        };
      });
  }

  return {
    getBalance, deriveAddress, deriveAllAddresses,
    sendDOGE, getHistory,
    getNextIndex, generateNewAddress, scanCount,
  };
})();

const DogecoinWallet = (() => {
  const API = 'https://api.blockcypher.com/v1/doge/main';

  async function getBalance(address) {
    try {
      const r = await fetch(`${API}/addrs/${address}/balance`);
      const d = await r.json();
      return ((d.balance ?? 0) / 1e8).toFixed(8);
    } catch { return '0.00000000'; }
  }

  async function deriveAddress(mnemonic) {
    try { return await UTXOCrypto.deriveP2PKH(mnemonic, 3, 0x1e); }
    catch(e) { console.error('DOGE derive:', e); return null; }
  }

  async function sendDOGE(mnemonic, toAddress, amountDOGE) {
    return UTXOCrypto.buildAndSendTx({
      mnemonic, coinType: 3, versionByte: 0x1e, bech32Prefix: null,
      toAddress, amount: amountDOGE,
      fetchUTXOs: async addr => {
        const r = await fetch(`${API}/addrs/${addr}?unspentOnly=true`);
        if (!r.ok) throw new Error('Failed to fetch UTXOs');
        const d = await r.json();
        return (d.txrefs || []).map(u => ({ txid: u.tx_hash, vout: u.tx_output_n, value: u.value }));
      },
      getFeeRate: async () => {
        // BlockCypher returns medium_fee_per_kb in sat/kB; UTXO builder expects sat/byte.
        // DOGE network minimum is 1000 sat/kB == 1 sat/byte.
        try {
          const d = await fetch(API).then(r => r.json());
          const satPerKb = d.medium_fee_per_kb || 1000;
          return Math.max(1, Math.ceil(satPerKb / 1000));
        } catch { return 1; }
      },
      broadcastTx: async hex => {
        const r = await fetch(`${API}/txs/push`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tx: hex }),
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        return d.tx?.hash;
      },
    });
  }

  async function getHistory(address) {
    const r = await fetch(`${API}/addrs/${address}/full?limit=20`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('API error');
    const d = await r.json();
    return (d.txs || []).map(tx => {
      const recv   = (tx.outputs || []).filter(o => o.addresses?.includes(address)).reduce((s, o) => s + (o.value || 0), 0);
      const spent  = (tx.inputs  || []).filter(i => i.addresses?.includes(address)).reduce((s, i) => s + (i.output_value || 0), 0);
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

  return { getBalance, deriveAddress, sendDOGE, getHistory };
})();

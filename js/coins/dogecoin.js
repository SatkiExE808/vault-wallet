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
      toAddress, amountFloat: parseFloat(amountDOGE),
      fetchUTXOs: async addr => {
        const r = await fetch(`${API}/addrs/${addr}?unspentOnly=true`);
        if (!r.ok) throw new Error('Failed to fetch UTXOs');
        const d = await r.json();
        return (d.txrefs || []).map(u => ({ txid: u.tx_hash, vout: u.tx_output_n, value: u.value }));
      },
      getFeeRate: async () => 1000, // 0.01 DOGE/kB standard minimum
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

  return { getBalance, deriveAddress, sendDOGE };
})();

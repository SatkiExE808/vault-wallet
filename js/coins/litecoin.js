const LitecoinWallet = (() => {
  const API = 'https://litecoinspace.org/api';

  async function getBalance(address) {
    try {
      const r = await fetch(`${API}/address/${address}`);
      const d = await r.json();
      return ((d.chain_stats.funded_txo_sum - d.chain_stats.spent_txo_sum) / 1e8).toFixed(8);
    } catch { return '0.00000000'; }
  }

  async function deriveAddress(mnemonic) {
    try { return await UTXOCrypto.deriveP2WPKH(mnemonic, 2, 'ltc'); }
    catch(e) { console.error('LTC derive:', e); return null; }
  }

  async function sendLTC(mnemonic, toAddress, amountLTC) {
    return UTXOCrypto.buildAndSendP2WPKH({
      mnemonic, coinType: 2, hrp: 'ltc',
      toAddress, amountFloat: parseFloat(amountLTC),
      fetchUTXOs: async addr => {
        const r = await fetch(`${API}/address/${addr}/utxo`);
        if (!r.ok) throw new Error('Failed to fetch UTXOs');
        return r.json();
      },
      getFeeRate: async () => {
        try { const f = await fetch(`${API}/v1/fees/recommended`).then(r => r.json()); return Math.max(1, f.halfHourFee || 1); }
        catch { return 1; }
      },
      broadcastTx: async hex => {
        const r = await fetch(`${API}/tx`, { method: 'POST', body: hex });
        if (!r.ok) throw new Error('Broadcast failed: ' + await r.text());
        return r.text();
      },
    });
  }

  return { getBalance, deriveAddress, sendLTC };
})();

const BitcoinWallet = (() => {
  const API = 'https://blockstream.info/api';

  async function getBalance(address) {
    try {
      const r = await fetch(`${API}/address/${address}`);
      const d = await r.json();
      return ((d.chain_stats.funded_txo_sum - d.chain_stats.spent_txo_sum) / 1e8).toFixed(8);
    } catch { return '0.00000000'; }
  }

  async function deriveAddress(mnemonic) {
    try { return await UTXOCrypto.deriveP2WPKH(mnemonic, 0, 'bc'); }
    catch(e) { console.error('BTC derive:', e); return null; }
  }

  async function sendBTC(mnemonic, toAddress, amountBTC) {
    return UTXOCrypto.buildAndSendP2WPKH({
      mnemonic, coinType: 0, hrp: 'bc',
      toAddress, amount: amountBTC,
      fetchUTXOs: async addr => {
        const r = await fetch(`${API}/address/${addr}/utxo`);
        if (!r.ok) throw new Error('Failed to fetch UTXOs');
        return r.json();
      },
      getFeeRate: async () => {
        try { const f = await fetch('https://mempool.space/api/v1/fees/recommended').then(r => r.json()); return Math.max(1, f.halfHourFee || 5); }
        catch { return 5; }
      },
      broadcastTx: async hex => {
        const r = await fetch(`${API}/tx`, { method: 'POST', body: hex });
        if (!r.ok) throw new Error('Broadcast failed: ' + await r.text());
        return r.text();
      },
    });
  }

  async function getHistory(address) {
    const r = await fetch(`https://mempool.space/api/address/${address}/txs`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('API error');
    const txs = await r.json();
    return txs.slice(0, 25).map(tx => {
      const recv     = tx.vout.filter(o => o.scriptpubkey_address === address).reduce((s, o) => s + o.value, 0);
      const spent    = tx.vin.filter(i => i.prevout?.scriptpubkey_address === address).reduce((s, i) => s + i.prevout.value, 0);
      const isSend   = spent > 0;
      // For sends, show outgoing amount (excluding change back to self).
      const amount   = isSend ? spent - recv : recv;
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

  return { getBalance, deriveAddress, sendBTC, getHistory };
})();

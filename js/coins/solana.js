// Solana support — keys are ed25519 (not secp256k1), so derivation goes
// through SLIP-0010 instead of BIP32, but the Phantom-compatible BIP44
// path m/44'/501'/0'/0' is otherwise standard.
const SolanaWallet = (() => {
  const RPCS = [
    'https://api.mainnet-beta.solana.com',
    'https://solana-rpc.publicnode.com',
  ];

  function hexToBytes(hex) {
    if (hex.startsWith('0x')) hex = hex.slice(2);
    const out = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  async function hmacSha512(key, data) {
    const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
  }

  // SLIP-0010 ed25519 derivation. All path segments must be hardened.
  async function deriveEd25519Seed(mnemonic) {
    const seedHex = ethers.Mnemonic.fromPhrase(mnemonic).computeSeed();
    const seed = hexToBytes(seedHex);
    const masterKey = new TextEncoder().encode('ed25519 seed');
    let i = await hmacSha512(masterKey, seed);
    let k = i.slice(0, 32);
    let c = i.slice(32, 64);
    for (const idx of [44, 501, 0, 0]) {
      const hardened = (idx | 0x80000000) >>> 0;
      const data = new Uint8Array(37);
      data[0] = 0;
      data.set(k, 1);
      data[33] = (hardened >>> 24) & 0xff;
      data[34] = (hardened >>> 16) & 0xff;
      data[35] = (hardened >>> 8) & 0xff;
      data[36] = hardened & 0xff;
      const out = await hmacSha512(c, data);
      k = out.slice(0, 32);
      c = out.slice(32, 64);
    }
    return k;
  }

  async function deriveKeypair(mnemonic) {
    const seed = await deriveEd25519Seed(mnemonic);
    return solanaWeb3.Keypair.fromSeed(seed);
  }

  async function deriveAddress(mnemonic) {
    try {
      const kp = await deriveKeypair(mnemonic);
      return kp.publicKey.toBase58();
    } catch (e) { console.error('SOL derive:', e); return null; }
  }

  async function rpcCall(method, params) {
    let lastErr;
    for (const url of RPCS) {
      try {
        const r = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) { lastErr = new Error(`HTTP ${r.status}`); continue; }
        const j = await r.json();
        if (j.error) { lastErr = new Error(j.error.message || 'RPC error'); continue; }
        return j.result;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('All Solana RPCs failed');
  }

  async function getBalance(address) {
    try {
      const res = await rpcCall('getBalance', [address]);
      const lamports = (res && typeof res === 'object' ? res.value : res) || 0;
      return (lamports / solanaWeb3.LAMPORTS_PER_SOL).toFixed(6);
    } catch { return '0.000000'; }
  }

  async function sendSOL(mnemonic, to, amount) {
    const kp = await deriveKeypair(mnemonic);
    const conn = new solanaWeb3.Connection(RPCS[0], 'confirmed');
    const lamports = Math.floor(Number(amount) * solanaWeb3.LAMPORTS_PER_SOL);
    if (!Number.isFinite(lamports) || lamports <= 0) throw new Error('Invalid amount');
    const tx = new solanaWeb3.Transaction().add(
      solanaWeb3.SystemProgram.transfer({
        fromPubkey: kp.publicKey,
        toPubkey: new solanaWeb3.PublicKey(to),
        lamports,
      })
    );
    tx.feePayer = kp.publicKey;
    const { blockhash } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(kp);
    return await conn.sendRawTransaction(tx.serialize());
  }

  async function getHistory(address) {
    try {
      const sigs = await rpcCall('getSignaturesForAddress', [address, { limit: 10 }]);
      if (!sigs || !sigs.length) return [];
      const details = await Promise.allSettled(sigs.map(s =>
        rpcCall('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }])
      ));
      const out = [];
      for (let i = 0; i < sigs.length; i++) {
        const s = sigs[i];
        const d = details[i].status === 'fulfilled' ? details[i].value : null;
        let type = 'send', amount = '—';
        if (d && d.meta && d.transaction) {
          const keys = d.transaction.message.accountKeys || [];
          const idx = keys.findIndex(k => (typeof k === 'string' ? k : k?.pubkey) === address);
          if (idx >= 0) {
            const delta = (d.meta.postBalances[idx] - d.meta.preBalances[idx]) / solanaWeb3.LAMPORTS_PER_SOL;
            type = delta < 0 ? 'send' : 'receive';
            amount = Math.abs(delta).toFixed(6);
          }
        }
        out.push({
          hash: s.signature,
          type, amount,
          time: s.blockTime ? s.blockTime * 1000 : null,
          confirmed: !s.err,
          status: s.err ? 'error' : 'ok',
          explorerUrl: `https://solscan.io/tx/${s.signature}`,
        });
      }
      return out;
    } catch { return []; }
  }

  return { deriveAddress, getBalance, sendSOL, getHistory };
})();

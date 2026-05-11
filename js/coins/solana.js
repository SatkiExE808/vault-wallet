// Solana support — keys are ed25519 (not secp256k1), so derivation goes
// through SLIP-0010 instead of BIP32, but the Phantom-compatible BIP44
// path m/44'/501'/0'/0' is otherwise standard.
const SolanaWallet = (() => {
  const RPCS = [
    'https://solana-rpc.publicnode.com',
    'https://api.mainnet-beta.solana.com',
    'https://rpc.ankr.com/solana',
    'https://solana.api.onfinality.io/public',
  ];

  // Build a Connection backed by the first RPC that actually responds.
  // The hardcoded `new Connection(RPCS[0], …)` pattern used to throw
  // "failed to get recent blockhash: 403 Access forbidden" whenever the
  // first endpoint (api.mainnet-beta) rate-limited the caller — staking
  // and JupSOL swaps would crash even though sendSOL's rpcCall() loop
  // had a perfectly working fallback.
  async function _conn() {
    let lastErr;
    for (const url of RPCS) {
      try {
        const c = new solanaWeb3.Connection(url, 'confirmed');
        // Probe with a lightweight call so we discover dead/limited
        // endpoints before signing a transaction with them.
        await c.getLatestBlockhash();
        return c;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error('All Solana RPC endpoints failed: ' + (lastErr?.message || lastErr));
  }

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
    // 2nd arg is the BIP39 passphrase ("25th word"); '' = standard derivation.
    const passphrase = (typeof window !== 'undefined' && window.getPassphrase) ? window.getPassphrase() : '';
    const seedHex = ethers.Mnemonic.fromPhrase(mnemonic, passphrase).computeSeed();
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
        if (!r.ok) { lastErr = new Error(`HTTP ${r.status} from ${new URL(url).host}`); continue; }
        const j = await r.json();
        if (j.error) {
          lastErr = new Error(j.error.message || 'RPC error');
          // Application-layer error (method-not-supported, rate limit, etc.)
          // — try the next endpoint.
          continue;
        }
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
    const conn = await _conn();
    const lamports = Math.floor(Number(amount) * solanaWeb3.LAMPORTS_PER_SOL);
    if (!Number.isFinite(lamports) || lamports <= 0) throw new Error('Invalid amount');
    const toPk = new solanaWeb3.PublicKey(to);
    // Sending SOL to a PDA (off-curve key) is permanent loss. validateAddress
    // already enforces this for the UI flow; this guard catches any future
    // programmatic caller that bypasses it.
    if (!solanaWeb3.PublicKey.isOnCurve(toPk.toBytes())) {
      throw new Error('Recipient is not a valid SOL account (off-curve / PDA)');
    }
    const tx = new solanaWeb3.Transaction().add(
      solanaWeb3.SystemProgram.transfer({
        fromPubkey: kp.publicKey,
        toPubkey: toPk,
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

  // ── Native staking ───────────────────────────────────────────────────
  // Stake account size is 200 bytes; rent reserve sits on top of the staked
  // amount and is recoverable on full withdraw.
  const STAKE_SPACE = 200;

  async function getStakeRent() {
    return await rpcCall('getMinimumBalanceForRentExemption', [STAKE_SPACE]);
  }

  // Lists stake accounts where the user is the withdraw authority.
  async function getStakeAccounts(address) {
    try {
      // The withdraw authority lives at offset 44 inside the parsed stake account
      // data; using getProgramAccounts with a memcmp filter is the standard pattern.
      const res = await rpcCall('getProgramAccounts', [
        solanaWeb3.StakeProgram.programId.toBase58(),
        {
          encoding: 'jsonParsed',
          filters: [
            { memcmp: { offset: 44, bytes: address } },
          ],
        },
      ]);
      const epoch = await rpcCall('getEpochInfo', []);
      const currentEpoch = epoch?.epoch ?? 0;
      return (res || []).map(a => {
        const info     = a.account?.data?.parsed?.info || {};
        const stake    = info.stake?.delegation;
        const lamports = a.account?.lamports ?? 0;
        const sol      = (lamports / solanaWeb3.LAMPORTS_PER_SOL).toFixed(6);
        const validator = stake?.voter || null;
        // Compare epochs as BigInt to safely handle Solana's u64::MAX
        // sentinel ('18446744073709551615'), which loses precision when
        // coerced through Number().
        let state = 'inactive';
        if (stake) {
          const tip = BigInt(currentEpoch);
          const act = BigInt(stake.activationEpoch ?? '0');
          const deact = BigInt(stake.deactivationEpoch ?? '0');
          const NEVER = (1n << 64n) - 1n;
          const isDeactivated = deact !== NEVER && deact < tip;
          const isDeactivating = deact !== NEVER && deact === tip;
          const isActivating = act > tip;
          if      (isDeactivated)  state = 'inactive';
          else if (isDeactivating) state = 'deactivating';
          else if (isActivating)   state = 'activating';
          else                     state = 'active';
        }
        return { pubkey: a.pubkey, lamports, sol, validator, state };
      });
    } catch { return []; }
  }

  // Vote program ID (canonical Solana vote program owner of every vote account)
  const VOTE_PROGRAM_ID = 'Vote111111111111111111111111111111111111111';

  // Verify the address is a real vote account before delegating to it.
  // Without this, a typo (or a token-mint pubkey copy/paste) creates a
  // stake account that can't earn rewards and requires a deactivate +
  // re-delegate cycle to recover.
  async function assertIsVoteAccount(votePubkey) {
    const info = await rpcCall('getAccountInfo', [votePubkey, { encoding: 'base64' }]);
    if (!info || !info.value) throw new Error('Validator address has no on-chain account');
    if (info.value.owner !== VOTE_PROGRAM_ID) {
      throw new Error('Address is not a vote account (wrong program owner)');
    }
  }

  // Look up validator metadata (name, logo, website) from the Stakewiz
  // public API. Cached in localStorage for 24h so repeat modal opens
  // don't hammer the API (and so the modal still shows names offline).
  async function getValidatorInfo(voteAddress) {
    if (!voteAddress) return null;
    const cacheKey = `vault.sol.validator.${voteAddress}`;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached.ts && Date.now() - cached.ts < 86400000) return cached.data;
      }
    } catch {}
    try {
      const r = await fetch(`https://api.stakewiz.com/validator/${voteAddress}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return null;
      const d = await r.json();
      const data = {
        name:    d.name || null,
        image:   d.image || null,
        website: d.website || null,
        apy:     typeof d.apy_estimate === 'number' ? d.apy_estimate : null,
      };
      try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data })); } catch {}
      return data;
    } catch { return null; }
  }

  // Batched last-epoch reward lookup for stake accounts. Unlike
  // getProgramAccounts, this method (getInflationReward) is supported by
  // most public RPCs. Returns parallel-indexed lamports — 0 when the
  // call fails or the account didn't earn anything yet.
  async function getLastEpochRewards(stakeAccountAddresses) {
    if (!stakeAccountAddresses || !stakeAccountAddresses.length) return [];
    try {
      const res = await rpcCall('getInflationReward', [stakeAccountAddresses]);
      return (res || []).map(r => (r && r.amount != null) ? Number(r.amount) : 0);
    } catch {
      return new Array(stakeAccountAddresses.length).fill(0);
    }
  }

  async function stakeSOL(mnemonic, validatorVoteAddress, amount) {
    await assertIsVoteAccount(validatorVoteAddress);
    const kp = await deriveKeypair(mnemonic);
    const conn = await _conn();
    const lamports = Math.floor(Number(amount) * solanaWeb3.LAMPORTS_PER_SOL);
    if (!Number.isFinite(lamports) || lamports <= 0) throw new Error('Invalid amount');
    const rent = await getStakeRent();
    const stakeAccount = solanaWeb3.Keypair.generate();
    const totalLamports = lamports + rent;
    const tx = new solanaWeb3.Transaction()
      .add(solanaWeb3.StakeProgram.createAccount({
        fromPubkey: kp.publicKey,
        stakePubkey: stakeAccount.publicKey,
        authorized: new solanaWeb3.Authorized(kp.publicKey, kp.publicKey),
        lockup: new solanaWeb3.Lockup(0, 0, kp.publicKey),
        lamports: totalLamports,
      }))
      .add(solanaWeb3.StakeProgram.delegate({
        stakePubkey: stakeAccount.publicKey,
        authorizedPubkey: kp.publicKey,
        votePubkey: new solanaWeb3.PublicKey(validatorVoteAddress),
      }));
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(kp, stakeAccount);
    return await conn.sendRawTransaction(tx.serialize());
  }

  async function deactivateStake(mnemonic, stakeAccountAddress) {
    const kp = await deriveKeypair(mnemonic);
    const conn = await _conn();
    const tx = new solanaWeb3.Transaction().add(
      solanaWeb3.StakeProgram.deactivate({
        stakePubkey: new solanaWeb3.PublicKey(stakeAccountAddress),
        authorizedPubkey: kp.publicKey,
      })
    );
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(kp);
    return await conn.sendRawTransaction(tx.serialize());
  }

  async function withdrawStake(mnemonic, stakeAccountAddress) {
    const kp = await deriveKeypair(mnemonic);
    const conn = await _conn();
    const stakePk = new solanaWeb3.PublicKey(stakeAccountAddress);
    const accInfo = await conn.getAccountInfo(stakePk);
    if (!accInfo) throw new Error('Stake account not found');
    const tx = new solanaWeb3.Transaction().add(
      solanaWeb3.StakeProgram.withdraw({
        stakePubkey: stakePk,
        authorizedPubkey: kp.publicKey,
        toPubkey: kp.publicKey,
        lamports: accInfo.lamports,
      })
    );
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(kp);
    return await conn.sendRawTransaction(tx.serialize());
  }

  // ── Liquid staking via Jupiter (JupSOL) ─────────────────────────────
  // We swap through Jupiter's aggregator instead of calling the stake-pool
  // deposit/withdraw instructions directly — this lets the user enter and
  // exit the position instantly with no setup.
  const JUPSOL_MINT = 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v';
  const SOL_MINT    = 'So11111111111111111111111111111111111111112';
  const JUP_API     = 'https://quote-api.jup.ag/v6';

  async function getJupSolBalance(address) {
    try {
      const res = await rpcCall('getTokenAccountsByOwner', [
        address,
        { mint: JUPSOL_MINT },
        { encoding: 'jsonParsed' },
      ]);
      const accounts = res?.value || [];
      let total = 0;
      for (const a of accounts) {
        total += Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
      }
      return total.toFixed(6);
    } catch { return '0.000000'; }
  }

  // Returns SOL equivalent of 1 JupSOL via a quick Jupiter quote.
  async function getJupSolRate() {
    try {
      const r = await fetch(`${JUP_API}/quote?inputMint=${JUPSOL_MINT}&outputMint=${SOL_MINT}&amount=1000000000&slippageBps=50`,
        { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const j = await r.json();
      return Number(j.outAmount) / 1e9;
    } catch { return null; }
  }

  async function jupiterSwap(mnemonic, inputMint, outputMint, amountAtomic) {
    const kp = await deriveKeypair(mnemonic);
    const userPk = kp.publicKey.toBase58();
    const qRes = await fetch(`${JUP_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountAtomic}&slippageBps=50`,
      { signal: AbortSignal.timeout(10000) });
    if (!qRes.ok) throw new Error(`Quote failed: HTTP ${qRes.status}`);
    const quote = await qRes.json();
    const sRes = await fetch(`${JUP_API}/swap`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: userPk,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!sRes.ok) throw new Error(`Swap build failed: HTTP ${sRes.status}`);
    const { swapTransaction } = await sRes.json();
    if (!swapTransaction) throw new Error('No swap transaction returned');
    const txBytes = Uint8Array.from(atob(swapTransaction), c => c.charCodeAt(0));
    const tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);
    tx.sign([kp]);
    const conn = await _conn();
    return await conn.sendRawTransaction(tx.serialize());
  }

  async function liquidStakeJupSol(mnemonic, solAmount) {
    const lamports = Math.floor(Number(solAmount) * solanaWeb3.LAMPORTS_PER_SOL);
    if (!Number.isFinite(lamports) || lamports <= 0) throw new Error('Invalid amount');
    return jupiterSwap(mnemonic, SOL_MINT, JUPSOL_MINT, lamports);
  }

  async function liquidUnstakeJupSol(mnemonic, jupSolAmount) {
    // JupSOL has 9 decimals like SOL.
    const amount = Math.floor(Number(jupSolAmount) * 1e9);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid amount');
    return jupiterSwap(mnemonic, JUPSOL_MINT, SOL_MINT, amount);
  }

  return { deriveAddress, getBalance, sendSOL, getHistory,
           getStakeAccounts, stakeSOL, deactivateStake, withdrawStake,
           getLastEpochRewards, getValidatorInfo,
           getJupSolBalance, getJupSolRate, liquidStakeJupSol, liquidUnstakeJupSol };
})();

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

  // Per-address balance cache. Public Solana RPCs throttle so aggressively
  // that returning 0.000000 on every failure has caused users to think
  // their funds disappeared. We persist the last fetched balance and serve
  // it as a fallback when the RPC blip persists.
  function _balanceCacheKey(addr) { return `vault.sol.balance.${addr}`; }
  function _readBalanceCache(addr) {
    try {
      const raw = localStorage.getItem(_balanceCacheKey(addr));
      return raw == null ? null : raw;
    } catch { return null; }
  }
  function _writeBalanceCache(addr, value) {
    try { localStorage.setItem(_balanceCacheKey(addr), value); } catch {}
  }
  async function getBalance(address) {
    try {
      const res = await rpcCall('getBalance', [address]);
      const lamports = (res && typeof res === 'object' ? res.value : res) || 0;
      const out = (lamports / solanaWeb3.LAMPORTS_PER_SOL).toFixed(6);
      _writeBalanceCache(address, out);
      return out;
    } catch {
      // RPC failure — show the last known balance rather than zeroing the
      // UI. Fresh wallets with no cache still see 0.000000.
      return _readBalanceCache(address) || '0.000000';
    }
  }

  // Quick preflight that catches "polyfill didn't load" cases — the user's
  // device may still be running an older HTML build that doesn't include
  // the buffer-polyfill.js <script> tag. Surfacing a clearer message
  // beats letting solanaWeb3 throw "Buffer is not defined" at sign-time.
  function _assertBufferPolyfill() {
    if (typeof Buffer === 'undefined') {
      throw new Error('Buffer polyfill not loaded — open Settings → Check for Updates, then close and reopen the app.');
    }
  }

  async function sendSOL(mnemonic, to, amount) {
    _assertBufferPolyfill();
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
    const ix = solanaWeb3.SystemProgram.transfer({
      fromPubkey: kp.publicKey,
      toPubkey: toPk,
      lamports,
    });
    // VersionedTransaction (not legacy Transaction). The legacy class
    // calls Node's Buffer internally inside .serialize(), and the
    // Capacitor WebView has no Buffer polyfill — sends were failing
    // with "Error: Buffer is not defined". VersionedTransaction's
    // serialize() works on plain Uint8Array, same code path the JupSOL
    // swap already uses successfully.
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new solanaWeb3.TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new solanaWeb3.VersionedTransaction(msg);
    tx.sign([kp]);
    return await conn.sendRawTransaction(tx.serialize());
  }

  // Known Solana program IDs we want to recognize in transaction history.
  // Used to label rows as Stake / Withdraw / Liquid stake / etc. instead
  // of the bare "Sent / Received" classification.
  const PROG_STAKE   = 'Stake11111111111111111111111111111111111111';
  const PROG_VOTE    = 'Vote111111111111111111111111111111111111111';
  const PROG_JUP_V6  = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
  const PROG_JUP_V4  = 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB';

  // Per-address transaction history cache. Same reasoning as the balance
  // and stake caches: when the RPC fails we'd rather show stale history
  // than an empty list that looks like all txs were wiped.
  function _historyCacheKey(addr) { return `vault.sol.history.${addr}`; }
  function _readHistoryCache(addr) {
    try {
      const raw = localStorage.getItem(_historyCacheKey(addr));
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function _writeHistoryCache(addr, rows) {
    try { localStorage.setItem(_historyCacheKey(addr), JSON.stringify(rows)); } catch {}
  }
  async function getHistory(address) {
    try {
      const sigs = await rpcCall('getSignaturesForAddress', [address, { limit: 10 }]);
      if (!sigs || !sigs.length) {
        // RPC returned an empty result. Real-empty for a fresh wallet,
        // or RPC silently truncated. Trust it and overwrite cache only
        // if we successfully got an array (vs. null/undefined).
        if (Array.isArray(sigs)) _writeHistoryCache(address, []);
        return _readHistoryCache(address);
      }
      const details = await Promise.allSettled(sigs.map(s =>
        rpcCall('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }])
      ));
      const out = [];
      for (let i = 0; i < sigs.length; i++) {
        const s = sigs[i];
        const d = details[i].status === 'fulfilled' ? details[i].value : null;
        let type = 'send', amount = '—', kind = 'send', delta = 0;
        if (d && d.meta && d.transaction) {
          // For V0 transactions with Address Lookup Tables (Jupiter
          // swaps, modern Solana txs), the resolved program/account
          // pubkeys live in meta.loadedAddresses, appended after the
          // static accountKeys. Without merging these in, an instruction
          // whose programIdIndex points past the static slice resolves
          // to undefined and classification falls back to plain Sent.
          const staticKeys = (d.transaction.message.accountKeys || []).map(k => typeof k === 'string' ? k : k?.pubkey);
          const loadedW = (d.meta.loadedAddresses?.writable || []).map(k => typeof k === 'string' ? k : k?.pubkey);
          const loadedR = (d.meta.loadedAddresses?.readonly || []).map(k => typeof k === 'string' ? k : k?.pubkey);
          const keys = [...staticKeys, ...loadedW, ...loadedR];
          const idx = keys.findIndex(k => k === address);
          if (idx >= 0) {
            delta = (d.meta.postBalances[idx] - d.meta.preBalances[idx]) / solanaWeb3.LAMPORTS_PER_SOL;
            type = delta < 0 ? 'send' : 'receive';
            amount = Math.abs(delta).toFixed(6);
          }
          // Belt-and-suspenders program detection. Combine three
          // independent signals and OR them together — whichever finds
          // a hit wins:
          //   1. Log messages "Program <id> invoke [N]" — present
          //      whenever the RPC returns logs; covers CPIs at any depth.
          //   2. Top-level instructions, resolved through `keys` (which
          //      already merges static accountKeys + loadedAddresses for
          //      V0 / ALT txs above).
          //   3. Inner instructions (meta.innerInstructions) for CPIs
          //      whose outer program is something else.
          // Some public RPCs strip logMessages from old transactions
          // and some strip innerInstructions, so we don't rely on any
          // single source.
          const logs = (d.meta.logMessages || []).join('\n');
          const topIxs   = d.transaction.message.instructions || [];
          const innerIxs = (d.meta.innerInstructions || []).flatMap(g => g.instructions || []);
          const programIds = [...topIxs, ...innerIxs].map(ix => {
            if (typeof ix.programId === 'string') return ix.programId;
            if (typeof ix.programIdIndex === 'number') return keys[ix.programIdIndex];
            return null;
          }).filter(Boolean);
          const hitStake = logs.includes(PROG_STAKE) || programIds.includes(PROG_STAKE);
          const hitJup   = logs.includes(PROG_JUP_V6) || logs.includes(PROG_JUP_V4)
                        || programIds.includes(PROG_JUP_V6) || programIds.includes(PROG_JUP_V4);
          // Classify. We can't reliably parse stake-instruction discriminators
          // here so we use the signed delta as a proxy:
          //   stake → big negative (lamports go into the new stake account)
          //   withdraw → big positive (lamports come back to wallet)
          //   manage (deactivate/etc.) → tiny / near-zero delta
          //   Jupiter → swap is liquid stake (out) or unstake (in)
          if (hitJup) {
            kind = delta < 0 ? 'liquid-stake' : 'liquid-unstake';
          } else if (hitStake) {
            if (Math.abs(delta) < 0.0001) kind = 'stake-manage';
            else if (delta < 0)           kind = 'stake';
            else                          kind = 'stake-withdraw';
          } else {
            kind = type; // plain send / receive
          }
        }
        out.push({
          hash: s.signature,
          type, amount, kind,
          time: s.blockTime ? s.blockTime * 1000 : null,
          confirmed: !s.err,
          status: s.err ? 'error' : 'ok',
          explorerUrl: `https://solscan.io/tx/${s.signature}`,
        });
      }
      // RPC call succeeded — refresh cache and return the fresh list.
      _writeHistoryCache(address, out);
      return out;
    } catch {
      // RPC failed. Serve whatever cached history we still have.
      return _readHistoryCache(address);
    }
  }

  // ── Native staking ───────────────────────────────────────────────────
  // Stake account size is 200 bytes; rent reserve sits on top of the staked
  // amount and is recoverable on full withdraw.
  const STAKE_SPACE = 200;

  async function getStakeRent() {
    return await rpcCall('getMinimumBalanceForRentExemption', [STAKE_SPACE]);
  }

  // Classify a stake account given its parsed accountInfo + current epoch.
  // Shared between the getProgramAccounts path and the per-account
  // getAccountInfo cache-hydration path.
  function _classifyStake(pubkey, parsedInfo, lamports, currentEpoch) {
    const stake = parsedInfo?.stake?.delegation;
    const sol = (lamports / solanaWeb3.LAMPORTS_PER_SOL).toFixed(6);
    const validator = stake?.voter || null;
    let state = 'inactive';
    if (stake) {
      // BigInt-safe comparison: Solana uses u64::MAX
      // (18446744073709551615) as a "never deactivates" sentinel which
      // loses precision when coerced through Number().
      const tip   = BigInt(currentEpoch);
      const act   = BigInt(stake.activationEpoch   ?? '0');
      const deact = BigInt(stake.deactivationEpoch ?? '0');
      const NEVER = (1n << 64n) - 1n;
      const isDeactivated  = deact !== NEVER && deact < tip;
      const isDeactivating = deact !== NEVER && deact === tip;
      const isActivating   = act > tip;
      if      (isDeactivated)  state = 'inactive';
      else if (isDeactivating) state = 'deactivating';
      else if (isActivating)   state = 'activating';
      else                     state = 'active';
    }
    return { pubkey, lamports, sol, validator, state };
  }

  // Persisted list of stake account pubkeys per withdraw-authority
  // address. Used as a reliable fallback when getProgramAccounts is
  // rate-limited / blocked by the public RPC (which is most of the time).
  function _stakeCacheKey(addr) { return `vault.sol.stakeAccounts.${addr}`; }
  function _readStakeCache(addr) {
    try {
      const raw = localStorage.getItem(_stakeCacheKey(addr));
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
    } catch { return []; }
  }
  function _writeStakeCache(addr, pubkeys) {
    try {
      const unique = Array.from(new Set(pubkeys.filter(Boolean)));
      localStorage.setItem(_stakeCacheKey(addr), JSON.stringify(unique));
    } catch {}
  }
  function rememberStakeAccount(address, stakePubkey) {
    if (!address || !stakePubkey) return;
    _writeStakeCache(address, [..._readStakeCache(address), stakePubkey]);
  }
  function forgetStakeAccount(address, stakePubkey) {
    if (!address || !stakePubkey) return;
    _writeStakeCache(address, _readStakeCache(address).filter(p => p !== stakePubkey));
    _forgetStakeState(stakePubkey);
  }

  // Full stake-account state cache, keyed by stake pubkey. Lets us still
  // render the row (with last-known balance and validator) when RPC is
  // throttled. _classifyStake's output is stable JSON so we just stringify.
  function _stakeStateKey(pk) { return `vault.sol.stakeState.${pk}`; }
  function _readStakeState(pk) {
    try {
      const raw = localStorage.getItem(_stakeStateKey(pk));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function _writeStakeState(pk, stake) {
    try { localStorage.setItem(_stakeStateKey(pk), JSON.stringify(stake)); } catch {}
  }
  function _forgetStakeState(pk) {
    try { localStorage.removeItem(_stakeStateKey(pk)); } catch {}
  }

  // Lists stake accounts where the user is the withdraw authority.
  // Strategy:
  //   1. Try getProgramAccounts (the canonical "find all my stakes" call).
  //   2. Whatever it returns, union with the locally cached pubkey list
  //      and refresh the cache. This means the modal still works after a
  //      successful stake even if the RPC silently rate-limits later.
  //   3. For any cached pubkey the RPC missed, fetch it individually via
  //      getAccountInfo (a lightweight call public RPCs allow). If the
  //      account is gone (withdrawn / closed), drop it from the cache.
  async function getStakeAccounts(address) {
    // We must distinguish "RPC failed" from "RPC says the account is gone".
    // Treating a transient throttle as a real deletion has wiped users'
    // cached stake-account pubkeys in the past — never again.
    let rpcAccountsOk = false;
    let rpcAccountsRaw = null;
    let epochInfo = null;
    await Promise.all([
      rpcCall('getProgramAccounts', [
        solanaWeb3.StakeProgram.programId.toBase58(),
        {
          encoding: 'jsonParsed',
          filters: [{ memcmp: { offset: 44, bytes: address } }],
        },
      ]).then(r => { rpcAccountsOk = true; rpcAccountsRaw = r; }).catch(() => {}),
      rpcCall('getEpochInfo', []).then(r => { epochInfo = r; }).catch(() => {}),
    ]);
    const currentEpoch = epochInfo?.epoch ?? 0;

    const fromRpc = Array.isArray(rpcAccountsRaw)
      ? rpcAccountsRaw.map(a => {
          const stake = _classifyStake(
            a.pubkey,
            a.account?.data?.parsed?.info || {},
            a.account?.lamports ?? 0,
            currentEpoch,
          );
          _writeStakeState(a.pubkey, stake);
          return stake;
        })
      : [];

    // Hydrate any cached pubkeys the RPC didn't return.
    const seen = new Set(fromRpc.map(a => a.pubkey));
    const cached = _readStakeCache(address);
    const missing = cached.filter(pk => !seen.has(pk));
    const fromCache = await Promise.all(missing.map(async pk => {
      let ok = false;
      let value = null;
      try {
        const info = await rpcCall('getAccountInfo', [pk, { encoding: 'jsonParsed' }]);
        ok = true;
        value = info?.value ?? null;
      } catch {
        // Network/RPC failure. Keep the cached pubkey AND render the
        // last-known state if we have one — otherwise nothing this cycle.
        const stale = _readStakeState(pk);
        return { keep: true, render: stale || null, pk };
      }
      if (ok && value === null) {
        // RPC confirmed: account doesn't exist anymore (withdrawn / closed).
        return { keep: false, render: null, pk };
      }
      const stake = _classifyStake(
        pk,
        value.data?.parsed?.info || {},
        value.lamports ?? 0,
        currentEpoch,
      );
      _writeStakeState(pk, stake);
      return { keep: true, pk, render: stake };
    }));

    // Drop only the cache entries the RPC EXPLICITLY confirmed are gone.
    for (const item of fromCache) {
      if (item && item.keep === false) forgetStakeAccount(address, item.pk);
    }

    const all = [
      ...fromRpc,
      ...fromCache.filter(x => x && x.render).map(x => x.render),
    ];
    // Only refresh the full cache snapshot if the canonical scan succeeded.
    // Otherwise leave the existing cache intact so a flaky RPC can't wipe
    // a user's stake-account list.
    if (rpcAccountsOk) {
      _writeStakeCache(address, all.map(a => a.pubkey));
    }
    return all;
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
    _assertBufferPolyfill();
    await assertIsVoteAccount(validatorVoteAddress);
    const kp = await deriveKeypair(mnemonic);
    const conn = await _conn();
    const lamports = Math.floor(Number(amount) * solanaWeb3.LAMPORTS_PER_SOL);
    if (!Number.isFinite(lamports) || lamports <= 0) throw new Error('Invalid amount');
    const rent = await getStakeRent();
    const stakeAccount = solanaWeb3.Keypair.generate();
    const totalLamports = lamports + rent;
    // StakeProgram helpers return Transaction objects; we want the raw
    // Instructions to build a VersionedTransaction (avoids the Node
    // Buffer dependency in legacy Transaction.serialize()).
    const createTx = solanaWeb3.StakeProgram.createAccount({
      fromPubkey: kp.publicKey,
      stakePubkey: stakeAccount.publicKey,
      authorized: new solanaWeb3.Authorized(kp.publicKey, kp.publicKey),
      lockup: new solanaWeb3.Lockup(0, 0, kp.publicKey),
      lamports: totalLamports,
    });
    const delegateTx = solanaWeb3.StakeProgram.delegate({
      stakePubkey: stakeAccount.publicKey,
      authorizedPubkey: kp.publicKey,
      votePubkey: new solanaWeb3.PublicKey(validatorVoteAddress),
    });
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new solanaWeb3.TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: blockhash,
      instructions: [...createTx.instructions, ...delegateTx.instructions],
    }).compileToV0Message();
    const tx = new solanaWeb3.VersionedTransaction(msg);
    tx.sign([kp, stakeAccount]);
    const signature = await conn.sendRawTransaction(tx.serialize());
    // Remember this stake account locally so getStakeAccounts() can still
    // find it even when the public RPC rate-limits getProgramAccounts.
    rememberStakeAccount(kp.publicKey.toBase58(), stakeAccount.publicKey.toBase58());
    // Also remember the initial stake size + timestamp so the modal can
    // compute realtime profit (current lamports minus initial) without
    // needing an indexer.
    rememberStakeBasis(stakeAccount.publicKey.toBase58(), totalLamports);
    return signature;
  }

  // ── Stake-account cost basis ────────────────────────────────────────
  // Per stake-account record of "what we paid into it on day one" so the
  // modal can render a realtime-profit line. The current on-chain balance
  // already includes accrued rewards (native staking compounds in place),
  // so profit = currentLamports - initialLamports.
  function _stakeBasisKey(pk) { return `vault.sol.stakeBasis.${pk}`; }
  function rememberStakeBasis(stakePubkey, initialLamports, stakedAtMs) {
    if (!stakePubkey || !initialLamports) return;
    try {
      localStorage.setItem(_stakeBasisKey(stakePubkey), JSON.stringify({
        initialLamports,
        stakedAt: stakedAtMs || Date.now(),
      }));
    } catch {}
  }
  function readStakeBasis(stakePubkey) {
    try {
      const raw = localStorage.getItem(_stakeBasisKey(stakePubkey));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !Number.isFinite(Number(obj.initialLamports))) return null;
      return {
        initialLamports: Number(obj.initialLamports),
        stakedAt: Number(obj.stakedAt) || Date.now(),
      };
    } catch { return null; }
  }
  function forgetStakeBasis(stakePubkey) {
    try { localStorage.removeItem(_stakeBasisKey(stakePubkey)); } catch {}
  }

  async function deactivateStake(mnemonic, stakeAccountAddress) {
    const kp = await deriveKeypair(mnemonic);
    const conn = await _conn();
    const deTx = solanaWeb3.StakeProgram.deactivate({
      stakePubkey: new solanaWeb3.PublicKey(stakeAccountAddress),
      authorizedPubkey: kp.publicKey,
    });
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new solanaWeb3.TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: blockhash,
      instructions: [...deTx.instructions],
    }).compileToV0Message();
    const tx = new solanaWeb3.VersionedTransaction(msg);
    tx.sign([kp]);
    return await conn.sendRawTransaction(tx.serialize());
  }

  async function withdrawStake(mnemonic, stakeAccountAddress) {
    const kp = await deriveKeypair(mnemonic);
    const conn = await _conn();
    const stakePk = new solanaWeb3.PublicKey(stakeAccountAddress);
    const accInfo = await conn.getAccountInfo(stakePk);
    if (!accInfo) throw new Error('Stake account not found');
    const wTx = solanaWeb3.StakeProgram.withdraw({
      stakePubkey: stakePk,
      authorizedPubkey: kp.publicKey,
      toPubkey: kp.publicKey,
      lamports: accInfo.lamports,
    });
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new solanaWeb3.TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: blockhash,
      instructions: [...wTx.instructions],
    }).compileToV0Message();
    const tx = new solanaWeb3.VersionedTransaction(msg);
    tx.sign([kp]);
    const sig = await conn.sendRawTransaction(tx.serialize());
    // Withdraw of the full balance closes the account — drop it from the
    // local cache so the modal stops showing a ghost entry next time.
    forgetStakeAccount(kp.publicKey.toBase58(), stakeAccountAddress);
    forgetStakeBasis(stakeAccountAddress);
    return sig;
  }

  // ── Liquid staking via Jupiter (JupSOL) ─────────────────────────────
  // We swap through Jupiter's aggregator instead of calling the stake-pool
  // deposit/withdraw instructions directly — this lets the user enter and
  // exit the position instantly with no setup.
  const JUPSOL_MINT = 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v';
  const SOL_MINT    = 'So11111111111111111111111111111111111111112';

  // Jupiter migrated their public API in 2025. The legacy quote-api.jup.ag/v6
  // host is being phased out and now returns network-level failures for
  // unauthenticated browser callers ("Failed to fetch"). lite-api.jup.ag is
  // the keyless replacement; api.jup.ag requires a paid key. Try lite first,
  // fall back to the legacy host as a safety net.
  const JUP_HOSTS = [
    'https://lite-api.jup.ag/swap/v1',
    'https://quote-api.jup.ag/v6',
  ];

  // Run an async fn against each Jupiter host until one returns. Helpful so
  // a deprecated endpoint doesn't bring down the whole liquid-stake flow.
  async function _jupTry(fn) {
    let lastErr;
    for (const host of JUP_HOSTS) {
      try { return await fn(host); }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('All Jupiter endpoints failed');
  }

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
      return await _jupTry(async host => {
        const r = await fetch(`${host}/quote?inputMint=${JUPSOL_MINT}&outputMint=${SOL_MINT}&amount=1000000000&slippageBps=50`,
          { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        return Number(j.outAmount) / 1e9;
      });
    } catch { return null; }
  }

  async function jupiterSwap(mnemonic, inputMint, outputMint, amountAtomic) {
    const kp = await deriveKeypair(mnemonic);
    const userPk = kp.publicKey.toBase58();

    let quote, host;
    try {
      ({ quote, host } = await _jupTry(async h => {
        const r = await fetch(`${h}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountAtomic}&slippageBps=50`,
          { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { quote: await r.json(), host: h };
      }));
    } catch (e) {
      throw new Error(`Jupiter quote unreachable (${e.message || e}). Check your connection or try again in a minute.`);
    }

    let sRes;
    try {
      sRes = await fetch(`${host}/swap`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: userPk,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      throw new Error(`Jupiter swap build unreachable (${e.message || e}). Try again in a minute.`);
    }
    if (!sRes.ok) {
      const txt = await sRes.text().catch(() => '');
      throw new Error(`Jupiter swap build failed: HTTP ${sRes.status}${txt ? ' — ' + txt.slice(0, 120) : ''}`);
    }
    const { swapTransaction } = await sRes.json();
    if (!swapTransaction) throw new Error('No swap transaction returned by Jupiter');
    const txBytes = Uint8Array.from(atob(swapTransaction), c => c.charCodeAt(0));
    const tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);
    tx.sign([kp]);
    const conn = await _conn();
    let signature;
    try {
      signature = await conn.sendRawTransaction(tx.serialize());
    } catch (e) {
      const msg = String(e?.message || e);
      // SPL Token program throws 0x1 ("InsufficientFunds") when there isn't
      // enough lamports left after the swap to cover the new ATA rent.
      // Rewrite the cryptic Solana log into something actionable.
      if (/0x1\b/.test(msg) || /InsufficientFunds/i.test(msg)) {
        throw new Error('Not enough SOL left to cover fees + the new JupSOL account rent (~0.005 SOL needed on top of the stake amount). Lower the amount and try again.');
      }
      throw e;
    }
    // Returns the signature plus the atomic-unit amounts Jupiter quoted
    // for the trade. Callers use these to track JupSOL cost basis
    // (SOL paid for the JupSOL we currently hold → realtime profit).
    return {
      signature,
      inAmountAtomic:  Number(quote.inAmount  || amountAtomic),
      outAmountAtomic: Number(quote.outAmount || 0),
    };
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
           rememberStakeAccount, forgetStakeAccount,
           rememberStakeBasis, readStakeBasis, forgetStakeBasis,
           getLastEpochRewards, getValidatorInfo,
           getJupSolBalance, getJupSolRate, liquidStakeJupSol, liquidUnstakeJupSol };
})();

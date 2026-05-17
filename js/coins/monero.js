const MoneroWallet = (() => {
  const MYMONERO = 'https://api.mymonero.com';
  const M64 = 0xFFFFFFFFFFFFFFFFn;
  const P = (1n << 255n) - 19n;
  const L = (1n << 252n) + 27742317777372353535851937790883648493n;

  // Convert an XMR decimal amount string (e.g. "1.234567891234") to piconero
  // BigInt exactly — without Number-precision loss. Monero has 12 decimals.
  function _xmrToPiconero(amount) {
    const s = String(amount).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Invalid XMR amount');
    const [intPart, fracPartRaw = ''] = s.split('.');
    if (fracPartRaw.length > 12) throw new Error('XMR amount has more than 12 decimal places');
    const fracPart = fracPartRaw.padEnd(12, '0');
    return BigInt(intPart) * 1000000000000n + BigInt(fracPart || '0');
  }

  // ── Keccak-256 (original pre-NIST, used by Monero) ───────────────────────────
  const KECCAK_RC = [
    0x0000000000000001n,0x0000000000008082n,0x800000000000808An,0x8000000080008000n,
    0x000000000000808Bn,0x0000000080000001n,0x8000000080008081n,0x8000000000008009n,
    0x000000000000008An,0x0000000000000088n,0x0000000080008009n,0x000000008000000An,
    0x000000008000808Bn,0x800000000000008Bn,0x8000000000008089n,0x8000000000008003n,
    0x8000000000008002n,0x8000000000000080n,0x000000000000800An,0x800000008000000An,
    0x8000000080008081n,0x8000000000008080n,0x0000000080000001n,0x8000000080008008n
  ];
  const KECCAK_ROT = [
    [0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]
  ];

  function keccak256(data) {
    const rot = (x, n) => n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64-n))) & M64;
    const inp = data instanceof Uint8Array ? data : new Uint8Array(data);
    const rate = 136;
    const total = Math.ceil((inp.length + 1) / rate) * rate;
    const padded = new Uint8Array(total);
    padded.set(inp);
    padded[inp.length] = 0x01;  // Keccak padding, not SHA3's 0x06
    padded[total - 1] |= 0x80;
    const S = Array.from({length:5}, () => new Array(5).fill(0n));
    for (let off = 0; off < padded.length; off += rate) {
      for (let i = 0; i < 17; i++) {
        const p = off + i * 8;
        const lo = BigInt(new DataView(padded.buffer, p, 4).getUint32(0, true));
        const hi = BigInt(new DataView(padded.buffer, p+4, 4).getUint32(0, true));
        S[i%5][Math.floor(i/5)] = (S[i%5][Math.floor(i/5)] ^ (lo | (hi << 32n))) & M64;
      }
      for (let r = 0; r < 24; r++) {
        const C = S.map(col => col.reduce((a,b) => (a^b)&M64));
        const D = C.map((_, x) => (C[(x+4)%5] ^ rot(C[(x+1)%5], 1)) & M64);
        for (let x=0;x<5;x++) for (let y=0;y<5;y++) S[x][y] = (S[x][y]^D[x])&M64;
        const B = Array.from({length:5}, () => new Array(5).fill(0n));
        for (let x=0;x<5;x++) for (let y=0;y<5;y++)
          B[y][(2*x+3*y)%5] = rot(S[x][y], KECCAK_ROT[x][y]);
        for (let x=0;x<5;x++) for (let y=0;y<5;y++)
          S[x][y] = (B[x][y] ^ ((M64^B[(x+1)%5][y]) & B[(x+2)%5][y])) & M64;
        S[0][0] = (S[0][0] ^ KECCAK_RC[r]) & M64;
      }
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 4; i++) {
      const v = S[i][0];
      new DataView(out.buffer, i*8, 4).setUint32(0, Number(v & 0xFFFFFFFFn), true);
      new DataView(out.buffer, i*8+4, 4).setUint32(0, Number((v>>32n) & 0xFFFFFFFFn), true);
    }
    return out;
  }

  // ── Ed25519 field / group arithmetic ─────────────────────────────────────────
  const fm = (a, m=P) => ((a%m)+m)%m;
  const fpow = (b, e, m=P) => { let r=1n; b=fm(b,m); while(e>0n){if(e&1n)r=r*b%m;b=b*b%m;e>>=1n;} return r; };
  const finv = a => fpow(fm(a), P-2n);
  const D_C = fm(-121665n * finv(121666n));

  // Extended twisted Edwards coords (X:Y:Z:T)
  const ID4 = [0n,1n,1n,0n];
  function pointAdd([x1,y1,z1,t1],[x2,y2,z2,t2]) {
    const A=fm((y1-x1)*(y2-x2)), B=fm((y1+x1)*(y2+x2));
    const C=fm(2n*D_C*t1*t2), Dv=fm(2n*z1*z2);
    const E=fm(B-A),F=fm(Dv-C),G=fm(Dv+C),H=fm(B+A);
    return [fm(E*F),fm(G*H),fm(F*G),fm(E*H)];
  }
  function scalarMul(pt, s) {
    let R=[...ID4], Q=[...pt];
    while(s>0n){if(s&1n)R=pointAdd(R,Q);Q=pointAdd(Q,Q);s>>=1n;}
    return R;
  }
  function compress([X,Y,Z]) {
    const zi=finv(Z), ax=fm(X*zi), ay=fm(Y*zi);
    const out=new Uint8Array(32);
    for(let i=0;i<32;i++) out[i]=Number((ay>>BigInt(i*8))&0xffn);
    if(ax&1n) out[31]|=0x80;
    return out;
  }

  // Base point
  const Gy0 = fm(4n*finv(5n));
  const Gx0 = (() => {
    const u=fm(Gy0*Gy0-1n), v=fm(D_C*Gy0*Gy0+1n), x2=fm(u*finv(v));
    let x=fpow(x2,(P+3n)/8n);
    if(fm(x*x)!==x2) x=fm(x*fpow(2n,(P-1n)/4n));
    if(x&1n) x=P-x;
    return x;
  })();
  const G = [Gx0, Gy0, 1n, fm(Gx0*Gy0)];

  function sc_reduce(bytes) {
    let n=0n;
    for(let i=bytes.length-1;i>=0;i--) n=(n<<8n)|BigInt(bytes[i]);
    return fm(n,L);
  }
  function scToBytes(s) {
    const out=new Uint8Array(32);
    for(let i=0;i<32;i++){out[i]=Number(s&0xffn);s>>=8n;}
    return out;
  }

  // ── BIP39 seed ───────────────────────────────────────────────────────────────
  // BIP39 passphrase ("25th word") is appended to the salt per spec.
  // '' means no passphrase — preserves standard derivation for existing wallets.
  function _pp() { return (typeof window !== 'undefined' && window.getPassphrase) ? window.getPassphrase() : ''; }

  async function bip39ToSeed(mnemonic) {
    const enc=new TextEncoder();
    const passphrase = _pp();
    const key=await crypto.subtle.importKey('raw',enc.encode(mnemonic.normalize('NFKD')),'PBKDF2',false,['deriveBits']);
    const bits=await crypto.subtle.deriveBits(
      {name:'PBKDF2',salt:enc.encode(('mnemonic'+passphrase).normalize('NFKD')),iterations:2048,hash:'SHA-512'},
      key,512
    );
    return new Uint8Array(bits);
  }

  // ── Monero Base58 (block encoding, different from Bitcoin Base58) ─────────────
  const XMR_B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ENC_SIZES = [0,2,3,5,6,7,9,10,11];
  function xmrBase58(data) {
    const full=Math.floor(data.length/8); let res='';
    for(let i=0;i<full;i++) res+=encBlock(data.slice(i*8,i*8+8),11);
    const rem=data.length%8;
    if(rem) res+=encBlock(data.slice(full*8),ENC_SIZES[rem]);
    return res;
  }
  function encBlock(block,size) {
    let n=0n; for(const b of block) n=(n<<8n)|BigInt(b);
    let s=''; while(s.length<size){s=XMR_B58[Number(n%58n)]+s;n/=58n;} return s;
  }

  // ── Private key helpers ───────────────────────────────────────────────────────
  async function deriveSpendKeyHex(mnemonic) {
    const seed = await bip39ToSeed(mnemonic);
    const privSpend = sc_reduce(seed.slice(0, 32));
    return Array.from(scToBytes(privSpend)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // First-try: our own CORS-friendly proxy on EYE-HCH. Public Monero
  // daemons don't send Access-Control-Allow-Origin on the binary
  // endpoints (/getblocks.bin etc.) used during sync, so the WASM
  // engine inside a WebView silently fails on them even when /json_rpc
  // works. The iamhch proxy strips Origin and injects permissive CORS,
  // backed by xmr-node.cakewallet.com:18081.
  // The remaining entries are fallbacks for when the proxy is down.
  const PUBLIC_NODES = [
    'https://xmr-rpc.iamhch.com',
    'https://node.sethforprivacy.com:443',
    'https://xmr-node.cakewallet.com:18081',
    'https://xmr.stormycloud.org:18089',
    'https://node.community.rino.io:18089',
    'https://selsta1.featherwallet.net:18081',
    'https://node.monerodevs.org:18089',
    'https://monero.stackwallet.com:18081',
    'https://node2.monerodevs.org:18089',
    'https://node3.monerodevs.org:18089',
  ];

  // User-configurable override. If set, gets tried before any public
  // node so the user can point at their own node or one they know
  // works on their network.
  function _nodeList() {
    const custom = (typeof localStorage !== 'undefined')
      ? (localStorage.getItem('xmr_custom_node') || '').trim()
      : '';
    return custom ? [custom, ...PUBLIC_NODES] : PUBLIC_NODES;
  }

  async function sendXMR(mnemonic, toAddress, amount, _restoreHeight, onProgress) {
    // Reuse the cached local-sync wallet so we don't pay the
    // ~5-30s wallet-creation cost on every send, and so we don't
    // run two parallel syncs (background balance + send sync).
    const w = await _getLocalWallet(mnemonic);
    if (onProgress) {
      try {
        await w.addListener({
          onSyncProgress: (_h, _s, _e, pct) => onProgress(Math.round(pct * 100)),
        });
      } catch {}
    }
    // Block until current tip so the send doesn't reference unspent
    // outputs the chain has since reorged.
    await w.sync();

    // String-based decimal → piconero conversion. The old
    // `Math.round(parseFloat(amount) * 1e12)` lost precision above ~9 XMR
    // because the intermediate float exceeds Number.MAX_SAFE_INTEGER.
    // Now we parse the decimal string exactly: "1.234567891234" XMR →
    // BigInt("1234567891234"), preserving every piconero.
    const piconero = _xmrToPiconero(amount);
    const txs = await w.createTxs({ accountIndex: 0, address: toAddress, amount: piconero, relay: true });
    // Keep the wallet open for the next balance refresh — no .close().
    return txs[0].getHash();
  }

  async function getCurrentHeight() {
    for (const node of _nodeList()) {
      try {
        const r = await fetch(node + '/json_rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_block_count' }),
        });
        const d = await r.json();
        if (d.result?.count) return d.result.count - 5;
      } catch { /* try next */ }
    }
    return 3710000; // fallback: approximate May 2026 height
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  async function deriveAddress(mnemonic) {
    try {
      const seed=await bip39ToSeed(mnemonic);
      const privSpend=sc_reduce(seed.slice(0,32));
      const privView=sc_reduce(keccak256(scToBytes(privSpend)));
      const pubSpend=compress(scalarMul(G,privSpend));
      const pubView=compress(scalarMul(G,privView));
      const raw=new Uint8Array([18,...pubSpend,...pubView]); // 18 = mainnet prefix
      const check=keccak256(raw).slice(0,4);
      return xmrBase58(new Uint8Array([...raw,...check]));
    } catch(e) { console.error('XMR derive:',e); return null; }
  }

  async function deriveViewKey(mnemonic) {
    const seed=await bip39ToSeed(mnemonic);
    const privSpend=sc_reduce(seed.slice(0,32));
    return scToBytes(sc_reduce(keccak256(scToBytes(privSpend))));
  }

  // ── Subaddresses (Cake-compatible) ──────────────────────────────
  // Standard Monero subaddress derivation. For (account=0, index=0)
  // returns the primary address (network byte 18). For any other
  // pair returns a subaddress (network byte 42) interoperable with
  // Cake / Feather / Monero GUI / Wallet RPC — the per-payment
  // receive addresses Monero uses to break linkability.
  //
  //   m_i = sc_reduce(keccak256("SubAddr\0" || a || varint(account) || varint(index)))
  //   D_i = b·G + m_i·G   (subaddress public spend point)
  //   C_i = a · D_i        (subaddress public view point)
  //   addr = base58([42] || D_i || C_i || keccak256(prefix)[0:4])
  function _varint(n) {
    const out = [];
    let v = n >>> 0;
    while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
    out.push(v & 0x7f);
    return new Uint8Array(out);
  }

  async function deriveSubaddress(mnemonic, account, index) {
    account = (account | 0) >>> 0;
    index = (index | 0) >>> 0;
    if (account === 0 && index === 0) return deriveAddress(mnemonic);

    const seed = await bip39ToSeed(mnemonic);
    const privSpend = sc_reduce(seed.slice(0, 32));               // b
    const privView  = sc_reduce(keccak256(scToBytes(privSpend))); // a

    // m_i = sc_reduce(keccak256("SubAddr\0" || a_le32 || varint(M) || varint(N)))
    const tag = new TextEncoder().encode('SubAddr\0'); // 8 bytes incl null
    const aBytes = scToBytes(privView);
    const accVI = _varint(account);
    const idxVI = _varint(index);
    const buf = new Uint8Array(tag.length + 32 + accVI.length + idxVI.length);
    let off = 0;
    buf.set(tag, off);   off += tag.length;
    buf.set(aBytes, off); off += 32;
    buf.set(accVI, off);  off += accVI.length;
    buf.set(idxVI, off);
    const m = sc_reduce(keccak256(buf));

    // D = b·G + m·G = (b + m)·G; doing it as point-add to match Monero
    // reference exactly.
    const B  = scalarMul(G, privSpend);
    const mG = scalarMul(G, m);
    const D  = pointAdd(B, mG);
    const C  = scalarMul(D, privView);

    const raw = new Uint8Array([42, ...compress(D), ...compress(C)]); // 42 = mainnet subaddress
    const check = keccak256(raw).slice(0, 4);
    return xmrBase58(new Uint8Array([...raw, ...check]));
  }

  async function deriveViewKeyHex(mnemonic) {
    const bytes = await deriveViewKey(mnemonic);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ── Local blockchain sync (replaces the MyMonero POST) ──────────
  // Privacy upgrade: the view key never leaves the device. The bundled
  // monero_wallet_full.wasm scans the Monero blockchain on-device using
  // a background sync worker. First sync from the configured restore
  // height; thereafter incremental every minute.
  //
  // Module-level state keyed by the first 16 hex chars of the spend
  // key (a stable proxy for "is this the same wallet?" that doesn't
  // require storing the mnemonic across calls).
  let _wState = { promise: null, tag: null };

  function _closeWalletState() {
    const prev = _wState;
    _wState = { promise: null, tag: null };
    if (prev.promise) {
      prev.promise.then(w => { try { w && w.close(); } catch {} }).catch(() => {});
    }
  }
  if (typeof window !== 'undefined') {
    // Re-bind on every lock so the wasm worker doesn't hold keys
    // across unlock cycles. app.js dispatches 'vault-lock' from its
    // lock handler.
    window.addEventListener('vault-lock', _closeWalletState);
  }

  // Wrap a promise with a hard timeout — used to bail out of
  // MoneroWalletFull.createWallet calls that hang forever (seen in the
  // wild when the WASM worker silently stops responding).
  function _withTimeout(p, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  function _setStatus(msg, err = null) {
    _wState.status = msg;
    _wState.lastErr = err ? (err.message || String(err)) : null;
  }

  async function _getLocalWallet(mnemonic) {
    if (typeof MoneroWalletFull === 'undefined') {
      _setStatus('Engine not loaded');
      throw new Error('Monero engine not loaded — refresh the app');
    }
    const spendKeyHex = await deriveSpendKeyHex(mnemonic);
    const tag = spendKeyHex.slice(0, 16);
    if (_wState.tag !== tag) _closeWalletState();
    if (_wState.promise) return _wState.promise;

    _wState.tag = tag;
    _wState.promise = (async () => {
      // Restore height: stored value (user-set or auto-anchored on
      // first run) wins. Otherwise default to currentTip-5000
      // (~1 week of recent activity) so we don't scan genesis.
      let restoreHeight = parseInt(localStorage.getItem('xmr_restore_height') || '0') || 0;
      if (restoreHeight === 0) {
        _setStatus('Fetching network tip…');
        const tip = await getCurrentHeight();
        restoreHeight = Math.max(0, tip - 5000);
        try { localStorage.setItem('xmr_restore_height', String(restoreHeight)); } catch {}
      }
      // Remember which node worked last so we try it first next time —
      // saves cycling through 10 failures every restart.
      const preferred = localStorage.getItem('xmr_last_good_node') || '';
      const nodes = preferred
        ? [preferred, ..._nodeList().filter(n => n !== preferred)]
        : _nodeList();

      let lastErr;
      for (const node of nodes) {
        const host = (() => { try { return new URL(node).host; } catch { return node; } })();
        try {
          _setStatus(`Building wallet for ${host}…`);
          // Step 1: create the wallet WITHOUT a daemon. This part is
          // pure WASM init + key derivation, no network. Doing it
          // first lets us isolate WASM-init failures from
          // daemon-connection failures.
          const w = await _withTimeout(
            MoneroWalletFull.createWallet({
              networkType: 0,
              privateSpendKey: spendKeyHex,
              restoreHeight,
              // proxyToWorker: false runs the WASM on the main thread.
              // proxyToWorker: true was hanging in the Capacitor
              // WebView — the worker context apparently can't reach
              // the network reliably from monero-javascript's bundled
              // HTTP client. Main thread blocks the UI briefly during
              // sync but actually works.
              proxyToWorker: false,
            }),
            20_000,
            `wallet build via ${host}`
          );

          // Step 2: attach the daemon. Separate from createWallet so a
          // network/CORS failure here can't be mistaken for a WASM
          // initialisation failure.
          _setStatus(`Attaching daemon ${host}…`);
          try {
            await _withTimeout(
              w.setDaemonConnection({ uri: node }),
              15_000,
              `setDaemonConnection ${host}`
            );
          } catch (e) {
            // Fallback: some library versions expose .setDaemon
            // instead. Try that before giving up.
            if (typeof w.setDaemon === 'function') {
              await _withTimeout(w.setDaemon(node), 15_000, `setDaemon ${host}`);
            } else {
              throw e;
            }
          }

          _setStatus(`Starting sync via ${host}…`);
          try {
            await w.addListener({
              onSyncProgress: (_h, _s, _e, pct) => {
                _wState.syncPct = Math.round(pct * 100);
                _setStatus(`Syncing ${_wState.syncPct}%`);
              },
              onNewBlock:     () => { _wState.syncPct = 100; _setStatus('Synced'); },
            });
          } catch (e) { /* listener API may vary across builds */ }
          await w.startSyncing(60_000);
          // Remember this one for next time.
          try { localStorage.setItem('xmr_last_good_node', node); } catch {}
          _setStatus(`Connected to ${host}`);
          return w;
        } catch (e) {
          console.warn(`XMR node ${host} failed:`, e);
          const msg = (e?.message || e).toString();
          _setStatus(`${host} failed: ${msg.slice(0, 80)}`, e);
          lastErr = e;
        }
      }
      _closeWalletState();
      _setStatus(`All nodes failed — last error: ${(lastErr?.message || lastErr || '?').toString().slice(0, 80)}`, lastErr);
      throw new Error('No Monero node reachable: ' + (lastErr?.message || lastErr));
    })();
    return _wState.promise;
  }

  // mnemonic is required (local sync needs the spend key). Legacy
  // callers that pass only (address, viewKey) get a clear error so
  // the migration is visible.
  async function getBalance(address, viewKeyBytes, mnemonic) {
    if (!mnemonic) return null; // not unlocked yet
    try {
      const w = await _getLocalWallet(mnemonic);
      const balRaw = await w.getBalance(0);
      const balPico = BigInt((balRaw && balRaw.toString) ? balRaw.toString() : '0');
      return (Number(balPico) / 1e12).toFixed(9);
    } catch (e) {
      console.warn('XMR local sync getBalance failed:', e);
      return null;
    }
  }

  function getSyncProgressPct() {
    // Surfaced to the UI so it can show "Syncing N%" next to a
    // still-zero balance until the worker catches up. Returns null
    // when no wallet exists yet or the wasm engine hasn't loaded.
    try {
      // Cached value updated by the wallet's onSyncProgress callback
      // — see addListener below.
      return _wState.syncPct;
    } catch { return null; }
  }

  function getSyncStatus() {
    // Human-readable status string set by _setStatus at each step of
    // wallet creation + sync. Surfaced in the UI so users see what
    // stage is stuck instead of staring at a frozen '…XMR'.
    return _wState.status || null;
  }

  function getLastError() {
    return _wState.lastErr || null;
  }

  return { deriveAddress, deriveSubaddress, deriveViewKey, deriveViewKeyHex,
           deriveSpendKeyHex, getBalance, getSyncProgressPct,
           getSyncStatus, getLastError,
           sendXMR, getCurrentHeight,
           // Called from Settings when the user changes the restore
           // height. Drops the cached wallet so the next balance refresh
           // re-creates one against the new height.
           resetSync: _closeWalletState };
})();
// Expose on window so displayBalance() in app.js can poll
// getSyncProgressPct without relying on lexical script scope —
// const-declared top-level identifiers don't attach to window
// in classic scripts, which is why the "Syncing N%" indicator
// stayed stuck at "…" pre-this-line.
if (typeof window !== 'undefined') window.MoneroWallet = MoneroWallet;

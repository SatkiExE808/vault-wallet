const MoneroWallet = (() => {
  const MYMONERO = 'https://api.mymonero.com';
  const M64 = 0xFFFFFFFFFFFFFFFFn;
  const P = (1n << 255n) - 19n;
  const L = (1n << 252n) + 27742317777372353535851937790883648493n;

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
  async function bip39ToSeed(mnemonic) {
    const enc=new TextEncoder();
    const key=await crypto.subtle.importKey('raw',enc.encode(mnemonic.normalize('NFKD')),'PBKDF2',false,['deriveBits']);
    const bits=await crypto.subtle.deriveBits(
      {name:'PBKDF2',salt:enc.encode('mnemonic'.normalize('NFKD')),iterations:2048,hash:'SHA-512'},
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

  const PUBLIC_NODES = [
    'https://node.community.rino.io:18089',
    'https://xmr-node.cakewallet.com:18081',
    'https://monero.stackwallet.com:18081',
  ];

  async function sendXMR(mnemonic, toAddress, amount, restoreHeight, onProgress) {
    if (typeof MoneroWalletFull === 'undefined')
      throw new Error('Monero library not loaded. Refresh and try again.');

    const spendKeyHex = await deriveSpendKeyHex(mnemonic);

    let wallet = null;
    let lastErr;
    for (const node of PUBLIC_NODES) {
      try {
        wallet = await MoneroWalletFull.createWallet({
          networkType: 0,
          privateSpendKey: spendKeyHex,
          server: node,
          restoreHeight: restoreHeight || 0,
          proxyToWorker: true,
        });
        break;
      } catch(e) { lastErr = e; console.warn(`XMR node ${node} failed:`, e); }
    }
    if (!wallet) throw new Error('Could not connect to a Monero node: ' + (lastErr?.message || ''));

    if (onProgress) {
      await wallet.addListener({
        onSyncProgress: (_h, _s, _e, pct) => onProgress(Math.round(pct * 100)),
      });
    }

    await wallet.sync();

    const piconero = BigInt(Math.round(parseFloat(amount) * 1e12));
    const txs = await wallet.createTxs({ accountIndex: 0, address: toAddress, amount: piconero, relay: true });
    await wallet.close();
    return txs[0].getHash();
  }

  async function getCurrentHeight() {
    for (const node of PUBLIC_NODES) {
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
    return 3450000; // fallback: approximate May 2025 height
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

  async function deriveViewKeyHex(mnemonic) {
    const bytes = await deriveViewKey(mnemonic);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function getBalance(address, viewKeyBytes) {
    if(!viewKeyBytes) return '0.000000000';
    try {
      const vk=Array.from(viewKeyBytes).map(b=>b.toString(16).padStart(2,'0')).join('');
      const r=await fetch(`${MYMONERO}/get_address_info`,{
        method:'POST',
        headers:{'Content-Type':'application/json','Accept':'application/json'},
        body:JSON.stringify({address,view_key:vk})
      });
      if(!r.ok) return '0.000000000';
      const d=await r.json();
      const bal=BigInt(d.total_received||'0')-BigInt(d.total_sent||'0');
      return (Number(bal)/1e12).toFixed(9);
    } catch { return '0.000000000'; }
  }

  return { deriveAddress, deriveViewKey, deriveViewKeyHex, deriveSpendKeyHex, getBalance, sendXMR, getCurrentHeight };
})();

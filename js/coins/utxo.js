// Shared crypto for UTXO coins (Bitcoin, Litecoin, Dogecoin)
const UTXOCrypto = (() => {
  function hexToBytes(hex) {
    hex = hex.replace('0x', '');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
  }

  function sha256(data) {
    return sha256Sync(data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  function sha256Sync(msg) {
    const K = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];
    let h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const len = msg.length, bitLen = len * 8;
    const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
    padded.set(msg); padded[len] = 0x80;
    new DataView(padded.buffer).setUint32(padded.length - 4, bitLen, false);
    const W = new Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let i = 0; i < padded.length; i += 64) {
      const block = new DataView(padded.buffer, i, 64);
      for (let j = 0; j < 16; j++) W[j] = block.getUint32(j * 4, false);
      for (let j = 16; j < 64; j++) {
        const s0 = rotr(W[j-15],7) ^ rotr(W[j-15],18) ^ (W[j-15]>>>3);
        const s1 = rotr(W[j-2],17) ^ rotr(W[j-2],19) ^ (W[j-2]>>>10);
        W[j] = (W[j-16] + s0 + W[j-7] + s1) >>> 0;
      }
      let [a,b,c,d,e,f,g,hh] = h;
      for (let j = 0; j < 64; j++) {
        const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (hh + S1 + ch + K[j] + W[j]) >>> 0;
        const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;
        [hh,g,f,e,d,c,b,a] = [g,f,e,(d+temp1)>>>0,c,b,a,(temp1+temp2)>>>0];
      }
      h = h.map((v,i) => (v + [a,b,c,d,e,f,g,hh][i]) >>> 0);
    }
    const out = new Uint8Array(32);
    h.forEach((v,i) => new DataView(out.buffer).setUint32(i*4, v, false));
    return out;
  }

  function ripemd160(data) {
    const ML = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13];
    const MR = [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11];
    const SL = [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6];
    const SR = [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11];
    const HL = [0x00000000,0x5A827999,0x6ED9EBA1,0x8F1BBCDC,0xA953FD4E];
    const HR = [0x50A28BE6,0x5C4DD124,0x6D703EF3,0x7A6D76E9,0x00000000];
    const msg = data instanceof Uint8Array ? data : new Uint8Array(data);
    const len = msg.length, bitLen = len * 8;
    const padLen = ((len + 8) % 64 <= 55) ? 55 - ((len + 8) % 64) + 8 : 119 - ((len + 8) % 64) + 8;
    const padded = new Uint8Array(len + padLen + 1 + 8);
    padded.set(msg); padded[len] = 0x80;
    new DataView(padded.buffer).setUint32(padded.length - 8, bitLen & 0xffffffff, true);
    new DataView(padded.buffer).setUint32(padded.length - 4, Math.floor(bitLen / 2**32), true);
    let [h0,h1,h2,h3,h4] = [0x67452301,0xEFCDAB89,0x98BADCFE,0x10325476,0xC3D2E1F0];
    const rol = (x,n) => (x << n) | (x >>> (32-n));
    const add = (...args) => args.reduce((a,b) => (a+b)|0, 0) >>> 0;
    const f = (j,x,y,z) => j<16?(x^y^z):j<32?((x&y)|(~x&z)):j<48?((x|~y)^z):j<64?((x&z)|(y&~z)):(x^(y|~z));
    for (let i = 0; i < padded.length; i += 64) {
      const X = Array.from({length:16}, (_,j) => new DataView(padded.buffer, i+j*4, 4).getUint32(0, true));
      let [al,bl,cl,dl,el] = [h0,h1,h2,h3,h4];
      let [ar,br,cr,dr,er] = [h0,h1,h2,h3,h4];
      for (let j = 0; j < 80; j++) {
        let T = add(rol(add(al,f(j,bl,cl,dl),X[ML[j]],HL[Math.floor(j/16)]),SL[j]),el);
        [al,el,dl,cl,bl] = [el,dl,rol(cl,10),bl,T];
        T = add(rol(add(ar,f(79-j,br,cr,dr),X[MR[j]],HR[Math.floor(j/16)]),SR[j]),er);
        [ar,er,dr,cr,br] = [er,dr,rol(cr,10),br,T];
      }
      const T = add(h1,cl,dr);
      [h1,h2,h3,h4,h0] = [add(h2,dl,er),add(h3,el,ar),add(h4,al,br),add(h0,bl,cr),T];
    }
    const out = new Uint8Array(20);
    [h0,h1,h2,h3,h4].forEach((v,i) => new DataView(out.buffer).setUint32(i*4, v, true));
    return out;
  }

  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function base58Encode(bytes) {
    let num = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join(''));
    let result = '';
    while (num > 0n) { result = B58[Number(num % 58n)] + result; num /= 58n; }
    for (const b of bytes) { if (b === 0) result = '1' + result; else break; }
    return result;
  }

  function base58Decode(str) {
    let num = 0n;
    for (const c of str) {
      const idx = B58.indexOf(c);
      if (idx < 0) throw new Error('Invalid base58 char: ' + c);
      num = num * 58n + BigInt(idx);
    }
    let leadingZeros = 0;
    for (const c of str) { if (c === '1') leadingZeros++; else break; }
    const bytes = [];
    while (num > 0n) { bytes.unshift(Number(num & 0xffn)); num >>= 8n; }
    return new Uint8Array([...new Array(leadingZeros).fill(0), ...bytes]);
  }

  // ── Transaction building utilities (shared by BTC, LTC, DOGE) ────────────────
  function dsha256(d) { return sha256(sha256(d)); }
  function writeLE32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
  function writeLE64(n) {
    const b = new Uint8Array(8), dv = new DataView(b.buffer), bn = BigInt(n);
    dv.setUint32(0, Number(bn & 0xFFFFFFFFn), true); dv.setUint32(4, Number(bn >> 32n), true); return b;
  }
  function varint(n) {
    if (n < 0xfd) return new Uint8Array([n]);
    if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, n >> 8]);
    const b = new Uint8Array(5); b[0] = 0xfe; new DataView(b.buffer).setUint32(1, n, true); return b;
  }
  function concatBytes(...parts) {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let off = 0; for (const p of parts) { out.set(p, off); off += p.length; } return out;
  }
  function p2pkhScript(h) { return new Uint8Array([0x76, 0xa9, 0x14, ...h, 0x88, 0xac]); }
  function p2shScript(h)  { return new Uint8Array([0xa9, 0x14, ...h, 0x87]); }

  // Parse a decimal amount string into integer satoshis without losing precision.
  // Accepts "0.123", "1.23456789", "100", etc. Rejects more than 8 decimals
  // (any UTXO chain we support uses 1e-8 base units).
  function amountToSat(input) {
    const s = String(input).trim();
    if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) throw new Error('Invalid amount');
    const [intPart, fracRaw = ''] = s.split('.');
    if (fracRaw.length > 8) throw new Error('Amount has more than 8 decimal places');
    const frac = fracRaw.padEnd(8, '0');
    const sat = BigInt(intPart) * 100000000n + BigInt(frac);
    if (sat <= 0n) throw new Error('Amount must be > 0');
    if (sat > Number.MAX_SAFE_INTEGER) throw new Error('Amount exceeds safe range');
    return Number(sat);
  }

  const N_SECP = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
  function derEncode(rHex, sHex) {
    let r = BigInt('0x' + rHex), s = BigInt('0x' + sHex);
    if (s > N_SECP / 2n) s = N_SECP - s;
    function encInt(n) {
      const b = []; while (n > 0n) { b.unshift(Number(n & 0xffn)); n >>= 8n; }
      if (b[0] & 0x80) b.unshift(0x00);
      return new Uint8Array([0x02, b.length, ...b]);
    }
    const rE = encInt(r), sE = encInt(s);
    return new Uint8Array([0x30, rE.length + sE.length, ...rE, ...sE]);
  }

  function serializeTx(inputs, outputs, sigIdx = -1, subscript = null) {
    const parts = [writeLE32(1), varint(inputs.length)];
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      parts.push(hexToBytes(inp.txid).reverse(), writeLE32(inp.vout));
      if (sigIdx === i)     { parts.push(varint(subscript.length), subscript); }
      else if (sigIdx >= 0) { parts.push(varint(0)); }
      else                  { parts.push(varint(inp.scriptSig.length), inp.scriptSig); }
      parts.push(writeLE32(0xffffffff));
    }
    parts.push(varint(outputs.length));
    for (const out of outputs) parts.push(writeLE64(out.value), varint(out.script.length), out.script);
    parts.push(writeLE32(0));
    return concatBytes(...parts);
  }

  // Bech32/bech32m decoder for segwit outputs (bc1, ltc1, etc.)
  const _BC32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const _B32G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  function _b32Poly(v) {
    let c = 1;
    for (const p of v) { const t = c >> 25; c = ((c & 0x1ffffff) << 5) ^ p; for (let i = 0; i < 5; i++) if ((t >> i) & 1) c ^= _B32G[i]; }
    return c;
  }
  function _b32Hrp(h) { const r = []; for (const c of h) r.push(c.charCodeAt(0) >> 5); r.push(0); for (const c of h) r.push(c.charCodeAt(0) & 31); return r; }
  function bech32Decode(str) {
    if (str.length < 8 || str.length > 90) throw new Error('Bad bech32 length');
    const s = str.toLowerCase(), sep = s.lastIndexOf('1');
    if (sep < 1 || sep + 7 > s.length) throw new Error('Bad bech32 separator');
    const hrp = s.slice(0, sep), data = Array.from(s.slice(sep + 1), c => _BC32.indexOf(c));
    if (data.includes(-1)) throw new Error('Invalid bech32 char');
    const poly = _b32Poly([..._b32Hrp(hrp), ...data]);
    const ver = data[0];
    // BIP350: v0 uses bech32 (poly==1); v1+ (Taproot) uses bech32m (poly==0x2bc830a3).
    if (ver === 0 && poly !== 1)            throw new Error('Bad bech32 checksum (v0 requires bech32)');
    if (ver >= 1 && poly !== 0x2bc830a3)    throw new Error('Bad bech32 checksum (v1+ requires bech32m)');
    if (ver < 0 || ver > 16)                throw new Error('Bad witness version');
    const prog5 = data.slice(1, -6);
    let acc = 0, bits = 0; const prog = [];
    for (const v of prog5) {
      acc = (acc << 5) | v; bits += 5;
      while (bits >= 8) { bits -= 8; prog.push((acc >> bits) & 0xff); }
    }
    if (bits >= 5 || ((acc << (8 - bits)) & 0xff)) throw new Error('Bad bech32 padding');
    if (prog.length < 2 || prog.length > 40)        throw new Error('Bad witness program length');
    if (ver === 0 && prog.length !== 20 && prog.length !== 32) throw new Error('Bad v0 program length');
    return { witnessVersion: ver, program: new Uint8Array(prog) };
  }

  // ── Bech32 encoding (for bc1q / ltc1q Native SegWit addresses) ───────────────
  function convertBits(data, from, to, pad = true) {
    let acc = 0, bits = 0;
    const result = [], maxv = (1 << to) - 1;
    for (const val of data) {
      acc = (acc << from) | val; bits += from;
      while (bits >= to) { bits -= to; result.push((acc >> bits) & maxv); }
    }
    if (pad && bits > 0) result.push((acc << (to - bits)) & maxv);
    return result;
  }

  function bech32Encode(hrp, witnessVersion, program) {
    const data = [witnessVersion, ...convertBits(program, 8, 5)];
    const values = [..._b32Hrp(hrp), ...data, 0, 0, 0, 0, 0, 0];
    // BIP350: v0 → bech32 (XOR 1); v1+ → bech32m (XOR 0x2bc830a3)
    const xorConst = witnessVersion === 0 ? 1 : 0x2bc830a3;
    const poly = _b32Poly(values) ^ xorConst;
    const checksum = Array.from({length: 6}, (_, i) => (poly >> (5 * (5 - i))) & 31);
    return hrp + '1' + [...data, ...checksum].map(d => _BC32[d]).join('');
  }

  function p2wpkhAddress(pubKeyBytes, hrp) {
    return bech32Encode(hrp, 0, ripemd160(sha256(pubKeyBytes)));
  }

  // Convert any Bitcoin-family address to its output scriptPubKey
  // bech32Prefix: 'bc' for Bitcoin, 'ltc' for Litecoin, null for Dogecoin
  function addressToScript(addr, bech32Prefix) {
    if (bech32Prefix && addr.toLowerCase().startsWith(bech32Prefix.toLowerCase() + '1')) {
      const { witnessVersion: ver, program: prog } = bech32Decode(addr);
      return new Uint8Array([ver === 0 ? 0x00 : 0x50 + ver, prog.length, ...prog]);
    }
    const raw = base58Decode(addr);
    if (raw.length !== 25) throw new Error('Unsupported address format');
    const check = dsha256(raw.slice(0, 21)).slice(0, 4);
    if (!check.every((b, i) => b === raw[21 + i])) throw new Error('Bad address checksum');
    // P2SH version bytes: 0x05 (BTC), 0x32 (LTC)
    if (raw[0] === 0x05 || raw[0] === 0x32) return p2shScript(raw.slice(1, 21));
    return p2pkhScript(raw.slice(1, 21)); // all P2PKH variants (0x00 BTC, 0x30 LTC, 0x1e DOGE)
  }

  // Complete UTXO transaction builder + signer
  // params: { mnemonic, coinType, versionByte, bech32Prefix, toAddress, amount (decimal string),
  //           fetchUTXOs(addr)->Promise<[{txid,vout,value}]>,
  //           getFeeRate()->Promise<number>,
  //           broadcastTx(hexStr)->Promise<txid> }
  async function buildAndSendTx({ mnemonic, coinType, versionByte, bech32Prefix, toAddress, amount, fetchUTXOs, getFeeRate, broadcastTx }) {
    const seed = await bip39ToSeed(mnemonic);
    const child = ethers.HDNodeWallet.fromSeed(seed).derivePath(`m/44'/${coinType}'/0'/0/0`);
    const signingKey = new ethers.SigningKey(child.privateKey);
    const pubKeyBytes = hexToBytes(child.publicKey.replace('0x', ''));
    const fromAddress = await deriveP2PKH(mnemonic, coinType, versionByte);
    const fromHash160 = base58Decode(fromAddress).slice(1, 21);
    const fromScript = p2pkhScript(fromHash160);

    const utxos = await fetchUTXOs(fromAddress);
    if (!utxos.length) throw new Error('No spendable UTXOs — address has no confirmed balance');

    const amountSat = amountToSat(amount);
    const feeRate = await getFeeRate();
    const txOverhead = 10, perInput = 148, perOutput = 34;

    const sorted = [...utxos].sort((a, b) => b.value - a.value);
    const selected = []; let inputsSat = 0;
    for (const u of sorted) {
      selected.push(u); inputsSat += u.value;
      // Use selected.length+1 in fee estimate so we don't break out before fees are actually covered
      const projectedFee = feeRate * (perInput * (selected.length + 1) + perOutput * 2 + txOverhead);
      if (inputsSat >= amountSat + projectedFee) break;
    }
    const fee = feeRate * (perInput * selected.length + perOutput * 2 + txOverhead);
    if (inputsSat < amountSat + fee)
      throw new Error(`Insufficient balance. Need ${((amountSat + fee) / 1e8).toFixed(8)} (incl. fee ~${(fee / 1e8).toFixed(8)})`);
    const changeSat = inputsSat - amountSat - fee;

    const toScript = addressToScript(toAddress, bech32Prefix);
    const outputs = [{ value: amountSat, script: toScript }];
    const dustThreshold = Math.max(546, feeRate * 34 * 3);
    if (changeSat >= dustThreshold) outputs.push({ value: changeSat, script: fromScript });

    const inputs = selected.map(u => ({ txid: u.txid, vout: u.vout, scriptSig: new Uint8Array() }));

    for (let i = 0; i < inputs.length; i++) {
      const preimage = concatBytes(serializeTx(inputs, outputs, i, fromScript), writeLE32(1));
      const sig = signingKey.sign(dsha256(preimage));
      const der = derEncode(sig.r.slice(2), sig.s.slice(2));
      const sigWithType = new Uint8Array([...der, 0x01]);
      inputs[i].scriptSig = new Uint8Array([sigWithType.length, ...sigWithType, pubKeyBytes.length, ...pubKeyBytes]);
    }

    const rawHex = Array.from(serializeTx(inputs, outputs)).map(b => b.toString(16).padStart(2, '0')).join('');
    return broadcastTx(rawHex);
  }

  // BIP143 Native SegWit (P2WPKH) transaction builder for bc1q / ltc1q addresses
  async function buildAndSendP2WPKH({ mnemonic, coinType, hrp, toAddress, amount, fetchUTXOs, getFeeRate, broadcastTx }) {
    const seed = await bip39ToSeed(mnemonic);
    const child = ethers.HDNodeWallet.fromSeed(seed).derivePath(`m/84'/${coinType}'/0'/0/0`);
    const signingKey = new ethers.SigningKey(child.privateKey);
    const pubKeyBytes = hexToBytes(child.publicKey);
    const hash160 = ripemd160(sha256(pubKeyBytes));
    const fromAddress = bech32Encode(hrp, 0, hash160);
    const scriptCode = p2pkhScript(hash160); // 25 bytes: OP_DUP OP_HASH160 <hash160> OP_EQUALVERIFY OP_CHECKSIG

    const utxos = await fetchUTXOs(fromAddress);
    if (!utxos.length) throw new Error('No spendable UTXOs — address has no confirmed balance');

    const amountSat = amountToSat(amount);
    const feeRate = await getFeeRate();

    // P2WPKH vbytes: 10.5 overhead + 68 per input + 31 per output
    const sorted = [...utxos].sort((a, b) => b.value - a.value);
    const selected = []; let inputsSat = 0;
    for (const u of sorted) {
      selected.push(u); inputsSat += u.value;
      const projectedFee = Math.ceil(feeRate * (10.5 + 68 * (selected.length + 1) + 31 * 2));
      if (inputsSat >= amountSat + projectedFee) break;
    }
    const fee = Math.ceil(feeRate * (10.5 + 68 * selected.length + 31 * 2));
    if (inputsSat < amountSat + fee)
      throw new Error(`Insufficient balance. Need ${((amountSat + fee) / 1e8).toFixed(8)} (incl. fee ~${(fee / 1e8).toFixed(8)})`);
    const changeSat = inputsSat - amountSat - fee;

    const toScript = addressToScript(toAddress, hrp);
    const changeScript = new Uint8Array([0x00, 0x14, ...hash160]); // P2WPKH scriptPubKey
    const outputs = [{ value: amountSat, script: toScript }];
    const dustThreshold = Math.max(546, feeRate * 31 * 3);
    if (changeSat >= dustThreshold) outputs.push({ value: changeSat, script: changeScript });

    // BIP143 hashes (SIGHASH_ALL)
    const hashPrevouts = dsha256(concatBytes(...selected.map(u => concatBytes(hexToBytes(u.txid).reverse(), writeLE32(u.vout)))));
    const hashSequence = dsha256(concatBytes(...selected.map(() => writeLE32(0xffffffff))));
    const hashOutputs  = dsha256(concatBytes(...outputs.map(o => concatBytes(writeLE64(o.value), varint(o.script.length), o.script))));
    const scriptCodeWithLen = concatBytes(varint(scriptCode.length), scriptCode);

    const witnesses = [];
    for (const utxo of selected) {
      const outpoint = concatBytes(hexToBytes(utxo.txid).reverse(), writeLE32(utxo.vout));
      const preimage = concatBytes(
        writeLE32(1), hashPrevouts, hashSequence,
        outpoint, scriptCodeWithLen, writeLE64(utxo.value),
        writeLE32(0xffffffff), hashOutputs, writeLE32(0), writeLE32(1)
      );
      const sig = signingKey.sign(dsha256(preimage));
      const der = derEncode(sig.r.slice(2), sig.s.slice(2));
      witnesses.push([new Uint8Array([...der, 0x01]), pubKeyBytes]);
    }

    // Serialize segwit transaction
    const parts = [writeLE32(1), new Uint8Array([0x00, 0x01])]; // version + marker + flag
    parts.push(varint(selected.length));
    for (const u of selected) {
      parts.push(hexToBytes(u.txid).reverse(), writeLE32(u.vout), varint(0), writeLE32(0xffffffff));
    }
    parts.push(varint(outputs.length));
    for (const o of outputs) parts.push(writeLE64(o.value), varint(o.script.length), o.script);
    for (const wit of witnesses) { parts.push(varint(wit.length)); for (const item of wit) parts.push(varint(item.length), item); }
    parts.push(writeLE32(0)); // locktime

    const rawHex = Array.from(concatBytes(...parts)).map(b => b.toString(16).padStart(2, '0')).join('');
    return broadcastTx(rawHex);
  }

  // BIP39 passphrase ("25th word"). Per BIP39 the salt is
  // "mnemonic" + passphrase (NFKD-normalized). Empty passphrase ('')
  // gives the standard derivation, so existing wallets are unaffected.
  function _pp() { return (typeof window !== 'undefined' && window.getPassphrase) ? window.getPassphrase() : ''; }

  async function bip39ToSeed(mnemonic) {
    const enc = new TextEncoder();
    const passphrase = _pp();
    const key = await crypto.subtle.importKey('raw', enc.encode(mnemonic.normalize('NFKD')), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(('mnemonic' + passphrase).normalize('NFKD')), iterations: 2048, hash: 'SHA-512' },
      key, 512
    );
    return new Uint8Array(bits);
  }

  // Derive a P2PKH address for any UTXO coin
  async function deriveP2PKH(mnemonic, coinType, versionByte) {
    const seed = await bip39ToSeed(mnemonic);
    const hdNode = ethers.HDNodeWallet.fromSeed(seed);
    const child = hdNode.derivePath(`m/44'/${coinType}'/0'/0/0`);
    const pubkeyBytes = hexToBytes(child.publicKey);
    const hash160 = ripemd160(sha256(pubkeyBytes));
    const versioned = new Uint8Array([versionByte, ...hash160]);
    const checksum = sha256(sha256(versioned)).slice(0, 4);
    return base58Encode(new Uint8Array([...versioned, ...checksum]));
  }

  async function deriveP2WPKH(mnemonic, coinType, hrp) {
    const seed = await bip39ToSeed(mnemonic);
    const child = ethers.HDNodeWallet.fromSeed(seed).derivePath(`m/84'/${coinType}'/0'/0/0`);
    return p2wpkhAddress(hexToBytes(child.publicKey), hrp);
  }

  return { hexToBytes, sha256, ripemd160, base58Encode, base58Decode, bip39ToSeed,
           deriveP2PKH, deriveP2WPKH, buildAndSendTx, buildAndSendP2WPKH, addressToScript };
})();

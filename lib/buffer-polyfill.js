// Minimal Buffer polyfill for Solana web3.js running inside the Capacitor
// WebView (no Node, so no native Buffer). Covers the subset of the Node
// Buffer API that @solana/web3.js@1.95.4 actually uses:
//   Buffer.from(string|Uint8Array|Array|ArrayBuffer, encoding?)
//   Buffer.alloc(size, fill?)
//   Buffer.concat(buffers, totalLen?)
//   Buffer.isBuffer(obj)
//   inst.toString('hex'|'utf8'|'base64', start?, end?)
//   inst.equals(other)
//   inst.slice(start, end)
//   inst.readUInt8/16/32 + writeUInt8/16/32 (BE + LE)
//
// Buffer is a Uint8Array subclass so all the typed-array methods (set,
// subarray, indexed access) Just Work.
//
// Note: this script must run BEFORE @solana/web3.js. The web3.js IIFE
// captures `typeof Buffer` at load time, so a polyfill installed later
// won't help.

(function () {
  if (typeof window === 'undefined') return;
  if (typeof window.Buffer !== 'undefined' && window.Buffer.from && window.Buffer.alloc) return;

  function hexToBytes(hex) {
    if (hex.length % 2) hex = '0' + hex;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function utf8ToBytes(str) { return new TextEncoder().encode(str); }
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  class Buffer extends Uint8Array {
    static from(value, encoding) {
      if (typeof value === 'string') {
        if (encoding === 'hex')    return new Buffer(hexToBytes(value));
        if (encoding === 'base64') return new Buffer(base64ToBytes(value));
        return new Buffer(utf8ToBytes(value));
      }
      if (value instanceof Buffer)       return value;
      if (value instanceof Uint8Array)   return new Buffer(value.buffer, value.byteOffset, value.byteLength);
      if (value instanceof ArrayBuffer)  return new Buffer(value);
      if (Array.isArray(value))          return new Buffer(value);
      // Buffer.from(N) is NOT valid in the Node API (since 4.x). Refuse.
      if (typeof value === 'number')     throw new TypeError('Use Buffer.alloc() instead of Buffer.from(number)');
      return new Buffer(value);
    }
    static alloc(size, fill) {
      const buf = new Buffer(size);
      if (fill !== undefined) buf.fill(fill);
      return buf;
    }
    static allocUnsafe(size) { return new Buffer(size); }
    static concat(list, totalLen) {
      if (!Array.isArray(list)) list = Array.from(list);
      if (totalLen === undefined) totalLen = list.reduce((s, a) => s + a.length, 0);
      const out = new Buffer(totalLen);
      let off = 0;
      for (const a of list) {
        if (off + a.length > totalLen) { out.set(a.subarray(0, totalLen - off), off); break; }
        out.set(a, off);
        off += a.length;
      }
      return out;
    }
    static isBuffer(o) { return o instanceof Buffer; }

    toString(encoding, start, end) {
      const sub = (start === undefined && end === undefined) ? this : this.subarray(start, end);
      if (!encoding || encoding === 'utf8' || encoding === 'utf-8') {
        return new TextDecoder().decode(sub);
      }
      if (encoding === 'hex') {
        let s = '';
        for (let i = 0; i < sub.length; i++) s += sub[i].toString(16).padStart(2, '0');
        return s;
      }
      if (encoding === 'base64') {
        let s = '';
        for (let i = 0; i < sub.length; i++) s += String.fromCharCode(sub[i]);
        return btoa(s);
      }
      if (encoding === 'ascii' || encoding === 'binary' || encoding === 'latin1') {
        let s = '';
        for (let i = 0; i < sub.length; i++) s += String.fromCharCode(sub[i]);
        return s;
      }
      return new TextDecoder().decode(sub);
    }

    equals(other) {
      if (!other || this.length !== other.length) return false;
      for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
      return true;
    }

    // Uint8Array.slice returns a copy; we override to keep it a Buffer so
    // chained calls (.slice().equals(), etc.) keep working.
    slice(start, end) {
      return Buffer.from(Uint8Array.prototype.subarray.call(this, start, end));
    }

    fill(value, offset, end) {
      offset = offset || 0;
      end = (end === undefined) ? this.length : end;
      if (typeof value === 'string') value = value.charCodeAt(0);
      for (let i = offset; i < end; i++) this[i] = value & 0xff;
      return this;
    }

    // ── Integer reads / writes (BE + LE). Used internally by Solana
    //    transaction encoding for amounts, slot numbers, etc.
    readUInt8(offset)          { return this[offset]; }
    readUInt16BE(offset)       { return (this[offset] << 8) | this[offset + 1]; }
    readUInt32BE(offset)       { return ((this[offset] << 24) | (this[offset+1] << 16) | (this[offset+2] << 8) | this[offset+3]) >>> 0; }
    readUInt16LE(offset)       { return this[offset] | (this[offset + 1] << 8); }
    readUInt32LE(offset)       { return (this[offset] | (this[offset+1] << 8) | (this[offset+2] << 16) | (this[offset+3] << 24)) >>> 0; }
    writeUInt8(value, offset)  { this[offset] = value & 0xff; return offset + 1; }
    writeUInt16BE(value, offset){ this[offset] = (value >> 8) & 0xff; this[offset+1] = value & 0xff; return offset + 2; }
    writeUInt32BE(value, offset){
      this[offset]   = (value >>> 24) & 0xff;
      this[offset+1] = (value >>> 16) & 0xff;
      this[offset+2] = (value >>> 8)  & 0xff;
      this[offset+3] = value & 0xff;
      return offset + 4;
    }
    writeUInt16LE(value, offset){ this[offset] = value & 0xff; this[offset+1] = (value >> 8) & 0xff; return offset + 2; }
    writeUInt32LE(value, offset){
      this[offset]   = value & 0xff;
      this[offset+1] = (value >>> 8)  & 0xff;
      this[offset+2] = (value >>> 16) & 0xff;
      this[offset+3] = (value >>> 24) & 0xff;
      return offset + 4;
    }
    // Aliased to BE/LE so calling code can use either name.
    readInt8(offset)           { const v = this[offset]; return v & 0x80 ? v - 256 : v; }
    readBigUInt64LE(offset) {
      offset = offset || 0;
      const lo = BigInt(this.readUInt32LE(offset));
      const hi = BigInt(this.readUInt32LE(offset + 4));
      return (hi << 32n) | lo;
    }
    writeBigUInt64LE(value, offset) {
      offset = offset || 0;
      const v = BigInt(value);
      this.writeUInt32LE(Number(v & 0xFFFFFFFFn), offset);
      this.writeUInt32LE(Number((v >> 32n) & 0xFFFFFFFFn), offset + 4);
      return offset + 8;
    }
  }

  window.Buffer = Buffer;
  // Some bundles look for it on globalThis.
  if (typeof globalThis !== 'undefined') globalThis.Buffer = Buffer;
})();

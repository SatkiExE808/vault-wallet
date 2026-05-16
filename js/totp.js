// RFC 6238 TOTP (Google Authenticator-compatible) — pure browser crypto.
//
// Threat model: same per-device shoulder-surfing / casual-malware tier as
// before. With the H2 fix the base32 secret now lives in native
// SecureStorage (iOS Keychain / Android Keystore) instead of plaintext
// localStorage, so a localStorage read alone can't compute codes anymore.
// Attackers with full app-level execution still can — TOTP is friction,
// not a hard root-of-trust.
const TwoFA = (() => {
  const LEGACY_LS_KEY = 'vault.totp_secret'; // pre-H2 plaintext entry
  const SS_PREFIX = 'capacitor-storage_';
  const SS_KEY    = 'vault.totp_secret';
  const ISSUER = 'Vault Wallet';
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const STEP = 30; // RFC 6238 default

  // SecureStorage shim — same pattern as settings.js _bioKey* helpers
  // (C2). Native (Capacitor) goes through @aparajita/capacitor-secure-
  // storage → iOS Keychain / Android Keystore. Browser PWA has no OS
  // keychain access and falls back to localStorage under SS_KEY (still
  // an improvement over the legacy plaintext name because it doesn't
  // co-locate with the wallet's encrypted-blob entries by convention).
  async function _ssSet(value) {
    const ss = window.Capacitor?.Plugins?.SecureStorage;
    if (ss?.internalSetItem) {
      await ss.internalSetItem({
        prefixedKey: SS_PREFIX + SS_KEY,
        data: JSON.stringify(value),
        sync: false,
        access: 0, // KeychainAccess.whenUnlocked
      });
      return;
    }
    localStorage.setItem(SS_KEY, value);
  }
  async function _ssGet() {
    const ss = window.Capacitor?.Plugins?.SecureStorage;
    if (ss?.internalGetItem) {
      try {
        const r = await ss.internalGetItem({ prefixedKey: SS_PREFIX + SS_KEY, sync: false });
        if (r?.data == null) return null;
        try { return JSON.parse(r.data); } catch { return r.data; }
      } catch { return null; }
    }
    return localStorage.getItem(SS_KEY);
  }
  async function _ssRemove() {
    const ss = window.Capacitor?.Plugins?.SecureStorage;
    if (ss?.internalRemoveItem) {
      try { await ss.internalRemoveItem({ prefixedKey: SS_PREFIX + SS_KEY }); } catch {}
    }
    localStorage.removeItem(SS_KEY);
  }

  // In-memory cache populated asynchronously at boot — TOTP prompts only
  // fire on user-initiated send/stake actions, by which time the load
  // has long since resolved. isEnabled() returns the cached state for
  // synchronous UI bindings.
  let _cached = null;
  const ready = (async () => {
    try {
      let v = await _ssGet();
      if (!v) {
        // Migrate from the legacy plaintext localStorage entry.
        const legacy = localStorage.getItem(LEGACY_LS_KEY);
        if (legacy) {
          try { await _ssSet(legacy); v = legacy; localStorage.removeItem(LEGACY_LS_KEY); }
          catch (e) { console.warn('TOTP H2 migration failed:', e); }
        }
      }
      _cached = v || null;
    } catch (e) { console.warn('TOTP load failed:', e); }
  })();

  function isEnabled() { return !!_cached; }
  function getSecret() { return _cached || ''; }
  async function setSecret(secret) {
    _cached = secret;
    await _ssSet(secret);
  }
  async function disable() {
    _cached = null;
    await _ssRemove();
  }

  // Generate a fresh 20-byte (160-bit) secret encoded as base32.
  function generateSecret() {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    return base32Encode(bytes);
  }

  function base32Encode(bytes) {
    let bits = 0, value = 0, out = '';
    for (const b of bytes) {
      value = (value << 8) | b;
      bits += 8;
      while (bits >= 5) {
        out += ALPHABET[(value >>> (bits - 5)) & 0x1f];
        bits -= 5;
      }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 0x1f];
    return out;
  }

  function base32Decode(str) {
    str = str.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
    let bits = 0, value = 0;
    const out = [];
    for (const c of str) {
      const i = ALPHABET.indexOf(c);
      if (i < 0) continue;
      value = (value << 5) | i;
      bits += 5;
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return new Uint8Array(out);
  }

  // Compute the 6-digit TOTP code for a given secret and timestamp.
  async function code(secretB32, atMs = Date.now()) {
    const key = base32Decode(secretB32);
    if (!key.length) return '';
    const counter = Math.floor(atMs / 1000 / STEP);
    const buf = new ArrayBuffer(8);
    new DataView(buf).setUint32(4, counter, false); // big-endian, low 32 bits
    const cryptoKey = await crypto.subtle.importKey(
      'raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, buf));
    const offset = sig[19] & 0xf;
    const num = ((sig[offset] & 0x7f) << 24)
              | ((sig[offset + 1] & 0xff) << 16)
              | ((sig[offset + 2] & 0xff) <<  8)
              | (sig[offset + 3]  & 0xff);
    return String(num % 1_000_000).padStart(6, '0');
  }

  // Verify entered code against ±1 window for clock skew.
  async function verify(entered) {
    if (!isEnabled()) return true; // not configured = pass-through
    const sanitized = String(entered || '').replace(/\D/g, '').slice(0, 6);
    if (sanitized.length !== 6) return false;
    const secret = getSecret();
    const now = Date.now();
    for (const skew of [0, -STEP * 1000, STEP * 1000]) {
      if ((await code(secret, now + skew)) === sanitized) return true;
    }
    return false;
  }

  function buildOtpAuthUri(secretB32, label = 'wallet') {
    return `otpauth://totp/${encodeURIComponent(ISSUER)}:${encodeURIComponent(label)}`
         + `?secret=${secretB32}&issuer=${encodeURIComponent(ISSUER)}`
         + `&algorithm=SHA1&digits=6&period=${STEP}`;
  }

  // Modal that asks the user for the current 6-digit code before continuing.
  // Resolves on correct code, rejects on Cancel / wrong code 3 times.
  function prompt() {
    return new Promise((resolve, reject) => {
      const root = document.createElement('div');
      root.className = 'modal-backdrop';
      root.innerHTML = `<div class="modal">
        <h2>🔐 Two-Factor Code</h2>
        <p>Enter the 6-digit code from your authenticator app to confirm.</p>
        <div class="form-group">
          <input id="totp-input" inputmode="numeric" pattern="[0-9]*" maxlength="6"
                 placeholder="123456" autocomplete="one-time-code" autofocus
                 style="text-align:center;font-size:24px;letter-spacing:8px">
        </div>
        <div id="totp-err" style="color:var(--red);font-size:13px;min-height:18px"></div>
        <div class="modal-actions">
          <button class="btn btn-outline" id="totp-cancel">Cancel</button>
          <button class="btn btn-primary" id="totp-ok">Continue</button>
        </div>
      </div>`;
      document.body.appendChild(root);
      const close = () => root.remove();
      const input = root.querySelector('#totp-input');
      const err = root.querySelector('#totp-err');
      let attempts = 0;
      const submit = async () => {
        const v = input.value.trim();
        if (v.length !== 6) { err.textContent = 'Enter 6 digits'; return; }
        if (await verify(v)) { close(); resolve(); return; }
        attempts++;
        if (attempts >= 3) { close(); reject(new Error('Too many wrong 2FA codes')); return; }
        err.textContent = `Wrong code (${3 - attempts} ${3 - attempts === 1 ? 'try' : 'tries'} left)`;
        input.value = '';
      };
      root.querySelector('#totp-ok').onclick = submit;
      root.querySelector('#totp-cancel').onclick = () => { close(); reject(new Error('Cancelled')); };
      root.addEventListener('click', e => {
        if (e.target === root) { close(); reject(new Error('Cancelled')); }
      });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
      // Auto-submit when 6 digits are entered (matches authenticator UX)
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(0, 6);
        if (input.value.length === 6) submit();
      });
    });
  }

  return { isEnabled, getSecret, setSecret, disable, generateSecret, code, verify, buildOtpAuthUri, prompt, ready };
})();

window.TwoFA = TwoFA;

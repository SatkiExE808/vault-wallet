// Settings: Show Seed, Change Password, Manage Assets, Biometric, Lock
(() => {
  const $ = id => document.getElementById(id);

  // ── Modal helpers ──────────────────────────────────────────
  function modal(html, onMount) {
    const root = document.createElement('div');
    root.className = 'modal-backdrop';
    root.innerHTML = `<div class="modal">${html}</div>`;
    document.body.appendChild(root);
    const close = () => root.remove();
    root.addEventListener('click', e => { if (e.target === root) close(); });
    if (onMount) onMount(root, close);
    return { root, close };
  }

  // Verify user identity via biometric (if enabled) or password.
  // Returns a Promise that resolves on success and rejects on cancel/fail.
  // Used to gate sensitive actions like sending crypto.
  function verifyAuth(reason = 'Verify it\'s you') {
    return new Promise((resolve, reject) => {
      const tryBiometric = async () => {
        if (!window.biometricEnabled?.()) return false;
        try {
          const method = localStorage.getItem('biometric_method') || 'webauthn';
          if (method === 'native') {
            const native = getNativePlugin();
            if (!native) return false;
            await native.internalAuthenticate({
              reason,
              cancelTitle: 'Use password',
              androidTitle: 'Vault Wallet',
              androidSubtitle: reason,
            });
            return true;
          } else {
            const credIdB64 = localStorage.getItem('biometric_credential_id');
            if (!credIdB64 || !window.PublicKeyCredential) return false;
            const credIdBytes = Uint8Array.from(atob(credIdB64), c => c.charCodeAt(0));
            await navigator.credentials.get({
              publicKey: {
                challenge: crypto.getRandomValues(new Uint8Array(32)),
                allowCredentials: [{ type: 'public-key', id: credIdBytes }],
                userVerification: 'required',
                timeout: 60000,
              },
            });
            return true;
          }
        } catch { return false; }
      };

      // After whichever first factor succeeds, optionally chain TOTP if
      // the user enabled 2FA. Any signing path that gates on verifyAuth
      // (send, stake, earn, sweep) automatically inherits the second factor.
      const finishWith2FA = () => {
        if (window.TwoFA?.isEnabled?.()) {
          window.TwoFA.prompt().then(resolve).catch(reject);
        } else {
          resolve();
        }
      };
      tryBiometric().then(ok => {
        if (ok) { finishWith2FA(); return; }
        passwordModal({
          title: '🔒 Confirm with password',
          message: reason,
          onSubmit: async (_pwd, close) => { close(); finishWith2FA(); },
          onCancel: () => reject(new Error('Cancelled')),
        });
      });
    });
  }
  window.verifyAuth = verifyAuth;

  function passwordModal({ title, message, onSubmit, onCancel }) {
    let settled = false;
    return modal(`
      <h2>${title}</h2>
      <p>${message}</p>
      <div class="form-group">
        <label>Password</label>
        <input type="password" id="pw-input" autocomplete="current-password" autofocus>
      </div>
      <div id="pw-err" style="color:var(--red);font-size:13px;min-height:18px"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="pw-cancel">Cancel</button>
        <button class="btn btn-primary" id="pw-ok">Continue</button>
      </div>
    `, (root, close) => {
      const cancelAndClose = () => {
        if (settled) return;
        settled = true;
        close();
        onCancel?.();
      };
      // Wrap close so submit handlers can call it without firing onCancel
      const closeSubmitted = () => { settled = true; close(); };
      const input = root.querySelector('#pw-input');
      const err = root.querySelector('#pw-err');
      const submit = async () => {
        err.textContent = '';
        const pwd = input.value;
        if (!pwd) { err.textContent = 'Enter your password'; return; }
        try {
          const decrypted = await decryptMnemonic(localStorage.getItem('wallet_encrypted'), pwd);
          if (decrypted !== state.mnemonic) throw new Error('Wrong password');
          await onSubmit(pwd, closeSubmitted);
        } catch (e) {
          err.textContent = e.message || 'Wrong password';
        }
      };
      root.querySelector('#pw-ok').onclick = submit;
      root.querySelector('#pw-cancel').onclick = cancelAndClose;
      // Backdrop click also counts as cancel
      root.addEventListener('click', e => { if (e.target === root) cancelAndClose(); });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    });
  }

  // ── Show recovery phrase ───────────────────────────────────
  function showSeed() {
    passwordModal({
      title: '🔑 Show Recovery Phrase',
      message: 'Enter your password to reveal your 12-word recovery phrase. <strong style="color:var(--accent2)">Never share it with anyone.</strong>',
      onSubmit: async (pwd, closeFirst) => {
        closeFirst();
        const words = state.mnemonic.split(' ');
        modal(`
          <h2>Recovery Phrase</h2>
          <div class="warning-box">
            ⚠️ Anyone with these 12 words can take all your funds. Never share them, never type them on a website. Write them on paper and store offline.
          </div>
          <button class="btn btn-primary btn-sm" id="seed-copy" style="width:100%;margin-bottom:12px">⧉ Copy all 12 words</button>
          <div class="seed-display">
            ${words.map((w, i) => `<div class="seed-word"><span>${i + 1}</span>${w}</div>`).join('')}
          </div>
          <div class="modal-actions" style="grid-template-columns:1fr;margin-top:14px">
            <button class="btn btn-outline" id="seed-done">I've saved it — close</button>
          </div>
        `, (root, close) => {
          root.querySelector('#seed-done').onclick = close;
          root.querySelector('#seed-copy').onclick = async () => {
            try { await navigator.clipboard.writeText(words.join(' ')); toast('Recovery phrase copied — clear your clipboard after saving it'); }
            catch { toast('Copy failed'); }
          };
        });
      },
    });
  }

  // ── Change password ────────────────────────────────────────
  function changePassword() {
    passwordModal({
      title: '🔒 Change Password',
      message: 'First, enter your <strong>current</strong> password.',
      onSubmit: async (oldPwd, closeFirst) => {
        closeFirst();
        modal(`
          <h2>New Password</h2>
          <p>Pick a new password. You'll need it to unlock your wallet from now on.</p>
          <div class="form-group">
            <label>New password (min 8 characters)</label>
            <input type="password" id="np1" autocomplete="new-password" autofocus>
          </div>
          <div class="form-group">
            <label>Confirm new password</label>
            <input type="password" id="np2" autocomplete="new-password">
          </div>
          <div id="np-err" style="color:var(--red);font-size:13px;min-height:18px"></div>
          <div class="modal-actions">
            <button class="btn btn-outline" id="np-cancel">Cancel</button>
            <button class="btn btn-primary" id="np-ok">Save</button>
          </div>
        `, (root, close) => {
          const err = root.querySelector('#np-err');
          const submit = async () => {
            err.textContent = '';
            const p1 = root.querySelector('#np1').value;
            const p2 = root.querySelector('#np2').value;
            if (p1.length < 8) { err.textContent = 'Password must be at least 8 characters'; return; }
            if (p1 !== p2) { err.textContent = "Passwords don't match"; return; }
            try {
              const newEncrypted = await encryptMnemonic(state.mnemonic, p1);
              localStorage.setItem('wallet_encrypted', newEncrypted);
              // Verify round-trip
              const back = await decryptMnemonic(newEncrypted, p1);
              if (back !== state.mnemonic) throw new Error('Verification failed');
              // Disable biometric (old encrypted password is now stale)
              if (localStorage.getItem('biometric_enabled')) {
                localStorage.removeItem('biometric_enabled');
                localStorage.removeItem('biometric_credential_id');
                localStorage.removeItem('biometric_blob');
              }
              close();
              toast('Password updated. Biometric was disabled — re-enable in Settings.');
            } catch (e) {
              err.textContent = e.message || 'Failed to change password';
            }
          };
          root.querySelector('#np-ok').onclick = submit;
          root.querySelector('#np-cancel').onclick = close;
        });
      },
    });
  }

  // ── Biometric ──────────────────────────────────────────────
  // Two paths:
  //  1. Capacitor app → use @aparajita/capacitor-biometric-auth native plugin
  //  2. Browser PWA   → fall back to WebAuthn
  function getNativePlugin() {
    // Plugin registers itself on the Capacitor bridge as "BiometricAuthNative"
    return window.Capacitor?.Plugins?.BiometricAuthNative
        || window.Capacitor?.Plugins?.BiometricAuth
        || null;
  }

  async function biometricSupported() {
    const native = getNativePlugin();
    if (native) {
      try {
        const r = await native.checkBiometry();
        // r = { isAvailable, biometryType, reason, code }
        if (!r.isAvailable) return { ok: false, reason: r.reason || 'Biometric not available on this device' };
        return { ok: true, native: true };
      } catch (e) {
        return { ok: false, reason: 'Biometric check failed: ' + (e.message || e.code || e) };
      }
    }
    // Browser fallback: WebAuthn
    if (!window.PublicKeyCredential || !navigator.credentials || !navigator.credentials.create) return { ok: false, reason: 'WebAuthn API not available in this browser' };
    if (!window.isSecureContext) return { ok: false, reason: 'Page must be loaded over HTTPS' };
    try {
      const platformAvailable = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      if (!platformAvailable) return { ok: false, reason: 'No Face ID / fingerprint configured on this device' };
      return { ok: true, native: false };
    } catch (e) {
      return { ok: false, reason: 'Platform authenticator check failed: ' + (e.message || e.name) };
    }
  }

  async function enableBiometric() {
    const support = await biometricSupported();
    if (!support.ok) { toast(support.reason); return; }

    passwordModal({
      title: '👆 Enable Biometric Unlock',
      message: 'Enter your password to enable Face ID / fingerprint unlock.',
      onSubmit: async (pwd, closeFirst) => {
        try {
          if (support.native) {
            // Native plugin path: just verify biometric works, then store password
            // encrypted with a random key. The plugin's authenticate() prompt is
            // the gate to retrieving them on unlock.
            const native = getNativePlugin();
            await native.internalAuthenticate({
              reason: 'Enable biometric unlock for Vault',
              cancelTitle: 'Cancel',
              androidTitle: 'Vault Wallet',
              androidSubtitle: 'Verify it\'s you to enable biometric',
            });
          } else {
            // WebAuthn path
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const userId = crypto.getRandomValues(new Uint8Array(16));
            const cred = await navigator.credentials.create({
              publicKey: {
                challenge,
                rp:   { name: 'Vault Wallet' },
                user: { id: userId, name: 'wallet', displayName: 'Vault User' },
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
                authenticatorSelection: {
                  authenticatorAttachment: 'platform',
                  userVerification:        'required',
                  residentKey:             'preferred',
                },
                timeout: 60000,
                attestation: 'none',
              },
            });
            if (!cred) throw new Error('Biometric setup cancelled');
            localStorage.setItem('biometric_credential_id', btoa(String.fromCharCode(...new Uint8Array(cred.rawId))));
          }

          // Encrypt password with random key. The biometric prompt at unlock is
          // the gate that decides whether the saved key gets used.
          const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const enc = new TextEncoder();
          const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(pwd));
          const rawKey = await crypto.subtle.exportKey('raw', aesKey);
          const blob = btoa(String.fromCharCode(...iv, ...new Uint8Array(rawKey), ...new Uint8Array(ct)));

          localStorage.setItem('biometric_enabled', '1');
          localStorage.setItem('biometric_method', support.native ? 'native' : 'webauthn');
          localStorage.setItem('biometric_blob', blob);
          closeFirst();
          toast('✓ Biometric unlock enabled');
          renderSettingsTab();
        } catch (e) {
          closeFirst();
          toast('Biometric setup failed: ' + (e.message || e.code || e.name));
        }
      },
    });
  }

  function clearBiometric() {
    // localStorage can throw in private-browsing / quota-exceeded modes.
    // Swallow so the calling close()-then-clear flow can't leave a modal stuck.
    try {
      localStorage.removeItem('biometric_enabled');
      localStorage.removeItem('biometric_credential_id');
      localStorage.removeItem('biometric_blob');
      localStorage.removeItem('biometric_method');
    } catch (e) { console.warn('clearBiometric:', e); }
    toast('Biometric disabled');
    try { renderSettingsTab(); } catch {}
  }

  async function disableBiometric() {
    // Require either biometric verification or password to disable, so a
    // shoulder-surfer who grabs the unlocked phone can't disable the lock.
    const method = localStorage.getItem('biometric_method') || 'webauthn';
    if (method === 'native') {
      const native = getNativePlugin();
      if (native) {
        try {
          await native.internalAuthenticate({
            reason: 'Disable biometric unlock',
            cancelTitle: 'Cancel',
            androidTitle: 'Disable Biometric',
            androidSubtitle: 'Verify it\'s you to turn off biometric unlock',
          });
          clearBiometric();
          return;
        } catch (e) {
          toast('Biometric verification cancelled');
          return;
        }
      }
    } else {
      // WebAuthn — try the same credential we registered
      const credIdB64 = localStorage.getItem('biometric_credential_id');
      if (credIdB64 && window.PublicKeyCredential) {
        try {
          const credIdBytes = Uint8Array.from(atob(credIdB64), c => c.charCodeAt(0));
          await navigator.credentials.get({
            publicKey: {
              challenge: crypto.getRandomValues(new Uint8Array(32)),
              allowCredentials: [{ type: 'public-key', id: credIdBytes }],
              userVerification: 'required',
              timeout: 60000,
            },
          });
          clearBiometric();
          return;
        } catch (e) {
          // Fall through to password
        }
      }
    }
    // Fallback: password verification
    passwordModal({
      title: 'Disable Biometric Unlock',
      message: 'Enter your password to confirm.',
      onSubmit: async (_pwd, close) => { close(); clearBiometric(); },
    });
  }

  // ── Unlock with biometric ──────────────────────────────────
  async function unlockWithBiometric() {
    const blobB64 = localStorage.getItem('biometric_blob');
    if (!blobB64) throw new Error('Biometric not configured');
    const method = localStorage.getItem('biometric_method') || 'webauthn';

    if (method === 'native') {
      const native = getNativePlugin();
      if (!native) throw new Error('Native biometric plugin not available — reinstall app');
      await native.internalAuthenticate({
        reason: 'Unlock Vault wallet',
        cancelTitle: 'Cancel',
        androidTitle: 'Unlock Vault',
        androidSubtitle: 'Verify it\'s you',
      });
    } else {
      const credIdB64 = localStorage.getItem('biometric_credential_id');
      if (!credIdB64) throw new Error('Biometric credential missing — re-enable biometric');
      const credIdBytes = Uint8Array.from(atob(credIdB64), c => c.charCodeAt(0));
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ type: 'public-key', id: credIdBytes }],
          userVerification: 'required',
          timeout: 60000,
        },
      });
      if (!assertion) throw new Error('Biometric verification cancelled');
    }

    const blobBytes = Uint8Array.from(atob(blobB64), c => c.charCodeAt(0));
    const iv = blobBytes.slice(0, 12);
    const rawKey = blobBytes.slice(12, 12 + 32);
    const ct = blobBytes.slice(12 + 32);
    const aesKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    const pwdBytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
    return new TextDecoder().decode(pwdBytes);
  }
  window.unlockWithBiometric = unlockWithBiometric;
  window.biometricEnabled = () => localStorage.getItem('biometric_enabled') === '1';

  // ── Manage assets (uses existing app.js renderSettingsList) ─
  function showManageAssets() {
    if (typeof renderSettingsList === 'function') renderSettingsList();
    const overlay = $('settings-overlay');
    if (overlay) {
      overlay.style.display = 'flex';
      // home.js converts style.display=flex to .show class
    }
  }

  // ── Wire settings menu items ───────────────────────────────
  function renderSettingsTab() {
    // Update biometric label
    const bioBtn = $('menu-biometric');
    if (bioBtn) {
      const enabled = window.biometricEnabled?.();
      bioBtn.querySelector('.menu-label').textContent = enabled
        ? 'Disable Biometric Unlock'
        : 'Enable Face ID / Biometric';
    }
    // Re-sync the right-side value labels so they reflect the live state
    // (e.g. after import-with-passphrase, the page-load wire() ran while
    // the flag was still off, so without this refresh the menu shows "Off"
    // even though the passphrase is active).
    refreshCurrencyLabel();
    refresh2FALabel();
    refreshPassphraseLabel();
  }
  window.renderSettingsTab = renderSettingsTab;

  // ── Check for updates ──────────────────────────────────────
  async function checkForUpdates() {
    toast('Checking for updates…');
    try {
      // Force-fetch the SW file with cache-bust to trigger a new install
      const r = await fetch('./sw.js?cb=' + Date.now(), { cache: 'no-store' });
      const text = await r.text();
      const match = text.match(/CACHE\s*=\s*['"]([^'"]+)['"]/);
      const remoteVer = match ? match[1] : '?';
      const localVer  = (await caches.keys()).find(k => k.startsWith('vault-')) || '?';

      // Tell the SW to update
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
      }

      if (remoteVer !== localVer) {
        if (confirm(`Update available: ${localVer} → ${remoteVer}\n\nReload now?`)) {
          // Clear all caches so the new version is fetched fresh
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
          location.reload();
        }
      } else {
        toast(`You're up to date (${localVer})`);
      }
    } catch (e) {
      toast('Update check failed: ' + (e.message || e.name));
    }
  }

  // ── Display Currency picker ────────────────────────────────
  const CURRENCY_OPTIONS = [
    { code: 'usd', label: 'US Dollar' },
    { code: 'eur', label: 'Euro' },
    { code: 'gbp', label: 'British Pound' },
    { code: 'jpy', label: 'Japanese Yen' },
    { code: 'cny', label: 'Chinese Yuan' },
    { code: 'inr', label: 'Indian Rupee' },
    { code: 'idr', label: 'Indonesian Rupiah' },
    { code: 'php', label: 'Philippine Peso' },
    { code: 'myr', label: 'Malaysian Ringgit' },
    { code: 'sgd', label: 'Singapore Dollar' },
    { code: 'thb', label: 'Thai Baht' },
    { code: 'aud', label: 'Australian Dollar' },
    { code: 'cad', label: 'Canadian Dollar' },
    { code: 'krw', label: 'Korean Won' },
  ];

  function refreshCurrencyLabel() {
    const el = document.getElementById('menu-currency-value');
    if (!el) return;
    const ccy = (window.getDisplayCurrency?.() || 'usd').toUpperCase();
    el.textContent = `${ccy} ›`;
  }
  function refresh2FALabel() {
    const el = document.getElementById('menu-2fa-value');
    if (!el) return;
    el.textContent = window.TwoFA?.isEnabled?.() ? 'On ›' : 'Off ›';
  }
  function refreshPassphraseLabel() {
    const el = document.getElementById('menu-passphrase-value');
    if (!el) return;
    el.textContent = window.isPassphraseEnabled?.() ? 'On ›' : 'Off ›';
  }

  // ── Two-Factor (TOTP) setup ────────────────────────────────
  function show2FAFlow() {
    // Hard-fail if the TOTP module didn't load — better than a silent
    // 'nothing happens when I tap' UX, which is what the user reported.
    if (!window.TwoFA) {
      toast('Two-factor module failed to load — refresh the app');
      return;
    }
    if (window.TwoFA.isEnabled()) {
      modal(`
        <h2>🔐 Two-Factor Enabled</h2>
        <p>Every send / stake / earn / sweep currently requires a 6-digit code from your authenticator app on top of biometric/password.</p>
        <div class="modal-actions">
          <button class="btn btn-outline" id="ta-close">Close</button>
          <button class="btn btn-danger" id="ta-disable">Disable 2FA</button>
        </div>
      `, (root, close) => {
        root.querySelector('#ta-close').onclick = close;
        root.querySelector('#ta-disable').onclick = async () => {
          if (!confirm('Turn off two-factor authentication?')) return;
          try { await verifyAuth('Disable two-factor'); }
          catch { return; }
          window.TwoFA.disable();
          refresh2FALabel();
          close();
          toast('Two-factor disabled');
        };
      });
      return;
    }

    // Not enabled — generate a fresh secret and walk the user through setup.
    const secret = window.TwoFA.generateSecret();
    const label = (state.addresses?.BTC || 'wallet').slice(0, 12);
    const uri = window.TwoFA.buildOtpAuthUri(secret, label);
    // Format the secret in 4-char groups so it's easier to type into apps
    // that don't support QR scanning.
    const secretGrouped = secret.replace(/(.{4})/g, '$1 ').trim();
    modal(`
      <h2>🔐 Set up Two-Factor</h2>
      <p style="font-size:13px">Scan with Google Authenticator, Authy, or any TOTP app — then enter the 6-digit code to confirm.</p>
      <div class="qr-container"><div id="ta-qr"></div></div>
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:14px">
        <div style="font-size:11px;color:var(--text2);margin-bottom:4px">Or enter this secret manually:</div>
        <div style="display:flex;align-items:center;gap:8px">
          <code id="ta-secret" style="flex:1;font-size:13px;color:var(--accent2);word-break:break-all;font-family:ui-monospace,monospace">${secretGrouped}</code>
          <button type="button" class="btn btn-outline btn-sm" id="ta-copy-secret" style="flex-shrink:0">Copy</button>
        </div>
      </div>
      <div class="form-group">
        <label>Enter 6-digit code from your app</label>
        <input id="ta-code" inputmode="numeric" pattern="[0-9]*" maxlength="6"
               placeholder="123456" autocomplete="one-time-code"
               style="text-align:center;font-size:22px;letter-spacing:6px">
      </div>
      <div id="ta-err" style="color:var(--red);font-size:13px;min-height:18px"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="ta-cancel">Cancel</button>
        <button class="btn btn-primary" id="ta-confirm">Enable</button>
      </div>
    `, (root, close) => {
      const qrSlot = root.querySelector('#ta-qr');
      if (typeof QRCode === 'undefined') {
        qrSlot.innerHTML = '<div style="color:var(--red);font-size:12px;text-align:center;padding:20px">QR library failed to load — use the manual secret below.</div>';
      } else {
        new QRCode(qrSlot, {
          text: uri, width: 220, height: 220,
          colorDark: '#000000', colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M,
        });
      }
      root.querySelector('#ta-copy-secret').onclick = async () => {
        try { await navigator.clipboard.writeText(secret); toast('Secret copied'); }
        catch { toast('Copy failed'); }
      };
      const input = root.querySelector('#ta-code');
      const err = root.querySelector('#ta-err');
      const confirm = async () => {
        const v = input.value.replace(/\D/g, '').slice(0, 6);
        if (v.length !== 6) { err.textContent = 'Enter 6 digits'; return; }
        const expected = await window.TwoFA.code(secret, Date.now());
        const expectedPrev = await window.TwoFA.code(secret, Date.now() - 30000);
        const expectedNext = await window.TwoFA.code(secret, Date.now() + 30000);
        if (v !== expected && v !== expectedPrev && v !== expectedNext) {
          err.textContent = 'Code did not match — check your authenticator clock';
          input.value = '';
          return;
        }
        localStorage.setItem('vault.totp_secret', secret);
        refresh2FALabel();
        close();
        toast('Two-factor enabled');
      };
      root.querySelector('#ta-confirm').onclick = confirm;
      root.querySelector('#ta-cancel').onclick = close;
      input.addEventListener('keydown', e => { if (e.key === 'Enter') confirm(); });
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(0, 6);
      });
    });
  }

  // ── BIP39 passphrase ("25th word") setup ───────────────────
  // Adds a second secret on top of the seed phrase. Without it, the
  // seed phrase derives a different (empty) wallet. The passphrase is
  // never stored — only a flag that we need to prompt for it on unlock.
  function showPassphraseFlow() {
    const enabled = window.isPassphraseEnabled?.();
    if (enabled) {
      modal(`
        <h2>🔑 Passphrase Active</h2>
        <p>Your wallet currently requires a BIP39 passphrase ("25th word") on every unlock. Without it, the wrong addresses are derived and your funds will not appear.</p>
        <div class="warning-box" style="margin-top:8px">⚠ Disabling does NOT move your funds. After turning it off, the next unlock will open the standard (no-passphrase) wallet — your passphrase-protected funds will only show again if you re-enable it.</div>
        <div class="modal-actions">
          <button class="btn btn-outline" id="pp-close">Close</button>
          <button class="btn btn-danger" id="pp-disable">Turn Off</button>
        </div>
      `, (root, close) => {
        root.querySelector('#pp-close').onclick = close;
        root.querySelector('#pp-disable').onclick = async () => {
          try { await verifyAuth('Disable passphrase protection'); }
          catch { return; }
          window.setPassphraseEnabled(false);
          refreshPassphraseLabel();
          close();
          toast('Passphrase disabled — relock and unlock to switch back to the standard wallet');
        };
      });
      return;
    }

    // Not yet enabled — explain, collect a passphrase, confirm, warn.
    modal(`
      <h2>🔑 Set up Passphrase</h2>
      <p style="font-size:13px">Adds a second secret on top of your 12-word seed. Even if your recovery phrase leaks, your funds stay safe without the passphrase.</p>
      <div class="warning-box" style="margin-top:8px">
        ⚠ <strong>There is NO recovery</strong> for the passphrase. If you forget it, your funds are gone forever. Write it down with your seed.
      </div>
      <div class="form-group" style="margin-top:14px">
        <label>Passphrase (your "25th word")</label>
        <input type="password" id="pp1" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Pick something memorable but secret">
      </div>
      <div class="form-group">
        <label>Confirm passphrase</label>
        <input type="password" id="pp2" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Repeat it exactly">
      </div>
      <label style="display:flex;align-items:center;gap:10px;font-size:13px;margin:8px 0;cursor:pointer">
        <input type="checkbox" id="pp-ack"> I understand that losing this passphrase means losing access to these funds forever.
      </label>
      <div id="pp-err" style="color:var(--red);font-size:13px;min-height:18px"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="pp-cancel">Cancel</button>
        <button class="btn btn-primary" id="pp-enable" disabled>Enable</button>
      </div>
    `, (root, close) => {
      const ack = root.querySelector('#pp-ack');
      const ok  = root.querySelector('#pp-enable');
      ack.onchange = () => { ok.disabled = !ack.checked; };
      ok.onclick = async () => {
        const err = root.querySelector('#pp-err');
        err.textContent = '';
        const p1 = root.querySelector('#pp1').value;
        const p2 = root.querySelector('#pp2').value;
        if (!p1) { err.textContent = 'Passphrase cannot be empty'; return; }
        if (p1 !== p2) { err.textContent = "Passphrases don't match"; return; }
        try { await verifyAuth('Enable passphrase protection'); }
        catch { return; }
        // Apply immediately: set the in-memory passphrase, flip the flag,
        // re-derive every address. The user keeps the same session — they
        // just see new addresses now (and their old/no-passphrase funds
        // are no longer reachable until they turn it off).
        window.setPassphraseEnabled(true);
        state.passphrase = p1;
        close();
        toast('Re-deriving addresses with passphrase…');
        try {
          if (typeof loadWallet === 'function') {
            await loadWallet();
          }
          refreshPassphraseLabel();
          toast('✓ Passphrase enabled — these are now your protected addresses');
        } catch (e) {
          toast('Re-derive failed: ' + (e.message || e));
        }
      };
      root.querySelector('#pp-cancel').onclick = close;
    });
  }

  function showCurrencyPicker() {
    const current = (window.getDisplayCurrency?.() || 'usd');
    modal(`
      <h2>Display Currency</h2>
      <p>All fiat values throughout the wallet (balances, prices, totals) are shown in this currency.</p>
      <div id="ccy-list" style="max-height:50vh;overflow-y:auto;margin:0 -8px"></div>
      <div class="modal-actions" style="grid-template-columns:1fr;margin-top:14px">
        <button class="btn btn-outline" id="ccy-close">Close</button>
      </div>
    `, (root, close) => {
      const list = root.querySelector('#ccy-list');
      list.innerHTML = CURRENCY_OPTIONS.map(o => `
        <button class="settings-menu-item ccy-row" data-code="${o.code}" style="background:transparent">
          <span class="menu-label">${o.label} <span style="color:var(--text3);font-size:12px;margin-left:4px">${o.code.toUpperCase()}</span></span>
          ${o.code === current ? '<span style="color:var(--accent);font-size:18px">✓</span>' : '<span></span>'}
        </button>
      `).join('');
      list.querySelectorAll('.ccy-row').forEach(btn => {
        btn.onclick = () => {
          window.setDisplayCurrency?.(btn.dataset.code);
          refreshCurrencyLabel();
          close();
          toast(`Display currency set to ${btn.dataset.code.toUpperCase()}`);
        };
      });
      root.querySelector('#ccy-close').onclick = close;
    });
  }

  function wire() {
    $('menu-show-seed')?.addEventListener('click', showSeed);
    $('menu-change-pwd')?.addEventListener('click', changePassword);
    $('menu-manage-assets')?.addEventListener('click', showManageAssets);
    $('menu-currency')?.addEventListener('click', showCurrencyPicker);
    $('menu-2fa')?.addEventListener('click', show2FAFlow);
    $('menu-passphrase')?.addEventListener('click', showPassphraseFlow);
    $('menu-check-update')?.addEventListener('click', checkForUpdates);
    $('menu-lock-wallet')?.addEventListener('click', () => $('lock-btn')?.click());
    $('menu-biometric')?.addEventListener('click', () => {
      if (window.biometricEnabled?.()) disableBiometric();
      else enableBiometric();
    });
    refreshCurrencyLabel();
    refresh2FALabel();
    refreshPassphraseLabel();
    renderSettingsTab();
  }

  // Settings.js loads after home.js; wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    Promise.resolve().then(wire);
  }
})();

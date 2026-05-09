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

      tryBiometric().then(ok => {
        if (ok) { resolve(); return; }
        // Fall back to password — rejecting on cancel/backdrop close so
        // callers' try/catch fires and the calling button can re-enable.
        passwordModal({
          title: '🔒 Confirm with password',
          message: reason,
          onSubmit: async (_pwd, close) => { close(); resolve(); },
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
    $('menu-check-update')?.addEventListener('click', checkForUpdates);
    $('menu-lock-wallet')?.addEventListener('click', () => $('lock-btn')?.click());
    $('menu-biometric')?.addEventListener('click', () => {
      if (window.biometricEnabled?.()) disableBiometric();
      else enableBiometric();
    });
    refreshCurrencyLabel();
    renderSettingsTab();
  }

  // Settings.js loads after home.js; wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    Promise.resolve().then(wire);
  }
})();

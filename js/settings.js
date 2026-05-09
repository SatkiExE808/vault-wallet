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

  function passwordModal({ title, message, onSubmit }) {
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
      const input = root.querySelector('#pw-input');
      const err = root.querySelector('#pw-err');
      const submit = async () => {
        err.textContent = '';
        const pwd = input.value;
        if (!pwd) { err.textContent = 'Enter your password'; return; }
        try {
          const decrypted = await decryptMnemonic(localStorage.getItem('wallet_encrypted'), pwd);
          if (decrypted !== state.mnemonic) throw new Error('Wrong password');
          await onSubmit(pwd, close);
        } catch (e) {
          err.textContent = e.message || 'Wrong password';
        }
      };
      root.querySelector('#pw-ok').onclick = submit;
      root.querySelector('#pw-cancel').onclick = close;
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
          <div class="seed-display">
            ${words.map((w, i) => `<div class="seed-word"><span>${i + 1}</span>${w}</div>`).join('')}
          </div>
          <div class="modal-actions" style="grid-template-columns:1fr">
            <button class="btn btn-primary" id="seed-done">I've saved it — close</button>
          </div>
        `, (root, close) => { root.querySelector('#seed-done').onclick = close; });
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
    return window.Capacitor?.Plugins?.BiometricAuth || null;
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
            await native.authenticate({
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

  function disableBiometric() {
    if (!confirm('Disable biometric unlock?')) return;
    localStorage.removeItem('biometric_enabled');
    localStorage.removeItem('biometric_credential_id');
    localStorage.removeItem('biometric_blob');
    localStorage.removeItem('biometric_method');
    toast('Biometric disabled');
    renderSettingsTab();
  }

  // ── Unlock with biometric ──────────────────────────────────
  async function unlockWithBiometric() {
    const blobB64 = localStorage.getItem('biometric_blob');
    if (!blobB64) throw new Error('Biometric not configured');
    const method = localStorage.getItem('biometric_method') || 'webauthn';

    if (method === 'native') {
      const native = getNativePlugin();
      if (!native) throw new Error('Native biometric plugin not available — reinstall app');
      await native.authenticate({
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

  function wire() {
    $('menu-show-seed')?.addEventListener('click', showSeed);
    $('menu-change-pwd')?.addEventListener('click', changePassword);
    $('menu-manage-assets')?.addEventListener('click', showManageAssets);
    $('menu-check-update')?.addEventListener('click', checkForUpdates);
    $('menu-lock-wallet')?.addEventListener('click', () => $('lock-btn')?.click());
    $('menu-biometric')?.addEventListener('click', () => {
      if (window.biometricEnabled?.()) disableBiometric();
      else enableBiometric();
    });
    renderSettingsTab();
  }

  // Settings.js loads after home.js; wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    Promise.resolve().then(wire);
  }
})();

// PWA service worker registration + safe-reload on SW activation.
// Extracted from an inline <script> in index.html so the page can ship a
// strict CSP without 'unsafe-inline' for script-src.

if ('serviceWorker' in navigator) {
  // updateViaCache:'none' bypasses the HTTP cache for the SW script
  // itself. Without it, iOS WebKit was serving a stale sw.js from
  // disk for up to 24h after a deploy — users stayed on the old SW
  // (and the old bundle) until the HTTP cache TTL expired naturally.
  navigator.serviceWorker
    .register('./sw.js', { updateViaCache: 'none' })
    .then(reg => {
      // Force an immediate update check on every app open.
      try { reg.update(); } catch {}
      // And again every 5 minutes while the app stays foregrounded,
      // so a long-running session picks up new builds without the
      // user having to kill + reopen.
      setInterval(() => { try { reg.update(); } catch {} }, 5 * 60 * 1000);
    })
    .catch(() => {});

  // When a new SW activates, the cache has fresh JS but this page is
  // still running whatever was loaded at startup. Reload once so the
  // user gets the new code without having to manually kill the app.
  let _swReloaded = false;
  function _safeReload(version) {
    if (_swReloaded) return;
    // Don't reload while a modal is open or a button is in-flight —
    // would lose user input or interrupt a pending signing tx. Retry
    // every couple seconds until safe.
    const modalOpen = !!document.querySelector('.modal-backdrop');
    const inFlightBtn = !!document.querySelector('button:disabled[id*="-do"], button:disabled[id*="-send"], button:disabled[id*="copy"]');
    if (modalOpen || inFlightBtn) { setTimeout(() => _safeReload(version), 2500); return; }
    _swReloaded = true;
    // location.reload() can reuse Capacitor WebView's in-memory parsed
    // JS modules, so a freshly-cached app.js never actually executes.
    // Navigating to the same path with a different query string forces
    // the WebView to discard its module state and re-evaluate.
    const url = new URL(location.href);
    url.searchParams.set('v', version || Date.now());
    location.replace(url.toString());
  }
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'SW_ACTIVATED') _safeReload(e.data.version);
  });
}

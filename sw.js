const CACHE = 'vault-v131';
const LOCAL_FILES = [
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/home.js',
  './js/settings.js',
  './js/tx-progress.js',
  './js/staking.js',
  './js/aave.js',
  './js/earn.js',
  './js/inbox.js',
  './js/totp.js',
  './js/qr-scanner.js',
  './js/coins/utxo.js',
  './js/coins/bitcoin.js',
  './js/coins/litecoin.js',
  './js/coins/dogecoin.js',
  './js/coins/ethereum.js',
  './js/coins/evm-chains.js',
  './js/coins/monero.js',
  './js/coins/tron.js',
  './js/coins/solana.js',
  // Buffer polyfill loaded BEFORE solana-web3.js so its internal
  // typeof Buffer checks see the global.
  './lib/buffer-polyfill.js',
  // Monero browser bundle + worker + wasm — needed for offline XMR support.
  './lib/monero-browser.js',
  './lib/monero_wallet_full.js',
  './lib/monero_wallet_full.wasm',
  './monero_web_worker.js',
];

// Cache local files on install — fetched with cache:'no-store' so we
// bypass the WebView's HTTP cache and any GitHub Pages CDN node still
// serving the old build. Earlier we used cache.addAll, which respects
// HTTP caching headers and would happily install stale JS files into a
// fresh SW cache key. The result: SW says "v100" but the bundled
// staking.js is still v99. This was the cause of the JupSOL "v100 is
// live but Max still gives 0.006707" report — the user's app honestly
// thought it was up to date because the cache key matched, while the
// JS files inside it were old.
self.addEventListener('install', e => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const fetches = LOCAL_FILES.map(async url => {
        try {
          const r = await fetch(url, { cache: 'no-store' });
          if (r && r.status === 200) await cache.put(url, r);
        } catch {}
      });
      await Promise.allSettled(fetches);
      // Icons are optional — same no-store rule, don't fail install if missing.
      await Promise.allSettled(['./icons/icon-192.png', './icons/icon-512.png'].map(async url => {
        try {
          const r = await fetch(url, { cache: 'no-store' });
          if (r && r.status === 200) await cache.put(url, r);
        } catch {}
      }));
      return self.skipWaiting();
    })()
  );
});

// Remove old caches on activate, then notify any open pages to reload so
// they actually pick up the new JS bundles. (Without this, a SW update can
// install fresh files into the cache, but pages keep running the JS that
// was already loaded into memory — the cause of the v55→v56 "Infinity"
// stuck-state bug.)
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const c of clients) c.postMessage({ type: 'SW_ACTIVATED', version: CACHE });
  })());
});

// Network-first for everything: always get fresh code when online,
// fall back to cache when offline.
//
// Same-origin GETs go out with cache:'no-store' to bypass the WebView's
// HTTP cache. Without this, GitHub Pages' default 10-min max-age would
// keep serving the old JS bundle from the WebView's HTTP cache for up
// to 10 minutes after I push a fix, even though the SW correctly
// fetched and cached the new files. The user-visible symptom: SW
// reports v101 but tapping Max still uses the v99 0.001 buffer because
// staking.js came from HTTP cache. The SW cache layer still acts as
// the offline fallback once we have the response.
self.addEventListener('fetch', e => {
  const req = e.request;
  const sameOrigin = new URL(req.url).origin === self.location.origin;
  const opts = (sameOrigin && req.method === 'GET') ? { cache: 'no-store' } : undefined;
  e.respondWith(
    (opts ? fetch(req, opts) : fetch(req))
      .then(res => {
        // Only cache successful same-origin responses + cross-origin OK responses
        if (res && res.status === 200 && res.type !== 'opaqueredirect') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});

const CACHE = 'vault-v61';
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
  './js/coins/utxo.js',
  './js/coins/bitcoin.js',
  './js/coins/litecoin.js',
  './js/coins/dogecoin.js',
  './js/coins/ethereum.js',
  './js/coins/evm-chains.js',
  './js/coins/monero.js',
  './js/coins/tron.js',
  './js/coins/solana.js',
  // Monero browser bundle + worker + wasm — needed for offline XMR support.
  './lib/monero-browser.js',
  './lib/monero_wallet_full.js',
  './lib/monero_wallet_full.wasm',
  './monero_web_worker.js',
];

// Cache local files on install
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async cache => {
      await cache.addAll(LOCAL_FILES);
      // Icons are optional — don't fail install if they haven't been generated yet
      await Promise.allSettled([
        cache.add('./icons/icon-192.png'),
        cache.add('./icons/icon-512.png'),
      ]);
      return self.skipWaiting();
    })
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
// fall back to cache when offline. This prevents the wallet from being
// stuck on an old version after I push a fix.
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Only cache successful same-origin responses + cross-origin OK responses
        if (res && res.status === 200 && res.type !== 'opaqueredirect') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

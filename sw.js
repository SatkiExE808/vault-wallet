const CACHE = 'vault-v16';
const LOCAL_FILES = [
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/home.js',
  './js/coins/utxo.js',
  './js/coins/bitcoin.js',
  './js/coins/litecoin.js',
  './js/coins/dogecoin.js',
  './js/coins/ethereum.js',
  './js/coins/evm-chains.js',
  './js/coins/monero.js',
  './js/coins/tron.js',
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

// Remove old caches on activate
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Local files: cache-first
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }))
    );
    return;
  }

  // CDN / external: network-first, fall back to cache
  e.respondWith(
    fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => caches.match(e.request))
  );
});

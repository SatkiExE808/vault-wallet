const CACHE = 'vault-v50';
const LOCAL_FILES = [
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/home.js',
  './js/settings.js',
  './js/tx-progress.js',
  './js/staking.js',
  './js/coins/utxo.js',
  './js/coins/bitcoin.js',
  './js/coins/litecoin.js',
  './js/coins/dogecoin.js',
  './js/coins/ethereum.js',
  './js/coins/evm-chains.js',
  './js/coins/monero.js',
  './js/coins/tron.js',
  './js/coins/solana.js',
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

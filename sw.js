// ─────────────────────────────────────────────────────────────
//  Savvey — Service Worker v6
//
//  Cache strategies:
//    FONT_CACHE    — Stale-While-Revalidate for Google Fonts CSS + woff2
//                    Serves cached fonts instantly, refreshes in background.
//    STATIC_CACHE  — Cache-First for manifest.json and icons.
//                    Network-first on navigate so fresh HTML is always tried.
//    /api/*        — Network-Only. Price data must never be stale.
//
//  Offline support:
//    SW posts an 'OFFLINE' message to all clients when navigator.onLine
//    would be false (i.e. a fetch fails and we fell back to cache).
//    The frontend listens via navigator.serviceWorker.addEventListener('message').
//
//  Bump STATIC_VER on every index.html deploy.
//  Bump FONT_VER only if font families or weights change.
// ─────────────────────────────────────────────────────────────

const STATIC_VER    = 'savvey-static-v9';
const FONT_VER      = 'savvey-fonts-v2';
const KEEP          = [STATIC_VER, FONT_VER];
const STATIC_ASSETS = ['/', '/index.html', '/manifest.json'];
const FONT_ORIGINS  = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

// ── Install: pre-cache shell ──────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_VER)
      .then(c => c.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: purge old caches ────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !KEEP.includes(k)).map(k => {
          console.log('[SW v6] Purging stale cache:', k);
          return caches.delete(k);
        })
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. API / Supabase — always network-only, never cache
  if (url.pathname.startsWith('/api/') || url.hostname.includes('supabase.co')) {
    return;
  }

  // 2. Google Fonts — Stale-While-Revalidate
  //    Serve the cached copy immediately (zero render-blocking), then
  //    fetch fresh in the background for the next visit.
  if (FONT_ORIGINS.some(o => request.url.startsWith(o))) {
    event.respondWith(staleWhileRevalidate(request, FONT_VER));
    return;
  }

  // 3. Navigation — network-first, fallback to cached shell
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(STATIC_VER).then(c => c.put(request, clone));
          }
          return res;
        })
        .catch(async () => {
          // Notify all open clients that we are offline
          notifyClients({ type: 'OFFLINE' });
          return caches.match('/index.html');
        })
    );
    return;
  }

  // 4. Manifest, icons, other static assets — cache-first
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(STATIC_VER).then(c => c.put(request, clone));
        }
        return res;
      });
    })
  );
});

// ── Stale-While-Revalidate helper ────────────────────────────
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  // Always fetch fresh in background — update cache silently
  const networkFetch = fetch(request).then(res => {
    if (res && res.status === 200) cache.put(request, res.clone());
    return res;
  }).catch(() => null);

  // Return stale immediately if we have it; else wait for network
  return cached || networkFetch;
}

// ── Broadcast to all clients ──────────────────────────────────
async function notifyClients(data) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage(data));
}

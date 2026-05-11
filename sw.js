// ─────────────────────────────────────────────────────────────
//  Savvey — Service Worker v3.4.1
//
//  Cache strategies:
//    FONT_CACHE    — Stale-While-Revalidate for Google Fonts
//    STATIC_CACHE  — Cache-First for manifest.json + icons
//                    Network-first on navigate so fresh HTML is always tried
//    /api/*        — Network-Only. Never cache identification calls.
// ─────────────────────────────────────────────────────────────

// v3.4.5s (7 May 2026): STATIC_VER bumped v345q -> v345s for Wave S
// (category-icon fallback in disambig when SerpAPI returns no thumbnail)
// v3.4.5q (7 May 2026): STATIC_VER bumped v345p -> v345q for Wave Q
// (Listerine routing hotfix + Reset link hide + affiliate disclosure under
// Amazon CTA + dead api/* file removal + console.log strip + _meta sunset)
// v3.4.5p (7 May 2026): STATIC_VER bumped v345o -> v345p for Wave F
// (verdict-pill basis micro-copy + your-snap on disambig + neutral-state pill)
// v3.4.5o (6 May 2026): STATIC_VER bumped v345n -> v345o for Wave E
// (swipe-between-screens + Snap pinch-to-zoom + copy tweaks + Snap-another
// CTA on result screen). Frontend-only wave; backend unchanged.
// STATIC_VER bumped v310 -> v341. Five deploys shipped
// between v3.1 and v3.4.1 (verdict pill, deep-link, smart loader, etc.) and
// the SW cache was never bumped. Installed PWAs were serving v3.1 cached
// shell. This bump invalidates the old cache, forces clients.claim(), and
// posts SW_UPDATED to controlled clients so the frontend can soft-reload
// to pick up the new shell.
const STATIC_VER    = 'savvey-static-v345v118';
const FONT_VER      = 'savvey-fonts-v2';
const KEEP          = [STATIC_VER, FONT_VER];
const STATIC_ASSETS = [
  '/', '/index.html', '/manifest.json',
];
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

self.addEventListener('message', event => {
  if(event.data && event.data.type === 'SKIP_WAITING'){
    self.skipWaiting();
  }
});

// ── Activate: purge old caches + notify clients to reload ────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !KEEP.includes(k)).map(k => {
          console.log('[SW v3.4.1] Purging stale cache:', k);
          return caches.delete(k);
        })
      ))
      .then(() => self.clients.claim())
      .then(() => notifyClients({ type: 'SW_UPDATED', version: STATIC_VER }))
  );
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. API — always network-only, never cache
  if (url.pathname.startsWith('/api/') || url.hostname.includes('supabase.co')) {
    return;
  }

  // 2. Google Fonts — Stale-While-Revalidate
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
          notifyClients({ type: 'OFFLINE' });
          return caches.match('/index.html');
        })
    );
    return;
  }

  // 4. Static assets — cache-first
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

async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkFetch = fetch(request).then(res => {
    if (res && res.status === 200) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return cached || networkFetch;
}

async function notifyClients(data) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage(data));
}

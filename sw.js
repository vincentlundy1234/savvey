// ─────────────────────────────────────────────────────────────
//  Savvey — Service Worker v3.4.5 (V.124)
//
//  Cache strategies:
//    FONT_CACHE    — Stale-While-Revalidate for Google Fonts
//    STATIC_CACHE  — Cache-First for manifest.json + icons
//                    Network-first on navigate so fresh HTML is always tried
//    /api/*        — Network-Only. Never cache identification calls.
//
//  V.124 (11 May 2026): AGGRESSIVE CACHE BUSTER + UPDATE TOAST
//  Panel mandate after iPhone PWA showed V.122+ visuals were not landing
//  because iOS Safari was serving the old cached shell. Three changes:
//    (1) Activate handler now deletes ALL caches whose name doesn't match
//        the CURRENT STATIC_VER exactly — even old Savvey caches that
//        happen to share a prefix.
//    (2) Activate also explicitly deletes the previously-cached '/' and
//        '/index.html' entries from the new cache, forcing the very next
//        navigate to re-fetch the HTML from network. Without this, the
//        post-install pre-cache snapshot of '/' could itself be stale.
//    (3) Post a richer SW_UPDATED message with the new version string so
//        the frontend can show a "Savvey updated to vX" toast.
// ─────────────────────────────────────────────────────────────

// v3.4.5s (7 May 2026): STATIC_VER bumped v345q -> v345s for Wave S
// v3.4.5q (7 May 2026): STATIC_VER bumped v345p -> v345q for Wave Q
// v3.4.5p (7 May 2026): STATIC_VER bumped v345o -> v345p for Wave F
// v3.4.5o (6 May 2026): STATIC_VER bumped v345n -> v345o for Wave E
// V.124 (11 May 2026): STATIC_VER bumped v345v123 -> v345v124 + new
// activate logic above; rolling forward will be self-recovering from now on.
const STATIC_VER    = 'savvey-static-v345v135';
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

// ── Activate: V.124 aggressive cache nuke + force-fresh navigation + notify ──
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // (1) Forcefully delete every cache key that doesn't exactly match the
    //     current STATIC_VER or FONT_VER. The strict-equality filter means
    //     even legacy Savvey caches (e.g. savvey-static-v345v122b) are
    //     nuked regardless of prefix similarity — no partial matches survive.
    const keys = await caches.keys();
    const purge = keys.filter(k => !KEEP.includes(k));
    await Promise.all(purge.map(k => {
      console.log('[SW V.124] Purging stale cache:', k);
      return caches.delete(k);
    }));
    // (2) The post-install pre-cache captures '/' and '/index.html' at
    //     install time. If the install was racing with the deploy CDN
    //     warm-up, those snapshots can themselves be stale. Delete them
    //     explicitly so the next navigate is forced to hit the network.
    try {
      const c = await caches.open(STATIC_VER);
      await c.delete('/');
      await c.delete('/index.html');
      console.log('[SW V.124] Forced stale navigate-cache eviction inside current STATIC_VER');
    } catch (e) {
      console.warn('[SW V.124] Navigate-cache eviction failed:', e && e.message);
    }
    // (3) Take control of every uncontrolled client immediately, then
    //     post a richer SW_UPDATED message including version + purge
    //     count so the frontend can show an "App Updated" toast.
    await self.clients.claim();
    await notifyClients({
      type: 'SW_UPDATED',
      version: STATIC_VER,
      purged_count: purge.length,
      purged_keys: purge,
      ts: Date.now()
    });
  })());
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

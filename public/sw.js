/*
 * Offline support: keeps a copy of the app's own files (never your items) so the
 * app opens without internet and your Saved items stay readable.
 * Pages: network first (always the newest version when online), cache as fallback.
 * /assets/ files have unique names per version, so they're cached on first use.
 */
const CACHE = 'qrls-app-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch relays, Google or fonts

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put('./', copy));
          }
          return res;
        })
        .catch(async () => (await caches.match('./')) || Response.error())
    );
    return;
  }

  if (url.pathname.includes('/assets/') || /\.(png|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
  }
});

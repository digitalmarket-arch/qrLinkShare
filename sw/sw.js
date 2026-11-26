/*
 * qrLinkShare service worker. This file is a template: every production build (see
 * vite.config.ts) writes the real sw.js from it and fills in VERSION and PRECACHE.
 *
 * - It keeps a copy of the app's own files (never your items), saved on install, so the app
 *   opens without internet from the first visit on. Each version of the app gets its own
 *   copy, and older copies are deleted once the new version takes over.
 * - Sharing into the installed app (Android share menu) opens ./?share-title=…&share-text=…
 *   &share-url=…. That address never goes to the network: the shared text is kept on this
 *   device and the app reopens as ./?shared=1, where it picks the text up and deletes it.
 * - Pages: network first (always the newest version when online), the saved copy offline.
 * - /assets/ files get a new name whenever they change, so the saved copy is used first.
 * - The manifest and icons: network first, so changes reach you; the saved copy offline.
 * - Requests to other sites (relays, Google, wallets) are never touched.
 * Don't turn on navigation preload: it would send shared text to the network.
 */

const VERSION = __QRLS_VERSION__;
const PRECACHE = __QRLS_PRECACHE__;

const CACHE = `qrls-app-${VERSION}`;
const SHARE_CACHE = 'qrls-share'; // read and emptied by src/lib/shareTarget.ts
const SHARE_PARAMS = ['share-title', 'share-text', 'share-url'];
const ASSETS = new URL('./assets/', self.location).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 'reload' skips the browser's HTTP cache, so a stale index.html is never saved.
      await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop older app copies (including the old 'qrls-app-v1'); keep pending shared text.
      for (const key of await caches.keys()) {
        if (key.startsWith('qrls-app-') && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch relays, Google or wallets

  if (req.mode === 'navigate') {
    const shared = SHARE_PARAMS.some((k) => url.searchParams.has(k));
    event.respondWith(shared ? keepShared(url) : page(event));
  } else if (url.pathname.startsWith(ASSETS)) {
    event.respondWith(asset(event));
  } else if (/\.(webmanifest|png)$/.test(url.pathname)) {
    event.respondWith(fresh(event));
  }
});

/** Shared into the app: keep it on this device, then reopen the app without it in the address. */
async function keepShared(url) {
  const q = url.searchParams;
  const data = { title: q.get('share-title'), text: q.get('share-text'), url: q.get('share-url') };
  try {
    const cache = await caches.open(SHARE_CACHE);
    await cache.put(
      new URL('./__shared', self.registration.scope),
      new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
    );
  } catch {
    // Storage blocked or full: this share is lost, but it still never goes to the network.
  }
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

/** Pages: the newest from the network; the saved copy when offline or the server is failing. */
async function page(event) {
  try {
    const res = await fetch(event.request);
    if (res.status >= 500) return (await saved('./')) || res;
    if (res.ok && (res.headers.get('Content-Type') || '').includes('text/html')) save(event, './', res.clone());
    return res;
  } catch {
    return (await saved('./')) || Response.error();
  }
}

/** /assets/ files never change under the same name: the saved copy first, else the network. */
async function asset(event) {
  const hit = await saved(event.request);
  if (hit) return hit;
  const res = await fetch(event.request);
  if (res.status === 200) save(event, event.request, res.clone());
  return res;
}

/** Manifest and icons: network first (always rechecked, so changes show up), saved copy offline. */
async function fresh(event) {
  try {
    const res = await fetch(event.request, { cache: 'no-cache' });
    if (res.status !== 200) return (await saved(event.request)) || res;
    save(event, event.request, res.clone());
    return res;
  } catch {
    return (await saved(event.request)) || Response.error();
  }
}

/** Looks only in this version's copy (never in the shared-text cache). */
async function saved(key) {
  try {
    return await caches.match(key, { cacheName: CACHE });
  } catch {
    return undefined;
  }
}

function save(event, key, res) {
  const done = caches
    .open(CACHE)
    .then((cache) => cache.put(key, res))
    .catch(() => {});
  try {
    event.waitUntil(done);
  } catch {
    // The event already ended; the copy is still written.
  }
}

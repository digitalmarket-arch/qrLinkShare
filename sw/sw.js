/*
 * qrLinkShare service worker. This file is a template: every production build (see
 * vite.config.ts) writes the real sw.js from it and fills in VERSION and PRECACHE.
 *
 * - It keeps a copy of the app's own files (never your items), saved on install, so the app
 *   opens without internet from the first visit on. Each file is saved on its own: one that
 *   fails to download (flaky mobile data, say) doesn't stop the install, and whatever is still
 *   missing is fetched again on each later visit. An /assets/ file that another version's copy
 *   already has is copied from there instead of downloaded.
 * - Each version of the app gets its own copy, and older copies are deleted once nothing can
 *   need them. A window that was already open when a new version took over keeps running the
 *   old version, and may still need old files the server no longer has (parts of the app it
 *   loads on first use, such as Google sign-in or the QR scanner). So:
 *   - if no window of the app is open when a new version takes over, older copies go at once;
 *   - otherwise the new copy notes which windows were open (the worker itself forgets
 *     everything whenever it stops), and older copies go once none of those windows is open any
 *     more: closed, or reloaded into the new version. Each request the worker answers checks
 *     this in the background. Windows opened later run the new version, so they don't count.
 *   Pending shared text ('qrls-share') is never deleted here.
 * - Sharing into the installed app (Android share menu) opens ./?share-title=…&share-text=…
 *   &share-url=…. That address never goes to the network: the shared text is kept on this
 *   device and the app reopens as ./?shared=1, where it picks the text up and deletes it.
 * - Pages: network first (always the newest version when online), the saved copy offline.
 * - /assets/ files get a new name whenever they change, so a saved copy is used first: this
 *   version's, else another version's (same name, same file), else the network.
 * - The manifest and icons: network first, so changes reach you; the saved copy offline.
 * - Requests to other sites (relays, Google, wallets) are never touched.
 * Don't turn on navigation preload: it would send shared text to the network.
 */

const VERSION = __QRLS_VERSION__;
const PRECACHE = __QRLS_PRECACHE__;

const COPY = 'qrls-app-'; // each version's copy is the cache qrls-app-<VERSION>
const CACHE = `${COPY}${VERSION}`;
const SHARE_CACHE = 'qrls-share'; // read and emptied by src/lib/shareTarget.ts
const SHARE_PARAMS = ['share-title', 'share-text', 'share-url'];
const ASSETS = new URL('./assets/', self.location).pathname;
// Kept in this version's copy while older copies wait to be deleted:
// { older: their cache names, windows: ids of the app's windows open when this version took over }.
const WAITING = new URL('./__older-copies', self.location).href;
// Marks a copy whose worker took over (so the next version knows which copy was in use).
const ACTIVATED = new URL('./__activated', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil(saveMissing(true).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const mine = await caches.open(CACHE);
        await mine.put(ACTIVATED, new Response('1'));
        // Older copies, including the old 'qrls-app-v1' (never the shared text in 'qrls-share').
        const older = (await caches.keys()).filter((k) => k.startsWith(COPY) && k !== CACHE);
        if (older.length) {
          const open = (await appWindows()).map((w) => w.id);
          // The copy in use until now: the newest older copy whose worker took over.
          let prev = null;
          for (const name of [...older].reverse()) {
            if (await caches.match(ACTIVATED, { cacheName: name })) {
              prev = name;
              break;
            }
          }
          prev ??= older[older.length - 1];
          const prevNote = await caches.match(WAITING, { cacheName: prev }).then((r) => (r ? r.json() : null)).catch(() => null);
          // Which windows each even older copy is kept for (an older worker's note: one list for all).
          const prevNeed = prevNote?.need ?? Object.fromEntries((prevNote?.older ?? []).map((n) => [n, prevNote.windows ?? []]));
          const need = {};
          const covered = new Set();
          for (const [name, ids] of Object.entries(prevNeed)) {
            if (!older.includes(name) || name === prev) continue;
            need[name] = ids.filter((id) => open.includes(id));
            for (const id of need[name]) covered.add(id);
          }
          // Open windows that don't run an even older version run the previous one.
          need[prev] = open.filter((id) => !covered.has(id));
          for (const name of older) need[name] ??= [];
          await mine.put(WAITING, new Response(JSON.stringify({ need })));
          await deleteOlderCopies(open);
        }
      } catch {
        // Storage unavailable: nothing to clean up.
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
    if (SHARE_PARAMS.some((k) => url.searchParams.has(k))) {
      event.respondWith(keepShared(url));
    } else {
      event.respondWith(page(event));
      event.waitUntil(saveMissing().then(tidy)); // in the background: fill gaps, then clean up
    }
  } else if (url.pathname.startsWith(ASSETS)) {
    event.respondWith(asset(event));
    event.waitUntil(tidy());
  } else if (/\.(webmanifest|png)$/.test(url.pathname)) {
    event.respondWith(fresh(event));
    event.waitUntil(tidy());
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
    if (res.status >= 500) return (await savedPage()) || res;
    if (res.ok && (res.headers.get('Content-Type') || '').includes('text/html')) save(event, './', res.clone());
    return res;
  } catch {
    return (await savedPage()) || Response.error();
  }
}

/** The saved page: this version's copy, else an older copy (this one may still lack it). */
async function savedPage() {
  return (await saved('./')) || (await fromOtherCopy('./'));
}

/**
 * /assets/ files never change under the same name: a saved copy first, else the network. That
 * is this version's copy, else another version's: a window still running an older version asks
 * for that version's files, which the server may no longer have.
 */
async function asset(event) {
  const hit = (await saved(event.request)) || (await fromOtherCopy(event.request));
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

/** Looks in the other versions' copies, newest first (caches.keys() lists the oldest first). */
async function fromOtherCopy(key) {
  try {
    const others = (await caches.keys()).filter((k) => k.startsWith(COPY) && k !== CACHE);
    for (const name of others.reverse()) {
      const hit = await caches.match(key, { cacheName: name });
      if (hit) return hit;
    }
  } catch {
    // Storage unavailable: the network it is.
  }
  return undefined;
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

/**
 * Saves the files this version's copy is missing. On install the page, manifest and icons are
 * fetched again even if the copy has them, as they keep their names when they change. Never fails.
 */
async function saveMissing(installing = false) {
  try {
    const cache = await caches.open(CACHE);
    const have = new Set((await cache.keys()).map((r) => r.url));
    const todo = PRECACHE.filter((u) => (installing && !isAsset(u)) || !have.has(new URL(u, self.location).href));
    await Promise.all(todo.map((u) => saveOne(cache, u)));
  } catch {
    // Storage unavailable: the app still works online, and shared text still never leaves.
  }
}

async function saveOne(cache, u) {
  try {
    const copy = isAsset(u) && (await fromOtherCopy(u));
    if (copy) return await cache.put(u, copy);
    // The page, manifest and icons skip the browser's HTTP cache ('reload'), so a stale one is
    // never saved. /assets/ files never change under the same name: 'default' reuses what the
    // page has just downloaded.
    await cache.add(new Request(u, { cache: isAsset(u) ? 'default' : 'reload' }));
  } catch {
    // Offline, flaky network or a server error: tried again on the next visit.
  }
}

function isAsset(u) {
  return new URL(u, self.location).pathname.startsWith(ASSETS);
}

// One cleanup check at a time, and none once nothing is left to delete. Both only save work: a
// worker that stopped forgets them and checks again. (The note is only written on activation,
// so once it is gone it stays gone for this worker.)
let tidying;
let tidied = false;

/** Deletes the older copies once nothing can need them any more (see the top of this file). */
function tidy() {
  if (tidied) return Promise.resolve();
  if (!tidying) {
    tidying = deleteOlderCopies()
      .then((done) => {
        tidied = done;
      })
      .catch(() => {})
      .finally(() => {
        tidying = undefined;
      });
  }
  return tidying;
}

/** True when no older copy is left waiting. */
async function deleteOlderCopies(openNow) {
  const cache = await caches.open(CACHE);
  const note = await cache.match(WAITING);
  if (!note) return true;
  // A newer version is being installed: it takes over the cleanup (and its copy may well have
  // the name of one we'd delete, if the app went back to an earlier build).
  if (self.registration.installing || self.registration.waiting) return false;
  // Until this copy has every file, an older copy may be the only place one of them is.
  const have = new Set((await cache.keys()).map((r) => r.url));
  if (PRECACHE.some((u) => !have.has(new URL(u, self.location).href))) return false;
  const { need } = await note.json();
  const open = new Set(openNow ?? (await appWindows()).map((w) => w.id));
  const left = {};
  for (const [name, ids] of Object.entries(need ?? {})) {
    const still = ids.filter((id) => open.has(id));
    if (still.length) left[name] = still;
    else await deleteCopies([name]);
  }
  if (Object.keys(left).length) {
    await cache.put(WAITING, new Response(JSON.stringify({ need: left })));
    return false;
  }
  await cache.delete(WAITING);
  return true;
}

/** Deletes app copies other than this version's own (never the shared-text cache). */
function deleteCopies(names) {
  return Promise.all(names.filter((k) => k.startsWith(COPY) && k !== CACHE).map((k) => caches.delete(k)));
}

/** The app's open windows (tabs, the installed app), not other pages on the same origin. */
async function appWindows() {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return all.filter((w) => w.url.startsWith(self.registration.scope));
}

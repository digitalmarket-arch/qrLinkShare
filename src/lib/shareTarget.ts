/**
 * Text shared into the installed app from another app (Android share menu).
 *
 * The manifest's share_target opens ./?share-title=…&share-text=…&share-url=…. The service
 * worker (sw/sw.js) catches that before it reaches the network, keeps the fields on this device
 * (cache 'qrls-share', key ./__shared) and reopens the app as ./?shared=1. When no service
 * worker was in control yet (first visit, hard reload), the fields are still in the address.
 */

export interface SharedFields {
  title?: string | null;
  text?: string | null;
  url?: string | null;
}

const SHARE_CACHE = 'qrls-share';
const SHARE_PARAMS = ['share-title', 'share-text', 'share-url'];

/** A link wins (so it's sent as a clickable link), then the text, then the title. */
export function pickSharedText(p: SharedFields): string {
  const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return clean(p?.url) || clean(p?.text) || clean(p?.title) || '';
}

let taken: Promise<string> | undefined;

/**
 * The text shared into the app on this page load, or '' if none. Every trace of it is removed
 * at once: the saved copy, and the `shared` / `share-*` parameters in the address bar (other
 * parameters and the #hash stay). The address is cleaned synchronously, before this returns.
 * Never throws; calling it again on the same page load gives the same result.
 */
export async function takeSharedText(): Promise<string> {
  return (taken ??= take().catch(() => ''));
}

async function take(): Promise<string> {
  const here = new URL(location.href);
  const q = here.searchParams;
  const fromWorker = q.get('shared') === '1';
  if (!fromWorker && !SHARE_PARAMS.some((k) => q.has(k))) return '';
  removeParams(fromWorker ? ['shared', ...SHARE_PARAMS] : SHARE_PARAMS);
  const saved = fromWorker ? await readSaved(new URL('./__shared', here).href) : null;
  return (
    pickSharedText(saved ?? {}) ||
    pickSharedText({ title: q.get('share-title'), text: q.get('share-text'), url: q.get('share-url') })
  );
}

function removeParams(keys: string[]): void {
  try {
    const u = new URL(location.href);
    for (const k of keys) u.searchParams.delete(k);
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  } catch {
    // e.g. a sandboxed frame: nothing more we can do
  }
}

/** Reads the copy the service worker kept, and deletes it right away (it is needed only once). */
async function readSaved(key: string): Promise<SharedFields | null> {
  try {
    if (typeof caches === 'undefined' || !(await caches.has(SHARE_CACHE))) return null;
    const cache = await caches.open(SHARE_CACHE);
    const res = await cache.match(key);
    if (!res) return null;
    const raw = await res.text().finally(() => cache.delete(key).catch(() => false));
    const data: unknown = JSON.parse(raw);
    return data && typeof data === 'object' ? (data as SharedFields) : null;
  } catch {
    return null;
  }
}

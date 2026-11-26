import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSharedText } from './shareTarget';

test('pickSharedText: a link wins, then the text, then the title', () => {
  assert.equal(pickSharedText({ title: 'Page', text: 'Look at this', url: 'https://example.com/a' }), 'https://example.com/a');
  assert.equal(pickSharedText({ title: 'Page', text: 'https://example.com/a', url: '' }), 'https://example.com/a'); // Android often puts the link in the text
  assert.equal(pickSharedText({ title: 'Page', text: 'Look at this', url: null }), 'Look at this');
  assert.equal(pickSharedText({ title: 'Page', text: null, url: null }), 'Page');
  assert.equal(pickSharedText({ title: 'Page' }), 'Page');
});

test('pickSharedText trims and skips blank or non-text fields', () => {
  assert.equal(pickSharedText({ title: ' T ', text: '  hello \n', url: '   ' }), 'hello');
  assert.equal(pickSharedText({ title: '\n', text: ' ', url: '' }), '');
  assert.equal(pickSharedText({}), '');
  assert.equal(pickSharedText({ url: 42 as unknown as string, text: 'ok' }), 'ok');
});

/* takeSharedText reads browser globals; each case gets fake ones and a fresh copy of the module. */

type ShareTarget = typeof import('./shareTarget');
let fresh = 0;
const load = () => import(`./shareTarget.ts?case=${++fresh}`) as Promise<ShareTarget>;

function fakeBrowser(href: string, saved: Record<string, string> = {}) {
  const page = { href, replaced: [] as string[], saved: new Map(Object.entries(saved)) };
  const cache = {
    match: async (key: string) => (page.saved.has(key) ? new Response(page.saved.get(key)) : undefined),
    delete: async (key: string) => page.saved.delete(key),
  };
  Object.assign(globalThis, {
    location: { get href() { return page.href; }, get search() { return new URL(page.href).search; } },
    history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => { page.replaced.push(url); page.href = new URL(url, page.href).href; } },
    caches: { has: async (name: string) => name === 'qrls-share', open: async () => cache },
  });
  return page;
}

test.afterEach(() => ['location', 'history', 'caches'].forEach((k) => Reflect.deleteProperty(globalThis, k)));

const KEY = 'https://example.test/qrLinkShare/__shared';

test('takeSharedText reads the copy the service worker kept, deletes it and cleans the address', async () => {
  const page = fakeBrowser('https://example.test/qrLinkShare/?shared=1&keep=1#join=abc', {
    [KEY]: JSON.stringify({ title: 'T', text: 'SECRET-123', url: 'https://example.com/secret' }),
  });
  const { takeSharedText } = await load();
  const pending = takeSharedText();
  assert.deepEqual(page.replaced, ['/qrLinkShare/?keep=1#join=abc']); // cleaned before the first await
  assert.equal(await pending, 'https://example.com/secret');
  assert.equal(page.saved.has(KEY), false);
  assert.equal(await takeSharedText(), 'https://example.com/secret'); // same result when called again
});

test('takeSharedText falls back to the address when no service worker was in control', async () => {
  const page = fakeBrowser('https://example.test/qrLinkShare/?share-title=T&share-text=%20hello%20&x=1#join=abc');
  Reflect.deleteProperty(globalThis, 'caches');
  const { takeSharedText } = await load();
  assert.equal(await takeSharedText(), 'hello');
  assert.equal(page.href, 'https://example.test/qrLinkShare/?x=1#join=abc');
});

test('takeSharedText leaves other addresses alone and never throws', async () => {
  const page = fakeBrowser('https://example.test/qrLinkShare/?x=1#join=abc');
  assert.equal(await (await load()).takeSharedText(), '');
  assert.deepEqual(page.replaced, []);

  const broken = fakeBrowser('https://example.test/qrLinkShare/?shared=1', { [KEY]: 'not json' });
  assert.equal(await (await load()).takeSharedText(), '');
  assert.equal(broken.href, 'https://example.test/qrLinkShare/');
  assert.equal(broken.saved.has(KEY), false);

  Reflect.deleteProperty(globalThis, 'location'); // not a browser at all
  assert.equal(await (await load()).takeSharedText(), '');
});

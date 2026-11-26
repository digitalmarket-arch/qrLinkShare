import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, splitLinks } from './linkify';

/** The link texts found in a note, as written. */
const linksIn = (text: string) => splitLinks(text).flatMap((p) => (p.kind === 'link' ? [p.text] : []));

test('a note shared from an Android app: a name, then a map link on the next line', () => {
  assert.deepEqual(splitLinks('Taj Mahal, Agra\nhttps://maps.app.goo.gl/AbC123xyz'), [
    { kind: 'text', text: 'Taj Mahal, Agra\n' },
    { kind: 'link', text: 'https://maps.app.goo.gl/AbC123xyz', url: 'https://maps.app.goo.gl/AbC123xyz' },
  ]);
  assert.deepEqual(splitLinks('Check this out https://example.com/page'), [
    { kind: 'text', text: 'Check this out ' },
    { kind: 'link', text: 'https://example.com/page', url: 'https://example.com/page' },
  ]);
  assert.deepEqual(splitLinks('no links here'), [{ kind: 'text', text: 'no links here' }]);
  assert.deepEqual(splitLinks(''), []);
});

test('punctuation that ends a sentence is not part of the link', () => {
  assert.deepEqual(splitLinks('Check this out https://example.com/page.'), [
    { kind: 'text', text: 'Check this out ' },
    { kind: 'link', text: 'https://example.com/page', url: 'https://example.com/page' },
    { kind: 'text', text: '.' },
  ]);
  for (const end of ['.', ',', ';', ':', '!', '?', '!!', '?!', '...', "'", '"', '”', '’', '»', '।', '…', '。', '，']) {
    assert.deepEqual(linksIn(`see https://example.com/a${end} ok`), ['https://example.com/a'], `ending with ${end}`);
  }
  assert.deepEqual(linksIn('He said “https://example.com/a” twice'), ['https://example.com/a']);
  assert.deepEqual(linksIn('"https://example.com/a"'), ['https://example.com/a']);
  assert.deepEqual(linksIn("'https://example.com/a'"), ['https://example.com/a']);
  assert.deepEqual(linksIn('«https://example.com/a»'), ['https://example.com/a']);
  assert.deepEqual(linksIn('<https://example.com/a>'), ['https://example.com/a']);
  assert.deepEqual(linksIn('यह देखो https://example.com/a। बहुत अच्छा है'), ['https://example.com/a']);
  // The same marks inside a link stay.
  assert.deepEqual(linksIn('https://example.com/search?q=a,b;c&d=e:f!g.'), ['https://example.com/search?q=a,b;c&d=e:f!g']);
  assert.deepEqual(linksIn('https://example.com:8080/a.b'), ['https://example.com:8080/a.b']);
});

test('a closing bracket stays only when it belongs to the link', () => {
  assert.deepEqual(linksIn('https://en.wikipedia.org/wiki/Foo_(bar)'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
  assert.deepEqual(linksIn('Read https://en.wikipedia.org/wiki/Foo_(bar).'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
  assert.deepEqual(linksIn('(https://en.wikipedia.org/wiki/Foo_(bar))'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
  assert.deepEqual(splitLinks('(see https://x.com/a).'), [
    { kind: 'text', text: '(see ' },
    { kind: 'link', text: 'https://x.com/a', url: 'https://x.com/a' },
    { kind: 'text', text: ').' },
  ]);
  assert.deepEqual(linksIn('(https://x.com/a.)'), ['https://x.com/a']);
  assert.deepEqual(linksIn('[https://x.com/a]'), ['https://x.com/a']);
  assert.deepEqual(linksIn('https://x.com/list[1]'), ['https://x.com/list[1]']);
  assert.deepEqual(linksIn('https://x.com/a))'), ['https://x.com/a']);
});

test('finds every link, in order', () => {
  const note = 'Hotel: https://booking.com/h/123, map https://maps.app.goo.gl/xyz\nTickets http://example.org/t?id=9\nhttps://booking.com/h/123';
  assert.deepEqual(
    splitLinks(note).filter((p) => p.kind === 'link'),
    [
      { kind: 'link', text: 'https://booking.com/h/123', url: 'https://booking.com/h/123' },
      { kind: 'link', text: 'https://maps.app.goo.gl/xyz', url: 'https://maps.app.goo.gl/xyz' },
      { kind: 'link', text: 'http://example.org/t?id=9', url: 'http://example.org/t?id=9' },
      { kind: 'link', text: 'https://booking.com/h/123', url: 'https://booking.com/h/123' },
    ]
  );
  assert.deepEqual(linksIn('https://a.com https://b.com\nhttps://c.com'), ['https://a.com', 'https://b.com', 'https://c.com']);
});

test('the link text is exactly what was written; the url is the cleaned-up address', () => {
  assert.deepEqual(splitLinks('HTTPS://Example.COM'), [{ kind: 'link', text: 'HTTPS://Example.COM', url: 'https://example.com/' }]);
  assert.deepEqual(splitLinks('https://hi.wikipedia.org/wiki/भारत'), [
    {
      kind: 'link',
      text: 'https://hi.wikipedia.org/wiki/भारत',
      url: 'https://hi.wikipedia.org/wiki/%E0%A4%AD%E0%A4%BE%E0%A4%B0%E0%A4%A4',
    },
  ]);
});

test('only real http and https links become clickable', () => {
  for (const note of [
    'javascript:alert(1)',
    'click javascript:alert(document.cookie)',
    'JavaScript:alert(1)//https',
    'ftp://example.com/file.zip',
    'mailto:someone@example.com',
    'data:text/html,<b>hi</b>',
    'file:///etc/passwd',
    'example.com and www.example.com',
    'https://',
    'https://.',
    'https://intranet/x',
    'xhttps://example.com',
  ]) {
    assert.deepEqual(splitLinks(note), [{ kind: 'text', text: note }], note);
  }
});

test('joining the parts always gives back the original text', () => {
  const samples = [
    '',
    'plain',
    '(see https://x.com/a).',
    '((https://x.com/a)))!!',
    'https://a.com https://b.com',
    'https://x.com/a\n\nhttps://x.com/a',
    '😀https://x.com/😀.',
    'नमस्ते https://example.com/a। ठीक है?',
    'https:// and ftp://x.com and https://intranet',
    '  https://example.com/  ',
  ];
  for (const s of samples) assert.equal(splitLinks(s).map((p) => p.text).join(''), s, JSON.stringify(s));

  // Random mixes of the tricky pieces (seeded, so every run checks the same 3,000 notes).
  const pieces = ['https://', 'http://', 'HTTPS://', 'x.com', 'a.co.in', '/a', '_(bar)', '(', ')', '[', ']', '.', ',', '!', '?', ':', ' ', '\n',
    'नमस्ते', '😀', '।', '”', '"', "'", '`', '<', '>', 'ftp://', 'javascript:', 'www.', 'localhost'];
  let seed = 0x2545f491;
  const rand = (n: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % n;
  };
  for (let i = 0; i < 3000; i++) {
    let s = '';
    for (let j = rand(14); j > 0; j--) s += pieces[rand(pieces.length)];
    const parts = splitLinks(s);
    assert.equal(parts.map((p) => p.text).join(''), s, JSON.stringify(s));
    parts.forEach((p, k) => {
      assert.ok(p.text.length > 0, `no empty parts in ${JSON.stringify(s)}`);
      if (p.kind === 'link') {
        assert.match(p.url, /^https?:\/\//);
        assert.match(p.text, /^https?:\/\/\S+$/i);
      } else if (k > 0) {
        assert.equal(parts[k - 1].kind, 'link', `two text parts in a row in ${JSON.stringify(s)}`);
      }
    });
  }
});

test('extractLinks lists each link once, in order of appearance', () => {
  assert.deepEqual(extractLinks('https://b.com/x then https://a.com, again https://b.com/x and HTTPS://A.COM/'), [
    'https://b.com/x',
    'https://a.com/',
  ]);
  assert.deepEqual(extractLinks('Taj Mahal, Agra\nhttps://maps.app.goo.gl/AbC123xyz'), ['https://maps.app.goo.gl/AbC123xyz']);
  assert.deepEqual(extractLinks('no links, just example.com and ftp://x.com'), []);
  assert.deepEqual(extractLinks(''), []);
});

test('links inside Chinese/Japanese sentences stop at full-width punctuation and curly quotes', () => {
  assert.deepEqual(extractLinks('链接：https://example.com/page，请查看'), ['https://example.com/page']);
  assert.deepEqual(extractLinks('詳しくはhttps://example.jp/a。ありがとう'), ['https://example.jp/a']);
  assert.deepEqual(extractLinks('“https://example.com/q”'), ['https://example.com/q']);
  assert.deepEqual(extractLinks('（https://example.com/x）を見て'), ['https://example.com/x']);
  // A link whose own path is in Chinese stays whole.
  const zh = extractLinks('看 https://zh.wikipedia.org/wiki/中文 吧');
  assert.equal(zh.length, 1);
  assert.ok(zh[0].startsWith('https://zh.wikipedia.org/wiki/'));
  const parts = splitLinks('链接：https://example.com/page，请查看');
  assert.equal(parts.map((p) => p.text).join(''), '链接：https://example.com/page，请查看');
});

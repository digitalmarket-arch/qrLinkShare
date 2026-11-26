/**
 * Finds web links inside a note so they can be shown as clickable links.
 * Pure helpers (no DOM, no network). Unit-tested in linkify.test.ts.
 */
import { toHttpUrl } from './shared';

export type TextPart = { kind: 'text'; text: string } | { kind: 'link'; text: string; url: string };

/** Anything that starts with http:// or https:// up to the next space, quote or angle bracket. */
// Stops at spaces, quotes and angle brackets, and also at curly quotes and the full-width
// punctuation of Chinese/Japanese text (which uses no spaces): "链接：https://x.com/a，请查看".
const CANDIDATE = /\bhttps?:\/\/[^\s<>"'`\u2018\u2019\u201C\u201D\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]+/gi;

/**
 * Punctuation that ends a sentence rather than a link, e.g. "see https://x.com/a." or "(https://x.com/a)".
 * Besides the usual English marks this includes the Hindi danda (। ॥), the ellipsis and Chinese/Japanese
 * full-width marks, because notes are often written in those languages.
 */
const TRAILING_PUNCTUATION = new Set([...'.,;:!?\'"”’»', ...'।॥…', ...'。，、；：！？']);

function count(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

/** Drops sentence punctuation and unmatched closing brackets from the end of a candidate link. */
function trimEnd(candidate: string): string {
  let s = candidate;
  for (;;) {
    const last = s.slice(-1);
    if (TRAILING_PUNCTUATION.has(last)) s = s.slice(0, -1);
    // Keep balanced brackets, as in https://en.wikipedia.org/wiki/Foo_(bar)
    else if (last === ')' && count(s, ')') > count(s, '(')) s = s.slice(0, -1);
    else if (last === ']' && count(s, ']') > count(s, '[')) s = s.slice(0, -1);
    else return s;
  }
}

/** Splits text into plain parts and http(s) links, in order. Joining every part's text gives back the original. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let done = 0; // everything before this index is already in `parts`
  for (const match of text.matchAll(CANDIDATE)) {
    const linkText = trimEnd(match[0]);
    const url = toHttpUrl(linkText);
    if (!url) continue; // not a real web address: it stays part of the surrounding text
    const start = match.index;
    if (start > done) parts.push({ kind: 'text', text: text.slice(done, start) });
    parts.push({ kind: 'link', text: linkText, url });
    done = start + linkText.length; // trimmed punctuation goes back into the next text part
  }
  if (done < text.length) parts.push({ kind: 'text', text: text.slice(done) });
  return parts;
}

/** The distinct valid http(s) links in the text, in order of appearance. */
export function extractLinks(text: string): string[] {
  const links = new Set<string>();
  for (const part of splitLinks(text)) if (part.kind === 'link') links.add(part.url);
  return [...links];
}

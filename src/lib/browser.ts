/** Small browser helpers. */

/** Copy to clipboard, with a fallback for plain-http pages where navigator.clipboard is missing. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('Copy is not supported in this browser.');
}

/** Saves a Blob as a file download. */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120_000); // big backups take a while to save
}

/** Opens a link in a new tab without giving it access to this page. Returns false if blocked. */
export function openInNewTab(url: string): boolean {
  const win = window.open('about:blank', '_blank');
  if (!win) return false;
  win.opener = null;
  win.location.href = url;
  return true;
}

/** iPhone, iPod or iPad (iPads may say they are a Mac). */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Opened from the Home Screen / as an installed app (not in a normal browser tab). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
}

/** Safari on a Mac (not Chrome, Edge, Firefox or Opera, which also say "Safari" in their name). */
export function isMacSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua) && navigator.maxTouchPoints <= 1;
}

/**
 * Safari (iPhone, iPad and Mac) deletes a website's stored data after 7 days of using Safari
 * without visiting the site, unless it is installed (Home Screen / Dock).
 */
export function safariMayDelete(): boolean {
  return (isIOS() || isMacSafari()) && !isStandalone();
}

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
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Opens a link in a new tab without giving it access to this page. Returns false if blocked. */
export function openInNewTab(url: string): boolean {
  const win = window.open('about:blank', '_blank');
  if (!win) return false;
  win.opener = null;
  win.location.href = url;
  return true;
}

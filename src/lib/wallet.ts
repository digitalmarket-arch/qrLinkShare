/**
 * Web3 wallet sign-in (MetaMask, Coinbase Wallet, Trust, Rabby, Brave…).
 *
 * Uses the standard browser wallet API (EIP-1193) and wallet discovery (EIP-6963).
 * The wallet signs ONE fixed message. The signature (which only this wallet can
 * make, and which is the same on every device) unlocks a private room for the
 * wallet's devices. Signing is free (no gas) and gives this site no access to funds.
 */
import { buildWalletRoomMessage } from './shared';
import { sha256Hex } from './pairing';

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface WalletOption {
  id: string;
  name: string;
  icon?: string;
  provider: Eip1193Provider;
}

interface AnnounceEvent extends Event {
  detail: { info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193Provider };
}

/** Finds the wallets installed in this browser. */
export function discoverWallets(timeoutMs = 400): Promise<WalletOption[]> {
  return new Promise((resolve) => {
    const found = new Map<string, WalletOption>();
    const onAnnounce = (e: Event) => {
      const { info, provider } = (e as AnnounceEvent).detail;
      found.set(info.rdns || info.uuid, { id: info.rdns || info.uuid, name: info.name, icon: info.icon, provider });
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      const injected = (window as unknown as { ethereum?: Eip1193Provider & { isMetaMask?: boolean } }).ethereum;
      if (found.size === 0 && injected) {
        found.set('injected', {
          id: 'injected',
          name: injected.isMetaMask ? 'MetaMask' : 'Browser wallet',
          provider: injected,
        });
      }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

/** Links that open this page inside a mobile wallet's built-in browser. */
export function mobileWalletLinks(): Array<{ name: string; href: string }> {
  const here = location.href.replace(/^https?:\/\//, '');
  return [
    { name: 'MetaMask', href: `https://metamask.app.link/dapp/${here}` },
    { name: 'Coinbase Wallet', href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(location.href)}` },
    { name: 'Trust Wallet', href: `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(location.href)}` },
  ];
}

function utf8ToHex(text: string): string {
  return '0x' + Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Asks the wallet to sign the fixed message and derives the private room key from it. */
export async function unlockWalletRoom(wallet: WalletOption): Promise<{ address: string; roomKey: string }> {
  const accounts = (await wallet.provider.request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts?.[0];
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('No wallet account was shared.');
  const message = buildWalletRoomMessage(address);
  const signature = (await wallet.provider.request({
    method: 'personal_sign',
    params: [utf8ToHex(message), address],
  })) as string;
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new Error('This wallet type isn’t supported. Use a regular wallet such as MetaMask, Trust or Rabby.');
  }
  // Only a hash of the signature is kept; the signature itself is never stored or sent.
  return { address, roomKey: await sha256Hex(`qrls/wallet-room/${signature.toLowerCase()}`) };
}

/** Wallet errors are cryptic; turn the common ones into plain English. */
export function walletErrorMessage(err: unknown): string {
  const e = err as { code?: number; message?: string };
  if (e?.code === 4001) return 'You cancelled the request in your wallet.';
  if (e?.code === -32002) return 'Your wallet already has a pending request. Open the wallet to continue.';
  return e?.message || 'Wallet sign-in failed.';
}

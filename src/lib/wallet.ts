/**
 * Web3 wallet sign-in (MetaMask, Coinbase Wallet, Trust, Rabby, Brave…).
 *
 * Uses the standard browser wallet API (EIP-1193) and wallet discovery (EIP-6963).
 * Signing a message proves you own the address. It costs no gas and gives
 * this site no access to your funds.
 */
import { api } from './api';
import type { RoomSession } from '../types/share';

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

/** Full sign-in: connect → ask server for a message → sign it → server verifies. */
export async function signInWithWallet(wallet: WalletOption): Promise<RoomSession> {
  const accounts = (await wallet.provider.request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts?.[0];
  if (!address) throw new Error('No wallet account was shared.');
  const chainHex = (await wallet.provider.request({ method: 'eth_chainId' }).catch(() => '0x1')) as string;
  const chainId = parseInt(chainHex, 16) || 1;

  const { message } = await api.walletChallenge(address, chainId);
  const signature = (await wallet.provider.request({
    method: 'personal_sign',
    params: [utf8ToHex(message), address],
  })) as string;
  return api.walletVerify(message, signature);
}

/** Wallet errors are cryptic; turn the common ones into plain English. */
export function walletErrorMessage(err: unknown): string {
  const e = err as { code?: number; message?: string };
  if (e?.code === 4001) return 'You cancelled the request in your wallet.';
  if (e?.code === -32002) return 'Your wallet already has a pending request. Open the wallet to continue.';
  return e?.message || 'Wallet sign-in failed.';
}

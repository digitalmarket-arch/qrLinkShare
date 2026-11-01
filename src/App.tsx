import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw, ServerCrash } from 'lucide-react';
import type { DeviceInfo, RoomSession, SharedItem } from './types/share';
import { ApiError, api, copyText, getDevice, loadPref, loadSession, saveSession, savePref } from './lib/api';
import { signInWithWallet, walletErrorMessage, type WalletOption } from './lib/wallet';
import { useRoom } from './hooks/useRoom';
import { ToastProvider, useToast } from './components/Toasts';
import { Header, Logo, type Theme } from './components/Header';
import { ConnectPanel } from './components/ConnectPanel';
import { DeviceList } from './components/DeviceList';
import { Composer } from './components/Composer';
import { Feed } from './components/Feed';
import { ItemQrModal } from './components/ItemQrModal';
import { WalletModal } from './components/WalletModal';

type FirebaseModule = typeof import('./lib/firebase');
let firebasePromise: Promise<FirebaseModule> | null = null;
const loadFirebase = () => (firebasePromise ??= import('./lib/firebase'));

/** Opens a link in a new tab without giving it access to this page. Returns false if blocked. */
function openInNewTab(url: string): boolean {
  const win = window.open('about:blank', '_blank');
  if (!win) return false;
  win.opener = null;
  win.location.href = url;
  return true;
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => loadPref<Theme>('theme', 'system'));
  useEffect(() => {
    savePref('theme', theme);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches));
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  return [theme, setTheme] as const;
}

function Shell() {
  const toast = useToast();
  const me = useMemo(getDevice, []);
  const isMobile = me.type !== 'desktop';
  const [theme, setTheme] = useTheme();

  const [session, setSession] = useState<RoomSession | null>(null);
  const [boot, setBoot] = useState<'loading' | 'ready' | 'unreachable'>('loading');
  const [busy, setBusy] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [busyWallet, setBusyWallet] = useState<string | null>(null);
  const [qrItem, setQrItem] = useState<SharedItem | null>(null);
  const [pairSignal, setPairSignal] = useState(0);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [autoOpen, setAutoOpen] = useState(() => loadPref('autoOpen', false));
  const firebaseRef = useRef<FirebaseModule | null>(null);
  const autoOpenRef = useRef(autoOpen);
  autoOpenRef.current = autoOpen;
  const unread = useRef(0);

  const adopt = useCallback((s: RoomSession) => {
    saveSession(s);
    setSession(s);
    setBoot('ready');
  }, []);

  const startFreshRoom = useCallback(async () => {
    try {
      adopt(await api.newRoom());
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) setBoot('unreachable');
      else toast({ tone: 'error', title: 'Could not start a room', body: (err as Error).message });
    }
  }, [adopt, toast]);

  /* ---------------------------------- boot ---------------------------------- */

  const runBoot = useCallback(async () => {
    setBoot('loading');
    const params = new URLSearchParams(location.search);
    const pairToken = params.get('pair');
    if (pairToken) {
      // Opened from a pairing QR code: remove the token from the address bar right away.
      params.delete('pair');
      history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
      try {
        adopt(await api.claimPairToken(pairToken));
        toast({ tone: 'success', title: 'Connected', body: 'This device is now paired. Anything you send appears on both screens.' });
        return;
      } catch (err) {
        if (err instanceof ApiError && err.status === 0) return setBoot('unreachable');
        toast({ tone: 'error', title: 'QR code did not work', body: (err as Error).message }, 8000);
      }
    }

    const saved = loadSession();
    if (saved) {
      try {
        await api.checkSession(saved.token);
        adopt(saved);
        return;
      } catch (err) {
        if (err instanceof ApiError && err.status === 0) return setBoot('unreachable');
      }
    }
    await startFreshRoom();
  }, [adopt, startFreshRoom, toast]);

  useEffect(() => {
    runBoot();
  }, []);

  // Load Google sign-in ahead of time. Safari/iOS only allow the sign-in popup if it
  // opens right after the tap, with no downloading in between.
  useEffect(() => {
    if (boot !== 'ready' || session?.method === 'google') return;
    const start = () =>
      loadFirebase()
        .then(async (m) => {
          await m.authReady();
          firebaseRef.current = m;
        })
        .catch(() => {});
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
    if (idle) idle(start);
    else setTimeout(start, 1500);
  }, [boot, session?.method]);

  /* ------------------------------- real time -------------------------------- */

  const onNewItem = useCallback(
    (item: SharedItem) => {
      setFreshIds((s) => new Set(s).add(item.id));
      setTimeout(() => setFreshIds((s) => {
        const n = new Set(s);
        n.delete(item.id);
        return n;
      }), 3000);
      navigator.vibrate?.(30);

      if (document.visibilityState === 'hidden') {
        unread.current += 1;
        document.title = `(${unread.current}) qrLinkShare`;
      }

      const what = item.kind === 'link' ? 'link' : item.kind === 'file' ? 'file' : 'note';
      if (item.kind === 'link' && autoOpenRef.current && openInNewTab(item.url!)) return;
      toast({
        tone: 'info',
        title: `New ${what} from ${item.from.name}`,
        body: item.kind === 'link' ? item.url : item.kind === 'file' ? item.file?.name : item.text?.slice(0, 120),
        action: item.kind === 'link' ? { label: 'Open', onClick: () => openInNewTab(item.url!) } : undefined,
      });
    },
    [toast]
  );

  const onDeviceJoined = useCallback(
    (d: DeviceInfo) => {
      if (d.id === me.id) return;
      setPairSignal((n) => n + 1);
      toast({ tone: 'success', title: `${d.name} connected`, body: 'You can now send things between these devices.' });
    },
    [me.id, toast]
  );

  const room = useRoom(session, {
    onNewItem,
    onDeviceJoined,
    onUnauthorized: () => {
      toast({ tone: 'error', title: 'Session expired', body: 'Starting a new room. Pair your devices again.' });
      startFreshRoom();
    },
  });

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        unread.current = 0;
        document.title = 'qrLinkShare: send files between phone and computer';
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const peerCount = room.devices.filter((d) => d.id !== me.id).length;

  /* -------------------------------- actions --------------------------------- */

  const claimPin = async (pin: string) => {
    setBusy(true);
    try {
      adopt(await api.claimPin(pin));
      toast({ tone: 'success', title: 'Connected', body: 'This device is now paired.' });
    } catch (err) {
      toast({ tone: 'error', title: 'Could not connect', body: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const onScanned = async (text: string) => {
    let token: string | null = null;
    try {
      token = new URL(text).searchParams.get('pair');
    } catch {
      // not a URL
    }
    if (!token) {
      toast({ tone: 'error', title: 'Not a pairing code', body: 'Scan the QR code shown under "Show code" on the other device.' });
      return;
    }
    setBusy(true);
    try {
      adopt(await api.claimPairToken(token));
      toast({ tone: 'success', title: 'Connected', body: 'This device is now paired.' });
    } catch (err) {
      toast({ tone: 'error', title: 'Could not connect', body: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const signInGoogle = async () => {
    setBusy(true);
    try {
      // Normally already loaded (see the preload above), so the popup opens straight from the tap.
      const fb = firebaseRef.current ?? (await loadFirebase());
      const idToken = await fb.getGoogleIdToken();
      const s = await api.googleSignIn(idToken);
      adopt(s);
      toast({ tone: 'success', title: `Signed in as ${s.account}`, body: 'Sign in with the same Google account on your other device.' });
    } catch (err) {
      const code = (err as { code?: string }).code || '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
      const body =
        code === 'auth/unauthorized-domain'
          ? 'This website is not on the allowed list in Firebase. Add it under Firebase → Authentication → Settings → Authorized domains.'
          : code === 'auth/popup-blocked'
            ? 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.'
            : (err as Error).message;
      toast({ tone: 'error', title: 'Google sign-in failed', body }, 9000);
    } finally {
      setBusy(false);
    }
  };

  const pickWallet = async (wallet: WalletOption) => {
    setBusyWallet(wallet.id);
    try {
      const s = await signInWithWallet(wallet);
      adopt(s);
      setWalletOpen(false);
      toast({ tone: 'success', title: `Wallet ${s.account} connected`, body: 'Connect the same wallet on your other device.' });
    } catch (err) {
      toast({ tone: 'error', title: 'Wallet sign-in failed', body: walletErrorMessage(err) });
    } finally {
      setBusyWallet(null);
    }
  };

  const leave = async () => {
    if (session?.method === 'google') await (await loadFirebase()).signOutGoogle();
    saveSession(null);
    await startFreshRoom();
    toast({ tone: 'info', title: session?.method === 'google' || session?.method === 'wallet' ? 'Signed out' : 'Left the room', body: 'This device is now in a new, empty room.' });
  };

  const copy = (text: string, what: string) => {
    copyText(text)
      .then(() => toast({ tone: 'success', title: `${what} copied` }, 2000))
      .catch(() => toast({ tone: 'error', title: 'Copy failed', body: 'Your browser blocked clipboard access.' }));
  };

  const deleteItem = async (item: SharedItem) => {
    if (!session) return;
    room.removeLocal(item.id);
    api.deleteItem(session, item.id).catch((err) => toast({ tone: 'error', title: 'Delete failed', body: err.message }));
  };

  const clearAll = async () => {
    if (!session) return;
    room.clearLocal();
    api.clearRoom(session).catch((err) => toast({ tone: 'error', title: 'Clear failed', body: err.message }));
  };

  /* --------------------------------- render --------------------------------- */

  if (boot === 'unreachable') return <Unreachable onRetry={runBoot} />;
  if (boot === 'loading' || !session) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-4">
        <Logo />
        <Loader2 className="w-5 h-5 animate-spin text-muted" aria-label="Loading" />
      </div>
    );
  }

  const isAccount = session.method === 'google' || session.method === 'wallet';
  const deviceList = (
    <DeviceList
      devices={room.devices.length ? room.devices : [{ ...me, method: session.method, joinedAt: '' }]}
      myDeviceId={me.id}
      onLeave={leave}
      leaveLabel={isAccount ? 'Sign out on this device' : 'Leave & start a new room'}
    />
  );

  return (
    <div className="min-h-dvh flex flex-col">
      <Header
        session={session}
        status={room.status}
        deviceCount={room.devices.length}
        theme={theme}
        onTheme={setTheme}
        onSignOut={leave}
      />

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {peerCount === 0 && room.items.length === 0 && (
          <div className="mb-6 sm:mb-8 max-w-2xl animate-rise">
            <h1 className="text-[28px] sm:text-4xl font-extrabold tracking-tight leading-[1.1]">
              Phone <span className="text-brand">⇄</span> computer.
              <br className="hidden sm:block" /> Send anything, instantly.
            </h1>
            <p className="mt-3 text-muted text-[15px] sm:text-base">
              Links, photos, PDFs, documents and notes, both ways, in real time. No app, no cable, no emailing yourself.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] gap-5 lg:gap-8 items-start">
          <aside className="space-y-5 lg:sticky lg:top-24">
            <ConnectPanel
              session={session}
              isMobile={isMobile}
              compact={peerCount > 0}
              busy={busy}
              refreshSignal={pairSignal}
              onClaimPin={claimPin}
              onScanned={onScanned}
              onGoogle={signInGoogle}
              onWallet={() => setWalletOpen(true)}
            />
            <div className="hidden lg:block">{deviceList}</div>
          </aside>

          <div className="space-y-6 min-w-0">
            <Composer session={session} peerCount={peerCount} onSent={room.addLocal} />
            <Feed
              items={room.items}
              loading={room.status === 'connecting' && room.items.length === 0}
              myDeviceId={me.id}
              freshIds={freshIds}
              autoOpen={autoOpen}
              onToggleAutoOpen={() => {
                const v = !autoOpen;
                setAutoOpen(v);
                savePref('autoOpen', v);
                if (v) toast({ tone: 'info', title: 'Auto-open is on', body: 'If links don’t open, allow pop-ups for this site in your browser.' }, 6000);
              }}
              onCopy={copy}
              onShowQr={setQrItem}
              onDelete={deleteItem}
              onClearAll={clearAll}
            />
            <div className="lg:hidden">{deviceList}</div>
          </div>
        </div>
      </main>

      <footer className="border-t border-line">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 flex flex-col sm:flex-row gap-2 justify-between text-xs text-muted">
          <span>qrLinkShare. Items are stored on the server for 24 hours, then deleted.</span>
          <span>Pair with QR · PIN · Google · Web3 wallet</span>
        </div>
      </footer>

      <ItemQrModal item={qrItem} onClose={() => setQrItem(null)} />
      <WalletModal
        open={walletOpen}
        isMobile={isMobile}
        busyWallet={busyWallet}
        onClose={() => setWalletOpen(false)}
        onPick={pickWallet}
      />
    </div>
  );
}

function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="min-h-dvh flex items-center justify-center p-4">
      <div className="card max-w-md w-full p-6 sm:p-8 text-center">
        <div className="mx-auto w-12 h-12 rounded-2xl bg-surface-2 flex items-center justify-center">
          <ServerCrash className="w-6 h-6 text-danger" />
        </div>
        <h1 className="mt-4 text-xl font-bold">Can’t reach the server</h1>
        <p className="mt-2 text-sm text-muted">
          qrLinkShare needs its live server to pass files between devices. Check your internet connection and try again.
        </p>
        <p className="mt-3 text-xs text-muted">
          Hosting this page on GitHub Pages? Deploy the server too (for example on Render) and build the page with{' '}
          <code className="font-mono">VITE_SERVER_URL</code> pointing to it.
        </p>
        <button type="button" className="btn btn-primary mt-6" onClick={onRetry}>
          <RefreshCw className="w-4 h-4" /> Try again
        </button>
      </div>
    </div>
  );
}

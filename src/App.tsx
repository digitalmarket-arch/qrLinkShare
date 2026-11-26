import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Account, DeviceInfo, Retention, StoredItem } from './types/share';
import { copyText, downloadBlob, openInNewTab } from './lib/browser';
import { loadPref, savePref, setPrivateMode, forgetPairing } from './lib/settings';
import { parseInviteLink, randomSecret } from './lib/pairing';
import { cleanPin, shortAddress } from './lib/shared';
import { deleteDatabase } from './lib/db';
import { createBackup, restoreBackup } from './lib/backup';
import { unlockWalletRoom, walletErrorMessage, type WalletOption } from './lib/wallet';
import { useP2P, type IncomingNotice } from './hooks/useP2P';
import { ToastProvider, useToast } from './components/Toasts';
import { Header, Logo, type Theme } from './components/Header';
import { ConnectPanel } from './components/ConnectPanel';
import { DeviceList } from './components/DeviceList';
import { DevicePanel } from './components/DevicePanel';
import { Composer } from './components/Composer';
import { Feed } from './components/Feed';
import { ItemQrModal } from './components/ItemQrModal';
import { KnockModal } from './components/KnockModal';
import { WalletModal } from './components/WalletModal';

type FirebaseModule = typeof import('./lib/firebase');
let firebasePromise: Promise<FirebaseModule> | null = null;
const loadFirebase = () => (firebasePromise ??= import('./lib/firebase'));

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

/** Reads (and removes from the address bar) a pairing invitation or text shared into the app. */
function takeLaunchParams(): { invite: string | null; shared: string } {
  const invite = parseInviteLink(location.hash);
  const q = new URLSearchParams(location.search);
  const shared = [q.get('share-title'), q.get('share-text'), q.get('share-url')].filter(Boolean).join('\n').trim();
  if (invite || shared || location.hash) {
    ['share-title', 'share-text', 'share-url'].forEach((k) => q.delete(k));
    history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
  }
  return { invite, shared };
}

function Shell() {
  const toast = useToast();
  const [theme, setTheme] = useTheme();
  const [launch] = useState(takeLaunchParams);

  const [joining, setJoining] = useState<string | null>(null);
  const [knock, setKnock] = useState<DeviceInfo | null>(null);
  const knockAnswer = useRef<((allow: boolean) => void) | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [busyWallet, setBusyWallet] = useState<string | null>(null);
  const [qrItem, setQrItem] = useState<StoredItem | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [autoOpen, setAutoOpen] = useState(() => loadPref('autoOpen', false));
  const firebaseRef = useRef<FirebaseModule | null>(null);
  const autoOpenRef = useRef(autoOpen);
  autoOpenRef.current = autoOpen;
  const unread = useRef(0);

  const problem = useCallback((message: string) => toast({ tone: 'error', title: 'Something went wrong', body: message }, 8000), [toast]);

  const onIncoming = useCallback(
    ({ item, from }: IncomingNotice) => {
      setFreshIds((s) => new Set(s).add(item.id));
      setTimeout(
        () =>
          setFreshIds((s) => {
            const n = new Set(s);
            n.delete(item.id);
            return n;
          }),
        3000
      );
      navigator.vibrate?.(30);
      if (document.visibilityState === 'hidden') {
        unread.current += 1;
        document.title = `(${unread.current}) qrLinkShare`;
      }
      if (item.kind === 'link' && autoOpenRef.current && openInNewTab(item.url!)) return;
      const what = item.kind === 'link' ? 'link' : item.kind === 'file' ? 'file' : 'note';
      toast({
        tone: 'info',
        title: `New ${item.retention === 'saved' ? 'saved ' : ''}${what} from ${from.name}`,
        body: item.kind === 'link' ? item.url : item.kind === 'file' ? item.file?.name : item.text?.slice(0, 120),
        action: item.kind === 'link' ? { label: 'Open', onClick: () => openInNewTab(item.url!) } : undefined,
      });
    },
    [toast]
  );

  const p2p = useP2P({ onIncoming, onProblem: problem });
  const isMobile = p2p.self.type !== 'desktop';

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

  /* ------------------------------- pairing ------------------------------- */

  const join = useCallback(
    async (code: { invite?: string; pin?: string }) => {
      const mesh = p2p.mesh.current;
      if (!mesh) return;
      setJoining(code.pin ? 'Waiting for the other device to approve…' : 'Connecting to the other device…');
      try {
        const secret = await mesh.joinWith(code, code.pin ? 90_000 : 45_000);
        await p2p.switchGroup(secret);
        toast({ tone: 'success', title: 'Paired', body: 'These devices now connect automatically whenever both have this page open.' });
      } catch (err) {
        toast({ tone: 'error', title: 'Could not pair', body: (err as Error).message }, 9000);
      } finally {
        setJoining(null);
      }
    },
    [p2p.mesh, p2p.switchGroup, toast]
  );

  // Opened from a pairing QR code (also when the link is opened in a tab that already has the app).
  useEffect(() => {
    if (!p2p.ready) return;
    if (launch.invite) void join({ invite: launch.invite });
    const onHash = () => {
      const invite = parseInviteLink(location.hash);
      if (!invite) return;
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      void join({ invite });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [p2p.ready]);

  const onKnock = useCallback(
    (device: DeviceInfo) =>
      new Promise<boolean>((resolve) => {
        knockAnswer.current?.(false); // only one request at a time
        knockAnswer.current = resolve;
        setKnock(device);
      }),
    []
  );

  const answerKnock = (allow: boolean) => {
    knockAnswer.current?.(allow);
    knockAnswer.current = null;
    setKnock(null);
  };

  const onPaired = useCallback(
    (device: DeviceInfo) => toast({ tone: 'success', title: `${device.name} paired`, body: 'You can now send things between these devices.' }),
    [toast]
  );

  const onScanned = (text: string) => {
    const invite = parseInviteLink(text);
    if (!invite) {
      toast({ tone: 'error', title: 'Not a pairing code', body: 'Scan the QR code shown under "Show code" on the other device.' });
      return;
    }
    void join({ invite });
  };

  const onEnterPin = (raw: string) => {
    const pin = cleanPin(raw);
    if (pin) void join({ pin });
  };

  const unpair = async () => {
    if (!confirm('Unpair this device? It stops connecting to the devices you paired with QR code or PIN. Your items stay on this device.')) return;
    await p2p.switchGroup(randomSecret());
    p2p.forgetDevices('paired');
    toast({ tone: 'info', title: 'Unpaired', body: 'Pair again any time with a QR code or PIN.' });
  };

  /* ------------------------------- accounts ------------------------------- */

  /**
   * Google sign-in is only loaded when someone taps the button, so people who never use
   * it never contact Google. The first time, Safari may block the popup because loading
   * took a moment; the module is then ready and a second tap works.
   */
  const signInGoogle = async () => {
    let fb = firebaseRef.current;
    if (!fb) {
      try {
        fb = await loadFirebase();
        await fb.setRemember(!p2p.privateMode);
        await fb.authReady();
        firebaseRef.current = fb;
      } catch {
        toast({ tone: 'error', title: 'Google sign-in could not load', body: 'Check your internet connection and try again.' });
        return;
      }
    }
    try {
      const user = await fb.signInWithGoogle();
      const acc: Account = { kind: 'google', uid: user.uid, label: user.email };
      p2p.setAccount(acc);
      toast({ tone: 'success', title: `Signed in as ${user.email}`, body: 'Sign in with the same Google account on your other device.' });
    } catch (err) {
      const code = (err as { code?: string }).code || '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
      const body =
        code === 'auth/unauthorized-domain'
          ? 'This website is not on the allowed list in Firebase. Add it under Firebase → Authentication → Settings → Authorized domains.'
          : code === 'auth/popup-blocked'
            ? 'Google sign-in is ready now. Tap “Continue with Google” again.'
            : (err as Error).message;
      toast({ tone: code === 'auth/popup-blocked' ? 'info' : 'error', title: code === 'auth/popup-blocked' ? 'One more tap' : 'Google sign-in failed', body }, 9000);
    }
  };

  const pickWallet = async (wallet: WalletOption) => {
    setBusyWallet(wallet.id);
    try {
      const { address, roomKey } = await unlockWalletRoom(wallet);
      p2p.setAccount({ kind: 'wallet', address, label: shortAddress(address), roomKey });
      setWalletOpen(false);
      toast({ tone: 'success', title: `Wallet ${shortAddress(address)} linked`, body: 'Link the same wallet on your other device.' });
    } catch (err) {
      toast({ tone: 'error', title: 'Wallet sign-in failed', body: walletErrorMessage(err) });
    } finally {
      setBusyWallet(null);
    }
  };

  const signOut = async () => {
    if (p2p.account?.kind === 'google') await (await loadFirebase()).signOutGoogle();
    if (p2p.account) p2p.forgetDevices(p2p.account.kind);
    p2p.setAccount(null);
    toast({ tone: 'info', title: 'Signed out', body: 'Devices paired by QR code or PIN stay connected.' });
  };

  /* ------------------------------- this device ------------------------------- */

  const togglePrivate = async () => {
    if (!p2p.privateMode) {
      if (!confirm('Keep nothing on this computer?\n\nThis deletes everything qrLinkShare stored in this browser (items and pairing) and reloads. From now on nothing is kept after the tab closes.')) return;
      if (p2p.account?.kind === 'google') await (await loadFirebase()).signOutGoogle();
      forgetPairing();
      await deleteDatabase();
      setPrivateMode(true);
    } else {
      if (!confirm('Start keeping items on this computer again?\n\nItems in this tab right now will be cleared, and the page reloads.')) return;
      forgetPairing();
      setPrivateMode(false);
    }
    location.reload();
  };

  const backup = async () => {
    const store = p2p.store.current;
    if (!store) return;
    const blob = await createBackup(store);
    downloadBlob(blob, `qrlinkshare-backup-${new Date().toISOString().slice(0, 10)}.json`);
  };

  const restore = async (file: File) => {
    const store = p2p.store.current;
    if (!store) return;
    try {
      const added = await restoreBackup(store, file);
      await p2p.refresh();
      toast({ tone: 'success', title: added ? `Restored ${added} item${added > 1 ? 's' : ''}` : 'Nothing new to restore', body: added ? 'They are in Saved.' : undefined });
    } catch (err) {
      toast({ tone: 'error', title: 'Restore failed', body: (err as Error).message });
    }
  };

  /* --------------------------------- items --------------------------------- */

  const copy = (text: string, what: string) => {
    copyText(text)
      .then(() => toast({ tone: 'success', title: `${what} copied` }, 2000))
      .catch(() => toast({ tone: 'error', title: 'Copy failed', body: 'Your browser blocked clipboard access.' }));
  };

  const keep = async (item: StoredItem) => {
    await p2p.keepForever(item.id);
    toast({ tone: 'success', title: 'Moved to Saved', body: 'It stays on this device until you delete it.' }, 3000);
  };

  const clear = (retention: Retention) => void p2p.removeAll(retention);

  /* --------------------------------- render --------------------------------- */

  if (!p2p.ready) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-4">
        <Logo />
        <Loader2 className="w-5 h-5 animate-spin text-muted" aria-label="Loading" />
      </div>
    );
  }

  const deviceCount = p2p.devices.length;
  const savedCount = p2p.items.filter((i) => i.retention === 'saved').length;
  return (
    <div className="min-h-dvh flex flex-col">
      <Header
        ready={p2p.ready}
        relay={p2p.relay}
        deviceCount={deviceCount}
        account={p2p.account}
        theme={theme}
        onTheme={setTheme}
        onSignOut={signOut}
      />

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {deviceCount === 0 && p2p.items.length === 0 && (
          <div className="mb-6 sm:mb-8 max-w-2xl animate-rise">
            <h1 className="text-[28px] sm:text-4xl font-extrabold tracking-tight leading-[1.1]">
              Phone <span className="text-brand">⇄</span> computer.
              <br className="hidden sm:block" /> Directly, privately.
            </h1>
            <p className="mt-3 text-muted text-[15px] sm:text-base">
              Links, photos, PDFs, documents and notes go straight from one device to the other. Nothing is stored on any server.
            </p>
          </div>
        )}

        {/* One copy of each panel; on computers the left column holds connect + devices + data. */}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:grid-rows-[auto_auto_auto_1fr] gap-5 lg:gap-x-8 items-start">
          <div className="lg:col-start-1 lg:row-start-1">
            <ConnectPanel
              mesh={p2p.mesh.current}
              groupSecret={p2p.groupSecret}
              account={p2p.account}
              isMobile={isMobile}
              compact={deviceCount > 0}
              joining={joining}
              onKnock={onKnock}
              onPaired={onPaired}
              onEnterPin={onEnterPin}
              onScanned={onScanned}
              onGoogle={signInGoogle}
              onWallet={() => setWalletOpen(true)}
            />
          </div>

          <div className="space-y-6 min-w-0 lg:col-start-2 lg:row-start-1 lg:row-span-4">
            <Composer deviceCount={deviceCount} initialText={launch.shared} sendText={p2p.sendText} sendFile={p2p.sendFile} />
            <Feed
              items={p2p.items}
              loading={false}
              myDeviceId={p2p.self.id}
              freshIds={freshIds}
              progress={p2p.progress}
              autoOpen={autoOpen}
              onToggleAutoOpen={() => {
                const v = !autoOpen;
                setAutoOpen(v);
                savePref('autoOpen', v);
                if (v) toast({ tone: 'info', title: 'Auto-open is on', body: 'If links don’t open, allow pop-ups for this site in your browser.' }, 6000);
              }}
              getBlob={p2p.getBlob}
              onCopy={copy}
              onShowQr={setQrItem}
              onKeep={keep}
              onDelete={(item) => void p2p.remove(item.id)}
              onRetry={(item) => void p2p.retry(item.id)}
              onClear={clear}
              onProblem={problem}
            />
          </div>

          <div className="lg:col-start-1 lg:row-start-2">
            <DeviceList self={p2p.self} devices={p2p.devices} offline={p2p.knownDevices} onUnpair={unpair} />
          </div>
          <div className="lg:col-start-1 lg:row-start-3">
            <DevicePanel
              privateMode={p2p.privateMode}
              persistent={p2p.persistent}
              savedCount={savedCount}
              onTogglePrivate={togglePrivate}
              onBackup={backup}
              onRestore={restore}
            />
          </div>
        </div>
      </main>

      <footer className="border-t border-line">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 flex flex-col sm:flex-row gap-2 justify-between text-xs text-muted">
          <span>qrLinkShare: devices talk directly to each other. Nothing is stored on any server.</span>
          <span>Pair with QR · PIN · Google · Web3 wallet</span>
        </div>
      </footer>

      <ItemQrModal item={qrItem} onClose={() => setQrItem(null)} />
      <KnockModal device={knock} onAnswer={answerKnock} />
      <WalletModal open={walletOpen} isMobile={isMobile} busyWallet={busyWallet} onClose={() => setWalletOpen(false)} onPick={pickWallet} />
    </div>
  );
}

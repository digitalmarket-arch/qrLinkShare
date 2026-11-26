import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { clearUserIdentity } from 'trystero';
import type { Account, DeviceInfo, LinkMethod, Retention, StoredItem } from './types/share';
import { copyText, downloadBlob, openInNewTab, safariMayDelete } from './lib/browser';
import { loadPref, savePref, setPrivateMode, forgetPairing } from './lib/settings';
import { APP_ID, parseInviteLink, randomSecret } from './lib/pairing';
import { cleanPin, shortAddress } from './lib/shared';
import { deleteDatabase, deleteNamedDatabase } from './lib/db';
import { createBackup, restoreBackup } from './lib/backup';
import { unlockWalletRoom, walletErrorMessage, type WalletOption } from './lib/wallet';
import { extractLinks } from './lib/linkify';
import { takeSharedText } from './lib/shareTarget';
import type { JoinStatus } from './lib/mesh';
import { useP2P, type IncomingNotice } from './hooks/useP2P';
import { ToastProvider, useToast } from './components/Toasts';
import { Header, Logo, type Theme } from './components/Header';
import { ConnectPanel, type JoinUi } from './components/ConnectPanel';
import { DeviceList } from './components/DeviceList';
import { DevicePanel } from './components/DevicePanel';
import { Composer } from './components/Composer';
import { Feed } from './components/Feed';
import { ItemQrModal } from './components/ItemQrModal';
import { KnockModal, type Knock } from './components/KnockModal';
import { WalletModal } from './components/WalletModal';

type FirebaseModule = typeof import('./lib/firebase');
let firebasePromise: Promise<FirebaseModule> | null = null;
const loadFirebase = () =>
  (firebasePromise ??= import('./lib/firebase').catch((err) => {
    firebasePromise = null;
    throw err;
  }));

/** Removes what Google sign-in saved in this browser (before switching to "keep nothing"). */
async function clearFirebaseTraces() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('firebase:')) localStorage.removeItem(k);
  } catch {
    // storage blocked
  }
  await deleteNamedDatabase('firebaseLocalStorageDb');
  await deleteNamedDatabase('firebase-heartbeat-database');
}

const METHOD_NAME: Record<LinkMethod, string> = { paired: 'QR / PIN pairing', google: 'Google', wallet: 'the wallet' };

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

/**
 * Reads what the app was opened with, and removes it from the address bar:
 *  - text shared into the app from another app (Android share menu; see shareTarget.ts)
 *  - a pairing invitation after "#" (from a QR code)
 */
function takeLaunchParams(): { invite: string | null; shared: Promise<string> } {
  const shared = takeSharedText(); // first: it reads (and cleans) the query part of the address
  const invite = parseInviteLink(location.hash);
  if (location.hash) history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  return { invite, shared };
}

function Shell() {
  const toast = useToast();
  const [theme, setTheme] = useTheme();
  const [launch] = useState(takeLaunchParams);
  const [sharedText, setSharedText] = useState('');
  useEffect(() => {
    void launch.shared.then((t) => t && setSharedText(t));
  }, [launch]);

  const [joining, setJoining] = useState<JoinUi | null>(null);
  const joinAbort = useRef<AbortController | null>(null);
  const [knock, setKnock] = useState<Knock | null>(null);
  /** "Allow this device?" questions, shown one at a time (several devices may ask at once). */
  const knockQueue = useRef<Array<{ knock: Knock; resolve: (allow: boolean) => void }>>([]);
  const showNextKnock = () => setKnock(knockQueue.current[0]?.knock ?? null);
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
      // Browsers only allow vibration after the person has tapped the page once.
      if ((navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive) navigator.vibrate?.(30);
      if (document.visibilityState === 'hidden') {
        unread.current += 1;
        document.title = `(${unread.current}) qrLinkShare`;
      }
      // A note that contains exactly one link (e.g. shared from a maps or shopping app) opens like a link.
      const noteLinks = item.kind === 'text' ? extractLinks(item.text ?? '') : [];
      const link = item.kind === 'link' ? item.url! : noteLinks.length === 1 ? noteLinks[0] : null;
      if (link && autoOpenRef.current && openInNewTab(link)) return;
      const what = item.kind === 'link' ? 'link' : item.kind === 'file' ? 'file' : 'note';
      toast({
        tone: 'info',
        title: `New ${item.retention === 'saved' ? 'saved ' : ''}${what} from ${from.name}`,
        body: item.kind === 'link' ? item.url : item.kind === 'file' ? item.file?.name : item.text?.slice(0, 120),
        action: link ? { label: 'Open', onClick: () => openInNewTab(link) } : undefined,
      });
    },
    [toast]
  );

  /** Shows the "Allow this device?" sheet; it closes by itself if that device gives up. */
  const askKnock = useCallback(
    (device: DeviceInfo, reason: Knock['reason'], code: string, signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        if (signal.aborted) return resolve(false);
        const entry = { knock: { device, reason, code }, resolve };
        knockQueue.current.push(entry);
        if (knockQueue.current.length === 1) showNextKnock();
        signal.addEventListener(
          'abort',
          () => {
            const i = knockQueue.current.indexOf(entry);
            if (i === -1) return;
            knockQueue.current.splice(i, 1);
            resolve(false);
            if (i === 0) showNextKnock();
            if (reason === 'pin') toast({ tone: 'info', title: `${device.name} stopped waiting`, body: 'Nothing was connected.' }, 4000);
          },
          { once: true }
        );
      }),
    [toast]
  );

  const onDeviceGone = useCallback(
    (name: string, method: LinkMethod, still: LinkMethod[]) => {
      const title = method === 'paired' ? `${name} unpaired` : `${name} signed out of ${method === 'google' ? 'Google' : 'the wallet'}`;
      const body = still.length
        ? `It's still connected through ${still.map((m) => METHOD_NAME[m]).join(' and ')}.`
        : 'It no longer connects to this device.';
      toast({ tone: 'info', title, body }, 5000);
    },
    [toast]
  );

  const p2p = useP2P({
    onIncoming,
    onProblem: problem,
    onAccountKnock: (device, code, signal) => askKnock(device, 'account', code, signal),
    onDeviceGone,
    onGroupMove: (from) =>
      toast({ tone: 'info', title: `${from.name} paired with another device`, body: 'This device now connects to it too.' }, 6000),
  });
  const isMobile = p2p.self.type !== 'desktop';

  // Google sign-in: load its code now, so a new version published while this tab stays open
  // can't break it later.
  useEffect(() => {
    if (!p2p.ready || p2p.account?.kind !== 'google') return;
    void loadFirebase().catch(() => {});
    void import('./lib/verify').then((m) => m.preloadVerifier()).catch(() => {});
  }, [p2p.ready, p2p.account?.kind]);

  // A part of the app couldn't be downloaded (offline, or a newer version replaced it).
  useEffect(() => {
    const onPreloadError = () =>
      toast(
        {
          tone: 'info',
          title: 'Part of qrLinkShare couldn’t load',
          body: 'You may be offline, or a new version is out. Reload to continue.',
          action: { label: 'Reload', onClick: () => location.reload() },
        },
        10000
      );
    window.addEventListener('vite:preloadError', onPreloadError);
    return () => window.removeEventListener('vite:preloadError', onPreloadError);
  }, [toast]);

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
      joinAbort.current?.abort();
      const abort = new AbortController();
      joinAbort.current = abort;
      const label: Record<JoinStatus, string> = {
        looking: code.pin ? 'Looking for the device showing this PIN…' : 'Looking for the other device…',
        found: 'Connecting to the other device…',
        approval: code.pin ? 'Now tap Allow on the other device.' : 'Connecting to the other device…',
      };
      const live = () => !abort.signal.aborted && joinAbort.current === abort;
      setJoining({ text: label.looking });
      // This device's other paired devices, named in the questions below.
      const others = [
        ...p2p.devices.filter((d) => d.method === 'paired'),
        ...p2p.knownDevices.filter((d) => d.methods.includes('paired')),
      ].map((d) => d.name);
      const othersText = others.length ? others.slice(0, 3).join(', ') + (others.length > 3 ? '…' : '') : 'your other paired devices';
      try {
        const res = await mesh.joinWith(code, {
          mySecret: p2p.currentGroup,
          paired: p2p.hasPaired(),
          signal: abort.signal,
          onStatus: (st) => live() && setJoining((j) => ({ ...(j ?? {}), text: label[st] })),
          confirm: ({ code: sas, host, merge }) =>
            new Promise<boolean>((resolve) => {
              if (!live()) return resolve(false);
              const onAnswer = (yes: boolean) => {
                if (live()) setJoining((j) => (j ? { ...j, ask: undefined, text: yes ? label.approval : j.text } : j));
                resolve(yes);
              };
              abort.signal.addEventListener('abort', () => resolve(false), { once: true });
              if (sas) {
                setJoining({
                  text: 'Found it. Compare this code with the other screen.',
                  code: sas,
                  ask: {
                    question: merge
                      ? `Does the other device show this same code? Pairing also connects it to ${othersText}.`
                      : 'Does the other device show this same code?',
                    yes: 'It matches',
                    onAnswer,
                  },
                });
              } else {
                setJoining({
                  text: `Pair with ${host?.name ?? 'this device'}?`,
                  ask: { question: `${othersText} will connect to it too.`, yes: 'Pair', onAnswer },
                });
              }
            }),
        });
        if (!res.adopted) await p2p.joinGroup(res.secret);
        toast({
          tone: 'success',
          title: res.host ? `Paired with ${res.host.name}` : 'Paired',
          body: 'These devices now connect automatically whenever both have this page open.',
        });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') toast({ tone: 'error', title: 'Could not pair', body: (err as Error).message }, 9000);
      } finally {
        if (joinAbort.current === abort) {
          joinAbort.current = null;
          setJoining(null);
        }
      }
    },
    [p2p.mesh, p2p.currentGroup, p2p.hasPaired, p2p.joinGroup, p2p.devices, p2p.knownDevices, toast]
  );
  const joinRef = useRef(join);
  joinRef.current = join;
  const cancelJoin = () => {
    joinAbort.current?.abort();
    joinAbort.current = null;
    setJoining(null);
  };

  // Opened from a pairing QR code (also when the link is opened in a tab that already has the app).
  useEffect(() => {
    if (!p2p.ready) return;
    if (launch.invite) void joinRef.current({ invite: launch.invite });
    const onHash = () => {
      const invite = parseInviteLink(location.hash);
      if (!invite) return;
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      void joinRef.current({ invite });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [p2p.ready]);

  const onKnock = useCallback(
    (device: DeviceInfo, code: string, signal: AbortSignal) => askKnock(device, 'pin', code, signal),
    [askKnock]
  );

  /** This device had no paired devices and the new one did: join the new one's group. */
  const onAdopt = useCallback((secret: string) => p2p.adoptGroup(secret), [p2p.adoptGroup]);

  const onCollision = useCallback(
    () =>
      toast(
        { tone: 'error', title: 'Two devices used this PIN at once', body: 'For safety a new code is shown. Try again with the new PIN.' },
        8000
      ),
    [toast]
  );

  const answerKnock = (allow: boolean) => {
    const head = knockQueue.current.shift();
    head?.resolve(allow);
    showNextKnock();
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
    await p2p.unpair(randomSecret());
    toast({ tone: 'info', title: 'Unpaired', body: 'Pair again any time with a QR code or PIN.' });
  };

  /* ------------------------------- accounts ------------------------------- */

  /**
   * Google sign-in is only loaded when someone taps the button, so people who never use
   * it never load Google's sign-in code. The first time, Safari may block the popup
   * because loading took a moment; the module is then ready and a second tap works.
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
        toast({
          tone: 'error',
          title: 'Google sign-in couldn’t load',
          body: 'You may be offline, or qrLinkShare was just updated. Reload the page to try again.',
          action: { label: 'Reload', onClick: () => location.reload() },
        });
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
    const wasGoogle = p2p.account?.kind === 'google';
    await p2p.leaveAccount().catch(() => {});
    if (wasGoogle) await loadFirebase().then((fb) => fb.signOutGoogle()).catch(() => {});
    toast({ tone: 'info', title: 'Signed out', body: 'Devices paired by QR code or PIN stay connected.' });
  };

  /* ------------------------------- this device ------------------------------- */

  const togglePrivate = async () => {
    if (!p2p.privateMode) {
      if (!confirm('Keep nothing on this computer?\n\nThis deletes everything qrLinkShare stored in this browser (items, pairing and this device’s identity) and reloads. From now on nothing is kept after the tab closes or reloads.')) return;
      try {
        // Google: sign out (best effort) and remove what it saved in this browser.
        if (p2p.account?.kind === 'google') await loadFirebase().then((fb) => fb.signOutGoogle()).catch(() => {});
        await clearFirebaseTraces();
        // Tell the other devices to forget this one: it is about to become a different device.
        await p2p.mesh.current?.sayBye('group').catch(() => {});
        await p2p.mesh.current?.sayBye('account').catch(() => {});
        // Switch first: other open tabs reload at once and let go of the database.
        setPrivateMode(true);
        forgetPairing();
        await p2p.mesh.current?.destroy();
        await clearUserIdentity(APP_ID).catch(() => {});
        await deleteDatabase();
      } finally {
        location.reload();
      }
      return;
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
    try {
      const blob = await createBackup(store);
      downloadBlob(blob, `qrlinkshare-backup-${new Date().toISOString().slice(0, 10)}.tar`);
    } catch (err) {
      toast({ tone: 'error', title: 'Backup failed', body: (err as Error).message || 'Not enough memory or storage.' });
    }
  };

  const restore = async (file: File) => {
    const store = p2p.store.current;
    if (!store) return;
    try {
      const added = await restoreBackup(store, file);
      toast({ tone: 'success', title: added ? `Restored ${added} item${added > 1 ? 's' : ''}` : 'Nothing new to restore', body: added ? 'They are in Saved.' : undefined });
    } catch (err) {
      toast({ tone: 'error', title: 'Restore failed', body: (err as Error).message });
    } finally {
      await p2p.refresh(); // a restore that stopped part-way may still have added some items
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
    toast(
      {
        tone: 'success',
        title: 'Moved to Saved',
        body: safariMayDelete()
          ? 'Kept until you delete it, but Safari deletes website data after 7 days without a visit. Back up now and then.'
          : 'It stays on this device until you delete it.',
      },
      4000
    );
  };

  const clear = (retention: Retention) => void p2p.removeAll(retention);

  /* --------------------------------- render --------------------------------- */

  if (!p2p.ready) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-4 px-4 text-center">
        <Logo />
        {p2p.startupError ? (
          <div className="card p-5 max-w-sm" role="alert">
            <p className="font-semibold flex items-center justify-center gap-2">
              <AlertTriangle className="w-4 h-4 text-danger" /> qrLinkShare couldn’t start
            </p>
            <p className="mt-2 text-sm text-muted">
              {typeof window !== 'undefined' && !window.isSecureContext
                ? 'qrLinkShare needs a secure address. Open it with https:// (or http://localhost on this computer).'
                : 'This browser may be too old. Update it (on iPhone: Settings → General → Software Update) or try another browser.'}
            </p>
            <p className="mt-2 text-xs text-muted break-words">{p2p.startupError}</p>
            <button type="button" className="btn btn-outline mt-4" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        ) : (
          <Loader2 className="w-5 h-5 animate-spin text-muted" aria-label="Loading" />
        )}
      </div>
    );
  }

  const deviceCount = p2p.devices.length;
  /** Paired or signed-in devices exist (connected now or not). */
  const paired = deviceCount > 0 || p2p.knownDevices.length > 0;
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
        {!paired && p2p.items.length === 0 && (
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
              compact={paired}
              joining={joining}
              onCancelJoin={cancelJoin}
              privateMode={p2p.privateMode}
              hasPaired={p2p.hasPaired}
              onKnock={onKnock}
              onAdopt={onAdopt}
              onPaired={onPaired}
              onCollision={onCollision}
              onEnterPin={onEnterPin}
              onScanned={onScanned}
              onGoogle={signInGoogle}
              onWallet={() => setWalletOpen(true)}
            />
          </div>

          <div className="space-y-6 min-w-0 lg:col-start-2 lg:row-start-1 lg:row-span-4">
            <Composer deviceCount={deviceCount} initialText={sharedText} sendText={p2p.sendText} sendFile={p2p.sendFile} />
            <Feed
              items={p2p.items}
              loading={false}
              myDeviceId={p2p.self.id}
              online={deviceCount > 0}
              deviceNames={p2p.deviceNames}
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
              onRetry={() => p2p.retry()}
              onClear={clear}
              onProblem={problem}
            />
          </div>

          <div className="lg:col-start-1 lg:row-start-2">
            <DeviceList
              self={p2p.self}
              devices={p2p.devices}
              offline={p2p.knownDevices}
              onUnpair={unpair}
              onForget={(d) => {
                if (confirm(`Forget ${d.name}? Use this for a device that was reset or is gone for good. It won't be sent anything any more.`)) {
                  p2p.forgetDevice(d.id);
                }
              }}
            />
          </div>
          <div className="lg:col-start-1 lg:row-start-3">
            <DevicePanel
              privateMode={p2p.privateMode}
              persistent={p2p.persistent}
              persisted={p2p.persisted}
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
      <KnockModal knock={knock} onAnswer={answerKnock} />
      <WalletModal open={walletOpen} isMobile={isMobile} busyWallet={busyWallet} onClose={() => setWalletOpen(false)} onPick={pickWallet} />
    </div>
  );
}

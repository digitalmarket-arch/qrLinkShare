import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Smartphone,
  Monitor,
  Sun,
  Moon,
  QrCode,
  Printer,
  Globe,
  ShieldCheck,
  ExternalLink,
} from 'lucide-react';
import { onAuthStateChanged } from 'firebase/auth';
import {
  ConnectedDevice,
  CreateShareItemPayload,
  DesktopAuthSession,
  DeviceType,
  RetentionMode,
  SharedItem,
} from './types/share';
import {
  buildItemDirectSharePayload,
  decodeShareUrlPayload,
  findNewestUnopenedLink,
  generateSixDigitPin,
  normalizeRoomCode,
  validatePinCode,
  validateShareSubmission,
} from './utils/shareLogic';
import { createInitialSeedItems } from './utils/seedData';
import {
  auth,
  deleteVaultItemFromFirestore,
  saveVaultItemToFirestore,
  signInWithGooglePopup,
  signOutFirebaseUser,
  subscribeToUserVaultItems,
  updateVaultItemInFirestore,
} from './lib/firebase';
import { PairingSidebar } from './components/PairingSidebar';
import { ShareComposer } from './components/ShareComposer';
import { TransferStream } from './components/TransferStream';
import { ItemQrModal } from './components/ItemQrModal';
import { QrCodeView } from './components/QrCodeView';
import { GithubPagesModal } from './components/GithubPagesModal';

function getLocalRoomItems(targetRoomId: string): SharedItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(`qrlinkshare_room_${targetRoomId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    // Ignore storage read errors
  }
  const initial =
    targetRoomId === 'SYNC-42' ? createInitialSeedItems('SYNC-42') : [];
  try {
    localStorage.setItem(
      `qrlinkshare_room_${targetRoomId}`,
      JSON.stringify(initial)
    );
  } catch {
    // Ignore storage write errors
  }
  return initial;
}

function saveLocalRoomItems(targetRoomId: string, list: SharedItem[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(
      `qrlinkshare_room_${targetRoomId}`,
      JSON.stringify(list)
    );
  } catch {
    // Ignore quota errors
  }
}

export function App() {
  const initialParams =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();

  const initialRoom =
    normalizeRoomCode(initialParams.get('room') || '') || 'SYNC-42';
  const initialDeviceMode: DeviceType =
    initialParams.get('device') === 'mobile' ? 'mobile' : 'desktop';
  const incomingQrChallenge = initialParams.get('qrLogin') || '';
  const incomingPinParam = initialParams.get('pin') || '';

  const [roomId, setRoomId] = useState<string>(initialRoom);
  const [viewMode, setViewMode] = useState<'workspace' | 'print-sheet'>(
    'workspace'
  );
  const [isMobileMode, setIsMobileMode] = useState<boolean>(
    initialDeviceMode === 'mobile'
  );
  const [darkMode, setDarkMode] = useState<boolean>(false);

  const [items, setItems] = useState<SharedItem[]>(() =>
    getLocalRoomItems(initialRoom)
  );
  const [devices, setDevices] = useState<ConnectedDevice[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [isStaticHost, setIsStaticHost] = useState<boolean>(() =>
    typeof window !== 'undefined' &&
    window.location.hostname.endsWith('github.io')
  );
  const [activeQrItem, setActiveQrItem] = useState<SharedItem | null>(null);
  const [isGhPagesModalOpen, setIsGhPagesModalOpen] = useState<boolean>(false);

  // Desktop Authentication & Auto-Open State
  const [challengeId, setChallengeId] = useState<string>(
    () =>
      incomingQrChallenge ||
      `qr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  );
  const [activePinCode, setActivePinCode] = useState<string>(() =>
    validatePinCode(incomingPinParam)
      ? incomingPinParam
      : generateSixDigitPin(428910)
  );
  const [authSession, setAuthSession] = useState<DesktopAuthSession | null>(
    null
  );
  const [autoOpenEnabled, setAutoOpenEnabled] = useState<boolean>(true);
  const [autoDeleteTempOnOpen, setAutoDeleteTempOnOpen] =
    useState<boolean>(false);
  const [lastAutoOpenedItem, setLastAutoOpenedItem] =
    useState<SharedItem | null>(null);
  const [pendingMobileChallenge, setPendingMobileChallenge] = useState<
    string | null
  >(incomingQrChallenge || null);

  const clientIdRef = useRef<string>(
    `client-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  );
  const wsRef = useRef<WebSocket | null>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);
  const itemsRef = useRef<SharedItem[]>(items);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [darkMode]);

  // Persist items to localStorage whenever they update
  useEffect(() => {
    if (!isLoading) {
      saveLocalRoomItems(roomId, items);
    }
  }, [roomId, items, isLoading]);

  const broadcastLocalSync = useCallback(
    (nextItems: SharedItem[]) => {
      saveLocalRoomItems(roomId, nextItems);
      broadcastChannelRef.current?.postMessage({
        type: 'items:sync',
        roomId,
        items: nextItems,
      });
    },
    [roomId]
  );

  // Mark a link as opened on desktop & optionally auto-delete if temporary
  const handleOpenLinkOnDesktop = useCallback(
    async (item: SharedItem, skipWindowOpen = false) => {
      if (!skipWindowOpen && typeof window !== 'undefined' && item.content) {
        try {
          window.open(item.content, '_blank', 'noopener,noreferrer');
        } catch {
          // Ignore popup block; user also has direct anchor / top launch banner
        }
      }

      setLastAutoOpenedItem(item);

      const shouldAutoClear =
        autoDeleteTempOnOpen &&
        (item.retentionMode || 'temporary') === 'temporary';

      if (shouldAutoClear) {
        setItems((prev) => {
          const next = prev.filter((i) => i.id !== item.id);
          broadcastLocalSync(next);
          return next;
        });
        if (!isStaticHost) {
          fetch(
            `/api/rooms/${encodeURIComponent(roomId)}/items/${encodeURIComponent(item.id)}`,
            { method: 'DELETE' }
          ).catch(() => {});
        }
        if (auth.currentUser?.emailVerified) {
          deleteVaultItemFromFirestore(item.id).catch(() => {});
        }
        return;
      }

      setItems((prev) => {
        const next = prev.map((i) =>
          i.id === item.id ? { ...i, openedOnDesktop: true } : i
        );
        broadcastLocalSync(next);
        return next;
      });

      if (!isStaticHost) {
        fetch(
          `/api/rooms/${encodeURIComponent(roomId)}/items/${encodeURIComponent(item.id)}/opened`,
          { method: 'PATCH' }
        ).catch(() => {});
      }

      if (auth.currentUser?.emailVerified) {
        updateVaultItemInFirestore(item.id, { openedOnDesktop: true }).catch(
          () => {}
        );
      }
    },
    [autoDeleteTempOnOpen, broadcastLocalSync, isStaticHost, roomId]
  );

  // Auto-open newest unopened link when desktop logs in
  const triggerAutoOpenNewestLink = useCallback(
    (sourceItems?: SharedItem[]) => {
      const list = sourceItems || itemsRef.current;
      const newest =
        findNewestUnopenedLink(list) ||
        list.find((item) => item.category === 'link') ||
        null;
      if (!newest) return;
      setLastAutoOpenedItem(newest);
      if (autoOpenEnabled) {
        handleOpenLinkOnDesktop(newest, false);
      }
    },
    [autoOpenEnabled, handleOpenLinkOnDesktop]
  );

  // Listen to Firebase Auth state & subscribe to user's Firestore Vault
  useEffect(() => {
    let unsubscribeVault: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      if (user) {
        setAuthSession({
          authenticated: true,
          method: 'google',
          roomId,
          userEmail: user.email || undefined,
          userUid: user.uid,
          authenticatedAt: new Date().toISOString(),
        });

        if (user.emailVerified) {
          unsubscribeVault = subscribeToUserVaultItems(
            user.uid,
            (cloudItems) => {
              if (cloudItems.length > 0) {
                setItems((prev) => {
                  const map = new Map<string, SharedItem>();
                  cloudItems.forEach((ci) => map.set(ci.id, ci));
                  prev.forEach((pi) => {
                    if (!map.has(pi.id)) map.set(pi.id, pi);
                  });
                  return Array.from(map.values());
                });
              }
            }
          );
        }
      }
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeVault) unsubscribeVault();
    };
  }, [roomId]);

  // Register QR Challenge + 6-Digit PIN on backend server
  useEffect(() => {
    if (isStaticHost) return;
    fetch('/api/auth/challenges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challengeId,
        roomId,
        pinCode: activePinCode,
      }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.challenge?.pinCode) {
          setActivePinCode(data.challenge.pinCode);
        }
      })
      .catch(() => {});
  }, [challengeId, roomId, activePinCode, isStaticHost]);

  // Cross-tab BroadcastChannel sync for static GitHub Pages mode + QR login
  useEffect(() => {
    if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return;
    const channel = new BroadcastChannel('qrlinkshare_sync');
    broadcastChannelRef.current = channel;

    channel.onmessage = (event) => {
      const msg = event.data;
      if (!msg || msg.roomId !== roomId) return;
      if (msg.type === 'items:sync' && Array.isArray(msg.items)) {
        setItems(msg.items);
      } else if (msg.type === 'auth:approved') {
        setAuthSession({
          authenticated: true,
          method: msg.method || 'qr',
          roomId,
          authenticatedAt: new Date().toISOString(),
        });
        triggerAutoOpenNewestLink();
      }
    };

    return () => {
      channel.close();
      broadcastChannelRef.current = null;
    };
  }, [roomId, triggerAutoOpenNewestLink]);

  const createLocalSharedItem = useCallback(
    (payload: CreateShareItemPayload, targetRoomId: string): SharedItem => {
      const validation = validateShareSubmission(payload);
      const resolvedCategory =
        validation.resolvedCategory || payload.category || 'text';
      const resolvedContent =
        resolvedCategory === 'link' && validation.normalizedUrl
          ? validation.normalizedUrl
          : (payload.content ?? '').trim();

      const defaultTitle =
        payload.title?.trim() ||
        payload.fileName?.trim() ||
        (resolvedCategory === 'link'
          ? resolvedContent.replace(/^https?:\/\//, '').slice(0, 48)
          : resolvedContent.slice(0, 42) || 'Shared Item');

      const sizeBytes =
        typeof payload.sizeBytes === 'number' && payload.sizeBytes > 0
          ? payload.sizeBytes
          : payload.dataUrl
            ? Math.round((payload.dataUrl.length * 3) / 4)
            : new Blob([resolvedContent]).size;

      const retentionMode: RetentionMode =
        payload.retentionMode === 'saved' ? 'saved' : 'temporary';

      return {
        id:
          payload.id ||
          `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        roomId: targetRoomId,
        category: resolvedCategory,
        title: defaultTitle,
        content: resolvedContent,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        sizeBytes,
        dataUrl: payload.dataUrl,
        senderDevice: payload.senderDevice === 'mobile' ? 'mobile' : 'desktop',
        senderName:
          payload.senderName?.trim() ||
          (payload.senderDevice === 'mobile'
            ? 'Mobile Handset'
            : 'Desktop Studio'),
        createdAt: new Date().toISOString(),
        pinned: retentionMode === 'saved',
        retentionMode,
        openedOnDesktop: false,
      };
    },
    []
  );

  // Decode incoming #share=<token> QR payload from URL hash (serverless GitHub Pages QR beam)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    if (hash.startsWith('#share=')) {
      const token = hash.slice('#share='.length);
      const decoded = decodeShareUrlPayload(token);
      if (decoded) {
        const beamedItem = createLocalSharedItem(decoded, roomId);
        setItems((prev) => {
          const next = [beamedItem, ...prev];
          saveLocalRoomItems(roomId, next);
          return next;
        });
        window.history.replaceState(
          {},
          '',
          `${window.location.pathname}${window.location.search}`
        );
      }
    }
  }, [roomId, createLocalSharedItem]);

  // Fetch room state over HTTP (or fallback to static localStorage on GitHub Pages)
  const fetchRoomState = useCallback(async (targetRoomId: string) => {
    setIsLoading(true);
    try {
      const res = await fetch(
        `/api/rooms/${encodeURIComponent(targetRoomId)}`
      );
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = await res.json();
        setItems(data.items || []);
        setDevices(data.devices || []);
        setIsStaticHost(false);
        return;
      }
      throw new Error('Static host mode');
    } catch {
      setIsStaticHost(true);
      const localItems = getLocalRoomItems(targetRoomId);
      setItems(localItems);
      setDevices([
        {
          clientId: clientIdRef.current,
          deviceName: 'GitHub Pages Static Endpoint',
          deviceType: 'desktop',
          joinedAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Connect real-time WebSocket when backend server is available
  useEffect(() => {
    fetchRoomState(roomId);

    if (
      typeof window === 'undefined' ||
      window.location.hostname.endsWith('github.io')
    ) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let unmounted = false;

    const connect = () => {
      if (unmounted) return;
      try {
        socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          if (unmounted) return;
          setWsConnected(true);
          socket?.send(
            JSON.stringify({
              type: 'room:join',
              roomId,
              clientId: clientIdRef.current,
              deviceType: isMobileMode ? 'mobile' : 'desktop',
              deviceName: isMobileMode
                ? 'Mobile Companion Handset'
                : 'Desktop Studio Workstation',
            })
          );
        };

        socket.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'room:init') {
              setItems(msg.items || []);
              setDevices(msg.devices || []);
              setIsLoading(false);
            } else if (msg.type === 'presence:updated') {
              setDevices(msg.devices || []);
            } else if (msg.type === 'item:created' && msg.item) {
              setItems((prev) => {
                if (prev.some((i) => i.id === msg.item.id)) return prev;
                return [msg.item, ...prev];
              });
            } else if (msg.type === 'item:updated' && msg.item) {
              setItems((prev) =>
                prev.map((i) => (i.id === msg.item.id ? msg.item : i))
              );
            } else if (msg.type === 'item:deleted' && msg.itemId) {
              setItems((prev) => prev.filter((i) => i.id !== msg.itemId));
            } else if (msg.type === 'room:cleared') {
              setItems(msg.items || []);
            } else if (msg.type === 'auth:challenge-approved') {
              setAuthSession({
                authenticated: true,
                method: msg.challenge?.approvedByMethod || 'qr',
                roomId,
                userEmail: msg.challenge?.userEmail,
                userUid: msg.challenge?.userUid,
                authenticatedAt: new Date().toISOString(),
              });
              triggerAutoOpenNewestLink(msg.items);
            }
          } catch {
            // Ignore invalid JSON
          }
        };

        socket.onclose = () => {
          if (unmounted) return;
          setWsConnected(false);
          reconnectTimer = setTimeout(connect, 4000);
        };
      } catch {
        setWsConnected(false);
      }
    };

    connect();

    return () => {
      unmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    };
  }, [roomId, isMobileMode, fetchRoomState, triggerAutoOpenNewestLink]);

  const handleJoinRoom = (newRoomId: string) => {
    const normalized = normalizeRoomCode(newRoomId) || 'SYNC-42';
    setRoomId(normalized);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('room', normalized);
      window.history.replaceState({}, '', url.toString());
    }
  };

  // Method 1: Approve QR Login (from mobile scan or desktop instant demo)
  const handleApproveQrLogin = async () => {
    if (!isStaticHost) {
      try {
        await fetch(
          `/api/auth/challenges/${encodeURIComponent(challengeId)}/approve`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              roomId,
              method: 'qr',
              userEmail: auth.currentUser?.email,
              userUid: auth.currentUser?.uid,
            }),
          }
        );
      } catch {
        // Fallback to local state
      }
    }

    setAuthSession({
      authenticated: true,
      method: 'qr',
      roomId,
      userEmail: auth.currentUser?.email || undefined,
      userUid: auth.currentUser?.uid,
      authenticatedAt: new Date().toISOString(),
    });
    setPendingMobileChallenge(null);

    broadcastChannelRef.current?.postMessage({
      type: 'auth:approved',
      roomId,
      method: 'qr',
    });

    triggerAutoOpenNewestLink();
  };

  // Method 2: Verify 6-Digit Pairing PIN
  const handleVerifyPinLogin = async (enteredPin: string): Promise<boolean> => {
    const cleanPin = enteredPin.trim();
    if (!validatePinCode(cleanPin)) return false;

    if (!isStaticHost) {
      try {
        const res = await fetch('/api/auth/pin-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinCode: cleanPin, roomId }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.roomId && data.roomId !== roomId) {
            handleJoinRoom(data.roomId);
          }
          setAuthSession({
            authenticated: true,
            method: 'pin',
            roomId: data.roomId || roomId,
            authenticatedAt: new Date().toISOString(),
          });
          triggerAutoOpenNewestLink(data.items);
          return true;
        }
      } catch {
        // Fallback to local PIN check below
      }
    }

    if (cleanPin === activePinCode || validatePinCode(cleanPin)) {
      setAuthSession({
        authenticated: true,
        method: 'pin',
        roomId,
        authenticatedAt: new Date().toISOString(),
      });
      broadcastChannelRef.current?.postMessage({
        type: 'auth:approved',
        roomId,
        method: 'pin',
      });
      triggerAutoOpenNewestLink();
      return true;
    }
    return false;
  };

  // Method 3: Sign in with Google (Firebase Auth + Cloud Firestore Vault)
  const handleGoogleLogin = async () => {
    const user = await signInWithGooglePopup();
    if (user) {
      setAuthSession({
        authenticated: true,
        method: 'google',
        roomId,
        userEmail: user.email || undefined,
        userUid: user.uid,
        authenticatedAt: new Date().toISOString(),
      });
      triggerAutoOpenNewestLink();
    }
  };

  const handleLogoutSession = async () => {
    await signOutFirebaseUser();
    setAuthSession(null);
    setChallengeId(
      `qr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    );
    setActivePinCode(generateSixDigitPin());
  };

  const handleShareItem = async (payload: CreateShareItemPayload) => {
    let createdItem: SharedItem | null = null;

    if (!isStaticHost) {
      try {
        const res = await fetch(
          `/api/rooms/${encodeURIComponent(roomId)}/items`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }
        );
        const contentType = res.headers.get('content-type') || '';
        if (res.ok && contentType.includes('application/json')) {
          const { item } = await res.json();
          createdItem = item;
          setItems((prev) => {
            if (prev.some((existing) => existing.id === item.id)) return prev;
            const next = [item, ...prev];
            saveLocalRoomItems(roomId, next);
            return next;
          });
        }
      } catch {
        // Fallback to local item creation below
      }
    }

    if (!createdItem) {
      createdItem = createLocalSharedItem(payload, roomId);
      setItems((prev) => {
        const next = [createdItem!, ...prev];
        broadcastLocalSync(next);
        return next;
      });
    }

    // Sync to Cloud Firestore when authenticated with Google
    if (auth.currentUser?.emailVerified && createdItem) {
      saveVaultItemToFirestore(createdItem, auth.currentUser.uid).catch(
        () => {}
      );
    }
  };

  const handleToggleRetention = async (
    itemId: string,
    nextMode: RetentionMode
  ) => {
    setItems((prev) => {
      const next = prev.map((i) =>
        i.id === itemId
          ? {
              ...i,
              retentionMode: nextMode,
              pinned: nextMode === 'saved' ? true : i.pinned,
            }
          : i
      );
      broadcastLocalSync(next);
      return next;
    });

    if (!isStaticHost) {
      fetch(
        `/api/rooms/${encodeURIComponent(roomId)}/items/${encodeURIComponent(itemId)}/retention`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ retentionMode: nextMode }),
        }
      ).catch(() => {});
    }

    if (auth.currentUser?.emailVerified) {
      updateVaultItemInFirestore(itemId, {
        retentionMode: nextMode,
        pinned: nextMode === 'saved',
      }).catch(() => {});
    }
  };

  const handleTogglePin = async (itemId: string) => {
    if (!isStaticHost) {
      try {
        const res = await fetch(
          `/api/rooms/${encodeURIComponent(roomId)}/items/${encodeURIComponent(itemId)}/pin`,
          { method: 'PATCH' }
        );
        if (res.ok) {
          const { item } = await res.json();
          setItems((prev) => {
            const next = prev.map((i) => (i.id === item.id ? item : i));
            saveLocalRoomItems(roomId, next);
            return next;
          });
          return;
        }
      } catch {
        // Fallback to static mode
      }
    }

    setItems((prev) => {
      const next = prev.map((i) =>
        i.id === itemId ? { ...i, pinned: !i.pinned } : i
      );
      broadcastLocalSync(next);
      return next;
    });
  };

  const handleDeleteItem = async (itemId: string) => {
    setItems((prev) => {
      const next = prev.filter((i) => i.id !== itemId);
      broadcastLocalSync(next);
      return next;
    });
    if (!isStaticHost) {
      await fetch(
        `/api/rooms/${encodeURIComponent(roomId)}/items/${encodeURIComponent(itemId)}`,
        { method: 'DELETE' }
      ).catch(() => {});
    }
    if (auth.currentUser?.emailVerified) {
      deleteVaultItemFromFirestore(itemId).catch(() => {});
    }
  };

  const handleClearTemporary = async () => {
    const tempIds = items
      .filter((i) => (i.retentionMode || 'temporary') === 'temporary')
      .map((i) => i.id);

    setItems((prev) => {
      const next = prev.filter(
        (i) => (i.retentionMode || 'temporary') === 'saved'
      );
      broadcastLocalSync(next);
      return next;
    });

    if (!isStaticHost) {
      await fetch(
        `/api/rooms/${encodeURIComponent(roomId)}/items?clearTemporary=true`,
        { method: 'DELETE' }
      ).catch(() => {});
    }

    if (auth.currentUser?.emailVerified) {
      tempIds.forEach((id) => {
        deleteVaultItemFromFirestore(id).catch(() => {});
      });
    }
  };

  const focusComposerInput = () => {
    const el =
      document.getElementById('share-link-url') ||
      document.getElementById('file-caption-input');
    el?.focus();
  };

  const baseUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : 'http://localhost:3000/';

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col">
      {/* Strict 3-Zone Top Navigation Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="./"
          className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0"
        >
          qrLinkShare
        </a>

        {/* Zone 2: 4 concise single-line text navigation links */}
        <nav
          aria-label="Primary Navigation"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-300"
        >
          <a
            href="#qr-bridge"
            onClick={(e) => {
              e.preventDefault();
              setViewMode('workspace');
            }}
            className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            QR Login
          </a>
          <a
            href="#beam-composer"
            onClick={(e) => {
              e.preventDefault();
              setViewMode('workspace');
              focusComposerInput();
            }}
            className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Share Link / Doc
          </a>
          <a
            href="#transfer-stream"
            onClick={(e) => {
              e.preventDefault();
              setViewMode('workspace');
            }}
            className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Desktop Vault
          </a>
          <a
            href="#qr-sheet"
            onClick={(e) => {
              e.preventDefault();
              setViewMode(
                viewMode === 'print-sheet' ? 'workspace' : 'print-sheet'
              );
            }}
            className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            QR Sheet
          </a>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => {
              setViewMode('workspace');
              focusComposerInput();
            }}
            className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            New Transfer
          </button>
        </div>
      </header>

      {/* Workspace Context Bar (Mode Toggles, Auth Status, GitHub Pages Publisher & Theme Switch) */}
      <div className="bg-white/70 dark:bg-slate-900/70 border-b border-slate-200/80 dark:border-slate-800/80 px-4 sm:px-6 py-2.5">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 font-mono flex-wrap tabular-nums">
            <span>Room: {roomId}</span>
            <span aria-hidden="true">·</span>
            <span>PIN: {activePinCode}</span>
            <span aria-hidden="true">·</span>
            <span>
              {authSession?.authenticated
                ? `Logged In (${authSession.method.toUpperCase()})`
                : 'Scan QR or Enter PIN to Login'}
            </span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Perspective Switcher */}
            <div
              role="group"
              aria-label="Workspace view mode"
              className="inline-flex items-center p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg"
            >
              <button
                type="button"
                onClick={() => {
                  setIsMobileMode(false);
                  setViewMode('workspace');
                }}
                className={`min-h-[34px] px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  !isMobileMode && viewMode === 'workspace'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Monitor className="w-3.5 h-3.5 shrink-0" />
                <span>Desktop</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsMobileMode(true);
                  setViewMode('workspace');
                }}
                className={`min-h-[34px] px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  isMobileMode && viewMode === 'workspace'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Smartphone className="w-3.5 h-3.5 shrink-0" />
                <span>Phone View</span>
              </button>

              <button
                type="button"
                onClick={() =>
                  setViewMode(
                    viewMode === 'print-sheet' ? 'workspace' : 'print-sheet'
                  )
                }
                className={`min-h-[34px] px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  viewMode === 'print-sheet'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <QrCode className="w-3.5 h-3.5 shrink-0" />
                <span>QR Sheet</span>
              </button>
            </div>

            {/* Publish to GitHub Pages Trigger */}
            <button
              type="button"
              onClick={() => setIsGhPagesModalOpen(true)}
              className="min-h-[34px] px-3 py-1.5 text-xs font-medium text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 border border-indigo-200/70 dark:border-indigo-800/70 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Globe className="w-3.5 h-3.5 shrink-0" />
              <span>GitHub Pages</span>
            </button>

            {/* Theme Toggle */}
            <button
              type="button"
              onClick={() => setDarkMode((d) => !d)}
              aria-label={
                darkMode ? 'Switch to light theme' : 'Switch to dark theme'
              }
              className="min-h-[34px] px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              {darkMode ? (
                <>
                  <Sun className="w-3.5 h-3.5 text-amber-400" />
                  <span>Light</span>
                </>
              ) : (
                <>
                  <Moon className="w-3.5 h-3.5" />
                  <span>Dark</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile QR Scan Handshake Banner (shown when phone scans Desktop QR code) */}
      {pendingMobileChallenge && (
        <div className="bg-indigo-600 text-white px-4 sm:px-6 py-3">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="w-5 h-5 shrink-0" />
              <div>
                <p className="text-xs font-semibold">
                  Desktop Browser QR Login Detected (Room {roomId})
                </p>
                <p className="text-[11px] text-indigo-100">
                  Approve below to log in your desktop browser and automatically open your newest shared link on desktop.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleApproveQrLogin}
              className="min-h-[38px] px-4 py-2 text-xs font-semibold bg-white text-indigo-700 hover:bg-indigo-50 rounded-lg flex items-center justify-center gap-1.5 shrink-0 cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Approve Desktop Login & Open Links</span>
            </button>
          </div>
        </div>
      )}

      {/* Main Content Viewport */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">
        {viewMode === 'print-sheet' ? (
          <section
            aria-labelledby="qr-sheet-heading"
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-100 dark:border-slate-800">
              <div>
                <h1
                  id="qr-sheet-heading"
                  className="text-xl font-bold text-slate-900 dark:text-slate-100"
                >
                  Room {roomId} — Printable Multi-QR Transfer Sheet
                </h1>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Scan any card below with a smartphone camera to open its link or download the attached file, image, or document directly.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="min-h-[38px] px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg flex items-center gap-1.5 cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print QR Sheet</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('workspace')}
                  className="min-h-[38px] px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg cursor-pointer"
                >
                  Back to Workspace
                </button>
              </div>
            </div>

            <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/50 flex flex-col items-center text-center"
                >
                  <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate max-w-full mb-1">
                    {item.title}
                  </p>
                  <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mb-3">
                    {item.category.toUpperCase()} ·{' '}
                    {(item.retentionMode || 'temporary').toUpperCase()} ·{' '}
                    {item.senderName}
                  </p>
                  <QrCodeView
                    value={buildItemDirectSharePayload(
                      item,
                      baseUrl,
                      isStaticHost
                    )}
                    size={160}
                    downloadFileName={`qr-${item.id}`}
                    showControls={true}
                  />
                </div>
              ))}
            </div>
          </section>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-5 space-y-6" id="qr-bridge">
              {isMobileMode ? (
                <>
                  <div id="beam-composer">
                    <ShareComposer
                      roomId={roomId}
                      defaultDevice="mobile"
                      onShareItem={handleShareItem}
                    />
                  </div>
                  <PairingSidebar
                    roomId={roomId}
                    challengeId={challengeId}
                    activePinCode={activePinCode}
                    authSession={authSession}
                    onJoinRoom={handleJoinRoom}
                    onApproveQrLogin={handleApproveQrLogin}
                    onVerifyPinLogin={handleVerifyPinLogin}
                    onGoogleLogin={handleGoogleLogin}
                    onLogoutSession={handleLogoutSession}
                    devices={devices}
                    wsConnected={wsConnected}
                    onSwitchToMobilePreview={() => setIsMobileMode(false)}
                    isMobileMode={true}
                  />
                </>
              ) : (
                <>
                  <PairingSidebar
                    roomId={roomId}
                    challengeId={challengeId}
                    activePinCode={activePinCode}
                    authSession={authSession}
                    onJoinRoom={handleJoinRoom}
                    onApproveQrLogin={handleApproveQrLogin}
                    onVerifyPinLogin={handleVerifyPinLogin}
                    onGoogleLogin={handleGoogleLogin}
                    onLogoutSession={handleLogoutSession}
                    devices={devices}
                    wsConnected={wsConnected}
                    onSwitchToMobilePreview={() => setIsMobileMode(true)}
                    isMobileMode={false}
                  />
                  <div id="beam-composer">
                    <ShareComposer
                      roomId={roomId}
                      defaultDevice="mobile"
                      onShareItem={handleShareItem}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="lg:col-span-7" id="transfer-stream">
              <TransferStream
                roomId={roomId}
                items={items}
                isLoading={isLoading}
                authSession={authSession}
                autoOpenEnabled={autoOpenEnabled}
                onToggleAutoOpen={() => setAutoOpenEnabled((v) => !v)}
                autoDeleteTempOnOpen={autoDeleteTempOnOpen}
                onToggleAutoDeleteTemp={() =>
                  setAutoDeleteTempOnOpen((v) => !v)
                }
                lastAutoOpenedItem={lastAutoOpenedItem}
                onOpenLinkOnDesktop={(item) =>
                  handleOpenLinkOnDesktop(item, false)
                }
                onToggleRetention={handleToggleRetention}
                onTogglePin={handleTogglePin}
                onDeleteItem={handleDeleteItem}
                onClearTemporary={handleClearTemporary}
                onSelectItemForQr={(item) => setActiveQrItem(item)}
                onFocusComposer={focusComposerInput}
              />
            </div>
          </div>
        )}
      </main>

      {/* Clean Minimal Footer */}
      <footer className="mt-auto border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-6 py-4">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>
            qrLinkShare — Share Links, Docs & Files from Phone & Auto-Open on Desktop via QR Login
          </span>
          <span className="font-mono tabular-nums">
            Room {roomId} · Temporary Drops & Saved Cloud Vault
          </span>
        </div>
      </footer>

      <ItemQrModal
        item={activeQrItem}
        onClose={() => setActiveQrItem(null)}
        isStaticHost={isStaticHost}
      />

      <GithubPagesModal
        isOpen={isGhPagesModalOpen}
        onClose={() => setIsGhPagesModalOpen(false)}
        roomId={roomId}
      />
    </div>
  );
}

export default App;

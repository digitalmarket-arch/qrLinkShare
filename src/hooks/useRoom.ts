import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceInfo, PresentDevice, RoomSession, ServerEvent, SharedItem } from '../types/share';
import { getDevice, wsUrl } from '../lib/api';

export type LinkStatus = 'connecting' | 'live' | 'offline';

interface Handlers {
  onNewItem?: (item: SharedItem) => void;
  onDeviceJoined?: (device: DeviceInfo) => void;
  onUnauthorized?: () => void;
}

const PING_EVERY_MS = 20_000;
const PONG_DEADLINE_MS = 8_000;

const byNewest = (a: SharedItem, b: SharedItem) => b.createdAt.localeCompare(a.createdAt);

/**
 * Keeps a WebSocket open to the room so new items appear on every device instantly.
 * Reconnects automatically (phones drop connections when the screen locks), and
 * pings the server so a silently dead connection (laptop sleep, Wi-Fi → mobile data)
 * is noticed and replaced instead of showing "Live" while missing items.
 */
export function useRoom(session: RoomSession | null, handlers: Handlers) {
  const [items, setItems] = useState<SharedItem[]>([]);
  const [devices, setDevices] = useState<PresentDevice[]>([]);
  const [status, setStatus] = useState<LinkStatus>('connecting');
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const roomIdRef = useRef(session?.roomId);
  roomIdRef.current = session?.roomId;

  useEffect(() => {
    if (!session) return;
    let ws: WebSocket | null = null;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let lastMsgAt = Date.now();
    let closed = false;
    const me = getDevice();

    setItems([]);
    setDevices([]);
    setStatus('connecting');

    const scheduleReconnect = () => {
      if (closed) return;
      setStatus('offline');
      retry += 1;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, Math.min(15_000, 500 * 2 ** Math.min(retry, 5)));
    };

    /** Drop the current socket without letting its late onclose schedule a second reconnect. */
    const discard = () => {
      clearInterval(pingTimer);
      clearTimeout(deadline);
      if (!ws) return;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
      ws = null;
    };

    /** Ask the server for a reply; if nothing at all arrives in time, reconnect. */
    const probe = (timeout = PONG_DEADLINE_MS) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const sentAt = Date.now();
      ws.send('{"type":"ping"}');
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        if (lastMsgAt < sentAt) {
          discard();
          retry = 0;
          setStatus('connecting');
          connect();
        }
      }, timeout);
    };

    function connect() {
      if (closed) return;
      discard();
      const socket = new WebSocket(wsUrl());
      ws = socket;
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'hello', token: session!.token, device: me }));
        pingTimer = setInterval(() => document.visibilityState === 'visible' && probe(), PING_EVERY_MS);
      };
      socket.onmessage = (e) => {
        lastMsgAt = Date.now();
        let msg: ServerEvent | { type: 'pong' };
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'ready':
            retry = 0;
            setStatus('live');
            setItems([...msg.items].sort(byNewest));
            setDevices(msg.devices);
            break;
          case 'presence':
            setDevices(msg.devices);
            break;
          case 'item:new': {
            const item = msg.item;
            setItems((prev) => (prev.some((i) => i.id === item.id) ? prev : [item, ...prev].sort(byNewest)));
            if (item.from.id !== me.id) handlersRef.current.onNewItem?.(item);
            break;
          }
          case 'item:removed': {
            const id = msg.itemId;
            setItems((prev) => prev.filter((i) => i.id !== id));
            break;
          }
          case 'room:cleared':
            setItems([]);
            break;
          case 'pair:used':
            handlersRef.current.onDeviceJoined?.(msg.by);
            break;
        }
      };
      socket.onclose = (e) => {
        if (closed || ws !== socket) return;
        clearInterval(pingTimer);
        clearTimeout(deadline);
        ws = null;
        if (e.code === 4003) {
          handlersRef.current.onUnauthorized?.();
          return;
        }
        scheduleReconnect();
      };
    }

    connect();

    // Phone woke up / tab came back / network changed: check the link right away.
    const onWake = () => {
      if (document.visibilityState !== 'visible') return;
      if (ws && ws.readyState === WebSocket.OPEN) probe(4_000);
      else if (!ws || ws.readyState > WebSocket.OPEN) {
        clearTimeout(retryTimer);
        retry = 0;
        connect();
      }
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onWake);
    window.addEventListener('pageshow', onWake);

    return () => {
      closed = true;
      clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
      window.removeEventListener('pageshow', onWake);
      discard();
    };
  }, [session?.token]);

  /** Optimistically add an item we just created (the WS echo is de-duplicated). Ignores items from a room we already left. */
  const addLocal = useCallback((item: SharedItem) => {
    if (item.roomId !== roomIdRef.current) return;
    setItems((prev) => (prev.some((i) => i.id === item.id) ? prev : [item, ...prev].sort(byNewest)));
  }, []);
  const removeLocal = useCallback((itemId: string) => setItems((prev) => prev.filter((i) => i.id !== itemId)), []);
  const clearLocal = useCallback(() => setItems([]), []);

  return { items, devices, status, addLocal, removeLocal, clearLocal };
}

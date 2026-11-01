import { useEffect, useRef, useState } from 'react';
import type { DeviceInfo, PresentDevice, RoomSession, ServerEvent, SharedItem } from '../types/share';
import { getDevice, wsUrl } from '../lib/api';

export type LinkStatus = 'connecting' | 'live' | 'offline';

interface Handlers {
  onNewItem?: (item: SharedItem) => void;
  onDeviceJoined?: (device: DeviceInfo) => void;
  onUnauthorized?: () => void;
}

/**
 * Keeps a WebSocket open to the room so new items appear on every device instantly.
 * Reconnects automatically (phones drop connections when the screen locks).
 */
export function useRoom(session: RoomSession | null, handlers: Handlers) {
  const [items, setItems] = useState<SharedItem[]>([]);
  const [devices, setDevices] = useState<PresentDevice[]>([]);
  const [status, setStatus] = useState<LinkStatus>('connecting');
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!session) return;
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const me = getDevice();

    setItems([]);
    setDevices([]);
    setStatus('connecting');

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: 'hello', token: session.token, device: me }));
      };
      ws.onmessage = (e) => {
        let msg: ServerEvent;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'ready':
            retry = 0;
            setStatus('live');
            setItems(msg.items);
            setDevices(msg.devices);
            break;
          case 'presence':
            setDevices(msg.devices);
            break;
          case 'item:new':
            setItems((prev) => (prev.some((i) => i.id === msg.item.id) ? prev : [msg.item, ...prev]));
            if (msg.item.from.id !== me.id) handlersRef.current.onNewItem?.(msg.item);
            break;
          case 'item:removed':
            setItems((prev) => prev.filter((i) => i.id !== msg.itemId));
            break;
          case 'room:cleared':
            setItems([]);
            break;
          case 'pair:used':
            handlersRef.current.onDeviceJoined?.(msg.by);
            break;
        }
      };
      ws.onclose = (e) => {
        if (closed) return;
        if (e.code === 4003) {
          handlersRef.current.onUnauthorized?.();
          return;
        }
        setStatus('offline');
        retry += 1;
        timer = setTimeout(connect, Math.min(15_000, 500 * 2 ** Math.min(retry, 5)));
      };
    };

    connect();

    // Reconnect right away when the phone wakes up / tab comes back.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && ws && ws.readyState > WebSocket.OPEN) {
        clearTimeout(timer);
        retry = 0;
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);

    return () => {
      closed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      ws?.close();
    };
  }, [session?.token]);

  /** Optimistically add an item we just created (the WS echo is de-duplicated). */
  const addLocal = (item: SharedItem) =>
    setItems((prev) => (prev.some((i) => i.id === item.id) ? prev : [item, ...prev]));
  const removeLocal = (itemId: string) => setItems((prev) => prev.filter((i) => i.id !== itemId));

  return { items, devices, status, addLocal, removeLocal, clearLocal: () => setItems([]) };
}

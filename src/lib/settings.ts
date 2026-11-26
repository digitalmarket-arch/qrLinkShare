/**
 * Small settings kept in the browser (localStorage).
 *
 * With "keep nothing on this computer" on, pairing details are kept only in this
 * page's memory: closing, reopening or reloading the tab starts unpaired, so the
 * next person at a shared computer can't pick up where you left off.
 */
import type { Account, DeviceInfo, KnownDevice } from '../types/share';
import { deviceNameFromUA, deviceTypeFromUA } from './shared';
import { isValidSecret, randomSecret } from './pairing';

/** The subset of the Storage API used here. */
type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function read<T>(storage: KV | undefined, key: string): T | null {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(storage: KV | undefined, key: string, value: unknown) {
  try {
    if (value === null || value === undefined) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked: the app still works for this tab
  }
}

const local = (): KV | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
};
const session = (): KV | undefined => {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
};

/** Memory-only storage for "keep nothing" mode: gone as soon as the page is. */
const memoryMap = new Map<string, string>();
const memory: KV = {
  getItem: (k) => memoryMap.get(k) ?? null,
  setItem: (k, v) => void memoryMap.set(k, String(v)),
  removeItem: (k) => void memoryMap.delete(k),
};

/** Everything that identifies this device's pairings. */
const PAIRING_KEYS = ['qrls.group', 'qrls.oldGroups', 'qrls.account', 'qrls.known', 'qrls.gone'];

/* ------------------------- "keep nothing" (private) ------------------------- */

export const isPrivateMode = () => read<boolean>(local(), 'qrls.private') === true;
export const setPrivateMode = (on: boolean) => write(local(), 'qrls.private', on || null);

// Earlier versions kept "keep nothing" pairing details in sessionStorage, which browsers
// bring back when a closed tab is reopened. Clear any leftovers.
if (isPrivateMode()) for (const k of PAIRING_KEYS) write(session(), k, null);

/**
 * A tab that opened in "keep nothing" mode stays memory-only until it reloads, even if another
 * tab turns the mode off; and any tab switches to memory as soon as the mode is turned on.
 */
const STARTED_PRIVATE = isPrivateMode();
const scoped = (): KV | undefined => (STARTED_PRIVATE || isPrivateMode() ? memory : local());

/* --------------------------------- pairing --------------------------------- */

/** The secret shared by this device's group of paired devices (created on first use). */
export function loadGroupSecret(): string {
  const saved = read<string>(scoped(), 'qrls.group');
  if (isValidSecret(saved)) return saved;
  const fresh = randomSecret();
  write(scoped(), 'qrls.group', fresh);
  return fresh;
}

export const saveGroupSecret = (secret: string) => write(scoped(), 'qrls.group', secret);

/**
 * Groups this device moved away from when it paired with a device of another group.
 * It keeps visiting them for a while to tell devices that come back where to find it.
 */
export interface OldGroup {
  secret: string;
  since: number;
}
const OLD_GROUP_DAYS = 30;
const MAX_OLD_GROUPS = 5;

export function loadOldGroups(now = Date.now()): OldGroup[] {
  const list = read<OldGroup[]>(scoped(), 'qrls.oldGroups') ?? [];
  return list
    .filter((g) => g && isValidSecret(g.secret) && typeof g.since === 'number' && now - g.since < OLD_GROUP_DAYS * 86_400_000)
    .slice(0, MAX_OLD_GROUPS);
}
export const saveOldGroups = (groups: OldGroup[]) => write(scoped(), 'qrls.oldGroups', groups.slice(0, MAX_OLD_GROUPS));

export const loadAccount = () => read<Account>(scoped(), 'qrls.account');
export const saveAccount = (account: Account | null) => write(scoped(), 'qrls.account', account);

/** Devices seen before, so they can be shown while offline and catch up when they return. */
export function loadKnownDevices(): Record<string, KnownDevice> {
  const raw = read<Record<string, KnownDevice & { method?: KnownDevice['methods'][number] }>>(scoped(), 'qrls.known') ?? {};
  const out: Record<string, KnownDevice> = {};
  for (const [id, d] of Object.entries(raw)) {
    if (!d || typeof d.id !== 'string') continue;
    // Older versions stored a single `method`.
    const methods = Array.isArray(d.methods) ? d.methods : d.method ? [d.method] : [];
    if (!methods.length) continue;
    const { method: _m, ...rest } = d;
    out[id] = { ...rest, methods };
  }
  return out;
}
export const saveKnownDevices = (known: Record<string, KnownDevice>) => write(scoped(), 'qrls.known', known);

/**
 * Items deleted on this device (id -> when). If another device sends one again (for
 * example because our receipt got lost), it is acknowledged instead of coming back.
 */
const GONE_DAYS = 45;
const MAX_GONE = 3000;
export function loadGone(now = Date.now()): Record<string, number> {
  const all = read<Record<string, number>>(scoped(), 'qrls.gone') ?? {};
  const kept = Object.entries(all)
    .filter(([, t]) => typeof t === 'number' && now - t < GONE_DAYS * 86_400_000)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_GONE);
  return Object.fromEntries(kept);
}
export const saveGone = (gone: Record<string, number>) => write(scoped(), 'qrls.gone', gone);

/** Removes pairing details from every storage (used when switching modes). */
export function forgetPairing() {
  for (const s of [local(), session(), memory]) for (const k of PAIRING_KEYS) write(s, k, null);
}

/* --------------------------------- device ---------------------------------- */

export function deviceBasics(): Omit<DeviceInfo, 'id'> {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return {
    name: read<string>(local(), 'qrls.deviceName') || deviceNameFromUA(ua),
    type: deviceTypeFromUA(ua),
  };
}

/* ---------------------------------- prefs ----------------------------------- */

export function loadPref<T>(key: string, fallback: T): T {
  const v = read<T>(local(), `qrls.pref.${key}`);
  return v === null ? fallback : v;
}
export const savePref = (key: string, value: unknown) => write(local(), `qrls.pref.${key}`, value);

/**
 * Small settings kept in the browser. Pairing details go to sessionStorage (this
 * tab only) when "keep nothing on this computer" is on, otherwise localStorage.
 */
import type { Account, DeviceInfo, KnownDevice } from '../types/share';
import { deviceNameFromUA, deviceTypeFromUA } from './shared';
import { isValidSecret, randomSecret } from './pairing';

function read<T>(storage: Storage | undefined, key: string): T | null {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(storage: Storage | undefined, key: string, value: unknown) {
  try {
    if (value === null || value === undefined) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked: the app still works for this tab
  }
}

const local = () => (typeof localStorage === 'undefined' ? undefined : localStorage);
const session = () => (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);

/* ------------------------- "keep nothing" (private) ------------------------- */

export const isPrivateMode = () => read<boolean>(local(), 'qrls.private') === true;
export const setPrivateMode = (on: boolean) => write(local(), 'qrls.private', on || null);

const scoped = () => (isPrivateMode() ? session() : local());

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

export const loadAccount = () => read<Account>(scoped(), 'qrls.account');
export const saveAccount = (account: Account | null) => write(scoped(), 'qrls.account', account);

/** Devices seen before, so they can be shown while offline and catch up when they return. */
export const loadKnownDevices = () => read<Record<string, KnownDevice>>(scoped(), 'qrls.known') ?? {};
export const saveKnownDevices = (known: Record<string, KnownDevice>) => write(scoped(), 'qrls.known', known);

/** Removes pairing details from both storages (used when switching modes). */
export function forgetPairing() {
  for (const s of [local(), session()]) {
    write(s, 'qrls.group', null);
    write(s, 'qrls.account', null);
    write(s, 'qrls.known', null);
  }
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

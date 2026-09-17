const PROBE_KEY = 'st.replay.storage_probe';

let storageOverride: Storage | null | undefined;

export function setReplaySessionStorageForTests(storage: Storage | null | undefined): void {
  storageOverride = storage;
}

export function getReplaySessionStorage(): Storage | null {
  if (storageOverride !== undefined) return storageOverride;
  if (typeof window === 'undefined') return null;
  try {
    const storage = window.sessionStorage;
    storage.setItem(PROBE_KEY, '1');
    storage.removeItem(PROBE_KEY);
    return storage;
  } catch {
    return null;
  }
}

export function readSessionJson<T>(key: string): T | null {
  const storage = getReplaySessionStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // ignore
    }
    return null;
  }
}

export function writeSessionJson(key: string, value: unknown): boolean {
  const storage = getReplaySessionStorage();
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeSessionKey(key: string): void {
  const storage = getReplaySessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // ignore
  }
}

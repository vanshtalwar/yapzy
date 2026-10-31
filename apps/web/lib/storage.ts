/**
 * Web Storage can throw (private mode, blocked cookies, quota) — every access goes through
 * these helpers so the app keeps working without it.
 */
type Area = 'local' | 'session';

function area(kind: Area): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readItem(kind: Area, key: string): string | null {
  try {
    return area(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeItem(kind: Area, key: string, value: string): boolean {
  try {
    const storage = area(kind);
    if (storage === null) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeItem(kind: Area, key: string): void {
  try {
    area(kind)?.removeItem(key);
  } catch {
    // nothing to clean up if storage is unavailable
  }
}

export function readJson(kind: Area, key: string): unknown {
  const raw = readItem(kind, key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

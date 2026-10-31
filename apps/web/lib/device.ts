import { z } from 'zod';

import { readItem, writeItem } from './storage.ts';

const KEY = 'rc.deviceId';
let fallback: string | null = null;

/**
 * Random per-browser id (only its HMAC is stored server-side). If localStorage is unavailable
 * a per-tab id is used instead, so bans by device still apply within that tab.
 */
export function getDeviceId(): string {
  const stored = readItem('local', KEY);
  if (stored !== null && z.uuid().safeParse(stored).success) return stored;
  const id = crypto.randomUUID();
  if (!writeItem('local', KEY, id)) {
    fallback ??= id;
    return fallback;
  }
  return id;
}

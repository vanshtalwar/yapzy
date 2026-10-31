import { z } from 'zod';

import { readJson, removeItem, writeItem } from './storage.ts';

/** Tab-scoped (sessionStorage) on purpose: an anonymous chat identity per tab (D-024). */
const KEY = 'rc.session';
/** Treat tokens as expired a minute early so a request never races the expiry. */
const SKEW_MS = 60_000;

const storedSessionSchema = z.object({
  token: z.string().min(1),
  visitorId: z.string().min(1),
  expiresAt: z.iso.datetime(),
});
export type StoredSession = z.output<typeof storedSessionSchema>;

let memory: StoredSession | null = null;

function isFresh(session: StoredSession, now: number): boolean {
  return Date.parse(session.expiresAt) - SKEW_MS > now;
}

export function getSession(now: number = Date.now()): StoredSession | null {
  if (memory === null) {
    const parsed = storedSessionSchema.safeParse(readJson('session', KEY));
    memory = parsed.success ? parsed.data : null;
  }
  if (memory !== null && !isFresh(memory, now)) clearSession();
  return memory;
}

export function getToken(): string | null {
  return getSession()?.token ?? null;
}

export function saveSession(session: StoredSession): void {
  memory = session;
  writeItem('session', KEY, JSON.stringify(session));
}

export function clearSession(): void {
  memory = null;
  removeItem('session', KEY);
}

import { randomBytes } from 'node:crypto';

import { adminSessionKey, getJson, type Redis, setJson } from '@app/redis';
import { z } from 'zod';

/** httpOnly, SameSite=Lax cookie holding the opaque admin session id. */
export const ADMIN_COOKIE = 'rc_admin';

const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;

const sessionSchema = z.object({
  adminId: z.uuid(),
  /** Must come back in `x-admin-csrf` on every mutating request. */
  csrf: z.string().min(32),
  createdAt: z.number(),
});
export type AdminSession = z.output<typeof sessionSchema> & { id: string };

/** Admin sessions live in Redis (`admsess:<id>`), separate from visitor JWTs. */
export function createAdminSessions(redis: Redis, ttlSeconds: number) {
  return {
    ttlSeconds,

    async create(adminId: string, now: number): Promise<AdminSession> {
      const id = randomBytes(32).toString('base64url');
      const session = { adminId, csrf: randomBytes(32).toString('base64url'), createdAt: now };
      await setJson(redis, adminSessionKey(id), sessionSchema, session, { ttlSeconds });
      return { id, ...session };
    },

    async get(id: string | undefined): Promise<AdminSession | null> {
      if (id === undefined || !SESSION_ID.test(id)) return null;
      const session = await getJson(redis, adminSessionKey(id), sessionSchema);
      return session === null ? null : { id, ...session };
    },

    async destroy(id: string): Promise<void> {
      if (SESSION_ID.test(id)) await redis.del(adminSessionKey(id));
    },
  };
}

export type AdminSessions = ReturnType<typeof createAdminSessions>;

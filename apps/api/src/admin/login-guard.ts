import { rateLimitKey, type Redis } from '@app/redis';

/** Per-email login attempts per minute (on top of the per-IP route limit). */
export const LOGIN_ATTEMPTS_PER_MINUTE = 5;
/** Failures within the window that lock the account for the window. */
export const LOGIN_FAILURES_BEFORE_LOCK = 10;
export const LOGIN_LOCK_SECONDS = 15 * 60;

/** Brute-force protection keyed by an HMAC of the email (never the address itself). */
export function createLoginGuard(redis: Redis) {
  const keys = (emailHash: string) => ({
    attempts: rateLimitKey('admin-login', emailHash),
    failures: rateLimitKey('admin-login-fail', emailHash),
    lock: rateLimitKey('admin-login-lock', emailHash),
  });

  return {
    async locked(emailHash: string): Promise<boolean> {
      return (await redis.exists(keys(emailHash).lock)) === 1;
    },

    /** Counts an attempt; false = too many this minute. */
    async attempt(emailHash: string): Promise<boolean> {
      const key = keys(emailHash).attempts;
      const [[, count]] = (await redis.multi().incr(key).expire(key, 60, 'NX').exec()) as [
        [Error | null, number],
      ];
      return count <= LOGIN_ATTEMPTS_PER_MINUTE;
    },

    async failure(emailHash: string): Promise<void> {
      const { failures, lock } = keys(emailHash);
      const [[, count]] = (await redis
        .multi()
        .incr(failures)
        .expire(failures, LOGIN_LOCK_SECONDS, 'NX')
        .exec()) as [[Error | null, number]];
      if (count >= LOGIN_FAILURES_BEFORE_LOCK) {
        await redis.set(lock, '1', 'EX', LOGIN_LOCK_SECONDS);
        await redis.del(failures);
      }
    },

    async success(emailHash: string): Promise<void> {
      await redis.del(keys(emailHash).failures);
    },
  };
}

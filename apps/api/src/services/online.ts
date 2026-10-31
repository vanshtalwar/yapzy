import { PRESENCE_NODES_KEY, presenceNodeKey, type Redis } from '@app/redis';

import { type Clock } from '../deps.ts';

export interface OnlineCounter {
  count(): Promise<number>;
}

/**
 * Sums the per-node socket counts the gateways publish. Cached in memory per API instance so
 * a busy landing page doesn't turn into one Redis round trip per visitor.
 */
export function createOnlineCounter(deps: {
  redis: Redis;
  clock: Clock;
  cacheMs?: number;
}): OnlineCounter {
  const { redis, clock, cacheMs = 2_000 } = deps;
  let cached: { value: number; at: number } | null = null;

  return {
    async count() {
      const now = clock.now().getTime();
      if (cached !== null && now - cached.at < cacheMs) return cached.value;

      const nodeIds = await redis.smembers(PRESENCE_NODES_KEY);
      const keys = nodeIds.flatMap((nodeId) => {
        try {
          return [presenceNodeKey(nodeId)];
        } catch {
          return []; // malformed member; the gateway owns cleanup of this set
        }
      });
      // Expired node keys (dead gateways) read as null and count as 0.
      const counts = await Promise.all(keys.map((key) => redis.get(key)));
      const value = counts.reduce((sum, raw) => {
        const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
        return Number.isSafeInteger(parsed) && parsed > 0 ? sum + parsed : sum;
      }, 0);

      cached = { value, at: now };
      return value;
    },
  };
}

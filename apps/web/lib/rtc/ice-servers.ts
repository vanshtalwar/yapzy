import { type TurnCredentials } from '@app/shared';

export interface IceServerCacheDeps {
  fetchCredentials: () => Promise<TurnCredentials>;
  now?: () => number;
  /** Refresh this long before the credentials expire. */
  marginMs?: number;
}

/**
 * TURN/STUN servers from `GET /v1/turn-credentials`, cached until `marginMs` before the
 * credentials expire; concurrent callers share one request.
 */
export function createIceServerCache(deps: IceServerCacheDeps) {
  const now = deps.now ?? Date.now;
  const marginMs = deps.marginMs ?? 60_000;
  let cached: { servers: RTCIceServer[]; refreshAt: number } | null = null;
  let inflight: Promise<RTCIceServer[]> | null = null;

  return {
    async get(): Promise<RTCIceServer[]> {
      if (cached !== null && now() < cached.refreshAt) return cached.servers;
      inflight ??= deps
        .fetchCredentials()
        .then(({ iceServers, ttlSeconds }) => {
          const servers = iceServers.map(({ urls, username, credential }) => ({
            urls,
            ...(username === undefined ? {} : { username }),
            ...(credential === undefined ? {} : { credential }),
          }));
          cached = { servers, refreshAt: now() + ttlSeconds * 1000 - marginMs };
          return servers;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },

    /** Last known servers (possibly stale), for code that cannot wait. */
    peek(): RTCIceServer[] | null {
      return cached?.servers ?? null;
    },

    /** Milliseconds until `get()` will fetch again (0 if it would fetch now). */
    refreshInMs(): number {
      return cached === null ? 0 : Math.max(0, cached.refreshAt - now());
    },

    clear(): void {
      cached = null;
    },
  };
}

export type IceServerCache = ReturnType<typeof createIceServerCache>;

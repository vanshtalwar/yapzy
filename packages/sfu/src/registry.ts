import { randomInt } from 'node:crypto';

import {
  hgetallJson,
  hsetJson,
  type Redis,
  SFU_HEALTH_LOCK_KEY,
  SFU_NODES_KEY,
} from '@app/redis';
import { z } from 'zod';

import { type AdminSocket, createJanusAdminClient } from './admin-client.ts';
import { createVideoRoomAdmin, type VideoRoomAdmin } from './videoroom.ts';

const wsUrl = z.url({ protocol: /^wss?$/, error: 'must be a ws:// or wss:// URL' });

/** One Janus node from JANUS_NODES. `wsUrl` is for browsers, `adminUrl` for the backend only. */
export const janusNodeSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  wsUrl,
  adminUrl: wsUrl,
});
export type JanusNode = z.output<typeof janusNodeSchema>;

/** `sfu:nodes` value: what the health checker last saw. */
export const nodeHealthSchema = z.object({
  wsUrl,
  adminUrl: wsUrl,
  healthy: z.boolean(),
  rooms: z.number().int().min(0),
  /** Consecutive failed checks. */
  failures: z.number().int().min(0),
  lastCheckedAt: z.number().int(),
});
export type NodeHealth = z.output<typeof nodeHealthSchema>;

/** A node is marked unhealthy after this many consecutive failed checks. */
export const UNHEALTHY_AFTER_FAILURES = 2;
/** Health entries older than this are ignored for placement (no checker running). */
const STALE_HEALTH_MS = 30_000;

export interface SfuRegistryDeps {
  redis: Redis;
  nodes: readonly JanusNode[];
  /** JANUS_ADMIN_SECRET: Admin API secret and VideoRoom admin_key. */
  adminSecret: string;
  now?: () => number;
  requestTimeoutMs?: number;
  onRequest?: (request: string, durationMs: number, outcome: 'ok' | 'error') => void;
  /** A node's Admin API connection closed (Janus stopped?): check it now. */
  onConnectionLost?: (nodeId: string) => void;
  createSocket?: (url: string, protocol: string) => AdminSocket;
}

/**
 * The configured Janus nodes: an Admin API client per node, health in `sfu:nodes`, and
 * placement (healthy node with the fewest rooms).
 */
export function createSfuRegistry(deps: SfuRegistryDeps) {
  const now = deps.now ?? Date.now;
  const byId = new Map(deps.nodes.map((node) => [node.id, node]));
  const admins = new Map<string, VideoRoomAdmin>();
  for (const node of deps.nodes) {
    const client = createJanusAdminClient({
      url: node.adminUrl,
      secret: deps.adminSecret,
      ...(deps.requestTimeoutMs === undefined ? {} : { timeoutMs: deps.requestTimeoutMs }),
      ...(deps.onRequest === undefined ? {} : { onRequest: deps.onRequest }),
      ...(deps.createSocket === undefined ? {} : { createSocket: deps.createSocket }),
      onClose: () => {
        deps.onConnectionLost?.(node.id);
      },
    });
    admins.set(node.id, createVideoRoomAdmin(client, deps.adminSecret));
  }

  async function health(): Promise<Map<string, NodeHealth>> {
    const all = await hgetallJson(deps.redis, SFU_NODES_KEY, nodeHealthSchema);
    return new Map(Object.entries(all));
  }

  return {
    nodes: deps.nodes,
    enabled: deps.nodes.length > 0,

    node(nodeId: string): JanusNode | undefined {
      return byId.get(nodeId);
    },

    admin(nodeId: string): VideoRoomAdmin {
      const admin = admins.get(nodeId);
      if (admin === undefined) throw new Error(`Unknown Janus node ${nodeId}`);
      return admin;
    },

    health,

    /**
     * One authenticated Admin API round trip (list rooms with the admin key) and the new
     * health entry. Doesn't write it: the leader does (see `startSfuHealthLoop`).
     */
    async check(nodeId: string, previous: NodeHealth | undefined): Promise<NodeHealth> {
      const node = byId.get(nodeId);
      if (node === undefined) throw new Error(`Unknown Janus node ${nodeId}`);
      const base = { wsUrl: node.wsUrl, adminUrl: node.adminUrl, lastCheckedAt: now() };
      try {
        const rooms = await this.admin(nodeId).listRooms();
        return { ...base, healthy: true, rooms: rooms.length, failures: 0 };
      } catch {
        const failures = (previous?.failures ?? 0) + 1;
        // Placement leaves a failing node alone at once; failover waits for a second failure
        // so one slow answer doesn't move every call.
        return {
          ...base,
          healthy: previous?.healthy === true && failures < UNHEALTHY_AFTER_FAILURES,
          rooms: previous?.rooms ?? 0,
          failures,
        };
      }
    },

    async saveHealth(nodeId: string, entry: NodeHealth): Promise<void> {
      await hsetJson(deps.redis, SFU_NODES_KEY, nodeId, nodeHealthSchema, entry);
    },

    /**
     * Placement: the healthy node with the fewest rooms (ties at random), using the last
     * health check (≤ 5 s old). `exclude` skips a node, e.g. the one a call is leaving.
     */
    async pickNode(options: { exclude?: string } = {}): Promise<JanusNode | null> {
      const entries = await health();
      let best: { node: JanusNode; rooms: number; tie: number } | null = null;
      for (const node of deps.nodes) {
        const entry = entries.get(node.id);
        if (node.id === options.exclude || entry === undefined || !entry.healthy) continue;
        if (entry.failures > 0 || now() - entry.lastCheckedAt > STALE_HEALTH_MS) continue;
        const tie = randomInt(0, 1_000_000);
        if (best === null || entry.rooms < best.rooms || (entry.rooms === best.rooms && tie < best.tie)) {
          best = { node, rooms: entry.rooms, tie };
        }
      }
      return best?.node ?? null;
    },

    close(): void {
      for (const admin of admins.values()) admin.client.close();
    },
  };
}

export type SfuRegistry = ReturnType<typeof createSfuRegistry>;

const RENEW_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

/** One gateway at a time checks the nodes: take the lock, or keep it if we already own it. */
export async function holdHealthLock(redis: Redis, owner: string, ttlMs: number): Promise<boolean> {
  const taken = await redis.set(SFU_HEALTH_LOCK_KEY, owner, 'PX', ttlMs, 'NX');
  if (taken === 'OK') return true;
  return (await redis.eval(RENEW_LOCK, 1, SFU_HEALTH_LOCK_KEY, owner, ttlMs)) === 1;
}

/** Releases the lock if we hold it (graceful shutdown: another gateway takes over at once). */
export async function releaseHealthLock(redis: Redis, owner: string): Promise<void> {
  await redis.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
    1,
    SFU_HEALTH_LOCK_KEY,
    owner,
  );
}

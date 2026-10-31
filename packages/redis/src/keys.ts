import {
  CHAT_MODES,
  type ChatMode,
  MAX_INTEREST_LENGTH,
  SUPPORTED_LANGS,
  type SupportedLang,
} from '@app/shared';

/**
 * Single source of truth for every Redis key and channel. Never build keys inline elsewhere.
 *
 * Keys that one Lua script touches together share a Redis Cluster hash tag (`{...}`): all
 * matchmaking keys of a pool/mode/lang, and all keys of one session. Only the FIRST `{...}`
 * in a key is hashed, so identifiers placed inside or before a tag must never contain braces.
 */

export const MATCH_POOLS = ['normal', 'shadow'] as const;
export type MatchPool = (typeof MATCH_POOLS)[number];

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_HASH = /^[0-9a-f]{64}$/;

function assertSafeId(kind: string, value: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${kind} for Redis key`);
  return value;
}

function assertHash(kind: string, value: string): string {
  if (!SAFE_HASH.test(value)) throw new Error(`Invalid ${kind} hash for Redis key`);
  return value;
}

function assertOneOf<T extends string>(kind: string, value: T, allowed: readonly string[]): T {
  if (!allowed.includes(value)) throw new Error(`Invalid ${kind} for Redis key`);
  return value;
}

/** Interests are normalized upstream (interestSchema); this only guards key integrity. */
function assertInterest(interest: string): string {
  if (
    interest.length === 0 ||
    interest.length > MAX_INTEREST_LENGTH ||
    interest !== interest.trim() ||
    interest !== interest.toLowerCase() ||
    /[{}:]/.test(interest)
  ) {
    throw new Error('Invalid interest for Redis key');
  }
  return interest;
}

// --- Matchmaking -------------------------------------------------------------------------

const REGION = /^[a-z0-9-]{1,32}$/;
export const MAX_BUCKETS = 1024;

/** One queue family `(region, pool, mode, lang)` is split into buckets (D-052). */
export interface QueueFamily {
  region: string;
  pool: MatchPool;
  mode: ChatMode;
  lang: SupportedLang;
}

/** One bucket of a family: the unit that lives on one Redis Cluster slot. */
export interface QueueBucket extends QueueFamily {
  bucket: number;
}

export function matchmakingTag(dims: QueueBucket): string {
  if (!REGION.test(dims.region)) throw new Error('Invalid region for Redis key');
  assertOneOf('pool', dims.pool, MATCH_POOLS);
  assertOneOf('mode', dims.mode, CHAT_MODES);
  assertOneOf('lang', dims.lang, SUPPORTED_LANGS);
  if (!Number.isInteger(dims.bucket) || dims.bucket < 0 || dims.bucket >= MAX_BUCKETS) {
    throw new Error('Invalid bucket for Redis key');
  }
  return `{mm:${dims.region}:${dims.pool}:${dims.mode}:${dims.lang}:${String(dims.bucket)}}`;
}

export interface MatchmakingKeys {
  tag: string;
  /** LIST: FIFO of ticket ids without an interest constraint. */
  queueAny: string;
  /** LIST: FIFO of ticket ids waiting on one interest. */
  queueInterest: (interest: string) => string;
  /** HASH: ticketId → ticket JSON. */
  tickets: string;
  /** ZSET: "minVisitorId|maxVisitorId" → matched-at ms; prevents immediate rematches. */
  recent: string;
}

export function matchmakingKeys(dims: QueueBucket): MatchmakingKeys {
  const tag = matchmakingTag(dims);
  return {
    tag,
    queueAny: `${tag}:q:any`,
    queueInterest: (interest) => `${tag}:q:int:${assertInterest(interest)}`,
    tickets: `${tag}:tickets`,
    recent: `${tag}:recent`,
  };
}

/** Member of the `recent` ZSET; order-independent so A|B and B|A are the same pair. */
export function recentPairMember(visitorIdA: string, visitorIdB: string): string {
  assertSafeId('visitorId', visitorIdA);
  assertSafeId('visitorId', visitorIdB);
  return visitorIdA < visitorIdB ? `${visitorIdA}|${visitorIdB}` : `${visitorIdB}|${visitorIdA}`;
}

/** STRING (SET NX PX): one gateway at a time sweeps stale tickets. */
export const MATCHMAKING_SWEEP_LOCK_KEY = 'lock:mm:sweep';

// --- Visitor -----------------------------------------------------------------------------

/** STRING: current ticket ref (matchmaking tag + ticketId). */
export function visitorTicketKey(visitorId: string): string {
  return `visitor:${assertSafeId('visitorId', visitorId)}:ticket`;
}

/** STRING: current sessionId. */
export function visitorSessionKey(visitorId: string): string {
  return `visitor:${assertSafeId('visitorId', visitorId)}:session`;
}

/**
 * STRING: id of the visitor's one live socket. Written on connect; the `kick_visitor` handler on
 * every node disconnects local sockets of that visitor whose id differs, so the LAST connection
 * wins even when two connections race on different nodes.
 */
export function visitorSocketKey(visitorId: string): string {
  return `visitor:${assertSafeId('visitorId', visitorId)}:socket`;
}

/** Socket.io room every socket of a visitor joins; all cross-node delivery targets it. */
export function visitorRoom(visitorId: string): string {
  return `visitor:${assertSafeId('visitorId', visitorId)}`;
}

// --- Session -----------------------------------------------------------------------------

export interface SessionKeys {
  tag: string;
  /** HASH: mode, topology, maxParticipants, startedAt, commonInterests, state, endedAt. */
  meta: string;
  /** HASH: participantId → participant JSON (left participants are kept for reports). */
  participants: string;
  /** LIST: transcript ring buffer (last TRANSCRIPT_MAX_MESSAGES). */
  log: string;
  /** HASH: participantId → JSON { received, lastAt } of moderation frame uploads (D-054). */
  frames: string;
}

export function sessionKeys(sessionId: string): SessionKeys {
  const tag = `{${assertSafeId('sessionId', sessionId)}}`;
  return {
    tag,
    meta: `session:${tag}:meta`,
    participants: `session:${tag}:participants`,
    log: `session:${tag}:log`,
    frames: `session:${tag}:frames`,
  };
}

// --- Presence & stats --------------------------------------------------------------------

/** STRING: socket count of one gateway node (refreshed with PRESENCE_TTL_SECONDS). */
export function presenceNodeKey(nodeId: string): string {
  return `presence:node:${assertSafeId('nodeId', nodeId)}`;
}

/** SET: known gateway node ids. */
export const PRESENCE_NODES_KEY = 'presence:nodes';

/**
 * STRING: matches started in one UTC minute (yyyyMMddHHmm), sharded (D-053): writers INCR a
 * random shard, readers sum all `shards`.
 */
export function statsMatchesKey(at: Date, shard: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const minute = `${String(at.getUTCFullYear())}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(
    at.getUTCHours(),
  )}${pad(at.getUTCMinutes())}`;
  if (!Number.isInteger(shard) || shard < 0) throw new Error('Invalid stats shard');
  return `stats:matches:${minute}:${String(shard)}`;
}

// --- Session deadlines ---------------------------------------------------------------------

/**
 * ZSET (sharded, D-053): member `<kind>|<sessionId>|<participantId>`, score = deadline ms.
 * The shard number is the hash tag, so each shard can live on a different Redis node.
 */
export function sessionDeadlinesKey(shard: number): string {
  if (!Number.isInteger(shard) || shard < 0) throw new Error('Invalid deadline shard');
  return `session:deadlines:{${String(shard)}}`;
}

/** Stable shard for a session id (FNV-1a), so all of a session's deadlines share a shard. */
export function deadlineShardOf(sessionId: string, shards: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i += 1) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % shards;
}

// --- Trust & safety ----------------------------------------------------------------------

/** STRING (JSON { type, expiresAt }): ban cache entries. */
export function banVisitorKey(visitorId: string): string {
  return `ban:visitor:${assertSafeId('visitorId', visitorId)}`;
}

export function banDeviceKey(deviceIdHash: string): string {
  return `ban:device:${assertHash('device', deviceIdHash)}`;
}

export function banIpKey(ipHash: string): string {
  return `ban:ip:${assertHash('ip', ipHash)}`;
}

/** STRING: cached trust score. */
export function trustKey(visitorId: string): string {
  return `trust:${assertSafeId('visitorId', visitorId)}`;
}

/** STRING (JSON, see moderation.ts): what the gateway needs to pick a sampling tier. */
export function riskProfileKey(visitorId: string): string {
  return `risk:${assertSafeId('visitorId', visitorId)}`;
}

/** STRING (SET NX PX): serializes the distinct-reporter check + automatic ban per visitor. */
export function reportThresholdLockKey(reportedId: string): string {
  return `lock:report-threshold:${assertSafeId('reportedId', reportedId)}`;
}

/**
 * STRING (SET NX, 24 h): a reporter's reports against one visitor cost that visitor trust only
 * once a day, so one person filing many reports can't push someone into the shadow pool.
 */
export function reportPenaltyKey(reporterId: string, reportedId: string): string {
  return `report:penalty:${assertSafeId('reporterId', reporterId)}:${assertSafeId('reportedId', reportedId)}`;
}

/** STRING: global frame-budget multiplier (≥ 1), written by the worker (D-054). */
export const MOD_BUDGET_MULTIPLIER_KEY = 'mod:budget:multiplier';

/** Length of the windows in which accepted moderation frames are counted. */
export const MOD_FRAMES_WINDOW_SECONDS = 10;

/** STRING: moderation frames accepted in the window starting at `windowStart` (epoch s). */
export function moderationFramesKey(windowStart: number): string {
  if (!Number.isInteger(windowStart) || windowStart < 0) throw new Error('Invalid window');
  return `mod:frames:${String(windowStart)}`;
}

/** STRING (SET NX): the one worker that recomputes the budget multiplier for this window. */
export function moderationBudgetClaimKey(windowStart: number): string {
  if (!Number.isInteger(windowStart) || windowStart < 0) throw new Error('Invalid window');
  return `lock:mod:budget:${String(windowStart)}`;
}

// --- SFU (Janus, Part 11) ----------------------------------------------------------------

/**
 * HASH: Janus nodeId → JSON { wsUrl, adminUrl, healthy, rooms, failures, lastCheckedAt },
 * written by the gateway that holds SFU_HEALTH_LOCK_KEY; read for room placement.
 */
export const SFU_NODES_KEY = 'sfu:nodes';

/**
 * HASH: `<nodeId>:<roomId>` → JSON { sessionId, createdAt }: every room we created and the
 * session it serves. Written before the room exists on Janus, removed after it is destroyed,
 * so the orphan sweep can destroy anything on a node that isn't listed here.
 */
export const SFU_ROOMS_KEY = 'sfu:rooms';

/** Field of SFU_ROOMS_KEY for one room. */
export function sfuRoomField(nodeId: string, roomId: number): string {
  if (!Number.isSafeInteger(roomId) || roomId <= 0) throw new Error('Invalid room id');
  return `${assertSafeId('nodeId', nodeId)}:${String(roomId)}`;
}

/** STRING (SET NX PX, renewed by its owner): the one gateway that health-checks Janus nodes. */
export const SFU_HEALTH_LOCK_KEY = 'lock:sfu:health';

// --- Rate limits & admin -----------------------------------------------------------------

/** Prefix for all rate-limit state, e.g. `rl:chat:message:<visitorId>`. */
export function rateLimitKey(scope: string, subject: string): string {
  if (!/^[a-z0-9:_-]{1,64}$/.test(scope)) throw new Error('Invalid rate-limit scope');
  return `rl:${scope}:${assertSafeId('rate-limit subject', subject)}`;
}

/**
 * Namespace for @fastify/rate-limit in the API. The plugin appends `<METHOD><url>-<subject>`,
 * e.g. `rl:api:POST/v1/session-<ipHash>`.
 */
export const API_RATE_LIMIT_PREFIX = 'rl:api:';

/** STRING: admin session (opaque id from the httpOnly cookie). */
export function adminSessionKey(adminSessionId: string): string {
  return `admsess:${assertSafeId('adminSessionId', adminSessionId)}`;
}

// --- Channels ----------------------------------------------------------------------------

/** PUB/SUB: cross-node gateway control messages (see control.ts). */
export const GW_CONTROL_CHANNEL = 'gw:control';

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

export function matchmakingTag(pool: MatchPool, mode: ChatMode, lang: SupportedLang): string {
  assertOneOf('pool', pool, MATCH_POOLS);
  assertOneOf('mode', mode, CHAT_MODES);
  assertOneOf('lang', lang, SUPPORTED_LANGS);
  return `{mm:${pool}:${mode}:${lang}}`;
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

export function matchmakingKeys(
  pool: MatchPool,
  mode: ChatMode,
  lang: SupportedLang,
): MatchmakingKeys {
  const tag = matchmakingTag(pool, mode, lang);
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

// --- Visitor -----------------------------------------------------------------------------

/** STRING: current ticket ref (matchmaking tag + ticketId). */
export function visitorTicketKey(visitorId: string): string {
  return `visitor:${assertSafeId('visitorId', visitorId)}:ticket`;
}

/** STRING: current sessionId. */
export function visitorSessionKey(visitorId: string): string {
  return `visitor:${assertSafeId('visitorId', visitorId)}:session`;
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
}

export function sessionKeys(sessionId: string): SessionKeys {
  const tag = `{${assertSafeId('sessionId', sessionId)}}`;
  return {
    tag,
    meta: `session:${tag}:meta`,
    participants: `session:${tag}:participants`,
    log: `session:${tag}:log`,
  };
}

// --- Presence & stats --------------------------------------------------------------------

/** STRING: socket count of one gateway node (refreshed with PRESENCE_TTL_SECONDS). */
export function presenceNodeKey(nodeId: string): string {
  return `presence:node:${assertSafeId('nodeId', nodeId)}`;
}

/** SET: known gateway node ids. */
export const PRESENCE_NODES_KEY = 'presence:nodes';

/** STRING: matches started in one UTC minute (yyyyMMddHHmm). */
export function statsMatchesKey(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const minute = `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(
    at.getUTCHours(),
  )}${pad(at.getUTCMinutes())}`;
  return `stats:matches:${minute}`;
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

// --- Rate limits & admin -----------------------------------------------------------------

/** Prefix for all rate-limit state, e.g. `rl:chat:message:<visitorId>`. */
export function rateLimitKey(scope: string, subject: string): string {
  if (!/^[a-z0-9:_-]{1,64}$/.test(scope)) throw new Error('Invalid rate-limit scope');
  return `rl:${scope}:${assertSafeId('rate-limit subject', subject)}`;
}

/** STRING: admin session (opaque id from the httpOnly cookie). */
export function adminSessionKey(adminSessionId: string): string {
  return `admsess:${assertSafeId('adminSessionId', adminSessionId)}`;
}

// --- Channels ----------------------------------------------------------------------------

/** PUB/SUB: cross-node gateway control messages (see control.ts). */
export const GW_CONTROL_CHANNEL = 'gw:control';

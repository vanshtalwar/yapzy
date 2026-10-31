import { describe, expect, it } from 'vitest';

import {
  adminSessionKey,
  banDeviceKey,
  banIpKey,
  banVisitorKey,
  deadlineShardOf,
  matchmakingKeys,
  presenceNodeKey,
  type QueueBucket,
  rateLimitKey,
  recentPairMember,
  sessionDeadlinesKey,
  sessionKeys,
  statsMatchesKey,
  trustKey,
  visitorRoom,
  visitorSessionKey,
  visitorTicketKey,
} from './keys.ts';

/** The slot-determining part of a key, per the Redis Cluster spec. */
function hashTagOf(key: string): string {
  const open = key.indexOf('{');
  const close = key.indexOf('}', open + 1);
  return open === -1 || close === -1 || close === open + 1 ? key : key.slice(open + 1, close);
}

const SESSION_ID = '0199a3b2-7c4d-7e5f-8a9b-0c1d2e3f4a5b';
const VISITOR_ID = '0199a3b2-0000-7000-8000-000000000001';
const HASH = 'a'.repeat(64);

const BUCKET: QueueBucket = {
  region: 'local',
  pool: 'normal',
  mode: 'video',
  lang: 'en',
  bucket: 2,
};

describe('matchmaking keys', () => {
  const keys = matchmakingKeys(BUCKET);

  it('builds the documented key names with region and bucket in the tag', () => {
    expect(keys.tag).toBe('{mm:local:normal:video:en:2}');
    expect(keys.queueAny).toBe('{mm:local:normal:video:en:2}:q:any');
    expect(keys.queueInterest('indie-games')).toBe(
      '{mm:local:normal:video:en:2}:q:int:indie-games',
    );
    expect(keys.tickets).toBe('{mm:local:normal:video:en:2}:tickets');
    expect(keys.recent).toBe('{mm:local:normal:video:en:2}:recent');
  });

  it('puts every key of one bucket in the same hash slot', () => {
    const tags = [keys.queueAny, keys.queueInterest('music'), keys.tickets, keys.recent].map(
      hashTagOf,
    );
    expect(new Set(tags)).toEqual(new Set(['mm:local:normal:video:en:2']));
  });

  it('gives different buckets, regions, pools, modes and languages different hash tags', () => {
    const variants: QueueBucket[] = [
      { ...BUCKET, bucket: 3 },
      { ...BUCKET, region: 'eu-west' },
      { ...BUCKET, pool: 'shadow' },
      { ...BUCKET, mode: 'text' },
      { ...BUCKET, lang: 'de' },
    ];
    const tags = new Set(
      [keys.tag, ...variants.map((dims) => matchmakingKeys(dims).tag)].map(hashTagOf),
    );
    expect(tags.size).toBe(variants.length + 1);
  });

  it('rejects unknown dimensions, bad buckets and unnormalized or brace-containing interests', () => {
    // @ts-expect-error runtime guard for values that bypassed validation
    expect(() => matchmakingKeys({ ...BUCKET, pool: 'vip' })).toThrow();
    // @ts-expect-error runtime guard
    expect(() => matchmakingKeys({ ...BUCKET, mode: 'audio' })).toThrow();
    for (const bucket of [-1, 1.5, 1024])
      expect(() => matchmakingKeys({ ...BUCKET, bucket })).toThrow();
    expect(() => matchmakingKeys({ ...BUCKET, region: 'EU{x}' })).toThrow();
    for (const bad of ['', 'Music', ' music', 'a{b}', 'a:b', 'x'.repeat(25)]) {
      expect(() => keys.queueInterest(bad)).toThrow();
    }
  });

  it('builds order-independent recent pair members', () => {
    expect(recentPairMember('b', 'a')).toBe('a|b');
    expect(recentPairMember('a', 'b')).toBe('a|b');
  });
});

describe('session keys', () => {
  const keys = sessionKeys(SESSION_ID);

  it('builds the documented key names with the session id as hash tag', () => {
    expect(keys.meta).toBe(`session:{${SESSION_ID}}:meta`);
    expect(keys.participants).toBe(`session:{${SESSION_ID}}:participants`);
    expect(keys.log).toBe(`session:{${SESSION_ID}}:log`);
    expect(keys.frames).toBe(`session:{${SESSION_ID}}:frames`);
    expect(new Set([keys.meta, keys.participants, keys.log, keys.frames].map(hashTagOf))).toEqual(
      new Set([SESSION_ID]),
    );
  });

  it('rejects ids that would break the hash tag', () => {
    for (const bad of ['', 'a}b', '{x}', 'a b', 'a:b']) expect(() => sessionKeys(bad)).toThrow();
  });
});

describe('other keys', () => {
  it('builds visitor, presence, stats, ban, trust, rate-limit and admin keys', () => {
    expect(visitorTicketKey(VISITOR_ID)).toBe(`visitor:${VISITOR_ID}:ticket`);
    expect(visitorSessionKey(VISITOR_ID)).toBe(`visitor:${VISITOR_ID}:session`);
    expect(visitorRoom(VISITOR_ID)).toBe(`visitor:${VISITOR_ID}`);
    expect(presenceNodeKey('gw-host-4001')).toBe('presence:node:gw-host-4001');
    expect(statsMatchesKey(new Date('2026-10-31T09:05:59.999Z'), 7)).toBe(
      'stats:matches:202610310905:7',
    );
    expect(sessionDeadlinesKey(3)).toBe('session:deadlines:{3}');
    expect(banVisitorKey(VISITOR_ID)).toBe(`ban:visitor:${VISITOR_ID}`);
    expect(banDeviceKey(HASH)).toBe(`ban:device:${HASH}`);
    expect(banIpKey(HASH)).toBe(`ban:ip:${HASH}`);
    expect(trustKey(VISITOR_ID)).toBe(`trust:${VISITOR_ID}`);
    expect(rateLimitKey('chat:message', VISITOR_ID)).toBe(`rl:chat:message:${VISITOR_ID}`);
    expect(adminSessionKey('abcDEF_123-x')).toBe('admsess:abcDEF_123-x');
  });

  it('only accepts hex SHA-256 digests for hashed identifiers (never raw values)', () => {
    expect(() => banIpKey('203.0.113.7')).toThrow();
    expect(() => banDeviceKey('7f3c-device-uuid')).toThrow();
  });
});

describe('deadline shards', () => {
  it('maps a session to a stable shard within range, spreading sessions across shards', () => {
    const shards = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      const sessionId = `0199a3b2-7c4d-7e5f-8a9b-${String(i).padStart(12, '0')}`;
      const shard = deadlineShardOf(sessionId, 16);
      expect(deadlineShardOf(sessionId, 16)).toBe(shard);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(16);
      shards.add(shard);
    }
    expect(shards.size).toBeGreaterThan(12);
  });
});

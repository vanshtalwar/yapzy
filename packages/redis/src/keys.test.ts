import { describe, expect, it } from 'vitest';

import {
  adminSessionKey,
  banDeviceKey,
  banIpKey,
  banVisitorKey,
  matchmakingKeys,
  presenceNodeKey,
  rateLimitKey,
  recentPairMember,
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

describe('matchmaking keys', () => {
  const keys = matchmakingKeys('normal', 'video', 'en');

  it('builds the documented key names', () => {
    expect(keys.tag).toBe('{mm:normal:video:en}');
    expect(keys.queueAny).toBe('{mm:normal:video:en}:q:any');
    expect(keys.queueInterest('indie games')).toBe('{mm:normal:video:en}:q:int:indie games');
    expect(keys.tickets).toBe('{mm:normal:video:en}:tickets');
    expect(keys.recent).toBe('{mm:normal:video:en}:recent');
  });

  it('puts every key of one pool/mode/lang in the same hash slot', () => {
    const tags = [keys.queueAny, keys.queueInterest('music'), keys.tickets, keys.recent].map(
      hashTagOf,
    );
    expect(new Set(tags)).toEqual(new Set(['mm:normal:video:en']));
  });

  it('separates pools, modes and languages', () => {
    expect(matchmakingKeys('shadow', 'video', 'en').tag).not.toBe(keys.tag);
    expect(matchmakingKeys('normal', 'text', 'en').tag).not.toBe(keys.tag);
    expect(matchmakingKeys('normal', 'video', 'de').tag).not.toBe(keys.tag);
  });

  it('rejects unknown dimensions and unnormalized or brace-containing interests', () => {
    // @ts-expect-error runtime guard for values that bypassed validation
    expect(() => matchmakingKeys('vip', 'video', 'en')).toThrow();
    // @ts-expect-error runtime guard
    expect(() => matchmakingKeys('normal', 'audio', 'en')).toThrow();
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
    expect(new Set([keys.meta, keys.participants, keys.log].map(hashTagOf))).toEqual(
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
    expect(statsMatchesKey(new Date('2026-10-31T09:05:59.999Z'))).toBe(
      'stats:matches:202610310905',
    );
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

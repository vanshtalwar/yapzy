import { randomUUID } from 'node:crypto';

import { matchmakingKeys, type QueueBucket, recentPairMember } from '@app/redis';
import { createTestRedis } from '@app/redis/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createMatchmaker, type EnqueueResult, type NewSeek } from './matchmaker.ts';

// Group calls (Part 12): sessions seeking one more person and group tickets in one bucket.
// Same DB as matchmaker.test.ts (11); vitest runs the two files one after the other.
const redis = createTestRedis('matchmaking-group-tests', { dbIndex: 11 });
const mm = createMatchmaker(redis, { recentPairTtlMs: 60_000 });
const dims: QueueBucket = { region: 'local', pool: 'normal', mode: 'video', lang: 'en', bucket: 0 };
const keys = matchmakingKeys(dims);
const T0 = 1_800_000_000_000;

const seek = (visitorIds: string[]): NewSeek => ({
  sessionId: randomUUID(),
  seekId: `s${randomUUID().slice(0, 12)}`,
  visitorIds,
  createdAt: T0,
});

function enqueue(visitorId: string, group: boolean): Promise<EnqueueResult> {
  return mm.enqueueOrMatch(
    dims,
    { ticketId: randomUUID(), visitorId, interests: [], createdAt: T0, group },
    'any',
    randomUUID(),
    { now: T0 },
  );
}

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await redis.quit();
});

describe('group joiners', () => {
  it('a group ticket joins a seeking session (first); a plain ticket never does', async () => {
    const s = seek(['alice', 'bob']);
    expect(await mm.seekOrMatch(dims, s, { now: T0 })).toEqual({ status: 'seeking' });
    expect(await enqueue('carol', false)).toEqual({ status: 'waiting' });
    const joined = await enqueue('dave', true);
    expect(joined).toMatchObject({
      status: 'joined',
      seek: { sessionId: s.sessionId, status: 'filled', joiner: 'dave' },
    });
    expect(await redis.llen(keys.queueSeek)).toBe(0);
    // The joiner's ticket is matched to the session (a racing cancel finds where it went).
    const tickets = Object.values(await redis.hgetall(keys.tickets)).map(
      (raw) => JSON.parse(raw) as { visitorId: string; status: string; sessionId?: string },
    );
    expect(tickets.find((t) => t.visitorId === 'dave')).toMatchObject({
      status: 'matched',
      sessionId: s.sessionId,
    });
    // Recent pairs with everyone in the call: no immediate rematch with any of them.
    expect(await redis.zscore(keys.recent, recentPairMember('dave', 'alice'))).not.toBeNull();
    expect(await redis.zscore(keys.recent, recentPairMember('dave', 'bob'))).not.toBeNull();
  });

  it('skips sessions with the joiner in them or a recent pair with any participant', async () => {
    // alice and erin already talked, so they don't pair up 1:1 here either; frank looks at
    // seeking sessions before any 1:1 match.
    for (const [x, y] of [
      ['erin', 'bob'],
      ['alice', 'erin'],
    ] as const) {
      await redis.zadd(keys.recent, T0, recentPairMember(x, y));
    }
    const s = seek(['alice', 'bob']);
    await mm.seekOrMatch(dims, s, { now: T0 });
    expect(await enqueue('alice', true)).toEqual({ status: 'waiting' }); // already in the call
    expect(await enqueue('erin', true)).toEqual({ status: 'waiting' }); // just talked to bob
    expect(await enqueue('frank', true)).toMatchObject({
      status: 'joined',
      seek: { sessionId: s.sessionId },
    });
  });

  it('a session entering seeking takes a waiting group ticket, else waits', async () => {
    // Three tickets that can't pair up 1:1 with each other (recent pairs) wait in q:any.
    for (const [x, y] of [
      ['plain', 'recent'],
      ['plain', 'ok'],
      ['recent', 'ok'],
      ['recent', 'alice'],
    ] as const) {
      await redis.zadd(keys.recent, T0, recentPairMember(x, y));
    }
    await enqueue('plain', false);
    await enqueue('recent', true);
    await enqueue('ok', true);
    expect(await redis.llen(keys.queueAny)).toBe(3);
    const result = await mm.seekOrMatch(dims, seek(['alice', 'bob']), { now: T0 });
    expect(result).toMatchObject({ status: 'joined', joiner: { visitorId: 'ok', status: 'matched' } });
    // The plain and the recent ticket still wait in q:any for a 1:1 match.
    expect(await redis.llen(keys.queueAny)).toBe(2);
    expect(await mm.seekOrMatch(dims, seek(['x', 'y']), { now: T0 })).toMatchObject({
      status: 'joined',
      joiner: { visitorId: 'recent' }, // not recent with x or y
    });
  });

  it('never gives a session more joiners than its free slot (racing tickets)', async () => {
    const s = seek(['alice', 'bob']);
    await mm.seekOrMatch(dims, s, { now: T0 });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => enqueue(`racer-${String(index)}`, true)),
    );
    expect(results.filter((result) => result.status === 'joined')).toHaveLength(1);
    // The others wait — and pair up with each other 1:1, as group tickets also match normally.
    expect(results.find((result) => result.status === 'joined')).toMatchObject({
      seek: { sessionId: s.sessionId },
    });
  });

  it('a ticket never joins two sessions', async () => {
    const first = seek(['a1', 'a2']);
    const second = seek(['b1', 'b2']);
    await mm.seekOrMatch(dims, first, { now: T0 });
    await mm.seekOrMatch(dims, second, { now: T0 });
    const joined = await enqueue('joiner', true);
    expect(joined).toMatchObject({ status: 'joined', seek: { sessionId: first.sessionId } });
    expect(await redis.lrange(keys.queueSeek, 0, -1)).toEqual([second.sessionId]);
    expect(await mm.getSeek(dims, second.sessionId)).toMatchObject({ status: 'seeking' });
  });

  it('cancelSeek removes a waiting seek, reports a filled one; finishSeek deletes it', async () => {
    const waiting = seek(['a', 'b']);
    await mm.seekOrMatch(dims, waiting, { now: T0 });
    expect(await mm.cancelSeek(dims, waiting.sessionId, 'sWrongRound01')).toEqual({ status: 'not_found' });
    expect(await mm.cancelSeek(dims, waiting.sessionId, waiting.seekId)).toEqual({ status: 'cancelled' });
    expect(await mm.getSeek(dims, waiting.sessionId)).toBeNull();
    expect(await enqueue('late', true)).toEqual({ status: 'waiting' }); // nothing left to join

    const filled = seek(['c', 'd']);
    await mm.seekOrMatch(dims, filled, { now: T0 }); // takes "late" at once
    expect(await mm.cancelSeek(dims, filled.sessionId, filled.seekId)).toEqual({
      status: 'filled',
      joinerVisitorId: 'late',
    });
    await mm.finishSeek(dims, filled.sessionId, filled.seekId);
    expect(await mm.getSeek(dims, filled.sessionId)).toBeNull();
  });

  it('the sweeper drops seeks a crashed node left behind', async () => {
    const old = seek(['a', 'b']);
    await mm.seekOrMatch(dims, old, { now: T0 });
    const dropped = await mm.sweepStale(dims, { now: T0 + 31 * 60_000, maxWaitingAgeMs: 30 * 60_000 });
    expect(dropped).toBeGreaterThanOrEqual(1);
    expect(await mm.getSeek(dims, old.sessionId)).toBeNull();
    expect(await redis.llen(keys.queueSeek)).toBe(0);
  });
});

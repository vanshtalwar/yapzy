import { randomInt, randomUUID } from 'node:crypto';

import { matchmakingKeys, type QueueBucket, type QueueFamily } from '@app/redis';
import { createTestRedis } from '@app/redis/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createMatchmaker, type EnqueueResult } from './matchmaker.ts';

/** DB 11: other packages' tests flush 10 and 12–15 in parallel. */
const redis = createTestRedis('matchmaking-tests', { dbIndex: 11 });
const RECENT_TTL = 60_000;
const mm = createMatchmaker(redis, { recentPairTtlMs: RECENT_TTL });
const family: QueueFamily = { region: 'local', pool: 'normal', mode: 'text', lang: 'en' };
const dims: QueueBucket = { ...family, bucket: 0 };
const keysOf = (bucket = 0) => matchmakingKeys({ ...family, bucket });
const T0 = 1_800_000_000_000;
const sid = () => randomUUID();

function ticket(visitorId: string, interests: string[] = [], createdAt = T0) {
  return { ticketId: randomUUID(), visitorId, interests, createdAt };
}

async function join(
  visitorId: string,
  interests: string[] = [],
  opts: { now?: number; at?: QueueBucket; priority?: boolean } = {},
): Promise<{ ticketId: string; result: EnqueueResult }> {
  const now = opts.now ?? T0;
  const t = ticket(visitorId, interests, now);
  const phase = interests.length > 0 ? 'interest' : 'any';
  const result = await mm.enqueueOrMatch(opts.at ?? dims, t, phase, sid(), {
    now,
    priority: opts.priority ?? false,
  });
  return { ticketId: t.ticketId, result };
}

function peerOf(result: EnqueueResult): string | undefined {
  return result.status === 'matched' ? result.peer.visitorId : undefined;
}

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await redis.quit();
});

describe('enqueueOrMatch', () => {
  it('pairs the second visitor with the first and records the session on both tickets', async () => {
    const a = await join('a');
    expect(a.result).toEqual({ status: 'waiting' });

    const sessionId = sid();
    const b = ticket('b');
    const result = await mm.enqueueOrMatch(dims, b, 'any', sessionId, { now: T0 });
    expect(result).toMatchObject({
      status: 'matched',
      peer: { visitorId: 'a' },
      commonInterests: [],
    });
    expect(await mm.getTicket(dims, a.ticketId)).toMatchObject({ status: 'matched', sessionId });
    expect(await mm.getTicket(dims, b.ticketId)).toMatchObject({ status: 'matched', sessionId });
    expect(await redis.llen(keysOf().queueAny)).toBe(0);
  });

  it('serves waiting visitors first-in, first-out', async () => {
    // a and b were just matched, so they wait side by side instead of pairing again.
    await redis.zadd(keysOf().recent, T0, 'a|b');
    await join('a');
    await join('b');
    expect(peerOf((await join('c')).result)).toBe('a');
    expect(peerOf((await join('d')).result)).toBe('b');
  });

  it('serves priority tickets before older normal ones', async () => {
    await redis.zadd(keysOf().recent, T0, 'old|vip');
    await join('old');
    await join('vip', [], { priority: true });
    expect(peerOf((await join('newcomer')).result)).toBe('vip');
  });

  it('prefers a shared interest over the head of the general queue', async () => {
    await join('no-interest');
    await join('music-fan', ['music']);
    const result = (await join('newcomer', ['games', 'music'])).result;
    expect(result).toMatchObject({ peer: { visitorId: 'music-fan' }, commonInterests: ['music'] });
  });

  it('falls back to the general queue only after promotion', async () => {
    await join('plain');
    const gamer = await join('gamer', ['games']);
    expect(gamer.result.status).toBe('waiting'); // interest phase ignores q:any

    const promoted = await mm.promoteToAny(dims, gamer.ticketId, sid(), T0 + 5_000);
    expect(promoted).toMatchObject({ status: 'matched', peer: { visitorId: 'plain' } });
  });

  it('lets a promoted interest ticket be found by later general joins', async () => {
    const gamer = await join('gamer', ['games']);
    expect(await mm.promoteToAny(dims, gamer.ticketId, sid(), T0)).toEqual({ status: 'waiting' });
    expect((await mm.getTicket(dims, gamer.ticketId))?.phase).toBe('any');
    expect(peerOf((await join('plain')).result)).toBe('gamer');
    // Its leftover reference in q:int:games is now dead and gets dropped.
    expect((await join('other-gamer', ['games'])).result.status).toBe('waiting');
    expect(await redis.lrange(keysOf().queueInterest('games'), 0, -1)).toHaveLength(1);
  });

  it('never matches a visitor with themselves', async () => {
    await join('solo');
    expect((await join('solo')).result.status).toBe('waiting');
  });

  it('avoids rematching a recent pair until the TTL expires', async () => {
    await join('a');
    expect(peerOf((await join('b')).result)).toBe('a');

    await join('a', [], { now: T0 + 1_000 });
    expect((await join('b', [], { now: T0 + 2_000 })).result.status).toBe('waiting');
    expect(peerOf((await join('c', [], { now: T0 + 3_000 })).result)).toBe('a'); // skipped, kept

    await redis.flushdb();
    await redis.zadd(keysOf().recent, T0, 'a|b');
    await join('a', [], { now: T0 + RECENT_TTL + 1 });
    expect(peerOf((await join('b', [], { now: T0 + RECENT_TTL + 2 })).result)).toBe('a');
  });

  it('never mixes modes, languages, pools, regions or buckets', async () => {
    await join('a');
    const others: QueueBucket[] = [
      { ...dims, mode: 'video' },
      { ...dims, lang: 'de' },
      { ...dims, pool: 'shadow' },
      { ...dims, region: 'eu' },
      { ...dims, bucket: 1 },
    ];
    for (const at of others) {
      expect((await join(`x-${JSON.stringify(at)}`, [], { at })).result.status).toBe('waiting');
    }
    expect(new Set(others.map((at) => matchmakingKeys(at).tag)).size).toBe(others.length);
  });

  it('skips and drops stale entries (cancelled, missing, orphaned)', async () => {
    const cancelled = await join('gone');
    expect(await mm.cancelTicket(dims, cancelled.ticketId)).toEqual({ status: 'cancelled' });
    await redis.rpush(keysOf().queueAny, randomUUID()); // reference without a ticket

    expect((await join('fresh')).result.status).toBe('waiting');
    expect(await redis.lrange(keysOf().queueAny, 0, -1)).toHaveLength(1); // only "fresh"
  });
});

describe('cancelTicket', () => {
  it('reports the session when the ticket was matched before the cancel arrived', async () => {
    const a = await join('a');
    const sessionId = sid();
    await mm.enqueueOrMatch(dims, ticket('b'), 'any', sessionId, { now: T0 });
    expect(await mm.cancelTicket(dims, a.ticketId)).toEqual({ status: 'matched', sessionId });
    expect(await mm.cancelTicket(dims, randomUUID())).toEqual({ status: 'not_found' });
  });

  it('makes promotion of a cancelled ticket a no-op', async () => {
    const gamer = await join('gamer', ['games']);
    await mm.cancelTicket(dims, gamer.ticketId);
    expect(await mm.promoteToAny(dims, gamer.ticketId, sid(), T0)).toEqual({
      status: 'not_waiting',
    });
  });
});

describe('buckets', () => {
  it('chooses a bucket where someone is waiting over an empty one', async () => {
    await join('waiting-in-1', [], { at: { ...family, bucket: 1 } });
    for (let i = 0; i < 20; i += 1) {
      expect(await mm.chooseBucket(family, 2, [])).toBe(1);
    }
    expect(await mm.chooseBucket(family, 1, [])).toBe(0);
  });

  it('always finds the only non-empty bucket among 4 (samples up to 4 buckets)', async () => {
    await join('lonely', [], { at: { ...family, bucket: 3 } });
    for (let i = 0; i < 20; i += 1) {
      expect(await mm.chooseBucket(family, 4, [])).toBe(3);
    }
  });

  it('matches two visitors waiting alone in different buckets after a hop', async () => {
    const a = await join('a', [], { at: { ...family, bucket: 0 } });
    expect((await join('b', [], { at: { ...family, bucket: 1 } })).result.status).toBe('waiting');

    const hop = await mm.hop(family, 2, 0, a.ticketId, sid(), T0 + 1_000);
    expect(hop).toMatchObject({ status: 'matched', bucket: 1, peer: { visitorId: 'b' } });
    expect(await mm.getTicket(dims, a.ticketId)).toMatchObject({ status: 'cancelled' });
  });

  it('keeps createdAt, phase and id on a hop and requeues with priority', async () => {
    await redis.zadd(keysOf(1).recent, T0, 'early|older');
    const early = await join('early', ['music'], { at: { ...family, bucket: 0 } });
    await join('older', ['music'], { at: { ...family, bucket: 1 }, now: T0 - 10_000 });

    const hop = await mm.hop(family, 2, 0, early.ticketId, sid(), T0 + 1_000);
    expect(hop).toEqual({ status: 'waiting', bucket: 1 });
    expect(await mm.getTicket({ ...family, bucket: 1 }, early.ticketId)).toMatchObject({
      createdAt: T0,
      phase: 'interest',
      status: 'waiting',
    });
    // Priority: the hopped ticket is now ahead of "older" in bucket 1's music queue.
    expect(await redis.lindex(keysOf(1).queueInterest('music'), 0)).toBe(early.ticketId);

    // Hopping back into a bucket that still holds the cancelled copy works too.
    expect(await mm.hop(family, 2, 1, early.ticketId, sid(), T0 + 2_000)).toEqual({
      status: 'waiting',
      bucket: 0,
    });
  });

  it('never loses or duplicates a ticket when a hop races a match', async () => {
    for (let round = 0; round < 30; round += 1) {
      await redis.flushdb();
      const a = await join('a', [], { at: { ...family, bucket: 0 } });
      const [hop, other] = await Promise.all([
        mm.hop(family, 2, 0, a.ticketId, sid(), T0 + 1_000),
        join('b', [], { at: { ...family, bucket: 0 } }),
      ]);

      const copies = await Promise.all(
        [0, 1].map((bucket) => mm.getTicket({ ...family, bucket }, a.ticketId)),
      );
      const live = copies.filter((t) => t?.status === 'waiting' || t?.status === 'matched');
      expect(live).toHaveLength(1); // exactly one live copy of a's ticket
      if (peerOf(other.result) === 'a') {
        expect(hop).toEqual({ status: 'not_waiting' });
      } else {
        expect(hop.status).not.toBe('not_waiting');
      }
    }
  });
});

describe('sweepStale', () => {
  it('drops old settled tickets, over-age waiting tickets and tickets of dead nodes', async () => {
    const keepWaiting = ticket('alive', [], T0);
    const deadNode = { ...ticket('orphan', [], T0), nodeId: 'gw-dead' };
    await mm.enqueueOrMatch(dims, { ...keepWaiting, nodeId: 'gw-live' }, 'any', sid(), {
      now: T0,
    });
    await redis.zadd(keysOf().recent, T0, 'alive|orphan');
    await mm.enqueueOrMatch(dims, deadNode, 'any', sid(), { now: T0 });
    const ancient = await join('ancient', ['rare'], { now: T0 - 3_600_000 });
    const cancelled = await join('quitter', ['rare2']);
    await mm.cancelTicket(dims, cancelled.ticketId);

    const dropped = await mm.sweepStale(dims, {
      now: T0 + 200_000,
      maxWaitingAgeMs: 1_800_000,
      isNodeAlive: (nodeId) => Promise.resolve(nodeId === 'gw-live'),
    });
    expect(dropped).toBe(3);
    expect(await mm.getTicket(dims, keepWaiting.ticketId)).not.toBeNull();
    expect(await mm.getTicket(dims, deadNode.ticketId)).toBeNull();
    expect(await mm.getTicket(dims, ancient.ticketId)).toBeNull();
    expect(await mm.getTicket(dims, cancelled.ticketId)).toBeNull();
  });
});

describe('concurrency', () => {
  it('200 parallel joins: everyone matched at most once, nobody lost', async () => {
    const pool = ['music', 'games', 'movies', 'travel'];
    const visitors = Array.from({ length: 200 }, (_, i) => `v${String(i)}`);
    const joins = await Promise.all(
      visitors.map((visitorId) => {
        const interests = randomInt(0, 3) === 0 ? [] : [pool[randomInt(0, pool.length)] ?? 'music'];
        return join(visitorId, interests);
      }),
    );

    const matchedWith = new Map<string, string>();
    const sessions = new Map<string, number>();
    for (const [index, { result }] of joins.entries()) {
      if (result.status !== 'matched') continue;
      const self = visitors[index] ?? '';
      const peer = result.peer.visitorId;
      expect(matchedWith.has(self)).toBe(false);
      expect(matchedWith.has(peer)).toBe(false);
      matchedWith.set(self, peer);
      matchedWith.set(peer, self);
      const sessionId = result.peer.sessionId ?? '';
      sessions.set(sessionId, (sessions.get(sessionId) ?? 0) + 1);
    }
    expect([...sessions.values()].every((count) => count === 1)).toBe(true);

    // Every visitor is either in exactly one pair or still holds a waiting ticket.
    const tickets = await redis.hgetall(keysOf().tickets);
    const waiting = new Set(
      Object.values(tickets)
        .map((raw) => JSON.parse(raw) as { visitorId: string; status: string })
        .filter((t) => t.status === 'waiting')
        .map((t) => t.visitorId),
    );
    for (const visitorId of visitors) {
      expect(matchedWith.has(visitorId) !== waiting.has(visitorId)).toBe(true);
    }
    expect(matchedWith.size + waiting.size).toBe(200);
    expect(Object.keys(tickets)).toHaveLength(200);
  });
});

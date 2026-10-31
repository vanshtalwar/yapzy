import { randomInt, randomUUID } from 'node:crypto';

import { matchmakingKeys } from '@app/redis';
import { createTestRedis } from '@app/redis/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createMatchmaker, type EnqueueResult, type MatchDimensions } from './matchmaker.ts';

/** DB 11: other packages' tests flush 12–15 in parallel. */
const redis = createTestRedis('matchmaking-tests', { dbIndex: 11 });
const RECENT_TTL = 60_000;
const mm = createMatchmaker(redis, { recentPairTtlMs: RECENT_TTL });
const dims: MatchDimensions = { pool: 'normal', mode: 'text', lang: 'en' };
const T0 = 1_800_000_000_000;

function ticket(visitorId: string, interests: string[] = [], createdAt = T0) {
  return { ticketId: randomUUID(), visitorId, interests, createdAt };
}

async function join(
  visitorId: string,
  interests: string[] = [],
  now = T0,
  at: MatchDimensions = dims,
): Promise<{ ticketId: string; result: EnqueueResult }> {
  const t = ticket(visitorId, interests, now);
  const phase = interests.length > 0 ? 'interest' : 'any';
  return { ticketId: t.ticketId, result: await mm.enqueueOrMatch(at, t, phase, randomUUID(), now) };
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

    const sessionId = randomUUID();
    const b = ticket('b');
    const result = await mm.enqueueOrMatch(dims, b, 'any', sessionId, T0);
    expect(result).toMatchObject({
      status: 'matched',
      peer: { visitorId: 'a' },
      commonInterests: [],
    });

    expect(await mm.getTicket(dims, a.ticketId)).toMatchObject({ status: 'matched', sessionId });
    expect(await mm.getTicket(dims, b.ticketId)).toMatchObject({ status: 'matched', sessionId });
    expect(await redis.llen(matchmakingKeys('normal', 'text', 'en').queueAny)).toBe(0);
  });

  it('serves waiting visitors first-in, first-out', async () => {
    // a and b were just matched, so they wait side by side instead of pairing again.
    await redis.zadd(matchmakingKeys('normal', 'text', 'en').recent, T0, 'a|b');
    await join('a');
    await join('b');
    expect(peerOf((await join('c')).result)).toBe('a');
    expect(peerOf((await join('d')).result)).toBe('b');
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

    const promoted = await mm.promoteToAny(dims, gamer.ticketId, randomUUID(), T0 + 5_000);
    expect(promoted).toMatchObject({ status: 'matched', peer: { visitorId: 'plain' } });
  });

  it('lets a promoted interest ticket be found by later general joins', async () => {
    const gamer = await join('gamer', ['games']);
    expect(await mm.promoteToAny(dims, gamer.ticketId, randomUUID(), T0)).toEqual({
      status: 'waiting',
    });
    expect(peerOf((await join('plain')).result)).toBe('gamer');
    // Its leftover reference in q:int:games is now dead and gets dropped.
    expect((await join('other-gamer', ['games'])).result.status).toBe('waiting');
    expect(
      await redis.lrange(matchmakingKeys('normal', 'text', 'en').queueInterest('games'), 0, -1),
    ).toHaveLength(1);
  });

  it('never matches a visitor with themselves', async () => {
    await join('solo');
    expect((await join('solo')).result.status).toBe('waiting');
  });

  it('avoids rematching a recent pair until the TTL expires', async () => {
    await join('a');
    expect(peerOf((await join('b')).result)).toBe('a');

    await join('a', [], T0 + 1_000);
    expect((await join('b', [], T0 + 2_000)).result.status).toBe('waiting');
    expect(peerOf((await join('c', [], T0 + 3_000)).result)).toBe('a'); // a was skipped, not dropped

    await redis.flushdb();
    await redis.zadd(matchmakingKeys('normal', 'text', 'en').recent, T0, 'a|b');
    await join('a', [], T0 + RECENT_TTL + 1);
    expect(peerOf((await join('b', [], T0 + RECENT_TTL + 2)).result)).toBe('a');
  });

  it('never mixes modes, languages or pools', async () => {
    await join('a', [], T0, { pool: 'normal', mode: 'text', lang: 'en' });
    for (const other of [
      { pool: 'normal', mode: 'video', lang: 'en' },
      { pool: 'normal', mode: 'text', lang: 'de' },
      { pool: 'shadow', mode: 'text', lang: 'en' },
    ] as const) {
      expect(
        (await join(`x-${other.pool}-${other.mode}-${other.lang}`, [], T0, other)).result.status,
      ).toBe('waiting');
    }
  });

  it('skips and drops stale entries (cancelled, missing, orphaned)', async () => {
    const queueAny = matchmakingKeys('normal', 'text', 'en').queueAny;
    const cancelled = await join('gone');
    expect(await mm.cancelTicket(dims, cancelled.ticketId)).toEqual({ status: 'cancelled' });
    await redis.rpush(queueAny, randomUUID()); // reference without a ticket

    expect((await join('fresh')).result.status).toBe('waiting');
    expect(await redis.lrange(queueAny, 0, -1)).toHaveLength(1); // only "fresh" remains
  });
});

describe('cancelTicket', () => {
  it('reports the session when the ticket was matched before the cancel arrived', async () => {
    const a = await join('a');
    const sessionId = randomUUID();
    await mm.enqueueOrMatch(dims, ticket('b'), 'any', sessionId, T0);
    expect(await mm.cancelTicket(dims, a.ticketId)).toEqual({ status: 'matched', sessionId });
    expect(await mm.cancelTicket(dims, randomUUID())).toEqual({ status: 'not_found' });
  });

  it('makes promotion of a cancelled ticket a no-op', async () => {
    const gamer = await join('gamer', ['games']);
    await mm.cancelTicket(dims, gamer.ticketId);
    expect(await mm.promoteToAny(dims, gamer.ticketId, randomUUID(), T0)).toEqual({
      status: 'not_waiting',
    });
  });
});

describe('sweepStale', () => {
  it('drops old settled tickets, over-age waiting tickets and tickets of dead nodes', async () => {
    const keepWaiting = ticket('alive', [], T0);
    const deadNode = { ...ticket('orphan', [], T0), nodeId: 'gw-dead' };
    await mm.enqueueOrMatch(dims, { ...keepWaiting, nodeId: 'gw-live' }, 'any', randomUUID(), T0);
    await redis.zadd(matchmakingKeys('normal', 'text', 'en').recent, T0, 'alive|orphan');
    await mm.enqueueOrMatch(dims, deadNode, 'any', randomUUID(), T0);
    const ancient = await join('ancient', ['rare'], T0 - 3_600_000);
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
    const tickets = await redis.hgetall(matchmakingKeys('normal', 'text', 'en').tickets);
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

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { getJson, hgetallJson, hgetJson, hsetJson, RedisJsonError, setJson } from './json.ts';
import { createTestRedis } from './testing.ts';

const redis = createTestRedis('test:json');
const entrySchema = z.object({ visitorId: z.string(), joinedAt: z.number().int() });

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await redis.quit();
});

describe('JSON helpers (integration)', () => {
  it('round-trips validated values with an optional TTL', async () => {
    await setJson(redis, 'k1', entrySchema, { visitorId: 'v1', joinedAt: 1 }, { ttlSeconds: 60 });
    expect(await getJson(redis, 'k1', entrySchema)).toEqual({ visitorId: 'v1', joinedAt: 1 });
    const ttl = await redis.ttl('k1');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('returns null for missing keys and fields', async () => {
    expect(await getJson(redis, 'missing', entrySchema)).toBeNull();
    expect(await hgetJson(redis, 'missing', 'f', entrySchema)).toBeNull();
  });

  it('refuses to write values that fail the schema', async () => {
    // @ts-expect-error invalid on purpose
    await expect(setJson(redis, 'k2', entrySchema, { visitorId: 1 })).rejects.toThrow();
    expect(await redis.exists('k2')).toBe(0);
  });

  it('throws RedisJsonError for corrupt or schema-violating data, without leaking the value', async () => {
    await redis.set('bad-json', '{not json');
    await redis.set('bad-shape', JSON.stringify({ visitorId: 'secret chat text', joinedAt: 'x' }));
    await expect(getJson(redis, 'bad-json', entrySchema)).rejects.toBeInstanceOf(RedisJsonError);
    const error: unknown = await getJson(redis, 'bad-shape', entrySchema).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RedisJsonError);
    expect((error as Error).message).toBe('Invalid JSON in Redis at bad-shape');
  });

  it('reads and writes hash fields', async () => {
    await hsetJson(redis, 'h', 'p1', entrySchema, { visitorId: 'v1', joinedAt: 1 });
    await hsetJson(redis, 'h', 'p2', entrySchema, { visitorId: 'v2', joinedAt: 2 });
    expect(await hgetJson(redis, 'h', 'p2', entrySchema)).toEqual({ visitorId: 'v2', joinedAt: 2 });
    const all = await hgetallJson(redis, 'h', entrySchema);
    expect([...all.keys()].sort()).toEqual(['p1', 'p2']);
    expect(all.get('p1')?.visitorId).toBe('v1');
  });
});

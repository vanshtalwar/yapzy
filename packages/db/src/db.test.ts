import { randomBytes } from 'node:crypto';

import { createEnv, databaseTestEnv } from '@app/env';
import { afterAll, describe, expect, it } from 'vitest';

import { assertBanHasTarget, BanTargetError } from './ban.ts';
import { createPrismaClient } from './client.ts';
import { Prisma } from './generated/prisma/client.ts';

const { DATABASE_URL_TEST } = createEnv(databaseTestEnv, { service: 'db-tests' });
const db = createPrismaClient({ databaseUrl: DATABASE_URL_TEST, maxConnections: 2 });

const randomHash = () => randomBytes(32).toString('hex');
const createdVisitorIds: string[] = [];

afterAll(async () => {
  await db.visitor.deleteMany({ where: { id: { in: createdVisitorIds } } });
  await db.$disconnect();
});

describe('database smoke test (app_test)', () => {
  it('creates and reads a Visitor with defaults', async () => {
    const deviceIdHash = randomHash();
    const created = await db.visitor.create({ data: { deviceIdHash } });
    createdVisitorIds.push(created.id);

    const read = await db.visitor.findUnique({ where: { deviceIdHash } });
    expect(read?.id).toBe(created.id);
    expect(read?.trustScore).toBe(50);
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/); // UUIDv7
  });

  it('enforces the unique deviceIdHash', async () => {
    const deviceIdHash = randomHash();
    const first = await db.visitor.create({ data: { deviceIdHash } });
    createdVisitorIds.push(first.id);

    const duplicate = await db.visitor.create({ data: { deviceIdHash } }).catch((e: unknown) => e);
    expect(duplicate).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((duplicate as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('rejects raw identifiers where a hash is expected (CHECK constraint)', async () => {
    await expect(db.visitor.create({ data: { deviceIdHash: '203.0.113.7' } })).rejects.toThrow();
  });

  it('rejects a ban without any target, in code and in the database', async () => {
    expect(() => {
      assertBanHasTarget({ visitorId: null, deviceIdHash: undefined });
    }).toThrow(BanTargetError);
    expect(() => {
      assertBanHasTarget({ ipHash: randomHash() });
    }).not.toThrow();

    await expect(
      db.ban.create({ data: { type: 'HARD', reason: 'test: no target' } }),
    ).rejects.toThrow(/bans_target_required|constraint/i);
  });
});

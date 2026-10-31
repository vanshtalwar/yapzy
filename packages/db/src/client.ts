import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client.ts';

export interface CreatePrismaClientOptions {
  databaseUrl: string;
  /** pg pool size per process; keep low so N services × M instances stay under max_connections. */
  maxConnections?: number;
}

export function createPrismaClient({
  databaseUrl,
  maxConnections = 10,
}: CreatePrismaClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: databaseUrl,
    max: maxConnections,
    // pg waits forever by default; fail fast like Prisma ≤ 6 did.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  return new PrismaClient({ adapter });
}

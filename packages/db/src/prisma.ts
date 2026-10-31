import { createEnv, databaseEnv } from '@app/env';

import { createPrismaClient } from './client.ts';
import { type PrismaClient } from './generated/prisma/client.ts';

const env = createEnv(databaseEnv, { service: 'db' });

// Dev hot reload (tsx watch, Next.js) re-evaluates modules; caching on globalThis reuses one
// pool instead of leaking a new one per reload.
const globalForPrisma = globalThis as typeof globalThis & { __appPrisma?: PrismaClient };

/** Process-wide client for DATABASE_URL. Connects lazily on the first query. */
export const prisma: PrismaClient =
  globalForPrisma.__appPrisma ?? createPrismaClient({ databaseUrl: env.DATABASE_URL });

if (env.NODE_ENV !== 'production') globalForPrisma.__appPrisma = prisma;

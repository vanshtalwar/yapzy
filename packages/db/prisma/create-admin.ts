/**
 * Create (or reset) an admin account — the way to bootstrap the first ADMIN anywhere,
 * production included (the dev seed refuses NODE_ENV=production). Later admins are created
 * from the admin UI. Usage:
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='…' ADMIN_ROLE=ADMIN pnpm admin:create
 * The password (≥ 12 chars) is read from the environment only, never from arguments, so it
 * stays out of shell history and process lists; it is stored as an argon2id hash.
 */
import { createEnv, databaseEnv } from '@app/env';
import { createLogger } from '@app/logger';
import { hash } from '@node-rs/argon2';
import { z } from 'zod';

import { createPrismaClient } from '../src/client.ts';

const env = createEnv(
  databaseEnv.extend({
    ADMIN_EMAIL: z.email(),
    ADMIN_PASSWORD: z.string().min(12),
    ADMIN_ROLE: z.enum(['ADMIN', 'MODERATOR']).default('MODERATOR'),
  }),
  { service: 'create-admin' },
);
const log = createLogger({ service: 'create-admin', level: env.LOG_LEVEL, nodeEnv: env.NODE_ENV });
const db = createPrismaClient({ databaseUrl: env.DATABASE_URL, maxConnections: 1 });

const email = env.ADMIN_EMAIL.trim().toLowerCase();
const passwordHash = await hash(env.ADMIN_PASSWORD);
const admin = await db.adminUser.upsert({
  where: { email },
  create: { email, passwordHash, role: env.ADMIN_ROLE },
  // Resetting an existing account re-enables it and clears its 2FA enrolment.
  update: {
    passwordHash,
    role: env.ADMIN_ROLE,
    disabledAt: null,
    totpSecret: null,
    totpEnabled: false,
  },
});
log.info({ adminId: admin.id, role: admin.role }, 'admin account ready');
await db.$disconnect();

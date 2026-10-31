import { loadRootEnvFile } from '@app/env';
import { defineConfig } from 'prisma/config';

// Prisma 7 does not read .env itself; use the same single root .env as every service.
loadRootEnvFile();

// `DB_TARGET=test` points migrate commands at the integration-test database.
const urlVariable = process.env.DB_TARGET === 'test' ? 'DATABASE_URL_TEST' : 'DATABASE_URL';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Not `env()`: `prisma generate` needs no database and must work on a fresh clone/CI
    // without .env. Commands that connect fail with Prisma's own error if this is empty.
    url: process.env[urlVariable] ?? '',
  },
});

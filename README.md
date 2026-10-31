# RandomChat

Random 1:1 text & video chat platform (development build). Monorepo: pnpm workspaces +
Turborepo, TypeScript everywhere.

- Implementation plan: [`MASTER_IMPLEMENTATION_PROMPT.md`](./MASTER_IMPLEMENTATION_PROMPT.md)
- Current state, decisions, ports, env vars: [`CONTEXT.md`](./CONTEXT.md)

## Prerequisites

- **Node.js 24** (see `.nvmrc`)
- **pnpm 12** via Corepack: `corepack enable pnpm` (if `/usr/local/bin` is not writable:
  `corepack enable --install-directory ~/.local/bin pnpm`, with `~/.local/bin` on `PATH`)
- **Docker** with Compose v2 (Docker Desktop on macOS)

## Setup

```bash
pnpm install
cp .env.example .env    # then replace the "dev-only" secrets, e.g. `openssl rand -hex 32`
pnpm infra:up           # Postgres, Redis, coturn, MinIO (+ bucket bootstrap)
```

If port 5432 is already used (e.g. Homebrew Postgres), set `POSTGRES_PORT=5433` in `.env` and
update `DATABASE_URL` / `DATABASE_URL_TEST` to match.

MinIO console: <http://localhost:9001> (user `S3_ACCESS_KEY`, password `S3_SECRET_KEY` from `.env`).

## Scripts

| Command                        | What it does                                                   |
| ------------------------------ | -------------------------------------------------------------- |
| `pnpm dev`                     | Run all apps in watch mode (apps arrive from Part 3)           |
| `pnpm build`                   | Build all apps                                                 |
| `pnpm lint`                    | ESLint (type-aware) in every package                           |
| `pnpm typecheck`               | `tsc` in every package                                         |
| `pnpm test`                    | Vitest in every package                                        |
| `pnpm format` / `format:check` | Prettier write / check                                         |
| `pnpm infra:up`                | Start infrastructure, wait until healthy, create MinIO buckets |
| `pnpm infra:down`              | Stop infrastructure (keeps data)                               |
| `pnpm infra:reset`             | Stop infrastructure and **delete all data volumes**            |
| `pnpm infra:logs` / `infra:ps` | Follow logs / show container status                            |
| `pnpm db:*`                    | Database scripts (Part 2)                                      |

Quality gate before committing: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

## Layout

```
apps/        user-facing and backend services (from Part 3)
packages/    config, env, logger, shared (+ db, redis, matchmaking, moderation later)
infra/docker docker-compose.yml, coturn, Postgres init, MinIO init
tools/ e2e/  bots and end-to-end tests (later parts)
```

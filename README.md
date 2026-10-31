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
pnpm db:migrate         # apply migrations to the dev database
pnpm db:seed            # dev admin + sample visitors, reports, a shadow ban
```

If port 5432 is already used (e.g. Homebrew Postgres), set `POSTGRES_PORT=5433` in `.env` and
update `DATABASE_URL` / `DATABASE_URL_TEST` to match.

MinIO console: <http://localhost:9001> (user `S3_ACCESS_KEY`, password `S3_SECRET_KEY` from `.env`).

## Scripts

| Command                        | What it does                                                        |
| ------------------------------ | ------------------------------------------------------------------- |
| `pnpm dev`                     | Run all apps in watch mode (API + one gateway node)                 |
| `pnpm build`                   | Build all apps                                                      |
| `pnpm lint`                    | ESLint (type-aware) in every package                                |
| `pnpm typecheck`               | `tsc` in every package                                              |
| `pnpm test`                    | Vitest in every package                                             |
| `pnpm format` / `format:check` | Prettier write / check                                              |
| `pnpm infra:up`                | Start infrastructure, wait until healthy, create MinIO buckets      |
| `pnpm infra:down`              | Stop infrastructure (keeps data)                                    |
| `pnpm infra:reset`             | Stop infrastructure and **delete all data volumes**                 |
| `pnpm infra:logs` / `infra:ps` | Follow logs / show container status                                 |
| `pnpm db:migrate` / `db:seed`  | Apply migrations / load idempotent dev data (`db:studio` to browse) |
| `pnpm db:generate`             | Regenerate the Prisma client after editing the schema               |

Quality gate before committing: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
`@app/db`, `@app/redis`, `@app/moderation`, `@app/api` and `@app/gateway` tests are integration
tests: run `pnpm infra:up` first.

## REST API (`apps/api`, port 4000)

```bash
pnpm --filter @app/api dev     # tsx watch (or `pnpm dev` for everything)
pnpm --filter @app/api build && pnpm --filter @app/api start   # bundled build
```

Try it with curl. In development the Turnstile test secret accepts any token, but the API still
calls Cloudflare's siteverify, so this needs internet access.

```bash
curl localhost:4000/health          # {"status":"ok"}
curl localhost:4000/ready           # Postgres + Redis checks (503 if either is down)
curl localhost:4000/v1/config

# Start an anonymous session (deviceId = any UUID; the web app keeps one in localStorage)
TOKEN=$(curl -s -X POST localhost:4000/v1/session -H 'content-type: application/json' \
  -d "{\"turnstileToken\":\"XXXX.DUMMY.TOKEN.XXXX\",\"ageConfirmed\":true,\"tosVersion\":\"2026-10-dev\",\"deviceId\":\"$(uuidgen | tr A-Z a-z)\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

curl localhost:4000/v1/turn-credentials -H "authorization: Bearer $TOKEN"
curl localhost:4000/v1/stats/online   # 0 until the gateway exists
```

Errors always look like `{"error":{"code":"…","message":"…","requestId":"…"}}`; the same id is
in the `x-request-id` response header and the server logs.

## Real-time gateway (`apps/gateway`, port 4001)

```bash
pnpm --filter @app/gateway dev         # one node on 4001
pnpm --filter @app/gateway dev:multi   # two nodes: gw-4001 and gw-4011
pnpm --filter @app/gateway build && pnpm --filter @app/gateway start
curl localhost:4001/health && curl localhost:4001/ready
```

Watch the online count across both nodes (API and `dev:multi` running):

```bash
pnpm --filter @app/bots connect --count 5 --gateway http://localhost:4001,http://localhost:4011
curl localhost:4000/v1/stats/online   # {"online":5} within ~5 s; drops when you Ctrl-C the bots
```

Each bot starts a real session through the API, so more than 10 bots per minute from one IP hit
the session rate limit unless `RATE_LIMIT_DISABLED=true` (honoured only in development).

## Layout

```
apps/        api (Fastify REST), gateway (Socket.io); web, admin, worker in later parts
packages/    config, env, logger, shared, db (Prisma), redis, moderation (bans)
infra/docker docker-compose.yml, coturn, Postgres init, MinIO init
tools/bots   socket bot clients (`connect`)
```

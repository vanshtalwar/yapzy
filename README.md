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
| `pnpm dev`                     | Run all apps in watch mode (web, API, one gateway node, worker)     |
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
`@app/db`, `@app/redis`, `@app/matchmaking`, `@app/moderation`, `@app/api`, `@app/gateway` and `@app/worker` tests are integration
tests: run `pnpm infra:up` first.

## Web app (`apps/web`, port 3000)

```bash
pnpm dev    # web + API + gateway + worker (needs `pnpm infra:up`)
```

Open <http://localhost:3000> in two windows that don't share storage (one normal, one
incognito), click **Start chatting** in both, tick the three boxes and wait for the bot check
(Cloudflare's always-pass test key, so it needs internet), then chat. **Next** needs a second
press within 3 s (or Esc twice); **Stop** leaves the chat. With "Auto-find next stranger" on,
both windows search again after a chat ends. A tab left in the background for 60 s while
searching pauses itself ("Keep searching").

```bash
pnpm --filter @app/web build && pnpm --filter @app/web start   # production build
pnpm --filter @app/web test                                     # store/controller unit tests
```

The UI kit lives in `packages/ui` (`@app/ui`): shadcn-style components adapted from
[21st.dev](https://21st.dev) via the `21st` MCP (provenance in each file and in `CONTEXT.md`).

### Video chat

Pick **Video chat** on the landing page (or open <http://localhost:3000/chat?mode=video>). The
pre-join screen asks for camera and microphone, shows a preview, device pickers and a mic
meter; **Start video chat** only enables once both work, so nobody is matched without media.
Calls are peer-to-peer WebRTC with coturn as fallback; text chat stays available next to the
video (a drawer on phones).

- Relay-only mode: set `NEXT_PUBLIC_FORCE_TURN_RELAY=true` in `.env` and restart the web app;
  `chrome://webrtc-internals` then shows a `relay` candidate pair.
- Restarting the gateway during a call does not interrupt the video; text chat resumes once the
  socket reconnects.
- Phones and other devices on the LAN: see [`docs/LAN_TESTING.md`](./docs/LAN_TESTING.md)
  (the camera needs https or localhost).

Overrides for `pnpm dev` go in `.env`: Turborepo runs tasks in strict env mode, so variables
set on the command line (`FOO=1 pnpm dev`) do not reach the apps. To override one app only, run
it directly, e.g. `RECENT_PAIR_TTL_MS=0 pnpm --filter @app/gateway dev`.

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

## Worker (`apps/worker`)

Consumes BullMQ jobs; today `session-log`, which writes `ChatSessionLog` + `SessionParticipant`
rows (metadata only, never messages) when a chat ends.

```bash
pnpm --filter @app/worker dev     # or build + start
```

## Load bots: full chat flow

With the API, both gateway nodes and the worker running (four terminals):

```bash
RATE_LIMIT_DISABLED=true pnpm --filter @app/api dev   # lets 50 bots start sessions at once
pnpm --filter @app/gateway dev:multi
pnpm --filter @app/worker dev
pnpm bots -- --clients 50 --gateways http://localhost:4001,http://localhost:4011 \
  --mode text --duration 120 --ghost-rate 0.1 --reconnect-rate 0.1
```

Each bot queues with random interests, acks its match, chats, then skips or ends, and repeats.
`--ghost-rate` bots never send `match:ack` (their sessions must end after `MATCH_ACK_TIMEOUT_MS`);
`--reconnect-rate` bots drop their socket mid-session, reconnect to another gateway and resume.
Restart one gateway node during a run (Ctrl-C it and start it again): its bots reconnect to the
other node and resume, and no session ends. The summary lists sessions (and any asymmetric
matches), undelivered messages, resumes, ghost-session end times, protocol errors and p50/p95
time-to-match; the exit code is 1 if anything was wrong. Browse the persisted sessions with
`pnpm db:studio` → `ChatSessionLog`.

To compare queue bucketing, start the gateways with `MM_BUCKETS=1` and then `MM_BUCKETS=4`.

## Layout

```
apps/        web (Next.js), api (Fastify REST), gateway (Socket.io), worker (BullMQ); admin in Part 9
packages/    config, env, logger, shared, ui (React kit), db (Prisma), redis, matchmaking (Lua), moderation (bans)
infra/docker docker-compose.yml, coturn, Postgres init, MinIO init
tools/bots   socket bot clients (`connect`, `bots`)
```

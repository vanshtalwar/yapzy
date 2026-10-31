# CONTEXT.md — Living Project Context

> **Agents:** read this file fully before any work, and update it before finishing any task that changes code, config or decisions (see `CLAUDE.md`). Keep it factual and concise; it is the only memory carried between sessions. Replace "TBD" entries as they become real — do not leave stale information.

---

## 1. Snapshot

| Item | Value |
|---|---|
| Project | RandomChat (working title) — random 1:1 text & video chat platform |
| Phase | Development build (local only) |
| Implementation plan | `MASTER_IMPLEMENTATION_PROMPT.md` (12 parts, executed one at a time) |
| Planned group calls | Up to **4 people per video call** via **Janus VideoRoom** (Parts 11–12); 2-person calls stay P2P. Parts 1–10 must stay participant-list based and keep the `CallManager` transport interface |
| Current status | Parts 1–5 done — **next: the Part 5 follow-up (session resilience + scale fixes, see Known issues), then Part 6** |
| Last updated | 2026-10-31 |

## 2. Progress tracker

| Part | Title | Status | Date | Notes |
|---|---|---|---|---|
| 1 | Monorepo foundation & local infrastructure | ✅ Done | 2026-10-31 | Postgres host port configurable (`POSTGRES_PORT`); MinIO via community fork image (D-014) |
| 2 | Database & shared server packages | ✅ Done | 2026-10-31 | Prisma 7.10.1 (driver adapter), CHECK constraints in migration SQL, ioredis 6 pinned to RESP2 (D-019) |
| 3 | REST API service | ✅ Done | 2026-10-31 | Fastify 5; TURN creds verified against live coturn; real Turnstile siteverify call in dev |
| 4 | Real-time gateway core | ✅ Done | 2026-10-31 | Two nodes verified live (stats 3+2=5); sharded adapter on node-redis (D-031); `VALIDATION_FAILED` used instead of spec's `VALIDATION_ERROR` (D-034) |
| 5 | Matchmaking & chat session lifecycle | ✅ Done | 2026-10-31 | Bots: 50 clients × 2 min × 2 nodes → 2 342 sessions, 0 asymmetric, 0 protocol errors, 8 202/8 202 messages delivered, p50 13 ms / p95 2.5 s to match |
| 6 | Web app & text chat | ⬜ Not started | | |
| 7 | Video chat (WebRTC) | ⬜ Not started | | |
| 8 | Trust & safety | ⬜ Not started | | |
| 9 | Admin & moderation dashboard | ⬜ Not started | | |
| 10 | Hardening, observability, testing & DX | ⬜ Not started | | |
| 11 | Janus SFU & call topology switch | ⬜ Not started | | After 1–10 |
| 12 | Group video: add a 3rd and 4th random person | ⬜ Not started | | After 11 |

Status legend: ⬜ Not started · 🟨 In progress · ✅ Done · ⚠️ Done with known issues

## 3. Development environment (observed 2026-10-31)

- OS: macOS (Darwin 25.6.0)
- Node.js: v24.20.0
- Docker: 29.7.2 (Docker Desktop)
- pnpm: 12.16.1 via Corepack. `/usr/local/bin` is not writable on this machine, so the shim was installed with `corepack enable --install-directory ~/.local/bin pnpm` (`~/.local/bin` is on `PATH`).
- Git: initialized in Part 1 (branch `main`)
- Docker Compose: v5.5.0
- **This machine runs a Homebrew `postgresql@17` on 127.0.0.1:5432**, so the local `.env` uses `POSTGRES_PORT=5433` (`DATABASE_URL*` point at 5433). `.env.example` keeps the canonical 5432.
- pnpm 12 enforces a minimum package release age by default (supply-chain guard). Brand-new releases resolve to the previous version; do not add `minimumReleaseAgeExclude` entries without a reason.
- pnpm 12 **fails install** on unapproved dependency build scripts (`ERR_PNPM_IGNORED_BUILDS`). Approved so far (`allowBuilds` in `pnpm-workspace.yaml`): `@prisma/engines`, `prisma`, `esbuild`. Approve new ones with `pnpm approve-builds <pkg>` only after checking what the script does.

## 4. Tech stack

| Layer | Choice | Version |
|---|---|---|
| Language | TypeScript (strict, ESM) | **6.0.x** (`~6.0.3`, pinned — see D-013) |
| Monorepo | pnpm workspaces + Turborepo | pnpm 12.16.1, turbo 2.11 |
| Lint / format | ESLint flat config + typescript-eslint + simple-import-sort; Prettier | eslint 10.13, typescript-eslint 8.72, prettier 3.9 |
| Validation | Zod | 4.6 |
| Logging | pino + pino-pretty | pino 10.4, pino-pretty 13.2 |
| Web / Admin | Next.js (App Router) + Tailwind CSS | TBD |
| UI components | 21st.dev components (via `21st` MCP) in shared `packages/ui` (`@app/ui`), shadcn-style conventions (D-018) | TBD (Part 6) |
| REST API | Node.js + Fastify + Zod | Fastify 5.12, fastify-type-provider-zod 7, @fastify/cors 11, helmet 13, rate-limit 11 (Redis store), sensible 6; bundled with tsup 9, dev via tsx 4 |
| Real-time | Socket.io + `@socket.io/redis-adapter` (sharded) | socket.io 4.8.4 (+ socket.io-client 4.8.4), @socket.io/redis-adapter 8.3 `createShardedAdapter` (`subscriptionMode: 'dynamic'`) on **node-redis 6.3** (adapter only; D-031), proxy-addr 2 |
| Database | PostgreSQL + Prisma ORM | Postgres 18.6 (image `postgres:18.6-alpine`); Prisma **7.10.1** (`prisma-client` generator, `@prisma/adapter-pg` driver adapter, pinned exactly — D-020) |
| Cache / queues / matchmaking | Redis (≥ 7.2) + ioredis + Lua | Redis 8.10.3 (`redis:8.10.3-alpine`); ioredis **6.0** (RESP2 forced — D-019) |
| Background jobs | BullMQ (`apps/worker`) | BullMQ 6.5 (queue prefix `{bull}`), connection by URL; ulid 3 for message ids |
| Object storage | MinIO (S3-compatible) | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, `pgsty/mc:RELEASE.2026-10-26T00-00-00Z` (D-014) |
| Media | WebRTC (P2P) + coturn (TURN/STUN) for 2-person calls; **Janus VideoRoom** (SFU) for 3–4-person calls (Part 11, D-050) | coturn 4.18 (`coturn/coturn:4.18-alpine`); Janus TBD (Part 11) |
| Auth | `jose` JWT (visitors), argon2id + TOTP (admins) | jose 6.2 (HS256 visitor tokens, `@app/shared/visitor-token`); `@node-rs/argon2` 2.2 (argon2id default) |
| Bot protection | Cloudflare Turnstile (test keys in dev) | — |
| Testing | Vitest, Playwright | Vitest 5.0; Playwright TBD |
| Observability | pino, prom-client, Prometheus, Grafana | TBD |

## 5. Architecture (summary)

- Browser ↔ `apps/api` (REST: sessions, TURN creds, reports, admin) and ↔ `apps/gateway` (Socket.io: queue, matching, text relay, WebRTC signaling relay).
- Matchmaking runs as atomic Redis Lua scripts called by the gateway; gateways are stateless and communicate via the Socket.io sharded Redis adapter + `gw:control` pub/sub channel.
- Video/audio flows peer-to-peer (DTLS-SRTP); coturn relays when P2P fails (or always, when relay mode is forced for IP privacy).
- Postgres stores only metadata, reports, bans, moderation events, admins and audit logs — never chat content except report evidence.
- Full canonical design: `MASTER_IMPLEMENTATION_PROMPT.md` → **Reference Design**.

## 6. Repository layout (actual)

```
/
├─ apps/
│  ├─ api/                Fastify REST API (port 4000)
│     ├─ src/server.ts    entry: env, logger, redis, prisma singleton, listen, graceful SIGTERM/SIGINT
│     ├─ src/app.ts       buildApp(deps) — plugins, rate limit, auth, routes (DI: config, prisma, redis, turnstile, clock, logger)
│     ├─ src/plugins/     auth.ts (Bearer JWT → request.visitor), error-handler.ts (envelope, 404)
│     ├─ src/routes/      health.ts, config.ts, session.ts, turn.ts, stats.ts
│     ├─ src/services/    turnstile.ts, bans.ts (ban checker + Redis cache), turn.ts (coturn creds), online.ts
│     ├─ src/test/        helpers.ts (test config, fakes, Redis DB 14); src/**/*.test.ts
│  │  └─ tsup.config.ts   bundles @app/* into dist/server.js; npm deps stay external
│  ├─ gateway/            Socket.io gateway (port 4001; second node 4011)
│     ├─ src/server.ts    entry: env, node id, logger, prisma singleton, listen, SIGTERM/SIGINT → shutdown()
│     ├─ src/gateway.ts   createGateway(deps): HTTP /health /ready, Socket.io + sharded adapter, origin check,
│     │                   handshake, single-socket policy, presence, onShutdown hooks, shutdown()
│     ├─ src/auth.ts      handshake middleware (JWT, ban check, socket.data)
│     ├─ src/register-handler.ts  attachGuards / registerHandler / markSocketReady (validation, token bucket, abuse)
│     ├─ src/handlers/    index.ts: EVENT_COSTS + all client events (moderation:signal still a stub)
│     ├─ src/sessions/    store.ts (refs, session create/leave Lua, context, transcript), lifecycle.ts
│     │                   (queue → match → session → leave orchestration, per-visitor locks, timers)
│     ├─ src/sweeper.ts   stale-ticket sweeper (30 s, SET NX PX lock)
│     ├─ src/single-socket.ts, presence.ts, client-ip.ts, token-bucket.ts, node-id.ts, errors.ts, types.ts
│     ├─ src/test/        helpers.ts (2 real nodes on random ports, Redis DB 13, unique channels)
│  │  └─ scripts/dev-multi.ts   runs gw-4001 + gw-4011
│  └─ worker/             BullMQ consumers: src/worker.ts (createWorkers), src/jobs/session-log.ts, src/server.ts
├─ packages/
│  ├─ config/             tsconfig.base/node/nextjs.json, eslint.config.base.js (createEslintConfig), prettier.config.js
│  ├─ env/                createEnv(schema), EnvValidationError, root .env loader; schemas: baseEnv, databaseEnv,
│  │                      databaseTestEnv, redisEnv, redisTestEnv, hashPepperEnv, seedEnv, apiEnv
│  ├─ logger/             createLogger({ service, level, nodeEnv, destination }), REDACT_PATHS
│  ├─ shared/             constants.ts, errors.ts (ErrorCode), schemas.ts, socket/ (events.ts names + NOTICE_CODES,
│  │                      schemas.ts payload Zod schemas both directions, types.ts event maps/acks/SocketData);
│  │                      server-only subpaths `@app/shared/crypto` (hmacHash), `@app/shared/jobs`
│  │                      (QUEUE_NAMES, BULLMQ_PREFIX, LEAVE_REASONS, sessionLogJobSchema),
│  │                      `@app/shared/visitor-token` (createVisitorTokenService: issue/verify visitor JWTs)
│  ├─ db/                 prisma.config.ts, prisma/schema.prisma, prisma/migrations/, prisma/seed.ts,
│  │                      src/client.ts (createPrismaClient), src/prisma.ts (singleton), src/ban.ts, src/generated/ (gitignored)
│  ├─ matchmaking/        lua.ts (ENQUEUE_OR_MATCH, CANCEL_TICKET, DROP_TICKETS_IF_UNCHANGED), matchmaker.ts
│  │                      (createMatchmaker: enqueueOrMatch, promoteToAny, cancelTicket, getTicket, sweepStale), ticket.ts
│  ├─ moderation/         bans.ts: createBanChecker (shared by api + gateway); text filter etc. arrive in Part 8
│  └─ redis/              src/client.ts (createRedis), keys.ts (ALL key builders), json.ts (Zod JSON helpers),
│                         control.ts (gw:control pub/sub), bans.ts (ban cache schema + TTLs), ttl.ts,
│                         testing.ts (`@app/redis/testing`: createTestRedis(name, { dbIndex }))
├─ infra/docker/
│  ├─ docker-compose.yml  project name `randomchat`: postgres, redis, coturn, minio, minio-init
│  ├─ coturn/turnserver.conf
│  ├─ postgres/init/01-create-test-db.sql   (creates app_test on first boot)
│  └─ minio/init.sh, minio/frames-lifecycle.json
├─ tools/
│  └─ bots/               `connect` (hold N connections) and `bots` (full chat-flow load test; `pnpm bots -- …`)
├─ package.json  pnpm-workspace.yaml (workspaces + version catalog)  turbo.json
├─ prettier.config.js  .prettierignore  .editorconfig  .nvmrc  .npmrc  .gitignore
└─ .env.example  README.md  CONTEXT.md  CLAUDE.md  MASTER_IMPLEMENTATION_PROMPT.md
```

Conventions established in Part 1:
- Internal packages export TS source (`"exports": { ".": "./src/index.ts" }`), have no build step, and are typechecked/linted/tested per package.
- Relative imports use the **`.ts` extension** (`allowImportingTsExtensions` + `noEmit`); `erasableSyntaxOnly` is on, so no TS `enum`/`namespace`/parameter properties — use `as const` objects (see `ErrorCode`).
- Each package has `tsconfig.json` extending `@app/config/tsconfig.node.json` (or `tsconfig.nextjs.json` for Next apps) and `eslint.config.js` calling `createEslintConfig({ tsconfigRootDir: import.meta.dirname })`.
- Shared dependency versions live in the `catalog:` of `pnpm-workspace.yaml`; package.json files reference `"catalog:"`.
- turbo `lint`/`typecheck`/`test` depend on a no-op `transit` task (correct cache invalidation across workspace deps, still fully parallel).
- `packages/shared` must stay browser-safe (no Node APIs in its main entry); server-only helpers go behind a separate export path (`@app/shared/crypto`).

Conventions established in Part 2:
- `@app/db` exports the generated client (`PrismaClient`, `Prisma`, model types, enums as `as const` objects), `createPrismaClient({ databaseUrl, maxConnections })`, the `prisma` singleton (validates `DATABASE_URL` **at import**, cached on `globalThis` outside production) and `assertBanHasTarget`. Import the generated client only through `@app/db`.
- The Prisma client is generated into `packages/db/src/generated/` (gitignored). turbo runs the `generate` task before `lint`/`typecheck`/`test`/`build`/`dev`, so a fresh clone needs no manual step; `pnpm db:generate` after editing the schema in watch mode.
- Prisma 7: `migrate dev`/`migrate reset` no longer run `generate` or the seed — run `pnpm db:generate` / `pnpm db:seed` explicitly.
- SQL naming: snake_case tables/columns/enum types via `@@map`/`@map`; ids are UUIDv7 (`@default(uuid(7)) @db.Uuid`) except `ChatSessionLog.id` = gateway sessionId; timestamps `timestamptz(3)`.
- Hand-written CHECK constraints are appended to migration SQL (Prisma ignores them when diffing, verified no drift). Create schema changes with `prisma migrate dev --create-only`, add CHECKs, then apply.
- Never build Redis keys inline — use `@app/redis` builders; they throw on ids that could break hash tags and accept only 64-hex hashes for ip/device keys.
- Values in Redis are written/read with `setJson`/`getJson`/`hsetJson`/`hgetJson`/`hgetallJson` (validated both ways; schemas must round-trip, no transforms). Corrupt data throws `RedisJsonError` (message contains the key only).
- Integration tests: Postgres `app_test` (`DATABASE_URL_TEST`, migrated by the turbo `migrate:test` task, which runs before `test` in `@app/db` and every package depending on it) and Redis DB 15 (`REDIS_URL_TEST`; `createTestRedis` refuses DB 0 because tests FLUSHDB). Redis pub/sub is **not** scoped by DB index — tests use a unique channel, never the real `gw:control`.

Conventions established in Part 3:
- Node apps: `src/server.ts` (process wiring only) + `src/app.ts` `buildApp(deps)` (pure, injectable, used by tests via `app.inject`). Apps read env once with their service schema (`apiEnv`).
- Every API error is `{ error: { code: ErrorCode, message, requestId, ...details } }`. Throw `AppError(status, code, message, details?)` for expected failures; anything else becomes a logged 500 with a generic message. Zod validation failures → 400 `VALIDATION_FAILED` with `issues[{ path, message }]`.
- Request ids are generated server-side (UUID), logged as `requestId`, returned in `x-request-id`; client-supplied ids are ignored.
- Routes declare Zod `response` schemas, so only declared fields are ever serialized.
- Rate limits are per route (`config.rateLimit`), Redis-backed, keyed by IP hash or visitor id (never raw IP); keys `rl:api:<METHOD><url>-<subject>`. Auth-keyed limits use `hook: 'preHandler'` so they run after `app.authenticate`.
- Test Redis DB per package (turbo runs packages in parallel and tests FLUSHDB): redis 15, api 14, gateway 13 (reserved). API test files run sequentially (`fileParallelism: false`). Tests build config from literals, not the developer's `.env` (except `DATABASE_URL_TEST`/`REDIS_URL_TEST`).

Conventions established in Part 4:
- Socket event names come from `CLIENT_EVENTS` / `SERVER_EVENTS` (`@app/shared`); payload schemas for both directions live in `packages/shared/src/socket/schemas.ts`; the typed maps `ClientToServerEvents` / `ServerToClientEvents` are checked against the name constants at compile time (`SocketEventMapsMatch`).
- Every client→server handler is registered with `registerHandler(socket, event, schema, handler, { cost })`; never `socket.on` directly. Handlers throw `SocketError(code, message)` for expected failures; the ack is always answered (`{ ok: true, data? }` / `{ ok: false, error }`).
- Handlers run only after the socket is fully registered (Redis socket key, kick broadcast, `visitor:<id>` room joined) — `markSocketReady`.
- Never emit to a socket id across nodes; emit to `visitorRoom(visitorId)` (works on any node through the sharded adapter). Use `io.local` only for node-local work (kicks, shutdown).
- Gateway tests start real gateway instances (`startGateway`) with unique control/adapter channel names per run, so they can run while a dev gateway is up.

Conventions established in Part 5:
- Visitor state is **derived from Redis on every lifecycle event** (`store.visitorState`): `visitor:<id>:session` → in_session, else `visitor:<id>:ticket` → waiting, else idle. `socket.data.state` is informational only (D-038).
- All lifecycle changes for a visitor (join, leave, next, end, interest promotion, reconcile, disconnect) run under a per-visitor lock on the node (`withVisitorLock`).
- Multi-key changes inside one hash tag go through Lua (`@app/matchmaking` for queues, `sessions/store.ts` for sessions); changes spanning tags (visitor refs vs session keys) are ordered so readers never see a ref without its target: write session keys → write session refs → delete ticket refs; on end: clear others' refs → emit `peer:left`.
- Never send visitor ids to clients; participants are addressed by `participantId` and messages are fanned out by looping over active participants' `visitor:<id>` rooms (works for 2 or 3).
- Background work is queued with BullMQ (`@app/shared/jobs` contracts, `{bull}` prefix, deterministic `jobId` for idempotence); the worker re-validates payloads.
- Integration-test Redis DBs: redis 15, api 14, gateway 13, moderation 12, matchmaking 11, worker 10.

### Matchmaking & session design (Part 5)
- **Tickets** (`{mm:<pool>:<mode>:<lang>}:tickets`): JSON `{ ticketId, visitorId, interests, createdAt, status: waiting|matched|cancelled, nodeId, sessionId? }`. `ENQUEUE_OR_MATCH` (one Lua call): phase `interest` scans the ticket's `q:int:<i>` queues, phase `any` scans `q:any`; each scan inspects ≤ 50 entries from the head, **drops** dead refs (missing/not waiting/orphaned same-visitor ticket) and **skips but keeps** recent pairs (D-040); match → both tickets `matched` with the caller's pre-generated `sessionId`, pair added to `recent` (pruned by `RECENT_PAIR_TTL_MS`), common interests returned; no match → `RPUSH` into the phase's queues.
- **Interest fallback:** interest tickets wait in interest queues only; the owning node's timer (`INTEREST_FALLBACK_MS`) calls `promoteToAny` (no-op unless still waiting). Timers live on the node of the waiting socket and are cleared on match/leave/disconnect.
- **Match → session** (done by whichever node ran the matching script): random `participantId` per visitor (`p` + 12 base64url chars) → `session:{id}:meta` + `:participants` (MULTI) → `visitor:<id>:session` refs → delete both ticket refs (compare-and-delete) → `INCR stats:matches:<minute>` → `match:found` to both visitor rooms; one random initiator per pair (`initiator: true, polite: false` for it; the other gets the opposite).
- **Leave** (`gwSessionLeave` Lua over `{sessionId}` keys): marks the participant left (idempotent: `already_left`), returns the still-active others; if < 2 remain → remaining participants marked left (no reason), `state=ended`, `endedAt`, 1 h TTL on meta/participants/log — exactly one caller sees `ended`. That caller clears the others' refs, emits `peer:left { participantId, reason: left|disconnected, sessionEnded }` and enqueues the `session-log` job (`jobId = sessionId`). Reasons: chat:next → SKIP, chat:end/queue:leave → STOP, disconnect/reconcile → DISCONNECT, shutdown → SERVER_RESTART; clients only see `left`/`disconnected`.
- **Match vs. cancel race:** `cancelTicket` on an already-matched ticket returns its `sessionId`; the canceller polls (≤ 20 × 50 ms) until its session ref appears, then leaves it (D-039).
- **Reconnect = fresh start:** on connect, after claiming the visitor, the gateway abandons any ticket/session left by the visitor's previous socket (no session resume). A disconnecting socket only cleans up if it still owns `visitor:<id>:socket`.
- **In-session events** (`lifecycle.inSession`): session ref must name the payload's `sessionId`, session `active`, sender not left → else `NOT_IN_SESSION`. `chat:message`: ulid id + ISO `at`, appended to `session:{id}:log` (LTRIM to last 100), fanned out to active others, ack `{ id, at }`. `chat:typing`: relayed on change, repeats at most every 2 s. `rtc:offer|answer|ice`: video sessions only (`INVALID_STATE` otherwise); `to` must be another active participant (`FORBIDDEN` otherwise); relayed only to that participant with server-set `from`. `rtc:summary`: membership-checked and logged (metrics only). `moderation:signal`: still `NOT_IMPLEMENTED` (Part 8).
- **Sweeper:** every 30 s the node holding `lock:mm:sweep` (SET NX PX 29 s) sweeps all 64 tags: settled tickets > 2 min, waiting tickets > 30 min or whose `nodeId` has no presence key; deletion is compare-and-delete (unchanged since read). Queue refs to deleted tickets are dropped lazily by later scans.
- **Shutdown hook:** `lifecycle.endAllLocal()` (SERVER_RESTART for sessions, cancel tickets) runs before `SERVER_RESTARTING` is sent; disconnect handlers are skipped while draining.

### Gateway design (Part 4)
- **Transport:** plain `node:http` server; Socket.io with `transports: ['websocket']`, `perMessageDeflate: false`, `maxHttpBufferSize` 32 KB, ping 25 s / timeout 20 s, `serveClient: false`. `GET /health` (liveness) and `GET /ready` (Redis app client + adapter client + Postgres; 503 while draining).
- **Origin check:** `allowRequest` rejects any `Origin` not in `CORS_ORIGINS` (CORS doesn't protect WebSockets); requests without `Origin` (bots/tests) are allowed but still need a JWT. Also rejects everything while draining.
- **Adapter:** `createShardedAdapter(pub, sub, { subscriptionMode: 'dynamic' })` with node-redis clients; channel prefix `socket.io` (tests override). ioredis is used for app data and for a dedicated `gw:control` subscriber.
- **Handshake** (`auth.ts`): `auth.token` → visitor JWT verify → client IP via proxy-addr with `TRUST_PROXY` semantics → `ipHash` → ban check (`@app/moderation`, visitor id + IP hash) → HARD ban rejects with `BANNED` (+`expiresAt`); SHADOW → `pool: 'shadow'`. Sets `socket.data = { visitorId, ipHash, pool, state: 'idle' }`. Errors reach the client as `connect_error` with `data: { code, message }` (`UNAUTHORIZED`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `BANNED`, `SERVER_RESTARTING`, `SERVICE_UNAVAILABLE`).
- **One socket per visitor** (`single-socket.ts`): on connect `SET visitor:<id>:socket <socketId> EX 86400` → publish `kick_visitor { keepSocketId }` on `gw:control` → join `visitor:<id>` → evict stale. Every node, on `kick_visitor`, disconnects its local sockets of that visitor whose id ≠ the Redis value (after emitting `system:notice SESSION_REPLACED`). On disconnect the key is deleted only if it still names this socket (Lua compare-and-delete).
- **Guards** (`register-handler.ts`): per-socket token bucket (capacity 20, refill 5/s) with per-event costs; strikes (rate-limited, invalid payload, unknown event) drain an abuse bucket (capacity 30, refill 0.5/s) — when empty: `system:notice RATE_LIMITED` + disconnect. Unknown events are acked with `VALIDATION_FAILED "Unknown event"`. `RATE_LIMIT_DISABLED=true` disables both only in development.
- **Event costs** (`handlers/index.ts` `EVENT_COSTS`): queue:join 2, queue:leave 1, chat:next 3, chat:end 1, chat:message 1, chat:typing 0.25, rtc:offer 1, rtc:answer 1, rtc:ice 0.125, rtc:summary 1, moderation:signal 0.5, ping 1.
- **Presence** (`presence.ts`): every 5 s `SET presence:node:<nodeId> <localSocketCount> EX 15` + `SADD presence:nodes`; each tick also `SREM`s members whose node key has expired (crashed nodes). Graceful stop deletes the key and set member.
- **Shutdown** (`gateway.shutdown()`): draining on (handshakes and `/ready` refused) → run `onShutdown` hooks (Part 5: end sessions) → `system:notice SERVER_RESTARTING` to local sockets → wait until all leave or 10 s → disconnect the rest → unsubscribe control, presence cleanup, `io.close()` (HTTP server + adapter) → quit all Redis clients. `server.ts` force-exits after 20 s.
- **Node id:** `GATEWAY_NODE_ID` or `<hostname>-<port>`; must be unique per running process.

### UI components list (sourced from 21st.dev)

_Filled from Part 6 onward: component — file in `@app/ui` or app — 21st.dev source — license._

| Component | File | Source | License |
|---|---|---|---|
| — | — | — | — |

### MCP servers for agents
- `21st` (21st.dev, HTTP `https://21st.dev/api/mcp`): configured twice — in the user's local Claude config (key inline, takes precedence) and in project `.mcp.json` (key from env var `API_KEY_21ST`, **not set** as of 2026-10-31). `.mcp.json` contains no secret and is safe to commit. Used for all frontend UI work (see master prompt → Reference Design → Frontend UI components).

## 7. Services & ports

| Service | Port | Start command | Status |
|---|---|---|---|
| web | 3000 | TBD | not built |
| admin | 3001 | TBD | not built |
| api | 4000 (`API_HOST`, default 0.0.0.0) | `pnpm --filter @app/api dev` (tsx watch) · `build` (tsup) · `start` (`node dist/server.js`) | ✅ running in dev; graceful shutdown verified |
| gateway | 4001 (+4011 via `dev:multi`), `GATEWAY_HOST` default 0.0.0.0 | `pnpm --filter @app/gateway dev` · `dev:multi` · `build` (tsup) · `start` | ✅ two nodes verified; graceful drain verified |
| worker | — (no HTTP) | `pnpm --filter @app/worker dev` · `build` · `start` | ✅ processed 4 600+ session-log jobs in the bot runs; graceful shutdown waits for in-flight jobs |
| PostgreSQL | 5432 (host port = `POSTGRES_PORT`; **5433 on this machine**), bound to 127.0.0.1 | `pnpm infra:up` | ✅ healthy; dbs `app`, `app_test` |
| Redis | 6379, bound to 127.0.0.1 | `pnpm infra:up` | ✅ healthy; AOF and RDB off |
| coturn | 3478 udp/tcp, 49160–49200/udp, bound to 0.0.0.0 (LAN testing) | `pnpm infra:up` | ✅ healthy; HMAC auth + relay↔relay verified |
| MinIO | 9000 (S3) / 9001 (console), bound to 127.0.0.1 | `pnpm infra:up` | ✅ healthy; buckets `evidence`, `frames` (1-day expiry) |

### coturn on macOS Docker Desktop (verified 2026-10-31)
- Relay candidates advertise `TURN_EXTERNAL_IP` (default `127.0.0.1`) via `--external-ip`; the relay port range is published 1:1, so browsers on the Mac reach `127.0.0.1:491xx`.
- Forced relay on both sides (relay↔relay) works: the "peer" of each allocation is the other allocation's `127.0.0.1:<port>`, which requires `allow-loopback-peers` (dev only). Verified with `turnutils_uclient -y` from a container via `host.docker.internal:3478`: 0 % loss, wrong HMAC secret rejected.
- Without forced relay, two tabs on the same Mac connect via host candidates and never use TURN.
- Mixed relay↔host may fail on Docker Desktop: the host peer's packets reach coturn NATed from the Docker VM gateway IP, not the IP in its permission. Not a production concern (TURN runs on a real host with a public IP).
- To test from a phone on the LAN, set `TURN_EXTERNAL_IP` (and later `TURN_HOST`/`STUN_URLS`) to the Mac's LAN IP and `pnpm infra:up` again.
- `static-auth-secret` is passed as a CLI flag (visible in `docker inspect`) — acceptable for dev only. The coturn image entrypoint `eval`s each argument, so `TURN_SECRET` must not contain shell metacharacters (hex is safe).
- Production SSRF protection (`denied-peer-ip` for private/loopback ranges, `no-loopback-peers`) is present but commented out in `turnserver.conf`, with the reason.

## 8. Environment variables (implemented)

_Add each variable when it is actually used. Canonical names are listed in the master prompt's Reference Design._

All canonical variables are present in `.env.example`; "Read by" lists what consumes each variable **today**. `.env` is generated from it with random `JWT_SECRET`, `IP_HASH_PEPPER`, `DEVICE_HASH_PEPPER`, `TURN_SECRET`, `S3_SECRET_KEY`.

Loading: `@app/env` `createEnv()` finds the workspace root (directory containing `pnpm-workspace.yaml`), loads `.env` once with Node's `util.parseEnv`, and never overrides variables already set in the real environment. Docker Compose reads the same file through `--env-file .env` in the `infra:*` scripts.

| Variable | Read by (now) | Description | Dev default |
|---|---|---|---|
| NODE_ENV | `@app/env` baseEnv | `development` \| `test` \| `production` | development |
| LOG_LEVEL | `@app/env` baseEnv | pino level incl. `silent` | debug (schema default `info`) |
| POSTGRES_PORT | docker-compose | Host port for Docker Postgres (new, not in master design) | 5432 (`.env` here: 5433) |
| DATABASE_URL | `@app/db` (prisma singleton, prisma.config.ts, seed), api, gateway (ban fallback), worker | Postgres URL (validated: `postgres(ql)://`) | postgresql://app:app@localhost:5432/app |
| DATABASE_URL_TEST | `@app/db` tests, `db:migrate:test` (via `DB_TARGET=test`) | Integration-test DB | postgresql://app:app@localhost:5432/app_test |
| DB_TARGET | `packages/db/prisma.config.ts` | Not in .env: `test` makes Prisma CLI use `DATABASE_URL_TEST` (set by the `migrate:test` script) | unset |
| REDIS_URL | api, gateway (app client, control subscriber, adapter pub/sub, BullMQ producer), worker (BullMQ) | Redis URL (validated: `redis(s)://`) | redis://localhost:6379 |
| REDIS_URL_TEST | integration tests (`createTestRedis`; DB index overridden per package: redis 15, api 14, gateway 13, moderation 12, matchmaking 11, worker 10) | Integration-test Redis; must select a non-zero DB (new, not in master design) | redis://localhost:6379/15 |
| JWT_SECRET, JWT_TTL_SECONDS | api (issue), gateway (verify; TTL unused there) | Visitor JWT HS256 secret (≥ 32 chars) / lifetime (60 s – 7 d) | placeholder, 43200 |
| IP_HASH_PEPPER, DEVICE_HASH_PEPPER | seed, api; gateway reads IP_HASH_PEPPER only (`hashPepperEnv`, min 16 chars) | HMAC peppers — rotating one invalidates all stored hashes (bans by device/IP) | placeholders |
| TOS_VERSION | api (`/v1/config`, session check); web in Part 6 | Current ToS version clients must accept | 2026-10-dev |
| TURNSTILE_SECRET_KEY | api (siteverify) | Cloudflare secret; dev = always-pass test secret | 1x0000000000000000000000000000000AA |
| NEXT_PUBLIC_TURNSTILE_SITE_KEY | (Part 6) | Cloudflare site key | always-pass test key |
| TURN_SECRET | docker-compose (coturn `--static-auth-secret`), api (credential HMAC) | Shared TURN HMAC secret (≥ 16 chars) | placeholder |
| TURN_EXTERNAL_IP | docker-compose (coturn `--external-ip`) | IP in relay candidates (new, not in master design) | 127.0.0.1 |
| TURN_HOST, TURN_PORT, TURN_CREDENTIAL_TTL_SECONDS, STUN_URLS | api (`/v1/turn-credentials`) | TURN/STUN servers handed to clients; STUN_URLS comma list of `stun:`/`stuns:` URLs | localhost, 3478, 600, stun:localhost:3478 |
| API_HOST | api | Listen address (new, not in master design) | 0.0.0.0 |
| API_PORT | api | API port | 4000 |
| GATEWAY_HOST | gateway | Listen address (new, not in master design) | 0.0.0.0 |
| GATEWAY_PORT, GATEWAY_NODE_ID | gateway | Port / unique node id (`[A-Za-z0-9_-]{1,64}`; `dev:multi` sets gw-4001 / gw-4011) | 4001, unset → `<hostname>-<port>` |
| CORS_ORIGINS | api, gateway (also the WebSocket Origin allowlist) | Comma list of allowed browser origins (validated URLs) | http://localhost:3000,http://localhost:3001 |
| TRUST_PROXY | api, gateway (proxy-addr) | Proxies trusted for X-Forwarded-For: empty = none, hop count, or IP/CIDR list; `true` rejected (new, not in master design) | empty |
| NEXT_PUBLIC_API_URL, NEXT_PUBLIC_GATEWAY_URL | bots (defaults for `connect`); web in Part 6 | Public API / gateway URLs | http://localhost:4000, http://localhost:4001 |
| NEXT_PUBLIC_FORCE_TURN_RELAY | (Part 7) | Force relay-only ICE | false |
| S3_ACCESS_KEY, S3_SECRET_KEY | docker-compose (MinIO root user/password, minio-init), API/worker later | MinIO creds (password ≥ 8 chars) | randomchat, placeholder |
| S3_BUCKET_EVIDENCE, S3_BUCKET_FRAMES | docker-compose (minio-init), API/worker later | Bucket names | evidence, frames |
| S3_ENDPOINT, S3_REGION | (Part 8) | S3 client | http://localhost:9000, us-east-1 |
| INTEREST_FALLBACK_MS, RECENT_PAIR_TTL_MS | gateway (`gatewayEnv`) | Interest-only wait before the general queue / no-rematch window for a pair | 5000, 60000 |
| WORKER_CONCURRENCY | worker (`workerEnv`) | Parallel jobs per worker process (1–100; new, not in master design) | 10 |
| RATE_LIMIT_DISABLED | api, gateway (token bucket + abuse guard) | Disables rate limits **only if NODE_ENV=development** (ignored + warning otherwise); parsed with `z.stringbool()` | false |
| SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD | `db:seed` (`seedEnv`: email, password ≥ 12 chars) | Dev admin login (password: see your `.env`) | admin@randomchat.local, placeholder |
| ADMIN_SESSION_TTL_SECONDS | (Part 9) | Admin session lifetime | 28800 |

## 9. Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install workspace deps (pnpm 12, catalogs, min-release-age guard) |
| `pnpm dev` / `build` / `lint` / `typecheck` / `test` / `clean` | `turbo run <task>` across the workspace (`build` has no tasks until Part 3 — exits 0) |
| `pnpm format` / `pnpm format:check` | Prettier write / check (planning docs are in `.prettierignore`) |
| `pnpm infra:up` | `docker compose up -d --wait` for postgres/redis/coturn/minio, then `run --rm minio-init` (buckets + lifecycle; idempotent) |
| `pnpm infra:down` | Stop containers, keep volumes |
| `pnpm infra:reset` | Stop and **delete volumes** (re-runs Postgres init script next time) |
| `pnpm infra:logs` / `pnpm infra:ps` | Follow logs / status |
| `pnpm db:generate` | Generate the Prisma client into `packages/db/src/generated/` |
| `pnpm db:migrate` | `prisma migrate dev` on `DATABASE_URL` (create + apply migrations; does **not** generate or seed in Prisma 7) |
| `pnpm db:migrate:test` | `prisma migrate deploy` on `DATABASE_URL_TEST` (also run automatically by `@app/db` tests) |
| `pnpm db:deploy` | `prisma migrate deploy` (apply pending migrations, no prompts) |
| `pnpm db:reset` | Drop + re-apply all migrations on `DATABASE_URL` (then run `pnpm db:seed`) |
| `pnpm db:seed` | Idempotent dev seed (refuses `NODE_ENV=production`) |
| `pnpm db:studio` | Prisma Studio |
| `pnpm approve-builds <pkg>` | Allow a dependency's install script (pnpm 12) |
| `pnpm --filter @app/api dev` | API with tsx watch (reads root `.env` via `@app/env`) |
| `pnpm --filter @app/api build` / `start` | tsup bundle → `apps/api/dist/server.js` / run it with node |
| `pnpm --filter @app/gateway dev` / `dev:multi` | One gateway node (4001) / two nodes gw-4001 + gw-4011 (tsx watch) |
| `pnpm --filter @app/gateway build` / `start` | tsup bundle → `apps/gateway/dist/server.js` / run it |
| `pnpm --filter @app/worker dev` / `build` / `start` | BullMQ worker (tsx watch / tsup bundle) |
| `pnpm bots -- --clients N --gateways URL[,URL] --mode text\|video --lang en --duration S` | Chat-flow load bots; summary + exit 1 on protocol errors/asymmetric matches. Run the API with `RATE_LIMIT_DISABLED=true` for > 10 clients |
| `pnpm --filter @app/bots connect --count N --gateway URL[,URL]` | N bot visitors (real sessions via the API), round-robin over gateways; Ctrl-C to stop |
| `pnpm --filter @app/api test` | API integration tests (needs `pnpm infra:up`; turbo `pnpm test` also migrates `app_test` first) |
| `pnpm --filter @app/<pkg> test` | Run one package's tests |

## 10. Data model (implemented)

Source: `packages/db/prisma/schema.prisma`, migration `20261031110826_init`. All ids UUIDv7; all timestamps `timestamptz(3)`.

| Model (table) | Key fields | Constraints / indexes |
|---|---|---|
| `Visitor` (`visitors`) | `deviceIdHash` char(64), `lastIpHash?`, `firstSeenAt`, `lastSeenAt`, `ageConfirmedAt?`, `tosVersion?`, `trustScore` int=50, `country?` char(2) | unique `deviceIdHash`; idx `lastIpHash`; CHECK hashes are 64-hex, `trustScore` 0–100 |
| `ChatSessionLog` (`chat_session_logs`) | `id` = gateway sessionId (no default), `mode`, `topology`=MESH, `maxParticipants`=2, `commonInterests` text[], `startedAt`, `endedAt?` | idx `startedAt`; CHECK `maxParticipants` 2–16 |
| `SessionParticipant` (`session_participants`) | `sessionId`→ChatSessionLog (cascade), `visitorId`→Visitor (cascade), `participantId` varchar(32), `joinedAt`, `leftAt?`, `leaveReason?` | unique (`sessionId`,`participantId`); idx `visitorId` |
| `Report` (`reports`) | `sessionId` (**no FK** — session log is written async), `reporterId`/`reportedId`→Visitor, `reportedParticipantId`, `reason`, `details?` ≤500, `status`=OPEN, `priority`=0, `transcript?` json, `assignedToId?`→AdminUser, `resolvedAt?`, `resolutionNote?` | idx (`status`,`priority` desc,`createdAt`), (`reportedId`,`createdAt`), (`reporterId`,`createdAt`), `sessionId` |
| `Evidence` (`evidence`) | `reportId?`→Report, `moderationEventId?`→ModerationEvent (both cascade), `type`, `storageKey`, `sha256` char(64), `expiresAt?` | CHECK report or moderation event set; idx each FK + `expiresAt` |
| `ModerationEvent` (`moderation_events`) | `visitorId`→Visitor, `sessionId?`, `source`, `label`, `score` float, `actionTaken`=NONE | idx (`visitorId`,`createdAt`), `createdAt` |
| `Ban` (`bans`) | `visitorId?`→Visitor (set null), `deviceIdHash?`, `ipHash?`, `type`, `reason`, `createdByAdminId?` (null = automated), `expiresAt?` (null = permanent), `revokedAt?`, `revokedByAdminId?` | CHECK at least one target (+ `assertBanHasTarget` in code); CHECK hashes 64-hex; idx `visitorId`, `deviceIdHash`, `ipHash`, `expiresAt` |
| `AdminUser` (`admin_users`) | `email` (unique, CHECK lowercase), `passwordHash` (argon2id PHC), `role`=MODERATOR, `totpSecret?`, `totpEnabled`, `lastLoginAt?`, `disabledAt?` | unique `email` |
| `AuditLog` (`audit_logs`) | `adminId`→AdminUser (restrict), `action`, `targetType`, `targetId?`, `metadata?` json | idx (`adminId`,`createdAt`), (`targetType`,`targetId`), `createdAt` |

Enums (SQL type names snake_case): `ChatMode` TEXT/VIDEO · `SessionTopology` MESH/SFU · `LeaveReason` SKIP/STOP/DISCONNECT/RTC_FAILED/REPORTED/BANNED/SERVER_RESTART · `ReportReason` NUDITY_SEXUAL/MINOR_SAFETY/HARASSMENT/HATE/SPAM_SCAM/VIOLENCE_SELF_HARM/OTHER · `ReportStatus` OPEN/IN_REVIEW/ACTIONED/DISMISSED · `EvidenceType` FRAME/TRANSCRIPT/AUTO_FLAG_FRAME · `ModerationSource` CLIENT_NSFW/SERVER_CLASSIFIER/TEXT_FILTER/HASH_MATCH/REPORT_THRESHOLD · `ModerationAction` NONE/MESSAGE_BLOCKED/TRUST_DECREASED/SHADOW_BANNED/BANNED/ESCALATED (`MESSAGE_BLOCKED` added beyond the plan, for the text filter) · `BanType` HARD/SHADOW · `AdminRole` ADMIN/MODERATOR.

Note: the API uses lowercase `'text'|'video'` (`@app/shared` `CHAT_MODES`); map to `ChatMode` TEXT/VIDEO when writing session logs.

Seed (`pnpm db:seed`, idempotent; dev data recognisable by ids `00000000-0000-7000-8000-…`, `[seed]` text, device ids `seed-device-N`, IPs from 198.51.100.0/24): dev admin (role ADMIN, credentials = `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` in `.env`), 4 visitors, 2 ended sessions (VIDEO + TEXT) with 2 participants each, 3 reports (HARASSMENT, SPAM_SCAM, one DISMISSED), 1 TEXT_FILTER moderation event, 1 SHADOW ban (visitor 3, 30 days).

## 11. Redis keys & channels (implemented)

Builders in `packages/redis/src/keys.ts` (functions/constants in parentheses). Builders throw on ids outside `[A-Za-z0-9_-]{1,128}` and on non-64-hex hashes.

| Key | Type | Builder | Notes |
|---|---|---|---|
| `{mm:<pool>:<mode>:<lang>}:q:any` | LIST | `matchmakingKeys(pool, mode, lang).queueAny` | pool `normal`\|`shadow` (`MATCH_POOLS`) |
| `{mm:…}:q:int:<interest>` | LIST | `.queueInterest(interest)` | interest must be normalized (lowercase, trimmed, no `{}:`) |
| `{mm:…}:tickets` | HASH | `.tickets` | ticketId → `ticketSchema` JSON (`@app/matchmaking`); `interests` may read back as `{}` from Lua (normalized to []) |
| `{mm:…}:recent` | ZSET | `.recent`, member `recentPairMember(a, b)` | member `minId\|maxId` |
| `visitor:<id>:ticket` | STRING (JSON) | `visitorTicketKey` | `{ pool, mode, lang, ticketId }` (gateway `ticketRefSchema`), TTL 24 h, compare-and-delete by ticketId |
| `visitor:<id>:session` | STRING (JSON) | `visitorSessionKey` | `{ sessionId, participantId }` (gateway `sessionRefSchema`) — JSON instead of the plain id in the master design, so handlers know the sender's participantId; TTL 24 h, compare-and-delete by sessionId |
| `visitor:<id>:socket` | STRING | `visitorSocketKey` | id of the visitor's one live socket (TTL 24 h safety; compare-and-delete on disconnect). New in Part 4 (not in master design) |
| `visitor:<id>` | Socket.io room | `visitorRoom` | not a key; delivery target |
| `session:{<id>}:meta` | HASH | `sessionKeys(id).meta` | `mode`, `topology`=mesh, `maxParticipants`, `startedAt` (ms), `commonInterests` (JSON), `state` active\|ended, `endedAt` (ms); 1 h TTL after end |
| `session:{<id>}:participants` | HASH | `.participants` | participantId → `{ visitorId, joinedAt, leftAt?, leaveReason? }` (ms); left participants kept |
| `session:{<id>}:log` | LIST | `.log` | transcript ring buffer: `{ id (ulid), from (participantId), text, at (ISO) }`, last `TRANSCRIPT_MAX_MESSAGES`=100; 1 h TTL after end |
| `presence:node:<nodeId>` | STRING | `presenceNodeKey` | local socket count, written every 5 s by each gateway, TTL `PRESENCE_TTL_SECONDS`=15 |
| `presence:nodes` | SET | `PRESENCE_NODES_KEY` | gateway node ids; dead members pruned by live nodes |
| `socket.io#…` | sharded PUB/SUB | (adapter) | Socket.io adapter channels (prefix `socket.io`, dynamic per-room channels) |
| `stats:matches:<yyyyMMddHHmm>` (UTC) | STRING | `statsMatchesKey(date)` | INCR per match, TTL `STATS_MATCHES_TTL_SECONDS`=7200 |
| `lock:mm:sweep` | STRING | `MATCHMAKING_SWEEP_LOCK_KEY` | sweeper lock (node id, PX 29 s) |
| `{bull}:session-log:*` | BullMQ | `BULLMQ_PREFIX` + `QUEUE_NAMES.SESSION_LOG` | job ids = session ids; completed kept 1 h, failed 7 d |
| `ban:visitor:<id>`, `ban:device:<hash>`, `ban:ip:<hash>` | STRING (JSON) | `banVisitorKey`, `banDeviceKey`, `banIpKey` | value `banCacheEntrySchema`: `{ banned: false }` (TTL `BAN_CACHE_NEGATIVE_TTL_SECONDS`=60) or `{ banned: true, banId, type: HARD\|SHADOW, expiresAt: ISO\|null }` (TTL = time to expiry, max `BAN_CACHE_MAX_TTL_SECONDS`=3600). Written by the API ban checker |
| `trust:<visitorId>` | STRING | `trustKey` | |
| `rl:<scope>:<subject>` | various | `rateLimitKey(scope, subject)` | scope `[a-z0-9:_-]{1,64}` |
| `rl:api:<METHOD><url>-<subject>` | @fastify/rate-limit | prefix `API_RATE_LIMIT_PREFIX` | e.g. `rl:api:POST/v1/session-<ipHash>`, `rl:api:GET/v1/turn-credentials-<visitorId>` |
| `admsess:<id>` | STRING | `adminSessionKey` | |
| channel `gw:control` | PUB/SUB | `GW_CONTROL_CHANNEL`, `publishControl`, `subscribeControl` | classic (not sharded) pub/sub; messages `gwControlMessageSchema` |

`gw:control` messages (all carry `originNodeId`; every node incl. the sender receives them; malformed ones are dropped via `onInvalid`):
- `kick_visitor` `{ visitorId, reason: session_replaced|banned|admin, keepSocketId? }`
- `end_session` `{ sessionId, reason: admin|banned|server_restart }`
- `ban_applied` `{ banId, banType: HARD|SHADOW, visitorId?, deviceIdHash?, ipHash?, expiresAt: ISO|null }` (≥ 1 target required)

`createRedis(url, { connectionName, lazyConnect, logger, redisOptions })`: RESP2, `maxRetriesPerRequest` 3 (pass `{ maxRetriesPerRequest: null }` for BullMQ), jittered exponential reconnect capped at 2 s, reconnect on `READONLY`. Subscribers need a dedicated connection.

## 12. REST endpoints (implemented)

| Method | Path | Auth | Rate limit | Purpose |
|---|---|---|---|---|
| GET | `/health` | — | — | Liveness `{ status: 'ok' }` (no dependencies) |
| GET | `/ready` | — | — | Readiness: `SELECT 1` + Redis `PING` (2 s timeout each) → 200 `{ status: 'ready', checks }` or 503 `{ status: 'unavailable', checks: { postgres, redis: 'ok'\|'fail' } }` |
| GET | `/v1/config` | — | — | `{ tosVersion, maxMessageLength, maxInterests, supportedLangs, features: { video: true, reports: false } }`, `cache-control: public, max-age=60` |
| POST | `/v1/session` | Turnstile | 10/min per IP hash | Body `{ turnstileToken, ageConfirmed, tosVersion, deviceId (uuid) }` → `{ token, visitorId, expiresAt }`. Errors: 400 `AGE_NOT_CONFIRMED`, 409 `TOS_OUTDATED` (+`tosVersion`), 403 `TURNSTILE_FAILED`, 503 `SERVICE_UNAVAILABLE` (Cloudflare unreachable), 403 `BANNED` (+`expiresAt`, HARD bans only) |
| GET | `/v1/turn-credentials` | Bearer | 30/min per visitor | `{ iceServers: [{ urls: STUN_URLS }, { urls: [turn:H:P?transport=udp, …tcp], username: '<expiryUnix>:<visitorId>', credential: base64(HMAC-SHA1(TURN_SECRET, username)) }], ttlSeconds }`, `cache-control: no-store` |
| GET | `/v1/stats/online` | — | — | `{ online }` = Σ `presence:node:<id>` over `presence:nodes` (expired nodes count 0); cached 2 s in memory, `cache-control: public, max-age=2` |

Cross-cutting: body limit 64 KB (413 `PAYLOAD_TOO_LARGE`), 404 `NOT_FOUND`, helmet headers, CORS allowlist (`CORS_ORIGINS`; requests without `Origin` allowed; methods GET/POST/OPTIONS; headers authorization, content-type; exposes x-request-id, retry-after), 429 `RATE_LIMITED` with `retry-after`.

### Visitor auth design (Part 3)
- `POST /v1/session` order: age flag → ToS version → Turnstile → hash deviceId (lowercased) and IP with HMAC-SHA256 peppers → upsert `Visitor` by `deviceIdHash` (retry once on P2002 race) → ban check → issue JWT.
- Ban check (`services/bans.ts`): reads `ban:visitor|device|ip:*`; if all three are cached it decides from Redis, otherwise one Postgres query for active bans (`revokedAt` null, not expired) on any identifier and re-caches each identifier. Most severe wins (HARD > SHADOW, permanent > later expiry). HARD → 403 `BANNED` with `expiresAt`; SHADOW → normal token (the gateway puts them in the shadow pool without telling them). Redis errors fall back to Postgres.
- JWT (`@app/shared/visitor-token`, jose): HS256, claims `sub`=visitorId, `jti` (UUID), `iss`=`randomchat-api`, `aud`=`randomchat`, `iat`, `exp` (`JWT_TTL_SECONDS`). Verification pins the algorithm, issuer and audience; errors are `expired` vs `invalid`.
- Auth plugin: `onRequest: [app.authenticate]` → `request.visitor = { id }`; 401 `UNAUTHORIZED` (missing header), 401 `TOKEN_INVALID` (malformed/tampered/wrong key/claims), 401 `TOKEN_EXPIRED` (client should start a new session).
- The web app (Part 6) keeps the token in memory + `sessionStorage` (not localStorage, not a cookie) and sends it as `Authorization: Bearer` for REST and in the Socket.io handshake `auth.token` (Part 4).
- Turnstile (`services/turnstile.ts`): POST to Cloudflare siteverify with `secret`, `response`, `idempotency_key`; the visitor IP (`remoteip`) is deliberately **not** sent. Network/HTTP/shape failures → `TurnstileUnavailableError` → 503 (never treated as a pass).

## 13. Socket events (implemented)

Contract: `packages/shared/src/socket/` (names, Zod schemas, types). Acks: `{ ok: true, data? } | { ok: false, error: { code, message } }`.

| Direction | Event | Status | Notes |
|---|---|---|---|
| C→S | `ping` | ✅ | ack `{ ok: true, data: { serverTime } }` (ms epoch) |
| C→S | `queue:join` | ✅ | idle only (`INVALID_STATE` otherwise); interests normalized; emits `queue:waiting` or `match:found` |
| C→S | `queue:leave` | ✅ | waiting only (`INVALID_STATE` otherwise) |
| C→S | `chat:next` / `chat:end` | ✅ | current `sessionId` only (`NOT_IN_SESSION` otherwise); next = leave (SKIP) + requeue with the socket's last preferences; end = leave (STOP) → idle |
| C→S | `chat:message` | ✅ | ack `{ ok: true, data: { id, at } }`; `NOT_IN_SESSION` for stale/ended sessions |
| C→S | `chat:typing` | ✅ | relayed on change, repeats ≤ 1 per 2 s |
| C→S | `rtc:offer` / `rtc:answer` / `rtc:ice` | ✅ | video sessions only (`INVALID_STATE`), `to` must be an active other participant (`FORBIDDEN`) |
| C→S | `rtc:summary` | ✅ (log only) | membership-checked, logged; aggregation in Part 7 |
| C→S | `moderation:signal` | 🟨 stub | validated, ack `NOT_IMPLEMENTED` (Part 8) |
| C→S | any other event | ✅ | ack `VALIDATION_FAILED "Unknown event"` + abuse strike |
| S→C | `system:notice` | ✅ `SESSION_REPLACED`, `SERVER_RESTARTING`, `RATE_LIMITED` | `BANNED`, `MESSAGE_BLOCKED` codes defined, used from Part 5/8 |
| S→C | `queue:waiting`, `match:found`, `chat:message`, `chat:typing`, `rtc:offer`, `rtc:answer`, `rtc:ice`, `peer:left` | ✅ | always delivered via `visitor:<id>` rooms (cross-node) |
| S→C | `participant:joined` | ⬜ typed only | Part 11 |
| handshake | `connect_error` | ✅ | `data.code`: `UNAUTHORIZED`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `BANNED` (+`expiresAt`), `SERVER_RESTARTING`, `SERVICE_UNAVAILABLE`; bad Origin → plain websocket error |

Payload limits (schemas): sessionId UUID; participantId `[A-Za-z0-9_-]{8,32}`; chat text ≤ 500 after trim; clientMsgId ≤ 64; SDP ≤ 16 KB (`MAX_SDP_BYTES`); ICE candidate string ≤ 1024 (`MAX_ICE_CANDIDATE_LENGTH`); rtc:summary metrics bounded, candidate types host/srflx/prflx/relay/unknown; moderation:signal `kind` `[a-z_]{1,32}`, score 0–1; whole message ≤ 32 KB (`maxHttpBufferSize`).

## 14. Decisions log (ADR-lite)

| ID | Date | Decision | Reason |
|---|---|---|---|
| D-001 | 2026-10-31 | Stack: Next.js, Node.js, TypeScript, PostgreSQL + Prisma, Socket.io, Redis, BullMQ, coturn, MinIO | One language end-to-end, shared types, fast iteration for a small team |
| D-002 | 2026-10-31 | pnpm + Turborepo monorepo; internal packages export TS source | Shared contracts between client and server; simple builds |
| D-003 | 2026-10-31 | Text chat relayed through the gateway (not WebRTC DataChannel) | Enables filtering, rate limiting and report evidence |
| D-004 | 2026-10-31 | Video P2P via WebRTC with coturn fallback; optional forced-relay mode | P2P is cheapest; relay mode hides user IPs at higher cost |
| D-005 | 2026-10-31 | Matchmaking = atomic Redis Lua scripts inside the gateway; keys hash-tagged per `{pool:mode:lang}` | Correct under concurrency, cluster-ready, no extra service in dev |
| D-006 | 2026-10-31 | Sharded Socket.io Redis adapter; deliver via `visitor:<id>` rooms; `gw:control` channel for cross-node control | Avoids broadcast fan-out of the classic adapter at scale |
| D-007 | 2026-10-31 | Prisma/Postgres kept off the real-time hot path (async writes via BullMQ) | Latency and DB connection limits |
| D-008 | 2026-10-31 | Anonymous visitors (JWT) identified by HMAC of a device id; IPs stored only as HMAC hashes | Privacy + ban persistence |
| D-009 | 2026-10-31 | No chat/video persistence except Redis transcript ring buffer (TTL) and report/auto-flag evidence | Privacy and legal risk reduction |
| D-010 | 2026-10-31 | Sessions are modeled as a **participant list** (per-session `participantId`, `SessionParticipant` table, signals addressed `to`/`from` a participant, one `PeerSession` per remote participant inside a `CallManager`) — never fixed `a`/`b` | Planned 3-person calls (Part 11) must not require a rewrite; also avoids leaking visitor IDs to other users |
| D-011 | 2026-10-31 | **Superseded by D-050.** 3-person calls will use a P2P mesh; an SFU (LiveKit or mediasoup, not Janus) only for 4+ participants, recording or server-side video moderation (`topology` field reserved in `match:found`) | Mesh is fine for 3; SFU routes 100% of media through servers (5–10× bandwidth cost) |
| D-012 | 2026-10-31 | Single root `.env` for all services, loaded by `@app/env` (walks up to `pnpm-workspace.yaml`, Node `util.parseEnv`, real env wins) and by Compose via `--env-file .env` | One place to configure dev; no dotenv dependency; CI/containers override via real env |
| D-013 | 2026-10-31 | Pin TypeScript to **6.0.x** although 7.0 is "latest" | typescript-eslint 8.72 requires TS `<6.1.0`; TS 7 (native Go port) exposes no classic compiler API yet. Revisit when typescript-eslint supports TS 7 |
| D-014 | 2026-10-31 | MinIO images from the community fork `pgsty/minio` / `pgsty/mc`, pinned to release tags | Upstream `minio/minio` and `minio/mc` images are no longer published on Docker Hub or quay.io; the fork keeps the same S3 API and full console. Any S3-compatible store works since apps only use the S3 API |
| D-015 | 2026-10-31 | Relative imports use `.ts` extensions; `erasableSyntaxOnly` on; error codes as `as const` objects (no TS enums) | Works unchanged in tsx, tsup, Vitest, Next.js and Node's native type stripping |
| D-016 | 2026-10-31 | Shared dependency versions via pnpm `catalog:`; honour pnpm's minimum-release-age guard | One version per tool across packages; avoid installing releases younger than the guard window |
| D-017 | 2026-10-31 | Docker Postgres/Redis/MinIO bound to 127.0.0.1; coturn on all interfaces; Postgres host port configurable (`POSTGRES_PORT`) | Don't expose dev data stores on the LAN; TURN must be reachable for LAN device testing; native Postgres installs often own 5432 |
| D-018 | 2026-10-31 | Frontend UI built from 21st.dev components (via the `21st` MCP), adapted into a shared shadcn-style `packages/ui` used by web and admin; components are presentational, security-reviewed, self-hosted assets only, provenance + license recorded | Faster, more polished UI with one consistent kit across apps, without giving up security (CSP), accessibility or control over logic |
| D-019 | 2026-10-31 | `createRedis` forces RESP2 (`protocol: 2`) although ioredis 6 defaults to RESP3 | Reply shapes and subscriber-connection behaviour stay what the Socket.io Redis adapter (Part 4) and our Lua scripts (Part 5) expect; revisit once both are verified on RESP3 |
| D-020 | 2026-10-31 | Prisma pinned to exactly **7.10.1** (CLI + client + adapter), not npm `latest` | npm `latest` for the CLI pointed at `8.0.0-rc.29` while the client's `latest` was 7.10.1; CLI and runtime must match |
| D-021 | 2026-10-31 | DB integrity rules Prisma can't express are CHECK constraints in migration SQL (ban target, evidence owner, 64-hex hashes, lowercase admin email, ranges), plus code checks where callers need typed errors | Defense in depth: a bug can't store a raw IP/device id or an untargeted ban |
| D-022 | 2026-10-31 | `Report.sessionId` has no FK to `ChatSessionLog`; other visitor/admin references are real FKs | Session logs are written asynchronously by the worker (D-007), so a report can arrive first |
| D-023 | 2026-10-31 | Added `REDIS_URL_TEST` (DB 15) for Redis integration tests, mirroring `DATABASE_URL_TEST`; `gw:control` helpers take an optional channel for tests | Tests FLUSHDB, so they need their own DB; pub/sub ignores DB index, so tests must not publish on the real channel |
| D-024 | 2026-10-31 | Visitor JWT kept in memory + `sessionStorage` on the client and sent as `Authorization: Bearer` (REST) and Socket.io handshake `auth.token`; no cookies for visitors | No CSRF surface for visitor endpoints; a tab-scoped session suits anonymous chat; 12 h expiry limits theft impact |
| D-025 | 2026-10-31 | Dev uses Cloudflare's always-pass Turnstile **test keys** but still makes the real siteverify call; `remoteip` is not sent; Cloudflare outages return 503 instead of passing | Same code path in dev and prod; less personal data shared; fail closed on bot protection |
| D-026 | 2026-10-31 | Ban cache stores negative results too (`{ banned: false }`, 60 s) and positive ones up to expiry (max 1 h); ban/revoke writers (Parts 8/9) must overwrite the cache keys and publish `ban_applied` | Avoids a Postgres query on every session/connection while keeping new bans effective immediately when written through the proper path |
| D-027 | 2026-10-31 | API rate limits fail open when Redis is unavailable (`skipOnError`) | Turnstile still gates session creation; refusing every request during a Redis blip is worse |
| D-028 | 2026-10-31 | `TRUST_PROXY` accepts only a hop count or proxy IP/CIDR list, never `true`; request ids are server-generated | Trusting every X-Forwarded-For would let clients spoof IPs past IP rate limits/bans; client-chosen request ids could pollute log correlation |
| D-029 | 2026-10-31 | Visitor-token issue/verify lives in `@app/shared/visitor-token` (server-only subpath, jose) | API issues and gateway verifies with identical claims/algorithm checks — one implementation |
| D-030 | 2026-10-31 | New `ErrorCode`s: `TOKEN_EXPIRED`, `TOKEN_INVALID`, `PAYLOAD_TOO_LARGE`, `SERVICE_UNAVAILABLE` | Clients must tell "start a new session" (expired) from other auth failures |
| D-031 | 2026-10-31 | Sharded Socket.io adapter uses **node-redis** (`redis` 6.x) clients; ioredis stays the app client | The adapter documents node-redis ≥ 4.6 for `createShardedAdapter`; it cannot use ioredis with Redis Cluster (ioredis#1759), and production will be Cluster |
| D-032 | 2026-10-31 | "Last connection wins" is decided by a Redis key `visitor:<id>:socket`, not by `kick_visitor` message order; new key builder `visitorSocketKey` | Two connections racing on different nodes would otherwise kick each other; the key gives one winner |
| D-033 | 2026-10-31 | Socket handlers wait for the socket's registration (room join) via `markSocketReady` | With the sharded adapter the room join is async (per-room channel subscription); without waiting, replies to the visitor room could be lost right after connect |
| D-034 | 2026-10-31 | Invalid socket payloads use `VALIDATION_FAILED` (same code as REST), not the spec's `VALIDATION_ERROR`; new code `NOT_IMPLEMENTED` for Part 4 stubs | One error vocabulary across REST and sockets |
| D-035 | 2026-10-31 | Ban checking moved to `@app/moderation` (`createBanChecker`), identifiers optional; the gateway checks visitor id + IP hash only (device bans are enforced when the API issues the session token) | One implementation for API and gateway; the gateway has no device id |
| D-036 | 2026-10-31 | WebSocket Origin allowlist via `allowRequest`; connections without `Origin` allowed (still need a JWT) | Browsers always send Origin, so cross-site WebSocket hijacking is blocked; bots/tests/native clients work |
| D-037 | 2026-10-31 | Per-socket in-memory token bucket (20 burst, 5/s) + abuse bucket (30 strikes, 0.5/s) instead of Redis-backed socket rate limits | Socket events are per-connection and hot-path; no Redis round trip per event. Cross-connection abuse is bounded by API session rate limits and one-socket-per-visitor |
| D-038 | 2026-10-31 | **Cross-node socket state is derived from Redis** on every lifecycle event (`visitor:<id>:session` → in_session, `visitor:<id>:ticket` → waiting, else idle); no `gw:control` message for matches | A match made on node B is visible on node A instantly with no extra messages or local state to reconcile; costs 1–2 Redis GETs per lifecycle event |
| D-039 | 2026-10-31 | The matching script stamps a pre-generated `sessionId` on both tickets; a cancel that lost the race gets that id back and leaves the session once it exists | Closes the "leave/disconnect while being matched" race without cross-slot transactions |
| D-040 | 2026-10-31 | Queue scans **drop** dead refs but only **skip** recent-pair candidates (deviation from the master text, which says drop) | Dropping a recent-pair entry would erase a waiting stranger's place in line for everyone else |
| D-041 | 2026-10-31 | `visitor:<id>:session` holds JSON `{ sessionId, participantId }`; the leaving caller clears other participants' refs **before** emitting `peer:left` | Handlers need the sender's participantId; clients may requeue immediately on `peer:left` |
| D-042 | 2026-10-31 | Reconnect never resumes a session: a new socket abandons the visitor's previous ticket/session (DISCONNECT); old sockets skip clean-up when they no longer own `visitor:<id>:socket` | Simple, race-free semantics with one socket per visitor |
| D-043 | 2026-10-31 | Interests are normalized by stripping (whitespace/underscore → `-`, other non-alphanumerics removed, Unicode letters kept) instead of rejected | Matches the Part 5 spec; "Indie Games" and "indie_games!" share a queue |
| D-044 | 2026-10-31 | BullMQ queues use prefix `{bull}` and `jobId = sessionId`; the worker upserts and skips participants whose visitor row is missing | Cluster-safe keys, idempotent retries/duplicates, a deleted visitor can't wedge a job |
| D-045 | 2026-10-31 | `msgpackr-extract` (BullMQ → msgpackr) install script denied in `allowBuilds` | Its prebuilt native binary ships as a platform package; the script only compiles from source |
| D-046 | 2026-10-31 | **Sessions survive signaling disconnects:** socket disconnect → participant `reconnecting` for `RECONNECT_GRACE_MS` (15 s); `session:resume` on any node restores it (with missed text messages); gateway shutdown never ends sessions. **Supersedes D-042** (Part 5 abandons the session on reconnect) | Media is P2P, so a deploy or gateway crash must not drop live calls (learned from the Harkirat Omegle stream: "even if the server crashes, they can still talk") |
| D-047 | 2026-10-31 | Match acknowledgement: participants start `pending`, must send `match:ack` within `MATCH_ACK_TIMEOUT_MS` (5 s); client pauses searching after 60 s hidden while waiting. Ack/grace deadlines live in a Redis ZSET `session:deadlines`, claimed with `ZREM` by any node | Ghost/background tabs waste real users' matches; deadlines in Redis survive node restarts and are processed exactly once |
| D-048 | 2026-10-31 | Fair requeue: early failures (within `EARLY_FAILURE_WINDOW_MS`, 10 s) caused by the peer requeue the innocent participant at the **head** of the queue (`enqueueOrMatch` `{ priority: true }`); normal skips requeue normally | A user shouldn't lose their place because the stranger ghosted or WebRTC failed |
| D-049 | 2026-10-31 | Video: `queue:join` only after camera/mic granted (pre-join screen). WebRTC lifecycle rules: no `RTCPeerConnection`/streams in React state, handlers attached right after construction, no `setTimeout`/`getTransceivers()` workarounds; one connection with perfect negotiation (not two connections per user) | Prevents matching people who can't send video and the `ontrack` bugs seen in the stream; two connections per user would double ICE/DTLS handshakes and TURN relay cost |
| D-050 | 2026-10-31 | **Group calls (3–4 people) use Janus VideoRoom**; 2-person calls stay P2P. A call switches `mesh → sfu` make-before-break when a group is formed (after everyone consents, before seeking) and never switches back. Max 4 participants. Built in Part 11 (Janus + orchestration) and Part 12 (adding people). Supersedes D-011 | A 4-person P2P mesh means 3 encodes/uploads per browser over 6 connections — unreliable on phones; Janus is proven and efficient. Chosen over LiveKit/mediasoup by the user; we build the node registry, placement, health checks and failover ourselves |
| D-051 | 2026-10-31 | Janus security: browsers never reach the admin API; rooms are created only by the gateway (`admin_key`); joining needs a Janus **signed token** (10 min, VideoRoom only) **and** membership in the room's `allowed` list; publisher `display` = opaque `participantId`, feeds not in the session are ignored | Strangers must not be able to join or enumerate rooms; no visitor ids leak via Janus |
| D-052 | 2026-10-31 | **Queue buckets:** each matchmaking family `(region, pool, mode, lang)` is split into `bucketCount` buckets, each with its own hash tag (`{mm:<region>:<pool>:<mode>:<lang>:<bucket>}`); join uses power-of-two-choices (prefer a bucket with someone waiting); waiting tickets hop buckets every `MM_BUCKET_HOP_MS` with priority and original `createdAt`. Interests and recent-pair avoidance are per bucket. `region` added to the tag for future multi-region | A single queue key pins all matching for a popular family (e.g. video:en, ~15k matches/s at 1M users) to one Redis core; buckets spread it across shards while hopping prevents stranded users |
| D-053 | 2026-10-31 | Hot-key sharding: `session:deadlines:{<shard>}` (`DEADLINE_SHARDS`) and `stats:matches:<minute>:<n>` (`STATS_COUNTER_SHARDS`) | One global deadline ZSET / counter would take ~50k ops/s on a single key at 1M users |
| D-054 | 2026-10-31 | **Risk-based frame sampling** (Part 8): server assigns `match:found.moderation.frameIntervalMs` per participant by tier (high / new / normal / trusted), a global `MOD_FRAME_BUDGET_PER_SEC` budget stretches low tiers first, uploads faster than assigned are rejected, missing uploads are penalised | Sampling every video user every 30 s ≈ 23k images/s at 1M users (GPU fleet); risk-based sampling keeps coverage where abuse is likely at a fraction of the cost |
| D-055 | 2026-10-31 | Deferred to the production plan (listed in Part 10's `docs/PRODUCTION_CHECKLIST.md`): session analytics via Redis Streams/Kafka → ClickHouse (off Postgres, sharded BullMQ), multi-region deployment, Redis Cluster sizing, and distributed scale validation to 1M (100+ bot machines, WebRTC media load, failure drills) | Infrastructure work, not code-structure changes; the code is already prepared (region in keys, hash tags, stateless services) |

## 15. Known issues / TODOs / production gaps

- `pnpm build` builds `apps/api` (tsup); internal packages intentionally have no build step. Because `@app/*` code is bundled into the app while npm deps stay external, every npm package used by a bundled workspace package (pino, pino-pretty, ioredis, zod, jose, @prisma/client, @prisma/adapter-pg) must also be listed in the app's own `dependencies`.
- A ban created directly in Postgres (seed, SQL, Prisma Studio) takes up to 60 s to apply to visitors whose "not banned" result is cached; Parts 8/9 must write bans through code that updates `ban:*` keys.
- `/v1/turn-credentials` does not re-check bans (a token issued before a ban keeps working for TURN until it expires); the gateway (Part 4) is where active sessions are cut off.
- `Visitor.country` stays null (no GeoIP yet; in production use the CDN's country header).
- Turnstile `hostname`/`action` from siteverify are not checked yet (add when the web app has a fixed hostname, Part 6/10).
- `/v1/session` needs internet access in dev (real siteverify call with the test secret).
- `@app/db` and `@app/redis` tests are integration tests: they need `pnpm infra:up` first. turbo caches test results by file hashes, so a cached pass does not prove the DB/Redis are up (`pnpm test --force` to rerun).
- Importing `@app/db` validates `DATABASE_URL` at import time (singleton). Tests and scripts that target another DB use `createPrismaClient` from the package internals instead.
- ESLint pinned below 10.14.0 for now only because 10.14.0 was younger than pnpm's minimum release age at install time; `pnpm update` will pick it up later.
- `docker compose up -d --wait` without the service list fails on the exited `minio-init` one-shot container — always use `pnpm infra:up`.
- Turborepo collects anonymous telemetry by default; opt out with `pnpm exec turbo telemetry disable` if desired.
- **Crashed gateway node:** its visitors' waiting tickets stay matchable until presence expires (15 s) and the sweeper runs (≤ 30 s); a live visitor matched with such a ghost sees a silent partner and must skip. Consider a liveness check before `match:found` (Part 10).
- `rtc:summary` is only logged; `moderation:signal` is still a stub (Parts 7/8).
- The participant who stays until a session ends is stored with `leaveReason = null` (the DB enum has no "peer left" value).
- Queue refs to tickets deleted by the sweeper are removed lazily by later scans of that queue; very rarely used interest queues can keep a few dead ids.
- A natural disconnect racing a reconnect of the same visitor on another node could, in a tiny window, clean up the new connection's fresh ticket; the client would simply requeue.
- The bot run needs `RATE_LIMIT_DISABLED=true` on the API for > 10 clients (session rate limit 10/min per IP).
- Gateway: a device ban created while a visitor is connected does not disconnect them yet (the gateway doesn't know device hashes); Part 8's ban writer must resolve affected visitor ids and publish `ban_applied`/`kick_visitor`. The `ban_applied` message is defined but not handled by the gateway yet.
- Gateway drain always waits up to 10 s if clients don't reconnect elsewhere (e.g. single-URL bots); the web client (Part 6) should reconnect on `SERVER_RESTARTING`.
- **Part 5 follow-up required (plan updates D-046…D-049 and D-052…D-053):** Part 5 was built before these changes. It must still implement:
  - Session resilience (master prompt → Reference Design → Session resilience): reconnect grace + `session:resume`, `match:ack` + ack deadlines, the deadline processor, priority requeue, and a shutdown hook that does **not** end sessions (supersedes D-042).
  - Scale fixes (Reference Design → Queue buckets, Redis key schema): matchmaking tag `{mm:<region>:<pool>:<mode>:<lang>:<bucket>}`, bucket choice + hopping, `MM_*` env vars; deadlines in sharded `session:deadlines:{<shard>}`; match counter sharded as `stats:matches:<minute>:<n>` (API `/v1/stats` sums shards if it reads it).
  - Run it with: `Apply the Part 5 follow-up (Session resilience D-046…D-049 + scale fixes D-052…D-053) — read CONTEXT.md and the master prompt's Part 5 and Reference Design.`
- `turbo dev` (root `pnpm dev`) runs a single gateway node; use `pnpm --filter @app/gateway dev:multi` for two.
- Killing only the child of `tsx watch` (e.g. by port) leaves the `tsx watch` parent alive; stop dev servers with Ctrl-C in their terminal.
- Production-only items (tracked fully in `docs/PRODUCTION_CHECKLIST.md` from Part 10): legal review, age-assurance vendor, CSAM hash matching + NCMEC reporting process, human moderation staffing, bare-metal TURN with `denied-peer-ip`, Kubernetes, Redis Cluster, PgBouncer, multi-region, CDN/WAF/DDoS.

## 16. Changelog

| Date | Part | Summary |
|---|---|---|
| 2026-10-31 | 0 | Created `MASTER_IMPLEMENTATION_PROMPT.md`, `CONTEXT.md`, `CLAUDE.md`. No code yet. |
| 2026-10-31 | 0 | Plan made participant-based (D-010, D-011): updated socket contract, Redis session keys, `SessionParticipant` model, gateway/WebRTC design; added optional Part 11 (3rd random participant). |
| 2026-10-31 | 1 | Monorepo foundation: git, pnpm 12 + turbo 2 workspace with version catalog; `@app/config` (TS 6 strict configs, type-aware ESLint flat config, Prettier), `@app/env` (createEnv + root .env loader), `@app/logger` (pino + redaction), `@app/shared` (constants, ErrorCode, Zod schemas); Docker infra (Postgres 18, Redis 8.10, coturn 4.18, MinIO fork + bucket init); `.env.example`, README. 17 unit tests. Added `POSTGRES_PORT`, `TURN_EXTERNAL_IP`; decisions D-012…D-017. |
| 2026-10-31 | — | Plan update: frontend UI to use 21st.dev components via the `21st` MCP in a shared `packages/ui` (D-018). Master prompt: new Reference Design section "Frontend UI components (21st.dev)", Parts 6–9 updated. Added `.mcp.json` (21st server, key via `API_KEY_21ST`). |
| 2026-10-31 | 2 | Database & shared server packages: `@app/db` (Prisma 7.10.1 schema with 9 models + 10 enums, init migration with CHECK constraints, adapter-pg client factory + globalThis singleton, idempotent seed with argon2id dev admin), `@app/redis` (createRedis on RESP2, every Reference Design key builder, Zod JSON helpers, typed `gw:control` pub/sub, ban cache schema), `@app/shared/crypto` (`hmacHash`), env schemas for db/redis/seed. Root `db:*` scripts, turbo `generate` task, `REDIS_URL_TEST`. Tests: 42 (incl. Postgres + Redis integration). Decisions D-019…D-023. Kept the concurrent plan update (D-018, `.mcp.json`). |
| 2026-10-31 | 3 | REST API (`apps/api`, Fastify 5): `buildApp(deps)` with Zod type provider, CORS allowlist, helmet, Redis rate limits, error envelope + request ids, auth plugin; routes `/health`, `/ready`, `/v1/config`, `/v1/session` (Turnstile, ToS/age, hashed device/IP, visitor upsert, cached ban check, JWT), `/v1/turn-credentials` (coturn REST creds, verified against live coturn), `/v1/stats/online`; graceful shutdown; tsup build. Added `apiEnv`, `@app/shared/visitor-token`, ban cache negative entries, 4 error codes, `API_HOST`, `TRUST_PROXY`, turbo `migrate:test` task. Tests: 72 total (22 API). Decisions D-024…D-030. |
| 2026-10-31 | 4 | Real-time gateway (`apps/gateway`): typed socket contract in `@app/shared/socket` (names, Zod schemas both directions, event maps with compile-time key check), Socket.io 4.8 on node:http with `/health` `/ready`, sharded Redis adapter (node-redis), Origin allowlist, JWT + ban handshake, one-socket-per-visitor across nodes via `visitor:<id>:socket` + `gw:control`, `registerHandler` (Zod, token bucket, abuse disconnect, always-ack), presence, graceful drain with `onShutdown` hooks, `ping` + `NOT_IMPLEMENTED` stubs, `dev:multi`. New `@app/moderation` (ban checker moved from API), `tools/bots` `connect`, `gatewayEnv`, `GATEWAY_HOST`, `NOT_IMPLEMENTED` code. Verified live: 2 nodes, `/v1/stats/online` = 3 + 2, graceful drain. Tests: 94 total (13 gateway incl. cross-node kick + adapter delivery). Decisions D-031…D-037. |
| 2026-10-31 | — | Plan update from reviewing the Harkirat Omegle-clone stream: new Reference Design section "Session resilience" (reconnect grace + `session:resume`, `match:ack`, `session:deadlines`, priority requeue, video pre-join); new events `match:ack`, `session:resume`, `peer:reconnecting`, `peer:resumed`; env `RECONNECT_GRACE_MS`, `MATCH_ACK_TIMEOUT_MS`, `EARLY_FAILURE_WINDOW_MS`; Parts 5, 6, 7, 10 updated; WebRTC lifecycle rules in Part 7. Decisions D-046…D-049. |
| 2026-10-31 | 5 | Matchmaking & sessions: `@app/matchmaking` (Lua enqueue/match/promote/cancel/sweep, bounded scans, recent-pair skip), gateway lifecycle (Redis-derived state, per-visitor locks, session create + atomic idempotent leave Lua, interest fallback timers, match/cancel race handling, reconnect reconcile, sweeper, shutdown hook), real handlers for queue/chat/rtc events, transcript ring buffer, `apps/worker` (BullMQ `session-log` → ChatSessionLog/SessionParticipant), `@app/shared/jobs`, bots load CLI. Bot acceptance (50 clients, 2 min, 2 nodes): 2 342 sessions, 0 asymmetric, 0 protocol errors, 8 202 messages all delivered, TTM p50 13 ms / p95 2.5 s; worker persisted every session. Tests: 120 total (13 matchmaking, 23 gateway, 3 worker). New: `INVALID_STATE`, `WORKER_CONCURRENCY`. Decisions D-038…D-045. |
| 2026-10-31 | — | Plan update: group video calls of up to 4 people via **Janus**. Master prompt: new Part 11 (Janus SFU, `packages/sfu`, node registry, P2P → SFU upgrade, failover) and Part 12 (add 3rd/4th person: consent, seek matching, 4-tile UI); Reference Design gains topologies `mesh`/`sfu`, events `call:topology`/`call:topologyReady`, `match:found.sfu`, `sfu:*` keys, Janus ports/env; Part 7 `CallManager` gets a transport interface. Decisions D-050, D-051 (D-011 superseded). Resilience decisions renumbered D-046…D-049 (had collided with Part 5's D-038…D-041). |
| 2026-10-31 | — | Scale review for 1M concurrent users: queue buckets with hopping + region in matchmaking keys (D-052), sharded deadlines and match counters (D-053), risk-based frame sampling with a global budget (D-054), production-plan items for session analytics, multi-region and 1M validation (D-055). Master prompt: Reference Design (key schema, new "Queue buckets" section, env vars, `match:found.moderation`), Parts 5, 8, 10 updated. Part 5 follow-up note extended. |

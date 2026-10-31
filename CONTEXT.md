# CONTEXT.md — Living Project Context

> **Agents:** read this file fully before any work, and update it before finishing any task that changes code, config or decisions (see `CLAUDE.md`). Keep it factual and concise; it is the only memory carried between sessions. Replace "TBD" entries as they become real — do not leave stale information.

---

## 1. Snapshot

| Item | Value |
|---|---|
| Project | RandomChat (working title) — random 1:1 text & video chat platform |
| Phase | Development build (local only) |
| Implementation plan | `MASTER_IMPLEMENTATION_PROMPT.md` (10 parts + optional future Part 11, executed one at a time) |
| Planned future feature | Add a 3rd random person to a running video call (Part 11) — Parts 1–10 must stay participant-list based |
| Current status | Parts 1–2 done — **next: Part 3** (REST API service) |
| Last updated | 2026-10-31 |

## 2. Progress tracker

| Part | Title | Status | Date | Notes |
|---|---|---|---|---|
| 1 | Monorepo foundation & local infrastructure | ✅ Done | 2026-10-31 | Postgres host port configurable (`POSTGRES_PORT`); MinIO via community fork image (D-014) |
| 2 | Database & shared server packages | ✅ Done | 2026-10-31 | Prisma 7.10.1 (driver adapter), CHECK constraints in migration SQL, ioredis 6 pinned to RESP2 (D-019) |
| 3 | REST API service | ⬜ Not started | | |
| 4 | Real-time gateway core | ⬜ Not started | | |
| 5 | Matchmaking & chat session lifecycle | ⬜ Not started | | |
| 6 | Web app & text chat | ⬜ Not started | | |
| 7 | Video chat (WebRTC) | ⬜ Not started | | |
| 8 | Trust & safety | ⬜ Not started | | |
| 9 | Admin & moderation dashboard | ⬜ Not started | | |
| 10 | Hardening, observability, testing & DX | ⬜ Not started | | |
| 11 | *(Future, optional)* Add a 3rd random participant | ⬜ Not started | | Only after 1–10 |

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
| REST API | Node.js + Fastify + Zod | TBD |
| Real-time | Socket.io + `@socket.io/redis-adapter` (sharded) | TBD |
| Database | PostgreSQL + Prisma ORM | Postgres 18.6 (image `postgres:18.6-alpine`); Prisma **7.10.1** (`prisma-client` generator, `@prisma/adapter-pg` driver adapter, pinned exactly — D-020) |
| Cache / queues / matchmaking | Redis (≥ 7.2) + ioredis + Lua | Redis 8.10.3 (`redis:8.10.3-alpine`); ioredis **6.0** (RESP2 forced — D-019) |
| Background jobs | BullMQ (`apps/worker`) | TBD |
| Object storage | MinIO (S3-compatible) | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, `pgsty/mc:RELEASE.2026-10-26T00-00-00Z` (D-014) |
| Media | WebRTC (P2P) + coturn (TURN/STUN) | coturn 4.18 (`coturn/coturn:4.18-alpine`) |
| Auth | `jose` JWT (visitors), argon2id + TOTP (admins) | `@node-rs/argon2` 2.2 (argon2id default, used by seed); jose TBD |
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
├─ apps/                  (empty until Part 3; .gitkeep)
├─ packages/
│  ├─ config/             tsconfig.base/node/nextjs.json, eslint.config.base.js (createEslintConfig), prettier.config.js
│  ├─ env/                createEnv(schema), EnvValidationError, root .env loader; schemas: baseEnv, databaseEnv,
│  │                      databaseTestEnv, redisEnv, redisTestEnv, hashPepperEnv, seedEnv
│  ├─ logger/             createLogger({ service, level, nodeEnv, destination }), REDACT_PATHS
│  ├─ shared/             constants.ts, errors.ts (ErrorCode), schemas.ts; crypto.ts = server-only `@app/shared/crypto` (hmacHash)
│  ├─ db/                 prisma.config.ts, prisma/schema.prisma, prisma/migrations/, prisma/seed.ts,
│  │                      src/client.ts (createPrismaClient), src/prisma.ts (singleton), src/ban.ts, src/generated/ (gitignored)
│  └─ redis/              src/client.ts (createRedis), keys.ts (ALL key builders), json.ts (Zod JSON helpers),
│                         control.ts (gw:control pub/sub), bans.ts (ban cache schema), ttl.ts, testing.ts (test Redis)
├─ infra/docker/
│  ├─ docker-compose.yml  project name `randomchat`: postgres, redis, coturn, minio, minio-init
│  ├─ coturn/turnserver.conf
│  ├─ postgres/init/01-create-test-db.sql   (creates app_test on first boot)
│  └─ minio/init.sh, minio/frames-lifecycle.json
├─ tools/                 (empty; .gitkeep)
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
- Integration tests: Postgres `app_test` (`DATABASE_URL_TEST`, migrated by `migrate:test` before each `@app/db` test run) and Redis DB 15 (`REDIS_URL_TEST`; `createTestRedis` refuses DB 0 because tests FLUSHDB). Redis pub/sub is **not** scoped by DB index — tests use a unique channel, never the real `gw:control`.

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
| api | 4000 | TBD | not built |
| gateway | 4001 (+4011) | TBD | not built |
| worker | — | TBD | not built |
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
| DATABASE_URL | `@app/db` (prisma singleton, prisma.config.ts, seed) | Postgres URL (validated: `postgres(ql)://`) | postgresql://app:app@localhost:5432/app |
| DATABASE_URL_TEST | `@app/db` tests, `db:migrate:test` (via `DB_TARGET=test`) | Integration-test DB | postgresql://app:app@localhost:5432/app_test |
| DB_TARGET | `packages/db/prisma.config.ts` | Not in .env: `test` makes Prisma CLI use `DATABASE_URL_TEST` (set by the `migrate:test` script) | unset |
| REDIS_URL | `redisEnv` schema (services from Part 3) | Redis URL (validated: `redis(s)://`) | redis://localhost:6379 |
| REDIS_URL_TEST | `@app/redis` tests (`createTestRedis`) | Integration-test Redis; must select a non-zero DB (new, not in master design) | redis://localhost:6379/15 |
| JWT_SECRET, JWT_TTL_SECONDS | (Part 3) | Visitor JWT | placeholder ≥ 32 chars, 43200 |
| IP_HASH_PEPPER, DEVICE_HASH_PEPPER | seed (`hashPepperEnv`, min 16 chars); API from Part 3 | HMAC peppers — rotating one invalidates all stored hashes (bans by device/IP) | placeholders |
| TOS_VERSION | (Part 3/6) | Accepted ToS version | 2026-10-dev |
| TURNSTILE_SECRET_KEY, NEXT_PUBLIC_TURNSTILE_SITE_KEY | (Part 3/6) | Cloudflare test keys | always-pass test keys |
| TURN_SECRET | docker-compose (coturn `--static-auth-secret`), API later | Shared TURN HMAC secret | placeholder |
| TURN_EXTERNAL_IP | docker-compose (coturn `--external-ip`) | IP in relay candidates (new, not in master design) | 127.0.0.1 |
| TURN_HOST, TURN_PORT, TURN_CREDENTIAL_TTL_SECONDS, STUN_URLS | (Part 3) | TURN/STUN for clients | localhost, 3478, 600, stun:localhost:3478 |
| API_PORT, GATEWAY_PORT, GATEWAY_NODE_ID | (Part 3/4) | Service ports / node id | 4000, 4001, unset → hostname+port |
| CORS_ORIGINS | (Part 3/4) | Allowed origins | http://localhost:3000,http://localhost:3001 |
| NEXT_PUBLIC_API_URL, NEXT_PUBLIC_GATEWAY_URL, NEXT_PUBLIC_FORCE_TURN_RELAY | (Part 6) | Browser config | http://localhost:4000, http://localhost:4001, false |
| S3_ACCESS_KEY, S3_SECRET_KEY | docker-compose (MinIO root user/password, minio-init), API/worker later | MinIO creds (password ≥ 8 chars) | randomchat, placeholder |
| S3_BUCKET_EVIDENCE, S3_BUCKET_FRAMES | docker-compose (minio-init), API/worker later | Bucket names | evidence, frames |
| S3_ENDPOINT, S3_REGION | (Part 8) | S3 client | http://localhost:9000, us-east-1 |
| INTEREST_FALLBACK_MS, RECENT_PAIR_TTL_MS | (Part 5) | Matchmaking timings | 5000, 60000 |
| RATE_LIMIT_DISABLED | (Part 3/4) | Dev-only switch | false |
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
| `{mm:…}:tickets` | HASH | `.tickets` | ticket JSON schema defined in Part 5 |
| `{mm:…}:recent` | ZSET | `.recent`, member `recentPairMember(a, b)` | member `minId\|maxId` |
| `visitor:<id>:ticket` / `visitor:<id>:session` | STRING | `visitorTicketKey`, `visitorSessionKey` | |
| `visitor:<id>` | Socket.io room | `visitorRoom` | not a key; delivery target |
| `session:{<id>}:meta` / `:participants` / `:log` | HASH / HASH / LIST | `sessionKeys(sessionId)` | 1 h TTL after end (`SESSION_ENDED_TTL_SECONDS`); log capped at `TRANSCRIPT_MAX_MESSAGES`=100 |
| `presence:node:<nodeId>` | STRING | `presenceNodeKey` | TTL `PRESENCE_TTL_SECONDS`=15 |
| `presence:nodes` | SET | `PRESENCE_NODES_KEY` | |
| `stats:matches:<yyyyMMddHHmm>` (UTC) | STRING | `statsMatchesKey(date)` | TTL `STATS_MATCHES_TTL_SECONDS`=7200 |
| `ban:visitor:<id>`, `ban:device:<hash>`, `ban:ip:<hash>` | STRING (JSON) | `banVisitorKey`, `banDeviceKey`, `banIpKey` | value `banCacheEntrySchema` `{ banId, type: HARD\|SHADOW, expiresAt: ISO\|null }` |
| `trust:<visitorId>` | STRING | `trustKey` | |
| `rl:<scope>:<subject>` | various | `rateLimitKey(scope, subject)` | scope `[a-z0-9:_-]{1,64}` |
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
| — | — | — | — | _(added from Part 3 onward)_ |

## 13. Socket events (implemented)

| Direction | Event | Status | Notes |
|---|---|---|---|
| — | — | — | _(added from Part 4 onward)_ |

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
| D-011 | 2026-10-31 | 3-person calls will use a P2P mesh; an SFU (LiveKit or mediasoup, not Janus) only for 4+ participants, recording or server-side video moderation (`topology` field reserved in `match:found`) | Mesh is fine for 3; SFU routes 100% of media through servers (5–10× bandwidth cost) |
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

## 15. Known issues / TODOs / production gaps

- `pnpm build` currently runs only `@app/db#generate` (no apps yet); internal packages intentionally have no build step.
- `@app/db` and `@app/redis` tests are integration tests: they need `pnpm infra:up` first. turbo caches test results by file hashes, so a cached pass does not prove the DB/Redis are up (`pnpm test --force` to rerun).
- Importing `@app/db` validates `DATABASE_URL` at import time (singleton). Tests and scripts that target another DB use `createPrismaClient` from the package internals instead.
- ESLint pinned below 10.14.0 for now only because 10.14.0 was younger than pnpm's minimum release age at install time; `pnpm update` will pick it up later.
- `docker compose up -d --wait` without the service list fails on the exited `minio-init` one-shot container — always use `pnpm infra:up`.
- Turborepo collects anonymous telemetry by default; opt out with `pnpm exec turbo telemetry disable` if desired.
- Production-only items (tracked fully in `docs/PRODUCTION_CHECKLIST.md` from Part 10): legal review, age-assurance vendor, CSAM hash matching + NCMEC reporting process, human moderation staffing, bare-metal TURN with `denied-peer-ip`, Kubernetes, Redis Cluster, PgBouncer, multi-region, CDN/WAF/DDoS.

## 16. Changelog

| Date | Part | Summary |
|---|---|---|
| 2026-10-31 | 0 | Created `MASTER_IMPLEMENTATION_PROMPT.md`, `CONTEXT.md`, `CLAUDE.md`. No code yet. |
| 2026-10-31 | 0 | Plan made participant-based (D-010, D-011): updated socket contract, Redis session keys, `SessionParticipant` model, gateway/WebRTC design; added optional Part 11 (3rd random participant). |
| 2026-10-31 | 1 | Monorepo foundation: git, pnpm 12 + turbo 2 workspace with version catalog; `@app/config` (TS 6 strict configs, type-aware ESLint flat config, Prettier), `@app/env` (createEnv + root .env loader), `@app/logger` (pino + redaction), `@app/shared` (constants, ErrorCode, Zod schemas); Docker infra (Postgres 18, Redis 8.10, coturn 4.18, MinIO fork + bucket init); `.env.example`, README. 17 unit tests. Added `POSTGRES_PORT`, `TURN_EXTERNAL_IP`; decisions D-012…D-017. |
| 2026-10-31 | — | Plan update: frontend UI to use 21st.dev components via the `21st` MCP in a shared `packages/ui` (D-018). Master prompt: new Reference Design section "Frontend UI components (21st.dev)", Parts 6–9 updated. Added `.mcp.json` (21st server, key via `API_KEY_21ST`). |
| 2026-10-31 | 2 | Database & shared server packages: `@app/db` (Prisma 7.10.1 schema with 9 models + 10 enums, init migration with CHECK constraints, adapter-pg client factory + globalThis singleton, idempotent seed with argon2id dev admin), `@app/redis` (createRedis on RESP2, every Reference Design key builder, Zod JSON helpers, typed `gw:control` pub/sub, ban cache schema), `@app/shared/crypto` (`hmacHash`), env schemas for db/redis/seed. Root `db:*` scripts, turbo `generate` task, `REDIS_URL_TEST`. Tests: 42 (incl. Postgres + Redis integration). Decisions D-019…D-023. Kept the concurrent plan update (D-018, `.mcp.json`). |

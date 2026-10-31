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
| Current status | Part 1 done — **next: Part 2** (Database & shared server packages) |
| Last updated | 2026-10-31 |

## 2. Progress tracker

| Part | Title | Status | Date | Notes |
|---|---|---|---|---|
| 1 | Monorepo foundation & local infrastructure | ✅ Done | 2026-10-31 | Postgres host port configurable (`POSTGRES_PORT`); MinIO via community fork image (D-014) |
| 2 | Database & shared server packages | ⬜ Not started | | |
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

## 4. Tech stack

| Layer | Choice | Version |
|---|---|---|
| Language | TypeScript (strict, ESM) | **6.0.x** (`~6.0.3`, pinned — see D-013) |
| Monorepo | pnpm workspaces + Turborepo | pnpm 12.16.1, turbo 2.11 |
| Lint / format | ESLint flat config + typescript-eslint + simple-import-sort; Prettier | eslint 10.13, typescript-eslint 8.72, prettier 3.9 |
| Validation | Zod | 4.6 |
| Logging | pino + pino-pretty | pino 10.4, pino-pretty 13.2 |
| Web / Admin | Next.js (App Router) + Tailwind CSS | TBD |
| REST API | Node.js + Fastify + Zod | TBD |
| Real-time | Socket.io + `@socket.io/redis-adapter` (sharded) | TBD |
| Database | PostgreSQL + Prisma ORM | Postgres 18.6 (image `postgres:18.6-alpine`); Prisma TBD |
| Cache / queues / matchmaking | Redis (≥ 7.2) + ioredis + Lua | Redis 8.10.3 (`redis:8.10.3-alpine`); ioredis TBD |
| Background jobs | BullMQ (`apps/worker`) | TBD |
| Object storage | MinIO (S3-compatible) | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, `pgsty/mc:RELEASE.2026-10-26T00-00-00Z` (D-014) |
| Media | WebRTC (P2P) + coturn (TURN/STUN) | coturn 4.18 (`coturn/coturn:4.18-alpine`) |
| Auth | `jose` JWT (visitors), argon2id + TOTP (admins) | TBD |
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
│  ├─ env/                createEnv(schema), EnvValidationError, baseEnv, root .env loader (src/load-env-file.ts)
│  ├─ logger/             createLogger({ service, level, nodeEnv, destination }), REDACT_PATHS
│  └─ shared/             constants.ts, errors.ts (ErrorCode), schemas.ts (chatMode/lang/interest(s)/messageText/errorCode)
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
- `packages/shared` must stay browser-safe (no Node APIs in its main entry); server-only helpers go behind a separate export path (Part 2 `crypto`).

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
| DATABASE_URL / DATABASE_URL_TEST | (Part 2) | Postgres URLs | postgresql://app:app@localhost:5432/app, …/app_test |
| REDIS_URL | (Part 2+) | Redis URL | redis://localhost:6379 |
| JWT_SECRET, JWT_TTL_SECONDS | (Part 3) | Visitor JWT | placeholder ≥ 32 chars, 43200 |
| IP_HASH_PEPPER, DEVICE_HASH_PEPPER | (Part 2/3) | HMAC peppers | placeholders |
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
| SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, ADMIN_SESSION_TTL_SECONDS | (Part 2/9) | Dev admin | admin@randomchat.local, placeholder, 28800 |

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
| `pnpm db:*` | Placeholders that exit 1 until Part 2 |
| `pnpm --filter @app/<pkg> test` | Run one package's tests |

## 10. Data model (implemented)

_Filled in Part 2 — models, key fields, enums, important indexes._

## 11. Redis keys & channels (implemented)

_Filled from Part 2 onward — must match `packages/redis/src/keys.ts`._

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

## 15. Known issues / TODOs / production gaps

- `pnpm build` currently runs no tasks (no apps yet); internal packages intentionally have no build step.
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

# Master Implementation Prompt — Random 1:1 Text & Video Chat Platform (Development Build)

> Working title: **RandomChat** (rename freely). Package scope: `@app/*`.
> Goal of this document: build a **production-shaped, development-first** platform where two random strangers are matched for real-time **text** and **video** chat, using **Next.js, Node.js, TypeScript, PostgreSQL, Prisma, Socket.io, Redis, WebRTC, coturn**.
> Production deployment (multi-region, Kubernetes, bare-metal TURN, age-verification vendors, CSAM hash matching) is **out of scope**, but every part must be designed so it scales out later without rewrites.

---

## How to use this file (for the human)

1. Open Claude Code in this folder.
2. Run one part at a time by pasting the one-line prompt shown at the top of each part, e.g.
   `Execute Part 1 of MASTER_IMPLEMENTATION_PROMPT.md`
3. When the agent finishes, do the **Manual check** listed in that part before moving on.
4. Start a **fresh conversation** (`/clear`) for each part. `CONTEXT.md` carries all project state between parts.
5. If a part fails midway, re-run with: `Continue Part N of MASTER_IMPLEMENTATION_PROMPT.md — read CONTEXT.md for where it stopped.`

| Part | Title | Result |
|---|---|---|
| 1 | Monorepo foundation & local infrastructure | pnpm/Turborepo workspace, shared configs, Docker (Postgres, Redis, coturn, MinIO) |
| 2 | Database & shared server packages | Prisma schema + migrations + seed, Redis/logger/env packages |
| 3 | REST API service | Anonymous sessions (JWT + Turnstile), TURN credentials, health, config |
| 4 | Real-time gateway core | Socket.io server, auth, sharded Redis adapter, validation, rate limits, presence |
| 5 | Matchmaking & chat session lifecycle | Redis Lua matcher, sessions, text relay, signaling relay, worker, bots |
| 6 | Web app & text chat | Next.js UI, age gate, Turnstile, working end-to-end text chat |
| 7 | Video chat (WebRTC) | Camera/mic, perfect negotiation, TURN, ICE restart, quality stats |
| 8 | Trust & safety | Text filter, reports + evidence, client NSFW, frame pipeline, bans, shadow pool, trust score |
| 9 | Admin & moderation dashboard | Admin auth (+TOTP), review queue, evidence viewer, bans, audit log, live stats |
| 10 | Hardening, observability, testing & DX | Security pass, metrics, E2E, load test, Dockerfiles, CI, production checklist |
| 11 | Janus SFU & call topology switch | Janus VideoRoom in Docker, room/token orchestration, node registry, P2P → Janus upgrade mid-call, failover |
| 12 | Group video: add a 3rd and 4th random person | Consent flow, "seek participant" matching, up to 4 people per call via Janus |

---

## GLOBAL RULES (apply to every part — the agent must follow these)

1. **Load context first.** Read `CONTEXT.md` and `CLAUDE.md` completely, then the **Reference Design** section of this file, then the part you were asked to execute. Inspect the repo to confirm `CONTEXT.md` matches reality (e.g. `pnpm install && pnpm typecheck`). If a previous part is incomplete or broken, fix the minimum needed and log it in `CONTEXT.md` before continuing.
2. **Stay in scope.** Implement only the requested part. Do not build features from later parts. If the Reference Design must change, update both this design (via a note in `CONTEXT.md` → Decisions) and the code consistently.
3. **Plan, then build.** Start by writing a short step list for the part, then execute it.
4. **Versions.** Use the latest **stable** versions at install time. For fast-moving libraries (Next.js, Prisma, Tailwind, Socket.io adapters, BullMQ, Turborepo) check the official docs for the current API instead of relying on memory. Record exact major versions in `CONTEXT.md`.
5. **Code standards.**
   - TypeScript `strict` everywhere, ESM, `noUncheckedIndexedAccess`. No `any` (use `unknown` + narrowing).
   - **Zod validation at every boundary**: env vars, HTTP body/query/params, socket payloads, JSON read from Redis, job payloads.
   - Small focused modules, named exports, descriptive names. Comments explain *why*, not *what*.
   - Shared types/constants live in `packages/shared`; never duplicate event names or limits.
6. **Security defaults.**
   - Never trust the client. Server validates identity, session membership and limits for every action.
   - Never log JWTs, passwords, raw IPs, device IDs or chat content — log IDs only.
   - Raw IP addresses and device IDs are stored **only as HMAC-SHA256 hashes** (with peppers from env).
   - Secrets only in `.env` (gitignored). Every new variable is added to `.env.example` with a safe dev default and to the env table in `CONTEXT.md`.
   - Never render user content as HTML.
7. **Privacy.** Chat content and video are never persisted, except (a) a short-lived transcript ring buffer in Redis (TTL) and (b) evidence explicitly attached to a report or an automated safety flag.
8. **Tests.** Vitest for unit/integration tests. Every part lists required tests; they must pass. Integration tests use the Docker Postgres/Redis (separate test database / Redis DB index).
9. **Quality gate (must be green before finishing):**
   `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
   If something cannot pass, explain why in `CONTEXT.md → Known issues`.
10. **Update `CONTEXT.md` (mandatory, last step before committing).** Update: status/progress table, repo layout, services & ports, env vars, commands, data model, Redis keys, socket events, REST endpoints, decisions (new ADR entries), known issues/TODOs, and append a changelog entry. Keep it accurate and concise — it is the next agent's only memory.
11. **Commit.** Ensure no `.env` or secrets are staged, then `git add -A && git commit -m "feat(part-N): <short summary>"`.
12. **Final report to the human:** what was built, exact commands/URLs to verify manually, any deviation from this plan and why, and what the next part is.

---

## REFERENCE DESIGN (canonical — all parts build toward this)

### Architecture (development)

```
 Browser (apps/web :3000)                     Moderator (apps/admin :3001)
   │  HTTPS REST          │ WebSocket (Socket.io)        │ REST (cookie auth)
   ▼                      ▼                              ▼
 apps/api :4000      apps/gateway :4001 (+ :4011 2nd node in tests)
 Fastify + Prisma     Socket.io + matchmaking (Redis Lua) + text/RTC relay
   │      │              │         │
   │      └──── Redis ◄──┘         └── BullMQ jobs ──► apps/worker (session logs, moderation)
   │            (queues, sessions, presence, rate limits, ban cache, pub/sub, adapter)
   ▼
 PostgreSQL (visitors, reports, bans, moderation events, admins, audit log, session metadata)
 MinIO (S3) (report evidence, temporary moderation frames)

 2-person calls:
 Browser ◄═══ WebRTC media (P2P, DTLS-SRTP) ═══► Browser
            └─ fallback relay via coturn :3478 (ephemeral HMAC credentials from API)

 3–4-person calls (Parts 11–12):
 Browser ══► Janus VideoRoom (SFU) ══► other browsers   (each user uploads once; Janus forwards)
             ▲ rooms + join tokens created by the gateway via the Janus admin API (never exposed to browsers)
```

### Repository layout (target)

```
/
├─ apps/
│  ├─ web/           Next.js user app (port 3000)
│  ├─ admin/         Next.js moderator dashboard (port 3001)
│  ├─ api/           Fastify REST API (port 4000)
│  ├─ gateway/       Socket.io gateway: signaling, text relay, matchmaking (port 4001)
│  └─ worker/        BullMQ workers: session logs, moderation jobs
├─ packages/
│  ├─ config/        tsconfig bases, ESLint flat config, Prettier
│  ├─ env/           Zod env loaders per service
│  ├─ shared/        socket event contracts, Zod schemas, constants, error codes
│  ├─ ui/            shared React UI kit (shadcn-style; components sourced from 21st.dev), theme tokens
│  ├─ logger/        pino logger factory
│  ├─ db/            Prisma schema, client singleton, seed
│  ├─ redis/         ioredis factory, central key builders, pub/sub helpers
│  ├─ matchmaking/   Lua scripts + typed TS wrapper
│  ├─ moderation/    text filter, classifier & hash-matcher interfaces, trust rules
│  └─ sfu/           Janus admin client, node registry, room/token orchestration (Part 11)
├─ infra/docker/     docker-compose.yml, coturn config, Janus image + config (Part 11), init scripts, (later) Prometheus/Grafana
├─ tools/bots/       socket bot clients (functional tests, later load tests)
├─ e2e/              Playwright tests
├─ docs/             PRODUCTION_CHECKLIST.md (Part 10)
├─ CONTEXT.md  CLAUDE.md  MASTER_IMPLEMENTATION_PROMPT.md  README.md  .env.example
```

### Frontend UI components (21st.dev) — applies to all UI work (Parts 6–9, 11)

UI components are sourced from **21st.dev** through the `21st` MCP server configured for this project (`.mcp.json` + local config). Rules:

1. **Use the MCP.** Before building any non-trivial UI element, use the `21st` MCP tools (list them to see the current names — e.g. component search/inspiration, component builder, refiner, logo search) to find or generate a fitting component. If the MCP is not available in the session, tell the human, then fall back to shadcn/ui primitives and note it in `CONTEXT.md`.
2. **One shared kit.** 21st.dev components follow shadcn/ui conventions (React, Tailwind, Radix primitives, `cn()` helper). Put reusable components in `packages/ui` (`@app/ui`) with a shadcn-style `components.json`, `cn()` (clsx + tailwind-merge), and theme tokens as CSS variables (light + dark). Apps import from `@app/ui`; app-specific compositions live in the app.
3. **Adapt, don't paste.** Every imported component must: use the project's theme tokens (no hard-coded colors), pass strict TypeScript and lint, be keyboard-accessible with visible focus and correct ARIA, respect `prefers-reduced-motion`, and work at 360 px width.
4. **Presentational only.** Components receive data and callbacks via props. Socket, WebRTC, API and store logic stays in the app's own code.
5. **Security review each component.** No external scripts, fonts, images or CDN URLs (self-host assets; CSP), no `dangerouslySetInnerHTML`, no analytics/tracking, no `eval`, no demo/sample data left in.
6. **Dependencies.** Allowed as needed: Radix primitives, `lucide-react`, `class-variance-authority`, `motion` (animations). Add them to the pnpm `catalog:`. Avoid heavy libraries (3D, large chart kits) on the chat/video screens; decorative animation is for the landing page only, never on hot paths.
7. **Provenance & license.** Add a header comment to each sourced file: `// Source: 21st.dev — <component name / URL>, adapted`. Check the component's license and record name, source and license in `CONTEXT.md` (UI components list).

**Internal package strategy:** workspace packages export TypeScript source (`"exports": { ".": "./src/index.ts" }`). Node apps run with `tsx watch` in dev and are bundled with `tsup` for build (bundle `@app/*` workspace packages). Next.js apps use `transpilePackages`. Single root `.env` for all services in development (load it in each app's scripts, e.g. `dotenv-cli`, and document how).

### Ports (development)

| Service | Port |
|---|---|
| web | 3000 |
| admin | 3001 |
| api | 4000 |
| gateway | 4001 (second instance 4011 for multi-node tests) |
| PostgreSQL | 5432 |
| Redis | 6379 |
| coturn | 3478 udp/tcp, relay range 49160–49200/udp |
| MinIO | 9000 (S3 API), 9001 (console) |
| Janus (Part 11) | 8188 (client WebSocket), 7188 (admin WebSocket — internal only), RTP 20000–20100/udp; second node `janus-2` on 8189 / 7189 / 20200–20300 (profile `sfu-multi`) |
| Prometheus / Grafana (Part 10) | 9090 / 3002 |

### Environment variables (canonical names)

| Variable | Used by | Dev default / note |
|---|---|---|
| `NODE_ENV` | all | `development` |
| `LOG_LEVEL` | all | `debug` |
| `DATABASE_URL` | api, worker, db | `postgresql://app:app@localhost:5432/app` |
| `DATABASE_URL_TEST` | tests | `postgresql://app:app@localhost:5432/app_test` |
| `REDIS_URL` | api, gateway, worker | `redis://localhost:6379` |
| `JWT_SECRET` | api, gateway | ≥ 32 random chars |
| `JWT_TTL_SECONDS` | api | `43200` |
| `IP_HASH_PEPPER`, `DEVICE_HASH_PEPPER` | api, gateway | random strings |
| `TOS_VERSION` | api, web | `2026-10-dev` |
| `TURNSTILE_SECRET_KEY` | api | Cloudflare always-pass test secret `1x0000000000000000000000000000000AA` |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | web | Cloudflare always-pass test site key `1x00000000000000000000AA` |
| `TURN_SECRET` | api, coturn | shared HMAC secret |
| `TURN_HOST`, `TURN_PORT` | api | `localhost`, `3478` |
| `TURN_CREDENTIAL_TTL_SECONDS` | api | `600` |
| `STUN_URLS` | api | `stun:localhost:3478` (comma-separated) |
| `API_PORT`, `GATEWAY_PORT`, `GATEWAY_NODE_ID` | api, gateway | `4000`, `4001`, hostname+port |
| `CORS_ORIGINS` | api, gateway | `http://localhost:3000,http://localhost:3001` |
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_GATEWAY_URL` | web, admin | `http://localhost:4000`, `http://localhost:4001` |
| `NEXT_PUBLIC_FORCE_TURN_RELAY` | web | `false` (true = hide IPs, all media via TURN) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | api, worker | MinIO dev creds |
| `S3_BUCKET_EVIDENCE`, `S3_BUCKET_FRAMES` | api, worker | `evidence`, `frames` |
| `INTEREST_FALLBACK_MS` | gateway | `5000` |
| `RECENT_PAIR_TTL_MS` | gateway | `60000` |
| `RECONNECT_GRACE_MS` | gateway | `15000` |
| `MATCH_ACK_TIMEOUT_MS` | gateway | `5000` |
| `EARLY_FAILURE_WINDOW_MS` | gateway | `10000` |
| `JANUS_NODES` | gateway | JSON list `[{ "id": "janus-1", "wsUrl": "ws://localhost:8188", "adminUrl": "ws://localhost:7188" }]` (Part 11) |
| `JANUS_ADMIN_SECRET` | gateway, Janus | admin API secret + VideoRoom `admin_key` (Part 11) |
| `JANUS_TOKEN_SECRET` | gateway, Janus | HMAC secret for Janus signed tokens (`token_auth_secret`) (Part 11) |
| `JANUS_PUBLIC_IP` | Janus | IP advertised in Janus ICE candidates (`nat_1_1_mapping`); `127.0.0.1` in dev (Part 11) |
| `SFU_PUBLISHER_BITRATE` | gateway | `600000` bps per publisher (Part 11) |
| `SFU_UPGRADE_TIMEOUT_MS` | gateway | `10000` (Part 11) |
| `DEV_FORCE_SFU` | gateway | `false`; development only — every video session uses Janus (Part 11) |
| `GROUP_MIN_TRUST`, `SEEK_PARTICIPANT_TIMEOUT_MS` | gateway | `60`, `30000` (Part 12) |
| `MM_REGION` | gateway | `local` — region in matchmaking keys |
| `MM_BUCKETS` | gateway | `4` — default bucket count per queue family |
| `MM_BUCKETS_BY_QUEUE` | gateway | JSON overrides, e.g. `{"video:en": 32}`; empty in dev |
| `MM_BUCKET_HOP_MS` | gateway | `1000` — waiting time before a ticket hops to another bucket |
| `DEADLINE_SHARDS` | gateway | `16` (production 64) |
| `STATS_COUNTER_SHARDS` | gateway, api | `16` |
| `MOD_FRAME_INTERVALS_MS` | gateway | JSON per risk tier, default `{"high": 20000, "new": 30000, "normal": 120000, "trusted": 0}` (`0` = only spot checks) (Part 8) |
| `MOD_NORMAL_SAMPLE_RATE`, `MOD_TRUSTED_SPOTCHECK_RATE` | gateway | `0.3`, `0.1` — share of sessions sampled for those tiers (Part 8) |
| `MOD_FRAME_BUDGET_PER_SEC` | gateway, worker | `50` in dev — global cap on frames/s sent for server-side checks (Part 8) |
| `RATE_LIMIT_DISABLED` | api, gateway | `false`; honored **only** when `NODE_ENV=development` |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | db seed | dev admin |
| `ADMIN_SESSION_TTL_SECONDS` | api | `28800` |

### Identity model

- **Visitor (anonymous user):** web generates a random `deviceId` (UUID in `localStorage`). `POST /v1/session` with Turnstile token + 18+ confirmation + accepted ToS version + `deviceId` → API upserts `Visitor` by `HMAC(deviceId)`, checks bans, returns a short-lived **JWT** (`jose`, HS256 in dev; claims `sub=visitorId`, `jti`, `exp`). Web keeps the token in memory + `sessionStorage` and sends it in the Socket.io handshake `auth.token` and as `Authorization: Bearer` for REST.
- **Admin:** email + password (argon2id) + optional TOTP. Opaque session id in an httpOnly, `SameSite=Lax` cookie, session stored in Redis.

### Socket.io contract (canonical — defined in `packages/shared`)

All client→server events that expect a result use an **ack**: `{ ok: true, data? } | { ok: false, error: { code, message } }`. Every in-session event carries `sessionId`; the server rejects and the client ignores events for a session that is not the current one (prevents stale signals during rapid skipping).

**Participants, not pairs.** A session has 2 participants today and up to 4 after Part 12. Each participant gets a random per-session `participantId`; visitor IDs are never sent to other users. All code (gateway, client, DB) must work over a participant list — never hard-code "the peer" or `a`/`b`.

**Two media topologies.** `mesh` = direct P2P, used **only for 2-person calls**: one `RTCPeerConnection` per remote participant, server assigns `initiator`/`polite` per pair, signaling relayed via `rtc:*`. `sfu` = **Janus VideoRoom**, used for 3–4-person calls (and for every video call when `DEV_FORCE_SFU=true`): each client publishes once to Janus and subscribes to the others' feeds; it signals with Janus directly over Janus's WebSocket using a short-lived token issued by our gateway. A call switches `mesh → sfu` mid-call (make-before-break) when a group is formed and never switches back.

Client → Server

| Event | Payload | Notes |
|---|---|---|
| `queue:join` | `{ mode: 'text'\|'video', lang: string, interests: string[] }` | interests ≤ 5, each ≤ 24 chars, normalized lowercase (Part 12 adds `allowGroup`) |
| `queue:leave` | `{}` | |
| `chat:next` | `{ sessionId }` | leaves the call + rejoins queue with same preferences |
| `chat:end` | `{ sessionId }` | leaves the call, back to idle |
| `chat:message` | `{ sessionId, text, clientMsgId }` | text ≤ 500 chars after trim; fanned out to all other participants |
| `chat:typing` | `{ sessionId, isTyping }` | throttled |
| `rtc:offer` / `rtc:answer` | `{ sessionId, to: participantId, sdp }` | sdp ≤ 16 KB; always addressed to one participant |
| `rtc:ice` | `{ sessionId, to: participantId, candidate }` | ≤ 1 KB |
| `rtc:summary` | `{ sessionId, peer: participantId, localCandidateType, remoteCandidateType, avgRttMs, avgBitrateKbps, timeToConnectedMs, failed }` | once per peer connection at its end (video) |
| `moderation:signal` | `{ sessionId, about: participantId\|'self', kind, score }` | client-side NSFW signals (Part 8), low trust weight |
| `match:ack` | `{ sessionId }` | must arrive within `MATCH_ACK_TIMEOUT_MS` of `match:found` |
| `session:resume` | `{ sessionId, lastMessageId? }` | after a socket reconnect; ack `{ selfParticipantId, peers, missedMessages }` or error `SESSION_NOT_RESUMABLE` |
| `call:topologyReady` | `{ sessionId, epoch }` | client is receiving all peers via the new topology and has closed the old connections (Part 11) |
| `ping` | `{}` | ack with server time |

Server → Client

| Event | Payload |
|---|---|
| `queue:waiting` | `{ since }` |
| `match:found` | `{ sessionId, mode, topology: 'mesh'\|'sfu', maxParticipants, selfParticipantId, peers: [{ participantId, initiator: boolean, polite: boolean }], sfu?: { wsUrl, roomId, token, epoch }, moderation: { frameIntervalMs: number \| null }, commonInterests: string[] }` (`initiator`/`polite` are from the receiver's point of view and only used for `mesh`; `sfu` is present only when `topology = 'sfu'`; `moderation.frameIntervalMs` is the server-chosen frame-sampling interval for this participant, `null` = no sampling — Part 8) |
| `call:topology` | `{ sessionId, topology: 'sfu', epoch, sfu: { wsUrl, roomId, token } }` — switch to (or, on SFU failover, move to a new) Janus room; or `{ sessionId, topology: 'mesh', epoch, reason }` to roll back a failed upgrade (Part 11) |
| `participant:joined` | `{ sessionId, participantId }` — a new participant joined a group call (Part 12) |
| `chat:message` | `{ sessionId, from: participantId, id, text, at }` |
| `chat:typing` | `{ sessionId, from: participantId, isTyping }` |
| `rtc:offer` / `rtc:answer` / `rtc:ice` | `{ sessionId, from: participantId, ... }` (`from` set by the server, never trusted from the client) |
| `peer:reconnecting` / `peer:resumed` | `{ sessionId, participantId }` — the peer's signaling connection dropped / came back (media may still flow) |
| `peer:left` | `{ sessionId, participantId, reason: 'left'\|'disconnected', sessionEnded: boolean }` (never reveal reports/bans to others) |
| `system:notice` | `{ code, message }` — e.g. `SESSION_REPLACED`, `SERVER_RESTARTING`, `BANNED`, `MESSAGE_BLOCKED`, `RATE_LIMITED` |

### Redis key schema (all builders in `packages/redis/src/keys.ts`)

Matchmaking keys share a **hash tag** so each Lua script touches a single slot (Redis Cluster–ready). `tag = {mm:<region>:<pool>:<mode>:<lang>:<bucket>}` where `region = MM_REGION`, `pool ∈ normal | shadow`, and `bucket ∈ [0, bucketCount)` — each queue family is split into buckets so no single Redis shard carries all matching for a popular queue (see **Queue buckets**).

| Key | Type | Purpose |
|---|---|---|
| `{tag}:q:any` | LIST | waiting tickets (FIFO) without interest constraint |
| `{tag}:q:int:<interest>` | LIST | waiting tickets per interest |
| `{tag}:tickets` | HASH | ticketId → JSON `{ ticketId, visitorId, interests, createdAt, status }` |
| `{tag}:recent` | ZSET | member `minId\|maxId` (pair), score = timestamp; avoids immediate rematch |
| `visitor:<id>:ticket` | STRING | current ticket ref (tag + ticketId) |
| `visitor:<id>:session` | STRING | current sessionId |
| `session:{<id>}:meta` | HASH | `{ mode, topology, maxParticipants, startedAt, commonInterests, state: active\|seeking\|ended, endedAt?, topologyEpoch, topologyState: stable\|upgrading, sfuNodeId?, sfuRoomId? }` |
| `sfu:nodes` | HASH | Janus nodeId → JSON `{ wsUrl, adminUrl, healthy, rooms, lastCheckedAt }` (Part 11) |
| `sfu:rooms` | HASH | `<nodeId>:<roomId>` → sessionId; used to destroy orphan rooms (Part 11) |
| `session:{<id>}:participants` | HASH | participantId → JSON `{ visitorId, status: pending\|active\|reconnecting\|left, joinedAt, disconnectedAt?, leftAt?, leaveReason? }` (left participants are kept so reports work) |
| `session:{<id>}:log` | LIST | transcript ring buffer (last 100 msgs, `from` = participantId) |
| `session:deadlines:{<shard>}` | ZSET | **sharded**: `shard = hash(sessionId) % DEADLINE_SHARDS`. Member `<kind>\|<sessionId>\|<participantId>` (kind `ack` or `grace`), score = deadline (ms). Every gateway node polls all shards; entries are claimed with `ZREM` so exactly one node handles each, and nothing is lost when a node restarts |
| `presence:node:<nodeId>` | STRING | socket count of a gateway node, TTL 15 s |
| `presence:nodes` | SET | known gateway node ids |
| `stats:matches:<yyyyMMddHHmm>:<n>` | STRING | per-minute match counter **sharded** into `STATS_COUNTER_SHARDS` keys (random `n` on write, summed on read), TTL 2 h — avoids one hot key taking every match |
| `ban:visitor:<id>`, `ban:device:<hash>`, `ban:ip:<hash>` | STRING | ban cache (JSON: type, expiresAt) |
| `trust:<visitorId>` | STRING | cached trust score |
| `rl:*` | various | rate limiting |
| `admsess:<id>` | STRING | admin sessions |
| channel `gw:control` | PUB/SUB | cross-node control: kick visitor, end session, ban applied |

Session keys share the hash tag `{<sessionId>}` so join/leave can be one atomic Lua script (Redis Cluster–safe). When a session ends, all its keys get a 1 h TTL so reports can still reference it.

### Session resilience (implemented in Parts 5–7)

1. **Calls survive signaling disconnects.** Media is P2P, so a gateway crash, deploy or brief network blip must not end a call. On socket disconnect the participant becomes `reconnecting` (not `left`) for `RECONNECT_GRACE_MS`; others get `peer:reconnecting`. If the same visitor reconnects to **any** gateway node and sends `session:resume` within the grace period, the participant becomes `active` again, others get `peer:resumed`, and the ack returns any text messages missed meanwhile. When the grace period expires, the participant leaves normally. Gateway shutdown never ends sessions.
2. **Match acknowledgement (ghost-tab protection).** Participants start as `pending`. The client must send `match:ack` within `MATCH_ACK_TIMEOUT_MS`; otherwise the session ends and the non-responding participant leaves (reason `match_timeout`). The client pauses searching when its tab has been hidden too long while waiting.
3. **Fair requeue.** If a session fails early (within `EARLY_FAILURE_WINDOW_MS`) through no fault of a participant — the peer never acked, disconnected for good, or WebRTC failed — that participant is requeued with **priority** (head of the queue). A normal skip is not a failure; skipped users requeue normally.
4. **Video only after media is ready.** In video mode the client only sends `queue:join` after camera and mic are granted (pre-join screen), so nobody is matched with someone who can't send video.

### Matching algorithm (implemented in Part 5)

- `enqueueOrMatch(ticket, phase)` is **one atomic Lua script**:
  1. `phase = 'interest'`: for each of the ticket's interests, scan `q:int:<interest>` from the head; skip & drop stale entries (status ≠ waiting, same visitor, or recent pair); bounded to 50 skips per call. First valid entry → match.
  2. `phase = 'any'` (immediately if no interests; otherwise after `INTEREST_FALLBACK_MS`): scan `q:any` the same way.
  3. No match → push ticket into the queues for its phase and mark `waiting`.
  4. Match → mark both tickets `matched`, record pair in `recent` (prune entries older than `RECENT_PAIR_TTL_MS`), return peer ticket + common interests.
- Interest tickets are first enqueued only in interest queues; a gateway timer later "promotes" them into `q:any`. Duplicate references are harmless because of stale-skipping.
- `enqueueOrMatch` accepts `{ priority: true }`: the ticket is pushed to the **head** of its queues instead of the tail (fair requeue after an early failure — see Session resilience).

### Queue buckets (scale: no single hot Redis shard)

- A **queue family** is `(region, pool, mode, lang)`. Each family is split into `bucketCount` buckets; each bucket has its own hash tag, so buckets land on different Redis shards and are matched in parallel. `bucketCount = MM_BUCKETS_BY_QUEUE[<mode>:<lang>]` or `MM_BUCKETS` (dev default 4 so the logic is always exercised; production: 32–64 for the busiest families, 1–4 for small ones — sized so every bucket keeps plenty of waiting users).
- **Bucket choice on join ("power of two choices"):** read the waiting count of 2 random buckets (one pipelined call); join the one that has someone waiting (an instant match is likely), otherwise the shorter one.
- **Hopping (no stranded users):** a ticket still waiting after `MM_BUCKET_HOP_MS` is atomically cancelled in its bucket (only if still `waiting`) and re-enqueued into another bucket chosen the same way, with `{ priority: true }` and its original `createdAt` so it keeps its place. This repeats until matched, so two lonely users in different buckets always find each other within a few hops.
- Interest matching and recent-pair avoidance work **within a bucket**. Because bucket counts scale with traffic, each bucket stays dense enough for interest matches; a rematch with the same person in another bucket is possible but negligible in busy queues (small queues use 1 bucket). Document this trade-off.
- `region` is in the tag now so multi-region matching (production phase) needs no key changes: each region matches locally first, then falls back to neighbouring regions.
- After a match the gateway (TypeScript) creates the session keys with a random `participantId` per visitor, randomly picks the pair's `initiator` (impolite peer, creates the offer), and emits `match:found` to each visitor's room `visitor:<id>`.
- Cross-node delivery: every socket joins room `visitor:<visitorId>`; emits go through the Socket.io sharded Redis adapter. No per-session rooms — "send to all other participants" loops over their visitor rooms, so the same code serves 2 or 3 participants. One active socket per visitor (new connection kicks the old one via `gw:control`).

---

## PART 1 — Monorepo foundation & local infrastructure

**Paste:** `Execute Part 1 of MASTER_IMPLEMENTATION_PROMPT.md`

**Goal:** A clean pnpm + Turborepo monorepo with shared tooling and a one-command local infrastructure (Postgres, Redis, coturn, MinIO).

**Tasks**
1. `git init`; add `.gitignore` (node_modules, .env*, except .env.example, dist, .next, .turbo, coverage, playwright artifacts), `.editorconfig`, `.nvmrc` (Node 24 LTS), `.npmrc`.
2. Install pnpm (prefer `corepack enable && corepack prepare pnpm@latest --activate`; fall back to `npm i -g pnpm`). Set `"packageManager"` in root `package.json`.
3. Create `pnpm-workspace.yaml` (`apps/*`, `packages/*`, `tools/*`, `e2e`) and `turbo.json` with tasks `dev` (persistent, no cache), `build`, `lint`, `typecheck`, `test`, `clean`.
4. Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `format`, `format:check`, `infra:up`, `infra:down`, `infra:logs`, `infra:reset` (down -v), placeholders for `db:*` (filled in Part 2).
5. `packages/config`: `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` off unless painless), `tsconfig.node.json` (NodeNext), `tsconfig.nextjs.json` (bundler resolution); ESLint flat config (typescript-eslint, import ordering, no-floating-promises); Prettier config.
6. `packages/env`: Zod-based helper `createEnv(schema)` that loads root `.env` once, validates, and throws a readable error listing missing/invalid vars. Export per-service schemas as they are needed (start with a `baseEnv`: `NODE_ENV`, `LOG_LEVEL`).
7. `packages/logger`: pino factory `createLogger({ service })` — pretty output in development, JSON otherwise; redact paths for `authorization`, `cookie`, `token`, `password`, `ip`.
8. `packages/shared`: initial skeleton — `constants.ts` (MAX_MESSAGE_LENGTH=500, MAX_INTERESTS=5, MAX_INTEREST_LENGTH=24, SUPPORTED_LANGS, CHAT_MODES), `errors.ts` (error code enum), `index.ts`. Unit test for constants/schemas.
9. `infra/docker/docker-compose.yml` with healthchecks and named volumes:
   - PostgreSQL (latest stable major) — db `app`, user `app`; init script also creates `app_test`.
   - Redis (≥ 7.2, needed for sharded pub/sub) with AOF off in dev.
   - coturn: `use-auth-secret`, `static-auth-secret` from env, `realm`, `listening-port=3478`, `min-port=49160`, `max-port=49200`, `fingerprint`, `no-cli`, `no-multicast-peers`. Add a **commented production block** with `denied-peer-ip` for private/loopback ranges (prevents SSRF through TURN) and explain why it is disabled for localhost dev. On macOS Docker Desktop, configure `external-ip` so relay candidates are reachable from the host; document what works.
   - MinIO + a one-shot `minio-init` (mc) container that creates buckets `evidence` and `frames` and sets a 1-day lifecycle on `frames`.
10. `.env.example` with all variables needed so far (see Reference Design table; include future ones commented if helpful) and copy to `.env` for local use.
11. `README.md` skeleton: prerequisites, setup (`pnpm i`, `cp .env.example .env`, `pnpm infra:up`), scripts table.

**Required tests:** `packages/shared` and `packages/env` unit tests (env loader rejects invalid config with a clear message).

**Acceptance criteria**
- `pnpm install` works from a clean clone; `pnpm infra:up` brings all containers to healthy.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green.
- `docker compose ps` shows postgres, redis, coturn, minio healthy; MinIO buckets exist.

**Manual check:** run `pnpm infra:up`, open MinIO console at http://localhost:9001 and see the two buckets.

**Out of scope:** any app (`apps/*`).

**Update CONTEXT.md:** tool versions, repo layout, ports, env vars, commands, decisions (pnpm+turbo, TS-source internal packages, single root .env), any macOS/Docker caveats (coturn).

---

## PART 2 — Database & shared server packages

**Paste:** `Execute Part 2 of MASTER_IMPLEMENTATION_PROMPT.md`

**Goal:** Prisma data model with migrations and seed; reusable Redis package with the central key schema.

**Tasks**
1. `packages/db` with Prisma (PostgreSQL). Follow the installed Prisma version's current conventions (config file, generator output, client import path). Export a singleton `prisma` client (cached on `globalThis` in development to survive hot reload) and re-export generated types.
2. Models (UUIDs or cuid2 ids, `createdAt`/`updatedAt` where sensible, explicit indexes):
   - `Visitor` — `deviceIdHash` (unique), `lastIpHash`, `firstSeenAt`, `lastSeenAt`, `ageConfirmedAt`, `tosVersion`, `trustScore` (int, default 50), `country` (nullable).
   - `ChatSessionLog` — metadata only: `id` (= sessionId), `mode`, `topology` (enum `MESH`; `SFU` reserved), `maxParticipants`, `commonInterests` (text[]), `startedAt`, `endedAt`. Index on `startedAt`.
   - `SessionParticipant` — `sessionId` (→ ChatSessionLog), `visitorId`, `participantId` (unique per session), `joinedAt`, `leftAt`, `leaveReason` (enum: `SKIP`, `STOP`, `DISCONNECT`, `RTC_FAILED`, `REPORTED`, `BANNED`, `SERVER_RESTART`). Unique `(sessionId, participantId)`, index on `visitorId`. Sessions are N participants so group calls (Parts 11–12) need no schema redesign.
   - `Report` — `sessionId`, `reporterId`, `reportedId` (visitor, resolved server-side), `reportedParticipantId`, `reason` (enum: `NUDITY_SEXUAL`, `MINOR_SAFETY`, `HARASSMENT`, `HATE`, `SPAM_SCAM`, `VIOLENCE_SELF_HARM`, `OTHER`), `details` (≤ 500), `status` (`OPEN`, `IN_REVIEW`, `ACTIONED`, `DISMISSED`), `priority` (int), `transcript` (Json, nullable), `assignedToId`, `resolvedAt`, `resolutionNote`. Index `(status, priority desc, createdAt)`.
   - `Evidence` — `reportId` (nullable), `moderationEventId` (nullable), `type` (`FRAME`, `TRANSCRIPT`, `AUTO_FLAG_FRAME`), `storageKey`, `sha256`, `expiresAt`.
   - `ModerationEvent` — `visitorId`, `sessionId`, `source` (`CLIENT_NSFW`, `SERVER_CLASSIFIER`, `TEXT_FILTER`, `HASH_MATCH`, `REPORT_THRESHOLD`), `label`, `score` (float), `actionTaken` (enum incl. `NONE`, `TRUST_DECREASED`, `SHADOW_BANNED`, `BANNED`, `ESCALATED`).
   - `Ban` — `visitorId`, `deviceIdHash`, `ipHash` (each nullable, at least one required — enforce in code), `type` (`HARD`, `SHADOW`), `reason`, `createdByAdminId` (nullable = automated), `expiresAt` (nullable = permanent), `revokedAt`, `revokedByAdminId`. Indexes for lookups by each identifier.
   - `AdminUser` — `email` (unique, citext or lowercased), `passwordHash`, `role` (`ADMIN`, `MODERATOR`), `totpSecret` (nullable, encrypted later), `totpEnabled`, `lastLoginAt`, `disabledAt`.
   - `AuditLog` — `adminId`, `action`, `targetType`, `targetId`, `metadata` (Json), `createdAt`.
3. Initial migration; scripts in root: `db:generate`, `db:migrate` (dev), `db:deploy`, `db:reset`, `db:seed`, `db:studio`; test DB migration script using `DATABASE_URL_TEST`.
4. Seed (idempotent): a dev admin from `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` (argon2id via `@node-rs/argon2`), a few visitors, sample reports, one shadow ban — clearly marked dev data.
5. `packages/redis`: `createRedis(url, opts)` (ioredis, sensible retry strategy, `lazyConnect` option), `keys.ts` implementing **every key builder from the Reference Design** (single source of truth), JSON get/set helpers validated with Zod, a typed pub/sub helper for channel `gw:control` (message union: `kick_visitor`, `end_session`, `ban_applied`).
6. `packages/shared/src/crypto.ts` (server-only export path): `hmacHash(value, pepper)` used for IP/device hashing.

**Required tests:** key builders (hash tags correct and consistent), hmac helper, Zod JSON helpers; a db smoke test against `app_test` (create/read Visitor, unique constraint on deviceIdHash).

**Acceptance criteria:** `pnpm db:migrate && pnpm db:seed` succeed on a fresh DB; `pnpm db:studio` shows seeded data; quality gate green.

**Manual check:** `pnpm db:studio` → browse `Visitor`, `Report`, `AdminUser`.

**Out of scope:** any HTTP/socket server.

**Update CONTEXT.md:** data model summary (models + key fields + enums), Redis key schema as implemented, db commands, seed credentials location (not the password itself if non-default).

---

## PART 3 — REST API service

**Paste:** `Execute Part 3 of MASTER_IMPLEMENTATION_PROMPT.md`

**Goal:** `apps/api` (Fastify) providing anonymous session issuance, TURN credentials, public config and health.

**Tasks**
1. Fastify app with: Zod type provider, `@fastify/cors` (allowlist `CORS_ORIGINS`), `@fastify/helmet`, `@fastify/rate-limit` backed by Redis, `@fastify/sensible`, request IDs, pino logger from `packages/logger`, consistent error envelope `{ error: { code, message, requestId } }`, 404 handler, body size limit (64 KB default). `trustProxy` only when configured. App factory `buildApp(deps)` (dependency-injected: prisma, redis, turnstile verifier, clock) for testability; `server.ts` starts it with graceful shutdown (SIGTERM/SIGINT).
2. Env schema in `packages/env` for the API.
3. Routes:
   - `GET /health` (liveness) and `GET /ready` (Postgres + Redis ping).
   - `GET /v1/config` → `{ tosVersion, maxMessageLength, maxInterests, supportedLangs, features: { video: true, reports: false } }` (flags updated in later parts).
   - `POST /v1/session` → body `{ turnstileToken, ageConfirmed: true, tosVersion, deviceId(uuid) }`:
     verify Turnstile via `TurnstileVerifier` interface (real siteverify call; dev uses Cloudflare test keys), require `tosVersion === TOS_VERSION`, hash deviceId & IP, upsert `Visitor`, check bans (Postgres; cache result in Redis keys `ban:*`) → HARD ban returns `403 { code: 'BANNED', expiresAt }`; issue JWT (`jose`). Response `{ token, visitorId, expiresAt }`. Rate limit: 10/min per IP hash.
   - `GET /v1/turn-credentials` (Bearer auth) → `{ iceServers: [ { urls: STUN_URLS }, { urls: ['turn:HOST:PORT?transport=udp','turn:HOST:PORT?transport=tcp'], username, credential } ], ttlSeconds }` using the coturn REST scheme: `username = <expiryUnix>:<visitorId>`, `credential = base64(HMAC-SHA1(TURN_SECRET, username))`. Rate limit 30/min per visitor.
   - `GET /v1/stats/online` → `{ online }` summed from `presence:node:*` via `presence:nodes` (returns 0 until the gateway exists). Cache 2 s.
4. Auth plugin: verifies Bearer JWT → `request.visitor = { id }`; distinguishes missing/expired/invalid tokens.
5. `RATE_LIMIT_DISABLED` honored only in development.
6. Dev scripts: `dev` (tsx watch), `build` (tsup), `start`.

**Required tests (fastify.inject):** session success; Turnstile failure; wrong tosVersion; hard-banned device → 403; JWT verification (valid/expired/tampered); TURN credential format matches coturn HMAC; CORS rejects unknown origin; rate limit triggers; `/ready` fails when Redis is down (mock).

**Acceptance criteria:** `curl` flows work (document them in README); quality gate green.

**Manual check:**
`curl -X POST localhost:4000/v1/session -H 'content-type: application/json' -d '{"turnstileToken":"XXXX.DUMMY.TOKEN.XXXX","ageConfirmed":true,"tosVersion":"2026-10-dev","deviceId":"<uuid>"}'` → token; then `curl localhost:4000/v1/turn-credentials -H "authorization: Bearer <token>"`.

**Out of scope:** reports, admin routes, moderation frame upload.

**Update CONTEXT.md:** REST endpoints table, auth design, env vars, commands, decisions (JWT in sessionStorage + handshake auth, Turnstile test keys in dev).

---

## PART 4 — Real-time gateway core

**Paste:** `Execute Part 4 of MASTER_IMPLEMENTATION_PROMPT.md`

**Goal:** `apps/gateway`: a horizontally scalable, validated, rate-limited Socket.io server. No matchmaking yet.

**Tasks**
1. Typed contracts in `packages/shared/src/socket/`: `ClientToServerEvents`, `ServerToClientEvents`, `SocketData`, Zod schemas for every payload in the Reference Design contract, ack types, notice codes.
2. Socket.io server on a plain Node HTTP server (no Express): `transports: ['websocket']`, `perMessageDeflate: false`, `maxHttpBufferSize: 32 KB`, ping 25 s/20 s, CORS + explicit `Origin` header check against `CORS_ORIGINS`. `GET /health` and `/ready` on the same HTTP server.
3. Redis adapter: `@socket.io/redis-adapter` **sharded adapter** (`createShardedAdapter`, `subscriptionMode: 'dynamic'`). Verify which Redis client it requires per current docs (node-redis vs ioredis) and use that client for the adapter only; ioredis remains the app client.
4. Handshake auth middleware: verify JWT, load ban status from Redis cache (fallback to Postgres is acceptable in dev via a small `BanService` shared with the API — place reusable logic in a package), set `socket.data = { visitorId, ipHash, pool: 'normal'|'shadow', state: 'idle' }`. Reject hard-banned visitors with error `BANNED`.
5. One socket per visitor: before joining `visitor:<id>`, publish `kick_visitor { visitorId, exceptSocketId }` on `gw:control`; every node handles it locally (`io.local`), emitting `system:notice SESSION_REPLACED` then disconnecting.
6. Event registration helper `registerHandler(socket, event, schema, handler, { cost })`: validates payload with Zod, applies a **per-socket token-bucket rate limiter** (in memory; per-event cost), catches errors, always answers the ack with the standard envelope, counts/ignores unknown events, disconnects sockets that exceed an abuse threshold.
7. Presence: every 5 s write `presence:node:<nodeId>` (TTL 15 s) and maintain `presence:nodes`.
8. `ping` handler (ack with server time). Stub handlers for the remaining events returning `NOT_IMPLEMENTED` (removed in Part 5).
9. Graceful shutdown: stop accepting connections, notify `SERVER_RESTARTING`, close sockets after a drain timeout (10 s), close Redis, exit. Leave a hook `onShutdown` for Part 5 (it stops timers; it must **not** end sessions — see Session resilience).
10. Scripts: `dev`, `dev:multi` (two instances on 4001 and 4011 with different `GATEWAY_NODE_ID`), `build`, `start`.

**Required tests (real Redis, socket.io-client, random ports):** rejects missing/invalid/expired token; rejects banned visitor; invalid payload → `VALIDATION_ERROR` ack; rate limit → `RATE_LIMITED`; second connection for same visitor kicks the first **across two gateway instances**; presence keys written and expire after shutdown.

**Acceptance criteria:** two gateway nodes run simultaneously; `GET /v1/stats/online` on the API reflects sockets on both; quality gate green.

**Manual check:** `pnpm --filter @app/gateway dev:multi`, connect with a tiny script from `tools/bots` (create the package with a minimal `connect` command) and watch online count change.

**Out of scope:** queues, sessions, relay.

**Update CONTEXT.md:** socket events (implemented vs stubbed), gateway design (adapter, control channel, rate-limit costs), commands, decisions.

---

## PART 5 — Matchmaking & chat session lifecycle

**Paste:** `Execute Part 5 of MASTER_IMPLEMENTATION_PROMPT.md`

**Goal:** Users can queue, get matched randomly (interests first), exchange text messages and WebRTC signaling through the server, skip and leave — correctly across multiple gateway nodes.

**Tasks**
1. `packages/matchmaking`: Lua scripts (loaded with ioredis `defineCommand`) + typed wrapper implementing the **Matching algorithm** in the Reference Design: `enqueueOrMatch(ticket, phase)`, `promoteToAny(ticketId)`, `cancelTicket(ticketId)`, `sweepStale(maxAgeMs)`. All keys passed via `KEYS` and sharing the hash tag. Bounded scans. Return values validated with Zod.
2. Gateway handlers replace the stubs:
   - Per-socket state machine `idle → waiting → in_session → (waiting|idle)`; reject invalid transitions with `INVALID_STATE`.
   - `queue:join`: normalize interests (lowercase, trim, dedupe, strip non-alphanumerics except `-`), store preferences on `socket.data`, create ticket, pick a bucket (Reference Design → **Queue buckets**), run `enqueueOrMatch('interest'|'any')`. If waiting with interests, schedule promotion after `INTEREST_FALLBACK_MS`; if still waiting after `MM_BUCKET_HOP_MS`, hop to another bucket (cancel timers on match/leave). Emit `queue:waiting`.
   - On match: create `session:{<id>}:meta` + `session:{<id>}:participants` (random `participantId` each, status `pending`) and `visitor:<id>:session` for both, add an `ack` deadline per participant to the session's `session:deadlines:{<shard>}`, increment a random shard of `stats:matches:<minute>`, choose the pair's initiator randomly, emit `match:found` to both `visitor:<id>` rooms (cross-node).
   - `match:ack`: mark the participant `active` and remove its `ack` deadline. Implement session logic over the **participant list** (helpers like `getOtherActiveParticipants(sessionId, selfParticipantId)`), never as fixed `a`/`b`.
   - Because the waiting peer may be on another node, nodes must update their local socket state when they receive `match:found` for their socket — design this explicitly (e.g. the emitting node also publishes a `gw:control` message, or socket state is derived from Redis `visitor:<id>:session` on each event). Document the choice.
   - `chat:message`: verify session membership + sessionId, trim, enforce length, assign `id` (ulid) + `at`, append to `session:{<id>}:log` (LTRIM 100), emit to every other active participant with `from`, ack sender with `{ id, at }`.
   - `chat:typing`: relay to other participants, throttled (max 1 per 2 s per state change).
   - `rtc:offer|answer|ice`: membership + size checks, verify `to` is an active participant of the same session, relay only to that participant with `from` set by the server.
   - `chat:next` / `chat:end` / `queue:leave` / expired grace / expired ack: **leave** the session with one atomic Lua script over the `{<id>}` keys (idempotent, so simultaneous leaves are safe): mark the participant left, emit `peer:left { participantId, sessionEnded }` to the others; when fewer than 2 active participants remain, set `state=ended`, apply a 1 h TTL to all session keys, and enqueue a BullMQ `session-log` job. `chat:next` rejoins the queue with the same preferences.
   - **Socket disconnect does not leave the session** (Reference Design → Session resilience): set the participant `reconnecting` + `disconnectedAt`, add a `grace` deadline, emit `peer:reconnecting`. A waiting (unmatched) visitor's ticket is still cancelled on disconnect.
   - `session:resume { sessionId, lastMessageId? }`: verify the visitor owns a `reconnecting` (or still `active`, if the disconnect hasn't been processed yet) participant in that session → mark `active`, remove the `grace` deadline, restore `socket.data` state, emit `peer:resumed`, ack with `{ selfParticipantId, peers, missedMessages }` (from `session:{<id>}:log` after `lastMessageId`). Otherwise ack `SESSION_NOT_RESUMABLE`. A `queue:join` from a visitor who still has a `reconnecting` session first leaves that session (e.g. after a page reload).
   - Deadline processor (every gateway node, every 1 s): for each of the `DEADLINE_SHARDS` shards (pipelined, starting at a random shard), read up to 100 due entries from `session:deadlines:{<shard>}`, claim each with `ZREM` (only the node that removed it handles it), then: expired `ack` → that participant leaves with reason `match_timeout`; expired `grace` → leaves with reason `disconnect`. Survives node restarts because deadlines live in Redis.
   - Fair requeue: when a session ends within `EARLY_FAILURE_WINDOW_MS` of `match:found` because a peer timed out, disconnected for good, or reported `rtc_failed`, requeue the other participant(s) automatically with `enqueueOrMatch(..., { priority: true })` (only if they had auto-requeue on — pass this preference in `queue:join`). Normal skips requeue normally.
   - Shutdown hook stops local timers only; it does **not** end sessions — clients reconnect to another node and resume.
   - Periodic sweeper (every 30 s, lock with `SET NX PX`) removes stale tickets.
3. `apps/worker`: BullMQ worker process; `session-log` job writes `ChatSessionLog` + `SessionParticipant` rows (idempotent upserts). Graceful shutdown. Scripts `dev`, `build`, `start`.
4. `tools/bots`: CLI (`pnpm bots -- --clients 20 --gateways http://localhost:4001,http://localhost:4011 --mode text --duration 60`) — each bot obtains a token from the API, connects to a random gateway, joins the queue (random interests from a small pool), sends `match:ack`, sends a few messages, randomly skips or ends, and repeats. Options `--ghost-rate` (fraction of bots that never ack) and `--reconnect-rate` (bots that drop their socket mid-session, reconnect to another gateway and resume). Prints matches, messages delivered, resumes, ack timeouts, errors, p50/p95 time-to-match.

**Required tests**
- Matchmaking (real Redis): basic pairing; FIFO fairness; interest match preferred; fallback to `any` after promotion; no self-match; recent-pair avoidance and expiry; different mode/lang/pool never mix; stale entries skipped and dropped; priority tickets are matched before older normal tickets; bucket choice prefers a bucket with someone waiting; **two users waiting alone in different buckets are matched after hopping**; a hop never loses or duplicates a ticket (concurrent hop + match); keys of different buckets have different hash tags; **concurrency: 200 parallel enqueues → every visitor matched at most once, no lost tickets**.
- Gateway integration: full text flow between two clients on **different gateway nodes**; skip → peer gets `peer:left` and requeues; stale `sessionId` rejected; `rtc:*` with a `to` outside the session rejected; simultaneous leave from both participants is safe; messages over limit rejected.
- Resilience: disconnect → peer gets `peer:reconnecting`, session stays; reconnect **to the other node** + `session:resume` within grace → `peer:resumed` and missed messages returned; no resume → participant leaves after `RECONNECT_GRACE_MS`; a gateway node shut down mid-session → its clients resume on the other node and the session survives; no `match:ack` → session ends after `MATCH_ACK_TIMEOUT_MS` and the acking peer is requeued with priority; each deadline is processed exactly once with two nodes running.
- Worker: session-log job persists row.

**Acceptance criteria:** bots run 2 minutes with 50 clients across 2 nodes with `MM_BUCKETS=4` (with `--ghost-rate 0.1 --reconnect-rate 0.1`), p95 time-to-match no worse than with `MM_BUCKETS=1`, with zero protocol errors, every match symmetric, every reconnecting bot resumed, and ghost sessions ended within the ack timeout; restarting one gateway node during the run ends no sessions; quality gate green.

**Manual check:** `pnpm --filter @app/gateway dev:multi`, `pnpm --filter @app/api dev`, `pnpm --filter @app/worker dev`, then `pnpm bots -- --clients 50 ...`; check `ChatSessionLog` rows in Prisma Studio.

**Out of scope:** web UI, text filtering, reports.

**Update CONTEXT.md:** matchmaking implementation notes, final Redis keys, socket events now implemented, the cross-node state design decision, worker jobs, bots usage, metrics from the bot run.

---

## PART 6 — Web app & end-to-end text chat

**Paste:** `Execute Part 6 of MASTER_IMPLEMENTATION_PROMPT.md`

**Goal:** `apps/web` (Next.js App Router) where a real user can pass the age gate and text-chat with a stranger.

**Tasks**
1. Next.js (App Router, TypeScript, Tailwind CSS, ESLint from `packages/config`), `transpilePackages` for `@app/shared` and `@app/ui`. Light/dark theme following system preference. Mobile-first responsive layout.
   - Create `packages/ui` per **Frontend UI components (21st.dev)** in the Reference Design: shadcn-style setup, `cn()`, theme tokens (light/dark), Tailwind configured so both Next apps pick up the package's classes.
   - Use the `21st` MCP to source and adapt the UI for this part: landing hero, mode-selection cards, language select, interest tag input, online-count badge, age-gate dialog (checkboxes + Turnstile slot), chat layout, message bubbles (self / stranger / system), typing indicator, chat input with counter, Next/Stop buttons, toasts, blocked/banned screen, empty and loading states. Shared primitives (Button, Dialog, Input, Select, Badge, Toast, Card, etc.) go in `@app/ui`.
2. Pages:
   - `/` landing: product name, short safety statement, mode selection (Text / Video — Video disabled with "coming soon" until Part 7), language select, interests tag input (≤ 5), live online count (`/v1/stats/online`, poll 10 s), links to guidelines/terms/privacy.
   - Age gate modal (first chat attempt): confirm 18+, accept Terms + Privacy + Community Guidelines (with `TOS_VERSION`), Cloudflare Turnstile widget → `POST /v1/session`. Banned → friendly blocked screen with expiry.
   - `/chat?mode=text`: chat screen.
   - `/terms`, `/privacy`, `/guidelines`: placeholder content clearly labeled **"Placeholder — requires legal review"**, including that video frames may be sampled for safety and reported content is retained as evidence.
3. Client architecture:
   - `lib/api.ts` typed REST client; `lib/device.ts` deviceId in `localStorage` (try/catch, regenerate if unavailable); token in memory + `sessionStorage`, refresh by re-running session creation when expired.
   - `lib/socket.ts` singleton typed Socket.io client (`transports: ['websocket']`, auth token, reconnection with backoff, handles `SESSION_REPLACED`, `BANNED`, `SERVER_RESTARTING`).
   - Zustand store with an explicit chat state machine (`idle | connecting | waiting | matched | ended | blocked | error`), current `sessionId`, messages, typing state, preferences, `autoRequeue` setting.
   - Ignore any server event whose `sessionId` ≠ current session.
   - Session resilience (Reference Design): send `match:ack` as soon as `match:found` is accepted by the store. On socket reconnect while in a session, send `session:resume { sessionId, lastMessageId }` and merge `missedMessages`; on `SESSION_NOT_RESUMABLE` treat the session as ended. Show a non-blocking "Stranger's connection is unstable…" hint on `peer:reconnecting`, cleared by `peer:resumed`. A socket reconnect alone never resets the chat UI.
   - Ghost-tab protection: if the tab is hidden for more than 60 s while **waiting**, send `queue:leave` and show a "Paused — click to keep searching" state.
   - Pass the auto-requeue preference in `queue:join` so the server can requeue with priority after an early failure.
4. Text chat UI: message list (self / stranger / system messages like "You're now chatting with a stranger. You both like: x"), `aria-live` region, typing indicator, input with character counter (500), Enter to send, optimistic send reconciled with ack (failed → retry/blocked state), **Next** (confirm on first press within 3 s or Esc twice), **Stop**, auto-requeue toggle, "Stranger has disconnected" state with "New chat" button. Never render HTML from messages; no auto-linking.
5. Basic `next.config` security headers (CSP finalized in Part 10).

**Required tests:** store/state-machine unit tests (transitions, stale session events ignored, optimistic message reconciliation); component test for message rendering escaping HTML.

**Acceptance criteria:** two browser windows (one normal, one incognito) can match and chat; Next/Stop/reconnect behave correctly; works on mobile viewport; quality gate green.

**Manual check:** run infra + api + gateway + worker + web (`pnpm dev` should start all — make sure it does), open http://localhost:3000 in two windows, chat, skip, stop.

**Out of scope:** video, reports UI.

**Update CONTEXT.md:** web app structure, state machine, how to run everything, UX decisions, known issues.

---

## PART 7 — Video chat (WebRTC)

**Paste:** `Execute Part 7 of MASTER_IMPLEMENTATION_PROMPT.md`

**Goal:** Reliable 1:1 video + audio (with side text chat) using P2P WebRTC, TURN fallback, and rapid skipping without leaks or stale state.

**Tasks**
1. `useLocalMedia` hook: `getUserMedia` (ideal 640×480 @ 24–30 fps, echoCancellation, noiseSuppression, autoGainControl), permission-denied / no-device / in-use errors with clear UI, device pickers (camera/mic, `devicechange` listener), mute and camera-off via `track.enabled`, mirrored local preview. Acquire once and reuse across matches.
   **Pre-join screen:** `/chat?mode=video` first shows a camera/mic check (preview, device pickers, mic level meter, "Start" button). `queue:join` is sent only after `getUserMedia` succeeded and the user clicked Start; if permission is denied, the user can switch to text mode instead.
2. `lib/rtc/CallManager.ts` (one per chat session) shares the single local stream and exposes remote media **per participantId** to the UI through a **transport interface**. Implement `MeshTransport` now: a `Map<participantId, PeerSession>`, routes incoming signals by `from`, creates PeerSessions from `match:found.peers` and destroys one on `peer:left`. Part 11 adds `SfuTransport` (Janus) behind the same interface and lets `CallManager` run both during a make-before-break switch — design the interface for that now.
   `lib/rtc/PeerSession.ts` (framework-agnostic class, **one instance per remote participant**):
   - ICE servers from `GET /v1/turn-credentials` (cache until 60 s before expiry).
   - `iceTransportPolicy: 'relay'` when `NEXT_PUBLIC_FORCE_TURN_RELAY=true`.
   - **Perfect negotiation** using server-assigned `polite`; `initiator` creates the first offer; trickle ICE through the gateway; queue remote candidates until a remote description exists.
   - Connection monitoring: `disconnected` for 3 s → ICE restart (initiator only); `failed` → one ICE restart, then end session with `chat:next` and reason `rtc_failed`.
   - Cap outgoing video bitrate (~800 kbps via `RTCRtpSender.setParameters`), prefer maintaining framerate.
   - `close()` is idempotent: removes listeners, closes the PC, clears remote stream; local stream stays alive.
   - Every outgoing/incoming signal is tagged with `sessionId`; signals for other sessions are dropped.
   - **Lifecycle rules (prevent the classic "ontrack never fires" bugs):** never store `RTCPeerConnection`, `MediaStream` or tracks in React state (keep them in the class; expose only plain status values to React); attach `ontrack`, `onicecandidate`, `onnegotiationneeded`, `onconnectionstatechange` immediately after constructing the connection and before any `setRemoteDescription`/`addTrack`; always pair `createOffer`/`createAnswer` with `setLocalDescription`; no `setTimeout`/polling workarounds (e.g. reading `getTransceivers()` later) — if `ontrack` doesn't fire, find the cause.
   - A socket reconnect must **not** close the `PeerSession`: media keeps flowing P2P while the client resumes the session. Only `peer:left`, ending the session, or `rtc_failed` closes it. Signals that were in flight during a reconnect may be lost — recover with an ICE restart if the connection becomes `disconnected`.
   - Collect `getStats()` every 2 s (RTT, packet loss, bitrate, selected candidate pair types) → quality indicator; send `rtc:summary` once at session end.
3. Gateway: handle `rtc:summary` (validate, log at debug, keep counters for Part 10 metrics).
4. Video chat page `/chat?mode=video`: remote video large (rendered from the list of remote participants, so the layout already handles 1–3 remote tiles, e.g. a 2×2 grid), local picture-in-picture, text chat panel (side on desktop, drawer on mobile), controls (Next, Stop, Mute, Camera, Device settings, Report placeholder disabled until Part 8), "Looking for someone…" state with local preview, connection quality badge, autoplay handling (muted-autoplay fallback with tap-to-unmute). Enable Video mode on the landing page and set `features.video` accordingly. Source the video tiles, controls bar, device-settings dialog and quality badge via the `21st` MCP into `@app/ui` (Reference Design → Frontend UI components); keep all WebRTC logic outside the components.
5. Handle tab visibility/background, page unload (`chat:end` via `pagehide`), and network change (`online/offline`).
6. Document LAN/mobile testing: `getUserMedia` needs a secure context — describe running `next dev --experimental-https` (or a local HTTPS proxy) and pointing `NEXT_PUBLIC_*` URLs at the LAN IP.

**Required tests:** `PeerSession` unit tests with mocked `RTCPeerConnection` (glare handled by perfect negotiation, candidate queuing, stale-session drop, idempotent close, restart policy, handlers attached before the first remote description, socket reconnect does not close the connection); `CallManager` tests (signals routed by `from`, peer added/removed, local stream shared and kept alive). Playwright smoke test is added in Part 10.

**Acceptance criteria:**
- Two windows connect video+audio within ~2 s on localhost; rapid Next ×20 leaves no zombie peer connections (check `chrome://webrtc-internals`) and no memory growth in tracks.
- With `NEXT_PUBLIC_FORCE_TURN_RELAY=true`, the selected candidate pair is `relay` and video still works through coturn.
- Restarting the gateway mid-call does not interrupt video/audio; text chat resumes after the socket reconnects.
- Nobody can enter the video queue without granted camera/mic.
- Quality gate green.

**Manual check:** two Chrome windows (one incognito) → video works; toggle relay mode and confirm in `chrome://webrtc-internals`; test camera-denied path; restart the gateway during a call and confirm the video keeps playing.

**Out of scope:** NSFW detection, reports.

**Update CONTEXT.md:** WebRTC design (negotiation, restart policy, bitrate cap, relay mode), TURN/macOS caveats discovered, LAN testing instructions.

---

## PART 8 — Trust & safety

**Paste:** `Execute Part 8 of MASTER_IMPLEMENTATION_PROMPT.md`

**Goal:** The safety systems a platform like this cannot launch without: filtering, reporting with evidence, automated detection hooks, bans, shadow pool and trust scores.

**Tasks**
1. `packages/moderation`:
   - `textFilter(text)` → `{ action: 'allow'|'mask'|'block', reasons[] , masked? }` using the `obscenity` library + detectors for URLs, emails, phone numbers and common social-handle solicitations (block links by default). Fully unit-tested, configurable lists.
   - Interfaces `ImageClassifier` (`classify(jpeg) → { labels: {name, score}[] }`) with `MockImageClassifier` (safe by default; deterministic flag via `DEV_FORCE_FLAG_VISITOR_IDS`), and `HashMatcher` with `NoopHashMatcher`. Document where PhotoDNA / Thorn Safer / NCMEC hash lists plug in for production — **never** add or download real abusive material for testing.
   - `TrustRules`: pure functions mapping events → trust delta (report received −10, auto-flag −20, text violation −2, clean session ≥ 60 s +1 capped at 100) and pool rules (shadow if SHADOW ban or trust < 10). Thresholds from env with defaults.
2. Gateway:
   - Apply `textFilter` before relaying; blocked → ack error `MESSAGE_BLOCKED` + `system:notice`; record `TEXT_FILTER` moderation event via a BullMQ job (never block the hot path on Postgres).
   - `moderation:signal` from clients: validate, rate-limit (max 1 per 5 s), enqueue job (low weight).
   - Subscribe to `gw:control` `ban_applied`: HARD → end session, notify `BANNED`, disconnect; SHADOW → end session, set pool to `shadow` on next queue join.
   - Pool from ban cache + trust cache at connect and on each `queue:join`.
3. API:
   - `POST /v1/reports` (Bearer, multipart via `@fastify/multipart`): `{ sessionId, reportedParticipantId, reason, details? }` + up to 3 JPEG frames (≤ 300 KB each, verify magic bytes, re-encode/strip metadata with `sharp`). Verify reporter and reported were both participants of the session (`session:{<id>}:participants`, kept 1 h after end), resolve `reportedParticipantId` → visitorId server-side, snapshot transcript from Redis, upload frames to MinIO `evidence/reports/<reportId>/<n>.jpg` with sha256, create `Report` + `Evidence` rows, compute priority (`MINOR_SAFETY` highest, then `NUDITY_SEXUAL`, …, boosted by reported visitor's recent report count). Rate limit 10/hour per visitor. Reporting automatically ends the session for the reporter (client sends `chat:next`).
   - `POST /v1/moderation/frames` (Bearer, video sessions only): one downscaled JPEG (≤ 320 px, ≤ 60 KB) of the visitor's **own outgoing** video; accepted only at the interval the server assigned to that participant (reject faster uploads); stored in MinIO `frames/` (1-day lifecycle) → enqueue `classify-frame` job.
   - **Risk-based frame sampling (scale):** sampling every video user every 30 s would be ~23k images/s at 1M users. Instead the gateway assigns each participant a sampling interval in `match:found.moderation.frameIntervalMs`, by risk tier (`MOD_FRAME_INTERVALS_MS`):
     - `high` — trust < 40, recent reports/flags, or any group (SFU) call: every ~20 s.
     - `new` — first 24 h or first 10 sessions: every ~30 s.
     - `normal` — only `MOD_NORMAL_SAMPLE_RATE` of sessions are sampled, every ~120 s.
     - `trusted` — trust ≥ 70 and no reports in 7 days: one spot-check frame ~10 s into `MOD_TRUSTED_SPOTCHECK_RATE` of sessions.
     - A report or client NSFW signal in a session switches its participants to `high` immediately (pushed via `system:notice` with the new interval).
     - **Global budget:** the worker measures `classify-frame` throughput/queue depth and publishes a multiplier in Redis; the gateway stretches intervals (lowest tiers first) so total uploads stay under `MOD_FRAME_BUDGET_PER_SEC`. `high` is never stretched beyond 2×.
     - **Missing uploads:** the gateway/API count expected vs received frames per participant; a client that repeatedly fails to upload gets a trust penalty and is moved to `high` (prevents opting out by blocking the upload).
   - `GET /v1/config` → `features.reports = true`.
4. Worker jobs: `classify-frame` (run `HashMatcher` then `ImageClassifier`; clean → delete frame immediately; flagged → `ModerationEvent`, `Evidence` (`AUTO_FLAG_FRAME`), auto-created high-priority `Report`, trust decrease, auto SHADOW ban above threshold / HARD ban + escalation on hash match, publish `ban_applied`); `moderation-event` (persist + trust update); `report-threshold` (≥ N distinct reporters in 24 h → automatic SHADOW ban, configurable). `BanService.apply()` writes Postgres, refreshes Redis ban cache, publishes `ban_applied`.
5. Web:
   - Report button + dialog (reason radio list, optional details; UI sourced via the `21st` MCP like the blur overlay and blocked-message notices). Keep an **in-memory** ring buffer of the last 3 remote frames sampled every 3 s (640 px JPEG via canvas) — never uploaded unless the user reports. Submit, then auto-Next with confirmation toast.
   - Client NSFW (`nsfwjs`, model files self-hosted under `/public/models`, lazy-loaded only in video mode): classify the remote video every 2 s at 224 px; above threshold → blur remote video with an overlay offering Next / Report; send `moderation:signal`. Classify own outgoing video every 5 s; above threshold → warn the user. Run inference off the critical render path (`requestIdleCallback` or a Web Worker with OffscreenCanvas when supported).
   - Server frame sampling: during video sessions upload own downscaled frame at the server-assigned `frameIntervalMs` (± 20 % jitter; first frame at a random point within the first interval); no uploads when it is `null`; apply interval updates from `system:notice`.
   - Banned/blocked UX; message-blocked UX.

**Required tests:** text filter cases (incl. obfuscation like `w w w . x . c o m`), trust rules, risk-tier interval assignment (incl. group calls → `high`, report → switch to `high`), budget multiplier stretches low tiers first and never `high` beyond 2×, frame uploads faster than the assigned interval rejected, missing-upload penalty, report endpoint (non-participant rejected, frame validation, transcript snapshot, priority), worker flows with mock classifier (flag → ban → `gw:control` message), gateway reacts to `ban_applied` across nodes, shadow-banned visitors only match each other.

**Acceptance criteria:** a report from the UI appears in Postgres with evidence in MinIO; forcing a flag via `DEV_FORCE_FLAG_VISITOR_IDS` shadow-bans that visitor live and they are only matched with shadow-pool bots; link messages are blocked; quality gate green.

**Manual check:** chat in two windows, send a link (blocked), report the other window (check MinIO + Prisma Studio), force-flag a visitor and confirm they're moved to the shadow pool.

**Out of scope:** admin UI (Part 9).

**Update CONTEXT.md:** moderation architecture, thresholds and env vars, privacy behavior (what is stored, where, TTLs), production gaps (age assurance vendor, real hash matching, human review staffing, NCMEC reporting process).

---

## PART 9 — Admin & moderation dashboard

**Paste:** `Execute Part 9 of MASTER_IMPLEMENTATION_PROMPT.md`

**Goal:** `apps/admin` for moderators to review reports, act on users, and monitor the live system — fully audited.

**Tasks**
1. API `/v1/admin/*` (cookie session auth, separate from visitor JWT; CSRF protection via `SameSite=Lax` + required custom header `x-admin-csrf` checked against the session):
   - `POST /auth/login` (argon2id verify, constant-time failure path, rate limit 5/min per IP hash + per email, lockout after repeated failures), `POST /auth/logout`, `GET /auth/me`, TOTP: `POST /auth/totp/setup` (otplib, QR as data URL), `POST /auth/totp/verify`; when `totpEnabled`, login requires the code. TOTP secret encrypted at rest (AES-256-GCM with `ADMIN_TOTP_ENC_KEY`).
   - Reports: list with filters (status, reason, priority, date) + cursor pagination; detail (report, transcript, evidence via **presigned MinIO URLs valid 5 min**, reporter/reported history: prior reports, moderation events, bans, session count); actions: assign to me, dismiss, action (ban HARD/SHADOW with duration presets, trust adjustment), add note.
   - Bans: list/search (by visitorId), create, revoke.
   - Moderation events feed with filters.
   - Visitors: lookup by id → profile (trust, bans, reports, sessions — metadata only).
   - Live stats: online (presence), queue lengths per pool/mode/lang, active sessions count, matches per minute (last 60 min from `stats:matches:*`), open reports by priority.
   - Admin users (ADMIN only): list, create, disable, reset TOTP.
   - Every mutating action writes `AuditLog` in the same transaction.
   - RBAC: MODERATOR may review, dismiss, shadow-ban, and hard-ban up to 30 days; ADMIN everything.
2. Admin UI (Next.js, port 3001), built with `@app/ui` plus dashboard components sourced via the `21st` MCP (sidebar/app shell, data table with sorting/filtering/pagination, stat cards, line chart, OTP input, filter chips, confirmation dialogs, command palette for search) — follow **Frontend UI components (21st.dev)** in the Reference Design; the admin CSP forbids any third-party asset, so self-host everything. Screens: login (+TOTP step), dashboard with stat cards and matches-per-minute chart (auto-refresh 5 s), reports queue table (sortable, filter chips, priority badges), report detail page with **evidence blurred by default and click-to-reveal** (moderator wellbeing), transcript view, action panel with confirmation dialogs, bans page, visitor page, audit log page, admin users page (ADMIN only). Keyboard shortcuts for queue triage (j/k to move, d dismiss, s shadow-ban) with visible hints.
3. `noindex` headers, strict CSP, no third-party scripts in admin.

**Required tests:** auth (wrong password, lockout, TOTP required/valid/invalid), RBAC matrix, CSRF header required, audit log written for each action, presigned URLs only for evidence of the requested report, ban action publishes `ban_applied` and the gateway disconnects the user.

**Acceptance criteria:** moderator can log in with the seeded admin, open a report created in Part 8, view blurred evidence, hard-ban the user, and the user's live session ends immediately; audit log shows the action; quality gate green.

**Manual check:** http://localhost:3001 → log in → process a report → verify the banned window gets the blocked screen.

**Out of scope:** SSO, appeals workflow (note as TODO).

**Update CONTEXT.md:** admin API table, RBAC matrix, security measures, new env vars (`ADMIN_TOTP_ENC_KEY`), how to create admins.

---

## PART 10 — Hardening, observability, testing & developer experience

**Paste:** `Execute Part 10 of MASTER_IMPLEMENTATION_PROMPT.md`

**Goal:** Make the development build robust, observable, tested end-to-end, load-tested, containerized and ready to start the production phase.

**Tasks**
1. **Security pass** (fix everything found, record in CONTEXT):
   - CSP for web (self, gateway/API origins incl. `ws:`/`wss:`, `challenges.cloudflare.com` for Turnstile, `blob:`/`mediastream:` for media, `wasm-unsafe-eval` only if TF.js needs it) and admin (stricter); HSTS (prod only), `Referrer-Policy`, `Permissions-Policy` (camera/mic self only), `X-Content-Type-Options`, frame-ancestors none.
   - Audit every HTTP route and socket event: auth, Zod validation, size limits, rate limits, membership checks. Produce a table in CONTEXT.md.
   - Verify logs contain no tokens/IPs/device IDs/message text (add a test that scans log output of an integration run).
   - `pnpm audit` and fix high/critical; optional `gitleaks` scan in CI.
   - Run the `/security-review` style checklist mentally on: JWT handling, CORS/Origin, CSRF (admin), SSRF (TURN `denied-peer-ip` in prod config, no server-side fetching of user URLs), file upload validation, presigned URL scope, Redis Lua inputs, Prisma raw queries (none).
2. **Observability:**
   - `prom-client` `/metrics` on api, gateway, worker: HTTP latency histograms, sockets connected, events/sec by type, rate-limit hits, queue lengths, **time-to-match histogram**, matches total, session duration histogram, `rtc:summary` aggregates (connected %, relay %, time-to-connected), reports total, moderation actions, BullMQ job durations/failures.
   - Docker Compose profile `observability`: Prometheus (scraping host services) + Grafana (port 3002) with a provisioned dashboard JSON for the metrics above.
   - Structured logs carry `requestId` / `socketId` / `sessionId` correlation fields. Optional OpenTelemetry tracing behind a flag.
3. **Testing:**
   - Coverage targets: `packages/matchmaking` ≥ 90 % lines, `packages/moderation` ≥ 90 %, apps ≥ 70 % for business logic.
   - Playwright E2E in `e2e/` (Chromium with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, two browser contexts): text chat flow; video connects (assert via a `data-rtc-state="connected"` attribute **and** that the remote `<video>` has `videoWidth > 0`, proving `ontrack` fired); a gateway restart mid-call keeps the video connected and text resumes; a tab that never acks a match doesn't block the other user; Next re-matches; report flow creates a report; hard-banned visitor sees blocked screen; admin bans a live user.
   - Root `pnpm test:e2e` that boots required services (or documents how).
4. **Load testing:** extend `tools/bots` with a `load` mode (ramp-up, target clients, skip-rate distribution, video-signaling simulation with fake SDP/ICE payload sizes, messages/sec) reporting p50/p95/p99 time-to-match, message delivery latency, error rates, and gateway CPU/memory (from `/metrics`). Run locally with 2 gateway nodes at 2,000 and 5,000 clients (or the max the machine handles), with `MM_BUCKETS` 1 vs 8, and **record results in CONTEXT.md** (incl. per-bucket match rates, hops per match, p99 time-to-match, Redis ops/s per key family), plus the projected node, Redis-shard and bucket counts for 1M concurrent. Add a Redis hot-key check (e.g. `redis-cli --hotkeys` with an LFU policy in a test run, or per-key-family op counters) and confirm no single key family dominates.
5. **Resilience checks:** kill one gateway node during a bot run → clients reconnect to the other and **resume their sessions** (none end), no stuck sessions, tickets or deadlines; restart Redis → services recover; worker restart → no lost jobs.
6. **Containers:** multi-stage Dockerfiles for api, gateway, worker, web, admin (`turbo prune`, non-root user, `HEALTHCHECK`, minimal runtime image, Next.js standalone output). Compose profile `full` runs the entire stack in containers.
7. **CI:** GitHub Actions workflow: pnpm cache, install, lint, typecheck, unit + integration tests (Postgres + Redis service containers, `db:deploy` on test DB), build; separate job for Playwright (can be manual-trigger). Dependabot config.
8. **Docs:** finalize `README.md` (setup, run modes, testing, load testing, troubleshooting incl. macOS/coturn/HTTPS for LAN), and create `docs/PRODUCTION_CHECKLIST.md` covering: legal review (COPPA, GDPR, DSA, UK Online Safety Act, India IT Rules, US 18 U.S.C. §2258A NCMEC reporting), age-assurance vendor, real CSAM hash matching (PhotoDNA/Thorn Safer), human moderation staffing & wellbeing, Kubernetes + HPA on connection count, Redis Cluster sizing (keys are already hash-tagged; queue buckets per family; sharded deadlines/counters; replicas + automatic failover), PgBouncer, **session analytics off Postgres** (session-log events via Redis Streams or Kafka, batch-inserted into ClickHouse; shard BullMQ queues by hash tag; Postgres keeps reports/bans/visitors), **multi-region** (regional gateways/Redis/TURN/Janus, `MM_REGION` matching local-first with neighbour-region fallback, GeoDNS/anycast), **scale validation to 1M** (distributed bot fleet on 100+ machines to 1M sockets and ~22k matches/s, headless WebRTC media load through TURN and Janus, failure drills under load: Redis primary, gateway node, Janus node, whole region), GPU/ML capacity for frame classification within `MOD_FRAME_BUDGET_PER_SEC`, Janus fleet sizing, bare-metal TURN fleet with `denied-peer-ip`, TURN over TLS 443, GeoDNS/multi-region matchmaking, CDN/WAF/DDoS, secrets manager, backups & DR, data retention jobs, incident response, penetration test.

**Acceptance criteria:** all E2E tests pass; load test results recorded; `docker compose --profile full up` runs the whole stack; CI workflow valid; quality gate green.

**Manual check:** open Grafana at http://localhost:3002 during a bot load run and watch time-to-match and sockets; run `pnpm test:e2e`.

**Out of scope:** real cloud deployment.

**Update CONTEXT.md:** final status (all parts complete), security audit table, metrics list, load test results and capacity projection, remaining production gaps linked to `docs/PRODUCTION_CHECKLIST.md`.

---

## PART 11 — Janus SFU & call topology switch

**Paste:** `Execute Part 11 of MASTER_IMPLEMENTATION_PROMPT.md`

**Prerequisite:** Parts 1–10 complete.

**Goal:** Video calls can run through a **Janus VideoRoom** (SFU) instead of P2P, and a running 2-person P2P call can switch to Janus mid-call without a visible drop. This is the media foundation for 3–4-person calls (Part 12). 2-person calls stay P2P by default.

**Why Janus for groups:** with 4 people in a P2P mesh each browser encodes and uploads its video 3 times over 6 fragile connections — unreliable on phones and mobile data. With Janus each user uploads once (~0.6 Mbps) and Janus forwards without re-encoding (~2 Mbps in / ~6 Mbps out per 4-person room). Janus has no built-in clustering, so this part builds the node registry, room placement, health checks and failover.

**Tasks**
1. **Janus in Docker** (`infra/docker/janus/`):
   - There is no official image: build Janus from a **pinned stable release tag** in a multi-stage Dockerfile with only what is needed — core, VideoRoom plugin, WebSocket transport (client port 8188, admin port 7188). Disable the HTTP/REST transport, data channels and all other plugins. Pin the dependency versions (libnice, libsrtp2, libwebsockets, jansson, libconfig) and record them in `CONTEXT.md`.
   - `janus.jcfg`: `nat_1_1_mapping` from `JANUS_PUBLIC_IP`, RTP port range 20000–20100 (published 1:1, UDP), `token_auth = true` with `token_auth_secret = JANUS_TOKEN_SECRET` (signed tokens), admin API protected by `admin_secret`, sensible `session_timeout`, debug level from env.
   - `janus.plugin.videoroom.jcfg`: no static rooms; `admin_key = JANUS_ADMIN_SECRET` so only our backend can create rooms; `lock_rtp_forward = true`.
   - The admin WebSocket (7188) is bound to localhost / the internal Docker network only — browsers never reach it.
   - Add `janus` to `pnpm infra:up` (with a healthcheck) and a second node `janus-2` under compose profile `sfu-multi` for placement/failover tests. Document macOS Docker Desktop caveats the same way coturn's are documented.
2. **`packages/sfu`** (server-only):
   - Typed Janus admin client over WebSocket (transactions, timeouts, reconnect, Zod-validated responses): `ping`, `createRoom`, `destroyRoom`, `allowTokens` (VideoRoom `allowed` list), `listRooms`.
   - Room creation: random numeric room id, random room `secret`, `publishers = 4`, `bitrate = SFU_PUBLISHER_BITRATE`, `notify_joining = true`, `require_pvtid = true`, VP8 + Opus, simulcast allowed, `audiolevel_event` on, recording off, and an `allowed` list containing one fresh token per participant.
   - Join tokens: Janus **signed tokens** (`<expiry>,janus,janus.plugin.videoroom:<HMAC-SHA1 signature>` per Janus's token format) valid 10 minutes and restricted to the VideoRoom plugin, **plus** membership in the room's `allowed` list — so a token is useless for any other room.
   - Node registry: `JANUS_NODES` from env; a health checker in the gateway (one leader at a time via `SET NX PX` lock) pings every node's admin API every 5 s and updates `sfu:nodes` (healthy, room count). Placement = healthy node with the fewest rooms.
   - Orphan cleanup: rooms in `sfu:rooms` whose session has ended are destroyed by the sweeper; rooms that exist on a node but not in `sfu:rooms` are destroyed too.
3. **Gateway orchestration:**
   - `upgradeToSfu(sessionId)`: atomically set `topologyState = upgrading` (no double upgrades), create the room, store `sfuNodeId`/`sfuRoomId`, increment `topologyEpoch`, emit `call:topology { topology: 'sfu', epoch, sfu }` to every active participant (each with its own token). When every participant sent `call:topologyReady { epoch }` → `topology = sfu`, `topologyState = stable`. If not all are ready within `SFU_UPGRADE_TIMEOUT_MS`, or room creation fails → destroy the room, emit `call:topology { topology: 'mesh', reason }`, keep the P2P call running.
   - New sessions can start directly on `sfu` (`match:found` with `topology: 'sfu'` and `sfu` info) — used when `DEV_FORCE_SFU=true` and by Part 12.
   - A call never switches back from `sfu` to `mesh`, even if it shrinks to 2 people.
   - Session end destroys the room. A participant leaving an SFU call is removed from the room's `allowed` list (kick from the room via the admin API).
   - **SFU failover:** when the health checker marks a node unhealthy, every active session on it gets a new room on a healthy node and a new `call:topology` (`epoch + 1`); clients rejoin. Expect a few seconds of interruption; the session itself survives (works together with Session resilience).
   - `rtc:*` relay is rejected for sessions whose topology is `sfu`.
   - Dev-only trigger (registered only when `NODE_ENV=development`): socket event `dev:upgradeToSfu { sessionId }` so the switch can be tested with two people.
4. **Web client — `SfuTransport`** (behind the `CallManager` transport interface from Part 7):
   - Talk to Janus with the official `janus.js` from the **same pinned Janus release** (vendored and wrapped in a typed module) or a small typed client for the Janus WebSocket API — choose one and record it.
   - One **publisher** PeerConnection (local audio + video, simulcast with 3 layers, `display` = own `participantId`) and one **multistream subscriber** PeerConnection receiving all other feeds. Map feeds to participants by `display`; ignore feeds whose `display` isn't a current session participant.
   - Pass the same ICE servers (coturn credentials) to Janus PeerConnections for users on restrictive networks.
   - Subscribe to a simulcast layer per tile size (high for a large tile, low for small tiles); switch layers on layout changes.
   - Keepalive the Janus session; on Janus WebSocket loss, reconnect and rejoin the room with the same token while it is valid; otherwise wait for the gateway's failover `call:topology`.
   - **Make-before-break:** on `call:topology sfu` keep the `MeshTransport` playing, join Janus, and only when media from every current peer arrives through Janus swap the tiles, close the P2P connections and send `call:topologyReady`. On rollback, close the Janus side and keep P2P.
   - The Part 7 WebRTC lifecycle rules apply to `SfuTransport` too.
5. **Moderation hooks:** existing client-side checks (NSFW, frame sampling, reports) must work identically on SFU calls. Document (do not build) how `rtp_forward` could feed a server-side moderation service in production.
6. **Metrics:** SFU rooms active, upgrade attempts/successes/rollbacks, upgrade duration, failovers, per-node room count and health, Janus admin API latency.

**Required tests:** `packages/sfu` integration tests against the real Janus container (create/destroy room; joining without a token, with an expired token, or with another room's token is rejected; admin API rejects a wrong secret); placement picks the least-loaded healthy node; health checker marks a stopped node unhealthy (profile `sfu-multi`); upgrade flow with a mocked Janus (ready → stable; timeout → rollback; concurrent upgrade requests → one upgrade); failover moves sessions to the other node; orphan rooms destroyed; `SfuTransport` unit tests with a mocked Janus client (feed ↔ participant mapping, unknown feeds ignored, make-before-break order); Playwright: a 2-person call with `DEV_FORCE_SFU=true` shows remote video (`videoWidth > 0`) and `chrome://webrtc-internals`-equivalent stats show the remote endpoint is Janus.

**Acceptance criteria:**
- With `DEV_FORCE_SFU=true`, two windows video chat through Janus.
- A P2P call upgraded via `dev:upgradeToSfu` switches to Janus with no visible freeze longer than ~1 s; a forced failure rolls back and the P2P call keeps running.
- With profile `sfu-multi`, stopping the node hosting a call moves it to the other node and the call recovers within a few seconds.
- Janus admin port is not reachable from the browser; no room can be joined without a valid token for that room.
- Quality gate green.

**Manual check:** `pnpm infra:up`, start everything with `DEV_FORCE_SFU=true`, call between two windows; then without the flag, start a P2P call and trigger the upgrade from the browser console (dev event); with `--profile sfu-multi`, `docker stop` the Janus node in use during a call.

**Update CONTEXT.md:** Janus version + build details, ports, env vars, `sfu:*` keys, events `call:topology` / `call:topologyReady`, token scheme, upgrade/rollback/failover behavior, macOS Docker caveats, metrics, capacity notes.

---

## PART 12 — Group video: add a 3rd and 4th random person

**Paste:** `Execute Part 12 of MASTER_IMPLEMENTATION_PROMPT.md`

**Prerequisite:** Part 11 complete.

**Goal:** People in a video call can jointly agree to add another random stranger, up to **4 people per call**. Group calls run on Janus (Part 11); 2-person calls stay P2P until a group is formed.

**Tasks**
1. Product rules (all enforced server-side):
   - **Consent from everyone in the call:** `call:requestAdd { sessionId }` → the others receive `call:addRequested`; each answers `call:respondAdd { sessionId, accept }`. The request expires after 15 s; anyone can cancel. When all agree: if the call is still `mesh`, run `upgradeToSfu` first (the switch is hidden behind the search wait); then `state = seeking` and everyone receives `call:seeking`.
   - Joiners come **only** from users who opted in: `queue:join { ..., allowGroup: true }` (landing-page toggle, off by default).
   - Eligibility: video mode, same lang, not in the shadow pool, trust ≥ `GROUP_MIN_TRUST` for **every** participant and the joiner.
   - `maxParticipants = 4`; "Add a person" is disabled at 4. Seeking times out after `SEEK_PARTICIPANT_TIMEOUT_MS` → `call:seekCancelled { reason }`, the call continues (on Janus) with the current people.
   - One seek at a time per session; each new person requires a fresh consent round from everyone present.
2. Matchmaking: hash-tagged queue `{tag}:q:seek` of sessions seeking a participant (entry stores sessionId + all current participants' visitorIds for recent-pair checks). Lua `matchJoiner`: opted-in solo tickets check `q:seek` first, then fall back to normal 1:1 matching; a session entering `seeking` checks waiting opted-in solo tickets. Atomic, stale-skipping, avoids recent pairs with **any** existing participant. Adding the participant is a second Lua step over `{<sessionId>}` (enforce `maxParticipants`); if it fails (session ended or full meanwhile), put the solo ticket back at the head of its queue.
3. Gateway: on a joiner match, add the participant (status `pending`, normal `match:ack` rules), add a token for them to the Janus room's `allowed` list, emit `match:found` to the joiner with `topology: 'sfu'`, the peers and their own `sfu` join info, and `participant:joined` to everyone else. Text fan-out, leave, resume and report logic already work over the participant list: when someone leaves, the rest continue while ≥ 2 remain (still on Janus). `chat:next` in a group call means "leave this call and find a new one".
4. Web: "Add a person" button + consent banner ("Stranger 2 wants to add someone — Accept / Decline"), "Looking for another person…" state, responsive grid for 2–4 tiles (2×2 on desktop, stacked/scrollable on mobile) labeled "Stranger 1/2/3", per-tile Report, quality badge and client NSFW check, active-speaker highlight from Janus audio-level events, simulcast layer per tile size.
5. Safety & admin: reports target a specific participant; transcripts show which stranger sent each line; admin report view lists all participants of the session; an auto-flag or ban removes only the flagged participant (kicked from the Janus room).
6. Metrics: add-person requests, consent rate, seek success rate, time-to-join, group sizes, group session duration.

**Required tests:** `matchJoiner` concurrency (a session never gets more joiners than free slots; a solo ticket never joins two sessions); consent required from everyone present; ineligible users (no opt-in, low trust, shadow pool) never join; joining a full session is rejected; a P2P call is upgraded to Janus before seeking; one leave keeps the others connected; banned participant is removed from the room; Playwright E2E with **four** browser contexts (fake media): A+B match → both consent → C joins → all three consent → D joins → all four see each other (`videoWidth > 0` on every remote tile) → D leaves → A, B, C continue.

**Acceptance criteria:** the four-person flow above works locally; consent and eligibility rules hold; the "Add a person" button is disabled at 4; quality gate green.

**Manual check:** four browser windows (normal, incognito, two more browser profiles) — run the flow above.

**Update CONTEXT.md:** new events (`call:requestAdd`, `call:addRequested`, `call:respondAdd`, `call:seeking`, `call:seekCancelled`), Redis keys, env vars (`GROUP_MIN_TRUST`, `SEEK_PARTICIPANT_TIMEOUT_MS`), group-call rules, metrics.

---

## After Part 10 (and Parts 11–12)

The development build is complete. Next phase (separate plan): production infrastructure (Terraform + Kubernetes), staging environment, real vendors for age assurance and hash matching, bare-metal TURN, multi-region rollout, mobile apps. Ask the agent: *"Read CONTEXT.md and docs/PRODUCTION_CHECKLIST.md and write PRODUCTION_PLAN.md broken into parts like MASTER_IMPLEMENTATION_PROMPT.md."*

# RandomChat — developer guide

Everything needed to run, test and load-test RandomChat on one machine. The project overview and
the production deployment guide are in the [README](../README.md).

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

| Command                        | What it does                                                           |
| ------------------------------ | ---------------------------------------------------------------------- |
| `pnpm dev`                     | Run all apps in watch mode (web, admin, API, one gateway, worker)      |
| `pnpm build`                   | Build all apps                                                         |
| `pnpm lint`                    | ESLint (type-aware) in every package                                   |
| `pnpm typecheck`               | `tsc` in every package                                                 |
| `pnpm test`                    | Vitest in every package                                                |
| `pnpm format` / `format:check` | Prettier write / check                                                 |
| `pnpm infra:up`                | Start infrastructure, wait until healthy, create MinIO buckets         |
| `pnpm infra:down`              | Stop infrastructure (keeps data)                                       |
| `pnpm infra:reset`             | Stop infrastructure and **delete all data volumes**                    |
| `pnpm infra:logs` / `infra:ps` | Follow logs / show container status                                    |
| `pnpm db:migrate` / `db:seed`  | Apply migrations / load idempotent dev data (`db:studio` to browse)    |
| `pnpm db:generate`             | Regenerate the Prisma client after editing the schema                  |
| `pnpm test:coverage`           | Tests with coverage thresholds (CI runs this)                          |
| `pnpm test:e2e`                | Build, boot the stack, run the Playwright suite (see Testing)          |
| `pnpm obs:up` / `obs:down`     | Prometheus (9090) + Grafana (3002) for the running services            |
| `pnpm stack:up` / `stack:down` | Every app in a container (Compose profile `full`)                      |
| `pnpm admin:create`            | Create or reset an admin (`ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_ROLE`) |
| `pnpm bots -- …`               | Chat-flow correctness bots (see Load testing for the `load` mode)      |

Quality gate before committing: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
`@app/db`, `@app/redis`, `@app/matchmaking`, `@app/moderation`, `@app/storage`, `@app/api`,
`@app/gateway` and `@app/worker` tests are integration tests: run `pnpm infra:up` first.

## Run modes

| Mode              | How                                    | Notes                                                                                                                                                                                                                                           |
| ----------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Development       | `pnpm dev`                             | Watch mode: web 3000, admin 3001, API 4000, one gateway 4001, worker (metrics 4002)                                                                                                                                                             |
| Two gateways      | `pnpm --filter @app/gateway dev:multi` | gw-4001 + gw-4011 (stop the single gateway first)                                                                                                                                                                                               |
| Production builds | `pnpm build`, then each app's `start`  | Bundled Node services, `next start` for web/admin                                                                                                                                                                                               |
| Containers        | `pnpm stack:up` / `pnpm stack:down`    | Builds `apps/*/Dockerfile`, runs migrations, starts everything on the same ports with `NODE_ENV=production` (stop the dev servers first). Production rate limits apply: all browsers on this machine share one IP for the 10 sessions/min limit |
| Observability     | `pnpm obs:up`                          | Grafana <http://localhost:3002> (dashboard "RandomChat — overview", viewers need no login), Prometheus <http://localhost:9090>; scrapes both the host services and the containers                                                               |

Every Node service exposes `/metrics` (Prometheus text format): API and gateway on their own
port, the worker on `WORKER_METRICS_PORT` (4002) together with `/health`. With `METRICS_TOKEN`
set they require `Authorization: Bearer <token>`; with `DEPLOY_ENV=production` and no token the
endpoint is off.

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
[21st.dev](https://21st.dev) via the `21st` MCP (provenance in each file).

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
- Phones and other devices on the LAN: see [`docs/LAN_TESTING.md`](./LAN_TESTING.md)
  (the camera needs https or localhost).

### Trust & safety

- Links, emails, phone numbers and "add me on …" requests are blocked before they reach the
  stranger (also obfuscated forms like `w w w . x . c o m`); slurs are blocked, other
  profanity is masked.
- **Report** (flag button) ends the chat and sends the recent messages — and, in video, the
  stranger's last few frames, which the browser kept in memory only — to the moderation queue.
  Check the result in `pnpm db:studio` (`Report`, `Evidence`) and in the MinIO console
  (<http://localhost:9001>, bucket `evidence`).
- Video is sampled server-side by risk tier (new visitors, low trust or recent reports more
  often); the worker classifies frames (mock classifier in development) and shadow-bans
  above the threshold. Shadow-banned or low-trust visitors only meet each other.
- To see a live shadow ban: create a session for a known device id
  (`curl -X POST localhost:4000/v1/session …`, see the API section), start the worker with
  `DEV_FORCE_FLAG_VISITOR_IDS=<that visitorId> pnpm --filter @app/worker dev`, then video chat
  as that device (`localStorage['rc.deviceId']`). Its first sampled frame is flagged and the
  chat ends silently; from then on it is matched only within the shadow pool.

Overrides for `pnpm dev` go in `.env`: Turborepo runs tasks in strict env mode, so variables
set on the command line (`FOO=1 pnpm dev`) do not reach the apps. To override one app only, run
it directly, e.g. `RECENT_PAIR_TTL_MS=0 pnpm --filter @app/gateway dev`.

## Admin dashboard (`apps/admin`, port 3001)

```bash
pnpm db:seed                 # dev admin from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD (.env)
pnpm dev                     # also starts the admin app on http://localhost:3001
```

Sign in with the seeded admin. The dashboard shows live stats (online, active chats, queues,
matches per minute, open reports) refreshing every 5 s. **Reports** is the review queue (filter
chips, priority badges; `j`/`k` to move, `Enter` to open, `d` dismiss, `s` shadow-ban — both
ask for confirmation). A report page shows the transcript, the evidence frames **blurred until
you click them**, both visitors' history and the decision panel (shadow or hard ban with
duration presets, trust adjustment, notes). Bans, moderation events, visitor profiles, the
audit log and admin accounts have their own pages; ⌘K / Ctrl+K jumps to a page, a visitor id
or a report id. Turn on two-factor authentication under **Settings**.

Create admins in the UI (**Admin users**, ADMIN only) or from the command line — the only
way to bootstrap the first admin in production, where the seed refuses to run:

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='at least 12 chars' ADMIN_ROLE=ADMIN pnpm admin:create
```

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

Consumes BullMQ jobs: `session-log` (session metadata rows, never messages), `classify-frame`,
`moderation-event`, `report-filed` and an hourly `retention` job that deletes expired evidence and
old transcripts. `/health` and `/metrics` on port 4002.

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

## Testing

- **Unit + integration:** `pnpm test` (needs `pnpm infra:up`; each package has its own Redis DB
  index so packages run in parallel). `pnpm test:coverage` enforces the thresholds:
  `@app/matchmaking` and `@app/moderation` ≥ 90 % of lines, the apps' business logic ≥ 70 %.
  Log-privacy tests scan API and gateway logs of a full flow for tokens, raw IPs, device ids
  and chat text.
- **End to end:** `pnpm test:e2e` builds the apps, starts API, gateway, worker, web and admin
  from the builds on the usual ports (stop `pnpm dev` first), creates an e2e admin and runs
  `e2e/tests/*.spec.ts` in Chromium with fake camera/microphone: text chat, video (connected
  per `data-rtc-state` and remote frames), a gateway restart mid-call, a tab that never acks,
  Next with three strangers, reporting, a banned visitor and a moderator banning a live user.
  Needs `pnpm infra:up` and internet (Cloudflare Turnstile test key). Browser: run
  `pnpm --filter @app/e2e exec playwright install chromium` once, or use an installed Chrome
  with `E2E_BROWSER_CHANNEL=chrome pnpm test:e2e`. `E2E_REUSE_STACK=1` tests whatever is already
  running instead (the gateway-restart test is then skipped). Reports and traces end up in
  `e2e/test-results/`.
- **CI** (`.github/workflows/ci.yml`): lint, typecheck, tests with coverage (Postgres + Redis
  service containers, MinIO), build, `pnpm audit`, a gitleaks scan and a check that the
  production TURN config keeps its SSRF rules. The e2e workflow (`e2e.yml`) is manual.

## Load testing

`tools/bots` has a `load` mode for many clients. Bots mint visitor tokens locally with
`JWT_SECRET` (no API calls, no Turnstile), so only the gateways and the worker need to run —
best from builds, with a raised handshake limit because every bot shares 127.0.0.1:

```bash
pnpm --filter @app/gateway build
cd apps/gateway
GATEWAY_PORT=4001 GATEWAY_NODE_ID=gw-a MM_BUCKETS=8 HANDSHAKE_LIMIT_PER_IP=10000000 LOG_LEVEL=warn node dist/server.js &
GATEWAY_PORT=4011 GATEWAY_NODE_ID=gw-b MM_BUCKETS=8 HANDSHAKE_LIMIT_PER_IP=10000000 LOG_LEVEL=warn node dist/server.js &
cd ../..
pnpm --filter @app/bots load -- --clients 5000 --ramp 30 --duration 60 --workers 6 \
  --gateways http://localhost:4001,http://localhost:4011 --json /tmp/load.json
```

Options: `--video-share` (0.5; video bots exchange fake SDP of `--sdp-bytes` and `--ice-count`
candidates), `--session-mean` (s, exponential → skip rate), `--msg-rate` (messages/s per bot),
`--lang`. The report has p50/p95/p99 time to match and message latency, ack errors by code and,
per gateway from `/metrics`, CPU, peak memory, sockets, matches/s per queue bucket, hops per
match and sessions ended by reason. Watch it live in Grafana (`pnpm obs:up`).

Redis inspection during or after a run:

```bash
pnpm --filter @app/bots inspect -- monitor --seconds 10   # ops/s per key family + hottest keys
pnpm --filter @app/bots inspect -- keys                   # key families + stuck-state check
```

Results of the Part 10 runs (2 nodes, 2,000 and 5,000 clients, 1 vs 8 buckets, hot keys,
gateway kill / Redis restart / worker kill drills) and the 1M projection are summarised in the
README ("Scaling").

## Troubleshooting

- **A port is busy** (`EADDRINUSE`, or `pnpm test:e2e` refuses to start): another dev server or
  the container stack still runs — `pnpm stack:down`, Ctrl-C `pnpm dev`, or find it with
  `lsof -nP -iTCP:<port> -sTCP:LISTEN`. Killing the child of `tsx watch` leaves the watcher.
- **`/v1/session` returns 503 or the bot check never finishes:** Cloudflare Turnstile needs
  internet even with the test keys.
- **`RATE_LIMITED` on session creation:** 10 sessions/min per IP. `RATE_LIMIT_DISABLED=true` in
  `.env` lifts it, but only with `NODE_ENV=development` (never in the containers).
- **Video never connects between two machines:** see `docs/LAN_TESTING.md` — the camera needs
  https (or a Chrome flag) on non-localhost origins, and coturn must advertise the LAN IP
  (`TURN_EXTERNAL_IP`) and listen on it (`TURN_BIND_IP=0.0.0.0`). On macOS, relay↔relay works
  between browsers on the same Mac; mixed relay↔host can fail under Docker Desktop's NAT.
- **Headless Chrome hangs when starting video on macOS:** it hangs capturing even fake audio;
  the e2e suite synthesizes the microphone with Web Audio (real browsers are fine).
- **Overrides on the command line are ignored by `pnpm dev`:** Turborepo's strict env mode passes
  only `.env`; run that app directly instead (see above).
- **Gateway `/health` is 503 `subscriber_stuck`:** its Socket.io adapter subscriber stopped
  answering Redis, so cross-node delivery fails; the process should be restarted (see D-101).

## Layout

```
apps/        web (Next.js), admin (Next.js), api (Fastify REST), gateway (Socket.io), worker (BullMQ);
             each with a Dockerfile
packages/    config, env, logger, metrics (Prometheus), shared, ui (React kit), db (Prisma), redis,
             matchmaking (Lua), moderation (text filter, bans, trust, sampling), storage (S3/MinIO)
e2e/         Playwright suite + stack harness
infra/docker docker-compose.yml (profiles: default infra, observability, full), coturn, Postgres and
             MinIO init, Prometheus config, Grafana provisioning + dashboard
infra/coturn turnserver.production.conf (production TURN template)
tools/bots   socket bots: `connect`, `bots` (correctness), `load` (load mode), `inspect` (Redis)
docs/        DEVELOPMENT.md, LAN_TESTING.md
.github/     CI and e2e workflows, Dependabot
```

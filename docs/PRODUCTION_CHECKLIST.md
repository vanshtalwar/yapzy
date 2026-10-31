# RandomChat production checklist

This is the hand-off checklist for the production phase: everything outside this development build
that must be done before RandomChat serves real users, each item with what to do, why, and where it
plugs into the existing code or configuration. Use it as the input for `PRODUCTION_PLAN.md` (see the
end of `MASTER_IMPLEMENTATION_PROMPT.md`) and tick an item only once it is done in a real
environment. `CONTEXT.md` is the source of truth for the current state (decisions, known issues,
load-test results); where the two disagree, `CONTEXT.md` wins and this file should be corrected.

Tags: **[Blocker]** launch blocker, must be done before real users · **[Scale]** needed before
traffic grows past what staging has validated · **[Later]** can follow launch · **[Groups]** needed
before group video calls go live (Janus, Parts 11–12, not built yet). References: `§N` = section of
`CONTEXT.md`, `D-NNN` = decision in `CONTEXT.md` §14, `Part N` = `MASTER_IMPLEMENTATION_PROMPT.md`.

## Capacity targets (1M concurrent)

| What              | Design target at 1M concurrent users                                            | Source             |
| ----------------- | ------------------------------------------------------------------------------- | ------------------ |
| Sockets           | 1M live sockets (one per visitor)                                               | Part 10 task 8     |
| Match rate        | ~22k matches/s overall; ~15k/s in the busiest family (`video:en`)               | Part 10, D-052     |
| Queue buckets     | 32–64 per busy queue family, 1–4 per small one (`MM_BUCKETS_BY_QUEUE`)          | Reference Design   |
| Hot-key sharding  | ~50k ops/s would hit one deadline ZSET or match counter → `DEADLINE_SHARDS` 64  | D-053              |
| Moderation frames | ~23k frames/s if every video user were sampled every 30 s → capped by a budget  | Part 8, D-054      |
| P2P media         | video sender capped at 800 kbps; coturn relays only when P2P fails or is forced | §6 (Part 7), D-004 |
| SFU media (Janus) | ~0.6 Mbps up per publisher; ~2 Mbps in / ~6 Mbps out per 4-person room          | Part 11            |

These are design targets, not measurements. The real frame load is whatever
`MOD_FRAME_BUDGET_PER_SEC` allows (dev: 50); its production value must come from measured classifier
capacity. Measured local numbers and the projected gateway-node, Redis-shard and bucket counts for
1M are in `CONTEXT.md` §"Load test results" (Part 10): size the first region from them, then
replace them with staging measurements (see Scale validation).

## Required production configuration

Names are final. `CONTEXT.md` §8 lists every variable with its development default.

- [ ] **[Blocker]** Run every service with `NODE_ENV=production` and `DEPLOY_ENV=production`
      (`staging` in staging): `NODE_ENV` makes the admin cookie `Secure` and turns dev switches off;
      `DEPLOY_ENV` tells a real deployment from a local `next build` (D-063). With
      `DEPLOY_ENV=production` the services refuse to start with `NODE_ENV≠production` or with the
      `.env.example` placeholder secrets (`dev-only…`, `…change-me`, all-zero keys).
- [ ] **[Blocker]** Turnstile: `DEPLOY_ENV=production` refuses the test keys and requires
      `TURNSTILE_HOSTNAMES` (comma list); siteverify results with an unlisted `hostname` or, in
      production, without the widget `action` `session` are rejected
      (`apps/api/src/services/turnstile.ts`).
- [ ] **[Blocker]** `METRICS_TOKEN`: bearer token for `/metrics` on api, gateway and worker
      (`WORKER_METRICS_PORT`, default 4002); unset in production disables `/metrics`. Prometheus
      scrapes with the token; never expose `/metrics` through the public ingress.
- [ ] **[Blocker]** Evidence/transcript retention job (worker): confirm it runs in production,
      deletes expired evidence objects and rows after 90 days (`EVIDENCE_RETENTION_DAYS`,
      `packages/moderation/src/reports.ts`) and never touches `expiresAt = null` (hash matches).
- [ ] **[Blocker]** Secrets only from a secrets manager: `JWT_SECRET`, `IP_HASH_PEPPER`,
      `DEVICE_HASH_PEPPER`, `TURN_SECRET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `ADMIN_TOTP_ENC_KEY`,
      `TURNSTILE_SECRET_KEY`, `METRICS_TOKEN`, database and credentialed Redis URLs.
- [ ] **[Blocker]** `TRUST_PROXY` = exact hop count or CIDR list of the CDN + load-balancer chain,
      never `true` (D-028). IP hashes drive `/v1/session` limits (10/min per IP hash), IP bans and
      the gateway ban check: a wrong value makes all visitors share one IP or lets clients spoof it.
- [ ] **[Blocker]** `CORS_ORIGINS` = the production web origin(s) (also the gateway's WebSocket
      Origin allowlist, D-036) and `ADMIN_ORIGINS` = only the admin dashboard origin(s): only those
      may call `/v1/admin/*` with credentials and the CSRF header (D-103). Serve admin and API from
      one registrable domain: the `rc_admin` cookie is `SameSite=Lax` (D-093).
- [ ] **[Blocker]** Handshake limits: `HANDSHAKE_LIMIT_PER_VISITOR` (30/min) and
      `HANDSHAKE_LIMIT_PER_IP` (600/min, per IP hash, IPv6 per /64) — tune the IP limit to the
      largest carrier-grade NAT you serve before launch (`gateway_rate_limit_hits_total{route="handshake"}`).
- [ ] **[Blocker]** `TURN_TLS_PORT=443` (adds `turns:` URLs to the credentials) once coturn serves
      TLS; `TURN_BIND_IP` is a development-only compose knob.
- [ ] **[Blocker]** Build web/admin images per environment: `NEXT_PUBLIC_API_URL`,
      `NEXT_PUBLIC_GATEWAY_URL` (https/wss), the site key and `NEXT_PUBLIC_FORCE_TURN_RELAY` are
      inlined at build; `S3_PUBLIC_ENDPOINT` sets the presigned-URL host and admin `img-src`.
- [ ] **[Blocker]** `S3_*` for the production store, with the frames bucket's 1-day expiry rule (dev
      sets it only in `infra/docker/minio/init.sh`); `@app/storage` forces path-style addressing.
- [ ] **[Blocker]** `TURN_HOST`, `TURN_PORT`, `STUN_URLS` per region, `TURN_CREDENTIAL_TTL_SECONDS`
      (600, D-073); `TURN_EXTERNAL_IP` is compose-only (production: coturn's own `external-ip`).
- [ ] **[Blocker]** Capacity values from the load-test projection: `MM_REGION`, `MM_BUCKETS`,
      `MM_BUCKETS_BY_QUEUE`, `DEADLINE_SHARDS=64`, `STATS_COUNTER_SHARDS`, `WORKER_CONCURRENCY`,
      `MOD_FRAME_BUDGET_PER_SEC`. Only raise bucket/shard counts on a live fleet: lowering them
      orphans waiting tickets (§15) or deadlines (only shards `0…N-1` are polled).
- [ ] **[Blocker]** Dev switches off: `RATE_LIMIT_DISABLED` unset and `DEV_FORCE_FLAG_VISITOR_IDS`
      empty (both ignored outside `NODE_ENV=development`), `DEV_FORCE_SFU=false` (Part 11),
      `LOG_LEVEL=info`; `TOS_VERSION` = version of the reviewed legal texts, bumped on every change.

## Legal & compliance

- [ ] **[Blocker]** Decide the launch countries with counsel (they decide which items below apply;
      geo-block the rest) and record each legal outcome as a decision in `CONTEXT.md`.
- [ ] **[Blocker]** Replace the placeholder `/terms`, `/privacy` and `/guidelines` pages
      (`apps/web/app/*/page.tsx`) with reviewed texts covering frame sampling, client NSFW checks,
      report evidence, retention and automated bans.
- [ ] **[Blocker]** US 18 U.S.C. §2258A: register with NCMEC as an electronic service provider;
      define who files CyberTipline reports, how fast after actual knowledge, and how reported
      content is preserved and restricted (period: confirm with counsel).
- [ ] **[Blocker]** COPPA: the service is 18+, but actual knowledge of an under-13 user (e.g. a
      `MINOR_SAFETY` report) creates duties; define ban + deletion, minus what must be preserved.
- [ ] **[Blocker]** GDPR / UK GDPR: DPIA (frame analysis at scale, trust scores, automated bans),
      records of processing, lawful bases, DPAs with every vendor, transfers, EU/UK representative;
      HMAC-hashed IPs and device ids (`@app/shared/crypto`) are still personal data.
- [ ] **[Blocker]** EU ePrivacy: a chat service may be an interpersonal communications service, so
      server-side frame sampling (D-054) and text filtering need a legal basis (check the interim
      CSAM-detection derogation, Regulation (EU) 2021/1232); assess `localStorage` (`rc.deviceId`).
- [ ] **[Blocker]** EU DSA: settle the classification (hosting service, online platform, or
      interpersonal communication) and build what follows: notice-and-action, statements of reasons
      (vs. silent shadow bans, D-089), complaints, contact points, transparency reports.
- [ ] **[Blocker]** UK Online Safety Act: illegal-content risk assessment, children's access (and,
      if needed, risk) assessment, Ofcom codes incl. CSEA measures and highly effective age
      assurance where required, user reporting and complaints, UK CSEA reporting duties.
- [ ] **[Blocker]** India IT Rules 2021: grievance officer and complaint timelines, takedown windows
      for orders, significant-social-media-intermediary thresholds and duties (incl. originator
      traceability for messaging); confirm applicability before serving India.
- [ ] **[Blocker]** Law-enforcement requests: who answers, what exists to disclose (hashes, ids,
      metadata and evidence only, D-008, D-009), emergency requests, preservation (legal hold).
- [ ] **[Blocker]** Licences: verify the 21st.dev component licences (theme, Chat Messages, consent
      gate; §6 UI components list, §15) and audit npm and model licences (NSFWJS model: MIT).

## Safety operations

- [ ] **[Blocker]** Age assurance vendor ("highly effective" methods where the UK requires them):
      verify its result in `POST /v1/session` (`apps/api/src/routes/session.ts`, beside Turnstile;
      UI in `apps/web/components/age-gate.tsx`). Age is self-declared today; store only the outcome.
- [ ] **[Blocker]** CSAM hash matching: implement `HashMatcher` for PhotoDNA or Thorn Safer
      (`packages/moderation/src/hash-matcher.ts`) and wire it in `apps/worker/src/server.ts` (today
      `NoopHashMatcher`); test only with provider-supplied test hashes, never real material.
- [ ] **[Blocker]** Hash-match report evidence too: `POST /v1/reports`
      (`apps/api/src/routes/reports.ts`) stores the reported stranger's frames unchecked.
- [ ] **[Blocker]** CSAM workflow: hash matches become priority-1000 `ESCALATED` reports in the main
      queue (`apps/worker/src/moderation/classify-frame.ts`); add a restricted queue, an audited
      "reported to NCMEC" action (CyberTipline submission), separate preservation storage.
- [ ] **[Blocker]** Real image classifier: implement `ImageClassifier`
      (`packages/moderation/src/classifier.ts`) with labels mapped to `FLAG_LABELS`, wire it in
      `apps/worker/src/server.ts`; refuse mocks when `DEPLOY_ENV=production` (today a warning).
- [ ] **[Blocker]** Calibrate on real traffic: `flagThreshold` (0.8, hard-coded in
      `apps/worker/src/server.ts`), `MOD_AUTO_SHADOW_SCORE`, `MOD_REPORT_THRESHOLD`,
      `MOD_AUTO_BAN_HOURS`, `TRUST_*`, `MOD_FRAME_INTERVALS_MS`, client NSFW thresholds (§15).
- [ ] **[Blocker]** Moderation staffing: 24/7 child-safety cover (`MINOR_SAFETY` priority 100, hash
      matches 1000), SLAs per priority band, languages of `SUPPORTED_LANGS`, headcount from report
      volume, escalation to the NCMEC filer and to emergency services.
- [ ] **[Blocker]** Moderator wellbeing: evidence stays blurred by default (Part 9); add exposure
      limits per shift, breaks, rotation, counselling and opt-outs, also in outsourcing contracts.
- [ ] **[Blocker]** Moderator access: TOTP is enforced when `DEPLOY_ENV=production` (until enrolled
      only `/auth/me`, TOTP setup/verify and logout work, D-104); add access reviews; disabling an
      admin should delete their `admsess:*` sessions and privilege changes should rotate the session
      (both open, §15). SSO is a TODO (§15). The per-email lockout (D-094) lets anyone who knows an
      admin's email keep it locked: watch for it and consider an allowlisted admin network.
- [ ] **[Blocker]** Appeals workflow for bans and automated decisions (none today, §15); needed for
      DSA complaint handling and for classifier false positives.
- [ ] **[Blocker]** Ban hygiene: create and revoke bans only via the admin UI / `BanService`; SQL
      edits keep cached "not banned" answers up to 60 s and publish no `ban_applied` (§15, D-026).
- [ ] **[Later]** IP-hash bans need admin UI (visitor-id bans only today) and a policy, because
      `ban:ip:<hash>` and per-IP limits hit everyone behind a carrier-grade NAT (IPv6 is hashed per
      /64). The `ban:ip:<hash>` key of a shared address is read on every handshake and join (506
      ops/s from one load-test IP): cache negative IP-ban answers in the gateway for a few seconds.
- [ ] **[Later]** Device bans are evadable by design: `deviceId` is chosen by the client
      (localStorage); age assurance and IP signals are the stronger levers.
- [ ] **[Later]** Text filter: `packages/moderation/src/text-filter.ts` uses only the obscenity
      English dataset while `SUPPORTED_LANGS` has more; harmless links count as violations.
- [ ] **[Later]** Trust rules (§15): a report lowers trust at once even when false; the `new` tier
      lacks the "first 10 sessions" rule; a report doesn't raise sampling of a running group call.

## Scale & infrastructure

### Kubernetes

- [ ] **[Blocker]** Run api, gateway, worker, web and admin on Kubernetes (infrastructure as code)
      from the Part 10 images; `/health` and `/ready` probes on api and gateway; add worker probes
      (§7 lists no HTTP endpoint for it besides the new metrics port).
- [ ] **[Blocker]** Gateway HPA on connection count (socket gauge from `/metrics` via Prometheus
      Adapter or KEDA), target from §"Load test results"; scale down slowly, since every removed pod
      makes its clients reconnect and resume elsewhere (D-046).
- [ ] **[Blocker]** Gateway termination: `terminationGracePeriodSeconds` > 20 s (drain ≤ 10 s, force
      exit at 20 s in `apps/gateway/src/server.ts`), a PodDisruptionBudget, a unique
      `GATEWAY_NODE_ID` per pod (the default `<hostname>-<port>` works).
- [ ] **[Blocker]** WebSocket ingress: no sticky sessions needed (websocket-only transport), idle
      timeout above ping 25 s + timeout 20 s, fd and conntrack limits for the per-pod socket target.
- [ ] **[Scale]** Worker replicas are safe for the budget multiplier (one update per window,
      `lock:mod:budget:<window>`) and the report threshold (`lock:report-threshold:<visitor>`, D-105);
      autoscale on the BullMQ backlog (`bullmq_queue_jobs`).
- [ ] **[Blocker]** Network policies: Postgres/Redis reachable only from app pods; egress allowlist
      (API → `challenges.cloudflare.com` for siteverify, worker → vendors, both → object storage).
- [ ] **[Blocker]** Probes: gateway `/ready` = Redis + adapter only (Postgres is reported, not
      required); gateway `/health` turns 503 when the adapter subscriber is stuck (D-101) so the
      pod is replaced; keep `/ready`/`/health`/`/metrics` off the public ingress.

### Redis

- [ ] **[Blocker]** Replicas + automatic failover for every Redis (managed, Sentinel or Cluster);
      `createRedis` reconnects on `READONLY` after a failover — prove it in the drills below.
- [ ] **[Blocker]** Split Redis by role: matchmaking, sessions, presence and the adapter are
      ephemeral; BullMQ needs AOF and `maxmemory-policy noeviction` (dev runs without AOF/RDB,
      `infra/docker/docker-compose.yml`), or a restart loses queued jobs.
- [ ] **[Scale]** Cluster clients: `createRedis` (`packages/redis/src/client.ts`) is a standalone
      ioredis client; add ioredis `Cluster` connections (app data, BullMQ, and the sharded adapter —
      ioredis since D-101: validate SSUBSCRIBE routing per slot on a real Cluster, ioredis#1759,
      before the rollout; the subscriber watchdog exposes a failure); needs new env vars.
- [ ] **[Scale]** Cross-slot code to fix: MULTI on `presence:node:<id>` + `presence:nodes` in
      `apps/gateway/src/presence.ts`; pipelines over buckets (`chooseBucket`) and deadline shards
      (`claimDueDeadlines` in `apps/gateway/src/sessions/store.ts`); admin `/stats` SCAN + MGET in
      `apps/api/src/admin/routes/system.ts` (use Prometheus, D-097).
- [ ] **[Scale]** Size the Cluster from measured ops/s per key family: busy families' bucket tags on
      different shards, deadline polling (each gateway reads every shard each second), one sharded
      channel per `visitor:<id>` room, memory (dead `q:int:*` ids, §15).
- [ ] **[Scale]** `gw:control` is classic pub/sub (each message reaches every gateway and, on a
      Cluster, every shard) and each connect publishes `kick_visitor`
      (`apps/gateway/src/single-socket.ts`); measure at 1M, move to sharded pub/sub if it dominates.

### Postgres & session analytics

- [ ] **[Blocker]** Managed Postgres with HA failover, PITR and encryption at rest, sized for
      reports, bans, visitors, moderation events and (until moved) session logs.
- [ ] **[Blocker]** PgBouncer (transaction pooling): each api, gateway and worker process opens a
      pool of 10 (`packages/db/src/client.ts`, not configurable yet); verify Prisma 7 +
      `@prisma/adapter-pg` behind it; run `pnpm db:deploy` on a direct URL.
- [ ] **[Scale]** Ban-check fallback: missing `ban:*` keys (e.g. after losing Redis) send every API
      session and gateway handshake to Postgres (§12); protect it from a mass-reconnect stampede.
- [ ] **[Scale]** Session analytics off Postgres (D-055): `apps/worker/src/jobs/session-log.ts`
      upserts `chat_session_logs` + `session_participants` per session, the top write load at ~22k
      matches/s; send session events via Redis Streams or Kafka to batched ClickHouse inserts;
      Postgres keeps reports, bans, visitors.
- [ ] **[Scale]** Batch session-end trust writes (`apps/worker/src/moderation/session-trust.ts`:
      event count + `visitors.trust_score` update per participant); repoint the admin session count
      (`apps/api/src/admin/views.ts`); add a stayed-to-the-end leave reason (`null` today, §15).
- [ ] **[Scale]** Shard BullMQ by hash tag: the single `{bull}` prefix (D-044) puts every queue on
      one Cluster slot, and `session-log` is the hottest key family at 5,000 load-test clients (24 %
      of Redis ops; `{bull}:session-log:wait` ≈ 2,100 ops/s ≈ 420k/s at 1M): use per-queue/per-shard
      tags with producers picking a shard (`apps/gateway/src/gateway.ts`, `apps/api/src/services/jobs.ts`,
      `apps/worker/src/worker.ts`) or move session logs to Streams/Kafka (above).

### Multi-region

- [ ] **[Later]** Regional stacks (gateways, Redis, TURN, Janus; API against one Postgres primary
      with read replicas) with `MM_REGION` per region; the keys already carry the region (D-052).
- [ ] **[Later]** Local-first matching with neighbour-region fallback is not implemented: gateways
      only read their own `MM_REGION` queues. Design how long waiters join a neighbour's queues.
- [ ] **[Later]** Cross-region safety: `ban_applied` / `kick_visitor` use one Redis's `gw:control`,
      and ban caches (60 s negative entries) and `visitor:<id>:socket` are per Redis; relay bans and
      kicks to every region and invalidate their caches.
- [ ] **[Later]** Keep reconnects in the session's region: its keys live in the regional Redis, so a
      resume elsewhere fails (`SESSION_NOT_RESUMABLE`), but `NEXT_PUBLIC_GATEWAY_URL` is one
      build-time URL; hand out a regional gateway URL (e.g. from `/v1/session` or `/v1/config`).
- [ ] **[Later]** GeoDNS/anycast: CDN for web/API, GeoDNS to regional gateway load balancers with
      health-checked failover, regional `TURN_HOST`/`STUN_URLS` and Janus nodes from the regional
      API; `Visitor.country` from the CDN country header (null today, §15); EU data residency.

### Scale validation to 1M

- [ ] **[Scale]** Bot fleet: `tools/bots` (Part 10 `load` mode) on 100+ machines up to 1M sockets
      and ~22k matches/s with realistic skips, messages and signalling; p50/p95/p99 time-to-match,
      latency, errors, hot-key check; record results in `CONTEXT.md`.
- [ ] **[Scale]** Staging-only bot sessions: `/v1/session` needs Turnstile and allows 10/min per IP
      hash; `pnpm --filter @app/bots load` mints tokens with the staging `JWT_SECRET` (never point it
      at production) and needs a raised `HANDSHAKE_LIMIT_PER_IP` on the staging gateways.
- [ ] **[Scale]** Headless WebRTC media load through TURN (relay-only) and Janus (Parts 11–12):
      bandwidth, CPU, loss and allocations per node; Linux load generators (headless Chrome on macOS
      hangs on audio capture, §15) or a native WebRTC client.
- [ ] **[Scale]** Failure drills under load, expected outcome written first: Redis primary failover;
      gateway kill (sessions resume within `RECONNECT_GRACE_MS`; its tickets stay matchable ≤ 15 s +
      ≤ 30 s sweeper, §15); Janus node (new room, `epoch + 1`); whole region (GeoDNS failover).
- [ ] **[Scale]** Crash cleanup: a crashed (not drained) gateway leaves its session participants
      `active` with no grace deadline, and a crash mid-hop leaves a ref to a cancelled ticket (§15);
      add a reaper keyed on expired `presence:node:<id>`.

### Moderation capacity (GPU/ML)

- [ ] **[Blocker]** Provision classifier and hash-matching capacity (GPUs or vendor quota) for peak
      and set `MOD_FRAME_BUDGET_PER_SEC` below it; the multiplier (1–64) stretches `high` at most
      2×, so cover half the `high`-tier rate (group calls are `high`, D-054).
- [ ] **[Blocker]** Alert when `mod:budget:multiplier` is missing (it expires 60 s after the last
      worker update and gateways stop stretching, D-087), pinned at 64, or the frame backlog grows.

## Media (TURN / Janus)

- [ ] **[Blocker]** TURN on hosts with public IPs (`external-ip` per node, wide relay port range),
      moving to bare metal for bandwidth cost; size from relay share (`rtc:summary` metrics) × video
      calls × ≤ 800 kbps per direction; UDP needs network-level DDoS protection.
- [ ] **[Blocker]** Deploy coturn from `infra/coturn/turnserver.production.conf` (no TCP relays, no
      loopback, every private/reserved range denied — CI checks these lines — quotas, `max-bps`,
      TLS on 443): fill in `realm`, certificates, `external-ip`, `total-quota`, and add the TURN
      host's own and VPC ranges to the deny list.
- [ ] **[Blocker]** TURN over TLS on 443 for networks that allow only HTTPS: certificates in coturn
      and `TURN_TLS_PORT=443` on the API (adds `turns:<host>:443?transport=tcp`).
- [ ] **[Blocker]** TURN secret: don't pass `static-auth-secret` on the command line (visible in
      `docker inspect`, and the image entrypoint `eval`s arguments, §7); rotate `TURN_SECRET` with
      an overlap of at least `TURN_CREDENTIAL_TTL_SECONDS`.
- [ ] **[Blocker]** Decide `NEXT_PUBLIC_FORCE_TURN_RELAY` as a privacy decision: P2P (default) shows
      each user's IP address to the stranger; relay-only hides it but sends all video through TURN.
- [ ] **[Groups]** Janus fleet sizing (Parts 11–12): rooms per node from ~2 Mbps in / ~6 Mbps out
      per 4-person room (`SFU_PUBLISHER_BITRATE` 600 kbps), CPU and RTP port ranges (dev
      20000–20100), `JANUS_PUBLIC_IP` (`nat_1_1_mapping`) per node, regional `JANUS_NODES`.
- [ ] **[Groups]** Janus exposure (D-051): admin API (dev 7188) internal only, client WebSocket over
      `wss://` (an https page can't open `ws://`), `JANUS_ADMIN_SECRET`/`JANUS_TOKEN_SECRET` from
      the secrets manager, coturn credentials for Janus peer connections, failover drill per node.
- [ ] **[Groups]** Group-call moderation: frames still come from clients; evaluate Janus
      `rtp_forward` into a server-side moderation service (Part 11 only documents it).

## Security

- [ ] **[Blocker]** CDN + WAF in front of web, API and admin: managed rules, edge rate limits for
      `/v1/session`, `/v1/reports`, `/v1/moderation/frames` and admin login, WebSocket support for
      the gateway (or a DDoS-protected load balancer), edge caching of `/models/nsfw/` (~2.6 MB).
- [ ] **[Blocker]** Admin behind an access proxy, VPN or IP allowlist on top of password + TOTP;
      never cached at the CDN (admin routes already send `cache-control: no-store`).
- [ ] **[Blocker]** TLS everywhere: https/wss with HSTS publicly; `rediss://` and Postgres
      `sslmode=require` (or a private network with mTLS) internally.
- [ ] **[Blocker]** Check the deployed CSPs: web without `'unsafe-inline'` scripts, `'unsafe-eval'`
      or dev `ws:` (§15), `connect-src` with the https API and wss gateway; admin nonce CSP
      (`apps/admin/proxy.ts`) with the evidence origin in `img-src`.
- [ ] **[Blocker]** Visitor tokens: HS256 with one shared `JWT_SECRET`, so every gateway could mint
      tokens; move to an asymmetric key (API signs, gateways verify only). Tokens can't be revoked
      (`jti` unused): HARD bans already refuse handshakes, reports and TURN credentials, but add a
      denylist for leaked tokens if tokens live long.
- [ ] **[Blocker]** Rotation runbooks: new `IP_HASH_PEPPER`/`DEVICE_HASH_PEPPER` values invalidate
      stored hashes and so IP/device bans; `JWT_SECRET` is one HS256 key without `kid`
      (`packages/shared/src/visitor-token.ts`), so rotating it logs every visitor out; a new
      `ADMIN_TOTP_ENC_KEY` breaks enrolled TOTPs (`v1:` allows versioned keys).
- [ ] **[Blocker]** Least-privilege object-store credentials per service instead of the MinIO root
      user used in dev (API: put evidence/frames, presign; worker: read/delete frames, copy/delete
      evidence); private buckets with server-side encryption.
- [ ] **[Blocker]** Accept or mitigate fail-open rate limits: API limits are skipped while Redis is
      down (D-027); the edge limits above are the backstop.
- [ ] **[Blocker]** Penetration test before launch, after Parts 11–12 and yearly: admin API (CSRF,
      TOTP, RBAC), gateway events, uploads (`/v1/reports` → sharp, `/v1/moderation/frames`),
      presigned URLs, `X-Forwarded-For` spoofing, Turnstile bypass, TURN SSRF/quotas, Janus tokens.
- [ ] **[Blocker]** Supply chain: `pnpm audit` (high/critical), secret scanning, image scanning and
      SBOMs, pinned base images, Turborepo telemetry off in CI (`turbo telemetry disable`, §15).

## Data & privacy

- [ ] **[Blocker]** Retention schedule approved by counsel and enforced: evidence and transcripts 90
      days (worker job), `moderation_events`, inactive `visitors` without bans, session logs,
      `audit_logs`, application logs, failed BullMQ jobs (7 days); Redis data already expires.
      Backups must not outlive these periods, or the privacy policy says so.
- [ ] **[Blocker]** Legal hold: an audited admin action that keeps evidence beyond 90 days
      (`expiresAt = null` or a hold flag) for preservation requests and confirmed CSAM; the
      retention job must skip held items.
- [ ] **[Blocker]** Evidence protection: keep 5-minute presigned URLs and the `report.view_evidence`
      audit entry; add bucket access logs, KMS-managed keys and separate CSAM preservation storage.
- [ ] **[Blocker]** Data-subject requests from anonymous visitors: how a requester proves identity
      (device id in their browser → `deviceIdHash`), what is exported or deleted, what bans or
      preserved evidence override.
- [ ] **[Blocker]** Logs: central store with access control and retention; confirm in staging that
      no tokens, raw IPs, device ids or chat text appear (pino `REDACT_PATHS` in `packages/logger`).

## Operations

- [ ] **[Blocker]** Monitoring: Prometheus scrapes api, gateway and worker with `METRICS_TOKEN` on
      the internal network (`infra/docker/prometheus/prometheus.yml` is the dev template); import the
      Grafana dashboard `infra/docker/grafana/dashboards/randomchat.json`; `rtc:summary` aggregates
      are per-node counters (sum them in queries).
- [ ] **[Blocker]** Alerts: `gateway_adapter_subscriber_oldest_pending_seconds` > 15 (cross-node
      delivery failing, D-101), socket-count drops, time-to-match p99, match rate, error rates, Redis
      latency/memory/failovers, BullMQ backlog and failures, TURN allocation failures and relay
      share, Turnstile 503s, PgBouncer saturation, report-queue age per priority band.
- [ ] **[Blocker]** Backups & DR: Postgres PITR + snapshots with restore drills, evidence-bucket
      versioning and replication, written RPO/RTO, a region failover drill once multi-region exists;
      Redis matchmaking/session data has no backup (losing it ends live chats).
- [ ] **[Blocker]** Incident response: on-call, severities, status page, post-mortems; runbooks for
      Redis failover, gateway mass reconnect, TURN outage, Cloudflare/Turnstile outage
      (`/v1/session` fails closed, D-025), classifier backlog, secret compromise, data breach (GDPR:
      authority within 72 h), child-safety escalation.
- [ ] **[Blocker]** Release process: staging (`DEPLOY_ENV=staging`) mirrors production; Part 10 CI +
      image signing; `pnpm db:deploy` first, backward-compatible migrations; verify gateway rolling
      updates (drain → `SERVER_RESTARTING` → resume, D-058, D-076) through the real ingress.
- [ ] **[Blocker]** First admin: `pnpm admin:create` with `ADMIN_EMAIL`, `ADMIN_PASSWORD` and
      `ADMIN_ROLE` from env (D-098; the seed refuses production); enrol TOTP at once.

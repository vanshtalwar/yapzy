import { Counter, createMetricsRegistry, Gauge, Histogram, type Registry } from '@app/metrics';

/** Prometheus metrics of a gateway node (`GET /metrics`); see CONTEXT.md "Metrics". */
export function createGatewayMetrics(registry: Registry) {
  /** Read at scrape time; the gateway points them at Socket.io, the lifecycle and the adapter. */
  const sources = {
    sockets: () => 0,
    waiting: () => 0,
    subscriberPending: () => 0,
    subscriberOldestMs: () => 0,
    /** Last `sfu:nodes` health (any gateway reads it; the leader writes it). */
    sfuNodes: (): { nodeId: string; healthy: boolean; rooms: number }[] => [],
  };
  return {
    registry,
    sources,
    socketsConnected: new Gauge({
      name: 'gateway_sockets_connected',
      help: 'Sockets connected to this node',
      registers: [registry],
      collect() {
        this.set(sources.sockets());
      },
    }),
    events: new Counter({
      name: 'gateway_events_total',
      help: 'Client events by type and outcome (ok, error, rate_limited, invalid, internal_error)',
      labelNames: ['event', 'outcome'] as const,
      registers: [registry],
    }),
    rateLimitHits: new Counter({
      name: 'rate_limit_hits_total',
      help: 'Socket events refused by the per-socket token bucket',
      labelNames: ['route'] as const,
      registers: [registry],
    }),
    abuseDisconnects: new Counter({
      name: 'gateway_abuse_disconnects_total',
      help: 'Sockets disconnected after too many invalid, unknown or rate-limited events',
      registers: [registry],
    }),
    matches: new Counter({
      name: 'matchmaking_matches_total',
      help: 'Matches made on this node, by mode, pool and queue bucket',
      labelNames: ['mode', 'pool', 'bucket'] as const,
      registers: [registry],
    }),
    timeToMatch: new Histogram({
      name: 'matchmaking_time_to_match_seconds',
      help: 'Ticket creation to match, per matched visitor (hops keep the original start)',
      labelNames: ['mode'] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 30, 60],
      registers: [registry],
    }),
    bucketHops: new Counter({
      name: 'matchmaking_bucket_hops_total',
      help: 'Waiting tickets moved to another queue bucket',
      labelNames: ['mode'] as const,
      registers: [registry],
    }),
    waitingVisitors: new Gauge({
      name: 'matchmaking_waiting_visitors',
      help: 'Searches whose wait timers run on this node (sum over nodes = visitors waiting)',
      registers: [registry],
      collect() {
        this.set(sources.waiting());
      },
    }),
    sessionsEnded: new Counter({
      name: 'sessions_ended_total',
      help: 'Sessions ended, by mode and the leave reason that ended them',
      labelNames: ['mode', 'reason'] as const,
      registers: [registry],
    }),
    sessionDuration: new Histogram({
      name: 'session_duration_seconds',
      help: 'Match to end of the session',
      labelNames: ['mode'] as const,
      buckets: [5, 15, 30, 60, 120, 300, 600, 1_200, 1_800, 3_600],
      registers: [registry],
    }),
    resumes: new Counter({
      name: 'session_resumes_total',
      help: 'session:resume after a reconnect, by outcome (ok, not_resumable)',
      labelNames: ['outcome'] as const,
      registers: [registry],
    }),
    rtcSummaries: new Counter({
      name: 'rtc_summaries_total',
      help: 'Peer connections reported by rtc:summary, by outcome (connected, failed)',
      labelNames: ['outcome'] as const,
      registers: [registry],
    }),
    rtcLocalCandidates: new Counter({
      name: 'rtc_local_candidates_total',
      help: 'Selected local ICE candidate type per peer connection (relay = through TURN)',
      labelNames: ['type'] as const,
      registers: [registry],
    }),
    rtcTimeToConnected: new Histogram({
      name: 'rtc_time_to_connected_seconds',
      help: 'Peer connection creation to connected',
      buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 20],
      registers: [registry],
    }),
    rtcRtt: new Histogram({
      name: 'rtc_rtt_seconds',
      help: 'Average round-trip time per peer connection',
      buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2],
      registers: [registry],
    }),
    subscriberPending: new Gauge({
      name: 'gateway_adapter_subscriber_pending',
      help: 'Room (un)subscriptions of the sharded adapter waiting for Redis',
      registers: [registry],
      collect() {
        this.set(sources.subscriberPending());
      },
    }),
    subscriberOldestSeconds: new Gauge({
      name: 'gateway_adapter_subscriber_oldest_pending_seconds',
      help: 'Age of the oldest pending room (un)subscription (stuck subscriber > 15 s)',
      registers: [registry],
      collect() {
        this.set(sources.subscriberOldestMs() / 1_000);
      },
    }),
    moderationActions: new Counter({
      name: 'moderation_actions_total',
      help: 'Moderation actions by source and kind',
      labelNames: ['source', 'action'] as const,
      registers: [registry],
    }),
    // --- Janus SFU (Part 11) ---
    sfuNodeRooms: new Gauge({
      name: 'sfu_node_rooms',
      help: 'Rooms per Janus node at the last health check (sum = SFU rooms active)',
      labelNames: ['node'] as const,
      registers: [registry],
      collect() {
        this.reset();
        for (const node of sources.sfuNodes()) this.set({ node: node.nodeId }, node.rooms);
      },
    }),
    sfuNodeHealthy: new Gauge({
      name: 'sfu_node_healthy',
      help: 'Janus node health at the last check (1 = healthy)',
      labelNames: ['node'] as const,
      registers: [registry],
      collect() {
        this.reset();
        for (const node of sources.sfuNodes())
          this.set({ node: node.nodeId }, node.healthy ? 1 : 0);
      },
    }),
    sfuUpgrades: new Counter({
      name: 'sfu_upgrades_total',
      help: 'P2P → Janus switches by outcome (started, succeeded, rolled_back, unavailable)',
      labelNames: ['outcome'] as const,
      registers: [registry],
    }),
    sfuUpgradeDuration: new Histogram({
      name: 'sfu_upgrade_duration_seconds',
      help: 'Start of a P2P → Janus switch until every participant confirmed it',
      buckets: [0.25, 0.5, 1, 2, 3, 5, 7.5, 10, 15],
      registers: [registry],
    }),
    sfuFailovers: new Counter({
      name: 'sfu_failovers_total',
      help: 'Calls on a lost Janus room, by outcome (moved, rolled_back, failed)',
      labelNames: ['outcome'] as const,
      registers: [registry],
    }),
    // --- Group calls (Part 12) ---
    groupAddRequests: new Counter({
      name: 'group_add_requests_total',
      help: 'Add-a-person rounds by outcome (requested, accepted, declined, expired, left, not_eligible) — consent rate = accepted / requested',
      labelNames: ['outcome'] as const,
      registers: [registry],
    }),
    groupSeeks: new Counter({
      name: 'group_seeks_total',
      help: 'Searches for one more person by outcome (joined, timeout, left, unavailable; turned_away = a matched joiner that could not be added) — success rate = joined / all but turned_away',
      labelNames: ['outcome'] as const,
      registers: [registry],
    }),
    groupTimeToJoin: new Histogram({
      name: 'group_time_to_join_seconds',
      help: 'Start of a search until the new person was added',
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60],
      registers: [registry],
    }),
    groupJoins: new Counter({
      name: 'group_joins_total',
      help: 'People added to group calls, by the resulting call size (3 or 4)',
      labelNames: ['size'] as const,
      registers: [registry],
    }),
    groupSessionDuration: new Histogram({
      name: 'group_session_duration_seconds',
      help: 'Start to end of sessions that had 3 or more participants',
      buckets: [30, 60, 120, 300, 600, 1_200, 1_800, 3_600],
      registers: [registry],
    }),
    sfuAdminLatency: new Histogram({
      name: 'sfu_admin_request_duration_seconds',
      help: 'Janus Admin API requests by request and outcome',
      labelNames: ['request', 'outcome'] as const,
      buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 3],
      registers: [registry],
    }),
  };
}

export type GatewayMetrics = ReturnType<typeof createGatewayMetrics>;

export function createDefaultGatewayMetrics(withProcessMetrics: boolean): GatewayMetrics {
  return createGatewayMetrics(
    createMetricsRegistry({ service: 'gateway', defaultMetrics: withProcessMetrics }),
  );
}

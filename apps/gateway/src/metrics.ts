import { Counter, createMetricsRegistry, Gauge, Histogram, type Registry } from '@app/metrics';

/** Prometheus metrics of a gateway node (`GET /metrics`); see CONTEXT.md "Metrics". */
export function createGatewayMetrics(registry: Registry) {
  /** Read at scrape time; the gateway points them at Socket.io, the lifecycle and the adapter. */
  const sources = {
    sockets: () => 0,
    waiting: () => 0,
    subscriberPending: () => 0,
    subscriberOldestMs: () => 0,
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
  };
}

export type GatewayMetrics = ReturnType<typeof createGatewayMetrics>;

export function createDefaultGatewayMetrics(withProcessMetrics: boolean): GatewayMetrics {
  return createGatewayMetrics(
    createMetricsRegistry({ service: 'gateway', defaultMetrics: withProcessMetrics }),
  );
}

import {
  Counter,
  createMetricsRegistry,
  Histogram,
  LATENCY_BUCKETS,
  type Registry,
} from '@app/metrics';

/** Prometheus metrics of the API (`GET /metrics`); see CONTEXT.md "Metrics". */
export function createApiMetrics(registry: Registry) {
  return {
    registry,
    httpDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency by route pattern and status code',
      labelNames: ['method', 'route', 'status'] as const,
      buckets: LATENCY_BUCKETS,
      registers: [registry],
    }),
    rateLimitHits: new Counter({
      name: 'rate_limit_hits_total',
      help: 'Requests refused with 429 (route limits, login limits, frame schedule)',
      labelNames: ['route'] as const,
      registers: [registry],
    }),
    reports: new Counter({
      name: 'reports_total',
      help: 'Reports filed (source=user: by visitors; automatic ones are counted by the worker)',
      labelNames: ['reason', 'source'] as const,
      registers: [registry],
    }),
    moderationActions: new Counter({
      name: 'moderation_actions_total',
      help: 'Moderation actions by source (admin, worker, gateway) and kind',
      labelNames: ['source', 'action'] as const,
      registers: [registry],
    }),
  };
}

export type ApiMetrics = ReturnType<typeof createApiMetrics>;

export function createDefaultApiMetrics(withProcessMetrics: boolean): ApiMetrics {
  return createApiMetrics(
    createMetricsRegistry({ service: 'api', defaultMetrics: withProcessMetrics }),
  );
}

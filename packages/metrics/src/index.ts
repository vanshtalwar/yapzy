import { timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type ServerResponse } from 'node:http';

import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export { Counter, Gauge, Histogram, Registry };

/** Seconds; covers fast HTTP handlers up to slow uploads. */
export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface MetricsRegistryOptions {
  /** Default label on every series (`api`, `gateway`, `worker`). */
  service: string;
  /** Process metrics (CPU, memory, event-loop lag, GC); off in unit tests. */
  defaultMetrics?: boolean;
}

/** One registry per app instance (tests build several apps in one process). */
export function createMetricsRegistry({
  service,
  defaultMetrics = true,
}: MetricsRegistryOptions): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  if (defaultMetrics) collectDefaultMetrics({ register: registry });
  return registry;
}

export interface MetricsAccessOptions {
  /** `METRICS_TOKEN`; when set, scrapers must send `Authorization: Bearer <token>`. */
  token: string | undefined;
  /** DEPLOY_ENV=production: without a token, /metrics is disabled rather than public. */
  requireToken: boolean;
}

export type MetricsAccess = 'ok' | 'unauthorized' | 'disabled';

export function metricsAccess(
  authorization: string | undefined,
  { token, requireToken }: MetricsAccessOptions,
): MetricsAccess {
  if (token === undefined) return requireToken ? 'disabled' : 'ok';
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(authorization ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? 'ok'
    : 'unauthorized';
}

/** `GET /metrics` for plain node:http servers (gateway, worker). */
export async function serveMetrics(
  request: IncomingMessage,
  response: ServerResponse,
  registry: Registry,
  access: MetricsAccessOptions,
): Promise<void> {
  const verdict = metricsAccess(request.headers.authorization, access);
  if (verdict !== 'ok') {
    response.writeHead(verdict === 'disabled' ? 404 : 401).end();
    return;
  }
  const body = await registry.metrics();
  response.writeHead(200, { 'content-type': registry.contentType }).end(body);
}

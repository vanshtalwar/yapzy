import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { Counter, createMetricsRegistry, metricsAccess, serveMetrics } from './index.ts';

describe('metrics', () => {
  it('labels every series with the service and keeps registries separate', async () => {
    const a = createMetricsRegistry({ service: 'api', defaultMetrics: false });
    const b = createMetricsRegistry({ service: 'gateway', defaultMetrics: false });
    new Counter({ name: 'things_total', help: 'Things', registers: [a] }).inc(2);
    new Counter({ name: 'things_total', help: 'Things', registers: [b] }).inc();
    expect(await a.metrics()).toContain('things_total{service="api"} 2');
    expect(await b.metrics()).toContain('things_total{service="gateway"} 1');
  });

  it('protects /metrics with an optional bearer token, disabled in production without one', () => {
    expect(metricsAccess(undefined, { token: undefined, requireToken: false })).toBe('ok');
    expect(metricsAccess(undefined, { token: undefined, requireToken: true })).toBe('disabled');
    const token = 't'.repeat(32);
    expect(metricsAccess(`Bearer ${token}`, { token, requireToken: true })).toBe('ok');
    expect(metricsAccess('Bearer nope', { token, requireToken: false })).toBe('unauthorized');
    expect(metricsAccess(undefined, { token, requireToken: false })).toBe('unauthorized');
  });

  it('serves the Prometheus text format over node:http', async () => {
    const registry = createMetricsRegistry({ service: 'worker', defaultMetrics: true });
    const token = 'k'.repeat(24);
    const server = createServer((request, response) => {
      void serveMetrics(request, response, registry, { token, requireToken: true });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/metrics`;
    try {
      expect((await fetch(url)).status).toBe(401);
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(await response.text()).toContain('process_cpu_seconds_total{service="worker"}');
    } finally {
      server.close();
    }
  });
});

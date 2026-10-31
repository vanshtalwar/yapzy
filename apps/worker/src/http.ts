import { createServer } from 'node:http';

import { type MetricsAccessOptions, type Registry, serveMetrics } from '@app/metrics';

/** The worker's only HTTP surface: liveness for orchestrators and Prometheus metrics. */
export function startWorkerHttp(options: {
  host: string;
  port: number;
  registry: Registry;
  access: MetricsAccessOptions;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    } else if (request.method === 'GET' && request.url === '/metrics') {
      serveMetrics(request, response, options.registry, options.access).catch(() => {
        response.writeHead(500).end();
      });
    } else {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : options.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

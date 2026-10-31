import { hostname } from 'node:os';

/** `GATEWAY_NODE_ID` or "<hostname>-<port>", restricted to characters valid in Redis keys. */
export function resolveNodeId(configured: string | undefined, port: number): string {
  if (configured !== undefined) return configured;
  const host = hostname()
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .slice(0, 48);
  return `${host}-${String(port)}`;
}

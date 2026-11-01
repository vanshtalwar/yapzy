import { type NextRequest, NextResponse } from 'next/server';

const TURNSTILE = 'https://challenges.cloudflare.com';

let sfuOrigins = { source: '', origins: '' };

/**
 * The Janus nodes' client WebSocket origins (`wsUrl` from JANUS_NODES, never the Admin API
 * URLs), read at request time so adding a node needs no rebuild. Malformed values allow none.
 */
function sfuConnectSources(): string {
  const source = process.env.JANUS_NODES ?? '';
  if (source === sfuOrigins.source) return sfuOrigins.origins;
  let origins = '';
  try {
    const nodes = JSON.parse(source === '' ? '[]' : source) as unknown;
    if (Array.isArray(nodes)) {
      const urls = nodes.flatMap((node: unknown) => {
        const wsUrl = (node as { wsUrl?: unknown } | null)?.wsUrl;
        if (typeof wsUrl !== 'string') return [];
        const url = new URL(wsUrl);
        return url.protocol === 'ws:' || url.protocol === 'wss:' ? [url.origin] : [];
      });
      origins = [...new Set(urls)].join(' ');
    }
  } catch {
    origins = '';
  }
  sfuOrigins = { source, origins };
  return origins;
}

/**
 * Final CSP (Part 10): scripts only with this request's nonce ('strict-dynamic' lets our own
 * code load the Turnstile script); network only to the API, the gateway (http + ws) and the
 * Janus nodes' client WebSockets (Part 11);
 * media from camera streams and blobs; Turnstile is the only third-party frame.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV === 'development';
  const api = new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').origin;
  const gateway = new URL(process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:4001');
  const gatewayWs = `${gateway.protocol === 'https:' ? 'wss:' : 'ws:'}//${gateway.host}`;
  // Janus client APIs (group calls, Part 11): the nodes' wsUrl origins only, never the admin port.
  const sfu = sfuConnectSources();
  const csp = [
    "default-src 'self'",
    // 'wasm-unsafe-eval' allows WebAssembly compilation only, not JS eval: tfjs (via long.js)
    // instantiates a small wasm helper.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval' ${TURNSTILE}${dev ? " 'unsafe-eval'" : ''}`,
    // Inline style attributes (Radix positioning, toasts) cannot carry nonces.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${api} ${gateway.origin} ${gatewayWs}${sfu === '' ? '' : ` ${sfu}`}${dev ? ' ws:' : ''}`,
    "media-src 'self' blob: mediastream:",
    "worker-src 'self' blob:",
    `frame-src ${TURNSTILE}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|models/|icon.svg).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};

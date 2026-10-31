import { type NextRequest, NextResponse } from 'next/server';

const TURNSTILE = 'https://challenges.cloudflare.com';

/**
 * Final CSP (Part 10): scripts only with this request's nonce ('strict-dynamic' lets our own
 * code load the Turnstile script); network only to the API and the gateway (http + ws);
 * media from camera streams and blobs; Turnstile is the only third-party frame.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV === 'development';
  const api = new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').origin;
  const gateway = new URL(process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:4001');
  const gatewayWs = `${gateway.protocol === 'https:' ? 'wss:' : 'ws:'}//${gateway.host}`;
  const csp = [
    "default-src 'self'",
    // 'wasm-unsafe-eval' allows WebAssembly compilation only, not JS eval: tfjs (via long.js)
    // instantiates a small wasm helper.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval' ${TURNSTILE}${dev ? " 'unsafe-eval'" : ''}`,
    // Inline style attributes (Radix positioning, toasts) cannot carry nonces.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${api} ${gateway.origin} ${gatewayWs}${dev ? ' ws:' : ''}`,
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

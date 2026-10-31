import { type NextRequest, NextResponse } from 'next/server';

/**
 * Strict CSP with a fresh nonce per request (Next.js applies it to its own scripts during
 * dynamic rendering). No third-party origins: only this app, the API, and the evidence store
 * for presigned images.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV === 'development';
  const api = new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').origin;
  const evidence = process.env.ADMIN_EVIDENCE_ORIGIN ?? 'http://localhost:9000';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // Radix and toasts set inline styles; scripts are what the nonce must protect.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${evidence}`,
    "font-src 'self'",
    `connect-src 'self' ${api}${dev ? ' ws:' : ''}`,
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
      source: '/((?!_next/static|_next/image|icon.svg).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};

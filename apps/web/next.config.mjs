// @ts-check
import path from 'node:path';

import { createEnv, loadRootEnvFile, webEnv } from '@app/env';

// Single root .env for every service (CONTEXT.md D-012); validated, then handed to Next.js,
// which inlines NEXT_PUBLIC_* into the browser bundle.
loadRootEnvFile();
const env = createEnv(webEnv, { service: 'web' });
for (const key of /** @type {const} */ ([
  'NEXT_PUBLIC_API_URL',
  'NEXT_PUBLIC_GATEWAY_URL',
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
])) {
  process.env[key] = env[key];
}
process.env.NEXT_PUBLIC_FORCE_TURN_RELAY = String(env.NEXT_PUBLIC_FORCE_TURN_RELAY);

// The CSP is set per request by proxy.ts (nonces); these headers are static.
const production = process.env.NODE_ENV === 'production';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `next dev` would otherwise write an AGENTS.md here; agent docs live in CLAUDE.md/CONTEXT.md.
  agentRules: false,
  transpilePackages: ['@app/shared', '@app/ui'],
  // Container images (Dockerfile sets NEXT_OUTPUT=standalone): a self-contained server with only
  // the traced dependencies; local `next start` keeps the regular output.
  ...(process.env.NEXT_OUTPUT === 'standalone'
    ? { output: /** @type {const} */ ('standalone') }
    : {}),
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  // LAN testing (docs/LAN_TESTING.md): the dev server accepts the host the public URLs use.
  allowedDevOrigins: [new URL(env.NEXT_PUBLIC_GATEWAY_URL).hostname],
  turbopack: { root: path.join(import.meta.dirname, '../..') },
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()',
          },
          // Browsers ignore HSTS on plain http, so local production builds are unaffected.
          ...(production
            ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]
            : []),
        ],
      },
    ]);
  },
};

export default nextConfig;

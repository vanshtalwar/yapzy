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

const isDev = process.env.NODE_ENV !== 'production';
const gateway = new URL(env.NEXT_PUBLIC_GATEWAY_URL);
const gatewayWs = `${gateway.protocol === 'https:' ? 'wss:' : 'ws:'}//${gateway.host}`;
const turnstile = 'https://challenges.cloudflare.com';

// Baseline CSP (finalized in Part 10). Next.js needs inline scripts unless nonces are used.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''} ${turnstile}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' ${new URL(env.NEXT_PUBLIC_API_URL).origin} ${gateway.origin} ${gatewayWs}${isDev ? ' ws: wss:' : ''}`,
  "media-src 'self' blob:",
  `frame-src ${turnstile}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `next dev` would otherwise write an AGENTS.md here; agent docs live in CLAUDE.md/CONTEXT.md.
  agentRules: false,
  transpilePackages: ['@app/shared', '@app/ui'],
  // LAN testing (docs/LAN_TESTING.md): the dev server accepts the host the public URLs use.
  allowedDevOrigins: [gateway.hostname],
  turbopack: { root: path.join(import.meta.dirname, '../..') },
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()',
          },
        ],
      },
    ]);
  },
};

export default nextConfig;

// @ts-check
import path from 'node:path';

import { adminWebEnv, createEnv, loadRootEnvFile } from '@app/env';

// Root .env for every service (D-012). The CSP itself is set per request by proxy.ts (nonces).
loadRootEnvFile();
const env = createEnv(adminWebEnv, { service: 'admin' });
process.env.NEXT_PUBLIC_API_URL = env.NEXT_PUBLIC_API_URL;
/** Origin of presigned evidence URLs (MinIO / S3), the only non-self image source. */
process.env.ADMIN_EVIDENCE_ORIGIN = new URL(env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT).origin;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `next dev` would otherwise write an AGENTS.md here; agent docs live in CLAUDE.md/CONTEXT.md.
  agentRules: false,
  transpilePackages: ['@app/shared', '@app/ui'],
  turbopack: { root: path.join(import.meta.dirname, '../..') },
  allowedDevOrigins: [new URL(env.NEXT_PUBLIC_API_URL).hostname],
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
        ],
      },
    ]);
  },
};

export default nextConfig;

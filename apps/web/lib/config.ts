import { z } from 'zod';

/**
 * Public configuration, inlined by Next.js at build time from the validated root .env
 * (next.config.mjs). `process.env.NEXT_PUBLIC_*` must be referenced literally for inlining.
 */
export const publicConfig = z
  .object({
    apiUrl: z.url(),
    gatewayUrl: z.url(),
    turnstileSiteKey: z.string().min(1),
  })
  .parse({
    apiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
    gatewayUrl: process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:4001',
    turnstileSiteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '1x00000000000000000000AA',
  });

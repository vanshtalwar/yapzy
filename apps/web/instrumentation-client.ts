import { z } from 'zod';

// Runs before any app code. Zod probes `Function('')` to decide whether to JIT-compile parsers,
// which the CSP (no 'unsafe-eval') reports as a violation; parse without the probe (D-100).
z.config({ jitless: true });

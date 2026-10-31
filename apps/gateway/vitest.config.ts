import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Files share Redis DB 13 and real gateway instances; run them one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // Business logic ≥ 70 % of lines (Part 10); server.ts is process wiring only.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test/**', 'src/server.ts'],
      thresholds: { lines: 70 },
    },
  },
});

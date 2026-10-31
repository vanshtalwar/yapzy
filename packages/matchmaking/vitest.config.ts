import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Coverage target (Part 10): ≥ 90 % of lines (`pnpm test:coverage`).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 90 },
    },
  },
});

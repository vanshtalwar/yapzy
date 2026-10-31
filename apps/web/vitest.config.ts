import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Business logic (lib/) ≥ 70 % of lines (Part 10). Excluded: test fakes, and browser glue
    // that needs a real browser (React singletons/hooks, Socket.io factory, canvas capture,
    // Web Audio meter) — covered by the Playwright suite in e2e/.
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts'],
      exclude: [
        'lib/**/*.test.ts',
        'lib/rtc/testing.ts',
        'lib/chat.ts',
        'lib/socket.ts',
        'lib/rtc/use-audio-level.ts',
        'lib/moderation/frame-grabber.ts',
      ],
      thresholds: { lines: 70 },
    },
  },
});

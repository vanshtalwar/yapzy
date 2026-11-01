import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFrameRingBuffer } from './frame-buffer.ts';
import { createFrameSampler, type UploadResult } from './frame-sampler.ts';
import { createNsfwWatcher, verdictOf } from './nsfw.ts';

const frame = (n: number) => new Blob([String(n)], { type: 'image/jpeg' });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('frame sampler (server-assigned schedule)', () => {
  function setup(results: UploadResult[] = [], random = () => 0.5) {
    const uploads: number[] = [];
    let n = 0;
    const sampler = createFrameSampler({
      grab: () => Promise.resolve(frame((n += 1))),
      upload: () => {
        uploads.push(Date.now());
        return Promise.resolve(results.shift() ?? 'ok');
      },
      random,
    });
    return { sampler, uploads };
  }

  it('uploads the first frame within the first interval, then every interval ± jitter', async () => {
    const start = Date.now();
    const { sampler, uploads } = setup();
    sampler.setSchedule({ frameIntervalMs: 20_000, maxFrames: null });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(uploads).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); // random 0.5 → half of the first interval
    expect(uploads).toEqual([start + 10_000]);
    // Next ones at 0.85 + 0.5 × 0.35 = 1.025 × 20 s, never faster than the server's 80 %.
    await vi.advanceTimersByTimeAsync(20_500);
    expect(uploads).toEqual([start + 10_000, start + 30_500]);
    expect(sampler.sent).toBe(2);
    sampler.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(uploads).toHaveLength(2);
  });

  it('keeps every gap within the jitter bounds', async () => {
    let flip = 0;
    const { sampler, uploads } = setup([], () => [0, 1][(flip += 1) % 2] ?? 0);
    sampler.setSchedule({ frameIntervalMs: 10_000, maxFrames: null });
    await vi.advanceTimersByTimeAsync(100_000);
    const gaps = uploads.slice(1).map((at, i) => at - (uploads[i] ?? 0));
    expect(gaps.length).toBeGreaterThan(4);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(8_500);
      expect(gap).toBeLessThanOrEqual(12_000);
    }
  });

  it('sends nothing without a schedule, stops at maxFrames or when the server says so', async () => {
    const none = setup();
    none.sampler.setSchedule({ frameIntervalMs: null });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(none.uploads).toHaveLength(0);

    const spot = setup();
    spot.sampler.setSchedule({ frameIntervalMs: 10_000, maxFrames: 1 });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(spot.uploads).toHaveLength(1);

    const refused = setup(['ok', 'stop']);
    refused.sampler.setSchedule({ frameIntervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(refused.uploads).toHaveLength(2);

    const flaky = setup(['skip', 'ok']);
    flaky.sampler.setSchedule({ frameIntervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(flaky.uploads).toHaveLength(2);
    expect(flaky.sampler.sent).toBe(1); // a skipped upload is not counted
  });

  it('applies a new schedule at once (e.g. raised to the high tier)', async () => {
    const start = Date.now();
    const { sampler, uploads } = setup();
    sampler.setSchedule({ frameIntervalMs: 120_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    sampler.setSchedule({ frameIntervalMs: 20_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(uploads).toEqual([start + 15_000]);
  });
});

describe('evidence ring buffer', () => {
  it('keeps only the last 3 frames, in memory', async () => {
    let n = 0;
    const buffer = createFrameRingBuffer({ grab: () => Promise.resolve(frame((n += 1))) });
    await vi.advanceTimersByTimeAsync(15_000);
    const frames = buffer.snapshot();
    expect(frames).toHaveLength(3);
    expect(await Promise.all(frames.map((f) => f.text()))).toEqual(['3', '4', '5']);
    buffer.stop();
    expect(buffer.snapshot()).toEqual([]);
  });
});

describe('client NSFW check', () => {
  it('flags explicit classes above the threshold and weighs suggestive ones less', () => {
    expect(verdictOf([{ className: 'Porn', probability: 0.9 }])).toEqual({
      flagged: true,
      kind: 'porn',
      score: 0.9,
    });
    expect(verdictOf([{ className: 'Hentai', probability: 0.5 }]).flagged).toBe(false);
    expect(verdictOf([{ className: 'Sexy', probability: 0.99 }])).toMatchObject({
      flagged: false,
      kind: 'sexy',
    });
    expect(verdictOf([{ className: 'Neutral', probability: 0.99 }]).score).toBe(0);
  });

  it('classifies the stranger every 2 s and the own video every 5 s', async () => {
    const remote = { videoWidth: 640 } as HTMLVideoElement;
    const self = { videoWidth: 640 } as HTMLVideoElement;
    const seen: string[] = [];
    const watcher = createNsfwWatcher({
      remotes: () => [{ participantId: 'pAlice000001', video: remote }],
      self: () => self,
      onRemote: (_participantId, verdict) => seen.push(`remote:${String(verdict.flagged)}`),
      onSelf: (verdict) => seen.push(`self:${String(verdict.flagged)}`),
      load: () =>
        Promise.resolve({
          classify: (element: HTMLVideoElement) =>
            Promise.resolve([{ className: 'Porn', probability: element === remote ? 0.95 : 0.1 }]),
        }),
    });
    await vi.advanceTimersByTimeAsync(10_100);
    expect(seen.filter((s) => s.startsWith('remote'))).toEqual(Array(5).fill('remote:true'));
    expect(seen.filter((s) => s.startsWith('self'))).toEqual(['self:false', 'self:false']);
    watcher.stop();
  });

  it('takes the strangers of a group call in turns (one inference per 2 s)', async () => {
    const videos = [0, 1, 2].map(() => ({ videoWidth: 640 }) as HTMLVideoElement);
    const seen: string[] = [];
    const watcher = createNsfwWatcher({
      remotes: () =>
        videos.map((video, index) => ({ participantId: `pPeer00000${String(index)}`, video })),
      self: () => null,
      onRemote: (participantId) => seen.push(participantId),
      onSelf: () => undefined,
      load: () => Promise.resolve({ classify: () => Promise.resolve([]) }),
    });
    await vi.advanceTimersByTimeAsync(6_100);
    expect(seen).toEqual(['pPeer000000', 'pPeer000001', 'pPeer000002']);
    watcher.stop();
  });
});

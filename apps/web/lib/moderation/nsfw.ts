/**
 * Client-side NSFW check (Part 8): NSFWJS MobileNetV2, self-hosted under /models/nsfw/ and
 * loaded lazily — only once a video call starts. Inference runs when the main thread is
 * idle, never on the render path.
 */
export interface NsfwPrediction {
  className: string;
  probability: number;
}

export interface NsfwVerdict {
  flagged: boolean;
  /** Label sent with `moderation:signal` (`[a-z_]`). */
  kind: string;
  score: number;
}

export const NSFW_THRESHOLD = 0.85;
/** "Sexy" (suggestive, not explicit) counts at a lower weight. */
const SUGGESTIVE_WEIGHT = 0.6;

export function verdictOf(predictions: NsfwPrediction[]): NsfwVerdict {
  const probability = (name: string) =>
    predictions.find((prediction) => prediction.className === name)?.probability ?? 0;
  const scores = [
    { kind: 'porn', score: probability('Porn') },
    { kind: 'hentai', score: probability('Hentai') },
    { kind: 'sexy', score: probability('Sexy') * SUGGESTIVE_WEIGHT },
  ];
  const worst = scores.reduce((a, b) => (b.score > a.score ? b : a));
  return { flagged: worst.score >= NSFW_THRESHOLD, kind: worst.kind, score: worst.score };
}

interface Classifier {
  classify(input: HTMLVideoElement): Promise<NsfwPrediction[]>;
}

let model: Promise<Classifier> | null = null;

export function loadNsfwModel(): Promise<Classifier> {
  model ??= (async () => {
    const [tf, nsfw] = await Promise.all([import('@tensorflow/tfjs'), import('nsfwjs/core')]);
    tf.enableProdMode();
    await tf.ready();
    return nsfw.load('/models/nsfw/', { size: 224 });
  })();
  model.catch(() => {
    model = null; // allow a retry on the next call
  });
  return model;
}

function whenIdle(task: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(task, { timeout: 1_000 });
  else setTimeout(task, 0);
}

/**
 * Classifies the stranger's video every 2 s and the own video every 5 s.
 * `onRemote` / `onSelf` get every verdict; callers act on `flagged`.
 */
export function createNsfwWatcher(deps: {
  remote: () => HTMLVideoElement | null;
  self: () => HTMLVideoElement | null;
  onRemote: (verdict: NsfwVerdict) => void;
  onSelf: (verdict: NsfwVerdict) => void;
  load?: () => Promise<Classifier>;
}) {
  let stopped = false;
  let busy = false;
  const timers: ReturnType<typeof setInterval>[] = [];
  const classifier = (deps.load ?? loadNsfwModel)();

  function check(video: () => HTMLVideoElement | null, report: (v: NsfwVerdict) => void) {
    if (busy || stopped) return;
    whenIdle(() => {
      const element = video();
      if (stopped || busy || element === null || element.videoWidth === 0) return;
      busy = true;
      classifier
        .then((model) => model.classify(element))
        .then((predictions) => {
          if (!stopped) report(verdictOf(predictions));
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    });
  }

  timers.push(
    setInterval(() => {
      check(deps.remote, deps.onRemote);
    }, 2_000),
    setInterval(() => {
      check(deps.self, deps.onSelf);
    }, 5_000),
  );

  return {
    stop(): void {
      stopped = true;
      for (const timer of timers) clearInterval(timer);
    },
  };
}

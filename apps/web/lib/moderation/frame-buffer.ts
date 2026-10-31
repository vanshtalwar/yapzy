/**
 * The stranger's last few frames, kept in memory only — they leave the browser solely as
 * evidence when the user reports (never uploaded otherwise).
 */
export function createFrameRingBuffer(deps: {
  grab: () => Promise<Blob | null>;
  size?: number;
  intervalMs?: number;
}) {
  const size = deps.size ?? 3;
  const frames: Blob[] = [];
  const timer = setInterval(() => {
    deps.grab().then(
      (frame) => {
        if (frame === null) return;
        frames.push(frame);
        if (frames.length > size) frames.shift();
      },
      () => undefined,
    );
  }, deps.intervalMs ?? 3_000);

  return {
    snapshot(): Blob[] {
      return [...frames];
    },
    stop(): void {
      clearInterval(timer);
      frames.length = 0;
    },
  };
}

export type FrameRingBuffer = ReturnType<typeof createFrameRingBuffer>;

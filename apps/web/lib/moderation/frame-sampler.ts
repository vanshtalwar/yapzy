import { type FrameSchedulePayload } from '@app/shared';

export type UploadResult = 'ok' | 'skip' | 'stop';

export interface FrameSamplerDeps {
  /** A downscaled JPEG of the own outgoing video (null if none is available right now). */
  grab: () => Promise<Blob | null>;
  /** 'skip' = try again next time (network, too early); 'stop' = the server expects no more. */
  upload: (frame: Blob) => Promise<UploadResult>;
  random?: () => number;
}

/** Jitter around the assigned interval; the server accepts gaps from 80 % of it. */
export const JITTER = { min: 0.85, max: 1.2 } as const;

/**
 * Server-assigned frame sampling (D-054): uploads a frame of the own video every
 * `frameIntervalMs` with jitter, the first one at a random point within the first interval,
 * at most `maxFrames`. `null` = no uploads. Schedules can change mid-session (FRAME_SCHEDULE).
 */
export function createFrameSampler(deps: FrameSamplerDeps) {
  const random = deps.random ?? Math.random;
  let schedule: { intervalMs: number; maxFrames: number | null } | null = null;
  let sent = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function plan(first: boolean): void {
    clearTimeout(timer);
    if (stopped || schedule === null) return;
    if (schedule.maxFrames !== null && sent >= schedule.maxFrames) return;
    const factor = first ? random() : JITTER.min + random() * (JITTER.max - JITTER.min);
    timer = setTimeout(() => void tick(), Math.round(schedule.intervalMs * factor));
  }

  async function tick(): Promise<void> {
    if (stopped || schedule === null) return;
    const frame = await deps.grab();
    const result = frame === null ? 'skip' : await deps.upload(frame);
    if (result === 'stop') {
      stopped = true;
      return;
    }
    if (result === 'ok') sent += 1;
    plan(false);
  }

  return {
    setSchedule(next: FrameSchedulePayload | null): void {
      const intervalMs = next?.frameIntervalMs ?? null;
      schedule = intervalMs === null ? null : { intervalMs, maxFrames: next?.maxFrames ?? null };
      plan(true);
    },
    stop(): void {
      stopped = true;
      clearTimeout(timer);
    },
    get sent(): number {
      return sent;
    },
  };
}

export type FrameSampler = ReturnType<typeof createFrameSampler>;

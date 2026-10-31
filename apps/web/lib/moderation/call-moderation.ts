import { type FrameSchedulePayload } from '@app/shared';

import { createFrameRingBuffer } from './frame-buffer.ts';
import { createFrameGrabber } from './frame-grabber.ts';
import { createFrameSampler, type UploadResult } from './frame-sampler.ts';
import { createNsfwWatcher, type NsfwVerdict } from './nsfw.ts';

export interface CallModerationOptions {
  sessionId: string;
  localStream: () => MediaStream | null;
  remoteStream: () => MediaStream | null;
  schedule: FrameSchedulePayload;
  /** `moderation:signal` about the stranger (rate-limited here to one per 5 s). */
  signal: (verdict: NsfwVerdict) => void;
  /** Blur the stranger's video. */
  onRemoteFlagged: () => void;
  /** Warn the user about their own camera (at most every 30 s). */
  onSelfFlagged: () => void;
}

export interface CallModeration {
  setSchedule(schedule: FrameSchedulePayload | null): void;
  /** The stranger's last frames (in memory), attached to a report. */
  evidence(): Blob[];
  stop(): void;
}

/** Moderation frames: ≤ 320 px, small enough for the 60 KB limit. */
const OWN_FRAME = { maxSize: 320, quality: 0.7 } as const;
/** Report evidence: sharper, still well under the 300 KB limit. */
const EVIDENCE_FRAME = { maxSize: 640, quality: 0.85 } as const;
const SIGNAL_EVERY_MS = 5_000;
const SELF_WARNING_EVERY_MS = 30_000;

/** Everything trust & safety does during one video call (Part 8). */
export function createCallModeration(
  options: CallModerationOptions,
  deps: {
    uploadFrame: (sessionId: string, frame: Blob) => Promise<UploadResult>;
    /** Client NSFW model (off in tests / unsupported browsers). */
    nsfw: boolean;
  },
): CallModeration {
  const local = createFrameGrabber(options.localStream);
  const remote = createFrameGrabber(options.remoteStream);
  const sampler = createFrameSampler({
    grab: () => local.grab(OWN_FRAME),
    upload: (frame) => deps.uploadFrame(options.sessionId, frame),
  });
  sampler.setSchedule(options.schedule);
  const buffer = createFrameRingBuffer({ grab: () => remote.grab(EVIDENCE_FRAME) });

  let remoteFlagged = false;
  let lastSignal = Number.NEGATIVE_INFINITY;
  let lastWarning = Number.NEGATIVE_INFINITY;
  const watcher = deps.nsfw
    ? createNsfwWatcher({
        remote: () => remote.element(),
        self: () => local.element(),
        onRemote: (verdict) => {
          if (!verdict.flagged) return;
          if (!remoteFlagged) {
            remoteFlagged = true;
            options.onRemoteFlagged();
          }
          const now = performance.now();
          if (now - lastSignal >= SIGNAL_EVERY_MS) {
            lastSignal = now;
            options.signal(verdict);
          }
        },
        onSelf: (verdict) => {
          const now = performance.now();
          if (verdict.flagged && now - lastWarning >= SELF_WARNING_EVERY_MS) {
            lastWarning = now;
            options.onSelfFlagged();
          }
        },
      })
    : null;

  return {
    setSchedule: (schedule) => {
      sampler.setSchedule(schedule);
    },
    evidence: () => buffer.snapshot(),
    stop() {
      sampler.stop();
      buffer.stop();
      watcher?.stop();
      local.stop();
      remote.stop();
    },
  };
}

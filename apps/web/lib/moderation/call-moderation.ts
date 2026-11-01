import { type FrameSchedulePayload } from '@app/shared';

import { createFrameRingBuffer, type FrameRingBuffer } from './frame-buffer.ts';
import { createFrameGrabber, type FrameGrabber } from './frame-grabber.ts';
import { createFrameSampler, type UploadResult } from './frame-sampler.ts';
import { createNsfwWatcher, type NsfwVerdict } from './nsfw.ts';

export interface CallModerationOptions {
  sessionId: string;
  localStream: () => MediaStream | null;
  /** A remote participant's media (group calls have up to three). */
  remoteStream: (participantId: string) => MediaStream | null;
  /** Remote participants at the start; `addRemote`/`removeRemote` follow joins and leaves. */
  remotes: string[];
  schedule: FrameSchedulePayload;
  /** `moderation:signal` about that participant (rate-limited here to one per 5 s each). */
  signal: (participantId: string, verdict: NsfwVerdict) => void;
  /** Blur that participant's video. */
  onRemoteFlagged: (participantId: string) => void;
  /** Warn the user about their own camera (at most every 30 s). */
  onSelfFlagged: () => void;
}

export interface CallModeration {
  setSchedule(schedule: FrameSchedulePayload | null): void;
  addRemote(participantId: string): void;
  removeRemote(participantId: string): void;
  /** That participant's last frames (in memory), attached to a report about them. */
  evidence(participantId: string): Blob[];
  stop(): void;
}

/** Moderation frames: ≤ 320 px, small enough for the 60 KB limit. */
const OWN_FRAME = { maxSize: 320, quality: 0.7 } as const;
/** Report evidence: sharper, still well under the 300 KB limit. */
const EVIDENCE_FRAME = { maxSize: 640, quality: 0.85 } as const;
const SIGNAL_EVERY_MS = 5_000;
const SELF_WARNING_EVERY_MS = 30_000;

interface Remote {
  grabber: FrameGrabber;
  buffer: FrameRingBuffer;
  flagged: boolean;
  lastSignal: number;
}

/**
 * Everything trust & safety does during one video call (Part 8), per remote participant in
 * group calls (Part 12): own frames for server-side checks (one sampler per call), and for
 * every stranger an in-memory evidence buffer and the client NSFW check.
 */
export function createCallModeration(
  options: CallModerationOptions,
  deps: {
    uploadFrame: (sessionId: string, frame: Blob) => Promise<UploadResult>;
    /** Client NSFW model (off in tests / unsupported browsers). */
    nsfw: boolean;
  },
): CallModeration {
  const local = createFrameGrabber(options.localStream);
  const sampler = createFrameSampler({
    grab: () => local.grab(OWN_FRAME),
    upload: (frame) => deps.uploadFrame(options.sessionId, frame),
  });
  sampler.setSchedule(options.schedule);

  const remotes = new Map<string, Remote>();
  function addRemote(participantId: string): void {
    if (remotes.has(participantId)) return;
    const grabber = createFrameGrabber(() => options.remoteStream(participantId));
    remotes.set(participantId, {
      grabber,
      buffer: createFrameRingBuffer({ grab: () => grabber.grab(EVIDENCE_FRAME) }),
      flagged: false,
      lastSignal: Number.NEGATIVE_INFINITY,
    });
  }
  for (const participantId of options.remotes) addRemote(participantId);

  let lastWarning = Number.NEGATIVE_INFINITY;
  const watcher = deps.nsfw
    ? createNsfwWatcher({
        remotes: () =>
          [...remotes].map(([participantId, remote]) => ({
            participantId,
            video: remote.grabber.element(),
          })),
        self: () => local.element(),
        onRemote: (participantId, verdict) => {
          const remote = remotes.get(participantId);
          if (remote === undefined || !verdict.flagged) return;
          if (!remote.flagged) {
            remote.flagged = true;
            options.onRemoteFlagged(participantId);
          }
          const now = performance.now();
          if (now - remote.lastSignal >= SIGNAL_EVERY_MS) {
            remote.lastSignal = now;
            options.signal(participantId, verdict);
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
    addRemote,
    removeRemote(participantId) {
      const remote = remotes.get(participantId);
      if (remote === undefined) return;
      remotes.delete(participantId);
      remote.buffer.stop();
      remote.grabber.stop();
    },
    evidence: (participantId) => remotes.get(participantId)?.buffer.snapshot() ?? [],
    stop() {
      sampler.stop();
      watcher?.stop();
      local.stop();
      for (const remote of remotes.values()) {
        remote.buffer.stop();
        remote.grabber.stop();
      }
      remotes.clear();
    },
  };
}

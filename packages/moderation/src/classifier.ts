export interface ImageLabel {
  name: string;
  /** 0–1 confidence. */
  score: number;
}

export interface ClassifyContext {
  /** Who sent the frame (used by the dev mock only; real classifiers look at pixels). */
  visitorId?: string;
}

/**
 * Server-side image classifier for sampled video frames. Production plugs in a real model
 * (a hosted moderation API, or an on-prem NSFW/violence model server); the worker only
 * depends on this interface.
 */
export interface ImageClassifier {
  classify(jpeg: Uint8Array, context?: ClassifyContext): Promise<{ labels: ImageLabel[] }>;
}

/** Labels that count as a violation when they reach the threshold. */
export const FLAG_LABELS = ['sexual_explicit', 'sexual_minor_risk', 'violence_graphic'] as const;

/** Highest-scoring violation label at or above `threshold`, if any. */
export function flaggedLabel(labels: ImageLabel[], threshold: number): ImageLabel | null {
  let worst: ImageLabel | null = null;
  for (const label of labels) {
    if (!(FLAG_LABELS as readonly string[]).includes(label.name) || label.score < threshold) {
      continue;
    }
    if (worst === null || label.score > worst.score) worst = label;
  }
  return worst;
}

/**
 * Development classifier: every frame is safe, except frames of visitors listed in
 * `DEV_FORCE_FLAG_VISITOR_IDS`, which are always flagged — deterministic, and no real
 * content is ever needed to exercise the pipeline.
 */
export class MockImageClassifier implements ImageClassifier {
  private readonly forceFlag: ReadonlySet<string>;

  constructor(forceFlagVisitorIds: Iterable<string> = []) {
    this.forceFlag = new Set(forceFlagVisitorIds);
  }

  classify(_jpeg: Uint8Array, context: ClassifyContext = {}): Promise<{ labels: ImageLabel[] }> {
    const flagged = context.visitorId !== undefined && this.forceFlag.has(context.visitorId);
    return Promise.resolve({
      labels: flagged
        ? [{ name: 'sexual_explicit', score: 0.99 }]
        : [{ name: 'neutral', score: 0.99 }],
    });
  }
}

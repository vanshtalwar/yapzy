export interface BanTarget {
  visitorId?: string | null;
  deviceIdHash?: string | null;
  ipHash?: string | null;
}

export class BanTargetError extends Error {
  constructor() {
    super('A ban needs at least one of visitorId, deviceIdHash or ipHash');
    this.name = 'BanTargetError';
  }
}

/**
 * A ban must identify someone. The DB enforces this too (CHECK bans_target_required); checking
 * in code first gives callers a typed error instead of a raw constraint violation.
 */
export function assertBanHasTarget(target: BanTarget): void {
  const hasTarget = [target.visitorId, target.deviceIdHash, target.ipHash].some(
    (value) => value !== undefined && value !== null && value !== '',
  );
  if (!hasTarget) throw new BanTargetError();
}

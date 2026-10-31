/**
 * Classic token bucket: holds up to `capacity` tokens and refills continuously at
 * `refillPerSecond`. Fractional costs are allowed (e.g. ICE candidates are cheap).
 */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(
    capacity: number,
    refillPerSecond: number,
    now: () => number = performance.now.bind(performance),
  ) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSecond / 1000;
    this.now = now;
    this.tokens = capacity;
    this.updatedAt = now();
  }

  /** Takes `cost` tokens if available; returns false (taking nothing) otherwise. */
  take(cost: number): boolean {
    const now = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.updatedAt) * this.refillPerMs);
    this.updatedAt = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

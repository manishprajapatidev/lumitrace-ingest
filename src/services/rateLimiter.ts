/**
 * Per-token sliding-window rate limiter (in-memory). Single-node only.
 * Use Redis (e.g. @upstash/ratelimit) when scaling out.
 */
const WINDOW_MS = 60_000;

interface Bucket {
  count: number;
  resetAt: number;
}

export class TokenRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(
    private readonly limit: number,
    private readonly windowMs = WINDOW_MS,
  ) {}

  /** Returns true if the request is allowed. */
  hit(key: string, weight = 1): { allowed: boolean; remaining: number; resetIn: number } {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, b);
    }
    if (b.count + weight > this.limit) {
      return { allowed: false, remaining: Math.max(0, this.limit - b.count), resetIn: b.resetAt - now };
    }
    b.count += weight;
    return { allowed: true, remaining: this.limit - b.count, resetIn: b.resetAt - now };
  }

  /** Periodic cleanup so the Map can't grow unbounded. */
  sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.buckets) {
      if (v.resetAt <= now) this.buckets.delete(k);
    }
  }
}

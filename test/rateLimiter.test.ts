import { describe, it, expect } from 'vitest';
import { TokenRateLimiter } from '../src/services/rateLimiter.js';

describe('TokenRateLimiter', () => {
  it('allows requests under the limit', () => {
    const rl = new TokenRateLimiter(3);
    expect(rl.hit('k').allowed).toBe(true);
    expect(rl.hit('k').allowed).toBe(true);
    expect(rl.hit('k').allowed).toBe(true);
    expect(rl.hit('k').allowed).toBe(false);
  });

  it('isolates buckets per key', () => {
    const rl = new TokenRateLimiter(1);
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('b').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(false);
  });

  it('reports remaining tokens', () => {
    const rl = new TokenRateLimiter(5);
    const r = rl.hit('x');
    expect(r.remaining).toBe(4);
  });

  it('supports custom windows', () => {
    const rl = new TokenRateLimiter(1, 15 * 60 * 1000);
    const first = rl.hit('email:user@example.com');
    const second = rl.hit('email:user@example.com');
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.resetIn).toBeGreaterThan(60_000);
  });
});

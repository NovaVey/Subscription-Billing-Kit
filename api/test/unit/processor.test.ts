import { describe, expect, it } from 'vitest';
import { computeBackoffSeconds, MAX_ATTEMPTS } from '../../src/webhooks/processor.js';

describe('computeBackoffSeconds doubles per attempt, capped by the attempts-exponent ceiling', () => {
  it('returns the exact backoff sequence for attempts 1 through 8', () => {
    // Read straight off the current implementation (not the comment above
    // it): exponent = Math.min(attempts, 7) - 1, so the exponent - and
    // therefore the backoff - stops growing once attempts reaches 7. That
    // plateaus at 30 * 2**6 = 1920s, never at the 3600s MAX_BACKOFF_SECONDS
    // the neighboring comment describes - MAX_BACKOFF_SECONDS is currently
    // unreachable through this formula. This test asserts the real,
    // observed sequence.
    expect(computeBackoffSeconds(1)).toBe(30);
    expect(computeBackoffSeconds(2)).toBe(60);
    expect(computeBackoffSeconds(3)).toBe(120);
    expect(computeBackoffSeconds(4)).toBe(240);
    expect(computeBackoffSeconds(5)).toBe(480);
    expect(computeBackoffSeconds(6)).toBe(960);
    expect(computeBackoffSeconds(7)).toBe(1920);
    expect(computeBackoffSeconds(8)).toBe(1920);
  });

  it('never exceeds MAX_ATTEMPTS worth of doubling in real usage (attempts caps out at 5)', () => {
    // MAX_ATTEMPTS is 5 in this codebase, so processRow only ever calls
    // computeBackoffSeconds with attempts in [1, MAX_ATTEMPTS - 1] before a
    // row is parked as 'failed' instead of retried. Documents that the
    // plateau/cap behavior above attempts=7 is not exercised by the real
    // retry path today.
    expect(MAX_ATTEMPTS).toBe(5);
    expect(computeBackoffSeconds(MAX_ATTEMPTS - 1)).toBe(240);
  });
});

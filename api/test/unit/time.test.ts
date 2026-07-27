import { describe, expect, it } from 'vitest';
import {
  fromStripeSeconds,
  fromStripeSecondsOrNull,
  toStripeSeconds,
  toStripeSecondsOrNull,
} from '../../src/lib/time.js';

describe('stripe second timestamps round trip without a thousand times error', () => {
  it('converts a known Stripe second timestamp to the correct Date', () => {
    // 1717200000 seconds = 2024-06-01T00:00:00.000Z. Getting the ×1000
    // wrong here lands somewhere around the year 1970 or the year 55000.
    const date = fromStripeSeconds(1_717_200_000);
    expect(date.toISOString()).toBe('2024-06-01T00:00:00.000Z');
  });

  it('converts a Date back to the same Stripe second timestamp', () => {
    const seconds = toStripeSeconds(new Date('2024-06-01T00:00:00.000Z'));
    expect(seconds).toBe(1_717_200_000);
  });

  it('round-trips seconds -> Date -> seconds for an arbitrary timestamp', () => {
    const original = 1_800_000_000;
    expect(toStripeSeconds(fromStripeSeconds(original))).toBe(original);
  });

  it('round-trips Date -> seconds -> Date (to the second) for an arbitrary date', () => {
    const original = new Date('2026-01-15T12:34:56.000Z');
    const roundTripped = fromStripeSeconds(toStripeSeconds(original));
    expect(roundTripped.toISOString()).toBe(original.toISOString());
  });

  it('does not land in the year 55000 (the thousand-times-error canary)', () => {
    const date = fromStripeSeconds(1_717_200_000);
    expect(date.getUTCFullYear()).toBe(2024);
  });

  it('passes null and undefined through the nullable variants unchanged', () => {
    expect(fromStripeSecondsOrNull(null)).toBeNull();
    expect(fromStripeSecondsOrNull(undefined)).toBeNull();
    expect(toStripeSecondsOrNull(null)).toBeNull();
    expect(toStripeSecondsOrNull(undefined)).toBeNull();
  });

  it('converts real values through the nullable variants', () => {
    expect(fromStripeSecondsOrNull(1_717_200_000)?.toISOString()).toBe('2024-06-01T00:00:00.000Z');
    expect(toStripeSecondsOrNull(new Date('2024-06-01T00:00:00.000Z'))).toBe(1_717_200_000);
  });
});

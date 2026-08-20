import { describe, expect, it } from 'vitest';
import { addSameCurrency, isZeroDecimalCurrency, toDisplay, toMinor } from '../../src/lib/money.js';

describe('money', () => {
  describe('zero-decimal currencies do not get divided by one hundred', () => {
    it('treats JPY as zero-decimal for toMinor', () => {
      // 500 JPY is minor amount 500, not 50000.
      expect(toMinor(500, 'jpy')).toBe(500);
    });

    it('treats JPY as zero-decimal for toDisplay', () => {
      expect(toDisplay(500, 'JPY')).toBe(500);
    });

    it('is case-insensitive on the currency code', () => {
      expect(isZeroDecimalCurrency('JPY')).toBe(true);
      expect(isZeroDecimalCurrency('jpy')).toBe(true);
    });

    it('recognizes the full zero-decimal set', () => {
      for (const code of ['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']) {
        expect(isZeroDecimalCurrency(code)).toBe(true);
      }
    });

    it('does NOT treat UGX as zero-decimal, despite it being one in reality', () => {
      // Stripe kept UGX two-decimal in the API for backward compatibility.
      // Treating it as zero-decimal here would undercharge by 100x.
      expect(isZeroDecimalCurrency('ugx')).toBe(false);
      expect(toMinor(5, 'ugx')).toBe(500);
    });
  });

  describe('two-decimal currencies', () => {
    it('scales USD by 100 going to minor units', () => {
      expect(toMinor(19.99, 'usd')).toBe(1999);
    });

    it('scales USD by 100 going back to a display amount', () => {
      expect(toDisplay(1999, 'usd')).toBeCloseTo(19.99, 6);
    });

    it('rounds away floating point drift on the way to minor units', () => {
      // 19.99 * 100 is 1998.9999999999998 in raw floating point.
      expect(toMinor(19.99, 'usd')).toBe(1999);
      expect(toMinor(0.1 + 0.2, 'usd')).toBe(30);
    });
  });

  describe('adding amounts in different currencies throws', () => {
    it('sums same-currency amounts', () => {
      const result = addSameCurrency([
        { amountMinor: 1999, currency: 'usd' },
        { amountMinor: 500, currency: 'USD' },
      ]);
      expect(result).toEqual({ amountMinor: 2499, currency: 'usd' });
    });

    it('throws when currencies differ instead of coercing', () => {
      expect(() =>
        addSameCurrency([
          { amountMinor: 1999, currency: 'usd' },
          { amountMinor: 500, currency: 'jpy' },
        ]),
      ).toThrow(/mixed currencies/i);
    });

    it('throws on an empty list rather than returning a meaningless zero', () => {
      expect(() => addSameCurrency([])).toThrow();
    });
  });

  describe('the exact half-cent rounding boundary', () => {
    it('pins the current rounding direction for toMinor at +19.995', () => {
      // 19.995 * 100 is exactly 1999.5 in floating point, and Math.round
      // rounds half-way values toward +Infinity, so this rounds UP to
      // 2000 (i.e. $20.00, not $19.99). This test pins today's deliberate
      // behavior so an accidental change to the rounding logic is caught.
      expect(toMinor(19.995, 'usd')).toBe(2000);
    });

    it('pins the current rounding direction for toMinor at -19.995', () => {
      // -19.995 * 100 is exactly -1999.5. Math.round still rounds
      // half-way values toward +Infinity, so this rounds toward zero to
      // -1999 (i.e. -$19.99) rather than away from zero to -2000 —
      // asymmetric with the +19.995 case above. Pinning the current
      // behavior here, not asserting it is the "correct" direction.
      expect(toMinor(-19.995, 'usd')).toBe(-1999);
    });
  });

  describe('negative amounts (refunds / proration credits)', () => {
    it('nets a negative line against positive charges instead of mishandling or rejecting it', () => {
      const result = addSameCurrency([
        { amountMinor: 2900, currency: 'usd' },
        { amountMinor: -900, currency: 'usd' },
      ]);
      expect(result).toEqual({ amountMinor: 2000, currency: 'usd' });
    });
  });
});

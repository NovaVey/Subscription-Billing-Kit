import { describe, expect, it } from 'vitest';
import { classifyInvoices, computeYesterdayWindow } from '../../src/billing/reconcile.js';

describe('reconciliation classifies drift, missing, and orphan correctly', () => {
  it('reports a clean period as zero mismatches, with matching totals', () => {
    const shared = [
      { stripeInvoiceId: 'in_1', status: 'paid', amountDueMinor: 2900, amountPaidMinor: 2900 },
      { stripeInvoiceId: 'in_2', status: 'open', amountDueMinor: 7900, amountPaidMinor: 0 },
    ];
    const result = classifyInvoices(shared, shared, 'usd');
    expect(result.entries).toHaveLength(0);
    expect(result.mismatchCount).toBe(0);
    expect(result.stripeTotalMinor).toBe(result.localTotalMinor);
    expect(result.stripeTotalMinor).toBe(2900); // only in_1's amount_paid_minor counts toward "collected"
  });

  it('flags a status difference as a field_drift entry naming the field and both values', () => {
    const stripeSide = [{ stripeInvoiceId: 'in_1', status: 'paid', amountDueMinor: 2900, amountPaidMinor: 2900 }];
    const localSide = [{ stripeInvoiceId: 'in_1', status: 'open', amountDueMinor: 2900, amountPaidMinor: 2900 }];
    const result = classifyInvoices(stripeSide, localSide, 'usd');
    expect(result.entries).toEqual([
      { type: 'field_drift', stripeInvoiceId: 'in_1', field: 'status', stripeValue: 'paid', localValue: 'open' },
    ]);
  });

  it('flags an amount_due difference and an amount_paid difference as two separate entries', () => {
    const stripeSide = [{ stripeInvoiceId: 'in_1', status: 'paid', amountDueMinor: 2900, amountPaidMinor: 2900 }];
    const localSide = [{ stripeInvoiceId: 'in_1', status: 'paid', amountDueMinor: 1900, amountPaidMinor: 1900 }];
    const result = classifyInvoices(stripeSide, localSide, 'usd');
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => ('field' in e ? e.field : undefined))).toEqual(
      expect.arrayContaining(['amount_due_minor', 'amount_paid_minor']),
    );
  });

  it('flags a Stripe invoice with no local counterpart as missing_local', () => {
    const stripeSide = [{ stripeInvoiceId: 'in_1', status: 'paid', amountDueMinor: 2900, amountPaidMinor: 2900 }];
    const result = classifyInvoices(stripeSide, [], 'usd');
    expect(result.entries).toEqual([{ type: 'missing_local', stripeInvoiceId: 'in_1' }]);
  });

  it('flags a local invoice with no Stripe counterpart as orphan_local', () => {
    const localSide = [{ stripeInvoiceId: 'in_1', status: 'paid', amountDueMinor: 2900, amountPaidMinor: 2900 }];
    const result = classifyInvoices([], localSide, 'usd');
    expect(result.entries).toEqual([{ type: 'orphan_local', stripeInvoiceId: 'in_1' }]);
  });

  it('a missing invoice and an extra one of equal value do not net to a clean report', () => {
    // The exact case §5.11 calls out: comparing totals alone would hide this.
    const stripeSide = [{ stripeInvoiceId: 'in_missing', status: 'paid', amountDueMinor: 5000, amountPaidMinor: 5000 }];
    const localSide = [{ stripeInvoiceId: 'in_orphan', status: 'paid', amountDueMinor: 5000, amountPaidMinor: 5000 }];
    const result = classifyInvoices(stripeSide, localSide, 'usd');
    expect(result.stripeTotalMinor).toBe(result.localTotalMinor); // totals net to equal...
    expect(result.mismatchCount).toBe(2); // ...but the detailed report still catches both
    expect(result.entries.map((e) => e.type).sort()).toEqual(['missing_local', 'orphan_local']);
  });
});

describe('computeYesterdayWindow bounds "yesterday" explicitly in the given timezone', () => {
  it('returns an exact 24-hour window ending at the start of today, in UTC', () => {
    const now = new Date('2026-03-15T10:30:00.000Z');
    const { start, end } = computeYesterdayWindow('UTC', now);
    expect(end.toISOString()).toBe('2026-03-15T00:00:00.000Z');
    expect(start.toISOString()).toBe('2026-03-14T00:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('bounds the window by the target timezone\'s calendar day, not server-local or UTC', () => {
    // At 02:00 UTC, it's still the previous evening in America/New_York
    // (UTC-5) - "yesterday" there is a different calendar day than UTC's.
    const now = new Date('2026-03-15T02:00:00.000Z');
    const utcWindow = computeYesterdayWindow('UTC', now);
    const nyWindow = computeYesterdayWindow('America/New_York', now);
    expect(utcWindow.start.toISOString()).not.toBe(nyWindow.start.toISOString());
    expect(nyWindow.end.getTime() - nyWindow.start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('on the spring-forward transition day, does not stretch/shrink to the 23-hour local day - it stays a fixed 24h and bleeds into the day before', () => {
    // 2026-03-08 is the US spring-forward day: America/New_York jumps from
    // EST (UTC-5) to EDT (UTC-4) at 02:00 local, so the true local day is
    // only 23 wall-clock hours long (00:00 EST -> 00:00 EDT the next day).
    // `now` is the day after, so "yesterday" is the transition day itself.
    const now = new Date('2026-03-09T12:00:00.000Z');
    const { start, end } = computeYesterdayWindow('America/New_York', now);

    // `end` is derived using "today"'s (post-transition) EDT offset and
    // correctly lands on true local midnight, 2026-03-09T00:00:00 EDT.
    expect(end.toISOString()).toBe('2026-03-09T04:00:00.000Z');

    // `start` is just `end` minus a flat 24h, so it also uses EDT (-4)
    // rather than the EST (-5) offset actually in effect at the start of
    // March 8th. True local midnight for March 8th (EST) converts to
    // 2026-03-08T05:00:00.000Z; the computed start lands an hour earlier,
    // at 2026-03-08T04:00:00.000Z - which is 23:00 on March 7th in New
    // York, not midnight of the 8th. This is exactly the DST-boundary edge
    // case named in computeYesterdayWindow's own comment: because the
    // window is a fixed 24h rather than the true 23-hour local day, it
    // pulls in the last hour of March 7th's invoices as if they were part
    // of "yesterday".
    expect(start.toISOString()).toBe('2026-03-08T04:00:00.000Z');
    expect(start.toISOString()).not.toBe('2026-03-08T05:00:00.000Z'); // true local midnight of the 8th

    // The window length is unconditionally 24h - it's computed as
    // `end - 24h`, never re-derived from the target timezone's actual
    // (here, 23-hour) civil day, so a DST spring-forward never shrinks it.
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('on the fall-back transition day, does not stretch to the 25-hour local day - it stays a fixed 24h and misses the first local hour', () => {
    // 2026-11-01 is the US fall-back day: America/New_York drops from EDT
    // (UTC-4) to EST (UTC-5) at 02:00 local, so the true local day is 25
    // wall-clock hours long. `now` is the day after, so "yesterday" is the
    // transition day itself.
    const now = new Date('2026-11-02T12:00:00.000Z');
    const { start, end } = computeYesterdayWindow('America/New_York', now);

    // `end` is derived using "today"'s (post-transition) EST offset and
    // correctly lands on true local midnight, 2026-11-02T00:00:00 EST.
    expect(end.toISOString()).toBe('2026-11-02T05:00:00.000Z');

    // `start` is just `end` minus a flat 24h, so it also uses EST (-5)
    // rather than the EDT (-4) offset actually in effect at the start of
    // November 1st. True local midnight for November 1st (EDT) converts to
    // 2026-11-01T04:00:00.000Z; the computed start lands an hour later, at
    // 2026-11-01T05:00:00.000Z - which is 01:00 on November 1st in New
    // York, not midnight. So the window misses the 00:00-01:00 EDT hour of
    // "yesterday" - the same known DST-boundary edge case named in
    // computeYesterdayWindow's own comment, here dropping an hour of
    // invoices rather than double-counting one.
    expect(start.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(start.toISOString()).not.toBe('2026-11-01T04:00:00.000Z'); // true local midnight of the 1st

    // The window length is unconditionally 24h - it's computed as
    // `end - 24h`, never re-derived from the target timezone's actual
    // (here, 25-hour) civil day, so a DST fall-back never stretches it.
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

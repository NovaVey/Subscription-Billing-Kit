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
});

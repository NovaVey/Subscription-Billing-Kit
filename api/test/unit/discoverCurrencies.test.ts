import { describe, expect, it, vi } from 'vitest';

// discoverCurrencies is the fix for the gap a local-only `SELECT DISTINCT
// currency FROM invoices` left in scripts/reconcile-nightly.ts: a currency
// Stripe invoiced but that never landed locally (sync broken, or hasn't run
// yet) previously meant the nightly job never even considered it. This unit
// test mocks the Stripe client the same way the reconciliation integration
// tests do, but - unlike those - never touches the database, since
// discoverCurrencies itself is pure Stripe-listing + dedup. See the deep
// bug hunt.

const mockInvoicesList = vi.fn();

vi.mock('../../src/stripe/client.js', () => ({
  stripe: {
    invoices: { list: (...args: unknown[]) => mockInvoicesList(...args) },
  },
}));

const { discoverCurrencies } = await import('../../src/billing/reconcile.js');
const { fakeInvoice } = await import('../integration/helpers/stripeFixtures.js');

describe('discoverCurrencies', () => {
  it('returns the distinct, lowercased set of currencies Stripe invoiced in the window', async () => {
    mockInvoicesList.mockReturnValue([
      fakeInvoice({ currency: 'usd' }),
      fakeInvoice({ currency: 'EUR' }),
      fakeInvoice({ currency: 'usd' }),
    ]);

    const result = await discoverCurrencies(new Date('2026-05-01T00:00:00Z'), new Date('2026-05-02T00:00:00Z'));

    expect(result).toEqual(['eur', 'usd']);
  });

  it('returns an empty array when Stripe has no invoices in the window', async () => {
    mockInvoicesList.mockReturnValue([]);
    const result = await discoverCurrencies(new Date('2026-05-01T00:00:00Z'), new Date('2026-05-02T00:00:00Z'));
    expect(result).toEqual([]);
  });

  it('passes the window through as gte/lt Stripe seconds, matching runReconciliation\'s own boundary semantics', async () => {
    mockInvoicesList.mockReturnValue([]);
    const start = new Date('2026-05-01T00:00:00Z');
    const end = new Date('2026-05-02T00:00:00Z');

    await discoverCurrencies(start, end);

    expect(mockInvoicesList).toHaveBeenCalledWith(
      expect.objectContaining({
        created: { gte: Math.floor(start.getTime() / 1000), lt: Math.floor(end.getTime() / 1000) },
      }),
    );
  });
});

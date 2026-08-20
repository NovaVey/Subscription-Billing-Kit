import { describe, expect, it, vi } from 'vitest';

// scripts/reconcile-nightly.ts's own per-currency loop logic (run
// runReconciliation once per distinct currency recorded in invoices, never
// mixing totals across currencies) is script-level logic, not just a
// pass-through to a tested library function - runReconciliation itself is
// already covered elsewhere at the single-currency level, but nothing
// previously exercised the loop. See the /improve audit.

const mockRunReconciliation = vi.fn();

vi.mock('../../../api/src/billing/reconcile.js', () => ({
  runReconciliation: (...args: unknown[]) => mockRunReconciliation(...args),
}));

const { reconcileEachCurrency } = await import('../../../scripts/reconcile-nightly.js');

describe('reconcileEachCurrency', () => {
  it('runs one reconciliation per distinct currency, each with the correct window and currency', async () => {
    mockRunReconciliation
      .mockResolvedValueOnce({ runId: 'run-usd', mismatchCount: 0, stripeTotalMinor: 100, localTotalMinor: 100, invoiceCountStripe: 1, invoiceCountLocal: 1, entries: [] })
      .mockResolvedValueOnce({ runId: 'run-jpy', mismatchCount: 1, stripeTotalMinor: 5000, localTotalMinor: 4000, invoiceCountStripe: 2, invoiceCountLocal: 2, entries: [] });

    const window = { periodStart: new Date('2026-05-01T00:00:00Z'), periodEnd: new Date('2026-05-02T00:00:00Z') };
    const results = await reconcileEachCurrency(window, ['usd', 'jpy']);

    expect(mockRunReconciliation).toHaveBeenCalledTimes(2);
    expect(mockRunReconciliation).toHaveBeenNthCalledWith(1, { ...window, currency: 'usd' });
    expect(mockRunReconciliation).toHaveBeenNthCalledWith(2, { ...window, currency: 'jpy' });

    expect(results).toEqual([
      { currency: 'usd', result: expect.objectContaining({ runId: 'run-usd' }) },
      { currency: 'jpy', result: expect.objectContaining({ runId: 'run-jpy' }) },
    ]);
  });

  it('never mixes one currency into another run - a usd invoice never appears in the jpy call', async () => {
    mockRunReconciliation.mockReset();
    mockRunReconciliation.mockImplementation(({ currency }: { currency: string }) =>
      Promise.resolve({
        runId: `run-${currency}`,
        mismatchCount: 0,
        stripeTotalMinor: 0,
        localTotalMinor: 0,
        invoiceCountStripe: 0,
        invoiceCountLocal: 0,
        entries: [],
      }),
    );

    const window = { periodStart: new Date('2026-05-01T00:00:00Z'), periodEnd: new Date('2026-05-02T00:00:00Z') };
    await reconcileEachCurrency(window, ['usd']);

    // Only ever called with the single requested currency - no cross-call
    // bleed of another currency's value into this one's args.
    expect(mockRunReconciliation).toHaveBeenCalledTimes(1);
    expect(mockRunReconciliation).toHaveBeenCalledWith(expect.objectContaining({ currency: 'usd' }));
  });

  it('returns an empty array and calls nothing for an empty currency list', async () => {
    mockRunReconciliation.mockReset();
    const window = { periodStart: new Date('2026-05-01T00:00:00Z'), periodEnd: new Date('2026-05-02T00:00:00Z') };
    const results = await reconcileEachCurrency(window, []);
    expect(results).toEqual([]);
    expect(mockRunReconciliation).not.toHaveBeenCalled();
  });
});

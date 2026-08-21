import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoicesList = vi.fn();

vi.mock('../../src/stripe/client.js', () => ({
  stripe: {
    invoices: { list: (...args: unknown[]) => mockInvoicesList(...args) },
  },
}));

const { db, pool } = await import('../../src/db/client.js');
const { customers, invoices, reconciliationRuns } = await import('../../src/db/schema.js');
const { runReconciliation } = await import('../../src/billing/reconcile.js');
const { fakeCustomer, fakeInvoice } = await import('./helpers/stripeFixtures.js');

const cleanupCustomerIds: string[] = [];
const cleanupInvoiceIds: string[] = [];
const cleanupRunIds: string[] = [];

// Each test gets its own day-long window (a different day of May 2026) so
// runReconciliation's local query - which fetches every local invoice in
// the period+currency, not just ones a given test cares about - can never
// pick up another test's leftover rows, whichever order they run in or
// whatever survives until afterAll's cleanup.
function windowForDay(day: number): { periodStart: Date; periodEnd: Date; inWindow: Date } {
  const pad = String(day).padStart(2, '0');
  return {
    periodStart: new Date(`2026-05-${pad}T00:00:00.000Z`),
    periodEnd: new Date(`2026-05-${pad}T23:59:59.000Z`),
    inWindow: new Date(`2026-05-${pad}T12:00:00.000Z`),
  };
}

async function seedCustomer() {
  const customer = fakeCustomer();
  const [row] = await db
    .insert(customers)
    .values({ stripeCustomerId: customer.id, email: customer.email })
    .returning({ id: customers.id });
  cleanupCustomerIds.push(row!.id);
  return row!.id;
}

async function seedLocalInvoice(
  customerId: string,
  overrides: {
    stripeInvoiceId: string;
    status: string;
    amountDueMinor: number;
    amountPaidMinor: number;
    // Reconciliation now windows local invoices by created_at, not
    // finalized_at (finding #18, deep bug hunt) - every seed call below
    // passes the same in-window instant for both, since none of these
    // tests care about created/finalized landing in different windows
    // (that's covered by its own test further down).
    createdAt: Date;
    finalizedAt: Date | null;
  },
) {
  const [row] = await db
    .insert(invoices)
    .values({
      customerId,
      stripeInvoiceId: overrides.stripeInvoiceId,
      status: overrides.status,
      currency: 'usd',
      amountDueMinor: overrides.amountDueMinor,
      amountPaidMinor: overrides.amountPaidMinor,
      createdAt: overrides.createdAt,
      finalizedAt: overrides.finalizedAt,
    })
    .returning({ id: invoices.id });
  cleanupInvoiceIds.push(row!.id);
  return row!.id;
}

beforeEach(() => {
  mockInvoicesList.mockReset();
});

afterAll(async () => {
  for (const id of cleanupRunIds) {
    await db.delete(reconciliationRuns).where(eq(reconciliationRuns.id, id));
  }
  for (const id of cleanupInvoiceIds) {
    await db.delete(invoices).where(eq(invoices.id, id));
  }
  for (const id of cleanupCustomerIds) {
    await db.delete(customers).where(eq(customers.id, id));
  }
  await pool.end();
});

describe('reconciliation-catches-a-status-drift', () => {
  it('reports field_drift on status when Stripe and the local row disagree', async () => {
    const { periodStart, periodEnd, inWindow } = windowForDay(1);
    const customerId = await seedCustomer();
    const invoice = fakeInvoice({ status: 'paid' });
    await seedLocalInvoice(customerId, {
      stripeInvoiceId: invoice.id,
      status: 'open',
      amountDueMinor: invoice.amount_due,
      amountPaidMinor: invoice.amount_paid,
      createdAt: inWindow,
      finalizedAt: inWindow,
    });
    mockInvoicesList.mockReturnValue([invoice]);

    const result = await runReconciliation({ periodStart, periodEnd, currency: 'usd' });
    cleanupRunIds.push(result.runId);

    const drift = result.entries.find((e) => e.stripeInvoiceId === invoice.id && 'field' in e && e.field === 'status');
    expect(drift).toMatchObject({ type: 'field_drift', field: 'status', stripeValue: 'paid', localValue: 'open' });
  });
});

describe('reconciliation-catches-an-amount-drift', () => {
  it('reports field_drift on amount_due_minor when a local invoice was corrupted', async () => {
    const { periodStart, periodEnd, inWindow } = windowForDay(2);
    const customerId = await seedCustomer();
    const invoice = fakeInvoice({ status: 'paid', amount_due: 5000, amount_paid: 5000 });
    await seedLocalInvoice(customerId, {
      stripeInvoiceId: invoice.id,
      status: 'paid',
      amountDueMinor: 1234, // corrupted
      amountPaidMinor: invoice.amount_paid,
      createdAt: inWindow,
      finalizedAt: inWindow,
    });
    mockInvoicesList.mockReturnValue([invoice]);

    const result = await runReconciliation({ periodStart, periodEnd, currency: 'usd' });
    cleanupRunIds.push(result.runId);

    const drift = result.entries.find(
      (e) => e.stripeInvoiceId === invoice.id && 'field' in e && e.field === 'amount_due_minor',
    );
    expect(drift).toMatchObject({ type: 'field_drift', field: 'amount_due_minor', stripeValue: 5000, localValue: 1234 });
  });
});

describe('reconciliation-catches-an-invoice-stripe-has-and-we-do-not', () => {
  it('reports missing_local for a Stripe invoice with no local row', async () => {
    const { periodStart, periodEnd } = windowForDay(3);
    const invoice = fakeInvoice({ status: 'paid' });
    mockInvoicesList.mockReturnValue([invoice]);

    const result = await runReconciliation({ periodStart, periodEnd, currency: 'usd' });
    cleanupRunIds.push(result.runId);

    expect(result.entries).toContainEqual({ type: 'missing_local', stripeInvoiceId: invoice.id });
  });
});

describe('reconciliation-catches-a-local-invoice-stripe-has-no-record-of', () => {
  it('reports orphan_local for a local invoice with no Stripe counterpart', async () => {
    const { periodStart, periodEnd, inWindow } = windowForDay(4);
    const customerId = await seedCustomer();
    const invoiceId = 'in_orphan_test_invoice';
    await seedLocalInvoice(customerId, {
      stripeInvoiceId: invoiceId,
      status: 'paid',
      amountDueMinor: 4200,
      amountPaidMinor: 4200,
      createdAt: inWindow,
      finalizedAt: inWindow,
    });
    mockInvoicesList.mockReturnValue([]); // Stripe has nothing in this window

    const result = await runReconciliation({ periodStart, periodEnd, currency: 'usd' });
    cleanupRunIds.push(result.runId);

    expect(result.entries).toContainEqual({ type: 'orphan_local', stripeInvoiceId: invoiceId });
  });
});

describe('a clean period stores a zero-mismatch run', () => {
  it('records mismatchCount 0 and equal totals when both sides agree', async () => {
    const { periodStart, periodEnd, inWindow } = windowForDay(5);
    const customerId = await seedCustomer();
    const invoice = fakeInvoice({ status: 'paid', amount_due: 2900, amount_paid: 2900 });
    await seedLocalInvoice(customerId, {
      stripeInvoiceId: invoice.id,
      status: 'paid',
      amountDueMinor: 2900,
      amountPaidMinor: 2900,
      createdAt: inWindow,
      finalizedAt: inWindow,
    });
    mockInvoicesList.mockReturnValue([invoice]);

    const result = await runReconciliation({ periodStart, periodEnd, currency: 'usd' });
    cleanupRunIds.push(result.runId);

    expect(result.mismatchCount).toBe(0);
    expect(result.stripeTotalMinor).toBe(result.localTotalMinor);

    const [storedRun] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, result.runId));
    expect(storedRun?.mismatchCount).toBe(0);
    expect(storedRun?.invoiceCountStripe).toBe(1);
    expect(storedRun?.invoiceCountLocal).toBe(1);
  });
});

describe('a never-finalized draft invoice is windowed by created_at, not permanently excluded by finalized_at (finding #18, deep bug hunt)', () => {
  it('matches a draft local row against its Stripe counterpart instead of misclassifying it missing_local', async () => {
    const { periodStart, periodEnd, inWindow } = windowForDay(7);
    const customerId = await seedCustomer();
    const invoice = fakeInvoice({ status: 'draft', created: Math.floor(inWindow.getTime() / 1000) });
    // finalizedAt is never set here - a draft invoice (auto_advance:false,
    // e.g. a manually-finalized B2B invoice) that stays in draft forever.
    // Windowed by finalized_at (the old behavior), this row would be
    // excluded from EVERY possible window query, permanently misclassifying
    // the matching Stripe invoice as missing_local. Windowed by created_at
    // instead, it's found and correctly matched.
    await seedLocalInvoice(customerId, {
      stripeInvoiceId: invoice.id,
      status: 'draft',
      amountDueMinor: invoice.amount_due,
      amountPaidMinor: invoice.amount_paid,
      createdAt: inWindow,
      finalizedAt: null,
    });
    mockInvoicesList.mockReturnValue([invoice]);

    const result = await runReconciliation({ periodStart, periodEnd, currency: 'usd' });
    cleanupRunIds.push(result.runId);

    expect(result.entries).not.toContainEqual({ type: 'missing_local', stripeInvoiceId: invoice.id });
    expect(result.mismatchCount).toBe(0);
  });
});

describe('duplicate Stripe invoices across pages are deduped, never double-counted (finding #26, deep bug hunt)', () => {
  it('counts a repeated invoice id once in invoiceCountStripe and stripeTotalMinor', async () => {
    const { periodStart, periodEnd } = windowForDay(8);
    const invoice = fakeInvoice({ status: 'paid', amount_due: 3000, amount_paid: 3000 });
    // Simulates the same object surfacing twice across pagination (a real
    // possibility when an object shifts position mid-pagination, per the
    // documented Stripe list-pagination race) - the fix keys by id, so a
    // repeat must never inflate the count or total.
    mockInvoicesList.mockReturnValue([invoice, invoice]);

    const result = await runReconciliation({ periodStart, periodEnd, currency: 'usd' });
    cleanupRunIds.push(result.runId);

    expect(result.invoiceCountStripe).toBe(1);
    expect(result.stripeTotalMinor).toBe(3000);
  });
});

describe('a live "now" period_end is clamped to a settled bound so live pagination can never silently drop an invoice (finding #26, deep bug hunt)', () => {
  it('queries Stripe with an upper bound behind now, and stores that clamped bound rather than the raw requested one', async () => {
    const now = new Date('2026-05-09T12:00:00.000Z');
    const periodStart = new Date('2026-05-09T00:00:00.000Z');
    // Requested as "now" - the common ad-hoc "reconcile since midnight" query.
    const requestedPeriodEnd = now;
    mockInvoicesList.mockReturnValue([]);

    const result = await runReconciliation({ periodStart, periodEnd: requestedPeriodEnd, currency: 'usd', now });
    cleanupRunIds.push(result.runId);

    const [callArgs] = mockInvoicesList.mock.calls.at(-1)!;
    const queriedLt = (callArgs as { created: { lt: number } }).created.lt;
    // Strictly behind the requested "now", not equal to it - the whole
    // point of the clamp.
    expect(queriedLt).toBeLessThan(Math.floor(requestedPeriodEnd.getTime() / 1000));

    const [storedRun] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, result.runId));
    // The stored record's own periodEnd reflects what was actually
    // queried, not the raw requested value - the run's own audit trail
    // must stay honest about what it covered.
    expect(storedRun?.periodEnd?.getTime()).toBeLessThan(requestedPeriodEnd.getTime());
    expect(storedRun?.periodEnd?.getTime()).toBe(queriedLt * 1000);
  });

  it('does not clamp a period_end that is already well in the past (the nightly cron\'s own case)', async () => {
    const now = new Date('2026-05-09T12:00:00.000Z');
    const periodStart = new Date('2026-01-01T00:00:00.000Z');
    const periodEnd = new Date('2026-01-02T00:00:00.000Z');
    mockInvoicesList.mockReturnValue([]);

    const result = await runReconciliation({ periodStart, periodEnd, currency: 'usd', now });
    cleanupRunIds.push(result.runId);

    const [callArgs] = mockInvoicesList.mock.calls.at(-1)!;
    const queriedLt = (callArgs as { created: { lt: number } }).created.lt;
    expect(queriedLt).toBe(Math.floor(periodEnd.getTime() / 1000));
  });
});

describe('adjacent-reconciliation-windows-do-not-double-count-an-invoice-on-a-shared-boundary', () => {
  it('counts a Stripe invoice created exactly on a shared boundary in exactly one of two back-to-back runs', async () => {
    const dayStart = new Date('2026-05-06T00:00:00.000Z');
    const boundary = new Date('2026-05-06T12:00:00.000Z');
    const dayEnd = new Date('2026-05-07T00:00:00.000Z');
    const boundaryInvoice = fakeInvoice({ status: 'paid', created: Math.floor(boundary.getTime() / 1000) });

    // Unlike the other tests' unconditional mockReturnValue, this mock
    // actually honors the passed gte/lt(e) params on `created`, the same
    // way Stripe's real API does - the bug this guards against (runReconciliation
    // previously used an inclusive `lte` on periodEnd, asymmetric with the
    // local query's `lt`) only shows up when the filter is respected at a
    // shared boundary.
    mockInvoicesList.mockImplementation(
      ({ created }: { created: { gte?: number; gt?: number; lte?: number; lt?: number } }) =>
        [boundaryInvoice].filter((inv) => {
          if (created.gte !== undefined && inv.created < created.gte) return false;
          if (created.gt !== undefined && inv.created <= created.gt) return false;
          if (created.lte !== undefined && inv.created > created.lte) return false;
          if (created.lt !== undefined && inv.created >= created.lt) return false;
          return true;
        }),
    );

    const morningRun = await runReconciliation({ periodStart: dayStart, periodEnd: boundary, currency: 'usd' });
    cleanupRunIds.push(morningRun.runId);
    const afternoonRun = await runReconciliation({ periodStart: boundary, periodEnd: dayEnd, currency: 'usd' });
    cleanupRunIds.push(afternoonRun.runId);

    // The afternoon window's lower bound is `gte boundary`, so it owns the
    // boundary invoice. The morning window's upper bound must be `lt
    // boundary`, not `lte`, so it must NOT also claim the same invoice -
    // that asymmetry is exactly what double-counted an invoice across two
    // adjacent runs before the fix.
    expect(morningRun.invoiceCountStripe).toBe(0);
    expect(afternoonRun.invoiceCountStripe).toBe(1);
  });
});

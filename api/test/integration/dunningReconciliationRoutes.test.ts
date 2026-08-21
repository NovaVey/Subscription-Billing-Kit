import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// GET /dunning/queue, POST /dunning/:id/resolve, GET /admin/reconciliation,
// and POST /admin/reconciliation/run are only ever exercised at the business
// -logic level elsewhere (dunning.test.ts calls runDunningTick() directly;
// reconciliation.test.ts calls runReconciliation() directly) - neither hits
// these routes over HTTP. This file closes that gap: the routes themselves
// (params/body validation, response shape, wiring to the underlying
// functions) have never been asserted against before this file existed.
const mockInvoicesList = vi.fn();

vi.mock('../../src/stripe/client.js', () => ({
  stripe: {
    invoices: { list: (...args: unknown[]) => mockInvoicesList(...args) },
  },
}));

const { buildApp } = await import('../../src/app.js');
const { db, pool } = await import('../../src/db/client.js');
const { customers, dunningState, invoices, reconciliationRuns, subscriptionEvents, subscriptions } = await import(
  '../../src/db/schema.js'
);
const { fakeCustomer, fakeInvoice, fakeSubscription } = await import('./helpers/stripeFixtures.js');
const { WRITE_KEY_HEADERS } = await import('./helpers/adminAuth.js');

const app = buildApp();

const cleanupCustomerIds: string[] = [];
const cleanupSubscriptionIds: string[] = [];
const cleanupInvoiceIds: string[] = [];
const cleanupRunIds: string[] = [];

beforeEach(() => {
  mockInvoicesList.mockReset();
});

afterAll(async () => {
  for (const id of cleanupRunIds) {
    await db.delete(reconciliationRuns).where(eq(reconciliationRuns.id, id));
  }
  // dunning_state.triggering_invoice_id references invoices, so it must be
  // cleared before invoices are deleted - same FK ordering discipline as
  // every other integration suite's afterAll.
  for (const id of cleanupSubscriptionIds) {
    await db.delete(subscriptionEvents).where(eq(subscriptionEvents.subscriptionId, id));
    await db.delete(dunningState).where(eq(dunningState.subscriptionId, id));
  }
  for (const id of cleanupInvoiceIds) {
    await db.delete(invoices).where(eq(invoices.id, id));
  }
  for (const id of cleanupSubscriptionIds) {
    await db.delete(subscriptions).where(eq(subscriptions.id, id));
  }
  for (const id of cleanupCustomerIds) {
    await db.delete(customers).where(eq(customers.id, id));
  }
  await app.close();
  await pool.end();
});

async function seedCustomer(email: string) {
  const customer = fakeCustomer({ email });
  const [row] = await db
    .insert(customers)
    .values({ stripeCustomerId: customer.id, email: customer.email })
    .returning({ id: customers.id });
  cleanupCustomerIds.push(row!.id);
  return row!.id;
}

async function seedSubscription(customerId: string, status = 'past_due') {
  const stripeSubscription = fakeSubscription();
  const [row] = await db
    .insert(subscriptions)
    .values({
      customerId,
      stripeSubscriptionId: stripeSubscription.id,
      status,
      planCode: 'starter',
      currency: 'usd',
    })
    .returning({ id: subscriptions.id });
  cleanupSubscriptionIds.push(row!.id);
  return row!.id;
}

async function seedInvoice(customerId: string, subscriptionId: string, amountDueMinor: number) {
  const [row] = await db
    .insert(invoices)
    .values({
      customerId,
      subscriptionId,
      stripeInvoiceId: `in_test_${Math.random().toString(36).slice(2)}`,
      status: 'open',
      currency: 'usd',
      amountDueMinor,
      amountPaidMinor: 0,
    })
    .returning({ id: invoices.id });
  cleanupInvoiceIds.push(row!.id);
  return row!.id;
}

describe('GET /dunning/queue', () => {
  it('lists a subscription in an open dunning cycle with the triggering invoice and amount at risk', async () => {
    const customerId = await seedCustomer('past-due@example.com');
    const subscriptionId = await seedSubscription(customerId);
    const invoiceId = await seedInvoice(customerId, subscriptionId, 4900);
    await db.insert(dunningState).values({
      subscriptionId,
      triggeringInvoiceId: invoiceId,
      stage: 1,
      enteredStageAt: new Date(),
      noticesSent: 1,
    });

    const response = await app.inject({ method: 'GET', url: '/dunning/queue', headers: WRITE_KEY_HEADERS });
    expect(response.statusCode).toBe(200);
    const row = response.json().queue.find((q: { subscriptionId: string }) => q.subscriptionId === subscriptionId);
    expect(row).toBeDefined();
    expect(row.stage).toBe(1);
    expect(row.triggeringInvoiceId).toBe(invoiceId);
    expect(row.amountAtRiskMinor).toBe(4900);
    expect(row.customerEmail).toBe('past-due@example.com');
  });

  it('excludes a healthy subscription (stage 0, no dunning_state row) from the queue', async () => {
    const customerId = await seedCustomer('healthy@example.com');
    const subscriptionId = await seedSubscription(customerId, 'active');

    const response = await app.inject({ method: 'GET', url: '/dunning/queue', headers: WRITE_KEY_HEADERS });
    expect(response.statusCode).toBe(200);
    expect(response.json().queue.some((q: { subscriptionId: string }) => q.subscriptionId === subscriptionId)).toBe(
      false,
    );
  });
});

describe('POST /dunning/:id/resolve', () => {
  it('resolves an open cycle, resets stage to 0, and writes a manual audit row', async () => {
    const customerId = await seedCustomer('resolve-me@example.com');
    const subscriptionId = await seedSubscription(customerId);
    await db.insert(dunningState).values({ subscriptionId, stage: 2, noticesSent: 1 });

    const response = await app.inject({
      headers: WRITE_KEY_HEADERS,
      method: 'POST',
      url: `/dunning/${subscriptionId}/resolve`,
      payload: { resolution: 'recovered', note: 'customer paid over the phone' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ subscriptionId, resolution: 'recovered' });

    const [dunningRow] = await db.select().from(dunningState).where(eq(dunningState.subscriptionId, subscriptionId));
    expect(dunningRow?.stage).toBe(0);
    expect(dunningRow?.resolution).toBe('recovered');
    expect(dunningRow?.resolvedAt).not.toBeNull();

    const events = await db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.subscriptionId, subscriptionId));
    expect(events.some((e) => e.reason === 'manual:api' && e.note?.includes('customer paid over the phone'))).toBe(
      true,
    );
  });

  it('returns 404 when the subscription has no dunning cycle', async () => {
    const customerId = await seedCustomer('never-late@example.com');
    const subscriptionId = await seedSubscription(customerId, 'active');

    const response = await app.inject({
      headers: WRITE_KEY_HEADERS,
      method: 'POST',
      url: `/dunning/${subscriptionId}/resolve`,
      payload: { resolution: 'manual', note: 'n/a' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 409 when the cycle is already resolved', async () => {
    const customerId = await seedCustomer('already-resolved@example.com');
    const subscriptionId = await seedSubscription(customerId);
    await db.insert(dunningState).values({ subscriptionId, stage: 0, resolvedAt: new Date(), resolution: 'recovered' });

    const response = await app.inject({
      headers: WRITE_KEY_HEADERS,
      method: 'POST',
      url: `/dunning/${subscriptionId}/resolve`,
      payload: { resolution: 'manual', note: 'n/a' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('rejects a body missing the required note', async () => {
    const customerId = await seedCustomer('bad-body@example.com');
    const subscriptionId = await seedSubscription(customerId);

    const response = await app.inject({
      headers: WRITE_KEY_HEADERS,
      method: 'POST',
      url: `/dunning/${subscriptionId}/resolve`,
      payload: { resolution: 'manual' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a malformed :id with 400 rather than a raw Postgres error (finding #17, deep bug hunt)', async () => {
    const response = await app.inject({
      headers: WRITE_KEY_HEADERS,
      method: 'POST',
      url: '/dunning/not-a-uuid/resolve',
      payload: { resolution: 'manual', note: 'n/a' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('lets exactly one of two concurrent resolve requests for the same cycle succeed (finding #7, deep bug hunt)', async () => {
    // A double-submitted click, or two operators resolving the same
    // subscription at once - a plain SELECT-then-UPDATE would let both
    // requests pass the "not already resolved" check before either writes,
    // both commit, and the second silently discards the first's outcome
    // (and doubles the audit trail). The guarded UPDATE must let only the
    // first commit succeed.
    const customerId = await seedCustomer('double-submit@example.com');
    const subscriptionId = await seedSubscription(customerId);
    await db.insert(dunningState).values({ subscriptionId, stage: 1, noticesSent: 0 });

    const [responseA, responseB] = await Promise.all([
      app.inject({
        headers: WRITE_KEY_HEADERS,
        method: 'POST',
        url: `/dunning/${subscriptionId}/resolve`,
        payload: { resolution: 'recovered', note: 'operator A' },
      }),
      app.inject({
        headers: WRITE_KEY_HEADERS,
        method: 'POST',
        url: `/dunning/${subscriptionId}/resolve`,
        payload: { resolution: 'manual', note: 'operator B' },
      }),
    ]);

    const statuses = [responseA.statusCode, responseB.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const [dunningRow] = await db.select().from(dunningState).where(eq(dunningState.subscriptionId, subscriptionId));
    expect(dunningRow?.resolvedAt).not.toBeNull();
    expect(dunningRow?.stage).toBe(0);

    // Exactly one manual audit row was written - the loser never reached
    // the subscription_events insert inside its transaction.
    const events = await db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.subscriptionId, subscriptionId));
    expect(events.filter((e) => e.reason === 'manual:api')).toHaveLength(1);
  });
});

describe('GET /admin/reconciliation', () => {
  it('lists stored reconciliation runs, most recent first', async () => {
    const [older] = await db
      .insert(reconciliationRuns)
      .values({
        periodStart: new Date('2026-04-01T00:00:00Z'),
        periodEnd: new Date('2026-04-02T00:00:00Z'),
        ranAt: new Date('2026-04-02T01:00:00Z'),
        currency: 'usd',
        stripeTotalMinor: 1000,
        localTotalMinor: 1000,
        invoiceCountStripe: 1,
        invoiceCountLocal: 1,
        mismatchCount: 0,
        report: [],
      })
      .returning({ id: reconciliationRuns.id });
    cleanupRunIds.push(older!.id);

    const [newer] = await db
      .insert(reconciliationRuns)
      .values({
        periodStart: new Date('2026-04-02T00:00:00Z'),
        periodEnd: new Date('2026-04-03T00:00:00Z'),
        ranAt: new Date('2026-04-03T01:00:00Z'),
        currency: 'usd',
        stripeTotalMinor: 2000,
        localTotalMinor: 2000,
        invoiceCountStripe: 1,
        invoiceCountLocal: 1,
        mismatchCount: 0,
        report: [],
      })
      .returning({ id: reconciliationRuns.id });
    cleanupRunIds.push(newer!.id);

    const response = await app.inject({ method: 'GET', url: '/admin/reconciliation', headers: WRITE_KEY_HEADERS });
    expect(response.statusCode).toBe(200);
    const ids = response.json().runs.map((r: { id: string }) => r.id);
    expect(ids.indexOf(newer!.id)).toBeLessThan(ids.indexOf(older!.id));
  });

  it('omits `report` from every row - fetched separately via the detail route', async () => {
    const [row] = await db
      .insert(reconciliationRuns)
      .values({
        periodStart: new Date('2026-04-04T00:00:00Z'),
        periodEnd: new Date('2026-04-05T00:00:00Z'),
        currency: 'usd',
        stripeTotalMinor: 500,
        localTotalMinor: 500,
        invoiceCountStripe: 1,
        invoiceCountLocal: 1,
        mismatchCount: 1,
        report: [{ type: 'orphan_local', stripeInvoiceId: 'in_orphan' }],
      })
      .returning({ id: reconciliationRuns.id });
    cleanupRunIds.push(row!.id);

    const response = await app.inject({ method: 'GET', url: '/admin/reconciliation', headers: WRITE_KEY_HEADERS });
    const body = response.json();
    expect(body.runs.length).toBeGreaterThan(0);
    for (const run of body.runs) {
      expect(run).not.toHaveProperty('report');
    }
  });
});

describe('GET /admin/reconciliation/:id', () => {
  it('returns the full row, including report', async () => {
    const report = [{ type: 'field_drift' as const, stripeInvoiceId: 'in_drift', field: 'status', stripeValue: 'paid', localValue: 'open' }];
    const [row] = await db
      .insert(reconciliationRuns)
      .values({
        periodStart: new Date('2026-04-06T00:00:00Z'),
        periodEnd: new Date('2026-04-07T00:00:00Z'),
        currency: 'usd',
        stripeTotalMinor: 900,
        localTotalMinor: 900,
        invoiceCountStripe: 1,
        invoiceCountLocal: 1,
        mismatchCount: 1,
        report,
      })
      .returning({ id: reconciliationRuns.id });
    cleanupRunIds.push(row!.id);

    const response = await app.inject({
      method: 'GET',
      url: `/admin/reconciliation/${row!.id}`,
      headers: WRITE_KEY_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(row!.id);
    expect(body.report).toEqual(report);
  });

  it('returns 404 for an unknown run id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/reconciliation/00000000-0000-0000-0000-000000000000',
      headers: WRITE_KEY_HEADERS,
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a malformed :id with 400 rather than a raw Postgres error (finding #17, deep bug hunt)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/reconciliation/not-a-uuid',
      headers: WRITE_KEY_HEADERS,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /admin/reconciliation/run', () => {
  it('runs reconciliation for the given window and stores the result', async () => {
    const customerId = await seedCustomer('recon-http@example.com');
    const invoice = fakeInvoice({ status: 'paid' });
    mockInvoicesList.mockReturnValue([invoice]);
    await db.insert(invoices).values({
      customerId,
      stripeInvoiceId: invoice.id,
      status: 'paid',
      currency: 'usd',
      amountDueMinor: invoice.amount_due,
      amountPaidMinor: invoice.amount_paid,
      // A day not used by any other test file's reconciliation window (see
      // reconciliation.test.ts's windowForDay comment) - runReconciliation
      // fetches every local invoice in the period+currency, so a shared day
      // would pick up another test's leftover row as a false orphan_local.
      // createdAt is what the local-side window now filters by (finding
      // #18, deep bug hunt) - finalizedAt alone no longer suffices.
      createdAt: new Date('2026-05-20T12:00:00Z'),
      finalizedAt: new Date('2026-05-20T12:00:00Z'),
    });
    const [insertedInvoiceRow] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, invoice.id));
    cleanupInvoiceIds.push(insertedInvoiceRow!.id);

    const response = await app.inject({
      headers: WRITE_KEY_HEADERS,
      method: 'POST',
      url: '/admin/reconciliation/run',
      payload: {
        // Safely in the past (see reconcile.ts's LIVE_WINDOW_BUFFER_MS,
        // finding #26 deep bug hunt) - a period_end near real wall-clock
        // "now" would get clamped to a settled bound behind it, which
        // this test doesn't exercise (see reconciliation.test.ts's own
        // dedicated clamp tests for that).
        period_start: '2026-05-20T00:00:00.000Z',
        period_end: '2026-05-20T23:59:59.000Z',
        currency: 'usd',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mismatchCount).toBe(0);
    cleanupRunIds.push(body.runId);

    const [storedRun] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, body.runId));
    expect(storedRun).toBeDefined();
    expect(storedRun?.mismatchCount).toBe(0);
  });

  it('rejects a window where period_end is not after period_start', async () => {
    const response = await app.inject({
      headers: WRITE_KEY_HEADERS,
      method: 'POST',
      url: '/admin/reconciliation/run',
      payload: {
        period_start: '2026-06-15T23:59:59.000Z',
        period_end: '2026-06-15T00:00:00.000Z',
        currency: 'usd',
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

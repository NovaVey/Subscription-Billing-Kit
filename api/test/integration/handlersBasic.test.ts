import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCustomersRetrieve = vi.fn();
const mockInvoicesRetrieve = vi.fn();
const mockPaymentIntentsRetrieve = vi.fn();
const mockInvoicePaymentsList = vi.fn();

vi.mock('../../src/stripe/client.js', () => ({
  stripe: {
    customers: { retrieve: (...args: unknown[]) => mockCustomersRetrieve(...args) },
    invoices: { retrieve: (...args: unknown[]) => mockInvoicesRetrieve(...args) },
    paymentIntents: { retrieve: (...args: unknown[]) => mockPaymentIntentsRetrieve(...args) },
    invoicePayments: { list: (...args: unknown[]) => mockInvoicePaymentsList(...args) },
  },
}));

const { db, pool } = await import('../../src/db/client.js');
const { customers, dunningNotices, dunningState, invoices, paymentAttempts, subscriptions } = await import(
  '../../src/db/schema.js'
);
const { handleCustomerEvent } = await import('../../src/webhooks/handlers/customer.js');
const { handleInvoiceEvent } = await import('../../src/webhooks/handlers/invoice.js');
const { handlePaymentIntentEvent } = await import('../../src/webhooks/handlers/paymentIntent.js');
const { fakeCustomer, fakeEvent, fakeInvoice, fakePaymentIntent, fakeSubscription } = await import(
  './helpers/stripeFixtures.js'
);

const cleanupCustomerIds: string[] = [];
const cleanupInvoiceIds: string[] = [];
const cleanupSubscriptionIds: string[] = [];

beforeEach(() => {
  mockCustomersRetrieve.mockReset();
  mockInvoicesRetrieve.mockReset();
  mockPaymentIntentsRetrieve.mockReset();
  mockInvoicePaymentsList.mockReset();
});

afterAll(async () => {
  for (const id of cleanupInvoiceIds) {
    await db.delete(paymentAttempts).where(eq(paymentAttempts.invoiceId, id));
    await db.delete(invoices).where(eq(invoices.id, id));
  }
  for (const id of cleanupSubscriptionIds) {
    await db.delete(subscriptions).where(eq(subscriptions.id, id));
  }
  for (const id of cleanupCustomerIds) {
    await db.delete(customers).where(eq(customers.id, id));
  }
  await pool.end();
});

describe('customer handler', () => {
  it('upserts a customers row from a re-fetched Stripe customer', async () => {
    const customer = fakeCustomer({ metadata: { external_ref: 'org_42' } });
    mockCustomersRetrieve.mockResolvedValueOnce(customer);

    await handleCustomerEvent(fakeEvent('customer.created', customer) as never);

    const [row] = await db.select().from(customers).where(eq(customers.stripeCustomerId, customer.id));
    expect(row).toBeDefined();
    cleanupCustomerIds.push(row!.id);
    expect(row?.email).toBe(customer.email);
    expect(row?.externalRef).toBe('org_42');
  });
});

describe('customer handler treats customer.deleted as a deliberate no-op', () => {
  it('leaves the local row untouched as a historical billing record and never re-fetches from Stripe', async () => {
    const customer = fakeCustomer({ email: 'keep-me@example.com', name: 'Keep Me', delinquent: true });
    await db
      .insert(customers)
      .values({
        stripeCustomerId: customer.id,
        email: customer.email,
        name: customer.name,
        delinquent: customer.delinquent,
      });
    const [customerRow] = await db
      .select()
      .from(customers)
      .where(eq(customers.stripeCustomerId, customer.id));
    expect(customerRow).toBeDefined();
    cleanupCustomerIds.push(customerRow!.id);

    const result = await handleCustomerEvent(fakeEvent('customer.deleted', customer) as never);
    expect(result).toEqual({});

    // customer.deleted must not trigger the re-fetch-rather-than-trust-the-payload
    // path every other customer event goes through (§5.6) - there is nothing left
    // on Stripe's side to re-fetch.
    expect(mockCustomersRetrieve).not.toHaveBeenCalled();

    const [afterRow] = await db
      .select()
      .from(customers)
      .where(eq(customers.stripeCustomerId, customer.id));
    expect(afterRow).toBeDefined();
    expect(afterRow?.email).toBe('keep-me@example.com');
    expect(afterRow?.name).toBe('Keep Me');
    expect(afterRow?.delinquent).toBe(true);
  });
});

describe('invoice handler resolves subscription via parent.subscription_details', () => {
  it('links an invoice to its subscription using the post-Basil parent shape, not a top-level field', async () => {
    const customer = fakeCustomer();
    await db.insert(customers).values({ stripeCustomerId: customer.id, email: customer.email });
    const [customerRow] = await db
      .select()
      .from(customers)
      .where(eq(customers.stripeCustomerId, customer.id));
    cleanupCustomerIds.push(customerRow!.id);

    const subscription = fakeSubscription({ customer: customer.id });
    const [subRow] = await db
      .insert(subscriptions)
      .values({
        customerId: customerRow!.id,
        stripeSubscriptionId: subscription.id,
        status: 'active',
        planCode: 'starter',
        currency: 'usd',
      })
      .returning({ id: subscriptions.id });
    cleanupSubscriptionIds.push(subRow!.id);

    const invoice = fakeInvoice({
      customer: customer.id,
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: subscription.id, metadata: null },
        quote_details: null,
      },
    });
    mockInvoicesRetrieve.mockResolvedValueOnce(invoice);

    await handleInvoiceEvent(fakeEvent('invoice.created', invoice) as never);

    const [invoiceRow] = await db.select().from(invoices).where(eq(invoices.stripeInvoiceId, invoice.id));
    expect(invoiceRow).toBeDefined();
    cleanupInvoiceIds.push(invoiceRow!.id);
    expect(invoiceRow?.subscriptionId).toBe(subRow!.id);
    expect(invoiceRow?.amountDueMinor).toBe(invoice.amount_due);
  });

  it('leaves subscriptionId null for a one-off invoice (parent is null)', async () => {
    const customer = fakeCustomer();
    await db.insert(customers).values({ stripeCustomerId: customer.id, email: customer.email });
    const [customerRow] = await db
      .select()
      .from(customers)
      .where(eq(customers.stripeCustomerId, customer.id));
    cleanupCustomerIds.push(customerRow!.id);

    const invoice = fakeInvoice({ customer: customer.id, parent: null });
    mockInvoicesRetrieve.mockResolvedValueOnce(invoice);

    await handleInvoiceEvent(fakeEvent('invoice.created', invoice) as never);

    const [invoiceRow] = await db.select().from(invoices).where(eq(invoices.stripeInvoiceId, invoice.id));
    cleanupInvoiceIds.push(invoiceRow!.id);
    expect(invoiceRow?.subscriptionId).toBeNull();
  });
});

describe('invoice handler staleness guard (staleGuard.ts) rejects out-of-order delivery', () => {
  it('ignores a late invoice.payment_failed delivered after a newer invoice.paid was already applied — does not touch the row or open a new dunning cycle', async () => {
    const customer = fakeCustomer();
    await db.insert(customers).values({ stripeCustomerId: customer.id, email: customer.email });
    const [customerRow] = await db
      .select()
      .from(customers)
      .where(eq(customers.stripeCustomerId, customer.id));
    cleanupCustomerIds.push(customerRow!.id);

    const subscription = fakeSubscription({ customer: customer.id });
    const [subRow] = await db
      .insert(subscriptions)
      .values({
        customerId: customerRow!.id,
        stripeSubscriptionId: subscription.id,
        status: 'active',
        planCode: 'starter',
        currency: 'usd',
      })
      .returning({ id: subscriptions.id });
    cleanupSubscriptionIds.push(subRow!.id);

    const t2Seconds = Math.floor(Date.now() / 1000);
    const t1Seconds = t2Seconds - 3600; // strictly earlier than t2 — the late arrival

    const invoice = fakeInvoice({
      customer: customer.id,
      status: 'paid',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: subscription.id, metadata: null },
        quote_details: null,
      },
    });

    // First delivery: invoice.paid at t2, processed normally (not stale — no
    // prior local row exists yet).
    mockInvoicesRetrieve.mockResolvedValueOnce(invoice);
    await handleInvoiceEvent(fakeEvent('invoice.paid', invoice, { created: t2Seconds }) as never);

    const [invoiceRow] = await db.select().from(invoices).where(eq(invoices.stripeInvoiceId, invoice.id));
    expect(invoiceRow).toBeDefined();
    cleanupInvoiceIds.push(invoiceRow!.id);
    expect(invoiceRow?.status).toBe('paid');

    // Second delivery: invoice.payment_failed for the SAME invoice, but with
    // event.created (t1) earlier than the last event already applied (t2) —
    // an out-of-order redelivery. staleGuard must skip it before the handler
    // ever re-fetches from Stripe or touches dunning.
    const result = await handleInvoiceEvent(
      fakeEvent('invoice.payment_failed', invoice, { created: t1Seconds }) as never,
    );
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/stale/);

    const [invoiceRowAfter] = await db.select().from(invoices).where(eq(invoices.stripeInvoiceId, invoice.id));
    expect(invoiceRowAfter?.status).toBe('paid');
    expect(invoiceRowAfter?.lastEventAt?.getTime()).toBe(invoiceRow?.lastEventAt?.getTime());

    // Critically: the stale failed event must not open a dunning cycle on a
    // subscription that is, as of the newer invoice.paid, healthy.
    const [dunningRow] = await db
      .select()
      .from(dunningState)
      .where(eq(dunningState.subscriptionId, subRow!.id));
    expect(dunningRow).toBeUndefined();
  });
});

describe('invoice handler cleans up a deleted draft invoice on a Stripe 404', () => {
  it('deletes the local row and returns cleanly when stripe.invoices.retrieve 404s (draft deleted before finalization) — no dunning side effects', async () => {
    const customer = fakeCustomer();
    await db.insert(customers).values({ stripeCustomerId: customer.id, email: customer.email });
    const [customerRow] = await db
      .select()
      .from(customers)
      .where(eq(customers.stripeCustomerId, customer.id));
    cleanupCustomerIds.push(customerRow!.id);

    const subscription = fakeSubscription({ customer: customer.id });
    const [subRow] = await db
      .insert(subscriptions)
      .values({
        customerId: customerRow!.id,
        stripeSubscriptionId: subscription.id,
        status: 'active',
        planCode: 'starter',
        currency: 'usd',
      })
      .returning({ id: subscriptions.id });
    cleanupSubscriptionIds.push(subRow!.id);

    // Seed a local row as if it were written by an earlier invoice.created —
    // a draft invoice that Stripe will report as gone (404) on the next event.
    const invoice = fakeInvoice({ customer: customer.id, status: 'draft' });
    const [invoiceRow] = await db
      .insert(invoices)
      .values({
        customerId: customerRow!.id,
        subscriptionId: subRow!.id,
        stripeInvoiceId: invoice.id,
        status: 'draft',
        currency: 'usd',
        amountDueMinor: invoice.amount_due,
      })
      .returning({ id: invoices.id });
    // Deliberately not pushed to cleanupInvoiceIds - the handler itself must
    // delete this row, and that deletion is what this test verifies.

    const notFound = new Stripe.errors.StripeInvalidRequestError({
      statusCode: 404,
      message: 'No such invoice',
      type: 'invalid_request_error',
    });
    mockInvoicesRetrieve.mockRejectedValueOnce(notFound);

    // invoice.payment_failed, specifically, so this test also proves the 404
    // branch returns before ever reaching the dunning side effect that this
    // event type would otherwise trigger.
    const result = await handleInvoiceEvent(fakeEvent('invoice.payment_failed', invoice) as never);
    expect(result).toEqual({});

    const rowsAfter = await db.select().from(invoices).where(eq(invoices.id, invoiceRow!.id));
    expect(rowsAfter).toHaveLength(0);

    const [dunningRow] = await db
      .select()
      .from(dunningState)
      .where(eq(dunningState.subscriptionId, subRow!.id));
    expect(dunningRow).toBeUndefined();
  });
});

describe('invoice handler serializes two genuinely concurrent events for the same invoice (finding #5, deep bug hunt)', () => {
  it('never leaves dunning open when a late payment_failed races a newer paid event, regardless of which transaction the DB runs first', async () => {
    const customer = fakeCustomer();
    await db.insert(customers).values({ stripeCustomerId: customer.id, email: customer.email });
    const [customerRow] = await db
      .select()
      .from(customers)
      .where(eq(customers.stripeCustomerId, customer.id));
    cleanupCustomerIds.push(customerRow!.id);

    const subscription = fakeSubscription({ customer: customer.id });
    const [subRow] = await db
      .insert(subscriptions)
      .values({
        customerId: customerRow!.id,
        stripeSubscriptionId: subscription.id,
        status: 'active',
        planCode: 'starter',
        currency: 'usd',
      })
      .returning({ id: subscriptions.id });
    cleanupSubscriptionIds.push(subRow!.id);

    const t0 = Math.floor(Date.now() / 1000) - 300;
    const t1 = t0 + 50; // the late payment_failed
    const t2 = t1 + 50; // the actually-newer paid event

    const invoice = fakeInvoice({
      customer: customer.id,
      status: 'open',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: subscription.id, metadata: null },
        quote_details: null,
      },
    });
    // Seed the row first (an already-committed invoice.created) so the
    // race below exercises the in-transaction FOR UPDATE guard against an
    // EXISTING row - the realistic scenario, not a first-ever insert race
    // (see subscriptionProjection.test.ts's equivalent sync.ts test for why
    // that's a different, narrower case).
    const [seededRow] = await db
      .insert(invoices)
      .values({
        customerId: customerRow!.id,
        subscriptionId: subRow!.id,
        stripeInvoiceId: invoice.id,
        status: 'open',
        currency: 'usd',
        amountDueMinor: invoice.amount_due,
        lastEventAt: new Date(t0 * 1000),
      })
      .returning({ id: invoices.id });
    cleanupInvoiceIds.push(seededRow!.id);

    // Both concurrent handler calls re-fetch and see the SAME (paid)
    // Stripe truth - re-fetch-not-trust-the-payload (§5.6) means Stripe
    // always returns its current state regardless of which locally-stale
    // event triggered the re-fetch. The only thing that actually differs
    // between the two calls is event.type and event.created.
    const paidInvoice = {
      ...invoice,
      status: 'paid',
      amount_paid: invoice.amount_due,
      status_transitions: { finalized_at: invoice.created, paid_at: t2 },
    };
    mockInvoicesRetrieve.mockResolvedValue(paidInvoice);

    await Promise.all([
      handleInvoiceEvent(fakeEvent('invoice.payment_failed', invoice, { created: t1 }) as never),
      handleInvoiceEvent(fakeEvent('invoice.paid', paidInvoice, { created: t2 }) as never),
    ]);

    const [invoiceRowAfter] = await db.select().from(invoices).where(eq(invoices.id, seededRow!.id));
    expect(invoiceRowAfter?.status).toBe('paid');
    expect(invoiceRowAfter?.lastEventAt?.getTime()).toBe(t2 * 1000);

    // No matter which transaction the DB happened to run first, the cycle
    // must never be left open - either the late failed event lost the
    // guard outright (never opened a cycle), or it opened one moments
    // before the newer paid event's resolveDunningOnInvoicePaid closed it
    // again.
    const [dunningRow] = await db.select().from(dunningState).where(eq(dunningState.subscriptionId, subRow!.id));
    expect(dunningRow === undefined || dunningRow.resolvedAt !== null).toBe(true);

    // dunning_state.triggering_invoice_id FKs to invoices, and
    // dunning_notices FKs to subscriptions - if the race above opened a
    // (now-resolved) cycle, both must be cleared here rather than left for
    // afterAll, which (unlike dunning.test.ts's) doesn't clean up either
    // table and would otherwise fail this file's own cleanupInvoiceIds /
    // cleanupSubscriptionIds deletes with a FK violation. See the deep bug
    // hunt notes on test-isolation hazards from this same audit.
    if (dunningRow) {
      await db.delete(dunningNotices).where(eq(dunningNotices.subscriptionId, subRow!.id));
      await db.delete(dunningState).where(eq(dunningState.subscriptionId, subRow!.id));
    }
  });
});

describe('payment intent handler resolves the invoice via invoicePayments (PaymentIntent has no .invoice field)', () => {
  it('records a payment_attempts row when the payment intent is linked to a known local invoice', async () => {
    const customer = fakeCustomer();
    await db.insert(customers).values({ stripeCustomerId: customer.id, email: customer.email });
    const [customerRow] = await db
      .select()
      .from(customers)
      .where(eq(customers.stripeCustomerId, customer.id));
    cleanupCustomerIds.push(customerRow!.id);

    const invoice = fakeInvoice({ customer: customer.id });
    const [invoiceRow] = await db
      .insert(invoices)
      .values({
        customerId: customerRow!.id,
        stripeInvoiceId: invoice.id,
        status: 'open',
        currency: 'usd',
        amountDueMinor: invoice.amount_due,
      })
      .returning({ id: invoices.id });
    cleanupInvoiceIds.push(invoiceRow!.id);

    const paymentIntent = fakePaymentIntent();
    mockPaymentIntentsRetrieve.mockResolvedValueOnce(paymentIntent);
    mockInvoicePaymentsList.mockResolvedValueOnce({ data: [{ invoice: invoice.id }] });

    await handlePaymentIntentEvent(fakeEvent('payment_intent.payment_failed', paymentIntent) as never);

    const attempts = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.invoiceId, invoiceRow!.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('failed');
    expect(attempts[0]?.failureCode).toBe('card_declined');
    expect(attempts[0]?.amountMinor).toBe(paymentIntent.amount);
  });

  it('records nothing when the payment intent has no linked invoice', async () => {
    const paymentIntent = fakePaymentIntent();
    mockPaymentIntentsRetrieve.mockResolvedValueOnce(paymentIntent);
    mockInvoicePaymentsList.mockResolvedValueOnce({ data: [] });

    const result = await handlePaymentIntentEvent(
      fakeEvent('payment_intent.payment_failed', paymentIntent) as never,
    );
    expect(result).toEqual({});

    const attempts = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.stripePaymentIntentId, paymentIntent.id));
    expect(attempts).toHaveLength(0);
  });
});

describe('payment intent handler is idempotent by stripe_payment_intent_id (finding #4, deep bug hunt)', () => {
  it('records exactly one payment_attempts row when the same payment intent is handled twice concurrently', async () => {
    const customer = fakeCustomer();
    await db.insert(customers).values({ stripeCustomerId: customer.id, email: customer.email });
    const [customerRow] = await db
      .select()
      .from(customers)
      .where(eq(customers.stripeCustomerId, customer.id));
    cleanupCustomerIds.push(customerRow!.id);

    const invoice = fakeInvoice({ customer: customer.id });
    const [invoiceRow] = await db
      .insert(invoices)
      .values({
        customerId: customerRow!.id,
        stripeInvoiceId: invoice.id,
        status: 'open',
        currency: 'usd',
        amountDueMinor: invoice.amount_due,
      })
      .returning({ id: invoices.id });
    cleanupInvoiceIds.push(invoiceRow!.id);

    const paymentIntent = fakePaymentIntent();
    mockPaymentIntentsRetrieve.mockResolvedValue(paymentIntent);
    mockInvoicePaymentsList.mockResolvedValue({ data: [{ invoice: invoice.id }] });

    // Two genuinely concurrent invocations for the same payment intent - a
    // retry racing the original delivery, or two workers both processing a
    // reaped lease. Before the unique constraint + onConflictDoNothing,
    // both inserts could land (a plain SELECT-then-INSERT check has a
    // window between the two statements); now only one row can ever exist.
    await Promise.all([
      handlePaymentIntentEvent(fakeEvent('payment_intent.payment_failed', paymentIntent) as never),
      handlePaymentIntentEvent(fakeEvent('payment_intent.payment_failed', paymentIntent) as never),
    ]);

    const attempts = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.stripePaymentIntentId, paymentIntent.id));
    expect(attempts).toHaveLength(1);
  });
});

describe('payment intent handler is blind to event.type (known gap, pinned on purpose)', () => {
  // handlePaymentIntentEvent never inspects event.type (or paymentIntent.status) — it
  // unconditionally writes payment_attempts.status = 'failed' for any payment_intent.*
  // event that resolves to a known local invoice. Today this is harmless because
  // processor.ts's dispatch() only ever routes payment_intent.payment_failed to this
  // handler, so a payment_intent.succeeded never actually reaches it in production.
  // This test pins that current, arguably-wrong behavior by calling the handler
  // directly with a fabricated payment_intent.succeeded event: if dispatch() is ever
  // changed to also route succeeded events here, they would be silently mis-recorded
  // as failures, and this test would need to change the day event.type-awareness is
  // added to the handler.
  it('still records payment_attempts.status="failed" for a payment_intent.succeeded event, because the handler never checks event.type', async () => {
    const customer = fakeCustomer();
    await db.insert(customers).values({ stripeCustomerId: customer.id, email: customer.email });
    const [customerRow] = await db
      .select()
      .from(customers)
      .where(eq(customers.stripeCustomerId, customer.id));
    cleanupCustomerIds.push(customerRow!.id);

    const invoice = fakeInvoice({ customer: customer.id });
    const [invoiceRow] = await db
      .insert(invoices)
      .values({
        customerId: customerRow!.id,
        stripeInvoiceId: invoice.id,
        status: 'open',
        currency: 'usd',
        amountDueMinor: invoice.amount_due,
      })
      .returning({ id: invoices.id });
    cleanupInvoiceIds.push(invoiceRow!.id);

    const paymentIntent = fakePaymentIntent({ status: 'succeeded', last_payment_error: null });
    mockPaymentIntentsRetrieve.mockResolvedValueOnce(paymentIntent);
    mockInvoicePaymentsList.mockResolvedValueOnce({ data: [{ invoice: invoice.id }] });

    await handlePaymentIntentEvent(fakeEvent('payment_intent.succeeded', paymentIntent) as never);

    const attempts = await db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.invoiceId, invoiceRow!.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('failed');
    expect(attempts[0]?.failureCode).toBeNull();
    expect(attempts[0]?.amountMinor).toBe(paymentIntent.amount);
  });
});

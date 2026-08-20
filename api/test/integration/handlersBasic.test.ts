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
const { customers, dunningState, invoices, paymentAttempts, subscriptions } = await import(
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

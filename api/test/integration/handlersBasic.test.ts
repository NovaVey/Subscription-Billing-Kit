import { eq } from 'drizzle-orm';
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
const { customers, invoices, paymentAttempts, subscriptions } = await import('../../src/db/schema.js');
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

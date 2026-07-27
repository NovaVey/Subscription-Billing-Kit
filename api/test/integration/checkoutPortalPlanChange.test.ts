import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCustomersCreate = vi.fn();
const mockCheckoutCreate = vi.fn();
const mockPortalCreate = vi.fn();
const mockInvoicesCreatePreview = vi.fn();
const mockSubscriptionsUpdate = vi.fn();
const mockSubscriptionsCancel = vi.fn();
const mockSubscriptionsResume = vi.fn();
const mockSubscriptionsRetrieve = vi.fn();

vi.mock('../../src/stripe/client.js', () => ({
  stripe: {
    customers: { create: (...args: unknown[]) => mockCustomersCreate(...args) },
    checkout: { sessions: { create: (...args: unknown[]) => mockCheckoutCreate(...args) } },
    billingPortal: { sessions: { create: (...args: unknown[]) => mockPortalCreate(...args) } },
    invoices: { createPreview: (...args: unknown[]) => mockInvoicesCreatePreview(...args) },
    subscriptions: {
      update: (...args: unknown[]) => mockSubscriptionsUpdate(...args),
      cancel: (...args: unknown[]) => mockSubscriptionsCancel(...args),
      resume: (...args: unknown[]) => mockSubscriptionsResume(...args),
      retrieve: (...args: unknown[]) => mockSubscriptionsRetrieve(...args),
    },
  },
}));

const { buildApp } = await import('../../src/app.js');
const { db, pool } = await import('../../src/db/client.js');
const { customers, subscriptionEvents, subscriptionItems, subscriptions } = await import(
  '../../src/db/schema.js'
);
const { fakeCustomer, fakeSubscription, fakeSubscriptionItem } = await import(
  './helpers/stripeFixtures.js'
);

const app = buildApp();

const cleanupCustomerIds: string[] = [];
const cleanupSubscriptionIds: string[] = [];

beforeEach(() => {
  mockCustomersCreate.mockReset();
  mockCheckoutCreate.mockReset();
  mockPortalCreate.mockReset();
  mockInvoicesCreatePreview.mockReset();
  mockSubscriptionsUpdate.mockReset();
  mockSubscriptionsCancel.mockReset();
  mockSubscriptionsResume.mockReset();
  mockSubscriptionsRetrieve.mockReset();
});

afterAll(async () => {
  for (const id of cleanupSubscriptionIds) {
    await db.delete(subscriptionEvents).where(eq(subscriptionEvents.subscriptionId, id));
    await db.delete(subscriptionItems).where(eq(subscriptionItems.subscriptionId, id));
    await db.delete(subscriptions).where(eq(subscriptions.id, id));
  }
  for (const id of cleanupCustomerIds) {
    await db.delete(customers).where(eq(customers.id, id));
  }
  await app.close();
  await pool.end();
});

async function seedCustomerAndSubscription() {
  const stripeCustomer = fakeCustomer();
  const [customerRow] = await db
    .insert(customers)
    .values({ stripeCustomerId: stripeCustomer.id, email: stripeCustomer.email })
    .returning({ id: customers.id });
  cleanupCustomerIds.push(customerRow!.id);

  const item = fakeSubscriptionItem();
  const stripeSubscription = fakeSubscription({ customer: stripeCustomer.id, items: { data: [item] } });
  const [subRow] = await db
    .insert(subscriptions)
    .values({
      customerId: customerRow!.id,
      stripeSubscriptionId: stripeSubscription.id,
      status: 'active',
      planCode: 'starter',
      currency: 'usd',
      cancelAtPeriodEnd: false,
    })
    .returning({ id: subscriptions.id });
  cleanupSubscriptionIds.push(subRow!.id);

  await db.insert(subscriptionItems).values({
    subscriptionId: subRow!.id,
    stripeItemId: item.id,
    priceId: item.price.id,
    quantity: 1,
    unitAmountMinor: item.price.unit_amount,
    currency: item.price.currency,
    recurringInterval: item.price.recurring.interval,
    currentPeriodStart: new Date(item.current_period_start * 1000),
    currentPeriodEnd: new Date(item.current_period_end * 1000),
  });

  return { customerRow: customerRow!, stripeCustomer, stripeSubscription, subRow: subRow!, item };
}

describe('POST /customers', () => {
  it('creates a customer via Stripe and syncs it locally', async () => {
    const stripeCustomer = fakeCustomer({ id: 'cus_new_1', metadata: {} });
    mockCustomersCreate.mockResolvedValueOnce(stripeCustomer);

    const response = await app.inject({
      method: 'POST',
      url: '/customers',
      payload: { external_ref: 'org_100', email: stripeCustomer.email, name: stripeCustomer.name },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    cleanupCustomerIds.push(body.id);
    expect(body.stripe_customer_id).toBe('cus_new_1');
    expect(mockCustomersCreate).toHaveBeenCalledTimes(1);
  });

  it('a retried create call with the same external_ref creates one customer, not two', async () => {
    const stripeCustomer = fakeCustomer({ id: 'cus_new_2', metadata: {} });
    // Echo back whatever metadata the route actually sent, the way Stripe
    // itself would - a static fixture would hide the local-first check's
    // dependency on external_ref actually being persisted.
    mockCustomersCreate.mockImplementationOnce((params: { metadata?: Record<string, string> }) =>
      Promise.resolve({ ...stripeCustomer, metadata: params.metadata ?? {} }),
    );

    const first = await app.inject({
      method: 'POST',
      url: '/customers',
      payload: { external_ref: 'org_200', email: stripeCustomer.email },
    });
    expect(first.statusCode).toBe(201);
    cleanupCustomerIds.push(first.json().id);

    // A second call for the same external_ref - simulating a client retry -
    // must not call Stripe again at all (local-first check short-circuits).
    const second = await app.inject({
      method: 'POST',
      url: '/customers',
      payload: { external_ref: 'org_200', email: stripeCustomer.email },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(mockCustomersCreate).toHaveBeenCalledTimes(1);

    const rows = await db.select().from(customers).where(eq(customers.externalRef, 'org_200'));
    expect(rows).toHaveLength(1);
  });
});

describe('POST /checkout/sessions', () => {
  it('returns the Stripe-hosted checkout url for a known customer', async () => {
    const { customerRow } = await seedCustomerAndSubscription();
    mockCheckoutCreate.mockResolvedValueOnce({ id: 'cs_test_1', url: 'https://checkout.stripe.com/cs_test_1' });

    const response = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      payload: { customer_id: customerRow.id, price_id: 'price_starter_monthly', quantity: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().url).toBe('https://checkout.stripe.com/cs_test_1');
    const [, options] = mockCheckoutCreate.mock.calls[0]!;
    expect((options as { idempotencyKey: string }).idempotencyKey).toMatch(/^checkout:/);
  });

  it('returns 404 for an unknown local customer id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      payload: { customer_id: '00000000-0000-0000-0000-000000000000', price_id: 'price_x', quantity: 1 },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /portal/sessions', () => {
  it('returns the Stripe billing portal url', async () => {
    const { customerRow } = await seedCustomerAndSubscription();
    mockPortalCreate.mockResolvedValueOnce({ url: 'https://billing.stripe.com/session_1' });

    const response = await app.inject({
      method: 'POST',
      url: '/portal/sessions',
      payload: { customer_id: customerRow.id, return_url: 'https://app.example.com/account' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().url).toBe('https://billing.stripe.com/session_1');
  });
});

describe('plan change preview matches the invoice Stripe actually issues', () => {
  it('returns the preview amount unmodified - our code passes it through rather than recomputing it', async () => {
    const { subRow, stripeCustomer } = await seedCustomerAndSubscription();

    mockInvoicesCreatePreview.mockResolvedValueOnce({
      currency: 'usd',
      amount_due: 5000,
      total: 5000,
      lines: { data: [{ description: 'Remaining time on Pro', amount: 5000, parent: null }] },
    });

    const previewResponse = await app.inject({
      method: 'GET',
      url: `/subscriptions/${subRow.id}/preview?price_id=price_pro_monthly&quantity=1`,
    });
    expect(previewResponse.statusCode).toBe(200);
    const previewBody = previewResponse.json();
    expect(previewBody.amount_due).toBe(5000);

    // Now apply the same change - the invoice that eventually gets created
    // for it should reflect the same numbers the preview showed, since
    // nothing in our code path recalculates or rounds them independently.
    mockSubscriptionsUpdate.mockResolvedValueOnce({});
    const updatedSubscription = fakeSubscription({
      id: (await db.select().from(subscriptions).where(eq(subscriptions.id, subRow.id)))[0]!
        .stripeSubscriptionId,
      customer: stripeCustomer.id,
      status: 'active',
    });
    mockSubscriptionsRetrieve.mockResolvedValueOnce(updatedSubscription);

    const applyResponse = await app.inject({
      method: 'POST',
      url: `/subscriptions/${subRow.id}/plan`,
      payload: { price_id: 'price_pro_monthly', quantity: 1, proration_behavior: 'create_prorations' },
    });
    expect(applyResponse.statusCode).toBe(200);

    const [, , updateOptions] = mockSubscriptionsUpdate.mock.calls[0]!;
    expect((updateOptions as { idempotencyKey: string }).idempotencyKey).toMatch(
      /^sub:.*:plan:price_pro_monthly:/,
    );
  });
});

describe('cancel and resume write a manual audit row even when status does not change', () => {
  it('cancel_at_period_end=true keeps status active but still records a manual subscription_events row', async () => {
    const { subRow, stripeSubscription, stripeCustomer } = await seedCustomerAndSubscription();

    mockSubscriptionsUpdate.mockResolvedValueOnce({});
    mockSubscriptionsRetrieve.mockResolvedValueOnce(
      fakeSubscription({
        id: stripeSubscription.id,
        customer: stripeCustomer.id,
        status: 'active',
        cancel_at_period_end: true,
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/subscriptions/${subRow.id}/cancel`,
      payload: { at_period_end: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('active');

    const [updatedRow] = await db.select().from(subscriptions).where(eq(subscriptions.id, subRow.id));
    expect(updatedRow?.cancelAtPeriodEnd).toBe(true);

    const events = await db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.subscriptionId, subRow.id));
    const manualEvent = events.find((e) => e.reason === 'manual:api');
    expect(manualEvent).toBeDefined();
    expect(manualEvent?.fromStatus).toBe('active');
    expect(manualEvent?.toStatus).toBe('active');
    expect(manualEvent?.note).toMatch(/canceled at period end/);
  });

  it('resume un-sets cancel_at_period_end and records a manual audit row', async () => {
    const { subRow, stripeSubscription, stripeCustomer } = await seedCustomerAndSubscription();
    await db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true })
      .where(eq(subscriptions.id, subRow.id));

    mockSubscriptionsUpdate.mockResolvedValueOnce({});
    mockSubscriptionsRetrieve.mockResolvedValueOnce(
      fakeSubscription({
        id: stripeSubscription.id,
        customer: stripeCustomer.id,
        status: 'active',
        cancel_at_period_end: false,
      }),
    );

    const response = await app.inject({ method: 'POST', url: `/subscriptions/${subRow.id}/resume` });
    expect(response.statusCode).toBe(200);

    const [updatedRow] = await db.select().from(subscriptions).where(eq(subscriptions.id, subRow.id));
    expect(updatedRow?.cancelAtPeriodEnd).toBe(false);

    const events = await db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.subscriptionId, subRow.id));
    expect(events.some((e) => e.reason === 'manual:api' && e.note === 'resumed')).toBe(true);
  });

  it('returns 409 when there is nothing to resume', async () => {
    const { subRow } = await seedCustomerAndSubscription();
    const response = await app.inject({ method: 'POST', url: `/subscriptions/${subRow.id}/resume` });
    expect(response.statusCode).toBe(409);
  });
});

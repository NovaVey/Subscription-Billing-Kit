import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

const { buildApp } = await import('../../src/app.js');
const { db, pool } = await import('../../src/db/client.js');
const { customers, dunningState, invoices, subscriptionItems, subscriptions, webhookEvents } = await import(
  '../../src/db/schema.js'
);
const { fakeCustomer, fakePrice, fakeSubscription, fakeSubscriptionItem } = await import('./helpers/stripeFixtures.js');
const { WRITE_KEY_HEADERS } = await import('./helpers/adminAuth.js');

const app = buildApp();

const cleanupCustomerIds: string[] = [];
const cleanupSubscriptionIds: string[] = [];
const cleanupInvoiceIds: string[] = [];
const cleanupEventIds: string[] = [];

afterAll(async () => {
  for (const id of cleanupInvoiceIds) {
    await db.delete(invoices).where(eq(invoices.id, id));
  }
  for (const id of cleanupSubscriptionIds) {
    await db.delete(dunningState).where(eq(dunningState.subscriptionId, id));
    await db.delete(subscriptionItems).where(eq(subscriptionItems.subscriptionId, id));
    await db.delete(subscriptions).where(eq(subscriptions.id, id));
  }
  for (const id of cleanupCustomerIds) {
    await db.delete(customers).where(eq(customers.id, id));
  }
  for (const id of cleanupEventIds) {
    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, id));
  }
  await app.close();
  await pool.end();
});

async function seedCustomer(overrides: Record<string, unknown> = {}) {
  const stripeCustomer = fakeCustomer(overrides);
  const [row] = await db
    .insert(customers)
    .values({
      stripeCustomerId: stripeCustomer.id,
      email: stripeCustomer.email,
      externalRef: (overrides['externalRef'] as string | undefined) ?? null,
    })
    .returning({ id: customers.id });
  cleanupCustomerIds.push(row!.id);
  return { id: row!.id, stripeCustomer };
}

async function seedSubscription(
  customerId: string,
  overrides: { status?: string; planCode?: string } = {},
) {
  const item = fakeSubscriptionItem();
  const stripeSubscription = fakeSubscription({ items: { data: [item] } });
  const [row] = await db
    .insert(subscriptions)
    .values({
      customerId,
      stripeSubscriptionId: stripeSubscription.id,
      status: overrides.status ?? 'active',
      planCode: overrides.planCode ?? 'starter',
      currency: 'usd',
      cancelAtPeriodEnd: false,
    })
    .returning({ id: subscriptions.id });
  cleanupSubscriptionIds.push(row!.id);

  await db.insert(subscriptionItems).values({
    subscriptionId: row!.id,
    stripeItemId: item.id,
    priceId: item.price.id,
    quantity: 1,
    unitAmountMinor: item.price.unit_amount,
    currency: item.price.currency,
    recurringInterval: item.price.recurring.interval,
    currentPeriodStart: new Date(item.current_period_start * 1000),
    currentPeriodEnd: new Date(item.current_period_end * 1000),
  });

  return { id: row!.id, stripeSubscription };
}

async function seedInvoice(
  customerId: string,
  subscriptionId: string | null,
  overrides: Record<string, unknown> = {},
) {
  const [row] = await db
    .insert(invoices)
    .values({
      customerId,
      subscriptionId,
      stripeInvoiceId: `in_test_${Math.random().toString(36).slice(2)}`,
      status: 'paid',
      currency: 'usd',
      amountDueMinor: 2900,
      amountPaidMinor: 2900,
      periodStart: new Date('2026-01-01T00:00:00Z'),
      periodEnd: new Date('2026-02-01T00:00:00Z'),
      ...overrides,
    })
    .returning({ id: invoices.id });
  cleanupInvoiceIds.push(row!.id);
  return row!.id;
}

async function seedWebhookEvent(overrides: Record<string, unknown> = {}) {
  const stripeEventId = `evt_test_${Math.random().toString(36).slice(2)}`;
  await db.insert(webhookEvents).values({
    stripeEventId,
    type: 'invoice.paid',
    apiVersion: '2026-06-24.dahlia',
    eventCreatedAt: new Date(),
    payload: { id: stripeEventId },
    status: 'received',
    ...overrides,
  });
  cleanupEventIds.push(stripeEventId);
  return stripeEventId;
}

describe('GET /subscriptions', () => {
  it('lists subscriptions with customer, MRR, and dunning stage joined in', async () => {
    const { id: customerId } = await seedCustomer({ email: 'list-test@example.com' });
    const { id: subscriptionId } = await seedSubscription(customerId);

    const response = await app.inject({ method: 'GET', url: '/subscriptions?limit=100', headers: WRITE_KEY_HEADERS });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const row = body.subscriptions.find((s: { id: string }) => s.id === subscriptionId);
    expect(row).toBeDefined();
    expect(row.customerEmail).toBe('list-test@example.com');
    expect(row.mrrMinor).toBe(2900);
    expect(row.dunningStage).toBe(0);
  });

  it('filters by status', async () => {
    const { id: customerId } = await seedCustomer();
    await seedSubscription(customerId, { status: 'canceled' });

    const response = await app.inject({ method: 'GET', url: '/subscriptions?status=canceled&limit=100', headers: WRITE_KEY_HEADERS });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.subscriptions.every((s: { status: string }) => s.status === 'canceled')).toBe(true);
  });

  it('paginates with a cursor and reports hasMore via nextCursor', async () => {
    const { id: customerId } = await seedCustomer();
    await seedSubscription(customerId);
    await seedSubscription(customerId);

    const firstPage = await app.inject({ method: 'GET', url: '/subscriptions?limit=1', headers: WRITE_KEY_HEADERS });
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json();
    expect(firstBody.subscriptions).toHaveLength(1);
    expect(firstBody.nextCursor).not.toBeNull();

    const secondPage = await app.inject({
      headers: WRITE_KEY_HEADERS,
      method: 'GET',
      url: `/subscriptions?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    });
    expect(secondPage.statusCode).toBe(200);
    const secondBody = secondPage.json();
    expect(secondBody.subscriptions[0].id).not.toBe(firstBody.subscriptions[0].id);
  });

  it('rejects an invalid limit', async () => {
    const response = await app.inject({ method: 'GET', url: '/subscriptions?limit=0', headers: WRITE_KEY_HEADERS });
    expect(response.statusCode).toBe(400);
  });

  it('computes mrrMinor by normalizing each item to a monthly-equivalent amount before summing, not by summing raw amounts', async () => {
    const { id: customerId } = await seedCustomer();
    const stripeSubscription = fakeSubscription({ items: { data: [] } });
    const [row] = await db
      .insert(subscriptions)
      .values({
        customerId,
        stripeSubscriptionId: stripeSubscription.id,
        status: 'active',
        planCode: 'starter',
        currency: 'usd',
        cancelAtPeriodEnd: false,
      })
      .returning({ id: subscriptions.id });
    const subscriptionId = row!.id;
    cleanupSubscriptionIds.push(subscriptionId);

    const annualItem = fakeSubscriptionItem({
      quantity: 2,
      price: fakePrice({ unit_amount: 29000, recurring: { interval: 'year', interval_count: 1 } }),
    });
    const weeklyItem = fakeSubscriptionItem({
      quantity: 1,
      price: fakePrice({ unit_amount: 500, recurring: { interval: 'week', interval_count: 1 } }),
    });

    await db.insert(subscriptionItems).values([
      {
        subscriptionId,
        stripeItemId: annualItem.id,
        priceId: annualItem.price.id,
        quantity: annualItem.quantity,
        unitAmountMinor: annualItem.price.unit_amount,
        currency: annualItem.price.currency,
        recurringInterval: annualItem.price.recurring.interval,
        currentPeriodStart: new Date(annualItem.current_period_start * 1000),
        currentPeriodEnd: new Date(annualItem.current_period_end * 1000),
      },
      {
        subscriptionId,
        stripeItemId: weeklyItem.id,
        priceId: weeklyItem.price.id,
        quantity: weeklyItem.quantity,
        unitAmountMinor: weeklyItem.price.unit_amount,
        currency: weeklyItem.price.currency,
        recurringInterval: weeklyItem.price.recurring.interval,
        currentPeriodStart: new Date(weeklyItem.current_period_start * 1000),
        currentPeriodEnd: new Date(weeklyItem.current_period_end * 1000),
      },
    ]);

    const response = await app.inject({ method: 'GET', url: '/subscriptions?limit=100', headers: WRITE_KEY_HEADERS });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const row2 = body.subscriptions.find((s: { id: string }) => s.id === subscriptionId);
    expect(row2).toBeDefined();
    // Hand-computed: annual item at 29000 minor * qty 2, divided by 12; plus
    // weekly item at 500 minor * qty 1, scaled by 52/12 - each rounded on its
    // own, not the raw combined amount (29000*2 + 500 = 58500). This also
    // pins the rounding order: summing the unrounded terms and rounding once
    // at the end happens to agree with rounding each term first for these
    // particular numbers, so either implementation choice passes here.
    const expectedMrrMinor = Math.round((29000 * 2) / 12) + Math.round((500 * 52) / 12);
    expect(row2.mrrMinor).toBe(expectedMrrMinor);
  });
});

describe('GET /subscriptions/:id', () => {
  it('includes the joined customer and dunning: null when there is no dunning_state row', async () => {
    const { id: customerId, stripeCustomer } = await seedCustomer({ email: 'detail-test@example.com' });
    const { id: subscriptionId } = await seedSubscription(customerId);

    const response = await app.inject({ method: 'GET', url: `/subscriptions/${subscriptionId}`, headers: WRITE_KEY_HEADERS });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.dunning).toBeNull();
    expect(body.customer.email).toBe(stripeCustomer.email);
  });

  it('returns the dunning_state row when one exists', async () => {
    const { id: customerId } = await seedCustomer();
    const { id: subscriptionId } = await seedSubscription(customerId, { status: 'past_due' });
    await db.insert(dunningState).values({ subscriptionId, stage: 2, noticesSent: 1 });

    const response = await app.inject({ method: 'GET', url: `/subscriptions/${subscriptionId}`, headers: WRITE_KEY_HEADERS });
    expect(response.statusCode).toBe(200);
    expect(response.json().dunning.stage).toBe(2);
  });
});

describe('subscription mutation routes: unknown id', () => {
  it('returns 404 from GET /subscriptions/:id, GET /subscriptions/:id/preview, POST /subscriptions/:id/plan, and POST /subscriptions/:id/cancel', async () => {
    const unknownId = '00000000-0000-0000-0000-000000000099';

    const detail = await app.inject({ method: 'GET', url: `/subscriptions/${unknownId}`, headers: WRITE_KEY_HEADERS });
    expect(detail.statusCode).toBe(404);

    const preview = await app.inject({
      method: 'GET',
      url: `/subscriptions/${unknownId}/preview?price_id=price_x&quantity=1`,
      headers: WRITE_KEY_HEADERS,
    });
    expect(preview.statusCode).toBe(404);

    const plan = await app.inject({
      method: 'POST',
      url: `/subscriptions/${unknownId}/plan`,
      headers: WRITE_KEY_HEADERS,
      payload: { price_id: 'price_x', quantity: 1 },
    });
    expect(plan.statusCode).toBe(404);

    const cancel = await app.inject({
      method: 'POST',
      url: `/subscriptions/${unknownId}/cancel`,
      headers: WRITE_KEY_HEADERS,
      payload: { at_period_end: true },
    });
    expect(cancel.statusCode).toBe(404);
  });
});

describe('subscription mutation routes: fully churned subscription (no active item)', () => {
  it('returns 409 from GET /subscriptions/:id/preview and POST /subscriptions/:id/plan without ever calling Stripe', async () => {
    const { id: customerId } = await seedCustomer();
    const stripeSubscription = fakeSubscription({ items: { data: [] } });
    const [row] = await db
      .insert(subscriptions)
      .values({
        customerId,
        stripeSubscriptionId: stripeSubscription.id,
        status: 'active',
        planCode: 'starter',
        currency: 'usd',
        cancelAtPeriodEnd: false,
      })
      .returning({ id: subscriptions.id });
    const subscriptionId = row!.id;
    cleanupSubscriptionIds.push(subscriptionId);

    const item = fakeSubscriptionItem();
    await db.insert(subscriptionItems).values({
      subscriptionId,
      stripeItemId: item.id,
      priceId: item.price.id,
      quantity: 1,
      unitAmountMinor: item.price.unit_amount,
      currency: item.price.currency,
      recurringInterval: item.price.recurring.interval,
      currentPeriodStart: new Date(item.current_period_start * 1000),
      currentPeriodEnd: new Date(item.current_period_end * 1000),
      // Fully churned: the only item row is soft-removed, so
      // loadActiveItem() finds nothing and the route must 409 before ever
      // reaching stripe.invoices.createPreview / stripe.subscriptions.update.
      removedAt: new Date(),
    });

    const preview = await app.inject({
      method: 'GET',
      url: `/subscriptions/${subscriptionId}/preview?price_id=price_x&quantity=1`,
      headers: WRITE_KEY_HEADERS,
    });
    expect(preview.statusCode).toBe(409);

    const plan = await app.inject({
      method: 'POST',
      url: `/subscriptions/${subscriptionId}/plan`,
      headers: WRITE_KEY_HEADERS,
      payload: { price_id: 'price_x', quantity: 1 },
    });
    expect(plan.statusCode).toBe(409);
  });
});

describe('GET /invoices', () => {
  it('lists invoices joined with customer email', async () => {
    const { id: customerId, stripeCustomer } = await seedCustomer({ email: 'invoice-list@example.com' });
    const invoiceId = await seedInvoice(customerId, null);

    const response = await app.inject({ method: 'GET', url: `/invoices?customer_id=${customerId}`, headers: WRITE_KEY_HEADERS });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.invoices).toHaveLength(1);
    expect(body.invoices[0].id).toBe(invoiceId);
    expect(body.invoices[0].customerEmail).toBe(stripeCustomer.email);
  });

  it('filters by status', async () => {
    const { id: customerId } = await seedCustomer();
    await seedInvoice(customerId, null, { status: 'open', stripeInvoiceId: `in_open_${Date.now()}` });
    await seedInvoice(customerId, null, { status: 'void', stripeInvoiceId: `in_void_${Date.now()}` });

    const response = await app.inject({
      headers: WRITE_KEY_HEADERS,
      method: 'GET',
      url: `/invoices?customer_id=${customerId}&status=void`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.invoices.every((i: { status: string }) => i.status === 'void')).toBe(true);
  });

  it('rejects an invalid customer_id', async () => {
    const response = await app.inject({ method: 'GET', url: '/invoices?customer_id=not-a-uuid', headers: WRITE_KEY_HEADERS });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /admin/webhook-events', () => {
  it('lists webhook events, most recent first', async () => {
    const olderId = await seedWebhookEvent({ receivedAt: new Date('2026-01-01T00:00:00Z') });
    const newerId = await seedWebhookEvent({ receivedAt: new Date('2026-01-02T00:00:00Z') });

    const response = await app.inject({ method: 'GET', url: '/admin/webhook-events?limit=100', headers: WRITE_KEY_HEADERS });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const ids = body.events.map((e: { stripeEventId: string }) => e.stripeEventId);
    expect(ids.indexOf(newerId)).toBeLessThan(ids.indexOf(olderId));
  });

  it('filters by status and type', async () => {
    const failedId = await seedWebhookEvent({ status: 'failed', type: 'invoice.payment_failed' });
    await seedWebhookEvent({ status: 'processed', type: 'invoice.paid' });

    const response = await app.inject({ method: 'GET', url: '/admin/webhook-events?status=failed', headers: WRITE_KEY_HEADERS });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].stripeEventId).toBe(failedId);
  });

  it('omits `payload` from every row - fetched separately via the detail route', async () => {
    await seedWebhookEvent();

    const response = await app.inject({ method: 'GET', url: '/admin/webhook-events?limit=100', headers: WRITE_KEY_HEADERS });
    const body = response.json();
    expect(body.events.length).toBeGreaterThan(0);
    for (const event of body.events) {
      expect(event).not.toHaveProperty('payload');
    }
  });
});

describe('GET /admin/webhook-events/:id', () => {
  it('returns the full row, including payload', async () => {
    const stripeEventId = await seedWebhookEvent({ payload: { id: 'evt_full_detail', foo: 'bar' } });

    const response = await app.inject({
      method: 'GET',
      url: `/admin/webhook-events/${stripeEventId}`,
      headers: WRITE_KEY_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.stripeEventId).toBe(stripeEventId);
    expect(body.payload).toEqual({ id: 'evt_full_detail', foo: 'bar' });
  });

  it('returns 404 for an unknown event id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/webhook-events/evt_does_not_exist',
      headers: WRITE_KEY_HEADERS,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /admin/webhook-events/:id/replay', () => {
  it('resets a failed event back to received with a clean attempt budget', async () => {
    const stripeEventId = await seedWebhookEvent({
      status: 'failed',
      attempts: 3,
      lastError: 'boom',
      nextAttemptAt: new Date(),
      processingStartedAt: new Date(),
      processedAt: new Date(),
    });

    const response = await app.inject({
      headers: WRITE_KEY_HEADERS,
      method: 'POST',
      url: `/admin/webhook-events/${stripeEventId}/replay`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ stripeEventId, status: 'received' });

    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.stripeEventId, stripeEventId));
    expect(row?.status).toBe('received');
    expect(row?.attempts).toBe(0);
    expect(row?.lastError).toBeNull();
    expect(row?.nextAttemptAt).toBeNull();
    expect(row?.processingStartedAt).toBeNull();
    expect(row?.processedAt).toBeNull();
  });

  it('returns 404 for an unknown event id', async () => {
    const response = await app.inject({
      headers: WRITE_KEY_HEADERS,
      method: 'POST',
      url: '/admin/webhook-events/evt_does_not_exist/replay',
    });
    expect(response.statusCode).toBe(404);
  });
});

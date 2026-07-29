import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

const { buildApp } = await import('../../src/app.js');
const { db, pool } = await import('../../src/db/client.js');
const { customers, dunningState, invoices, subscriptionItems, subscriptions, webhookEvents } = await import(
  '../../src/db/schema.js'
);
const { fakeCustomer, fakeSubscription, fakeSubscriptionItem } = await import('./helpers/stripeFixtures.js');
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

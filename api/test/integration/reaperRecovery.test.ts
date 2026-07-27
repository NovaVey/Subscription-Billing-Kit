import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRetrieve = vi.fn();
vi.mock('../../src/stripe/client.js', () => ({
  stripe: {
    subscriptions: { retrieve: (...args: unknown[]) => mockRetrieve(...args) },
  },
}));

const { db, pool } = await import('../../src/db/client.js');
const { customers, subscriptionEvents, subscriptionItems, subscriptions, webhookEvents } = await import(
  '../../src/db/schema.js'
);
const { env } = await import('../../src/env.js');
const { processPendingWebhookEvents, MAX_ATTEMPTS } = await import('../../src/webhooks/processor.js');
const { reapStaleProcessingEvents } = await import('../../src/webhooks/reaper.js');
const { fakeCustomer, fakeEvent, fakeSubscription } = await import('./helpers/stripeFixtures.js');

const cleanupEventIds: string[] = [];
const cleanupCustomerIds: string[] = [];
const cleanupSubscriptionIds: string[] = [];

beforeEach(() => {
  mockRetrieve.mockReset();
});

afterAll(async () => {
  for (const id of cleanupSubscriptionIds) {
    await db.delete(subscriptionEvents).where(eq(subscriptionEvents.subscriptionId, id));
    await db.delete(subscriptionItems).where(eq(subscriptionItems.subscriptionId, id));
    await db.delete(subscriptions).where(eq(subscriptions.id, id));
  }
  for (const id of cleanupEventIds) {
    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, id));
  }
  for (const id of cleanupCustomerIds) {
    await db.delete(customers).where(eq(customers.id, id));
  }
  await pool.end();
});

function staleProcessingStartedAt(): Date {
  return new Date(Date.now() - (env.WEBHOOK_LEASE_SECONDS + 10) * 1000);
}

describe('a worker killed mid-event has its row reaped and reprocessed', () => {
  it('returns a stuck "processing" row to "received" once its lease has expired, and it gets processed', async () => {
    const c = fakeCustomer();
    await db.insert(customers).values({ stripeCustomerId: c.id, email: c.email });
    cleanupCustomerIds.push(
      (await db.select().from(customers).where(eq(customers.stripeCustomerId, c.id)))[0]!.id,
    );

    const subscription = fakeSubscription({ customer: c.id });
    const event = fakeEvent('customer.subscription.created', subscription);
    cleanupEventIds.push(event.id);

    // Simulate a worker that claimed this row and then died before
    // finishing - status is 'processing' but the lease has long expired.
    await db.insert(webhookEvents).values({
      stripeEventId: event.id,
      type: event.type,
      apiVersion: event.api_version,
      eventCreatedAt: new Date(event.created * 1000),
      payload: event,
      status: 'processing',
      processingStartedAt: staleProcessingStartedAt(),
      attempts: 0,
    });

    const beforeReap = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, event.id));
    expect(beforeReap[0]?.status).toBe('processing');

    const reapResult = await reapStaleProcessingEvents();
    expect(reapResult.reaped).toBeGreaterThanOrEqual(1);

    const afterReap = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, event.id));
    expect(afterReap[0]?.status).toBe('received');
    expect(afterReap[0]?.processingStartedAt).toBeNull();
    expect(afterReap[0]?.attempts).toBe(1);

    // Now the normal processor tick should pick it up and finish the job.
    mockRetrieve.mockResolvedValueOnce(subscription);
    await processPendingWebhookEvents();

    const afterProcess = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, event.id));
    expect(afterProcess[0]?.status).toBe('processed');

    const [subRow] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, subscription.id));
    expect(subRow).toBeDefined();
    cleanupSubscriptionIds.push(subRow!.id);
  });

  it('parks a row as "failed" instead of re-queuing once attempts would reach the max', async () => {
    const event = fakeEvent('customer.subscription.updated', fakeSubscription());
    cleanupEventIds.push(event.id);

    await db.insert(webhookEvents).values({
      stripeEventId: event.id,
      type: event.type,
      apiVersion: event.api_version,
      eventCreatedAt: new Date(event.created * 1000),
      payload: event,
      status: 'processing',
      processingStartedAt: staleProcessingStartedAt(),
      attempts: MAX_ATTEMPTS - 1,
    });

    const reapResult = await reapStaleProcessingEvents();
    expect(reapResult.parked).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, event.id));
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(MAX_ATTEMPTS);
  });
});

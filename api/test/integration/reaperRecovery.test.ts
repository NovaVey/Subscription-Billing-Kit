import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRetrieve = vi.fn();
// syncSubscriptionFromStripe now separately paginates subscription items
// (finding #24, deep bug hunt) - nothing in this file asserts on item
// content, so it defaults to empty via beforeEach below.
const mockSubscriptionItemsList = vi.fn();
vi.mock('../../src/stripe/client.js', () => ({
  stripe: {
    subscriptions: { retrieve: (...args: unknown[]) => mockRetrieve(...args) },
    subscriptionItems: { list: (...args: unknown[]) => mockSubscriptionItemsList(...args) },
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
  mockSubscriptionItemsList.mockReset();
  mockSubscriptionItemsList.mockReturnValue([]);
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

  it('does not double-reap the same row across two immediate ticks', async () => {
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
      attempts: 0,
    });

    const first = await reapStaleProcessingEvents();
    expect(first.reaped).toBeGreaterThanOrEqual(1);

    // The reaper runs on its own interval, independent of the processor -
    // a second tick firing immediately after the first must not match this
    // row again (it's 'received' now, not 'processing') and must not
    // increment its attempts a second time for the same lease expiry.
    await reapStaleProcessingEvents();

    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
    expect(row?.status).toBe('received');
    expect(row?.attempts).toBe(1);

    // Left in 'received', this row would otherwise sit around and get
    // swept up by any later test's processPendingWebhookEvents() call in
    // this file (afterAll doesn't run until the whole file is done) -
    // clean it up now rather than risk contaminating a sibling test's own
    // claim batch.
    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
  });
});

describe('a still-alive handler whose lease is reclaimed mid-flight cannot clobber the row that reclaimed it', () => {
  it('does not finalize to "processed" once the row it claimed has moved on underneath it', async () => {
    const c = fakeCustomer();
    await db.insert(customers).values({ stripeCustomerId: c.id, email: c.email });
    cleanupCustomerIds.push(
      (await db.select().from(customers).where(eq(customers.stripeCustomerId, c.id)))[0]!.id,
    );

    const subscription = fakeSubscription({ customer: c.id });
    const event = fakeEvent('customer.subscription.created', subscription);
    cleanupEventIds.push(event.id);

    await db.insert(webhookEvents).values({
      stripeEventId: event.id,
      type: event.type,
      apiVersion: event.api_version,
      eventCreatedAt: new Date(event.created * 1000),
      payload: event,
      status: 'received',
    });

    // The handler's own Stripe call is where the deep bug hunt's exact
    // scenario lands: the row outlives its lease while still genuinely
    // in flight. Simulate the reaper reclaiming it (a real requeue, not a
    // mock) from *inside* the mocked call, i.e. strictly between
    // claimBatch's claim and processRow's later finalize write.
    mockRetrieve.mockImplementationOnce(async () => {
      await db
        .update(webhookEvents)
        .set({ status: 'received', processingStartedAt: null, attempts: 1, lastError: 'reaped mid-flight (test)' })
        .where(eq(webhookEvents.stripeEventId, event.id));
      return subscription;
    });

    await processPendingWebhookEvents();

    const [row] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, event.id));
    // If processRow's finalize write weren't guarded, this would be
    // 'processed' - silently overwriting the reap that happened while the
    // handler (which had already committed its real subscription-projection
    // side effects, below) was still running.
    expect(row?.status).toBe('received');
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe('reaped mid-flight (test)');

    // The handler's actual work still committed - this guard protects the
    // webhook_events ledger row, not the handler's own side effects (that's
    // a separate idempotency concern, see the deep bug hunt's finding on
    // payment_attempts).
    const [subRow] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, subscription.id));
    expect(subRow).toBeDefined();
    cleanupSubscriptionIds.push(subRow!.id);
    // Unlike the 'does not double-reap' test above, this row can't be
    // deleted inline here - a real subscription_events row now references
    // it via FK (written by the handler this test actually exercised), and
    // that only gets cleaned up in the right order by afterAll below, keyed
    // off cleanupSubscriptionIds. Safe to leave 'received' either way: this
    // is the last test in the file, so there's no later claim batch left to
    // sweep it up.
  });
});

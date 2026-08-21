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
const { webhookEvents } = await import('../../src/db/schema.js');
const { processPendingWebhookEvents, MAX_ATTEMPTS } = await import('../../src/webhooks/processor.js');
const { fakeEvent, fakeSubscription } = await import('./helpers/stripeFixtures.js');

const cleanupEventIds: string[] = [];

beforeEach(() => {
  mockRetrieve.mockReset();
  mockSubscriptionItemsList.mockReset();
  mockSubscriptionItemsList.mockReturnValue([]);
});

afterAll(async () => {
  for (const id of cleanupEventIds) {
    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, id));
  }
  await pool.end();
});

describe('processRow retries a failing event with exponential backoff, then parks it as failed', () => {
  it('goes back to "received" with attempts=1 and a ~30s nextAttemptAt after one failure, then reaches "failed" at MAX_ATTEMPTS', async () => {
    const subscription = fakeSubscription();
    const event = fakeEvent('customer.subscription.updated', subscription);
    cleanupEventIds.push(event.id);

    await db.insert(webhookEvents).values({
      stripeEventId: event.id,
      type: event.type,
      apiVersion: event.api_version,
      eventCreatedAt: new Date(event.created * 1000),
      payload: event,
      status: 'received',
    });

    // First failure: the Stripe re-fetch inside handleSubscriptionEvent
    // rejects, so processRow's catch path should requeue rather than fail.
    mockRetrieve.mockRejectedValueOnce(new Error('stripe unavailable'));
    await processPendingWebhookEvents();

    const [afterFirst] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, event.id));
    expect(afterFirst?.status).toBe('received');
    expect(afterFirst?.attempts).toBe(1);
    expect(afterFirst?.lastError).toBe('stripe unavailable');

    // computeBackoffSeconds(1) === 30 - allow a few seconds of slack for
    // however long the test itself takes to reach this assertion.
    const nextAttemptMs = afterFirst?.nextAttemptAt?.getTime() ?? 0;
    const expectedMs = Date.now() + 30_000;
    expect(Math.abs(nextAttemptMs - expectedMs)).toBeLessThan(5_000);

    // Keep failing it through the rest of its attempts. Real time won't
    // advance 30-1920s inside a test, so nextAttemptAt is forced into the
    // past before each subsequent claim, standing in for "later" the same
    // way the reaper tests stand in for a dead worker.
    let row = afterFirst;
    while (row && row.status === 'received' && row.attempts < MAX_ATTEMPTS) {
      await db
        .update(webhookEvents)
        .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(eq(webhookEvents.stripeEventId, event.id));

      mockRetrieve.mockRejectedValueOnce(new Error('stripe unavailable'));
      await processPendingWebhookEvents();

      [row] = await db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.stripeEventId, event.id));
    }

    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(MAX_ATTEMPTS);
  });
});

describe('dispatch() treats an unrecognized event type as a no-op, not a failure', () => {
  it('processes a charge.succeeded row straight to "processed" with no error and no Stripe call', async () => {
    const event = fakeEvent('charge.succeeded', { id: 'ch_test_unhandled', object: 'charge' });
    cleanupEventIds.push(event.id);

    await db.insert(webhookEvents).values({
      stripeEventId: event.id,
      type: event.type,
      apiVersion: event.api_version,
      eventCreatedAt: new Date(event.created * 1000),
      payload: event,
      status: 'received',
    });

    await processPendingWebhookEvents();

    const [row] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, event.id));
    expect(row?.status).toBe('processed');
    expect(row?.lastError).toBeNull();
    // dispatch() falls through to a resolved no-op for unhandled types -
    // it never reaches into a handler that would call the Stripe API.
    expect(mockRetrieve).not.toHaveBeenCalled();
  });
});

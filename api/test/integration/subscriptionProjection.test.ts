import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRetrieve = vi.fn();
vi.mock('../../src/stripe/client.js', () => ({
  stripe: {
    subscriptions: { retrieve: (...args: unknown[]) => mockRetrieve(...args) },
  },
}));

const { db, pool } = await import('../../src/db/client.js');
const { customers, subscriptionItems, subscriptionEvents, subscriptions, webhookEvents } = await import(
  '../../src/db/schema.js'
);
const { processPendingWebhookEvents } = await import('../../src/webhooks/processor.js');
const { syncCustomerFromStripe, syncSubscriptionFromStripe } = await import('../../src/stripe/sync.js');
const { fakeCustomer, fakeEvent, fakeSubscription, fakeSubscriptionItem } = await import(
  './helpers/stripeFixtures.js'
);

const cleanupSubscriptionIds: string[] = [];
const cleanupCustomerIds: string[] = [];
const cleanupEventIds: string[] = [];

async function seedCustomer(stripeCustomerId: string) {
  const [row] = await db
    .insert(customers)
    .values({ stripeCustomerId, email: 'test@example.com' })
    .returning({ id: customers.id });
  cleanupCustomerIds.push(row!.id);
  return row!.id;
}

async function insertReceivedEvent(event: { id: string; type: string; created: number }) {
  await db.insert(webhookEvents).values({
    stripeEventId: event.id,
    type: event.type,
    apiVersion: '2026-06-24.dahlia',
    eventCreatedAt: new Date(event.created * 1000),
    payload: event,
    status: 'received',
  });
  cleanupEventIds.push(event.id);
}

beforeEach(() => {
  mockRetrieve.mockReset();
});

afterAll(async () => {
  // subscription_events references webhook_events, so it must go first.
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

describe('subscription periods are read from items, not from the subscription', () => {
  it('stores current_period_start/end on subscription_items using the item-level values', async () => {
    const stripeCustomerId = await (async () => {
      const c = fakeCustomer();
      await seedCustomer(c.id);
      return c.id;
    })();

    const item = fakeSubscriptionItem();
    const subscription = fakeSubscription({ customer: stripeCustomerId, items: { data: [item] } });
    mockRetrieve.mockResolvedValueOnce(subscription);

    const event = fakeEvent('customer.subscription.created', subscription);
    await insertReceivedEvent(event);
    await processPendingWebhookEvents();

    const [subRow] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, subscription.id));
    expect(subRow).toBeDefined();
    cleanupSubscriptionIds.push(subRow!.id);

    const items = await db
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, subRow!.id));
    expect(items).toHaveLength(1);
    expect(items[0]?.currentPeriodStart?.getTime()).toBe(item.current_period_start * 1000);
    expect(items[0]?.currentPeriodEnd?.getTime()).toBe(item.current_period_end * 1000);
  });
});

describe('a mixed-interval subscription stores a period per item', () => {
  it('projects two items with different intervals and different periods, independently', async () => {
    const c = fakeCustomer();
    await seedCustomer(c.id);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const monthlyItem = fakeSubscriptionItem({
      price: { id: 'price_monthly', object: 'price', currency: 'usd', unit_amount: 2900, recurring: { interval: 'month' }, metadata: {} },
      current_period_start: nowSeconds,
      current_period_end: nowSeconds + 30 * 24 * 60 * 60,
    });
    const annualItem = fakeSubscriptionItem({
      price: { id: 'price_annual', object: 'price', currency: 'usd', unit_amount: 29000, recurring: { interval: 'year' }, metadata: {} },
      current_period_start: nowSeconds,
      current_period_end: nowSeconds + 365 * 24 * 60 * 60,
    });
    const subscription = fakeSubscription({
      customer: c.id,
      items: { data: [monthlyItem, annualItem] },
    });
    mockRetrieve.mockResolvedValueOnce(subscription);

    const event = fakeEvent('customer.subscription.created', subscription);
    await insertReceivedEvent(event);
    await processPendingWebhookEvents();

    const [subRow] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, subscription.id));
    cleanupSubscriptionIds.push(subRow!.id);

    const items = await db
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, subRow!.id));
    expect(items).toHaveLength(2);

    const monthly = items.find((i) => i.recurringInterval === 'month');
    const annual = items.find((i) => i.recurringInterval === 'year');
    expect(monthly?.currentPeriodEnd?.getTime()).toBe(monthlyItem.current_period_end * 1000);
    expect(annual?.currentPeriodEnd?.getTime()).toBe(annualItem.current_period_end * 1000);
    expect(monthly?.currentPeriodEnd?.getTime()).not.toBe(annual?.currentPeriodEnd?.getTime());

    // next_period_end_derived is the minimum of the two - the monthly one.
    expect(subRow?.nextPeriodEndDerived?.getTime()).toBe(monthlyItem.current_period_end * 1000);
  });
});

describe('subscription created then immediately canceled, out of order', () => {
  it('does not let a late-arriving older "created" event revert a newer "canceled" state', async () => {
    const c = fakeCustomer();
    await seedCustomer(c.id);

    const t1 = Math.floor(Date.now() / 1000) - 100;
    const t2 = t1 + 50;

    const stripeSubscriptionId = 'sub_test_outoforder';
    const createdSubscriptionSnapshot = fakeSubscription({
      id: stripeSubscriptionId,
      customer: c.id,
      status: 'trialing',
    });
    const canceledSubscriptionSnapshot = fakeSubscription({
      id: stripeSubscriptionId,
      customer: c.id,
      status: 'canceled',
    });

    // Event B (canceled, created at t2) is processed FIRST - out of order.
    mockRetrieve.mockResolvedValueOnce(canceledSubscriptionSnapshot);
    const eventB = fakeEvent('customer.subscription.deleted', canceledSubscriptionSnapshot, { created: t2 });
    await insertReceivedEvent(eventB);
    await processPendingWebhookEvents();

    const [afterB] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));
    expect(afterB?.status).toBe('canceled');
    cleanupSubscriptionIds.push(afterB!.id);

    // Event A (created, created at t1 < t2) arrives late and gets
    // processed second. If the guard didn't exist, this mocked retrieve
    // would make it look "trialing" again.
    mockRetrieve.mockResolvedValueOnce(createdSubscriptionSnapshot);
    const eventA = fakeEvent('customer.subscription.created', createdSubscriptionSnapshot, { created: t1 });
    await insertReceivedEvent(eventA);
    await processPendingWebhookEvents();

    const [afterA] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));
    // Still canceled - the stale event must not have reverted it.
    expect(afterA?.status).toBe('canceled');

    const [eventARow] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, eventA.id));
    expect(eventARow?.status).toBe('skipped');

    // The stale event's handler must never even have called the Stripe API
    // a second time - the guard short-circuits before the re-fetch.
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
  });
});

describe('an event that arrives late does not overwrite newer state', () => {
  it('skips an older update event once a newer one has already been applied', async () => {
    const c = fakeCustomer();
    await seedCustomer(c.id);

    const t1 = Math.floor(Date.now() / 1000) - 100;
    const t2 = t1 + 50;
    const t0 = t1 - 50; // older than both

    const stripeSubscriptionId = 'sub_test_latearrival';
    const activeSnapshot = fakeSubscription({ id: stripeSubscriptionId, customer: c.id, status: 'active' });
    const pastDueSnapshot = fakeSubscription({ id: stripeSubscriptionId, customer: c.id, status: 'past_due' });

    mockRetrieve.mockResolvedValueOnce(activeSnapshot);
    await insertReceivedEvent(fakeEvent('customer.subscription.updated', activeSnapshot, { created: t1 }));
    await processPendingWebhookEvents();

    mockRetrieve.mockResolvedValueOnce(pastDueSnapshot);
    await insertReceivedEvent(fakeEvent('customer.subscription.updated', pastDueSnapshot, { created: t2 }));
    await processPendingWebhookEvents();

    const [afterNewer] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));
    expect(afterNewer?.status).toBe('past_due');
    cleanupSubscriptionIds.push(afterNewer!.id);

    // An older event (t0, before either processed event) arrives last.
    const staleEvent = fakeEvent('customer.subscription.updated', activeSnapshot, { created: t0 });
    await insertReceivedEvent(staleEvent);
    await processPendingWebhookEvents();

    const [afterStale] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));
    expect(afterStale?.status).toBe('past_due');

    const [staleRow] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, staleEvent.id));
    expect(staleRow?.status).toBe('skipped');
    expect(mockRetrieve).toHaveBeenCalledTimes(2); // only the two in-order events
  });
});

describe('an unexpected state transition is still applied and logged - Stripe is always the source of truth', () => {
  it('projects a status the EXPECTED_TRANSITIONS table does not list for the prior status, and records it', async () => {
    const c = fakeCustomer();
    await seedCustomer(c.id);

    const stripeSubscriptionId = 'sub_test_unexpectedtransition';
    const activeSnapshot = fakeSubscription({
      id: stripeSubscriptionId,
      customer: c.id,
      status: 'active',
    });
    mockRetrieve.mockResolvedValueOnce(activeSnapshot);
    await insertReceivedEvent(fakeEvent('customer.subscription.created', activeSnapshot));
    await processPendingWebhookEvents();

    const [afterCreate] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));
    expect(afterCreate?.status).toBe('active');
    cleanupSubscriptionIds.push(afterCreate!.id);

    // EXPECTED_TRANSITIONS['active'] only lists past_due, canceled, paused,
    // unpaid - 'trialing' is not in that set, so active -> trialing is
    // genuinely unexpected. It must still be applied and logged, not
    // silently dropped or blocked.
    const trialingSnapshot = fakeSubscription({
      id: stripeSubscriptionId,
      customer: c.id,
      status: 'trialing',
    });
    mockRetrieve.mockResolvedValueOnce(trialingSnapshot);
    await insertReceivedEvent(fakeEvent('customer.subscription.updated', trialingSnapshot));
    await processPendingWebhookEvents();

    const [afterUpdate] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));
    // Stripe wins - the row is updated even though the transition is not
    // "expected".
    expect(afterUpdate?.status).toBe('trialing');

    const events = await db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.subscriptionId, afterUpdate!.id));
    const transitionEvent = events.find((e) => e.toStatus === 'trialing');
    expect(transitionEvent).toBeDefined();
    expect(transitionEvent?.fromStatus).toBe('active');
    expect(transitionEvent?.reason).toBe('customer.subscription.updated');
  });
});

describe('syncSubscriptionFromStripe serializes two genuinely concurrent syncs of an existing subscription (finding #5, deep bug hunt)', () => {
  it('ends up at the newer event\'s status regardless of which of the two concurrent transactions the DB happens to run first', async () => {
    const c = fakeCustomer();
    await seedCustomer(c.id);

    const t0 = Math.floor(Date.now() / 1000) - 200;
    const t1 = t0 + 50;
    const t2 = t1 + 50;
    const stripeSubscriptionId = 'sub_test_concurrent_sync';

    // Seed the row first (a prior, already-committed sync) so the race
    // below is the realistic scenario the FOR UPDATE guard protects - two
    // concurrent UPDATEs of an EXISTING row (e.g. an admin's
    // resyncAfterMutation() racing the webhook worker), not two concurrent
    // first-time inserts. (SELECT ... FOR UPDATE can't lock a row that
    // doesn't exist yet, so a first-ever insert-vs-insert race is a
    // different, narrower case this guard doesn't cover - it's guarded
    // instead by the unique constraint on stripe_subscription_id.)
    const initialSnapshot = fakeSubscription({ id: stripeSubscriptionId, customer: c.id, status: 'trialing' });
    const seeded = await syncSubscriptionFromStripe(initialSnapshot as never, {
      reason: 'seed',
      lastEventAt: new Date(t0 * 1000),
    });
    cleanupSubscriptionIds.push(seeded.id);

    const olderSnapshot = fakeSubscription({ id: stripeSubscriptionId, customer: c.id, status: 'active' });
    const newerSnapshot = fakeSubscription({ id: stripeSubscriptionId, customer: c.id, status: 'past_due' });

    // Two genuinely concurrent calls racing each other directly - not two
    // sequential processPendingWebhookEvents() ticks like the out-of-order
    // tests above. Whichever transaction's SELECT ... FOR UPDATE actually
    // runs first wins the lock; FOR UPDATE + the in-transaction staleness
    // re-check must still land on the newer event's state either way. (The
    // older call's own return value legitimately depends on which one the
    // DB ran first - if it runs first, its write is genuinely valid at
    // that moment and it correctly reports 'active'; if it runs second, it
    // loses the guard and correctly reports the row's actual 'past_due'
    // state instead. Only the newer call's result, and the row's final
    // state, are deterministic - asserted below.)
    const [olderResult, newerResult] = await Promise.all([
      syncSubscriptionFromStripe(olderSnapshot as never, { reason: 'race:older', lastEventAt: new Date(t1 * 1000) }),
      syncSubscriptionFromStripe(newerSnapshot as never, { reason: 'race:newer', lastEventAt: new Date(t2 * 1000) }),
    ]);

    expect(olderResult.id).toBe(seeded.id);
    expect(newerResult.id).toBe(seeded.id);
    // The strictly-newer call must always report the status that actually
    // won - there is no interleaving where a later, newer write ever loses
    // to an older one.
    expect(newerResult.toStatus).toBe('past_due');

    const [row] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));
    expect(row?.status).toBe('past_due');
    expect(row?.lastEventAt?.getTime()).toBe(t2 * 1000);
  });
});

describe('syncCustomerFromStripe preserves external_ref on a blank re-sync', () => {
  it('does not overwrite an existing externalRef when a later sync has no metadata.external_ref key', async () => {
    const original = fakeCustomer({ metadata: { external_ref: 'org_blank_resync' } });
    const { id: customerId } = await syncCustomerFromStripe(original as never);
    cleanupCustomerIds.push(customerId);

    const [afterFirst] = await db.select().from(customers).where(eq(customers.id, customerId));
    expect(afterFirst?.externalRef).toBe('org_blank_resync');

    // Same Stripe customer id, but metadata carries no external_ref key at
    // all - a bare re-sync (e.g. triggered by an unrelated field changing).
    const blankResync = fakeCustomer({ id: original.id, metadata: {} });
    await syncCustomerFromStripe(blankResync as never);

    const [afterSecond] = await db.select().from(customers).where(eq(customers.id, customerId));
    // Still the original value - never overwritten with a blank.
    expect(afterSecond?.externalRef).toBe('org_blank_resync');
  });
});

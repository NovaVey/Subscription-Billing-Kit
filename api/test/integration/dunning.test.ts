import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoicesRetrieve = vi.fn();
const mockSubscriptionsRetrieve = vi.fn();
const mockEmailSend = vi.fn();
// syncSubscriptionFromStripe (reached via handleSubscriptionEvent) now
// separately paginates subscription items (finding #24, deep bug hunt) -
// nothing in this file asserts on item content, so it defaults to empty
// via beforeEach below.
const mockSubscriptionItemsList = vi.fn();

vi.mock('../../src/stripe/client.js', () => ({
  stripe: {
    invoices: { retrieve: (...args: unknown[]) => mockInvoicesRetrieve(...args) },
    subscriptions: { retrieve: (...args: unknown[]) => mockSubscriptionsRetrieve(...args) },
    subscriptionItems: { list: (...args: unknown[]) => mockSubscriptionItemsList(...args) },
  },
}));

vi.mock('../../src/billing/emailAdapter.js', () => ({
  emailAdapter: { send: (...args: unknown[]) => mockEmailSend(...args) },
}));

const { db, pool } = await import('../../src/db/client.js');
const { customers, dunningNotices, dunningState, invoices, subscriptionEvents, subscriptions, webhookEvents } =
  await import('../../src/db/schema.js');
const { handleInvoiceEvent } = await import('../../src/webhooks/handlers/invoice.js');
const { handleSubscriptionEvent } = await import('../../src/webhooks/handlers/subscription.js');
const { runDunningTick, resolveDunningOnInvoicePaid, closeDunningOnSubscriptionDeleted } = await import(
  '../../src/billing/dunning.js'
);
const { fakeCustomer, fakeEvent, fakeInvoice, fakeSubscription } = await import('./helpers/stripeFixtures.js');

const cleanupSubscriptionIds: string[] = [];
const cleanupCustomerIds: string[] = [];
const cleanupInvoiceIds: string[] = [];
const cleanupWebhookEventIds: string[] = [];

async function seedCustomerAndSubscription() {
  const customer = fakeCustomer();
  const [customerRow] = await db
    .insert(customers)
    .values({ stripeCustomerId: customer.id, email: customer.email })
    .returning({ id: customers.id });
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

  return { customer, customerRow: customerRow!, subscription, subRow: subRow! };
}

function subscriptionLinkedInvoice(
  stripeSubscriptionId: string,
  stripeCustomerId: string,
  overrides: Record<string, unknown> = {},
) {
  return fakeInvoice({
    customer: stripeCustomerId,
    parent: {
      type: 'subscription_details',
      subscription_details: { subscription: stripeSubscriptionId, metadata: null },
      quote_details: null,
    },
    ...overrides,
  });
}

async function getDunningState(subscriptionId: string) {
  const [row] = await db.select().from(dunningState).where(eq(dunningState.subscriptionId, subscriptionId));
  return row;
}

beforeEach(() => {
  mockInvoicesRetrieve.mockReset();
  mockSubscriptionsRetrieve.mockReset();
  mockEmailSend.mockReset();
  mockEmailSend.mockResolvedValue(undefined);
  mockSubscriptionItemsList.mockReset();
  mockSubscriptionItemsList.mockReturnValue([]);
});

afterAll(async () => {
  // dunning_notices/dunning_state/subscription_events reference
  // subscriptions/invoices/webhook_events, so they must be cleaned up before
  // any of those (same FK ordering discipline as every other integration
  // suite's afterAll - see subscriptionProjection.test.ts). subscription_events
  // rows only exist here because the subscription-deleted test drives the
  // real handleSubscriptionEvent handler, which records a state transition.
  for (const id of cleanupSubscriptionIds) {
    await db.delete(dunningNotices).where(eq(dunningNotices.subscriptionId, id));
    await db.delete(dunningState).where(eq(dunningState.subscriptionId, id));
    await db.delete(subscriptionEvents).where(eq(subscriptionEvents.subscriptionId, id));
  }
  for (const id of cleanupInvoiceIds) {
    await db.delete(invoices).where(eq(invoices.id, id));
  }
  for (const id of cleanupSubscriptionIds) {
    await db.delete(subscriptions).where(eq(subscriptions.id, id));
  }
  for (const id of cleanupCustomerIds) {
    await db.delete(customers).where(eq(customers.id, id));
  }
  for (const id of cleanupWebhookEventIds) {
    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, id));
  }
  await pool.end();
});

describe('payment-failed-then-paid-clears-dunning-in-one-tick', () => {
  it('opens a dunning cycle on invoice.payment_failed and resolves it on invoice.paid for the same invoice, with no tick in between', async () => {
    const { subscription, subRow } = await seedCustomerAndSubscription();

    const failedInvoice = subscriptionLinkedInvoice(subscription.id, subscription.customer, { status: 'open', attempt_count: 1 });
    mockInvoicesRetrieve.mockResolvedValueOnce(failedInvoice);
    await handleInvoiceEvent(fakeEvent('invoice.payment_failed', failedInvoice) as never);

    const [invoiceRow] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, failedInvoice.id));
    cleanupInvoiceIds.push(invoiceRow!.id);

    const openState = await getDunningState(subRow.id);
    expect(openState?.stage).toBe(1);
    expect(openState?.resolvedAt).toBeNull();
    expect(openState?.triggeringInvoiceId).toBe(invoiceRow!.id);

    const paidInvoice = subscriptionLinkedInvoice(subscription.id, subscription.customer, {
      id: failedInvoice.id,
      status: 'paid',
      amount_paid: failedInvoice.amount_due,
      status_transitions: { finalized_at: failedInvoice.created, paid_at: Math.floor(Date.now() / 1000) },
    });
    mockInvoicesRetrieve.mockResolvedValueOnce(paidInvoice);
    await handleInvoiceEvent(fakeEvent('invoice.paid', paidInvoice) as never);

    const resolvedState = await getDunningState(subRow.id);
    expect(resolvedState?.resolvedAt).not.toBeNull();
    expect(resolvedState?.resolution).toBe('recovered');
    expect(resolvedState?.stage).toBe(0);
  });
});

describe('paying-an-unrelated-invoice-does-not-clear-dunning', () => {
  it('leaves the cycle open when a different invoice for the same subscription is paid', async () => {
    const { subscription, subRow } = await seedCustomerAndSubscription();

    const triggeringInvoice = subscriptionLinkedInvoice(subscription.id, subscription.customer, { status: 'open' });
    mockInvoicesRetrieve.mockResolvedValueOnce(triggeringInvoice);
    await handleInvoiceEvent(fakeEvent('invoice.payment_failed', triggeringInvoice) as never);
    const [triggeringRow] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, triggeringInvoice.id));
    cleanupInvoiceIds.push(triggeringRow!.id);

    const unrelatedInvoice = subscriptionLinkedInvoice(subscription.id, subscription.customer, {
      status: 'paid',
      status_transitions: { finalized_at: null, paid_at: Math.floor(Date.now() / 1000) },
    });
    mockInvoicesRetrieve.mockResolvedValueOnce(unrelatedInvoice);
    await handleInvoiceEvent(fakeEvent('invoice.paid', unrelatedInvoice) as never);
    const [unrelatedRow] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, unrelatedInvoice.id));
    cleanupInvoiceIds.push(unrelatedRow!.id);

    const state = await getDunningState(subRow.id);
    expect(state?.resolvedAt).toBeNull();
    expect(state?.stage).toBe(1);
    expect(state?.triggeringInvoiceId).toBe(triggeringRow!.id);
  });
});

describe('a-one-off-invoice-failure-never-opens-a-dunning-cycle', () => {
  it('records no dunning_state row when a payment_failed invoice has no subscription link', async () => {
    const customer = fakeCustomer();
    const [customerRow] = await db
      .insert(customers)
      .values({ stripeCustomerId: customer.id, email: customer.email })
      .returning({ id: customers.id });
    cleanupCustomerIds.push(customerRow!.id);

    const oneOffInvoice = fakeInvoice({ customer: customer.id, parent: null, status: 'open' });
    mockInvoicesRetrieve.mockResolvedValueOnce(oneOffInvoice);
    await handleInvoiceEvent(fakeEvent('invoice.payment_failed', oneOffInvoice) as never);

    const [invoiceRow] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, oneOffInvoice.id));
    cleanupInvoiceIds.push(invoiceRow!.id);
    expect(invoiceRow?.subscriptionId).toBeNull();

    const [triggered] = await db
      .select()
      .from(dunningState)
      .where(eq(dunningState.triggeringInvoiceId, invoiceRow!.id));
    expect(triggered).toBeUndefined();
  });
});

describe('dunning-never-sends-two-notices-for-one-stage', () => {
  it('does not double-escalate or double-send when the tick runs twice for the same due cycle', async () => {
    const { subRow } = await seedCustomerAndSubscription();

    const past = new Date(Date.now() - 60_000);
    await db.insert(dunningState).values({
      subscriptionId: subRow.id,
      stage: 1,
      enteredStageAt: past,
      nextActionAt: past, // already due for escalation to stage 2
    });

    await runDunningTick();
    await runDunningTick(); // simulates the tick firing again before anything else changes

    const state = await getDunningState(subRow.id);
    expect(state?.stage).toBe(2); // escalated exactly once, not twice

    const notices = await db
      .select()
      .from(dunningNotices)
      .where(and(eq(dunningNotices.subscriptionId, subRow.id), eq(dunningNotices.stage, 2)));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.sentAt).not.toBeNull();

    const stage2SendCalls = mockEmailSend.mock.calls.filter(([arg]) => (arg as { stage: number }).stage === 2);
    expect(stage2SendCalls).toHaveLength(1);
  });
});

describe('crash-between-notice-write-and-send-does-not-double-email', () => {
  it('sends an armed-but-unsent notice exactly once even if the send pass runs again', async () => {
    const { subRow } = await seedCustomerAndSubscription();

    // Simulates a crash after the escalation transaction committed (stage
    // already advanced, notice row already written) but before the send
    // pass confirmed delivery - the exact state a real crash in that
    // window would leave behind.
    await db.insert(dunningState).values({
      subscriptionId: subRow.id,
      stage: 2,
      enteredStageAt: new Date(),
      nextActionAt: new Date(Date.now() + 7 * 86_400_000),
    });
    await db.insert(dunningNotices).values({
      subscriptionId: subRow.id,
      stage: 2,
      channel: 'email',
      template: 'dunning_stage_2_reminder',
      sentAt: null,
    });

    await runDunningTick();
    await runDunningTick(); // the "tick runs again" from the named test

    const [notice] = await db
      .select()
      .from(dunningNotices)
      .where(and(eq(dunningNotices.subscriptionId, subRow.id), eq(dunningNotices.stage, 2)));
    expect(notice?.sentAt).not.toBeNull();
    expect(mockEmailSend).toHaveBeenCalledTimes(1);
  });
});

describe('escalates through every stage and resolves on a late payment', () => {
  it('drives a subscription from stage 1 to stage 3 via the tick, then recovers on invoice.paid (Phase 5 exit criteria, without a real test clock)', async () => {
    const { subscription, subRow } = await seedCustomerAndSubscription();

    const triggeringInvoice = subscriptionLinkedInvoice(subscription.id, subscription.customer, { status: 'open' });
    mockInvoicesRetrieve.mockResolvedValueOnce(triggeringInvoice);
    await handleInvoiceEvent(fakeEvent('invoice.payment_failed', triggeringInvoice) as never);
    const [triggeringRow] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, triggeringInvoice.id));
    cleanupInvoiceIds.push(triggeringRow!.id);

    expect((await getDunningState(subRow.id))?.stage).toBe(1);

    // Force each escalation to be immediately due, standing in for what a
    // real test clock's time jump would do - the tick logic being
    // exercised is identical either way.
    await db
      .update(dunningState)
      .set({ nextActionAt: new Date(Date.now() - 1000) })
      .where(eq(dunningState.subscriptionId, subRow.id));
    await runDunningTick();
    expect((await getDunningState(subRow.id))?.stage).toBe(2);

    await db
      .update(dunningState)
      .set({ nextActionAt: new Date(Date.now() - 1000) })
      .where(eq(dunningState.subscriptionId, subRow.id));
    await runDunningTick();
    expect((await getDunningState(subRow.id))?.stage).toBe(3);

    const notices = await db
      .select()
      .from(dunningNotices)
      .where(eq(dunningNotices.subscriptionId, subRow.id));
    expect(notices.map((n) => n.stage).sort()).toEqual([1, 2, 3]);
    expect(notices.every((n) => n.sentAt !== null)).toBe(true);

    const paidInvoice = subscriptionLinkedInvoice(subscription.id, subscription.customer, {
      id: triggeringInvoice.id,
      status: 'paid',
      amount_paid: triggeringInvoice.amount_due,
      status_transitions: { finalized_at: triggeringInvoice.created, paid_at: Math.floor(Date.now() / 1000) },
    });
    mockInvoicesRetrieve.mockResolvedValueOnce(paidInvoice);
    await handleInvoiceEvent(fakeEvent('invoice.paid', paidInvoice) as never);

    const finalState = await getDunningState(subRow.id);
    expect(finalState?.resolution).toBe('recovered');
    expect(finalState?.resolvedAt).not.toBeNull();
    expect(finalState?.stage).toBe(0);
  });
});

describe('resolved-cycle-does-not-still-send-a-notice-armed-before-it-resolved', () => {
  it('never sends a dunning_notices row whose owning dunning_state cycle already resolved', async () => {
    const { subRow } = await seedCustomerAndSubscription();

    // Simulates the exact race this guards against: a notice was armed
    // (sent_at left null) in the same window a concurrent invoice.paid
    // resolved the cycle - armNotice()'s write and
    // resolveDunningOnInvoicePaid() are separate transactions, not atomic
    // with each other.
    await db.insert(dunningState).values({
      subscriptionId: subRow.id,
      stage: 0,
      enteredStageAt: new Date(),
      nextActionAt: null,
      resolvedAt: new Date(),
      resolution: 'recovered',
    });
    await db.insert(dunningNotices).values({
      subscriptionId: subRow.id,
      stage: 2,
      channel: 'email',
      template: 'dunning_stage_2_reminder',
      sentAt: null,
    });

    await runDunningTick();

    const [notice] = await db
      .select()
      .from(dunningNotices)
      .where(and(eq(dunningNotices.subscriptionId, subRow.id), eq(dunningNotices.stage, 2)));
    expect(notice?.sentAt).toBeNull();
    expect(mockEmailSend).not.toHaveBeenCalled();
  });
});

describe('re-opening-a-resolved-cycle-clears-stale-notices-from-the-prior-cycle', () => {
  it('lets the new cycle arm and send its own stage 2 notice even though the prior cycle already sent one', async () => {
    const { subscription, subRow } = await seedCustomerAndSubscription();

    // A fully-completed prior cycle: it reached and sent a stage 2 notice,
    // then resolved.
    await db.insert(dunningState).values({
      subscriptionId: subRow.id,
      stage: 0,
      enteredStageAt: new Date(Date.now() - 30 * 86_400_000),
      nextActionAt: null,
      resolvedAt: new Date(Date.now() - 20 * 86_400_000),
      resolution: 'recovered',
    });
    await db.insert(dunningNotices).values({
      subscriptionId: subRow.id,
      stage: 2,
      channel: 'email',
      template: 'dunning_stage_2_reminder',
      sentAt: new Date(Date.now() - 20 * 86_400_000),
    });

    // A brand new invoice fails on the same subscription, opening a fresh cycle.
    const newFailedInvoice = subscriptionLinkedInvoice(subscription.id, subscription.customer, { status: 'open' });
    mockInvoicesRetrieve.mockResolvedValueOnce(newFailedInvoice);
    await handleInvoiceEvent(fakeEvent('invoice.payment_failed', newFailedInvoice) as never);
    const [newInvoiceRow] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, newFailedInvoice.id));
    cleanupInvoiceIds.push(newInvoiceRow!.id);

    expect((await getDunningState(subRow.id))?.stage).toBe(1);

    // Drive the new cycle to stage 2, same technique as "escalates through
    // every stage" above.
    await db
      .update(dunningState)
      .set({ nextActionAt: new Date(Date.now() - 1000) })
      .where(eq(dunningState.subscriptionId, subRow.id));
    await runDunningTick();
    expect((await getDunningState(subRow.id))?.stage).toBe(2);

    const stage2Notices = await db
      .select()
      .from(dunningNotices)
      .where(and(eq(dunningNotices.subscriptionId, subRow.id), eq(dunningNotices.stage, 2)));
    expect(stage2Notices).toHaveLength(1); // the stale row was cleared, not left as a blocking second row
    expect(stage2Notices[0]?.sentAt).not.toBeNull(); // and the new cycle's own stage 2 notice DID send

    const stage2SendCalls = mockEmailSend.mock.calls.filter(([arg]) => (arg as { stage: number }).stage === 2);
    expect(stage2SendCalls).toHaveLength(1); // sent for the new cycle - proves the old row didn't block it
  });
});

describe('a-canceled-cycle-is-never-reopened-by-a-late-out-of-order-payment-failed', () => {
  it('leaves a resolution=canceled cycle untouched when invoice.payment_failed arrives after customer.subscription.deleted already closed it', async () => {
    const { subscription, subRow } = await seedCustomerAndSubscription();

    // Already closed as canceled - the exact terminal state
    // closeDunningOnSubscriptionDeleted leaves behind.
    await db.insert(dunningState).values({
      subscriptionId: subRow.id,
      stage: 4,
      enteredStageAt: new Date(),
      nextActionAt: null,
      resolvedAt: new Date(),
      resolution: 'canceled',
    });

    // Stripe can generate a final invoice right around cancellation, and
    // webhook delivery order isn't guaranteed - its payment_failed can
    // arrive after the deletion event already processed. Without the guard
    // this test exercises, that late event would reopen and re-arm a
    // dunning cycle for a subscription Stripe already reports gone.
    const lateFailedInvoice = subscriptionLinkedInvoice(subscription.id, subscription.customer, { status: 'open' });
    mockInvoicesRetrieve.mockResolvedValueOnce(lateFailedInvoice);
    await handleInvoiceEvent(fakeEvent('invoice.payment_failed', lateFailedInvoice) as never);
    const [invoiceRow] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, lateFailedInvoice.id));
    cleanupInvoiceIds.push(invoiceRow!.id);

    const state = await getDunningState(subRow.id);
    expect(state?.stage).toBe(4);
    expect(state?.resolvedAt).not.toBeNull();
    expect(state?.resolution).toBe('canceled');

    const notices = await db.select().from(dunningNotices).where(eq(dunningNotices.subscriptionId, subRow.id));
    expect(notices).toHaveLength(0); // no stage-1 notice was armed for a reopened cycle

    await runDunningTick();
    const sendCallsForSub = mockEmailSend.mock.calls.filter(
      ([arg]) => (arg as { subscriptionId: string }).subscriptionId === subRow.id,
    );
    expect(sendCallsForSub).toHaveLength(0);
  });
});

describe('subscription-deleted-closes-an-open-dunning-cycle-permanently', () => {
  it('closes an open dunning cycle as canceled on customer.subscription.deleted, and a later tick does not re-escalate or re-notify it', async () => {
    const { subscription, subRow } = await seedCustomerAndSubscription();

    // Open dunning cycle already at stage 2 - same direct-seed technique as
    // "crash-between-notice-write-and-send-does-not-double-email" above.
    await db.insert(dunningState).values({
      subscriptionId: subRow.id,
      stage: 2,
      enteredStageAt: new Date(),
      nextActionAt: new Date(Date.now() + 7 * 86_400_000),
    });

    const canceledSubscription = fakeSubscription({
      id: subscription.id,
      customer: subscription.customer,
      status: 'canceled',
    });
    const deletedEvent = fakeEvent('customer.subscription.deleted', canceledSubscription);

    // handleSubscriptionEvent is normally only reached after the processor
    // has already persisted the webhook_events row (that's how every other
    // integration suite exercises it - see subscriptionProjection.test.ts).
    // Calling it directly here, the same way this file already calls
    // handleInvoiceEvent directly, means the status change to 'canceled'
    // needs its own webhook_events row up front: syncSubscriptionFromStripe's
    // recordTransition() writes subscription_events.stripe_event_id, which
    // has a real FK to webhook_events.stripe_event_id.
    await db.insert(webhookEvents).values({
      stripeEventId: deletedEvent.id,
      type: deletedEvent.type,
      apiVersion: deletedEvent.api_version,
      eventCreatedAt: new Date(deletedEvent.created * 1000),
      payload: deletedEvent,
      status: 'received',
    });
    cleanupWebhookEventIds.push(deletedEvent.id);

    mockSubscriptionsRetrieve.mockResolvedValueOnce(canceledSubscription);
    await handleSubscriptionEvent(deletedEvent as never);

    const closedState = await getDunningState(subRow.id);
    expect(closedState?.stage).toBe(4);
    expect(closedState?.resolvedAt).not.toBeNull();
    expect(closedState?.resolution).toBe('canceled');
    expect(closedState?.nextActionAt).toBeNull();

    // Terminal-by-cancellation, not terminal-by-timeout (§5.10's stage 4 via
    // escalateDueCycles) - resolvedAt is already set, so a later tick must
    // not escalate this cycle further or send anything for it.
    await runDunningTick();

    const afterTick = await getDunningState(subRow.id);
    expect(afterTick?.stage).toBe(4);
    expect(afterTick?.resolvedAt).not.toBeNull();
    expect(afterTick?.resolution).toBe('canceled');

    const notices = await db
      .select()
      .from(dunningNotices)
      .where(eq(dunningNotices.subscriptionId, subRow.id));
    expect(notices).toHaveLength(0); // no notice was ever armed or sent for this cycle

    const sendCallsForSub = mockEmailSend.mock.calls.filter(
      ([arg]) => (arg as { subscriptionId: string }).subscriptionId === subRow.id,
    );
    expect(sendCallsForSub).toHaveLength(0);
  });
});

describe('sendUnsentDunningNotices claims a notice atomically before sending it (finding #6, deep bug hunt)', () => {
  it('sends an armed-but-unsent notice exactly once even when two ticks run concurrently, racing for the same notice', async () => {
    const { subRow } = await seedCustomerAndSubscription();

    // A notice already armed (sent_at null), stage not due for escalation -
    // isolates the send-claim race from escalateDueCycles.
    await db.insert(dunningState).values({
      subscriptionId: subRow.id,
      stage: 2,
      enteredStageAt: new Date(),
      nextActionAt: new Date(Date.now() + 7 * 86_400_000),
    });
    await db.insert(dunningNotices).values({
      subscriptionId: subRow.id,
      stage: 2,
      channel: 'email',
      template: 'dunning_stage_2_reminder',
      sentAt: null,
    });

    // Two genuinely concurrent ticks - not the sequential double-call the
    // "crash-between-notice-write-and-send" test above exercises. Both
    // SELECT the same unsent notice before either UPDATE commits; only the
    // guarded claim UPDATE (WHERE sent_at IS NULL ... RETURNING) lets one
    // of them win.
    await Promise.all([runDunningTick(), runDunningTick()]);

    const sendCallsForSub = mockEmailSend.mock.calls.filter(
      ([arg]) => (arg as { subscriptionId: string }).subscriptionId === subRow.id,
    );
    expect(sendCallsForSub).toHaveLength(1);

    const [notice] = await db
      .select()
      .from(dunningNotices)
      .where(and(eq(dunningNotices.subscriptionId, subRow.id), eq(dunningNotices.stage, 2)));
    expect(notice?.sentAt).not.toBeNull();
  });

  it('reverts the claim (sent_at back to null) and records sendError when the send itself fails, so a later tick can retry it', async () => {
    const { subRow } = await seedCustomerAndSubscription();

    await db.insert(dunningState).values({
      subscriptionId: subRow.id,
      stage: 1,
      enteredStageAt: new Date(),
      nextActionAt: new Date(Date.now() + 7 * 86_400_000),
    });
    await db.insert(dunningNotices).values({
      subscriptionId: subRow.id,
      stage: 1,
      channel: 'email',
      template: 'dunning_stage_1_payment_failed',
      sentAt: null,
    });

    mockEmailSend.mockReset();
    mockEmailSend.mockRejectedValueOnce(new Error('smtp timeout'));

    await runDunningTick();

    const [afterFailure] = await db
      .select()
      .from(dunningNotices)
      .where(and(eq(dunningNotices.subscriptionId, subRow.id), eq(dunningNotices.stage, 1)));
    expect(afterFailure?.sentAt).toBeNull();
    expect(afterFailure?.sendError).toBe('smtp timeout');

    // A later tick retries it once the transient failure clears - the
    // claim-then-revert-on-failure design must not have left the notice
    // permanently stuck (e.g. mis-claimed as already sent).
    mockEmailSend.mockResolvedValueOnce(undefined);
    await runDunningTick();

    const [afterRetry] = await db
      .select()
      .from(dunningNotices)
      .where(and(eq(dunningNotices.subscriptionId, subRow.id), eq(dunningNotices.stage, 1)));
    expect(afterRetry?.sentAt).not.toBeNull();
    expect(mockEmailSend).toHaveBeenCalledTimes(2);
  });
});

describe('resolveDunningOnInvoicePaid and closeDunningOnSubscriptionDeleted guard against racing each other (finding #8, deep bug hunt)', () => {
  async function seedOpenCycleWithInvoice() {
    const { customerRow, subRow } = await seedCustomerAndSubscription();
    const [invoiceRow] = await db
      .insert(invoices)
      .values({
        customerId: customerRow.id,
        subscriptionId: subRow.id,
        stripeInvoiceId: `in_test_race_${Math.random().toString(36).slice(2)}`,
        status: 'open',
        currency: 'usd',
        amountDueMinor: 4900,
      })
      .returning({ id: invoices.id });
    cleanupInvoiceIds.push(invoiceRow!.id);
    await db.insert(dunningState).values({
      subscriptionId: subRow.id,
      triggeringInvoiceId: invoiceRow!.id,
      stage: 1,
      enteredStageAt: new Date(),
      nextActionAt: new Date(),
    });
    return { subRow, invoiceRow: invoiceRow! };
  }

  it('a resolution that already committed stays as-is when a losing resolution is applied moments later (first resolution wins, not last write)', async () => {
    const { subRow, invoiceRow } = await seedOpenCycleWithInvoice();

    // invoice.paid resolves the cycle first, fully committed...
    await db.transaction((tx) => resolveDunningOnInvoicePaid(tx, { invoiceId: invoiceRow.id, now: new Date() }));
    const afterPaid = await getDunningState(subRow.id);
    expect(afterPaid?.resolution).toBe('recovered');

    // ...then a customer.subscription.deleted for the same subscription
    // arrives moments later (Stripe delivery order isn't guaranteed - the
    // cancellation could be a consequence of the very payment that just
    // recovered the account, or unrelated). It must not overwrite the
    // already-recorded recovery with 'canceled'.
    await db.transaction((tx) => closeDunningOnSubscriptionDeleted(tx, { subscriptionId: subRow.id, now: new Date() }));
    const afterDeleted = await getDunningState(subRow.id);
    expect(afterDeleted?.resolution).toBe('recovered');
    expect(afterDeleted?.resolvedAt?.getTime()).toBe(afterPaid?.resolvedAt?.getTime());
  });

  it('the reverse order also holds - a cancellation that already committed is never overwritten by a late payment recovery', async () => {
    const { subRow, invoiceRow } = await seedOpenCycleWithInvoice();

    await db.transaction((tx) => closeDunningOnSubscriptionDeleted(tx, { subscriptionId: subRow.id, now: new Date() }));
    const afterDeleted = await getDunningState(subRow.id);
    expect(afterDeleted?.resolution).toBe('canceled');

    await db.transaction((tx) => resolveDunningOnInvoicePaid(tx, { invoiceId: invoiceRow.id, now: new Date() }));
    const afterPaid = await getDunningState(subRow.id);
    expect(afterPaid?.resolution).toBe('canceled');
    expect(afterPaid?.resolvedAt?.getTime()).toBe(afterDeleted?.resolvedAt?.getTime());
  });

  it('lands on exactly one clean resolution, never a corrupted mixed state, when both race genuinely concurrently', async () => {
    const { subRow, invoiceRow } = await seedOpenCycleWithInvoice();

    await Promise.all([
      db.transaction((tx) => resolveDunningOnInvoicePaid(tx, { invoiceId: invoiceRow.id, now: new Date() })),
      db.transaction((tx) => closeDunningOnSubscriptionDeleted(tx, { subscriptionId: subRow.id, now: new Date() })),
    ]);

    const state = await getDunningState(subRow.id);
    expect(state?.resolvedAt).not.toBeNull();
    expect(['recovered', 'canceled']).toContain(state?.resolution);
    // A corrupted mixed state would show up as stage/resolution disagreeing
    // with resolvedAt's presence - 'canceled' always sets stage 4,
    // 'recovered' always sets stage 0.
    expect(state?.stage).toBe(state?.resolution === 'canceled' ? 4 : 0);
  });
});

describe('an invoice claimed before its subscription row exists is re-linked once the subscription arrives, and replayed through the dunning gate (finding #21, deep bug hunt)', () => {
  it('links the orphaned failed invoice and opens a dunning cycle once customer.subscription.created is processed', async () => {
    const customer = fakeCustomer();
    const [customerRow] = await db
      .insert(customers)
      .values({ stripeCustomerId: customer.id, email: customer.email })
      .returning({ id: customers.id });
    cleanupCustomerIds.push(customerRow!.id);

    // The subscription's local row does NOT exist yet - simulates
    // processor.ts claiming this invoice.payment_failed event before the
    // customer.subscription.created event for the same subscription
    // (ordering is by receivedAt, not Stripe's event.created).
    const stripeSubscriptionId = 'sub_orphan_test';
    const failedInvoice = subscriptionLinkedInvoice(stripeSubscriptionId, customer.id, {
      status: 'open',
      attempt_count: 1,
    });
    mockInvoicesRetrieve.mockResolvedValueOnce(failedInvoice);
    await handleInvoiceEvent(fakeEvent('invoice.payment_failed', failedInvoice) as never);

    const [orphanedRow] = await db.select().from(invoices).where(eq(invoices.stripeInvoiceId, failedInvoice.id));
    cleanupInvoiceIds.push(orphanedRow!.id);
    expect(orphanedRow?.subscriptionId).toBeNull();
    // The raw Stripe id is stored even though the local link isn't
    // resolvable yet - this is what makes re-linking possible at all.
    expect(orphanedRow?.stripeSubscriptionId).toBe(stripeSubscriptionId);

    // No dunning cycle yet - there's no local subscription to attach one to.
    const beforeLink = await db
      .select()
      .from(dunningState)
      .where(eq(dunningState.triggeringInvoiceId, orphanedRow!.id));
    expect(beforeLink).toHaveLength(0);

    // Now the subscription's own creation event is processed.
    const subscription = fakeSubscription({ id: stripeSubscriptionId, customer: customer.id });
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription);
    const createdEvent = fakeEvent('customer.subscription.created', subscription);
    cleanupWebhookEventIds.push(createdEvent.id);
    await db.insert(webhookEvents).values({
      stripeEventId: createdEvent.id,
      type: createdEvent.type,
      apiVersion: createdEvent.api_version,
      eventCreatedAt: new Date(createdEvent.created * 1000),
      payload: createdEvent,
      status: 'received',
    });
    await handleSubscriptionEvent(createdEvent as never);

    const [subRow] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));
    expect(subRow).toBeDefined();
    cleanupSubscriptionIds.push(subRow!.id);

    // The orphaned invoice is now linked...
    const [relinkedRow] = await db.select().from(invoices).where(eq(invoices.id, orphanedRow!.id));
    expect(relinkedRow?.subscriptionId).toBe(subRow!.id);

    // ...and replayed through the dunning gate as if invoice.payment_failed
    // had been processed in order - a real cycle is open, keyed to this
    // exact invoice.
    const state = await getDunningState(subRow!.id);
    expect(state?.stage).toBe(1);
    expect(state?.resolvedAt).toBeNull();
    expect(state?.triggeringInvoiceId).toBe(orphanedRow!.id);
  });

  it('does not open a cycle for an orphaned invoice that is merely open with no failed attempts yet', async () => {
    const customer = fakeCustomer();
    const [customerRow] = await db
      .insert(customers)
      .values({ stripeCustomerId: customer.id, email: customer.email })
      .returning({ id: customers.id });
    cleanupCustomerIds.push(customerRow!.id);

    const stripeSubscriptionId = 'sub_orphan_no_attempts';
    // status 'open' but attempt_count 0 - freshly finalized, not yet
    // attempted, and therefore not a failure - opening a cycle for this
    // would be a false trigger with no actual payment problem behind it.
    const freshInvoice = subscriptionLinkedInvoice(stripeSubscriptionId, customer.id, {
      status: 'open',
      attempt_count: 0,
    });
    mockInvoicesRetrieve.mockResolvedValueOnce(freshInvoice);
    await handleInvoiceEvent(fakeEvent('invoice.created', freshInvoice) as never);
    const [orphanedRow] = await db.select().from(invoices).where(eq(invoices.stripeInvoiceId, freshInvoice.id));
    cleanupInvoiceIds.push(orphanedRow!.id);

    const subscription = fakeSubscription({ id: stripeSubscriptionId, customer: customer.id });
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription);
    const createdEvent = fakeEvent('customer.subscription.created', subscription);
    cleanupWebhookEventIds.push(createdEvent.id);
    await db.insert(webhookEvents).values({
      stripeEventId: createdEvent.id,
      type: createdEvent.type,
      apiVersion: createdEvent.api_version,
      eventCreatedAt: new Date(createdEvent.created * 1000),
      payload: createdEvent,
      status: 'received',
    });
    await handleSubscriptionEvent(createdEvent as never);

    const [subRow] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));
    cleanupSubscriptionIds.push(subRow!.id);

    const [relinkedRow] = await db.select().from(invoices).where(eq(invoices.id, orphanedRow!.id));
    expect(relinkedRow?.subscriptionId).toBe(subRow!.id);

    const state = await getDunningState(subRow!.id);
    expect(state).toBeUndefined();
  });
});

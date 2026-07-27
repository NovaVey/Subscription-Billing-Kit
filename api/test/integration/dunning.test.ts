import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoicesRetrieve = vi.fn();
const mockEmailSend = vi.fn();

vi.mock('../../src/stripe/client.js', () => ({
  stripe: {
    invoices: { retrieve: (...args: unknown[]) => mockInvoicesRetrieve(...args) },
  },
}));

vi.mock('../../src/billing/emailAdapter.js', () => ({
  emailAdapter: { send: (...args: unknown[]) => mockEmailSend(...args) },
}));

const { db, pool } = await import('../../src/db/client.js');
const { customers, dunningNotices, dunningState, invoices, subscriptions } = await import(
  '../../src/db/schema.js'
);
const { handleInvoiceEvent } = await import('../../src/webhooks/handlers/invoice.js');
const { runDunningTick } = await import('../../src/billing/dunning.js');
const { fakeCustomer, fakeEvent, fakeInvoice, fakeSubscription } = await import('./helpers/stripeFixtures.js');

const cleanupSubscriptionIds: string[] = [];
const cleanupCustomerIds: string[] = [];
const cleanupInvoiceIds: string[] = [];

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
  mockEmailSend.mockReset();
  mockEmailSend.mockResolvedValue(undefined);
});

afterAll(async () => {
  // dunning_notices/dunning_state reference subscriptions/invoices, so they
  // must be cleaned up before either of those (same FK ordering discipline
  // as every other integration suite's afterAll - see subscriptionProjection.test.ts).
  for (const id of cleanupSubscriptionIds) {
    await db.delete(dunningNotices).where(eq(dunningNotices.subscriptionId, id));
    await db.delete(dunningState).where(eq(dunningState.subscriptionId, id));
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

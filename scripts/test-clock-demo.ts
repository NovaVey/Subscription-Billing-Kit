// Unattended demo of the full arc §5.12 promises: trial -> renewal ->
// failed payment -> dunning stage 3 -> recovery, in seconds rather than
// real weeks. This is what a demo video would be a screen recording of.
//
// Two different "clocks" are compressed here, for two different reasons:
//   - Stripe's own test clock (scripts/test-clock.ts) compresses the
//     BILLING side - trial ending, a renewal invoice being generated,
//     finalized, and attempted - which genuinely happens on Stripe's
//     servers and cannot be faked locally.
//   - The DUNNING side (stage 1 -> 2 -> 3) is timed against this
//     project's OWN database, using entered_stage_at (set from the real,
//     re-fetched invoice.payment_failed event's timestamp - see
//     webhooks/handlers/invoice.ts) compared against runDunningTick()'s
//     own `now` parameter. Production's real cron calls
//     `runDunningTick()` with its default (real wall-clock `now`); this
//     script calls the exact same function with an explicit, advancing
//     `now` instead - not a different code path, just a supplied clock,
//     for exactly the same reason Stripe's test clocks exist: waiting
//     3, 7, and 14 real days for a demo would defeat the point.
//
// Every webhook a real deployment would receive is instead delivered here
// as a minimal, correctly-shaped event envelope fed directly into the same
// handler functions the real receiver dispatches to. This works because
// every handler re-fetches current truth from the Stripe API by id rather
// than trusting the payload (§5.6) - the envelope only needs to name which
// object changed, not describe its state. Nothing about the handlers
// themselves is different from a production run.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { stripe } from '../api/src/stripe/client.js';
import { pool, db } from '../api/src/db/client.js';
import {
  customers,
  dunningNotices,
  dunningState,
  invoices,
  subscriptionEvents,
  subscriptionItems,
  subscriptions,
  webhookEvents,
} from '../api/src/db/schema.js';
import { handleCustomerEvent } from '../api/src/webhooks/handlers/customer.js';
import { handleSubscriptionEvent } from '../api/src/webhooks/handlers/subscription.js';
import { handleInvoiceEvent } from '../api/src/webhooks/handlers/invoice.js';
import { runDunningTick } from '../api/src/billing/dunning.js';
import { createTestClock, advanceTestClock, teardownTestClock } from './test-clock.js';

const DAY_SECONDS = 24 * 60 * 60;

let eventCounter = 0;
function nextEventId(): string {
  eventCounter += 1;
  return `evt_demo_${eventCounter}_${Date.now()}`;
}

// subscription_events.stripe_event_id carries a real foreign key to
// webhook_events.stripe_event_id (§4) - a real receiver always inserts the
// ledger row first (§5.3), so any handler that ever records a transition
// with a stripeEventId assumes that row already exists. This helper does
// the same thing a real webhook delivery does before dispatching to a
// handler: land the ledger row, then call the handler - not just to avoid
// the FK violation, but because that ordering is the actual thing under
// test in the rest of this codebase's suite, and the demo should exercise
// it too, not bypass it.
async function deliverEvent<T>(
  handler: (event: never) => Promise<T>,
  type: string,
  objectId: string,
  createdSeconds: number,
): Promise<T> {
  const id = nextEventId();
  const event = {
    id,
    object: 'event',
    api_version: '2026-06-24.dahlia',
    created: createdSeconds,
    type,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: { id: objectId } },
  };
  await db.insert(webhookEvents).values({
    stripeEventId: id,
    type,
    apiVersion: '2026-06-24.dahlia',
    eventCreatedAt: new Date(createdSeconds * 1000),
    payload: event,
    status: 'received',
  });
  return handler(event as never);
}

async function loadStarterMonthlyPriceId(): Promise<string> {
  const catalogPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const priceId = catalog?.plans?.starter?.prices?.month?.priceId;
  if (!priceId) {
    throw new Error(`no starter monthly price in ${catalogPath} - run "npm run seed:catalog" first`);
  }
  return priceId;
}

async function main() {
  console.log('[demo] loading catalog...');
  const priceId = await loadStarterMonthlyPriceId();

  console.log('[demo] creating test clock...');
  const clock = await createTestClock(new Date(), 'test-clock-demo');
  console.log(`[demo] test clock ${clock.id} frozen at ${clock.frozenTime.toISOString()}`);

  let localSubscriptionId: string | null = null;
  let localCustomerId: string | null = null;

  try {
    console.log('[demo] creating customer + payment method (pm_card_visa)...');
    const stripeCustomer = await stripe.customers.create({
      email: `demo-${Date.now()}@example.com`,
      name: 'Test Clock Demo',
      test_clock: clock.id,
    });
    const goodPaymentMethod = await stripe.paymentMethods.attach('pm_card_visa', {
      customer: stripeCustomer.id,
    });
    await stripe.customers.update(stripeCustomer.id, {
      invoice_settings: { default_payment_method: goodPaymentMethod.id },
    });
    await deliverEvent(
      handleCustomerEvent,
      'customer.created',
      stripeCustomer.id,
      Math.floor(Date.now() / 1000),
    );
    const [customerRow] = await db
      .select()
      .from(customers)
      .where(eq(customers.stripeCustomerId, stripeCustomer.id));
    localCustomerId = customerRow?.id ?? null;
    console.log(`[demo] customer ${stripeCustomer.id} created and synced locally`);

    console.log('[demo] creating subscription with a 1-day trial...');
    const nowSeconds = Math.floor(Date.now() / 1000);
    const trialEndSeconds = nowSeconds + DAY_SECONDS;
    const stripeSubscription = await stripe.subscriptions.create({
      customer: stripeCustomer.id,
      items: [{ price: priceId }],
      trial_end: trialEndSeconds,
    });
    await deliverEvent(
      handleSubscriptionEvent,
      'customer.subscription.created',
      stripeSubscription.id,
      nowSeconds,
    );
    // Captured immediately, not after the payment-failure section below -
    // if anything later throws (a real risk given test-clock timing), the
    // finally block below still needs these ids to clean up whatever was
    // already created.
    const [subRowAfterCreate] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, stripeSubscription.id));
    if (!subRowAfterCreate) throw new Error('subscription was not projected locally');
    localSubscriptionId = subRowAfterCreate.id;
    console.log(`[demo] subscription ${stripeSubscription.id} created and synced locally (trialing)`);

    console.log('[demo] advancing past trial end - Stripe renews and charges the good payment method...');
    const afterTrial = await advanceTestClock(clock.id, new Date((trialEndSeconds + 2 * 60 * 60) * 1000));
    const activeSubscription = await stripe.subscriptions.retrieve(stripeSubscription.id);
    const afterTrialSeconds = Math.floor(afterTrial.frozenTime.getTime() / 1000);
    await deliverEvent(handleSubscriptionEvent, 'customer.subscription.updated', stripeSubscription.id, afterTrialSeconds);
    const [paidInvoice] = (
      await stripe.invoices.list({ subscription: stripeSubscription.id, status: 'paid', limit: 1 })
    ).data;
    if (paidInvoice) {
      await deliverEvent(handleInvoiceEvent, 'invoice.paid', paidInvoice.id, afterTrialSeconds);
      console.log(`[demo] renewal invoice ${paidInvoice.id} paid - subscription is active (${activeSubscription.status})`);
    } else {
      console.log(`[demo] no paid invoice found yet - subscription status is ${activeSubscription.status}`);
    }

    console.log('[demo] swapping to pm_card_chargeCustomerFail...');
    const failingPaymentMethod = await stripe.paymentMethods.attach('pm_card_chargeCustomerFail', {
      customer: stripeCustomer.id,
    });
    await stripe.customers.update(stripeCustomer.id, {
      invoice_settings: { default_payment_method: failingPaymentMethod.id },
    });

    console.log('[demo] advancing past the next period end - the renewal attempt fails...');
    const currentPeriodEndSeconds = Math.floor(
      new Date((await stripe.subscriptions.retrieve(stripeSubscription.id)).items.data[0]!.current_period_end * 1000).getTime() / 1000,
    );
    // Renewal invoices sit in a ~1 hour draft window before Stripe
    // auto-finalizes and attempts them (confirmed against Stripe's docs
    // during Phase 5's live verification, not assumed) - advancing only a
    // few minutes past period end would leave the invoice stuck in draft.
    const afterFailure = await advanceTestClock(
      clock.id,
      new Date((currentPeriodEndSeconds + 2 * 60 * 60) * 1000),
    );
    const [failedInvoice] = (
      await stripe.invoices.list({ subscription: stripeSubscription.id, status: 'open', limit: 1 })
    ).data;
    if (!failedInvoice) {
      throw new Error('expected an open (failed) renewal invoice after advancing past period end');
    }
    const failureEventCreated = Math.floor(afterFailure.frozenTime.getTime() / 1000);
    await deliverEvent(handleInvoiceEvent, 'invoice.payment_failed', failedInvoice.id, failureEventCreated);
    await deliverEvent(handleSubscriptionEvent, 'customer.subscription.updated', stripeSubscription.id, failureEventCreated);
    console.log(`[demo] invoice ${failedInvoice.id} failed - dunning cycle opened`);

    async function printStage(label: string) {
      const [row] = await db.select().from(dunningState).where(eq(dunningState.subscriptionId, localSubscriptionId!));
      console.log(`[demo] ${label}: stage=${row?.stage ?? 0} noticesSent=${row?.noticesSent ?? 0}`);
    }
    await printStage('after payment_failed');

    // Escalate stage 1 -> 2 -> 3 by calling runDunningTick() with an
    // advancing `now`, exactly the function a real cron invokes - just fed
    // a simulated clock instead of waiting 3, then 7, real days.
    const failureDate = new Date(failureEventCreated * 1000);
    await runDunningTick(new Date(failureDate.getTime() + 3 * DAY_SECONDS * 1000 + 60 * 60 * 1000));
    await printStage('3 days later (tick)');
    await runDunningTick(new Date(failureDate.getTime() + (3 + 7) * DAY_SECONDS * 1000 + 60 * 60 * 1000));
    await printStage('10 days later (tick)');

    console.log('[demo] recovering - swapping back to pm_card_visa and paying the failed invoice...');
    await stripe.customers.update(stripeCustomer.id, {
      invoice_settings: { default_payment_method: goodPaymentMethod.id },
    });
    const paidRecoveryInvoice = await stripe.invoices.pay(failedInvoice.id);
    // Must be later than the last tick's simulated `now` above (real
    // wall-clock Date.now() would actually be OLDER than that simulated
    // instant, since the failure itself happened on the test clock's
    // future timeline - using it here would make the staleness guard
    // (§5.7) correctly, but unhelpfully, skip this event as stale).
    const recoveryEventCreated = Math.floor(
      (failureDate.getTime() + (3 + 7) * DAY_SECONDS * 1000 + 2 * 60 * 60 * 1000) / 1000,
    );
    await deliverEvent(handleInvoiceEvent, 'invoice.paid', paidRecoveryInvoice.id, recoveryEventCreated);
    await printStage('after recovery');

    console.log('[demo] full arc complete: trial -> renewal -> failed payment -> dunning stage 3 -> recovery');
  } finally {
    console.log(`[demo] tearing down test clock ${clock.id} (cascades customer/subscription/invoices on Stripe)...`);
    await teardownTestClock(clock.id);

    // This system deliberately never mirrors Stripe-side deletion locally
    // (same as customer.deleted - see docs/ARCHITECTURE.md), so the rows
    // this run created are cleaned up explicitly, by the ids captured
    // above, rather than left behind for every repeat run to accumulate
    // demo debris (and rather than guessing which row was ours - every
    // Stripe subscription id starts with "sub_", so that's not a filter).
    // dunning_notices references subscriptions and must be cleared first,
    // same FK ordering discipline as every integration suite's afterAll.
    if (localSubscriptionId) {
      await db.delete(dunningNotices).where(eq(dunningNotices.subscriptionId, localSubscriptionId));
      await db.delete(subscriptionEvents).where(eq(subscriptionEvents.subscriptionId, localSubscriptionId));
      await db.delete(dunningState).where(eq(dunningState.subscriptionId, localSubscriptionId));
      await db.delete(invoices).where(eq(invoices.subscriptionId, localSubscriptionId));
      await db.delete(subscriptionItems).where(eq(subscriptionItems.subscriptionId, localSubscriptionId));
      await db.delete(subscriptions).where(eq(subscriptions.id, localSubscriptionId));
    }
    if (localCustomerId) {
      await db.delete(customers).where(eq(customers.id, localCustomerId));
    }
    console.log('[demo] local rows cleaned up');
  }
}

main()
  .catch((err) => {
    console.error('[demo] failed', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

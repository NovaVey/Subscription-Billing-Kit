import { and, eq, isNull, notInArray } from 'drizzle-orm';
import type Stripe from 'stripe';
import { stripe } from '../../stripe/client.js';
import { db, type Executor } from '../../db/client.js';
import { customers, subscriptionItems, subscriptions } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { fromStripeSeconds, fromStripeSecondsOrNull } from '../../lib/time.js';
import { recordTransition, type SubscriptionStatus } from '../../billing/stateMachine.js';
import type { HandlerResult } from './customer.js';

function resolveId(ref: string | { id: string }): string {
  return typeof ref === 'string' ? ref : ref.id;
}

// Projects a re-fetched Stripe subscription (with its items) into
// subscriptions + subscription_items. Periods live on the items (§5.1) -
// subscriptions.next_period_end_derived is computed here as the minimum
// item period end and is never read back off the Stripe object directly.
async function projectSubscription(
  tx: Executor,
  subscription: Stripe.Subscription,
  localCustomerId: string,
  existingId: string | undefined,
  eventCreatedAt: Date,
): Promise<string> {
  const items = subscription.items.data;
  const firstPrice = items[0]?.price;
  const planCode = (firstPrice?.metadata['plan_code'] as string | undefined) ?? firstPrice?.id ?? 'unknown';
  const currency = firstPrice?.currency ?? subscription.currency;
  const periodEnds = items.map((item) => fromStripeSeconds(item.current_period_end).getTime());
  const nextPeriodEndDerived = periodEnds.length > 0 ? new Date(Math.min(...periodEnds)) : null;

  const row = {
    customerId: localCustomerId,
    stripeSubscriptionId: subscription.id,
    status: subscription.status,
    planCode,
    currency,
    trialEnd: fromStripeSecondsOrNull(subscription.trial_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    canceledAt: fromStripeSecondsOrNull(subscription.canceled_at),
    nextPeriodEndDerived,
    lastEventAt: eventCreatedAt,
    updatedAt: new Date(),
  };

  let localId: string;
  if (existingId) {
    await tx.update(subscriptions).set(row).where(eq(subscriptions.id, existingId));
    localId = existingId;
  } else {
    const [inserted] = await tx
      .insert(subscriptions)
      .values({ ...row, createdAt: new Date() })
      .returning({ id: subscriptions.id });
    localId = inserted!.id;
  }

  const currentStripeItemIds = items.map((item) => item.id);

  for (const item of items) {
    await tx
      .insert(subscriptionItems)
      .values({
        subscriptionId: localId,
        stripeItemId: item.id,
        priceId: item.price.id,
        quantity: item.quantity ?? 1,
        unitAmountMinor: item.price.unit_amount ?? 0,
        currency: item.price.currency,
        recurringInterval: item.price.recurring?.interval ?? null,
        currentPeriodStart: fromStripeSeconds(item.current_period_start),
        currentPeriodEnd: fromStripeSeconds(item.current_period_end),
      })
      .onConflictDoUpdate({
        target: subscriptionItems.stripeItemId,
        set: {
          priceId: item.price.id,
          quantity: item.quantity ?? 1,
          unitAmountMinor: item.price.unit_amount ?? 0,
          currency: item.price.currency,
          recurringInterval: item.price.recurring?.interval ?? null,
          currentPeriodStart: fromStripeSeconds(item.current_period_start),
          currentPeriodEnd: fromStripeSeconds(item.current_period_end),
          removedAt: null,
        },
      });
  }

  // Items that existed locally but aren't in Stripe's current item list
  // anymore (a plan change removed one) are marked removed, never deleted -
  // this is billing history.
  if (currentStripeItemIds.length > 0) {
    await tx
      .update(subscriptionItems)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(subscriptionItems.subscriptionId, localId),
          notInArray(subscriptionItems.stripeItemId, currentStripeItemIds),
          isNull(subscriptionItems.removedAt),
        ),
      );
  }

  return localId;
}

export async function handleSubscriptionEvent(event: Stripe.Event): Promise<HandlerResult> {
  const stripeSubscriptionId = (event.data.object as { id: string }).id;
  const eventCreatedAt = fromStripeSeconds(event.created);

  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));

  // Staleness guard (§5.7): an event older than the newest one already
  // applied to this row is skipped outright - not because a re-fetch would
  // return wrong data (it always returns current truth), but because
  // applying an out-of-order event's semantics (e.g. treating a "created"
  // event as the first sighting of a subscription that a later event has
  // already moved past) would write a subscription_events row that reads
  // as nonsense on the timeline and could re-trigger logic tied to that
  // event type. Combined with re-fetching, ordering stops mattering.
  if (existing?.lastEventAt && existing.lastEventAt.getTime() > eventCreatedAt.getTime()) {
    const reason = `stale: event.created (${eventCreatedAt.toISOString()}) is older than last_event_at (${existing.lastEventAt.toISOString()})`;
    logger.info({ stripeSubscriptionId, eventType: event.type, reason }, 'skipping stale subscription event');
    return { skipped: true, skipReason: reason };
  }

  // Re-fetch from the Stripe API rather than trust the payload (§5.6).
  const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId, {
    expand: ['items.data.price'],
  });

  const stripeCustomerId = resolveId(subscription.customer);
  const [customerRow] = await db
    .select()
    .from(customers)
    .where(eq(customers.stripeCustomerId, stripeCustomerId));
  if (!customerRow) {
    throw new Error(
      `no local customer for Stripe customer ${stripeCustomerId} — customer.* events must be processed first`,
    );
  }

  const fromStatus = (existing?.status as SubscriptionStatus | undefined) ?? null;
  const toStatus = subscription.status as SubscriptionStatus;

  await db.transaction(async (tx) => {
    const localId = await projectSubscription(
      tx,
      subscription,
      customerRow.id,
      existing?.id,
      eventCreatedAt,
    );

    if (fromStatus !== toStatus) {
      await recordTransition(tx, {
        subscriptionId: localId,
        fromStatus,
        toStatus,
        reason: event.type,
        stripeEventId: event.id,
      });
    }
  });

  return {};
}

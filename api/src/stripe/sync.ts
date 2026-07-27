import { and, eq, isNull, notInArray } from 'drizzle-orm';
import type Stripe from 'stripe';
import { db, type Executor } from '../db/client.js';
import { customers, subscriptionItems, subscriptions } from '../db/schema.js';
import { fromStripeSeconds, fromStripeSecondsOrNull } from '../lib/time.js';
import { recordTransition, type SubscriptionStatus } from '../billing/stateMachine.js';

// Shared projection logic used by both the webhook handlers (Phase 3) and
// the admin/checkout routes (Phase 4) - a plan change made through the API
// re-fetches or receives the updated subscription from Stripe directly and
// syncs it locally through the exact same path a webhook would, so the
// caller sees up-to-date state immediately instead of waiting for the next
// processor tick.

export function resolveStripeId(ref: string | { id: string }): string {
  return typeof ref === 'string' ? ref : ref.id;
}

export async function syncCustomerFromStripe(customer: Stripe.Customer): Promise<{ id: string }> {
  const externalRef = typeof customer.metadata?.['external_ref'] === 'string'
    ? customer.metadata['external_ref']
    : undefined;

  const [row] = await db
    .insert(customers)
    .values({
      stripeCustomerId: customer.id,
      email: customer.email ?? '',
      name: customer.name ?? null,
      delinquent: customer.delinquent ?? false,
      ...(externalRef !== undefined ? { externalRef } : {}),
    })
    .onConflictDoUpdate({
      target: customers.stripeCustomerId,
      set: {
        email: customer.email ?? '',
        name: customer.name ?? null,
        delinquent: customer.delinquent ?? false,
        updatedAt: new Date(),
        // Only touch external_ref when Stripe metadata actually carries one
        // - never overwrite an existing value with a blank on a bare re-sync.
        ...(externalRef !== undefined ? { externalRef } : {}),
      },
    })
    .returning({ id: customers.id });

  return { id: row!.id };
}

// Periods live on the items (§5.1) - subscriptions.next_period_end_derived
// is computed here as the minimum item period end and is never read back
// off the Stripe object directly.
async function projectSubscription(
  tx: Executor,
  subscription: Stripe.Subscription,
  localCustomerId: string,
  existingId: string | undefined,
  lastEventAt: Date,
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
    lastEventAt,
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

export interface SyncSubscriptionOptions {
  reason: string; // webhook event type, or 'manual:<actor>' for admin actions
  actor?: string | null;
  note?: string | null;
  stripeEventId?: string | null;
  lastEventAt: Date;
  // Manual admin actions (cancel/resume/plan-change) must never bypass the
  // audit trail (§5.8), even when the action doesn't change `status` - a
  // plan change is exactly this case. Webhook-driven syncs leave this
  // unset, so a routine re-sync that doesn't change status doesn't spam
  // the timeline with no-op rows.
  forceRecord?: boolean;
}

export interface SyncSubscriptionResult {
  id: string;
  fromStatus: SubscriptionStatus | null;
  toStatus: SubscriptionStatus;
}

export async function syncSubscriptionFromStripe(
  subscription: Stripe.Subscription,
  options: SyncSubscriptionOptions,
): Promise<SyncSubscriptionResult> {
  const stripeCustomerId = resolveStripeId(subscription.customer);
  const [customerRow] = await db
    .select()
    .from(customers)
    .where(eq(customers.stripeCustomerId, stripeCustomerId));
  if (!customerRow) {
    throw new Error(
      `no local customer for Stripe customer ${stripeCustomerId} — customer.* events must be processed first`,
    );
  }

  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, subscription.id));

  const fromStatus = (existing?.status as SubscriptionStatus | undefined) ?? null;
  const toStatus = subscription.status as SubscriptionStatus;

  const localId = await db.transaction(async (tx) => {
    const id = await projectSubscription(
      tx,
      subscription,
      customerRow.id,
      existing?.id,
      options.lastEventAt,
    );

    if (fromStatus !== toStatus || options.forceRecord) {
      await recordTransition(tx, {
        subscriptionId: id,
        fromStatus,
        toStatus,
        reason: options.reason,
        actor: options.actor ?? null,
        note: options.note ?? null,
        stripeEventId: options.stripeEventId ?? null,
      });
    }

    return id;
  });

  return { id: localId, fromStatus, toStatus };
}

import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import { stripe } from './client.js';
import { db, type Executor } from '../db/client.js';
import { customers, invoices, subscriptionItems, subscriptions } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { fromStripeSeconds, fromStripeSecondsOrNull } from '../lib/time.js';
import { recordTransition, type SubscriptionStatus } from '../billing/stateMachine.js';
import { openDunningCycleOnPaymentFailed, resolveDunningOnInvoicePaid } from '../billing/dunning.js';

// unit_amount_minor is NOT NULL, so tiered/graduated/package pricing
// (billing_scheme other than 'per_unit', which only sets `tiers`, not
// `unit_amount`) can't just store null - but silently storing 0 (the
// previous behavior) is worse: it looks like a real, free-tier price
// rather than "this item's amount genuinely isn't representable as one
// flat number", and every downstream reader (MRR, revenue reporting) that
// doesn't know to check for it silently undercounts with no signal
// anywhere that data was lost. -1 can never be a real minor amount, so
// it's unambiguous as a sentinel; every reader of unit_amount_minor that
// cares about correctness (currently just computeMrrMinor) must check for
// it explicitly rather than summing it in. See the deep bug hunt.
export const TIERED_PRICING_SENTINEL_MINOR = -1;

// Shared projection logic used by both the webhook handlers (Phase 3) and
// the admin/checkout routes (Phase 4) - a plan change made through the API
// re-fetches or receives the updated subscription from Stripe directly and
// syncs it locally through the exact same path a webhook would, so the
// caller sees up-to-date state immediately instead of waiting for the next
// processor tick.

export function resolveStripeId(ref: string | { id: string }): string {
  return typeof ref === 'string' ? ref : ref.id;
}

// A Subscription's own `items` field (as returned by subscriptions.retrieve
// or delivered on a webhook payload) is capped at Stripe's default list
// page size (10), with no `limit` param on SubscriptionRetrieveParams to
// ask for more (verified against the installed SDK's own types, not
// assumed - §0 rule 9) - a subscription with 11+ items would otherwise
// silently look 10-items-large to every reader of `subscription.items.data`.
// subscriptionItems.list is a real, separately-paginated endpoint; auto-
// paginating it here (the SDK's `for await` iterates every page
// transparently) gets the complete, current item list regardless of count.
// `expand: ['data.price']` matches what retrieve's own `expand:
// ['items.data.price']` already gave every existing caller - projectSubscription
// reads price.currency/unit_amount/recurring/metadata directly off each
// item. See the deep bug hunt.
async function listAllSubscriptionItems(stripeSubscriptionId: string): Promise<Stripe.SubscriptionItem[]> {
  const items: Stripe.SubscriptionItem[] = [];
  for await (const item of stripe.subscriptionItems.list({
    subscription: stripeSubscriptionId,
    limit: 100,
    expand: ['data.price'],
  })) {
    items.push(item);
  }
  return items;
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
//
// `items` is the caller's own fully-paginated list (see
// listAllSubscriptionItems below), not `subscription.items.data` - a
// Subscription's own retrieve() response caps that nested list at
// Stripe's default page size (10) with no way to request more, so a
// subscription with 11+ items would otherwise silently look like it only
// has the first 10 to every reader here, including the removal-detection
// step below. See the deep bug hunt.
async function projectSubscription(
  tx: Executor,
  subscription: Stripe.Subscription,
  items: readonly Stripe.SubscriptionItem[],
  localCustomerId: string,
  existingId: string | undefined,
  lastEventAt: Date,
): Promise<string> {
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

  // A single multi-row upsert instead of one insert-on-conflict round trip
  // per item - this runs on every subscription webhook and every admin
  // plan-change/cancel/resume resync, so an N-item subscription previously
  // paid N sequential DB round trips here. `excluded.<col>` in the SET
  // clause refers to each conflicting row's own incoming values (standard
  // Postgres upsert), not a single shared literal. See the /improve audit.
  if (items.length > 0) {
    for (const item of items) {
      if (item.price.unit_amount === null) {
        logger.warn(
          { subscriptionId: localId, stripeItemId: item.id, priceId: item.price.id, billingScheme: item.price.billing_scheme },
          'subscription item has no flat unit_amount (tiered/graduated/package pricing) - storing the sentinel, MRR for this item is excluded rather than reported as 0',
        );
      }
    }
    await tx
      .insert(subscriptionItems)
      .values(
        items.map((item) => ({
          subscriptionId: localId,
          stripeItemId: item.id,
          priceId: item.price.id,
          quantity: item.quantity ?? 1,
          unitAmountMinor: item.price.unit_amount ?? TIERED_PRICING_SENTINEL_MINOR,
          currency: item.price.currency,
          recurringInterval: item.price.recurring?.interval ?? null,
          currentPeriodStart: fromStripeSeconds(item.current_period_start),
          currentPeriodEnd: fromStripeSeconds(item.current_period_end),
        })),
      )
      .onConflictDoUpdate({
        target: subscriptionItems.stripeItemId,
        set: {
          priceId: sql`excluded.price_id`,
          quantity: sql`excluded.quantity`,
          unitAmountMinor: sql`excluded.unit_amount_minor`,
          currency: sql`excluded.currency`,
          recurringInterval: sql`excluded.recurring_interval`,
          currentPeriodStart: sql`excluded.current_period_start`,
          currentPeriodEnd: sql`excluded.current_period_end`,
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

// An invoice.* event claimed before its subscription's own
// customer.subscription.created has been processed (processor.ts orders
// by receivedAt, not Stripe's event.created) previously stored
// subscriptionId=null with nothing ever re-linking it once the
// subscription's local row eventually appeared - permanently losing the
// link, and for a payment_failed invoice, the dunning trigger it should
// have opened. Called the moment a subscription's local row is first
// created (never on a routine update - only a first-time insert can have
// orphans waiting on it), this finds every local invoice referencing this
// Stripe subscription id with no local link yet, links them, and replays
// each one through the same dunning gate handleInvoiceEvent's own
// event-type dispatch would have applied, in chronological order (a paid
// invoice must resolve a cycle an earlier orphaned failed invoice in this
// same batch just opened, not the other way around). There's no original
// event *type* left to dispatch on this long after the fact, so the
// invoice's own current, already-authoritative fields stand in for it:
// status 'open' with attempt_count > 0 is Stripe's own signal that at
// least one charge attempt has failed (a freshly finalized 'open' invoice
// with no attempts yet is not a failure and must not open a cycle);
// status 'paid' mirrors invoice.paid. Any other status (draft, void,
// uncollectible) never touched dunning even in the real handler, so it's
// skipped here too. See the deep bug hunt.
async function relinkOrphanedInvoices(
  tx: Executor,
  stripeSubscriptionId: string,
  localSubscriptionId: string,
): Promise<void> {
  const orphaned = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.stripeSubscriptionId, stripeSubscriptionId), isNull(invoices.subscriptionId)))
    .orderBy(asc(invoices.lastEventAt));
  if (orphaned.length === 0) return;

  await tx
    .update(invoices)
    .set({ subscriptionId: localSubscriptionId })
    .where(
      inArray(
        invoices.id,
        orphaned.map((row) => row.id),
      ),
    );

  for (const invoiceRow of orphaned) {
    const now = invoiceRow.lastEventAt ?? new Date();
    if (invoiceRow.status === 'open' && invoiceRow.attemptCount > 0) {
      await openDunningCycleOnPaymentFailed(tx, {
        subscriptionId: localSubscriptionId,
        invoiceId: invoiceRow.id,
        now,
      });
    } else if (invoiceRow.status === 'paid') {
      await resolveDunningOnInvoicePaid(tx, { invoiceId: invoiceRow.id, now });
    }
  }

  logger.info(
    { stripeSubscriptionId, localSubscriptionId, relinkedCount: orphaned.length },
    're-linked invoices that arrived before their subscription row existed, and replayed them through the dunning gate',
  );
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

  // Fetched outside the transaction, same as the customer lookup above -
  // this is a Stripe API call, not a DB read, and there's no reason to
  // hold row locks open across the network round trip(s) it takes.
  const items = await listAllSubscriptionItems(subscription.id);

  return db.transaction(async (tx) => {
    // Re-read (and lock) the row inside this transaction, not from a
    // pre-transaction SELECT. Two concurrent syncs of the same
    // subscription - an admin's resyncAfterMutation() racing the webhook
    // worker after a cancel action, or two overlapping processor ticks -
    // must never both read the same stale fromStatus/lastEventAt and both
    // decide to write from it. FOR UPDATE serializes them: the second
    // transaction blocks here until the first commits, then sees the
    // first's own write when it re-selects. See the deep bug hunt.
    const [existing] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, subscription.id))
      .for('update');

    // Matches staleGuard.ts's exact semantics (skip only if strictly
    // newer) - re-applied here because the handler-level staleGuard's own
    // read is not atomic with this write, so a concurrent transaction can
    // still commit a newer lastEventAt in between.
    if (existing?.lastEventAt && existing.lastEventAt.getTime() > options.lastEventAt.getTime()) {
      const status = existing.status as SubscriptionStatus;
      return { id: existing.id, fromStatus: status, toStatus: status };
    }

    const fromStatus = (existing?.status as SubscriptionStatus | undefined) ?? null;
    const toStatus = subscription.status as SubscriptionStatus;

    const id = await projectSubscription(
      tx,
      subscription,
      items,
      customerRow.id,
      existing?.id,
      options.lastEventAt,
    );

    // Only on a first-time insert (existing was undefined) - only then can
    // there possibly be an invoice waiting on this subscription id that
    // arrived before this row did. A routine update has nothing to
    // re-link (every invoice this subscription will ever reference from
    // here on has this row available to link against immediately).
    if (!existing) {
      await relinkOrphanedInvoices(tx, subscription.id, id);
    }

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

    return { id, fromStatus, toStatus };
  });
}

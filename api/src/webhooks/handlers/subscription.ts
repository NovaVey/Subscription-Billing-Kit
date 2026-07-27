import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { stripe } from '../../stripe/client.js';
import { db } from '../../db/client.js';
import { subscriptions } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { fromStripeSeconds } from '../../lib/time.js';
import { syncSubscriptionFromStripe } from '../../stripe/sync.js';
import { closeDunningOnSubscriptionDeleted } from '../../billing/dunning.js';
import type { HandlerResult } from './customer.js';

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

  const result = await syncSubscriptionFromStripe(subscription, {
    reason: event.type,
    stripeEventId: event.id,
    lastEventAt: eventCreatedAt,
  });

  // A deleted subscription has nothing left to collect on - closes any
  // open dunning cycle as 'canceled' rather than leaving it open (§5.10).
  if (event.type === 'customer.subscription.deleted') {
    await closeDunningOnSubscriptionDeleted(db, { subscriptionId: result.id, now: eventCreatedAt });
  }

  return {};
}

import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { stripe } from '../../stripe/client.js';
import { db } from '../../db/client.js';
import { subscriptions } from '../../db/schema.js';
import { fromStripeSeconds } from '../../lib/time.js';
import { syncSubscriptionFromStripe } from '../../stripe/sync.js';
import { closeDunningOnSubscriptionDeleted } from '../../billing/dunning.js';
import type { HandlerResult } from './customer.js';
import { staleGuard } from './staleGuard.js';

export async function handleSubscriptionEvent(event: Stripe.Event): Promise<HandlerResult> {
  const stripeSubscriptionId = (event.data.object as { id: string }).id;
  const eventCreatedAt = fromStripeSeconds(event.created);

  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));

  const stale = staleGuard({
    entityLabel: 'subscription',
    logFields: { stripeSubscriptionId },
    eventType: event.type,
    lastEventAt: existing?.lastEventAt,
    eventCreatedAt,
  });
  if (stale) return stale;

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

import type Stripe from 'stripe';
import { db } from '../db/client.js';
import { webhookEvents } from '../db/schema.js';
import { fromStripeSeconds } from '../lib/time.js';

export interface RecordResult {
  // false means the row already existed (on-conflict-do-nothing fired) —
  // i.e. this is a replay of an event already in the ledger.
  inserted: boolean;
}

// Inbound idempotency lives here: stripe_event_id is the primary key, and
// the insert is on-conflict-do-nothing. Replaying the same event any number
// of times produces exactly one row. See docs/ARCHITECTURE.md.
export async function recordWebhookEvent(event: Stripe.Event): Promise<RecordResult> {
  const result = await db
    .insert(webhookEvents)
    .values({
      stripeEventId: event.id,
      type: event.type,
      apiVersion: event.api_version,
      eventCreatedAt: fromStripeSeconds(event.created),
      payload: event as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: webhookEvents.stripeEventId })
    .returning({ stripeEventId: webhookEvents.stripeEventId });

  return { inserted: result.length > 0 };
}

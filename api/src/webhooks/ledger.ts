import { eq } from 'drizzle-orm';
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

// Resets a webhook_events row to 'received' with a clean attempt budget, so
// the next processor tick claims and re-applies it - a manual "try this
// again" action, distinct from the automatic backoff/retry counter (§5.7).
// Shared by the admin replay route and scripts/replay-event.ts (previously
// duplicated in both). Returns false if no row exists for the given id -
// nothing was updated. See the /improve audit.
export async function resetWebhookEventForReplay(stripeEventId: string): Promise<boolean> {
  const [existing] = await db.select().from(webhookEvents).where(eq(webhookEvents.stripeEventId, stripeEventId));
  if (!existing) return false;

  await db
    .update(webhookEvents)
    .set({
      status: 'received',
      attempts: 0,
      nextAttemptAt: null,
      processingStartedAt: null,
      processedAt: null,
      lastError: null,
    })
    .where(eq(webhookEvents.stripeEventId, stripeEventId));

  return true;
}

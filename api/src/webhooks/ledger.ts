import { and, eq, ne } from 'drizzle-orm';
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

// 'reset' - the row existed and wasn't 'processing'; it's now 'received'.
// 'not_found' - no row exists for that id.
// 'processing' - the row exists but a handler is actively working it right
// now; replaying it here would race that live handler exactly like the
// reaper/finalize race processor.ts's claimGuard protects against - see the
// deep bug hunt. Refused rather than attempted.
export type ReplayResetResult = 'reset' | 'not_found' | 'processing';

// Resets a webhook_events row to 'received' with a clean attempt budget, so
// the next processor tick claims and re-applies it - a manual "try this
// again" action, distinct from the automatic backoff/retry counter (§5.7).
// Shared by the admin replay route and scripts/replay-event.ts (previously
// duplicated in both). See the /improve audit.
export async function resetWebhookEventForReplay(stripeEventId: string): Promise<ReplayResetResult> {
  const [updated] = await db
    .update(webhookEvents)
    .set({
      status: 'received',
      attempts: 0,
      nextAttemptAt: null,
      processingStartedAt: null,
      processedAt: null,
      lastError: null,
    })
    .where(and(eq(webhookEvents.stripeEventId, stripeEventId), ne(webhookEvents.status, 'processing')))
    .returning({ stripeEventId: webhookEvents.stripeEventId });

  if (updated) return 'reset';

  // The guarded UPDATE above didn't apply - either no row exists at all, or
  // it exists but is currently 'processing'. This second read only exists to
  // tell those two apart for a clearer caller-facing error; it isn't what
  // makes the reset itself race-safe (the guarded UPDATE already is).
  const [existing] = await db
    .select({ status: webhookEvents.status })
    .from(webhookEvents)
    .where(eq(webhookEvents.stripeEventId, stripeEventId));

  return existing ? 'processing' : 'not_found';
}

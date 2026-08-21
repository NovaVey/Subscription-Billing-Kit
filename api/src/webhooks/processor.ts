import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type Stripe from 'stripe';
import { db } from '../db/client.js';
import { webhookEvents } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { handleCustomerEvent, type HandlerResult } from './handlers/customer.js';
import { handleInvoiceEvent } from './handlers/invoice.js';
import { handlePaymentIntentEvent } from './handlers/paymentIntent.js';
import { handleSubscriptionEvent } from './handlers/subscription.js';

export const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 3600;

// Exponential backoff: 30s, 60s, 120s, 240s, 480s, 960s, then plateaus at
// 1920s (32 min) once the exponent clamp at attempts=7 kicks in - the
// MAX_BACKOFF_SECONDS=3600 cap below is unreachable through this formula
// (30 * 2^6 = 1920 < 3600) and is dead code as currently written. Neither
// matters in production today: MAX_ATTEMPTS=5 means processRow never calls
// this with attempts >= 6. Corrected by the /improve audit, which verified
// the actual sequence against the code rather than trusting this comment.
export function computeBackoffSeconds(attempts: number): number {
  const exponent = Math.min(attempts, 7) - 1;
  return Math.min(BASE_BACKOFF_SECONDS * 2 ** Math.max(exponent, 0), MAX_BACKOFF_SECONDS);
}

type WebhookEventRow = typeof webhookEvents.$inferSelect;

function dispatch(event: Stripe.Event): Promise<HandlerResult> {
  if (event.type.startsWith('customer.subscription.')) return handleSubscriptionEvent(event);
  if (event.type.startsWith('customer.')) return handleCustomerEvent(event);
  if (event.type.startsWith('invoice.')) return handleInvoiceEvent(event);
  if (event.type === 'payment_intent.payment_failed') return handlePaymentIntentEvent(event);
  // Not every Stripe event type has a handler here, and it doesn't need
  // one to be handled correctly - Stripe explicitly recommends gracefully
  // ignoring unfamiliar event types rather than treating them as failures.
  return Promise.resolve({});
}

// Claims a batch of `received` rows whose backoff has elapsed, using
// FOR UPDATE SKIP LOCKED so concurrent claimers never contend for the same
// row. The claim (SELECT candidate ids + status flip to 'processing') is a
// short transaction; the actual handler work happens outside it, after this
// function returns - holding a transaction open across a Stripe API call
// would hold row locks far longer than necessary.
//
// Returns the UPDATE's own `.returning()` rows, not the pre-update SELECT -
// processRow needs each row's freshly-set `processingStartedAt` as its exact
// lease token (see claimGuard below). Returning the pre-update read here
// used to hand processRow a stale timestamp from *before* this claim, which
// silently defeated that guard - see the deep bug hunt.
async function claimBatch(batchSize: number): Promise<WebhookEventRow[]> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ stripeEventId: webhookEvents.stripeEventId })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.status, 'received'),
          or(isNull(webhookEvents.nextAttemptAt), lte(webhookEvents.nextAttemptAt, new Date())),
        ),
      )
      .orderBy(webhookEvents.receivedAt)
      .limit(batchSize)
      .for('update', { skipLocked: true });

    if (candidates.length === 0) return [];

    const ids = candidates.map((row) => row.stripeEventId);
    return tx
      .update(webhookEvents)
      .set({ status: 'processing', processingStartedAt: new Date() })
      .where(inArray(webhookEvents.stripeEventId, ids))
      .returning();
  });
}

// A finalize write for `row` only takes effect if the row is still exactly
// the claim this invocation made: status='processing' AND the same
// processingStartedAt claimBatch just set. If the reaper reclaimed this row
// (lease expired) or an admin replayed it before this handler finished, the
// row's status/processingStartedAt has since moved on and this guard fails
// to match - the finalize write silently no-ops instead of clobbering
// whatever claimed the row next. See the deep bug hunt.
function claimGuard(row: WebhookEventRow) {
  return and(
    eq(webhookEvents.stripeEventId, row.stripeEventId),
    eq(webhookEvents.status, 'processing'),
    row.processingStartedAt
      ? eq(webhookEvents.processingStartedAt, row.processingStartedAt)
      : isNull(webhookEvents.processingStartedAt),
  );
}

function logIfDiscarded(applied: unknown[], row: WebhookEventRow, outcome: string): void {
  if (applied.length > 0) return;
  logger.warn(
    { stripeEventId: row.stripeEventId, type: row.type },
    `discarded a webhook event's ${outcome} - its lease had already moved on (reaped or replayed) before this write landed`,
  );
}

async function processRow(row: WebhookEventRow): Promise<void> {
  const event = row.payload as unknown as Stripe.Event;
  try {
    const result = await dispatch(event);
    const finalized = await db
      .update(webhookEvents)
      .set({
        status: result.skipped ? 'skipped' : 'processed',
        processedAt: new Date(),
        lastError: result.skipReason ?? null,
      })
      .where(claimGuard(row))
      .returning({ stripeEventId: webhookEvents.stripeEventId });
    logIfDiscarded(finalized, row, 'successful result');
  } catch (err) {
    const attempts = row.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, stripeEventId: row.stripeEventId, type: row.type, attempts },
      'webhook event processing failed',
    );
    const guard = claimGuard(row);
    if (attempts >= MAX_ATTEMPTS) {
      const parked = await db
        .update(webhookEvents)
        .set({ status: 'failed', attempts, lastError: message })
        .where(guard)
        .returning({ stripeEventId: webhookEvents.stripeEventId });
      logIfDiscarded(parked, row, 'failure (max attempts reached)');
    } else {
      const backoffSeconds = computeBackoffSeconds(attempts);
      const requeued = await db
        .update(webhookEvents)
        .set({
          status: 'received',
          attempts,
          lastError: message,
          nextAttemptAt: new Date(Date.now() + backoffSeconds * 1000),
        })
        .where(guard)
        .returning({ stripeEventId: webhookEvents.stripeEventId });
      logIfDiscarded(requeued, row, 'retry backoff');
    }
  }
}

export async function processPendingWebhookEvents(batchSize = 10): Promise<{ claimed: number }> {
  const rows = await claimBatch(batchSize);
  for (const row of rows) {
    await processRow(row);
  }
  return { claimed: rows.length };
}

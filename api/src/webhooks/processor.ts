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
// row. The claim (SELECT + status flip to 'processing') is a short
// transaction; the actual handler work happens outside it, after this
// function returns - holding a transaction open across a Stripe API call
// would hold row locks far longer than necessary.
async function claimBatch(batchSize: number): Promise<WebhookEventRow[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
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

    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.stripeEventId);
    await tx
      .update(webhookEvents)
      .set({ status: 'processing', processingStartedAt: new Date() })
      .where(inArray(webhookEvents.stripeEventId, ids));

    return rows;
  });
}

async function processRow(row: WebhookEventRow): Promise<void> {
  const event = row.payload as unknown as Stripe.Event;
  try {
    const result = await dispatch(event);
    await db
      .update(webhookEvents)
      .set({
        status: result.skipped ? 'skipped' : 'processed',
        processedAt: new Date(),
        lastError: result.skipReason ?? null,
      })
      .where(eq(webhookEvents.stripeEventId, row.stripeEventId));
  } catch (err) {
    const attempts = row.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, stripeEventId: row.stripeEventId, type: row.type, attempts },
      'webhook event processing failed',
    );
    if (attempts >= MAX_ATTEMPTS) {
      await db
        .update(webhookEvents)
        .set({ status: 'failed', attempts, lastError: message })
        .where(eq(webhookEvents.stripeEventId, row.stripeEventId));
    } else {
      const backoffSeconds = computeBackoffSeconds(attempts);
      await db
        .update(webhookEvents)
        .set({
          status: 'received',
          attempts,
          lastError: message,
          nextAttemptAt: new Date(Date.now() + backoffSeconds * 1000),
        })
        .where(eq(webhookEvents.stripeEventId, row.stripeEventId));
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

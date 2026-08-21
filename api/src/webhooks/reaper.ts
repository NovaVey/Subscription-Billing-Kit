import { and, eq, isNull, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { webhookEvents } from '../db/schema.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { MAX_ATTEMPTS } from './processor.js';

// If a worker dies mid-event (a deploy, an OOM kill), its claimed row stays
// 'processing' forever and the event is never applied - the claim
// transaction already committed, so there's no rollback to fall back on.
// This returns any row whose lease has expired back to 'received' (or
// parks it 'failed' if it's already exhausted its attempt budget), so the
// next processor tick can pick it up.
export async function reapStaleProcessingEvents(): Promise<{ reaped: number; parked: number }> {
  const cutoff = new Date(Date.now() - env.WEBHOOK_LEASE_SECONDS * 1000);

  const stuck = await db
    .select()
    .from(webhookEvents)
    .where(and(eq(webhookEvents.status, 'processing'), lt(webhookEvents.processingStartedAt, cutoff)));

  let reaped = 0;
  let parked = 0;

  for (const row of stuck) {
    const attempts = row.attempts + 1;

    // Guarded by status='processing' AND the exact processingStartedAt this
    // row had when we selected it above (its lease token). If the handler
    // still (or since) working this row finalizes it - or an admin replay
    // resets it - between our SELECT and this UPDATE, the guard fails to
    // match and we silently no-op instead of reverting an
    // already-finished/replayed row back to 'received'/'failed' out from
    // under it. This is the exact double-dispatch race the deep bug hunt
    // found: without it, a slow-but-alive handler could be reaped mid-flight
    // and reprocessed concurrently, and whichever write landed last would
    // silently clobber the other's terminal status.
    const leaseGuard = and(
      eq(webhookEvents.stripeEventId, row.stripeEventId),
      eq(webhookEvents.status, 'processing'),
      row.processingStartedAt
        ? eq(webhookEvents.processingStartedAt, row.processingStartedAt)
        : isNull(webhookEvents.processingStartedAt),
    );

    let claimed: { stripeEventId: string }[];
    if (attempts >= MAX_ATTEMPTS) {
      claimed = await db
        .update(webhookEvents)
        .set({
          status: 'failed',
          attempts,
          lastError: 'reaped: processing lease expired and max attempts reached',
        })
        .where(leaseGuard)
        .returning({ stripeEventId: webhookEvents.stripeEventId });
      if (claimed.length > 0) parked++;
    } else {
      claimed = await db
        .update(webhookEvents)
        .set({
          status: 'received',
          attempts,
          processingStartedAt: null,
          lastError: 'reaped: processing lease expired',
        })
        .where(leaseGuard)
        .returning({ stripeEventId: webhookEvents.stripeEventId });
      if (claimed.length > 0) reaped++;
    }

    if (claimed.length > 0) {
      logger.warn(
        { stripeEventId: row.stripeEventId, type: row.type, attempts },
        'reaped a stale processing webhook event',
      );
    } else {
      logger.info(
        { stripeEventId: row.stripeEventId, type: row.type },
        'skipped reaping a webhook event whose lease had already changed underneath the reaper - it finished or was replayed first',
      );
    }
  }

  return { reaped, parked };
}

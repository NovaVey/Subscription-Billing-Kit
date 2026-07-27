import { and, eq, lt } from 'drizzle-orm';
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
    if (attempts >= MAX_ATTEMPTS) {
      await db
        .update(webhookEvents)
        .set({
          status: 'failed',
          attempts,
          lastError: 'reaped: processing lease expired and max attempts reached',
        })
        .where(eq(webhookEvents.stripeEventId, row.stripeEventId));
      parked++;
    } else {
      await db
        .update(webhookEvents)
        .set({
          status: 'received',
          attempts,
          processingStartedAt: null,
          lastError: 'reaped: processing lease expired',
        })
        .where(eq(webhookEvents.stripeEventId, row.stripeEventId));
      reaped++;
    }
    logger.warn(
      { stripeEventId: row.stripeEventId, type: row.type, attempts },
      'reaped a stale processing webhook event',
    );
  }

  return { reaped, parked };
}

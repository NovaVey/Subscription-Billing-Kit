// Manual "try this again" for a single webhook event, from the command
// line rather than the admin UI's Replay button or POST
// /admin/webhook-events/:id/replay directly - useful when the API isn't
// reachable (an incident, a one-off script against the raw database) but
// the same reset semantics are still wanted: a clean received state with a
// fresh attempt budget, distinct from the automatic backoff/retry counter
// (§5.7). Same underlying update as routes/webhookEvents.ts's replay route.
import { eq } from 'drizzle-orm';
import { pool, db } from '../api/src/db/client.js';
import { webhookEvents } from '../api/src/db/schema.js';

async function main() {
  const stripeEventId = process.argv[2];
  if (!stripeEventId) {
    console.error('Usage: tsx scripts/replay-event.ts <stripe_event_id>');
    process.exitCode = 1;
    return;
  }

  const [existing] = await db.select().from(webhookEvents).where(eq(webhookEvents.stripeEventId, stripeEventId));
  if (!existing) {
    console.error(`[replay-event] no webhook_events row for ${stripeEventId}`);
    process.exitCode = 1;
    return;
  }

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

  console.log(`[replay-event] ${stripeEventId} reset to 'received' - the next processor tick will pick it up`);
}

main()
  .catch((err) => {
    console.error('[replay-event] failed', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

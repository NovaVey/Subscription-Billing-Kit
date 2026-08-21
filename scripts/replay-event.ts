// Manual "try this again" for a single webhook event, from the command
// line rather than the admin UI's Replay button or POST
// /admin/webhook-events/:id/replay directly - useful when the API isn't
// reachable (an incident, a one-off script against the raw database) but
// the same reset semantics are still wanted: a clean received state with a
// fresh attempt budget, distinct from the automatic backoff/retry counter
// (§5.7). Same underlying update as routes/webhookEvents.ts's replay route.
import { pool } from '../api/src/db/client.js';
import { resetWebhookEventForReplay } from '../api/src/webhooks/ledger.js';

async function main() {
  const stripeEventId = process.argv[2];
  if (!stripeEventId) {
    console.error('Usage: tsx scripts/replay-event.ts <stripe_event_id>');
    process.exitCode = 1;
    return;
  }

  const result = await resetWebhookEventForReplay(stripeEventId);
  if (result === 'not_found') {
    console.error(`[replay-event] no webhook_events row for ${stripeEventId}`);
    process.exitCode = 1;
    return;
  }
  if (result === 'processing') {
    console.error(
      `[replay-event] ${stripeEventId} is currently processing - refusing to replay a live event; wait for it to finish or be reaped first`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`[replay-event] ${stripeEventId} reset to 'received' - the next processor tick will pick it up`);
}

main()
  .catch((err) => {
    console.error('[replay-event] failed', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

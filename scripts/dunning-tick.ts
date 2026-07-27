// One-shot entry point for a production cron to invoke (§5.12: "every 15
// min in dev, cron in prod"). The in-process interval in
// api/src/webhooks/worker.ts covers dev; a long-lived process's timer
// isn't something you'd point a prod cron scheduler at, so this script
// runs a single tick and exits, same shape as scripts/seed-catalog.ts.
import { env } from '../api/src/env.js';
import { pool } from '../api/src/db/client.js';
import { runDunningTick } from '../api/src/billing/dunning.js';

async function main() {
  if (!env.DUNNING_ENABLED) {
    console.log('[dunning-tick] DUNNING_ENABLED=false — skipping this run');
    return;
  }
  const result = await runDunningTick();
  console.log('[dunning-tick]', JSON.stringify(result));
}

main()
  .catch((err) => {
    console.error('[dunning-tick] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

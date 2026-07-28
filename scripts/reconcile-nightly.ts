// One-shot entry point for a nightly cron (§5.11: "nightly job + on-demand
// run" - unlike the dunning tick, reconciliation has no dev-mode in-process
// interval, since testing it doesn't need a fast retry loop). Bounds
// "yesterday" explicitly in RECONCILE_TZ (never server-local time) and
// runs once per distinct currency this system has actually recorded
// invoices in - totals are never summed across currencies (§5.9/§5.10).
import { env } from '../api/src/env.js';
import { db, pool } from '../api/src/db/client.js';
import { invoices } from '../api/src/db/schema.js';
import { computeYesterdayWindow, runReconciliation } from '../api/src/billing/reconcile.js';

async function main() {
  const { start, end } = computeYesterdayWindow(env.RECONCILE_TZ, new Date());
  console.log(`[reconcile-nightly] window: ${start.toISOString()} .. ${end.toISOString()} (${env.RECONCILE_TZ})`);

  const currencyRows = await db.selectDistinct({ currency: invoices.currency }).from(invoices);
  if (currencyRows.length === 0) {
    console.log('[reconcile-nightly] no invoices recorded yet - nothing to reconcile');
    return;
  }

  for (const { currency } of currencyRows) {
    const result = await runReconciliation({ periodStart: start, periodEnd: end, currency });
    console.log(
      `[reconcile-nightly] ${currency}: ${result.mismatchCount} mismatch(es), ` +
        `stripe=${result.stripeTotalMinor} local=${result.localTotalMinor} ` +
        `(run ${result.runId})`,
    );
  }
}

main()
  .catch((err) => {
    console.error('[reconcile-nightly] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

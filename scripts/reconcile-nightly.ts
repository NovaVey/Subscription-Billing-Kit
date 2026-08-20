// One-shot entry point for a nightly cron (§5.11: "nightly job + on-demand
// run" - unlike the dunning tick, reconciliation has no dev-mode in-process
// interval, since testing it doesn't need a fast retry loop). Bounds
// "yesterday" explicitly in RECONCILE_TZ (never server-local time) and
// runs once per distinct currency this system has actually recorded
// invoices in - totals are never summed across currencies (§5.9/§5.10).
import { env } from '../api/src/env.js';
import { db, pool } from '../api/src/db/client.js';
import { invoices } from '../api/src/db/schema.js';
import { computeYesterdayWindow, runReconciliation, type RunReconciliationResult } from '../api/src/billing/reconcile.js';

// Runs one reconciliation per distinct currency - totals are never summed
// across currencies (§5.9/§5.10). Exported (rather than inlined in main())
// so the per-currency looping itself - not just runReconciliation, which is
// already unit/integration tested - has direct test coverage. See the
// /improve audit.
export async function reconcileEachCurrency(
  window: { periodStart: Date; periodEnd: Date },
  currencies: readonly string[],
): Promise<{ currency: string; result: RunReconciliationResult }[]> {
  const results: { currency: string; result: RunReconciliationResult }[] = [];
  for (const currency of currencies) {
    const result = await runReconciliation({ ...window, currency });
    results.push({ currency, result });
  }
  return results;
}

async function main() {
  const { start, end } = computeYesterdayWindow(env.RECONCILE_TZ, new Date());
  console.log(`[reconcile-nightly] window: ${start.toISOString()} .. ${end.toISOString()} (${env.RECONCILE_TZ})`);

  const currencyRows = await db.selectDistinct({ currency: invoices.currency }).from(invoices);
  if (currencyRows.length === 0) {
    console.log('[reconcile-nightly] no invoices recorded yet - nothing to reconcile');
    return;
  }

  const results = await reconcileEachCurrency(
    { periodStart: start, periodEnd: end },
    currencyRows.map((row) => row.currency),
  );
  for (const { currency, result } of results) {
    console.log(
      `[reconcile-nightly] ${currency}: ${result.mismatchCount} mismatch(es), ` +
        `stripe=${result.stripeTotalMinor} local=${result.localTotalMinor} ` +
        `(run ${result.runId})`,
    );
  }
}

// Guarded so this file can be imported for reconcileEachCurrency()'s own
// test coverage without running the whole script as a side effect of the
// import - `tsx scripts/reconcile-nightly.ts` still runs main() exactly as
// before, since argv[1] is this file's own path in that case. See the
// /improve audit.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main()
    .catch((err) => {
      console.error('[reconcile-nightly] failed:', err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

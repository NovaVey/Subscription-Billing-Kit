// One-shot entry point for a nightly cron (§5.11: "nightly job + on-demand
// run" - unlike the dunning tick, reconciliation has no dev-mode in-process
// interval, since testing it doesn't need a fast retry loop). Bounds
// "yesterday" explicitly in RECONCILE_TZ (never server-local time) and
// runs once per currency either side has seen in the window - totals are
// never summed across currencies (§5.9/§5.10).
import { pathToFileURL } from 'node:url';
import { env } from '../api/src/env.js';
import { db, pool } from '../api/src/db/client.js';
import { invoices } from '../api/src/db/schema.js';
import {
  computeYesterdayWindow,
  discoverCurrencies,
  runReconciliation,
  type RunReconciliationResult,
} from '../api/src/billing/reconcile.js';

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

// A currency list sourced only from local invoice rows (the previous
// approach) can never include a currency whose local sync is entirely
// missing - exactly the failure this job exists to catch. Unioning in
// whatever Stripe itself invoiced in the window closes that gap; the local
// side stays in the union too, in case a local row exists in a currency
// Stripe's own list happens not to surface for some other reason - either
// side alone can under-cover, so both are considered. Exported (rather
// than inlined in main()) so the merge itself has direct test coverage,
// same reasoning as reconcileEachCurrency above. See the deep bug hunt.
export function mergeCurrencies(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b].map((c) => c.toLowerCase()))].sort();
}

async function main() {
  const { start, end } = computeYesterdayWindow(env.RECONCILE_TZ, new Date());
  console.log(`[reconcile-nightly] window: ${start.toISOString()} .. ${end.toISOString()} (${env.RECONCILE_TZ})`);

  const [stripeCurrencies, localCurrencyRows] = await Promise.all([
    discoverCurrencies(start, end),
    db.selectDistinct({ currency: invoices.currency }).from(invoices),
  ]);
  const currencies = mergeCurrencies(
    stripeCurrencies,
    localCurrencyRows.map((row) => row.currency),
  );
  if (currencies.length === 0) {
    console.log('[reconcile-nightly] no invoices recorded yet - nothing to reconcile');
    return;
  }

  const results = await reconcileEachCurrency({ periodStart: start, periodEnd: end }, currencies);
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
// before, since argv[1] is this file's own path in that case. Built with
// pathToFileURL rather than a hand-rolled `file://${...}` template: on
// Windows argv[1] is a drive-letter path (`C:\...`) that pathToFileURL
// percent-encodes into a correct file:// URL, while the template produces
// something import.meta.url never actually equals - the guard would always
// read false and main() would silently never run from the CLI. Also wrong
// for any POSIX path containing a character `file://` + template
// concatenation wouldn't percent-encode (a space, a '#'). See the deep bug
// hunt.
const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMainModule) {
  main()
    .catch((err) => {
      console.error('[reconcile-nightly] failed:', err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

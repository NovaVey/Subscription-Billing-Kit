import { and, eq, gte, lt } from 'drizzle-orm';
import { stripe } from '../stripe/client.js';
import { db } from '../db/client.js';
import { invoices, reconciliationRuns, type ReconciliationReportEntry } from '../db/schema.js';
import { addSameCurrency } from '../lib/money.js';
import { toStripeSeconds } from '../lib/time.js';

// Comparison snapshot for one invoice, from either side - deliberately
// narrow (only the fields §5.11 says to compare) so classifyInvoices() has
// no Stripe SDK or Drizzle row shape to depend on, and can be unit-tested
// with plain objects.
export interface ReconciliationInvoiceSnapshot {
  stripeInvoiceId: string;
  status: string;
  amountDueMinor: number;
  amountPaidMinor: number;
}

export interface ClassifiedReconciliation {
  entries: ReconciliationReportEntry[];
  stripeTotalMinor: number;
  localTotalMinor: number;
  mismatchCount: number;
}

// Pure classification (§5.11): every Stripe invoice not found locally is
// missing_local; every local invoice not found in Stripe is orphan_local;
// a shared invoice with any differing field is field_drift - one entry per
// differing field, not one entry per invoice, so the report says exactly
// what's wrong rather than just that something is. Totals are "what was
// actually collected" (amount_paid_minor) per currency (§5.9/§5.10) - the
// headline sanity-check figure, on top of (not instead of) the field-level
// detail above.
export function classifyInvoices(
  stripeInvoices: readonly ReconciliationInvoiceSnapshot[],
  localInvoices: readonly ReconciliationInvoiceSnapshot[],
  currency: string,
): ClassifiedReconciliation {
  const stripeById = new Map(stripeInvoices.map((inv) => [inv.stripeInvoiceId, inv]));
  const localById = new Map(localInvoices.map((inv) => [inv.stripeInvoiceId, inv]));
  const entries: ReconciliationReportEntry[] = [];

  for (const [id, stripeInv] of stripeById) {
    const localInv = localById.get(id);
    if (!localInv) {
      entries.push({ type: 'missing_local', stripeInvoiceId: id });
      continue;
    }
    if (stripeInv.status !== localInv.status) {
      entries.push({
        type: 'field_drift',
        stripeInvoiceId: id,
        field: 'status',
        stripeValue: stripeInv.status,
        localValue: localInv.status,
      });
    }
    if (stripeInv.amountDueMinor !== localInv.amountDueMinor) {
      entries.push({
        type: 'field_drift',
        stripeInvoiceId: id,
        field: 'amount_due_minor',
        stripeValue: stripeInv.amountDueMinor,
        localValue: localInv.amountDueMinor,
      });
    }
    if (stripeInv.amountPaidMinor !== localInv.amountPaidMinor) {
      entries.push({
        type: 'field_drift',
        stripeInvoiceId: id,
        field: 'amount_paid_minor',
        stripeValue: stripeInv.amountPaidMinor,
        localValue: localInv.amountPaidMinor,
      });
    }
  }

  for (const [id] of localById) {
    if (!stripeById.has(id)) {
      entries.push({ type: 'orphan_local', stripeInvoiceId: id });
    }
  }

  const stripeTotalMinor = addSameCurrency(
    stripeInvoices.length > 0
      ? stripeInvoices.map((inv) => ({ amountMinor: inv.amountPaidMinor, currency }))
      : [{ amountMinor: 0, currency }],
  ).amountMinor;
  const localTotalMinor = addSameCurrency(
    localInvoices.length > 0
      ? localInvoices.map((inv) => ({ amountMinor: inv.amountPaidMinor, currency }))
      : [{ amountMinor: 0, currency }],
  ).amountMinor;

  return { entries, stripeTotalMinor, localTotalMinor, mismatchCount: entries.length };
}

// "Yesterday" bounded explicitly in RECONCILE_TZ, not server-local time
// (§5.11) - computed with Intl rather than a date-TZ library, since none
// is in the approved stack (§0 rule 5). Uses the target timezone's UTC
// offset at `now` for both boundaries; a "yesterday" window can only be
// off by this if the timezone's offset itself changes (a DST transition)
// within that specific day, an accepted edge case per §5.11's own framing
// of TZ-boundary ambiguity as a known, narrow category of noise.
function timeZoneOffsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(at)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  const asUtc = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']),
    Number(parts['minute']),
    Number(parts['second']),
  );
  return asUtc - at.getTime();
}

export function computeYesterdayWindow(tz: string, now: Date): { start: Date; end: Date } {
  const offsetMs = timeZoneOffsetMs(tz, now);
  const wallClockNow = new Date(now.getTime() + offsetMs);
  const startOfTodayWallClock = Date.UTC(
    wallClockNow.getUTCFullYear(),
    wallClockNow.getUTCMonth(),
    wallClockNow.getUTCDate(),
  );
  const startOfTodayUtc = new Date(startOfTodayWallClock - offsetMs);
  const startOfYesterdayUtc = new Date(startOfTodayUtc.getTime() - 24 * 60 * 60 * 1000);
  return { start: startOfYesterdayUtc, end: startOfTodayUtc };
}

// Lists every currency Stripe actually invoiced in the window, so the
// nightly job's per-currency loop can include a currency that has zero
// local rows — the exact case a local-only `SELECT DISTINCT currency FROM
// invoices` misses (a currency whose sync never landed locally at all is
// precisely what reconciliation exists to catch, and it can't catch a
// currency it never even considers). One list call for the whole window,
// not one per currency — reconcileEachCurrency still lists Stripe again
// per currency for the actual comparison, but discovering *which*
// currencies exist doesn't need that per-currency granularity. See the
// deep bug hunt.
export async function discoverCurrencies(periodStart: Date, periodEnd: Date): Promise<string[]> {
  const currencies = new Set<string>();
  for await (const invoice of stripe.invoices.list({
    created: { gte: toStripeSeconds(periodStart), lt: toStripeSeconds(periodEnd) },
    limit: 100,
  })) {
    currencies.add(invoice.currency.toLowerCase());
  }
  return [...currencies].sort();
}

export interface RunReconciliationInput {
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  // Defaults to the real wall clock - overridable so the live-window
  // clamp below (LIVE_WINDOW_BUFFER_MS) is deterministically testable,
  // the same "now as an explicit, testable param" pattern
  // computeYesterdayWindow above already establishes in this file.
  now?: Date;
}

export interface RunReconciliationResult extends ClassifiedReconciliation {
  runId: string;
  invoiceCountStripe: number;
  invoiceCountLocal: number;
}

// Stripe's List Invoices has no ascending-order option (verified against
// the installed SDK's own types, not assumed - §0 rule 9) - pages come
// back newest-first, walked forward via starting_after. An invoice that
// finalizes *during* this call - after an earlier page has already been
// fetched, but before pagination completes - is newer than everything
// already returned; every subsequent page only returns OLDER items, so it
// can never surface, however many pages this walks. Unreachable for the
// nightly cron (period_end is always a past midnight, already fully
// settled by the time the cron runs) but real for an ad-hoc admin run
// whose period_end is "now" - the common "reconcile since midnight" query,
// run while checkouts are actively completing. Clamping the window's
// effective upper bound a short buffer behind wall-clock now guarantees
// nothing this call actually pages through is still mid-finalization, at
// the cost of the last couple of minutes not being covered by *this* run
// (the next one covers them - the stored/reported window reflects the
// clamped bound actually used, not the raw requested one, so the run's own
// record stays honest about what it covered). See the deep bug hunt.
const LIVE_WINDOW_BUFFER_MS = 2 * 60 * 1000;

// Stripe's List Invoices has no currency filter (verified against the
// pinned version's actual API reference, not assumed - §0 rule 9), so
// every invoice in the created-date window is fetched and filtered to the
// requested currency client-side. Both sides window by the SAME field -
// Stripe's own invoice.created, mirrored locally on invoices.created_at
// (finding #18, deep bug hunt) - finalized_at can't serve this: it's
// permanently null for a draft that never finalizes (permanently
// excluding it from every possible window, misclassifying it missing_local
// forever) and can land in a different day's window than created for a
// normally-finalizing invoice (Stripe's ~1hr charge_automatically
// auto-finalize delay).
export async function runReconciliation(input: RunReconciliationInput): Promise<RunReconciliationResult> {
  const currency = input.currency.toLowerCase();
  const now = input.now ?? new Date();
  const settledBound = new Date(now.getTime() - LIVE_WINDOW_BUFFER_MS);
  const periodEnd = input.periodEnd.getTime() > settledBound.getTime() ? settledBound : input.periodEnd;

  // Half-open on both sides ([periodStart, periodEnd)), matching the local
  // query below exactly - an invoice landing on a shared boundary between
  // two adjacent runs (e.g. back-to-back nightly windows) must count in
  // exactly one run on both sides, not be double-counted on the Stripe side
  // while single-counted locally (or vice versa). This was previously `lte`
  // on periodEnd, which broke that invariant at the boundary - see the
  // /improve audit.
  //
  // Keyed by id, not appended to an array - a duplicate Stripe returns
  // across two pages (the pagination race documented above can shift an
  // object's page position, not just drop it) can never be double-counted
  // in invoiceCountStripe/stripeTotalMinor. See the deep bug hunt.
  const stripeInvoicesById = new Map<string, ReconciliationInvoiceSnapshot>();
  for await (const invoice of stripe.invoices.list({
    created: { gte: toStripeSeconds(input.periodStart), lt: toStripeSeconds(periodEnd) },
    limit: 100,
  })) {
    if (invoice.currency.toLowerCase() !== currency) continue;
    stripeInvoicesById.set(invoice.id!, {
      stripeInvoiceId: invoice.id!,
      status: invoice.status ?? 'draft',
      amountDueMinor: invoice.amount_due,
      amountPaidMinor: invoice.amount_paid,
    });
  }
  const stripeInvoices = [...stripeInvoicesById.values()];

  const localRows = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.currency, currency),
        gte(invoices.createdAt, input.periodStart),
        lt(invoices.createdAt, periodEnd),
      ),
    );
  const localInvoices: ReconciliationInvoiceSnapshot[] = localRows.map((row) => ({
    stripeInvoiceId: row.stripeInvoiceId,
    status: row.status,
    amountDueMinor: row.amountDueMinor,
    amountPaidMinor: row.amountPaidMinor,
  }));

  const classified = classifyInvoices(stripeInvoices, localInvoices, currency);

  const [row] = await db
    .insert(reconciliationRuns)
    .values({
      periodStart: input.periodStart,
      periodEnd,
      currency,
      stripeTotalMinor: classified.stripeTotalMinor,
      localTotalMinor: classified.localTotalMinor,
      invoiceCountStripe: stripeInvoices.length,
      invoiceCountLocal: localInvoices.length,
      mismatchCount: classified.mismatchCount,
      report: classified.entries,
    })
    .returning({ id: reconciliationRuns.id });

  return {
    runId: row!.id,
    invoiceCountStripe: stripeInvoices.length,
    invoiceCountLocal: localInvoices.length,
    ...classified,
  };
}

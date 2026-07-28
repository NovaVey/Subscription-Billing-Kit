import { useEffect, useState } from 'react';
import { listReconciliationRuns, runReconciliation } from '../lib/api';
import type { ReconciliationReportEntry, ReconciliationRun } from '../lib/types';
import { Amount } from '../components/Amount';
import { StatusTag } from '../components/StatusTag';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { formatTimestamp } from '../lib/format';
import { useToast } from '../components/Toast';

function mismatchBreakdown(report: ReconciliationReportEntry[]): string {
  if (report.length === 0) return 'zero mismatches';
  const counts = new Map<string, number>();
  for (const entry of report) counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([type, count]) => `${count} ${type.replace(/_/g, ' ')}`)
    .join(', ');
}

export function ReconciliationPage() {
  const { notify } = useToast();
  const [runs, setRuns] = useState<ReconciliationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReconciliationRun | null>(null);

  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [currency, setCurrency] = useState('usd');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  function reload() {
    setLoading(true);
    setError(null);
    listReconciliationRuns()
      .then((res) => setRuns(res.runs))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);

  async function handleRun() {
    if (!periodStart || !periodEnd || !currency) return;
    setRunning(true);
    setRunError(null);
    try {
      const result = await runReconciliation({
        period_start: new Date(periodStart).toISOString(),
        period_end: new Date(periodEnd).toISOString(),
        currency,
      });
      notify('Reconciliation run complete');
      setSelected({
        id: result.runId,
        periodStart: new Date(periodStart).toISOString(),
        periodEnd: new Date(periodEnd).toISOString(),
        ranAt: new Date().toISOString(),
        currency,
        stripeTotalMinor: result.stripeTotalMinor,
        localTotalMinor: result.localTotalMinor,
        invoiceCountStripe: result.invoiceCountStripe,
        invoiceCountLocal: result.invoiceCountLocal,
        mismatchCount: result.mismatchCount,
        report: result.entries,
      });
      reload();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
      notify('Reconciliation run failed', 'alert');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Reconciliation</h1>

      <section className="border border-rule p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/60">Run a new reconciliation</h2>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            Period start
            <input
              type="datetime-local"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              className="num border border-rule px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            Period end
            <input
              type="datetime-local"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              className="num border border-rule px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            Currency
            <input
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="num w-20 border border-rule px-2 py-1"
            />
          </label>
          <button
            type="button"
            onClick={handleRun}
            disabled={running || !periodStart || !periodEnd || !currency}
            className="border border-ink px-3 py-1.5 hover:bg-ink hover:text-paper disabled:opacity-50"
          >
            {running ? 'Running…' : 'Run reconciliation'}
          </button>
        </div>
        {runError && <div className="mt-3"><ErrorState message={runError} /></div>}
      </section>

      {error && <ErrorState message={`Could not load reconciliation history: ${error}`} />}
      {loading && runs.length === 0 && <LoadingState />}
      {!loading && !error && runs.length === 0 && (
        <EmptyState message="No reconciliation runs yet. Run one above, or wait for the nightly job." />
      )}

      {runs.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/60">Run history</h2>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-rule text-left text-xs uppercase tracking-wide text-ink/60">
                <th className="py-2 pr-4 font-normal">Ran at</th>
                <th className="py-2 pr-4 font-normal">Period</th>
                <th className="py-2 pr-4 font-normal">Currency</th>
                <th className="py-2 pr-4 text-right font-normal">Stripe total</th>
                <th className="py-2 pr-4 text-right font-normal">Local total</th>
                <th className="py-2 pr-4 font-normal">Mismatches</th>
                <th className="py-2 pr-4 font-normal" />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b border-rule">
                  <td className="num py-2 pr-4">{formatTimestamp(run.ranAt)}</td>
                  <td className="num py-2 pr-4">
                    {formatTimestamp(run.periodStart)} → {formatTimestamp(run.periodEnd)}
                  </td>
                  <td className="num py-2 pr-4 uppercase">{run.currency}</td>
                  <td className="py-2 pr-4">
                    <Amount minor={run.stripeTotalMinor} currency={run.currency} />
                  </td>
                  <td className="py-2 pr-4">
                    <Amount minor={run.localTotalMinor} currency={run.currency} />
                  </td>
                  <td className="py-2 pr-4">
                    {run.mismatchCount === 0 ? (
                      <StatusTag status="zero mismatches" tone="settled" />
                    ) : (
                      <StatusTag status={`${run.mismatchCount} mismatches`} tone="alert" />
                    )}
                  </td>
                  <td className="py-2 pr-4 text-right">
                    <button
                      type="button"
                      onClick={() => setSelected(run)}
                      className="border border-ink px-2 py-1 text-xs hover:bg-ink hover:text-paper"
                    >
                      Drill in
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {selected && (
        <section className="border-t border-rule pt-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink/60">
            Run detail — {formatTimestamp(selected.ranAt)}
          </h2>
          <p className="mb-3 text-sm text-ink/60">{mismatchBreakdown(selected.report)}</p>

          {selected.report.length === 0 ? (
            <EmptyState message="Zero mismatches for this run." />
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-rule text-left text-xs uppercase tracking-wide text-ink/60">
                  <th className="py-2 pr-4 font-normal">Type</th>
                  <th className="py-2 pr-4 font-normal">Stripe invoice</th>
                  <th className="py-2 pr-4 font-normal">Field</th>
                  <th className="py-2 pr-4 font-normal">Stripe value</th>
                  <th className="py-2 pr-4 font-normal">Local value</th>
                </tr>
              </thead>
              <tbody>
                {selected.report.map((entry, i) => (
                  <tr key={`${entry.stripeInvoiceId}-${i}`} className="border-b border-rule">
                    <td className="py-2 pr-4">
                      <StatusTag status={entry.type} />
                    </td>
                    <td className="num py-2 pr-4">{entry.stripeInvoiceId}</td>
                    <td className="py-2 pr-4">{entry.field ?? '—'}</td>
                    <td className="num py-2 pr-4">{entry.stripeValue != null ? String(entry.stripeValue) : '—'}</td>
                    <td className="num py-2 pr-4">{entry.localValue != null ? String(entry.localValue) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

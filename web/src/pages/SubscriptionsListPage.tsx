import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listSubscriptions } from '../lib/api';
import type { SubscriptionListRow } from '../lib/types';
import { Amount } from '../components/Amount';
import { StatusTag } from '../components/StatusTag';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { formatDateOnly } from '../lib/format';

const STATUS_OPTIONS = [
  '',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
  'canceled',
  'incomplete',
  'incomplete_expired',
];

export function SubscriptionsListPage() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [rows, setRows] = useState<SubscriptionListRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    listSubscriptions({ status: status || undefined, q: appliedQ || undefined, limit: 25 })
      .then((res) => {
        setRows(res.subscriptions);
        setCursor(res.nextCursor);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [status, appliedQ]);

  function loadMore() {
    if (!cursor) return;
    setLoading(true);
    listSubscriptions({ status: status || undefined, q: appliedQ || undefined, cursor, limit: 25 })
      .then((res) => {
        setRows((prev) => [...prev, ...res.subscriptions]);
        setCursor(res.nextCursor);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <h1 className="text-xl font-semibold">Subscriptions</h1>
        <div className="ml-auto flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-xs text-ink/60">
            Status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="mt-1 border border-rule bg-paper px-2 py-1 text-sm text-ink"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s || 'all'}
                </option>
              ))}
            </select>
          </label>
          <form
            className="flex flex-col text-xs text-ink/60"
            onSubmit={(e) => {
              e.preventDefault();
              setAppliedQ(q);
            }}
          >
            Search email / external ref
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="jane@example.com"
              className="mt-1 border border-rule bg-paper px-2 py-1 text-sm text-ink"
            />
          </form>
        </div>
      </div>

      {error && <ErrorState message={`Could not load subscriptions: ${error}`} />}
      {loading && rows.length === 0 && <LoadingState />}
      {!loading && !error && rows.length === 0 && (
        <EmptyState message="No subscriptions match these filters. Try clearing the status or search." />
      )}

      {rows.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-rule text-left text-xs uppercase tracking-wide text-ink/60">
              <th className="py-2 pr-4 font-normal">Customer</th>
              <th className="py-2 pr-4 font-normal">Plan</th>
              <th className="py-2 pr-4 font-normal">Status</th>
              <th className="py-2 pr-4 text-right font-normal">MRR</th>
              <th className="py-2 pr-4 text-right font-normal">Next renewal (derived)</th>
              <th className="py-2 pr-4 font-normal">Dunning</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-rule hover:bg-ink/[0.03]">
                <td className="py-2 pr-4">
                  <Link to={`/subscriptions/${row.id}`} className="underline decoration-rule hover:decoration-ink">
                    {row.customerEmail}
                  </Link>
                  {row.customerExternalRef && (
                    <div className="num text-xs text-ink/50">{row.customerExternalRef}</div>
                  )}
                </td>
                <td className="py-2 pr-4">{row.planCode}</td>
                <td className="py-2 pr-4">
                  <StatusTag status={row.status} />
                </td>
                <td className="py-2 pr-4">
                  <Amount minor={row.mrrMinor} currency={row.currency} className="block" />
                </td>
                <td className="num py-2 pr-4 text-right">{formatDateOnly(row.nextPeriodEndDerived)}</td>
                <td className="py-2 pr-4">
                  {row.dunningStage > 0 ? (
                    <StatusTag status={`stage ${row.dunningStage}`} tone="alert" />
                  ) : (
                    <span className="text-ink/40">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {cursor && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loading}
          className="self-start border border-ink px-3 py-1.5 text-sm hover:bg-ink hover:text-paper disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

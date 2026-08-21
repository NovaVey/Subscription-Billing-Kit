import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { listSubscriptions } from '../lib/api';
import type { SubscriptionListRow } from '../lib/types';
import { Amount } from '../components/Amount';
import { StatusTag } from '../components/StatusTag';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { formatDateOnly } from '../lib/format';
import { useAsyncData } from '../lib/hooks';

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
  const { data, loading, error } = useAsyncData(
    () => listSubscriptions({ status: status || undefined, q: appliedQ || undefined, limit: 25 }),
    [status, appliedQ],
  );
  const [rows, setRows] = useState<SubscriptionListRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // Always holds the filters actually in effect right now (updated every
  // render, not just when a fetch fires) - loadMore() reads it back inside
  // its own .then() to tell "the filters that were active when this page
  // request went out" from "the filters active now". See loadMore below.
  const activeFiltersRef = useRef({ status, appliedQ });
  activeFiltersRef.current = { status, appliedQ };

  // loadMore appends to `rows` rather than replacing it, which doesn't fit
  // useAsyncData's replace-on-fetch shape - so the initial (filter-driven)
  // load goes through the shared hook, and only the append step stays
  // hand-rolled here. See the /improve audit.
  useEffect(() => {
    if (data) {
      setRows(data.subscriptions);
      setCursor(data.nextCursor);
      setLoadMoreError(null);
    }
  }, [data]);

  function loadMore() {
    if (!cursor) return;
    const requestStatus = status;
    const requestAppliedQ = appliedQ;
    setLoadingMore(true);
    setLoadMoreError(null);
    listSubscriptions({ status: requestStatus || undefined, q: requestAppliedQ || undefined, cursor, limit: 25 })
      .then((res) => {
        // The status/search filter can change while this page request is
        // still in flight - the base useAsyncData fetch for the new filter
        // already replaced `rows` by the time this resolves. Appending a
        // stale filter's page onto the new filter's rows would silently mix
        // the two result sets together, so discard it once the filters
        // active now no longer match the ones this request was made under.
        // See the deep bug hunt.
        const current = activeFiltersRef.current;
        if (current.status !== requestStatus || current.appliedQ !== requestAppliedQ) return;
        setRows((prev) => [...prev, ...res.subscriptions]);
        setCursor(res.nextCursor);
      })
      .catch((err: Error) => setLoadMoreError(err.message))
      .finally(() => setLoadingMore(false));
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

      {(error ?? loadMoreError) && <ErrorState message={`Could not load subscriptions: ${error ?? loadMoreError}`} />}
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
                  {row.hasTieredPricing && (
                    <div
                      className="text-right text-xs text-ink/40"
                      title="One or more items use tiered/graduated/package pricing - MRR excludes them and understates the true total"
                    >
                      tiered pricing excluded
                    </div>
                  )}
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
          disabled={loadingMore}
          className="self-start border border-ink px-3 py-1.5 text-sm hover:bg-ink hover:text-paper disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

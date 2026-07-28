import { useEffect, useState } from 'react';
import { listInvoices } from '../lib/api';
import type { Invoice } from '../lib/types';
import { Amount } from '../components/Amount';
import { StatusTag } from '../components/StatusTag';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { formatTimestamp } from '../lib/format';

const STATUS_OPTIONS = ['', 'draft', 'open', 'paid', 'uncollectible', 'void'];

export function InvoicesPage() {
  const [status, setStatus] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [appliedCustomerId, setAppliedCustomerId] = useState('');
  const [rows, setRows] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    listInvoices({ status: status || undefined, customer_id: appliedCustomerId || undefined, limit: 100 })
      .then((res) => setRows(res.invoices))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [status, appliedCustomerId]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <h1 className="text-xl font-semibold">Invoices</h1>
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
              setAppliedCustomerId(customerId);
            }}
          >
            Customer id
            <input
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder="uuid"
              className="num mt-1 border border-rule bg-paper px-2 py-1 text-sm text-ink"
            />
          </form>
        </div>
      </div>

      {error && <ErrorState message={`Could not load invoices: ${error}`} />}
      {loading && rows.length === 0 && <LoadingState />}
      {!loading && !error && rows.length === 0 && (
        <EmptyState message="No invoices match these filters. Try clearing the status or customer id." />
      )}

      {rows.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-rule text-left text-xs uppercase tracking-wide text-ink/60">
              <th className="py-2 pr-4 font-normal">Customer</th>
              <th className="py-2 pr-4 font-normal">Status</th>
              <th className="py-2 pr-4 text-right font-normal">Due</th>
              <th className="py-2 pr-4 text-right font-normal">Paid</th>
              <th className="py-2 pr-4 text-right font-normal">Attempts</th>
              <th className="py-2 pr-4 font-normal">Next attempt</th>
              <th className="py-2 pr-4 font-normal">Hosted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((inv) => (
              <tr key={inv.id} className="border-b border-rule">
                <td className="py-2 pr-4">{inv.customerEmail ?? '—'}</td>
                <td className="py-2 pr-4">
                  <StatusTag status={inv.status} />
                </td>
                <td className="py-2 pr-4">
                  <Amount minor={inv.amountDueMinor} currency={inv.currency} />
                </td>
                <td className="py-2 pr-4">
                  <Amount minor={inv.amountPaidMinor} currency={inv.currency} />
                </td>
                <td className="num py-2 pr-4 text-right">{inv.attemptCount}</td>
                <td className="num py-2 pr-4">{formatTimestamp(inv.nextPaymentAttempt)}</td>
                <td className="py-2 pr-4">
                  {inv.hostedInvoiceUrl ? (
                    <a href={inv.hostedInvoiceUrl} target="_blank" rel="noreferrer" className="underline">
                      View on Stripe
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

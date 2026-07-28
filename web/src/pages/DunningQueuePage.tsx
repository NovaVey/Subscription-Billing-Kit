import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getDunningQueue, resolveDunning } from '../lib/api';
import type { DunningQueueRow } from '../lib/types';
import { Amount } from '../components/Amount';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Modal } from '../components/Modal';
import { formatTimestamp, truncateId } from '../lib/format';
import { useToast } from '../components/Toast';

const RESOLUTIONS = ['recovered', 'canceled', 'manual'] as const;

export function DunningQueuePage() {
  const { notify } = useToast();
  const [rows, setRows] = useState<DunningQueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolveTarget, setResolveTarget] = useState<DunningQueueRow | null>(null);
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]>('recovered');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  function reload() {
    setLoading(true);
    setError(null);
    getDunningQueue()
      .then((res) => setRows(res.queue))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);

  async function handleResolve() {
    if (!resolveTarget || !note.trim()) return;
    setBusy(true);
    try {
      await resolveDunning(resolveTarget.subscriptionId, { resolution, note });
      notify('Resolved');
      setResolveTarget(null);
      setNote('');
      reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Resolve failed', 'alert');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={`Could not load the dunning queue: ${error}`} />;

  const groups = [4, 3, 2, 1].map((stage) => ({
    stage,
    items: rows.filter((r) => r.stage === stage),
  }));

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Dunning queue</h1>

      {rows.length === 0 && <EmptyState message="Nothing in dunning right now. Every subscription is current." />}

      {groups.map(
        (group) =>
          group.items.length > 0 && (
            <section key={group.stage}>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-alert">
                Stage {group.stage} · {group.items.length}
              </h2>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-rule text-left text-xs uppercase tracking-wide text-ink/60">
                    <th className="py-2 pr-4 font-normal">Customer</th>
                    <th className="py-2 pr-4 text-right font-normal">Days in stage</th>
                    <th className="py-2 pr-4 font-normal">Triggering invoice</th>
                    <th className="py-2 pr-4 text-right font-normal">Amount at risk</th>
                    <th className="py-2 pr-4 font-normal">Next action</th>
                    <th className="py-2 pr-4 font-normal" />
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((row) => (
                    <tr key={row.subscriptionId} className="border-b border-rule">
                      <td className="py-2 pr-4">
                        <Link
                          to={`/subscriptions/${row.subscriptionId}`}
                          className="underline decoration-rule hover:decoration-ink"
                        >
                          {row.customerEmail}
                        </Link>
                      </td>
                      <td className="num py-2 pr-4 text-right">{row.daysInStage ?? '—'}</td>
                      <td className="num py-2 pr-4">{truncateId(row.triggeringInvoiceId)}</td>
                      <td className="py-2 pr-4">
                        {row.amountAtRiskMinor != null && row.currency ? (
                          <Amount minor={row.amountAtRiskMinor} currency={row.currency} />
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="num py-2 pr-4">{formatTimestamp(row.nextActionAt)}</td>
                      <td className="py-2 pr-4 text-right">
                        <button
                          type="button"
                          onClick={() => setResolveTarget(row)}
                          className="border border-ink px-2 py-1 text-xs hover:bg-ink hover:text-paper"
                        >
                          Resolve
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ),
      )}

      {resolveTarget && (
        <Modal
          title={`Resolve dunning for ${resolveTarget.customerEmail}`}
          onClose={() => {
            setResolveTarget(null);
            setNote('');
          }}
        >
          <div className="flex flex-col gap-3 text-sm">
            <label className="flex flex-col gap-1">
              Resolution
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value as (typeof RESOLUTIONS)[number])}
                className="border border-rule px-2 py-1"
              >
                {RESOLUTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              Note
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className="border border-rule px-2 py-1"
                placeholder="Why this cycle is being resolved manually"
              />
            </label>
            <button
              type="button"
              onClick={handleResolve}
              disabled={!note.trim() || busy}
              className="self-start border border-settled px-3 py-1.5 text-settled hover:bg-settled hover:text-paper disabled:opacity-50"
            >
              Resolve
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

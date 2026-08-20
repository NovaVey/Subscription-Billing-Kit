import { Fragment, useEffect, useState } from 'react';
import { getWebhookEvent, listWebhookEvents, replayWebhookEvent } from '../lib/api';
import type { WebhookEvent } from '../lib/types';
import { StatusTag } from '../components/StatusTag';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { formatTimestamp } from '../lib/format';
import { useToast } from '../components/Toast';

const STATUS_OPTIONS = ['', 'received', 'processing', 'processed', 'failed', 'skipped'];

function leaseAge(event: WebhookEvent): string {
  if (event.status !== 'processing' || !event.processingStartedAt) return '—';
  const ms = Date.now() - new Date(event.processingStartedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function WebhookLogPage() {
  const { notify } = useToast();
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [appliedType, setAppliedType] = useState('');
  const [rows, setRows] = useState<WebhookEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [payloads, setPayloads] = useState<Record<string, Record<string, unknown>>>({});
  const [loadingPayload, setLoadingPayload] = useState<string | null>(null);
  const [replaying, setReplaying] = useState<string | null>(null);

  function reload() {
    setLoading(true);
    setError(null);
    listWebhookEvents({ status: status || undefined, type: appliedType || undefined, limit: 100 })
      .then((res) => setRows(res.events))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(reload, [status, appliedType]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // The list response no longer carries `payload` - fetch it once, on
    // first expand, and cache it locally so re-collapsing/re-expanding the
    // same row doesn't re-fetch.
    if (!expanded.has(id) && !(id in payloads)) {
      setLoadingPayload(id);
      getWebhookEvent(id)
        .then((detail) => setPayloads((prev) => ({ ...prev, [id]: detail.payload })))
        .catch((err: Error) => notify(err.message, 'alert'))
        .finally(() => setLoadingPayload((current) => (current === id ? null : current)));
    }
  }

  async function handleReplay(id: string) {
    setReplaying(id);
    try {
      await replayWebhookEvent(id);
      notify('Replayed');
      reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Replay failed', 'alert');
    } finally {
      setReplaying(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <h1 className="text-xl font-semibold">Webhook log</h1>
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
              setAppliedType(type);
            }}
          >
            Event type
            <input
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="invoice.payment_failed"
              className="mt-1 border border-rule bg-paper px-2 py-1 text-sm text-ink"
            />
          </form>
        </div>
      </div>

      {error && <ErrorState message={`Could not load the webhook log: ${error}`} />}
      {loading && rows.length === 0 && <LoadingState />}
      {!loading && !error && rows.length === 0 && (
        <EmptyState message="No webhook events match these filters." />
      )}

      {rows.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-rule text-left text-xs uppercase tracking-wide text-ink/60">
              <th className="py-2 pr-4 font-normal">Type</th>
              <th className="py-2 pr-4 font-normal">Status</th>
              <th className="py-2 pr-4 text-right font-normal">Attempts</th>
              <th className="py-2 pr-4 font-normal">Next attempt</th>
              <th className="py-2 pr-4 font-normal">Lease age</th>
              <th className="py-2 pr-4 font-normal">Last error</th>
              <th className="py-2 pr-4 font-normal" />
            </tr>
          </thead>
          <tbody>
            {rows.map((event) => (
              <Fragment key={event.stripeEventId}>
                <tr className="border-b border-rule align-top">
                  <td className="num py-2 pr-4">{event.type}</td>
                  <td className="py-2 pr-4">
                    <StatusTag status={event.status} />
                  </td>
                  <td className="num py-2 pr-4 text-right">{event.attempts}</td>
                  <td className="num py-2 pr-4">{formatTimestamp(event.nextAttemptAt)}</td>
                  <td className="num py-2 pr-4">{leaseAge(event)}</td>
                  <td className={`max-w-xs truncate py-2 pr-4 ${event.lastError ? 'text-alert' : ''}`}>
                    {event.lastError ?? '—'}
                  </td>
                  <td className="py-2 pr-4 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(event.stripeEventId)}
                        className="border border-ink px-2 py-1 text-xs hover:bg-ink hover:text-paper"
                      >
                        {expanded.has(event.stripeEventId) ? 'Hide payload' : 'Payload'}
                      </button>
                      <button
                        type="button"
                        disabled={replaying === event.stripeEventId}
                        onClick={() => handleReplay(event.stripeEventId)}
                        className="border border-ink px-2 py-1 text-xs hover:bg-ink hover:text-paper disabled:opacity-50"
                      >
                        Replay
                      </button>
                    </div>
                  </td>
                </tr>
                {expanded.has(event.stripeEventId) && (
                  <tr className="border-b border-rule">
                    <td colSpan={7} className="bg-ink/[0.03] p-4">
                      {loadingPayload === event.stripeEventId && !(event.stripeEventId in payloads) ? (
                        <p className="text-xs text-ink/60">Loading payload…</p>
                      ) : (
                        <pre className="num max-h-80 overflow-auto whitespace-pre-wrap text-xs">
                          {JSON.stringify(payloads[event.stripeEventId], null, 2)}
                        </pre>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

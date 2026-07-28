import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  applyPlanChange,
  cancelSubscription,
  getSubscription,
  previewPlanChange,
  resumeSubscription,
} from '../lib/api';
import type { SubscriptionDetailResponse } from '../lib/types';
import { Amount } from '../components/Amount';
import { StatusTag } from '../components/StatusTag';
import { ErrorState, LoadingState } from '../components/States';
import { Modal } from '../components/Modal';
import { formatTimestamp, truncateId } from '../lib/format';
import { useToast } from '../components/Toast';

const PRORATION_OPTIONS = ['create_prorations', 'none', 'always_invoice'];

export function SubscriptionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { notify } = useToast();
  const [data, setData] = useState<SubscriptionDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [priceId, setPriceId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [prorationBehavior, setProrationBehavior] = useState('create_prorations');
  const [preview, setPreview] = useState<{ currency: string; amount_due: number; total: number } | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<string | null>(null);

  function reload() {
    if (!id) return;
    setLoading(true);
    setError(null);
    getSubscription(id)
      .then(setData)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(reload, [id]);

  async function handlePreview() {
    if (!id) return;
    setPreviewError(null);
    setPreview(null);
    try {
      const result = await previewPlanChange(id, { price_id: priceId, quantity, proration_behavior: prorationBehavior });
      setPreview(result);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleApplyPlanChange() {
    if (!id) return;
    setBusy(true);
    try {
      await applyPlanChange(id, { price_id: priceId, quantity, proration_behavior: prorationBehavior });
      notify('Plan changed');
      setPlanModalOpen(false);
      setPreview(null);
      reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Plan change failed', 'alert');
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel(atPeriodEnd: boolean) {
    if (!id) return;
    setBusy(true);
    try {
      await cancelSubscription(id, atPeriodEnd);
      notify(atPeriodEnd ? 'Canceled at period end' : 'Canceled');
      reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Cancel failed', 'alert');
    } finally {
      setBusy(false);
    }
  }

  async function handleResume() {
    if (!id) return;
    setBusy(true);
    try {
      await resumeSubscription(id);
      notify('Resumed');
      reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Resume failed', 'alert');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={`Could not load this subscription: ${error}`} />;
  if (!data) return null;

  const { subscription, customer, items, timeline, invoices, dunning } = data;
  const canResume = subscription.status === 'paused' || subscription.cancelAtPeriodEnd;

  return (
    <div className="flex flex-col gap-8">
      <button type="button" onClick={() => navigate('/subscriptions')} className="self-start text-sm text-ink/60 hover:text-ink">
        ← Back to subscriptions
      </button>

      {/* Header facts */}
      <section className="border-b border-rule pb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">{customer?.email ?? 'Unknown customer'}</h1>
            {customer?.externalRef && <p className="num text-sm text-ink/60">{customer.externalRef}</p>}
          </div>
          <StatusTag status={subscription.status} />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink/50">Plan</dt>
            <dd>{subscription.planCode}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink/50">Currency</dt>
            <dd className="num uppercase">{subscription.currency}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink/50">Next renewal (derived)</dt>
            <dd className="num">{formatTimestamp(subscription.nextPeriodEndDerived)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink/50">Cancel at period end</dt>
            <dd>{subscription.cancelAtPeriodEnd ? 'Yes' : 'No'}</dd>
          </div>
          <div className="col-span-2 sm:col-span-4">
            <dt className="text-xs uppercase tracking-wide text-ink/50">Stripe subscription id</dt>
            <dd className="num">{subscription.stripeSubscriptionId}</dd>
          </div>
        </dl>

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => setPlanModalOpen(true)}
            className="border border-ink px-3 py-1.5 text-sm hover:bg-ink hover:text-paper disabled:opacity-50"
          >
            Change plan
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => handleCancel(true)}
            className="border border-ink px-3 py-1.5 text-sm hover:bg-ink hover:text-paper disabled:opacity-50"
          >
            Cancel at period end
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => handleCancel(false)}
            className="border border-alert px-3 py-1.5 text-sm text-alert hover:bg-alert hover:text-paper disabled:opacity-50"
          >
            Cancel immediately
          </button>
          {canResume && (
            <button
              type="button"
              disabled={busy}
              onClick={handleResume}
              className="border border-settled px-3 py-1.5 text-sm text-settled hover:bg-settled hover:text-paper disabled:opacity-50"
            >
              Resume
            </button>
          )}
        </div>
      </section>

      {dunning && dunning.stage > 0 && (
        <section className="border-l-2 border-alert bg-alert/5 px-4 py-3 text-sm">
          <p className="font-semibold text-alert">Dunning stage {dunning.stage}</p>
          <p className="text-ink/70">
            Entered {formatTimestamp(dunning.enteredStageAt)} · next action {formatTimestamp(dunning.nextActionAt)} ·{' '}
            {dunning.noticesSent} notice(s) sent
          </p>
        </section>
      )}

      {/* Item list with per-item periods */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/60">Items</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-rule text-left text-xs uppercase tracking-wide text-ink/60">
              <th className="py-2 pr-4 font-normal">Price</th>
              <th className="py-2 pr-4 text-right font-normal">Qty</th>
              <th className="py-2 pr-4 text-right font-normal">Unit amount</th>
              <th className="py-2 pr-4 font-normal">Interval</th>
              <th className="py-2 pr-4 font-normal">Current period</th>
              <th className="py-2 pr-4 font-normal">Removed</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-rule">
                <td className="num py-2 pr-4">{item.priceId}</td>
                <td className="num py-2 pr-4 text-right">{item.quantity}</td>
                <td className="py-2 pr-4">
                  <Amount minor={item.unitAmountMinor} currency={item.currency} />
                </td>
                <td className="py-2 pr-4">{item.recurringInterval ?? '—'}</td>
                <td className="num py-2 pr-4">
                  {formatTimestamp(item.currentPeriodStart)} → {formatTimestamp(item.currentPeriodEnd)}
                </td>
                <td className="py-2 pr-4">{item.removedAt ? <StatusTag status="removed" tone="alert" /> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Signature element: the event timeline */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/60">Event timeline</h2>
        {timeline.length === 0 ? (
          <p className="text-sm text-ink/60">No events recorded yet.</p>
        ) : (
          <ol className="relative flex flex-col gap-4 border-l border-rule pl-4">
            {timeline.map((event) => (
              <li key={event.id} className="num text-sm">
                <span className="text-ink/70">{formatTimestamp(event.occurredAt)}</span>{'  '}
                <span className="font-medium">
                  {event.fromStatus ?? '∅'} → {event.toStatus}
                </span>{'  '}
                <span className="text-ink/60">{event.reason}</span>
                {event.stripeEventId && <span className="text-ink/40">{'  '}{truncateId(event.stripeEventId)}</span>}
                {event.note && <div className="font-sans text-xs text-ink/60">{event.note}</div>}
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Invoice list */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/60">Invoices</h2>
        {invoices.length === 0 ? (
          <p className="text-sm text-ink/60">No invoices yet.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-rule text-left text-xs uppercase tracking-wide text-ink/60">
                <th className="py-2 pr-4 font-normal">Status</th>
                <th className="py-2 pr-4 text-right font-normal">Due</th>
                <th className="py-2 pr-4 text-right font-normal">Paid</th>
                <th className="py-2 pr-4 font-normal">Period</th>
                <th className="py-2 pr-4 font-normal">Hosted</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-rule">
                  <td className="py-2 pr-4">
                    <StatusTag status={inv.status} />
                  </td>
                  <td className="py-2 pr-4">
                    <Amount minor={inv.amountDueMinor} currency={inv.currency} />
                  </td>
                  <td className="py-2 pr-4">
                    <Amount minor={inv.amountPaidMinor} currency={inv.currency} />
                  </td>
                  <td className="num py-2 pr-4">
                    {formatTimestamp(inv.periodStart)} → {formatTimestamp(inv.periodEnd)}
                  </td>
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
      </section>

      {planModalOpen && (
        <Modal
          title="Change plan"
          onClose={() => {
            setPlanModalOpen(false);
            setPreview(null);
            setPreviewError(null);
          }}
        >
          <div className="flex flex-col gap-3 text-sm">
            <label className="flex flex-col gap-1">
              Price id
              <input
                value={priceId}
                onChange={(e) => setPriceId(e.target.value)}
                className="border border-rule px-2 py-1"
                placeholder="price_..."
              />
            </label>
            <label className="flex flex-col gap-1">
              Quantity
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
                className="num border border-rule px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1">
              Proration behavior
              <select
                value={prorationBehavior}
                onChange={(e) => setProrationBehavior(e.target.value)}
                className="border border-rule px-2 py-1"
              >
                {PRORATION_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={handlePreview}
              disabled={!priceId || busy}
              className="mt-2 self-start border border-ink px-3 py-1.5 hover:bg-ink hover:text-paper disabled:opacity-50"
            >
              Preview proration
            </button>

            {previewError && <ErrorState message={previewError} />}
            {preview && (
              <div className="border border-rule px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-ink/50">Amount due now</p>
                <Amount minor={preview.amount_due} currency={preview.currency} className="text-base" />
              </div>
            )}

            <button
              type="button"
              onClick={handleApplyPlanChange}
              disabled={!preview || busy}
              className="self-start border border-settled px-3 py-1.5 text-settled hover:bg-settled hover:text-paper disabled:opacity-50"
            >
              Apply plan change
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

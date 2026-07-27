import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { stripe } from '../../stripe/client.js';
import { db } from '../../db/client.js';
import { customers, invoices, subscriptions } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { fromStripeSeconds, fromStripeSecondsOrNull } from '../../lib/time.js';
import type { HandlerResult } from './customer.js';

function resolveId(ref: string | { id: string } | null | undefined): string | undefined {
  if (!ref) return undefined;
  return typeof ref === 'string' ? ref : ref.id;
}

// As of this pinned API version, an invoice's subscription is NOT a
// top-level `invoice.subscription` field (that's the older shape most
// tutorials still show) — it moved under `invoice.parent`, a discriminated
// union keyed by `parent.type`. Getting this wrong doesn't error, it just
// silently returns undefined and every subscription invoice looks like a
// one-off — the same class of bug as the Basil period fields, just on a
// different object. See docs/ARCHITECTURE.md.
function resolveSubscriptionRef(invoice: Stripe.Invoice): string | undefined {
  if (invoice.parent?.type === 'subscription_details') {
    return resolveId(invoice.parent.subscription_details?.subscription ?? null);
  }
  return undefined;
}

export async function handleInvoiceEvent(event: Stripe.Event): Promise<HandlerResult> {
  const stripeInvoiceId = (event.data.object as { id: string }).id;
  const eventCreatedAt = fromStripeSeconds(event.created);

  const [existing] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.stripeInvoiceId, stripeInvoiceId));

  // Staleness guard (§5.7) — see the identical rationale in
  // handlers/subscription.ts.
  if (existing?.lastEventAt && existing.lastEventAt.getTime() > eventCreatedAt.getTime()) {
    const reason = `stale: event.created (${eventCreatedAt.toISOString()}) is older than last_event_at (${existing.lastEventAt.toISOString()})`;
    logger.info({ stripeInvoiceId, eventType: event.type, reason }, 'skipping stale invoice event');
    return { skipped: true, skipReason: reason };
  }

  let invoice: Stripe.Invoice;
  try {
    invoice = await stripe.invoices.retrieve(stripeInvoiceId);
  } catch (err) {
    if (err instanceof Stripe.errors.StripeInvalidRequestError && err.statusCode === 404) {
      // A draft invoice deleted before finalization no longer exists to
      // re-fetch. If we have a local row for it (from invoice.created),
      // remove it — it never represented a real, collectible invoice.
      if (existing) {
        await db.delete(invoices).where(eq(invoices.id, existing.id));
        logger.info({ stripeInvoiceId }, 'removed local row for a deleted draft invoice');
      }
      return {};
    }
    throw err;
  }

  const stripeCustomerId = resolveId(invoice.customer);
  if (!stripeCustomerId) {
    logger.warn({ stripeInvoiceId }, 'invoice has no customer; skipping');
    return {};
  }
  const [customerRow] = await db
    .select()
    .from(customers)
    .where(eq(customers.stripeCustomerId, stripeCustomerId));
  if (!customerRow) {
    throw new Error(
      `no local customer for Stripe customer ${stripeCustomerId} — customer.* events must be processed first`,
    );
  }

  // Invoices with no subscription are one-off invoices (§4) — subscriptionId
  // stays null, matching the "never enters dunning" rule for Phase 5.
  const stripeSubscriptionId = resolveSubscriptionRef(invoice);
  let localSubscriptionId: string | null = null;
  if (stripeSubscriptionId) {
    const [subRow] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));
    localSubscriptionId = subRow?.id ?? null;
    if (!localSubscriptionId) {
      logger.warn(
        { stripeInvoiceId, stripeSubscriptionId },
        'invoice references a subscription with no local row yet — storing invoice without the link for now',
      );
    }
  }

  const row = {
    customerId: customerRow.id,
    subscriptionId: localSubscriptionId,
    stripeInvoiceId: invoice.id!,
    number: invoice.number,
    status: invoice.status ?? 'draft',
    currency: invoice.currency,
    amountDueMinor: invoice.amount_due,
    amountPaidMinor: invoice.amount_paid,
    attemptCount: invoice.attempt_count,
    nextPaymentAttempt: fromStripeSecondsOrNull(invoice.next_payment_attempt),
    periodStart: fromStripeSeconds(invoice.period_start),
    periodEnd: fromStripeSeconds(invoice.period_end),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdfUrl: invoice.invoice_pdf ?? null,
    finalizedAt: fromStripeSecondsOrNull(invoice.status_transitions.finalized_at),
    paidAt: fromStripeSecondsOrNull(invoice.status_transitions.paid_at),
    lastEventAt: eventCreatedAt,
  };

  if (existing) {
    await db.update(invoices).set(row).where(eq(invoices.id, existing.id));
  } else {
    await db.insert(invoices).values(row);
  }

  return {};
}

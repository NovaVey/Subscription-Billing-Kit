import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { stripe } from '../../stripe/client.js';
import { db } from '../../db/client.js';
import { invoices, paymentAttempts } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { resolveId } from '../../stripe/refs.js';
import type { HandlerResult } from './customer.js';

// As of this pinned API version, PaymentIntent has no `invoice` field at
// all (older integrations widely assume `paymentIntent.invoice` exists —
// it doesn't here). The link now lives on InvoicePayment, queried by
// payment_intent id. See docs/ARCHITECTURE.md.
async function findInvoiceIdForPaymentIntent(paymentIntentId: string): Promise<string | undefined> {
  const page = await stripe.invoicePayments.list({
    payment: { type: 'payment_intent', payment_intent: paymentIntentId },
    limit: 1,
  });
  const match = page.data[0];
  return match ? resolveId(match.invoice) : undefined;
}

export async function handlePaymentIntentEvent(event: Stripe.Event): Promise<HandlerResult> {
  const paymentIntentId = (event.data.object as { id: string }).id;

  // Re-fetch rather than trust the payload (§5.6).
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

  const stripeInvoiceId = await findInvoiceIdForPaymentIntent(paymentIntent.id);
  if (!stripeInvoiceId) {
    // payment_attempts requires an invoice (§4) — a payment intent with no
    // invoice link isn't part of subscription billing's failure tracking.
    logger.info({ paymentIntentId }, 'payment_intent has no linked invoice; not recording a payment attempt');
    return {};
  }

  const [invoiceRow] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.stripeInvoiceId, stripeInvoiceId));
  if (!invoiceRow) {
    logger.warn(
      { paymentIntentId, stripeInvoiceId },
      'payment_intent references an invoice with no local row yet; not recording a payment attempt',
    );
    return {};
  }

  await db.insert(paymentAttempts).values({
    invoiceId: invoiceRow.id,
    stripePaymentIntentId: paymentIntent.id,
    status: 'failed',
    failureCode: paymentIntent.last_payment_error?.code ?? null,
    failureMessage: paymentIntent.last_payment_error?.message ?? null,
    amountMinor: paymentIntent.amount,
  });

  return {};
}

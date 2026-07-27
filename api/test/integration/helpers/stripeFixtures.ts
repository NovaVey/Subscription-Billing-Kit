import { randomUUID } from 'node:crypto';

// Realistic Stripe object shapes for this pinned API version, verified
// against the installed stripe SDK's own type definitions (not recalled
// from memory) - in particular: periods live on subscription items, not
// the subscription; an invoice's subscription lives at
// parent.subscription_details.subscription, not a top-level field.

let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}_test_${counter}_${randomUUID().slice(0, 8)}`;
}

export function fakePrice(overrides: Record<string, unknown> = {}) {
  return {
    id: id('price'),
    object: 'price',
    currency: 'usd',
    unit_amount: 2900,
    recurring: { interval: 'month', interval_count: 1 },
    metadata: { plan_code: 'starter' },
    ...overrides,
  };
}

export function fakeSubscriptionItem(overrides: Record<string, unknown> = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    id: id('si'),
    object: 'subscription_item',
    quantity: 1,
    price: fakePrice(),
    current_period_start: nowSeconds,
    current_period_end: nowSeconds + 30 * 24 * 60 * 60,
    ...overrides,
  };
}

export function fakeSubscription(overrides: Record<string, unknown> = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const items = (overrides['items'] as { data: unknown[] } | undefined)?.data ?? [fakeSubscriptionItem()];
  return {
    id: id('sub'),
    object: 'subscription',
    customer: id('cus'),
    status: 'active',
    currency: 'usd',
    trial_end: null,
    cancel_at_period_end: false,
    canceled_at: null,
    created: nowSeconds,
    items: { object: 'list', data: items, has_more: false, url: '/v1/subscription_items' },
    ...overrides,
  };
}

export function fakeCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: id('cus'),
    object: 'customer',
    email: 'test@example.com',
    name: 'Test Customer',
    delinquent: false,
    metadata: {},
    ...overrides,
  };
}

export function fakeInvoice(overrides: Record<string, unknown> = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    id: id('in'),
    object: 'invoice',
    customer: id('cus'),
    number: 'INV-0001',
    status: 'open',
    currency: 'usd',
    amount_due: 2900,
    amount_paid: 0,
    attempt_count: 0,
    next_payment_attempt: null,
    period_start: nowSeconds,
    period_end: nowSeconds + 30 * 24 * 60 * 60,
    hosted_invoice_url: 'https://invoice.stripe.com/test',
    invoice_pdf: 'https://invoice.stripe.com/test.pdf',
    parent: null,
    status_transitions: { finalized_at: null, paid_at: null },
    ...overrides,
  };
}

export function fakePaymentIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: id('pi'),
    object: 'payment_intent',
    amount: 2900,
    status: 'requires_payment_method',
    last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
    ...overrides,
  };
}

// Wraps a Stripe object in a minimal, realistic Event envelope - the same
// shape used by api/test/integration/helpers/webhookFixture.ts for the
// receiver tests, reused here for the processor/handlers, which read
// directly from a webhook_events row rather than an HTTP request.
export function fakeEvent(type: string, object: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: id('evt'),
    object: 'event',
    api_version: '2026-06-24.dahlia',
    created: Math.floor(Date.now() / 1000),
    type,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object },
    ...overrides,
  };
}

// The one place outbound idempotency keys get built (§5.5). No call site
// constructs its own — a timed-out create call that actually succeeded,
// followed by a naive retry, creates a second Stripe object and (for
// subscriptions) double-bills the customer. Inbound idempotency
// (webhook_events' primary key) gets all the attention; this is where the
// money actually goes missing if it's skipped.
//
// Customer creation is keyed on external_ref alone, with no timestamp: the
// same external_ref should never produce two Stripe customers, no matter
// how much later a retry arrives. Every other operation here includes a
// `requestedAt` the caller captures once per logical request (at the top
// of the route handler, before any Stripe call) — if that same operation
// is retried within this codebase (a caught network error, not a brand
// new HTTP request from our own API's caller), reusing the same
// `requestedAt` reproduces the same key and Stripe recognizes the retry.
function buildKey(parts: ReadonlyArray<string | number | boolean>): string {
  return parts.map(String).join(':');
}

export function customerCreateKey(externalRef: string): string {
  return buildKey(['customer', 'create', externalRef]);
}

export function checkoutSessionKey(
  customerId: string,
  priceId: string,
  quantity: number,
  requestedAt: Date,
): string {
  return buildKey(['checkout', customerId, priceId, quantity, requestedAt.toISOString()]);
}

export function portalSessionKey(customerId: string, requestedAt: Date): string {
  return buildKey(['portal', customerId, requestedAt.toISOString()]);
}

export function subscriptionPlanChangeKey(
  subscriptionId: string,
  priceId: string,
  requestedAt: Date,
): string {
  return buildKey(['sub', subscriptionId, 'plan', priceId, requestedAt.toISOString()]);
}

export function subscriptionCancelKey(
  subscriptionId: string,
  atPeriodEnd: boolean,
  requestedAt: Date,
): string {
  return buildKey(['sub', subscriptionId, 'cancel', atPeriodEnd, requestedAt.toISOString()]);
}

export function subscriptionResumeKey(subscriptionId: string, requestedAt: Date): string {
  return buildKey(['sub', subscriptionId, 'resume', requestedAt.toISOString()]);
}

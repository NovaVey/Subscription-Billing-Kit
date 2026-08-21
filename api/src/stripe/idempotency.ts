import type { FastifyRequest } from 'fastify';

// The one place outbound idempotency keys get built (§5.5). No call site
// constructs its own — a timed-out create call that actually succeeded,
// followed by a naive retry, creates a second Stripe object and (for
// subscriptions) double-bills the customer. Inbound idempotency
// (webhook_events' primary key) gets all the attention; this is where the
// money actually goes missing if it's skipped.
//
// Customer creation is keyed on external_ref alone, with no timestamp: the
// same external_ref should never produce two Stripe customers, no matter
// how much later a retry arrives.
//
// Every other operation here takes an IdempotencyContext instead of a bare
// timestamp - see its own doc comment for why. A pure per-request
// `requestedAt` (computed fresh server-side on every incoming HTTP request,
// as this used to work) only ever protects a same-process internal retry
// that reuses the same captured Date - a code path that doesn't exist
// anywhere in this codebase. The actual production failure mode is a
// *client*-side retry after network ambiguity (our own admin UI, or a
// merchant's integration, times out waiting for our response even though
// Stripe's call already succeeded) - completely unprotected by a
// server-generated-per-request timestamp, since the retry's new HTTP
// request computes a brand new one. See the deep bug hunt.
// Escapes '\' and ':' within a single part before it's joined below - each
// part must be unambiguously delimited from its neighbors, or a colon
// inside one part (a Stripe id is opaque to us; nothing guarantees one
// never contains one) can shift the apparent part boundary onto the next
// part and produce an identical joined string for two genuinely different
// operations. Was previously unescaped - see this file's test for the
// exact collision that was possible.
function escapePart(part: string | number | boolean): string {
  return String(part).replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

function buildKey(parts: ReadonlyArray<string | number | boolean>): string {
  return parts.map(escapePart).join(':');
}

// clientToken: an `Idempotency-Key` header the CALLER generates once per
// logical action and resends verbatim on its own retry. This is the only
// mechanism that can correctly distinguish "the client retried this exact
// request" from "the client made a new, coincidentally identical request"
// with full precision, so it always wins when present - it becomes the
// entire key (never joined with other parts via buildKey's unescaped ':'
// join, so a colon inside a client-supplied token can't collide with a
// different operation's key space the way buildKey's own pinned
// known-limitation test documents for its *other* callers).
//
// requestedAt: the fallback when no client token is supplied. Bucketed to
// the minute (not left at full millisecond precision) so a genuine retry
// a few seconds later - the real failure mode described above - still
// reproduces the same key, without permanently colliding with an
// unrelated, much later action against the same object the way a
// timestamp-free "stable forever" key would (a plan-change or resume
// against the same subscription weeks apart must never dedupe against
// each other).
export interface IdempotencyContext {
  clientToken?: string | undefined;
  requestedAt: Date;
}

function contextKey(parts: ReadonlyArray<string | number | boolean>, ctx: IdempotencyContext): string {
  if (ctx.clientToken) {
    return `client:${ctx.clientToken}`;
  }
  const bucketMs = Math.floor(ctx.requestedAt.getTime() / 60_000) * 60_000;
  return buildKey([...parts, new Date(bucketMs).toISOString()]);
}

// Reads a caller-supplied idempotency token off the standard
// `Idempotency-Key` header. Trimmed and length-capped defensively (Stripe
// itself caps idempotency keys at 255 characters) - not a security
// boundary, just a guard against an obviously-wrong header producing a
// confusing Stripe error instead of falling back cleanly.
export function clientIdempotencyToken(req: FastifyRequest): string | undefined {
  const header = req.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 255) : undefined;
}

export function customerCreateKey(externalRef: string): string {
  return buildKey(['customer', 'create', externalRef]);
}

export function checkoutSessionKey(
  customerId: string,
  priceId: string,
  quantity: number,
  ctx: IdempotencyContext,
): string {
  return contextKey(['checkout', customerId, priceId, quantity], ctx);
}

export function portalSessionKey(customerId: string, ctx: IdempotencyContext): string {
  return contextKey(['portal', customerId], ctx);
}

export function subscriptionPlanChangeKey(
  subscriptionId: string,
  priceId: string,
  ctx: IdempotencyContext,
): string {
  return contextKey(['sub', subscriptionId, 'plan', priceId], ctx);
}

export function subscriptionCancelKey(
  subscriptionId: string,
  atPeriodEnd: boolean,
  ctx: IdempotencyContext,
): string {
  return contextKey(['sub', subscriptionId, 'cancel', atPeriodEnd], ctx);
}

export function subscriptionResumeKey(subscriptionId: string, ctx: IdempotencyContext): string {
  return contextKey(['sub', subscriptionId, 'resume'], ctx);
}

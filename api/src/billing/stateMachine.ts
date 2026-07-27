import type { Executor } from '../db/client.js';
import { subscriptionEvents } from '../db/schema.js';
import { logger } from '../lib/logger.js';

// Mirrors Stripe's own Subscription.status enum exactly - there is no
// separate internal vocabulary to keep in sync with theirs.
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'paused'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired';

export const ALL_STATUSES: readonly SubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
  'canceled',
  'incomplete',
  'incomplete_expired',
];

// Explicit transition table, not scattered `if` statements (§5.8). This is
// deliberately a statement of what's *expected*, not what's *allowed*:
// Stripe is always the source of truth, so every transition - expected or
// not - gets applied and logged to subscription_events. An entry missing
// here only changes whether a warning gets logged and how the admin
// timeline (Phase 7) renders the row; it never blocks anything.
const EXPECTED_TRANSITIONS: Record<SubscriptionStatus, ReadonlySet<SubscriptionStatus>> = {
  incomplete: new Set<SubscriptionStatus>(['active', 'incomplete_expired', 'canceled']),
  incomplete_expired: new Set<SubscriptionStatus>(), // terminal
  trialing: new Set<SubscriptionStatus>(['active', 'past_due', 'canceled', 'unpaid', 'paused']),
  active: new Set<SubscriptionStatus>(['past_due', 'canceled', 'paused', 'unpaid']),
  past_due: new Set<SubscriptionStatus>(['active', 'canceled', 'unpaid']),
  unpaid: new Set<SubscriptionStatus>(['active', 'canceled', 'past_due']),
  paused: new Set<SubscriptionStatus>(['active', 'canceled']),
  canceled: new Set<SubscriptionStatus>(), // terminal
};

export function isExpectedTransition(
  from: SubscriptionStatus | null,
  to: SubscriptionStatus,
): boolean {
  if (from === null) return true; // first time we've seen this subscription
  if (from === to) return true; // re-sync with no status change, not a transition
  return EXPECTED_TRANSITIONS[from].has(to);
}

export interface TransitionInput {
  subscriptionId: string; // our uuid (subscriptions.id), not the Stripe id
  fromStatus: SubscriptionStatus | null;
  toStatus: SubscriptionStatus;
  reason: string; // webhook event type, or 'manual:<actor>' for admin actions
  actor?: string | null;
  note?: string | null;
  stripeEventId?: string | null;
}

export interface TransitionResult {
  expected: boolean;
}

// Writes the subscription_events row for a status transition - the one
// place this happens, so no code path (webhook-driven or a future manual
// admin action) can change a subscription's status without leaving an
// audit trail entry.
export async function recordTransition(
  tx: Executor,
  input: TransitionInput,
): Promise<TransitionResult> {
  const expected = isExpectedTransition(input.fromStatus, input.toStatus);
  if (!expected) {
    logger.warn(
      {
        subscriptionId: input.subscriptionId,
        from: input.fromStatus,
        to: input.toStatus,
        reason: input.reason,
      },
      'unexpected subscription state transition — applying anyway, Stripe is the source of truth',
    );
  }
  await tx.insert(subscriptionEvents).values({
    subscriptionId: input.subscriptionId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    reason: input.reason,
    actor: input.actor ?? null,
    note: input.note ?? null,
    stripeEventId: input.stripeEventId ?? null,
  });
  return { expected };
}

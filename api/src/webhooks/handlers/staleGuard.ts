import { logger } from '../../lib/logger.js';
import type { HandlerResult } from './customer.js';

// Skips an event whose event.created is older than the newest one already
// applied to this row - not because a re-fetch would return wrong data (it
// always returns current truth), but because applying an out-of-order
// event's semantics would write a subscription_events/timeline entry that
// reads as nonsense and could re-trigger logic tied to that event type.
// Combined with re-fetching, ordering stops mattering (§5.7).
//
// Shared by the subscription and invoice webhook handlers - previously
// duplicated verbatim in both, differing only in the id field name and log
// message. See the /improve audit.
//
// Returns a HandlerResult to return immediately if the event is stale, or
// null to continue processing.
export function staleGuard(input: {
  entityLabel: string; // e.g. 'subscription' | 'invoice' - only used in the log message
  logFields: Record<string, unknown>; // e.g. { stripeSubscriptionId } or { stripeInvoiceId }
  eventType: string;
  lastEventAt: Date | null | undefined;
  eventCreatedAt: Date;
}): HandlerResult | null {
  const { entityLabel, logFields, eventType, lastEventAt, eventCreatedAt } = input;
  if (!lastEventAt || lastEventAt.getTime() <= eventCreatedAt.getTime()) {
    return null;
  }
  const reason = `stale: event.created (${eventCreatedAt.toISOString()}) is older than last_event_at (${lastEventAt.toISOString()})`;
  logger.info({ ...logFields, eventType, reason }, `skipping stale ${entityLabel} event`);
  return { skipped: true, skipReason: reason };
}

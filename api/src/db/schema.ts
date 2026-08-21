import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Idempotency ledger. Every webhook lands here FIRST, before any logic — see
// docs/ARCHITECTURE.md (persist-ack-process, inbound idempotency).
export const webhookEvents = pgTable(
  'webhook_events',
  {
    stripeEventId: text('stripe_event_id').primaryKey(),
    type: text('type').notNull(),
    // Stripe's event.api_version — see docs/ARCHITECTURE.md §5.1.
    apiVersion: text('api_version'),
    eventCreatedAt: timestamp('event_created_at', { withTimezone: true }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    // Lease start — see the reaper (Phase 3).
    processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    status: text('status').notNull().default('received'), // received|processing|processed|failed|skipped
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastError: text('last_error'),
  },
  (t) => [
    index('webhook_events_status_next_attempt_received_idx').on(
      t.status,
      t.nextAttemptAt,
      t.receivedAt,
    ),
    index('webhook_events_status_processing_started_idx').on(t.status, t.processingStartedAt),
    index('webhook_events_type_event_created_idx').on(t.type, t.eventCreatedAt),
    // The three indexes above all lead with status or type - none serves
    // GET /admin/webhook-events' default (unfiltered) view, which sorts the
    // whole table by received_at desc. See the /improve audit.
    index('webhook_events_received_at_idx').on(t.receivedAt),
  ],
);

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  externalRef: text('external_ref').unique(), // the client app's own user/org id
  stripeCustomerId: text('stripe_customer_id').unique().notNull(),
  email: text('email').notNull(),
  name: text('name'),
  delinquent: boolean('delinquent').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    stripeSubscriptionId: text('stripe_subscription_id').unique().notNull(),
    status: text('status').notNull(), // see docs/STATE-MACHINE.md
    planCode: text('plan_code').notNull(),
    currency: text('currency').notNull(),
    trialEnd: timestamp('trial_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    // DERIVED for display and dunning only: min(items.current_period_end).
    // Billing periods live on items, not here. See docs/ARCHITECTURE.md §5.1 —
    // this column does not exist on the Stripe subscription object post-Basil.
    nextPeriodEndDerived: timestamp('next_period_end_derived', { withTimezone: true }),
    // Staleness guard: the event.created of the newest event applied to this row.
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('subscriptions_status_idx').on(t.status),
    index('subscriptions_customer_id_idx').on(t.customerId),
    // GET /subscriptions orders every call by created_at desc and uses it as
    // the keyset-pagination cursor column - including the default,
    // unfiltered first page. See the /improve audit.
    index('subscriptions_created_at_idx').on(t.createdAt),
  ],
);

// Periods are per-item. A subscription can mix intervals, so items on the
// same subscription can be in different periods. See docs/ARCHITECTURE.md §5.1.
export const subscriptionItems = pgTable(
  'subscription_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    stripeItemId: text('stripe_item_id').unique().notNull(),
    priceId: text('price_id').notNull(),
    quantity: integer('quantity').notNull().default(1),
    unitAmountMinor: integer('unit_amount_minor').notNull(),
    currency: text('currency').notNull(),
    recurringInterval: text('recurring_interval'), // month|year|week|day
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => [index('subscription_items_subscription_id_idx').on(t.subscriptionId)],
);

export const subscriptionEvents = pgTable(
  'subscription_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    reason: text('reason').notNull(), // webhook type, or 'manual:<actor>' for admin actions
    actor: text('actor'), // set for manual actions
    note: text('note'),
    stripeEventId: text('stripe_event_id').references(() => webhookEvents.stripeEventId),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Queried by subscriptionId on every subscription detail page load; this
  // table grows by one row per state transition, forever. See the /improve audit.
  (t) => [index('subscription_events_subscription_id_idx').on(t.subscriptionId)],
);

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id), // null for one-off invoices
    // The raw Stripe subscription id an invoice references, stored even
    // when subscription_id (above) is still null - an invoice.* event
    // claimed before its subscription's own customer.subscription.created
    // has been processed (processor.ts orders by receivedAt, not Stripe's
    // event.created) previously had no way to ever find its subscription
    // again once the local row eventually appeared, permanently losing the
    // link and, for a payment_failed invoice, the dunning trigger it
    // should have opened. syncSubscriptionFromStripe re-links every
    // orphaned row matching this column when it creates a subscription's
    // local row for the first time - see relinkOrphanedInvoices in sync.ts.
    // Null for a one-off invoice, same as subscription_id. See the deep
    // bug hunt.
    stripeSubscriptionId: text('stripe_subscription_id'),
    stripeInvoiceId: text('stripe_invoice_id').unique().notNull(),
    number: text('number'),
    status: text('status').notNull(), // draft|open|paid|uncollectible|void
    currency: text('currency').notNull(),
    // Stripe's own invoice.created, not this row's own insert time -
    // reconciliation windows local invoices by this same field Stripe's
    // own list query windows by (finding #18, deep bug hunt), which
    // finalized_at (below) can't do: it's permanently null for a draft
    // that never finalizes, and can land in a different day's window than
    // created for a normally-finalizing invoice (Stripe's ~1hr
    // charge_automatically auto-finalize delay). Nullable, not backfilled
    // for rows that predate this column - every invoice.ts upsert
    // (including a plain re-sync with no real change) sets it, so an
    // existing row gets it filled in on its own next Stripe event; only a
    // dormant pre-migration invoice that never receives another event
    // stays excluded from reconciliation's local-side window in the
    // meantime. See the deep bug hunt.
    createdAt: timestamp('created_at', { withTimezone: true }),
    amountDueMinor: integer('amount_due_minor').notNull(),
    amountPaidMinor: integer('amount_paid_minor').notNull().default(0),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextPaymentAttempt: timestamp('next_payment_attempt', { withTimezone: true }),
    periodStart: timestamp('period_start', { withTimezone: true }),
    periodEnd: timestamp('period_end', { withTimezone: true }),
    hostedInvoiceUrl: text('hosted_invoice_url'),
    invoicePdfUrl: text('invoice_pdf_url'),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  },
  (t) => [
    index('invoices_subscription_id_status_idx').on(t.subscriptionId, t.status),
    // GET /invoices filters by customer_id and always orders by
    // period_start desc, neither of which the composite index above serves.
    // See the /improve audit.
    index('invoices_customer_id_idx').on(t.customerId),
    index('invoices_period_start_idx').on(t.periodStart),
    // Reconciliation's local-side query now windows by created_at
    // (finding #18, deep bug hunt) - same reasoning as the period_start
    // index above.
    index('invoices_created_at_idx').on(t.createdAt),
    // relinkOrphanedInvoices' own lookup (finding #21, deep bug hunt) -
    // every orphaned row for a given Stripe subscription id, found the
    // moment that subscription's local row is first created.
    index('invoices_stripe_subscription_id_idx').on(t.stripeSubscriptionId),
  ],
);

export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    status: text('status').notNull(), // succeeded|failed|requires_action
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    amountMinor: integer('amount_minor').notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A given Stripe payment_intent should only ever produce one attempt
    // row, no matter how many times the webhook that recorded it gets
    // reprocessed (a retry after a transient finalize failure, a reaped
    // lease, an admin replay). See the deep bug hunt.
    unique('payment_attempts_stripe_payment_intent_id_key').on(t.stripePaymentIntentId),
  ],
);

export const dunningState = pgTable('dunning_state', {
  subscriptionId: uuid('subscription_id')
    .primaryKey()
    .references(() => subscriptions.id),
  // The specific invoice that opened this dunning cycle. Resolution only
  // counts when THIS invoice is paid, not any invoice for the customer.
  triggeringInvoiceId: uuid('triggering_invoice_id').references(() => invoices.id),
  stage: integer('stage').notNull().default(0), // 0 healthy, 1..3 escalation, 4 terminal
  enteredStageAt: timestamp('entered_stage_at', { withTimezone: true }),
  nextActionAt: timestamp('next_action_at', { withTimezone: true }),
  lastNoticeAt: timestamp('last_notice_at', { withTimezone: true }),
  noticesSent: integer('notices_sent').notNull().default(0),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolution: text('resolution'), // recovered|canceled|manual
});

export const dunningNotices = pgTable(
  'dunning_notices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id),
    stage: integer('stage').notNull(),
    channel: text('channel').notNull(), // email|in_app|webhook_out
    template: text('template').notNull(),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }), // null until the adapter confirms
    sendError: text('send_error'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
  },
  // One notice per stage, enforced by the DB — see docs/ARCHITECTURE.md (dunning).
  (t) => [unique('dunning_notices_subscription_id_stage_unique').on(t.subscriptionId, t.stage)],
);

export interface ReconciliationReportEntry {
  type: 'field_drift' | 'missing_local' | 'orphan_local';
  stripeInvoiceId: string;
  field?: string;
  stripeValue?: unknown;
  localValue?: unknown;
}

export const reconciliationRuns = pgTable('reconciliation_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  currency: text('currency').notNull(), // totals are per-currency, never summed across
  // number-mode bigint (safe to 2^53-1): a 90-day total in minor units
  // overflows int4 above ~21.5M USD.
  stripeTotalMinor: bigint('stripe_total_minor', { mode: 'number' }).notNull(),
  localTotalMinor: bigint('local_total_minor', { mode: 'number' }).notNull(),
  invoiceCountStripe: integer('invoice_count_stripe').notNull(),
  invoiceCountLocal: integer('invoice_count_local').notNull(),
  mismatchCount: integer('mismatch_count').notNull(),
  report: jsonb('report').$type<ReconciliationReportEntry[]>().notNull(),
});

// Mirrors api/src/db/schema.ts and the route response shapes in
// api/src/routes/*.ts. Timestamps arrive as ISO strings over JSON.

export interface SubscriptionListRow {
  id: string;
  status: string;
  planCode: string;
  currency: string;
  mrrMinor: number;
  nextPeriodEndDerived: string | null;
  dunningStage: number;
  customerEmail: string;
  customerExternalRef: string | null;
}

export interface SubscriptionListResponse {
  subscriptions: SubscriptionListRow[];
  nextCursor: string | null;
}

export interface Customer {
  id: string;
  externalRef: string | null;
  stripeCustomerId: string;
  email: string;
  name: string | null;
  delinquent: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Subscription {
  id: string;
  customerId: string;
  stripeSubscriptionId: string;
  status: string;
  planCode: string;
  currency: string;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  nextPeriodEndDerived: string | null;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionItem {
  id: string;
  subscriptionId: string;
  stripeItemId: string;
  priceId: string;
  quantity: number;
  unitAmountMinor: number;
  currency: string;
  recurringInterval: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  removedAt: string | null;
}

export interface SubscriptionEvent {
  id: string;
  subscriptionId: string;
  fromStatus: string | null;
  toStatus: string;
  reason: string;
  actor: string | null;
  note: string | null;
  stripeEventId: string | null;
  occurredAt: string;
}

export interface Invoice {
  id: string;
  customerId: string;
  customerEmail?: string;
  subscriptionId: string | null;
  stripeInvoiceId: string;
  number: string | null;
  status: string;
  currency: string;
  amountDueMinor: number;
  amountPaidMinor: number;
  attemptCount: number;
  nextPaymentAttempt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  finalizedAt: string | null;
  paidAt: string | null;
  lastEventAt: string | null;
}

export interface DunningState {
  subscriptionId: string;
  triggeringInvoiceId: string | null;
  stage: number;
  enteredStageAt: string | null;
  nextActionAt: string | null;
  lastNoticeAt: string | null;
  noticesSent: number;
  resolvedAt: string | null;
  resolution: string | null;
}

export interface SubscriptionDetailResponse {
  subscription: Subscription;
  customer: Customer | null;
  items: SubscriptionItem[];
  timeline: SubscriptionEvent[];
  invoices: Invoice[];
  dunning: DunningState | null;
}

export interface InvoiceListResponse {
  invoices: Invoice[];
}

export interface DunningQueueRow {
  subscriptionId: string;
  stage: number;
  daysInStage: number | null;
  nextActionAt: string | null;
  triggeringInvoiceId: string | null;
  amountAtRiskMinor: number | null;
  currency: string | null;
  noticesSent: number;
  planCode: string;
  subscriptionStatus: string;
  customerEmail: string;
  customerExternalRef: string | null;
}

export interface DunningQueueResponse {
  queue: DunningQueueRow[];
}

export interface WebhookEvent {
  stripeEventId: string;
  type: string;
  apiVersion: string | null;
  eventCreatedAt: string;
  payload: Record<string, unknown>;
  receivedAt: string;
  processingStartedAt: string | null;
  processedAt: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
}

export interface WebhookEventListResponse {
  events: WebhookEvent[];
}

export interface ReconciliationReportEntry {
  type: 'field_drift' | 'missing_local' | 'orphan_local';
  stripeInvoiceId: string;
  field?: string;
  stripeValue?: unknown;
  localValue?: unknown;
}

export interface ReconciliationRun {
  id: string;
  periodStart: string;
  periodEnd: string;
  ranAt: string;
  currency: string;
  stripeTotalMinor: number;
  localTotalMinor: number;
  invoiceCountStripe: number;
  invoiceCountLocal: number;
  mismatchCount: number;
  report: ReconciliationReportEntry[];
}

export interface ReconciliationRunListResponse {
  runs: ReconciliationRun[];
}

// POST /admin/reconciliation/run's live response shape (billing/reconcile.ts's
// RunReconciliationResult) - "entries", not the stored row's "report".
export interface ReconciliationRunResult {
  runId: string;
  entries: ReconciliationReportEntry[];
  stripeTotalMinor: number;
  localTotalMinor: number;
  mismatchCount: number;
  invoiceCountStripe: number;
  invoiceCountLocal: number;
}

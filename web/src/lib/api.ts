import type {
  DunningQueueResponse,
  InvoiceListResponse,
  ReconciliationRunDetail,
  ReconciliationRunListResponse,
  ReconciliationRunResult,
  SubscriptionDetailResponse,
  SubscriptionListResponse,
  WebhookEventDetail,
  WebhookEventListResponse,
} from './types';
import { clearAdminKey, getAdminKey } from './adminKey';

// API_BASE_URL is the server's own env var name (§2); VITE_ prefixes are
// how Vite exposes build-time env vars to client code, so this is that
// same value under Vite's naming convention, not a second source of truth.
const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000';

export class ApiError extends Error {
  status: number;
  details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const adminKey = getAdminKey();
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      // Only set when there's an actual body to describe - Fastify's default
      // JSON body parser rejects "content-type: application/json" paired
      // with an empty body outright (a real bug this caught: resumeSubscription
      // and replayWebhookEvent both POST with no body and were failing with a
      // 400 in a real browser, invisible to the API's own app.inject-based
      // tests since inject never sent this header without a payload either).
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(adminKey ? { Authorization: `Bearer ${adminKey}` } : {}),
      ...init?.headers,
    },
  });
  if (response.status === 401) {
    // The stored key is missing or wrong (Phase 10) - clear it and reload so
    // AdminGate reprompts, rather than surfacing a confusing "unauthorized"
    // toast on whatever page happened to be open. The reload normally tears
    // down this whole page within milliseconds, but if something ever blocks
    // it (an embedding iframe, a beforeunload handler), this promise must
    // still eventually settle - otherwise every caller's `finally` (button
    // busy-state, loading spinners) would stay stuck forever with no way out.
    clearAdminKey();
    window.location.reload();
    return new Promise<T>((_, reject) => {
      setTimeout(() => reject(new ApiError(401, 'admin key was rejected; reloading')), 5000);
    });
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, body.error ?? `request failed (${response.status})`, body.details);
  }
  return response.json() as Promise<T>;
}

export function listSubscriptions(params: {
  status?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}): Promise<SubscriptionListResponse> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.q) qs.set('q', params.q);
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.limit) qs.set('limit', String(params.limit));
  return request(`/subscriptions?${qs.toString()}`);
}

export function getSubscription(id: string): Promise<SubscriptionDetailResponse> {
  return request(`/subscriptions/${id}`);
}

export function previewPlanChange(
  id: string,
  params: { price_id: string; quantity: number; proration_behavior: string },
): Promise<{ currency: string; amount_due: number; total: number; lines: unknown[] }> {
  const qs = new URLSearchParams({
    price_id: params.price_id,
    quantity: String(params.quantity),
    proration_behavior: params.proration_behavior,
  });
  return request(`/subscriptions/${id}/preview?${qs.toString()}`);
}

export function applyPlanChange(
  id: string,
  body: { price_id: string; quantity: number; proration_behavior: string },
): Promise<{ id: string; status: string }> {
  return request(`/subscriptions/${id}/plan`, { method: 'POST', body: JSON.stringify(body) });
}

export function cancelSubscription(id: string, atPeriodEnd: boolean): Promise<{ id: string; status: string }> {
  return request(`/subscriptions/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ at_period_end: atPeriodEnd }),
  });
}

export function resumeSubscription(id: string): Promise<{ id: string; status: string }> {
  return request(`/subscriptions/${id}/resume`, { method: 'POST' });
}

export function listInvoices(params: { customer_id?: string; status?: string; limit?: number }): Promise<
  InvoiceListResponse
> {
  const qs = new URLSearchParams();
  if (params.customer_id) qs.set('customer_id', params.customer_id);
  if (params.status) qs.set('status', params.status);
  if (params.limit) qs.set('limit', String(params.limit));
  return request(`/invoices?${qs.toString()}`);
}

export function getDunningQueue(): Promise<DunningQueueResponse> {
  return request('/dunning/queue');
}

export function resolveDunning(
  subscriptionId: string,
  body: { resolution: 'recovered' | 'canceled' | 'manual'; note: string },
): Promise<{ subscriptionId: string; resolution: string }> {
  return request(`/dunning/${subscriptionId}/resolve`, { method: 'POST', body: JSON.stringify(body) });
}

export function listWebhookEvents(params: { status?: string; type?: string; limit?: number }): Promise<
  WebhookEventListResponse
> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.type) qs.set('type', params.type);
  if (params.limit) qs.set('limit', String(params.limit));
  return request(`/admin/webhook-events?${qs.toString()}`);
}

export function replayWebhookEvent(id: string): Promise<{ stripeEventId: string; status: string }> {
  return request(`/admin/webhook-events/${id}/replay`, { method: 'POST' });
}

// Fetched on demand when a single row is expanded - the list response no
// longer carries `payload` (§ efficiency: /improve audit).
export function getWebhookEvent(id: string): Promise<WebhookEventDetail> {
  return request(`/admin/webhook-events/${id}`);
}

export function listReconciliationRuns(): Promise<ReconciliationRunListResponse> {
  return request('/admin/reconciliation');
}

// Fetched on demand when a single run is drilled into - the list response no
// longer carries `report` (§ efficiency: /improve audit).
export function getReconciliationRun(id: string): Promise<ReconciliationRunDetail> {
  return request(`/admin/reconciliation/${id}`);
}

export function runReconciliation(body: {
  period_start: string;
  period_end: string;
  currency: string;
}): Promise<ReconciliationRunResult> {
  return request('/admin/reconciliation/run', { method: 'POST', body: JSON.stringify(body) });
}

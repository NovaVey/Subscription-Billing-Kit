import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mswServer';
import {
  ApiError,
  applyPlanChange,
  cancelSubscription,
  replayWebhookEvent,
  resolveDunning,
  resumeSubscription,
  runReconciliation,
} from '../../src/lib/api';
import { getAdminKey, setAdminKey } from '../../src/lib/adminKey';

const BASE_URL = 'http://localhost:3000';

type Captured = { headers: Headers; bodyText: string };

// Registers a one-shot MSW handler for `${BASE_URL}${path}` and resolves
// with the headers/body it actually received, so assertions below inspect
// what fetch really sent rather than what the source merely intends to send.
function captureRequest(path: string, status = 200, responseBody: Record<string, unknown> = {}): Promise<Captured> {
  let resolveCaptured!: (c: Captured) => void;
  const captured = new Promise<Captured>((resolve) => {
    resolveCaptured = resolve;
  });
  server.use(
    http.post(`${BASE_URL}${path}`, async ({ request }) => {
      const bodyText = await request.text();
      resolveCaptured({ headers: request.headers, bodyText });
      return HttpResponse.json(responseBody, { status });
    }),
  );
  return captured;
}

let originalLocation: Location;

beforeEach(() => {
  sessionStorage.clear();
  originalLocation = window.location;
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  vi.useRealTimers();
});

// Replaces window.location with a stand-in whose `reload` is a spy, since
// jsdom's real Location.reload is non-configurable and can't be vi.spyOn'd
// directly (it throws "Cannot redefine property: reload").
function stubLocationReload() {
  const reloadMock = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, reload: reloadMock },
  });
  return reloadMock;
}

describe('request() Content-Type handling', () => {
  // This is the single most important test in this file: it directly
  // guards the real production bug (Fastify 400s on Content-Type paired
  // with an empty body) that resumeSubscription/replayWebhookEvent hit in
  // a real browser - see the comment above request() in src/lib/api.ts.
  describe('omits Content-Type and sends no body for no-body POST calls', () => {
    it('resumeSubscription', async () => {
      const captured = captureRequest('/subscriptions/sub_123/resume', 200, { id: 'sub_123', status: 'active' });

      await resumeSubscription('sub_123');

      const { headers, bodyText } = await captured;
      expect(headers.has('content-type')).toBe(false);
      expect(bodyText).toBe('');
    });

    it('replayWebhookEvent', async () => {
      const captured = captureRequest('/admin/webhook-events/evt_123/replay', 200, {
        stripeEventId: 'evt_123',
        status: 'replayed',
      });

      await replayWebhookEvent('evt_123');

      const { headers, bodyText } = await captured;
      expect(headers.has('content-type')).toBe(false);
      expect(bodyText).toBe('');
    });
  });

  describe('sends Content-Type: application/json and a matching JSON body for body-bearing calls', () => {
    it('applyPlanChange', async () => {
      const payload = { price_id: 'price_456', quantity: 2, proration_behavior: 'create_prorations' };
      const captured = captureRequest('/subscriptions/sub_123/plan', 200, { id: 'sub_123', status: 'active' });

      await applyPlanChange('sub_123', payload);

      const { headers, bodyText } = await captured;
      expect(headers.get('content-type')).toBe('application/json');
      expect(JSON.parse(bodyText)).toEqual(payload);
    });

    it('cancelSubscription', async () => {
      const captured = captureRequest('/subscriptions/sub_123/cancel', 200, { id: 'sub_123', status: 'canceled' });

      await cancelSubscription('sub_123', true);

      const { headers, bodyText } = await captured;
      expect(headers.get('content-type')).toBe('application/json');
      expect(JSON.parse(bodyText)).toEqual({ at_period_end: true });
    });

    it('resolveDunning', async () => {
      const payload = { resolution: 'recovered' as const, note: 'customer paid manually over the phone' };
      const captured = captureRequest('/dunning/sub_123/resolve', 200, {
        subscriptionId: 'sub_123',
        resolution: 'recovered',
      });

      await resolveDunning('sub_123', payload);

      const { headers, bodyText } = await captured;
      expect(headers.get('content-type')).toBe('application/json');
      expect(JSON.parse(bodyText)).toEqual(payload);
    });

    it('runReconciliation', async () => {
      const payload = { period_start: '2026-01-01', period_end: '2026-01-31', currency: 'usd' };
      const captured = captureRequest('/admin/reconciliation/run', 200, { id: 'run_1', status: 'completed' });

      await runReconciliation(payload);

      const { headers, bodyText } = await captured;
      expect(headers.get('content-type')).toBe('application/json');
      expect(JSON.parse(bodyText)).toEqual(payload);
    });
  });
});

describe('request() 401 handling', () => {
  it('clears the stored admin key and reloads exactly once', async () => {
    setAdminKey('test-admin-key');
    const reloadMock = stubLocationReload();
    server.use(
      http.post(`${BASE_URL}/subscriptions/sub_123/cancel`, () =>
        HttpResponse.json({ error: 'unauthorized' }, { status: 401 }),
      ),
    );

    // Don't await the call itself - request() never settles on the happy
    // path here within this tick (it's waiting out the 5s fallback timer),
    // but the clearAdminKey()/reload() side effects happen synchronously
    // once the 401 response arrives, before that timer is even started.
    const promise = cancelSubscription('sub_123', false);
    // Swallow the eventual rejection here; it's asserted precisely below.
    promise.catch(() => {});

    await vi.waitFor(() => {
      expect(reloadMock).toHaveBeenCalledTimes(1);
    });
    expect(getAdminKey()).toBeNull();
  });

  it('the returned promise still eventually rejects with a 401 ApiError after 5s, so a caller .finally() cannot hang forever', async () => {
    setAdminKey('test-admin-key');
    const reloadMock = stubLocationReload();
    server.use(
      http.post(`${BASE_URL}/subscriptions/sub_123/cancel`, () =>
        HttpResponse.json({ error: 'unauthorized' }, { status: 401 }),
      ),
    );

    vi.useFakeTimers();

    const promise = cancelSubscription('sub_123', false);
    // The 401 branch clears the key and calls reload() as soon as the
    // (real, MSW-mocked) network response arrives - fake timers only affect
    // setTimeout/setInterval, not that underlying I/O, so this still
    // resolves without needing to advance the clock.
    await vi.waitFor(() => {
      expect(reloadMock).toHaveBeenCalledTimes(1);
    });

    const assertion = expect(promise).rejects.toMatchObject({
      status: 401,
      message: 'admin key was rejected; reloading',
    });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    const rejected = await promise.catch((err: unknown) => err);
    expect(rejected).toBeInstanceOf(ApiError);
  });
});

describe('request() 403 handling', () => {
  it('rejects with the server-provided message and does not clear the admin key or reload', async () => {
    setAdminKey('test-admin-key');
    const reloadMock = stubLocationReload();
    server.use(
      http.post(`${BASE_URL}/subscriptions/sub_123/cancel`, () =>
        HttpResponse.json({ error: 'read-only key cannot perform this action' }, { status: 403 }),
      ),
    );

    await expect(cancelSubscription('sub_123', false)).rejects.toMatchObject({
      status: 403,
      message: 'read-only key cannot perform this action',
    });

    expect(getAdminKey()).toBe('test-admin-key');
    expect(reloadMock).not.toHaveBeenCalled();
  });
});

describe('request() malformed/non-JSON error body fallback', () => {
  it('falls back to a generic "request failed (<status>)" ApiError instead of throwing a JSON-parse error', async () => {
    server.use(
      http.post(
        `${BASE_URL}/subscriptions/sub_123/cancel`,
        () => new HttpResponse('Internal Server Error', { status: 500, headers: { 'Content-Type': 'text/plain' } }),
      ),
    );

    await expect(cancelSubscription('sub_123', false)).rejects.toMatchObject({
      status: 500,
      message: 'request failed (500)',
    });
  });
});

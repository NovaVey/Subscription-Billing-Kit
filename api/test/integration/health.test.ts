import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// GET /health was Phase 0's own exit criterion ("npm run dev serves /health
// returning db status, stripe status, and the pinned API version") and is
// the first line of §6's API surface, but had never once been asserted
// against by an automated test - only ever checked manually with curl.
const mockCheckStripeConnectivity = vi.fn();

vi.mock('../../src/stripe/client.js', () => ({
  stripe: {},
  checkStripeConnectivity: () => mockCheckStripeConnectivity(),
}));

const { buildApp } = await import('../../src/app.js');
const { env } = await import('../../src/env.js');
const { pool } = await import('../../src/db/client.js');

const app = buildApp();

beforeEach(() => {
  mockCheckStripeConnectivity.mockReset();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('GET /health', () => {
  it('reports db ok, stripe ok, and the pinned api version when everything is reachable', async () => {
    mockCheckStripeConnectivity.mockResolvedValueOnce({ ok: true, accountId: 'acct_test_123' });

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.db.ok).toBe(true);
    expect(body.stripe.ok).toBe(true);
    expect(body.stripe.apiVersion).toBe(env.STRIPE_API_VERSION);
    expect(() => new Date(body.time).toISOString()).not.toThrow();
  });

  it('returns 503 and status degraded when Stripe is unreachable, while still reporting the pinned version', async () => {
    mockCheckStripeConnectivity.mockResolvedValueOnce({ ok: false, error: 'connect ETIMEDOUT' });

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('degraded');
    expect(body.db.ok).toBe(true);
    expect(body.stripe.ok).toBe(false);
    expect(body.stripe.apiVersion).toBe(env.STRIPE_API_VERSION);
  });
});

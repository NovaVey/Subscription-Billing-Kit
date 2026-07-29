import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { pool } from '../../src/db/client.js';
import { WRITE_KEY_HEADERS, READONLY_KEY_HEADERS } from './helpers/adminAuth.js';

// Proves the Phase 10 admin auth gate itself, not the business logic behind
// each route - that's already covered where each route's own tests live
// (adminEndpoints.test.ts, dunningReconciliationRoutes.test.ts,
// checkoutPortalPlanChange.test.ts), all of which now send WRITE_KEY_HEADERS.
// Fastify runs preHandler hooks before a route's own body/param handling, so
// a nonexistent id is fine here - the auth check always happens first.
const app = buildApp();

afterAll(async () => {
  await app.close();
  await pool.end();
});

const ADMIN_GET_ROUTES = [
  { method: 'GET' as const, url: '/subscriptions' },
  { method: 'GET' as const, url: '/subscriptions/00000000-0000-0000-0000-000000000000' },
  { method: 'GET' as const, url: '/subscriptions/00000000-0000-0000-0000-000000000000/preview?price_id=price_x&quantity=1' },
  { method: 'GET' as const, url: '/invoices' },
  { method: 'GET' as const, url: '/dunning/queue' },
  { method: 'GET' as const, url: '/admin/reconciliation' },
  { method: 'GET' as const, url: '/admin/webhook-events' },
];

const ADMIN_MUTATING_ROUTES = [
  { method: 'POST' as const, url: '/subscriptions/00000000-0000-0000-0000-000000000000/plan' },
  { method: 'POST' as const, url: '/subscriptions/00000000-0000-0000-0000-000000000000/cancel' },
  { method: 'POST' as const, url: '/subscriptions/00000000-0000-0000-0000-000000000000/resume' },
  { method: 'POST' as const, url: '/dunning/00000000-0000-0000-0000-000000000000/resolve' },
  { method: 'POST' as const, url: '/admin/reconciliation/run' },
  { method: 'POST' as const, url: '/admin/webhook-events/evt_does_not_exist/replay' },
];

describe('admin routes reject requests with no valid key', () => {
  for (const route of [...ADMIN_GET_ROUTES, ...ADMIN_MUTATING_ROUTES]) {
    it(`${route.method} ${route.url} returns 401 with no Authorization header`, async () => {
      const response = await app.inject({ method: route.method, url: route.url });
      expect(response.statusCode).toBe(401);
    });

    it(`${route.method} ${route.url} returns 401 with a key that matches neither tier`, async () => {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: { authorization: 'Bearer not-a-real-key' },
      });
      expect(response.statusCode).toBe(401);
    });
  }
});

describe('the read-only key', () => {
  for (const route of ADMIN_GET_ROUTES) {
    it(`allows ${route.method} ${route.url}`, async () => {
      const response = await app.inject({ method: route.method, url: route.url, headers: READONLY_KEY_HEADERS });
      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).not.toBe(403);
    });
  }

  for (const route of ADMIN_MUTATING_ROUTES) {
    it(`rejects ${route.method} ${route.url} with 403, not 401 - the key is valid, just insufficient`, async () => {
      const response = await app.inject({ method: route.method, url: route.url, headers: READONLY_KEY_HEADERS });
      expect(response.statusCode).toBe(403);
    });
  }
});

describe('the write key allows both GET and mutating routes past the gate', () => {
  for (const route of [...ADMIN_GET_ROUTES, ...ADMIN_MUTATING_ROUTES]) {
    it(`${route.method} ${route.url} is not rejected by the auth gate itself`, async () => {
      const response = await app.inject({ method: route.method, url: route.url, headers: WRITE_KEY_HEADERS });
      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).not.toBe(403);
    });
  }
});

describe('HEAD requests are treated as read-only, like GET', () => {
  it('a HEAD request with the readonly key is not rejected as a mutation', async () => {
    // Fastify registers a HEAD sibling for every GET route by default -
    // HEAD is side-effect-free, same as GET, so the readonly key must be
    // allowed here too, not just on GET itself.
    const response = await app.inject({ method: 'HEAD', url: '/subscriptions', headers: READONLY_KEY_HEADERS });
    expect(response.statusCode).not.toBe(403);
  });
});

describe('public and special routes are never gated by the admin key', () => {
  it('GET /health does not require a key', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).not.toBe(401);
  });

  it('POST /customers reaches its own body validation rather than the admin gate', async () => {
    const response = await app.inject({ method: 'POST', url: '/customers', payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it('POST /checkout/sessions reaches its own body validation rather than the admin gate', async () => {
    const response = await app.inject({ method: 'POST', url: '/checkout/sessions', payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it('POST /portal/sessions reaches its own body validation rather than the admin gate', async () => {
    const response = await app.inject({ method: 'POST', url: '/portal/sessions', payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it('POST /webhooks/stripe reaches signature verification rather than the admin gate', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.from('{}', 'utf8'),
    });
    expect(response.statusCode).toBe(400);
  });
});

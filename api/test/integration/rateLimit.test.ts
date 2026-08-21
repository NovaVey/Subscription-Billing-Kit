import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercises finding #27 (deep bug hunt) end to end through the real Fastify
// plugin - checkout.ts and portal.ts are the only two routes that opt into
// `perCustomerRateLimit` (see app.ts's `global: false` registration), so
// this is the one place that behavior is worth testing directly rather than
// re-verified per route.
const mockCheckoutCreate = vi.fn();
const mockPortalCreate = vi.fn();

vi.mock('../../src/stripe/client.js', () => ({
  stripe: {
    checkout: { sessions: { create: (...args: unknown[]) => mockCheckoutCreate(...args) } },
    billingPortal: { sessions: { create: (...args: unknown[]) => mockPortalCreate(...args) } },
  },
}));

const { buildApp } = await import('../../src/app.js');
const { db, pool } = await import('../../src/db/client.js');
const { customers } = await import('../../src/db/schema.js');
const { fakeCustomer } = await import('./helpers/stripeFixtures.js');

// A fresh app per describe block (rather than the file-wide singleton other
// integration files use) so this file's request bursts can't leak rate-limit
// state into - or be affected by - any other test file's app instance.
const app = buildApp();

const cleanupCustomerIds: string[] = [];

beforeEach(() => {
  mockCheckoutCreate.mockReset();
  mockCheckoutCreate.mockResolvedValue({ id: 'cs_test', url: 'https://checkout.stripe.com/cs_test' });
  mockPortalCreate.mockReset();
  mockPortalCreate.mockResolvedValue({ url: 'https://billing.stripe.com/session_test' });
});

afterAll(async () => {
  for (const id of cleanupCustomerIds) {
    await db.delete(customers).where(eq(customers.id, id));
  }
  await app.close();
  await pool.end();
});

async function seedCustomer() {
  const stripeCustomer = fakeCustomer();
  const [row] = await db
    .insert(customers)
    .values({ stripeCustomerId: stripeCustomer.id, email: stripeCustomer.email })
    .returning({ id: customers.id });
  cleanupCustomerIds.push(row!.id);
  return row!.id;
}

describe('rate limiting on POST /checkout/sessions', () => {
  it('allows 10 requests for one customer in a minute, then 429s the 11th', async () => {
    const customerId = await seedCustomer();

    for (let i = 0; i < 10; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        payload: { customer_id: customerId, price_id: 'price_starter_monthly', quantity: 1 },
      });
      expect(response.statusCode).toBe(200);
    }

    const eleventh = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      payload: { customer_id: customerId, price_id: 'price_starter_monthly', quantity: 1 },
    });
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.json().error).toMatch(/rate limit exceeded/i);
    // The bookkeeping caller code (createCheckoutSession -> Stripe) never
    // ran for the 11th call - the limiter rejected it in preHandler, before
    // the route body executed.
    expect(mockCheckoutCreate).toHaveBeenCalledTimes(10);
  });

  it('keys the limit by customer_id, not just IP - a different customer gets a fresh bucket', async () => {
    const exhaustedCustomerId = await seedCustomer();
    const otherCustomerId = await seedCustomer();

    for (let i = 0; i < 10; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        payload: { customer_id: exhaustedCustomerId, price_id: 'price_starter_monthly', quantity: 1 },
      });
      expect(response.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      payload: { customer_id: exhaustedCustomerId, price_id: 'price_starter_monthly', quantity: 1 },
    });
    expect(blocked.statusCode).toBe(429);

    // Same injected request (same IP under app.inject), different
    // customer_id - not blocked by the first customer's exhausted bucket.
    const fresh = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      payload: { customer_id: otherCustomerId, price_id: 'price_starter_monthly', quantity: 1 },
    });
    expect(fresh.statusCode).toBe(200);
  });
});

describe('rate limiting on POST /portal/sessions', () => {
  it('429s the 11th request for the same customer within a minute', async () => {
    const customerId = await seedCustomer();

    for (let i = 0; i < 10; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/portal/sessions',
        payload: { customer_id: customerId, return_url: 'https://app.example.com/account' },
      });
      expect(response.statusCode).toBe(200);
    }

    const eleventh = await app.inject({
      method: 'POST',
      url: '/portal/sessions',
      payload: { customer_id: customerId, return_url: 'https://app.example.com/account' },
    });
    expect(eleventh.statusCode).toBe(429);
    expect(mockPortalCreate).toHaveBeenCalledTimes(10);
  });

  it('is a separate bucket from /checkout/sessions for the same customer', async () => {
    const customerId = await seedCustomer();

    for (let i = 0; i < 10; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        payload: { customer_id: customerId, price_id: 'price_starter_monthly', quantity: 1 },
      });
      expect(response.statusCode).toBe(200);
    }
    const checkoutBlocked = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      payload: { customer_id: customerId, price_id: 'price_starter_monthly', quantity: 1 },
    });
    expect(checkoutBlocked.statusCode).toBe(429);

    // /portal/sessions is registered with its own perCustomerRateLimit(10)
    // call, so it has its own bucket keyed on the same customer_id - it
    // is not exhausted by the checkout route's calls above.
    const portalStillAllowed = await app.inject({
      method: 'POST',
      url: '/portal/sessions',
      payload: { customer_id: customerId, return_url: 'https://app.example.com/account' },
    });
    expect(portalStillAllowed.statusCode).toBe(200);
  });
});

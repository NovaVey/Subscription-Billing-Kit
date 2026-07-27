import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { db, pool } from '../../src/db/client.js';
import { webhookEvents } from '../../src/db/schema.js';
import { signFixture } from './helpers/webhookFixture.js';

const app = buildApp();

afterAll(async () => {
  await app.close();
  await pool.end();
});

// The receiver reads the request body as a raw Buffer and never round-trips
// it through JSON.parse/JSON.stringify before verifying the signature. If
// it did, the reserialized bytes could differ from what Stripe actually
// signed the moment metadata contains anything outside plain ASCII, and
// verification would fail unpredictably in production while working fine
// against every hand-typed test payload in development.
describe('raw body parsing survives non-ASCII metadata', () => {
  it('accepts and correctly stores an event containing non-ASCII customer metadata', async () => {
    const nonAsciiName = 'Zoë Müller — 田中太郎 — Ñoño 🎉';
    const { payload, signatureHeader, event } = signFixture({
      object: {
        id: 'cus_test_nonascii',
        object: 'customer',
        name: nonAsciiName,
        email: 'zoe@example.com',
      },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: { 'content-type': 'application/json', 'stripe-signature': signatureHeader },
        payload: Buffer.from(payload, 'utf8'),
      });

      expect(response.statusCode).toBe(200);

      const rows = await db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.stripeEventId, event.id));
      expect(rows).toHaveLength(1);
      const storedPayload = rows[0]?.payload as { data: { object: { name: string } } };
      expect(storedPayload.data.object.name).toBe(nonAsciiName);
    } finally {
      await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, event.id));
    }
  });
});

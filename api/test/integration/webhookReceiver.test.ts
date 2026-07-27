import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { db, pool } from '../../src/db/client.js';
import { webhookEvents } from '../../src/db/schema.js';
import { signFixture } from './helpers/webhookFixture.js';

const app = buildApp();
const createdEventIds: string[] = [];

async function rowsFor(eventId: string) {
  return db.select().from(webhookEvents).where(eq(webhookEvents.stripeEventId, eventId));
}

afterAll(async () => {
  for (const id of createdEventIds) {
    await db.delete(webhookEvents).where(eq(webhookEvents.stripeEventId, id));
  }
  await app.close();
  await pool.end();
});

describe('webhook receiver', () => {
  it('accepts a validly-signed event and persists exactly one row', async () => {
    const { payload, signatureHeader, event } = signFixture();
    createdEventIds.push(event.id);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signatureHeader },
      payload: Buffer.from(payload, 'utf8'),
    });

    expect(response.statusCode).toBe(200);
    const rows = await rowsFor(event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('customer.created');
    expect(rows[0]?.status).toBe('received');
  });

  describe('replaying the same event 10 times changes nothing', () => {
    it('leaves exactly one row after 10 replays of the same signed payload', async () => {
      const { payload, signatureHeader, event } = signFixture();
      createdEventIds.push(event.id);

      for (let i = 0; i < 10; i++) {
        const response = await app.inject({
          method: 'POST',
          url: '/webhooks/stripe',
          headers: { 'content-type': 'application/json', 'stripe-signature': signatureHeader },
          payload: Buffer.from(payload, 'utf8'),
        });
        // Every replay still gets a 200 - Stripe must never see a reason to
        // stop believing the event was delivered.
        expect(response.statusCode).toBe(200);
      }

      const rows = await rowsFor(event.id);
      expect(rows).toHaveLength(1);
    });
  });

  describe('webhook with a bad signature is rejected and logged', () => {
    it('returns 400 and persists nothing for a tampered signature', async () => {
      const { payload, event } = signFixture();
      // Don't push to createdEventIds cleanup on purpose - proving no row
      // exists is the point, but harmless to also attempt cleanup.
      createdEventIds.push(event.id);

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 't=1700000000,v1=0000000000000000000000000000000000000000000000000000000000000000',
        },
        payload: Buffer.from(payload, 'utf8'),
      });

      expect(response.statusCode).toBe(400);
      const rows = await rowsFor(event.id);
      expect(rows).toHaveLength(0);
    });

    it('returns 400 when the stripe-signature header is missing entirely', async () => {
      const { payload, event } = signFixture();
      createdEventIds.push(event.id);

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: { 'content-type': 'application/json' },
        payload: Buffer.from(payload, 'utf8'),
      });

      expect(response.statusCode).toBe(400);
      const rows = await rowsFor(event.id);
      expect(rows).toHaveLength(0);
    });
  });
});

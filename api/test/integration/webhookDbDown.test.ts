import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { pool } from '../../src/db/client.js';
import { signFixture } from './helpers/webhookFixture.js';

// This file deliberately kills its own copy of the shared pg Pool to prove
// the "DB down" failure mode - it must stay isolated from every other
// integration test file. Vitest gives each test file a fresh module graph
// by default (isolate: true), so this Pool instance is private to this
// file's import of db/client.ts and ending it here cannot affect the pool
// any other test file is using.
describe('a failed persist returns 500 so Stripe retries', () => {
  it('returns 500 (not 200) when the database is unreachable', async () => {
    const app = buildApp();
    await pool.end(); // simulates "with the DB stopped"

    const { payload, signatureHeader } = signFixture();
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signatureHeader },
      payload: Buffer.from(payload, 'utf8'),
    });

    // A 500 here, not a 200, is the entire point: it tells Stripe to retry
    // once the database recovers, instead of quietly losing the event.
    expect(response.statusCode).toBe(500);

    await app.close();
  });
});

import { randomUUID } from 'node:crypto';
import { env } from '../../../src/env.js';
import { stripe } from '../../../src/stripe/client.js';

export interface FakeEventOptions {
  id?: string;
  type?: string;
  created?: number;
  object?: Record<string, unknown>;
}

// A minimal, realistic Stripe Event payload. constructEvent only verifies
// the HMAC signature over the raw bytes and then JSON.parses the result —
// it does not schema-validate the event body — so this is sufficient to
// exercise the receiver's real code path end to end without any network
// access to Stripe (signing is a pure local HMAC operation, same algorithm
// Stripe itself uses).
export function buildFakeEvent(options: FakeEventOptions = {}) {
  const id = options.id ?? `evt_test_${randomUUID().replace(/-/g, '')}`;
  return {
    id,
    object: 'event',
    api_version: env.STRIPE_API_VERSION,
    created: options.created ?? Math.floor(Date.now() / 1000),
    type: options.type ?? 'customer.created',
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: {
      object: options.object ?? {
        id: `cus_test_${randomUUID().replace(/-/g, '')}`,
        object: 'customer',
        email: 'test@example.com',
      },
    },
  };
}

export interface SignedFixture {
  payload: string;
  signatureHeader: string;
  event: ReturnType<typeof buildFakeEvent>;
}

export function signFixture(options: FakeEventOptions = {}): SignedFixture {
  const event = buildFakeEvent(options);
  const payload = JSON.stringify(event);
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET must be set to sign test fixtures');
  }
  const signatureHeader = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: env.STRIPE_WEBHOOK_SECRET,
  });
  return { payload, signatureHeader, event };
}

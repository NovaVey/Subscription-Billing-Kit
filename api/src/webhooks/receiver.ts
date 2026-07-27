import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { env } from '../env.js';
import { stripe } from '../stripe/client.js';
import { recordWebhookEvent } from './ledger.js';

// The receiver does exactly three things: verify signature, insert into
// webhook_events, return 200. All business logic happens in the processor
// (Phase 3). A slow handler here must never cause Stripe to retry, and a
// failed persist must never look like a success to Stripe.
//
// Registered as its own encapsulated plugin (not on the root app instance)
// specifically so the raw-body content-type parser below is scoped to this
// route only — every other route keeps Fastify's normal JSON parsing.
// Parsing then re-verifying a re-serialized body is the single most common
// Stripe webhook bug: it works in dev and breaks on the first payload with
// a character that doesn't round-trip identically through JSON.stringify.
export async function webhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser<Buffer>(
    'application/json',
    { parseAs: 'buffer' },
    (_req, rawBody, done) => {
      done(null, rawBody);
    },
  );

  app.post('/webhooks/stripe', async (req, reply) => {
    const signatureHeader = req.headers['stripe-signature'];
    if (typeof signatureHeader !== 'string') {
      req.log.warn('webhook request missing stripe-signature header');
      return reply.code(400).send({ error: 'missing signature' });
    }

    if (!env.STRIPE_WEBHOOK_SECRET) {
      // Config problem, not a signature problem — 500 so Stripe retries
      // once the secret is actually configured, rather than 400 (which
      // Stripe treats as permanently rejected and won't retry).
      req.log.error('STRIPE_WEBHOOK_SECRET is not configured');
      return reply.code(500).send({ error: 'webhook not configured' });
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body as Buffer,
        signatureHeader,
        env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      req.log.warn({ err }, 'rejected webhook: invalid signature');
      return reply.code(400).send({ error: 'invalid signature' });
    }

    try {
      const { inserted } = await recordWebhookEvent(event);
      req.log.info({ eventId: event.id, type: event.type, inserted }, 'webhook event persisted');
      // 200 only after the insert above has committed — see
      // docs/ARCHITECTURE.md. Returning 200 before that point (or on a
      // persist failure) tells Stripe the event was delivered, retries
      // stop, and the event is gone for good.
      return reply.code(200).send({ received: true });
    } catch (err) {
      req.log.error({ err, eventId: event.id }, 'failed to persist webhook event');
      return reply.code(500).send({ error: 'persist failed' });
    }
  });
}

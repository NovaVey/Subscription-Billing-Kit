import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { adminAuthPreHandler } from './lib/adminAuth.js';
import { healthRoutes } from './routes/health.js';
import { customerRoutes } from './routes/customers.js';
import { checkoutRoutes } from './routes/checkout.js';
import { portalRoutes } from './routes/portal.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { dunningRoutes } from './routes/dunning.js';
import { reconciliationRoutes } from './routes/reconciliation.js';
import { invoiceRoutes } from './routes/invoices.js';
import { webhookEventRoutes } from './routes/webhookEvents.js';
import { webhookRoutes } from './webhooks/receiver.js';

export function buildApp() {
  const app = Fastify({ loggerInstance: logger });

  // Every route already validates its own input up front (parseOrReply,
  // parseUuidParam) and replies its own 4xx directly rather than throwing
  // - this only ever catches something genuinely unexpected: a DB error
  // no route anticipated, a bug. Without a registered handler, Fastify's
  // own fallback serializes `error.message` verbatim into the response -
  // for a Postgres error that's raw driver/column/type text (e.g.
  // `invalid input syntax for type uuid: "..."`), leaked to anyone holding
  // an admin key. The real error is still logged server-side; the caller
  // only ever sees a generic message for anything at 500+. A 4xx thrown by
  // Fastify itself (e.g. malformed JSON in the body) keeps its own
  // already-client-safe message. See the deep bug hunt.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'unhandled route error');
    const statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    reply.code(statusCode).send({
      error: statusCode < 500 ? error.message : 'internal server error',
    });
  });

  // The admin UI (§7) is a separate origin from the API even in dev
  // (5173 vs 3000), so it needs CORS - scoped to APP_BASE_URL, the one
  // origin that's actually meant to call these admin endpoints.
  app.register(cors, { origin: env.APP_BASE_URL });

  // global:false - no route is rate limited unless it explicitly opts in
  // via `config.rateLimit` (checkout.ts, portal.ts). Admin routes already
  // gate on adminAuthPreHandler and aren't reachable by an anonymous
  // caller in the first place; the webhook receiver is Stripe's own
  // signed-and-retried delivery, which a request cap would only fight
  // against. See the deep bug hunt (finding #27).
  app.register(rateLimit, { global: false });

  app.register(healthRoutes);
  app.register(customerRoutes);
  app.register(checkoutRoutes);
  app.register(portalRoutes);

  // Everything an admin (not an end customer, not Stripe) calls — gated by
  // adminAuthPreHandler (Phase 10). Fastify's plugin encapsulation keeps this
  // hook scoped to only the routes registered inside this callback, the same
  // mechanism webhookRoutes below already relies on for its own scoped
  // content-type parser.
  app.register(async (adminScope) => {
    adminScope.addHook('preHandler', adminAuthPreHandler);
    adminScope.register(subscriptionRoutes);
    adminScope.register(dunningRoutes);
    adminScope.register(reconciliationRoutes);
    adminScope.register(invoiceRoutes);
    adminScope.register(webhookEventRoutes);
  });

  // Registered as its own plugin so its raw-body content-type parser stays
  // scoped away from every other route — see webhooks/receiver.ts.
  app.register(webhookRoutes);

  return app;
}

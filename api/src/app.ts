import Fastify from 'fastify';
import cors from '@fastify/cors';
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

  // The admin UI (§7) is a separate origin from the API even in dev
  // (5173 vs 3000), so it needs CORS - scoped to APP_BASE_URL, the one
  // origin that's actually meant to call these admin endpoints.
  app.register(cors, { origin: env.APP_BASE_URL });

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

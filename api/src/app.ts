import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './env.js';
import { logger } from './lib/logger.js';
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
  app.register(subscriptionRoutes);
  app.register(dunningRoutes);
  app.register(reconciliationRoutes);
  app.register(invoiceRoutes);
  app.register(webhookEventRoutes);
  // Registered as its own plugin so its raw-body content-type parser stays
  // scoped away from every other route — see webhooks/receiver.ts.
  app.register(webhookRoutes);

  return app;
}

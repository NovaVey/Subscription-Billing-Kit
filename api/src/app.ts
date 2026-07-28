import Fastify from 'fastify';
import { logger } from './lib/logger.js';
import { healthRoutes } from './routes/health.js';
import { customerRoutes } from './routes/customers.js';
import { checkoutRoutes } from './routes/checkout.js';
import { portalRoutes } from './routes/portal.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { dunningRoutes } from './routes/dunning.js';
import { reconciliationRoutes } from './routes/reconciliation.js';
import { webhookRoutes } from './webhooks/receiver.js';

export function buildApp() {
  const app = Fastify({ loggerInstance: logger });

  app.register(healthRoutes);
  app.register(customerRoutes);
  app.register(checkoutRoutes);
  app.register(portalRoutes);
  app.register(subscriptionRoutes);
  app.register(dunningRoutes);
  app.register(reconciliationRoutes);
  // Registered as its own plugin so its raw-body content-type parser stays
  // scoped away from every other route — see webhooks/receiver.ts.
  app.register(webhookRoutes);

  return app;
}

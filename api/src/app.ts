import Fastify from 'fastify';
import { logger } from './lib/logger.js';
import { healthRoutes } from './routes/health.js';
import { webhookRoutes } from './webhooks/receiver.js';

export function buildApp() {
  const app = Fastify({ loggerInstance: logger });

  app.register(healthRoutes);
  // Registered as its own plugin so its raw-body content-type parser stays
  // scoped away from every other route — see webhooks/receiver.ts.
  app.register(webhookRoutes);

  return app;
}

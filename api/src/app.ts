import Fastify from 'fastify';
import { logger } from './lib/logger.js';
import { healthRoutes } from './routes/health.js';

export function buildApp() {
  const app = Fastify({ loggerInstance: logger });

  app.register(healthRoutes);

  return app;
}

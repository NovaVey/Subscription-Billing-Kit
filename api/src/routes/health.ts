import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { checkDbConnectivity } from '../db/client.js';
import { checkStripeConnectivity } from '../stripe/client.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    const [db, stripeCheck] = await Promise.all([checkDbConnectivity(), checkStripeConnectivity()]);

    const ok = db.ok && stripeCheck.ok;
    reply.code(ok ? 200 : 503);
    return {
      status: ok ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      db,
      stripe: {
        ...stripeCheck,
        apiVersion: env.STRIPE_API_VERSION,
      },
    };
  });
}

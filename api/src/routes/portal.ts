import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createPortalSession } from '../stripe/portal.js';
import { clientIdempotencyToken } from '../stripe/idempotency.js';
import { loadCustomerOr404 } from '../lib/lookups.js';
import { perCustomerRateLimit } from '../lib/rateLimit.js';
import { parseOrReply } from '../lib/validate.js';

const CreatePortalSessionBody = z.object({
  customer_id: z.string().uuid(),
  return_url: z.string().url(),
});

export async function portalRoutes(app: FastifyInstance) {
  app.post('/portal/sessions', { config: { rateLimit: perCustomerRateLimit(10) } }, async (req, reply) => {
    const body = parseOrReply(CreatePortalSessionBody, req.body, reply);
    if (!body) return;
    const { customer_id, return_url } = body;

    const customerRow = await loadCustomerOr404(customer_id, reply);
    if (!customerRow) return;

    const { url } = await createPortalSession({
      stripeCustomerId: customerRow.stripeCustomerId,
      returnUrl: return_url,
      idempotency: { clientToken: clientIdempotencyToken(req), requestedAt: new Date() },
    });

    return reply.code(200).send({ url });
  });
}

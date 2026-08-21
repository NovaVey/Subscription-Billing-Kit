import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createCheckoutSession } from '../stripe/checkout.js';
import { clientIdempotencyToken } from '../stripe/idempotency.js';
import { loadCustomerOr404 } from '../lib/lookups.js';
import { perCustomerRateLimit } from '../lib/rateLimit.js';
import { parseOrReply } from '../lib/validate.js';

const CreateCheckoutSessionBody = z.object({
  customer_id: z.string().uuid(),
  price_id: z.string().min(1),
  quantity: z.number().int().positive().default(1),
});

export async function checkoutRoutes(app: FastifyInstance) {
  app.post('/checkout/sessions', { config: { rateLimit: perCustomerRateLimit(10) } }, async (req, reply) => {
    const body = parseOrReply(CreateCheckoutSessionBody, req.body, reply);
    if (!body) return;
    const { customer_id, price_id, quantity } = body;

    const customerRow = await loadCustomerOr404(customer_id, reply);
    if (!customerRow) return;

    const { url } = await createCheckoutSession({
      stripeCustomerId: customerRow.stripeCustomerId,
      priceId: price_id,
      quantity,
      idempotency: { clientToken: clientIdempotencyToken(req), requestedAt: new Date() },
    });

    return reply.code(200).send({ url });
  });
}

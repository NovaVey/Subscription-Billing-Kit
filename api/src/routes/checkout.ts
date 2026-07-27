import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createCheckoutSession } from '../stripe/checkout.js';
import { db } from '../db/client.js';
import { customers } from '../db/schema.js';

const CreateCheckoutSessionBody = z.object({
  customer_id: z.string().uuid(),
  price_id: z.string().min(1),
  quantity: z.number().int().positive().default(1),
});

export async function checkoutRoutes(app: FastifyInstance) {
  app.post('/checkout/sessions', async (req, reply) => {
    const parsed = CreateCheckoutSessionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const { customer_id, price_id, quantity } = parsed.data;

    const [customerRow] = await db.select().from(customers).where(eq(customers.id, customer_id));
    if (!customerRow) {
      return reply.code(404).send({ error: 'customer not found' });
    }

    const { url } = await createCheckoutSession({
      stripeCustomerId: customerRow.stripeCustomerId,
      priceId: price_id,
      quantity,
      requestedAt: new Date(),
    });

    return reply.code(200).send({ url });
  });
}

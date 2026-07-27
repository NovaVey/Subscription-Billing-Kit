import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createPortalSession } from '../stripe/portal.js';
import { db } from '../db/client.js';
import { customers } from '../db/schema.js';

const CreatePortalSessionBody = z.object({
  customer_id: z.string().uuid(),
  return_url: z.string().url(),
});

export async function portalRoutes(app: FastifyInstance) {
  app.post('/portal/sessions', async (req, reply) => {
    const parsed = CreatePortalSessionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const { customer_id, return_url } = parsed.data;

    const [customerRow] = await db.select().from(customers).where(eq(customers.id, customer_id));
    if (!customerRow) {
      return reply.code(404).send({ error: 'customer not found' });
    }

    const { url } = await createPortalSession({
      stripeCustomerId: customerRow.stripeCustomerId,
      returnUrl: return_url,
      requestedAt: new Date(),
    });

    return reply.code(200).send({ url });
  });
}

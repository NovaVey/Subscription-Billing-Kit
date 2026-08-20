import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { stripe } from '../stripe/client.js';
import { customerCreateKey } from '../stripe/idempotency.js';
import { syncCustomerFromStripe } from '../stripe/sync.js';
import { db } from '../db/client.js';
import { customers } from '../db/schema.js';
import { parseOrReply } from '../lib/validate.js';

const CreateCustomerBody = z.object({
  external_ref: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1).optional(),
});

export async function customerRoutes(app: FastifyInstance) {
  app.post('/customers', async (req, reply) => {
    const body = parseOrReply(CreateCustomerBody, req.body, reply);
    if (!body) return;
    const { external_ref, email, name } = body;

    // Local-first idempotency: Stripe's own idempotency key only guards a
    // retry within its retention window (currently 24h). A request for an
    // external_ref that already has a customer - however long ago it was
    // created - must still return the existing one, not attempt another
    // Stripe create call.
    const [existing] = await db
      .select()
      .from(customers)
      .where(eq(customers.externalRef, external_ref));
    if (existing) {
      return reply.code(200).send({
        id: existing.id,
        stripe_customer_id: existing.stripeCustomerId,
        external_ref: existing.externalRef,
        email: existing.email,
        name: existing.name,
      });
    }

    const customer = await stripe.customers.create(
      { email, ...(name !== undefined ? { name } : {}), metadata: { external_ref } },
      { idempotencyKey: customerCreateKey(external_ref) },
    );
    const { id } = await syncCustomerFromStripe(customer);

    return reply.code(201).send({
      id,
      stripe_customer_id: customer.id,
      external_ref,
      email,
      name: name ?? null,
    });
  });
}

import { eq } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { db } from '../db/client.js';
import { customers, subscriptions } from '../db/schema.js';

// Loads a subscription by id or sends the route's standard 404 and returns
// undefined - callers do:
//   const subRow = await loadSubscriptionOr404(id, reply);
//   if (!subRow) return;
// A single shared home for the select-or-404 block previously duplicated
// across 6 route handlers. See the /improve audit.
export async function loadSubscriptionOr404(id: string, reply: FastifyReply) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
  if (!row) {
    reply.code(404).send({ error: 'subscription not found' });
    return undefined;
  }
  return row;
}

// Same pattern for a customer lookup - previously duplicated between
// checkout.ts and portal.ts.
export async function loadCustomerOr404(customerId: string, reply: FastifyReply) {
  const [row] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!row) {
    reply.code(404).send({ error: 'customer not found' });
    return undefined;
  }
  return row;
}

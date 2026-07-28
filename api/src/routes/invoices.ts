import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { customers, invoices } from '../db/schema.js';

const ListQuery = z.object({
  customer_id: z.uuid().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function invoiceRoutes(app: FastifyInstance) {
  // ?customer_id=&status= (§6)
  app.get('/invoices', async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const { customer_id, status, limit } = parsed.data;

    const conditions = [];
    if (customer_id) conditions.push(eq(invoices.customerId, customer_id));
    if (status) conditions.push(eq(invoices.status, status));

    const rows = await db
      .select({
        id: invoices.id,
        stripeInvoiceId: invoices.stripeInvoiceId,
        customerId: invoices.customerId,
        customerEmail: customers.email,
        subscriptionId: invoices.subscriptionId,
        status: invoices.status,
        currency: invoices.currency,
        amountDueMinor: invoices.amountDueMinor,
        amountPaidMinor: invoices.amountPaidMinor,
        attemptCount: invoices.attemptCount,
        nextPaymentAttempt: invoices.nextPaymentAttempt,
        hostedInvoiceUrl: invoices.hostedInvoiceUrl,
        periodStart: invoices.periodStart,
        periodEnd: invoices.periodEnd,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(invoices.periodStart))
      .limit(limit);

    return reply.send({ invoices: rows });
  });
}

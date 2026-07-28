import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { webhookEvents } from '../db/schema.js';

const ListQuery = z.object({
  status: z.string().optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function webhookEventRoutes(app: FastifyInstance) {
  // ?status=&type= (§6) - stripe_event_id is the row's own primary key, so
  // no separate uuid identifies a webhook_events row.
  app.get('/admin/webhook-events', async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const { status, type, limit } = parsed.data;

    const conditions = [];
    if (status) conditions.push(eq(webhookEvents.status, status));
    if (type) conditions.push(eq(webhookEvents.type, type));

    const rows = await db
      .select()
      .from(webhookEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(webhookEvents.receivedAt))
      .limit(limit);

    return reply.send({ events: rows });
  });

  // Resets a row to 'received' with a clean attempt budget, so the next
  // processor tick claims and re-applies it - a manual "try this again"
  // action, distinct from the automatic backoff/retry counter (§5.7).
  app.post('/admin/webhook-events/:id/replay', async (req, reply) => {
    const { id } = req.params as { id: string };

    const [existing] = await db.select().from(webhookEvents).where(eq(webhookEvents.stripeEventId, id));
    if (!existing) {
      return reply.code(404).send({ error: 'webhook event not found' });
    }

    await db
      .update(webhookEvents)
      .set({
        status: 'received',
        attempts: 0,
        nextAttemptAt: null,
        processingStartedAt: null,
        processedAt: null,
        lastError: null,
      })
      .where(eq(webhookEvents.stripeEventId, id));

    return reply.send({ stripeEventId: id, status: 'received' });
  });
}

import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { webhookEvents } from '../db/schema.js';
import { resetWebhookEventForReplay } from '../webhooks/ledger.js';
import { parseOrReply } from '../lib/validate.js';

const ListQuery = z.object({
  status: z.string().optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function webhookEventRoutes(app: FastifyInstance) {
  // ?status=&type= (§6) - stripe_event_id is the row's own primary key, so
  // no separate uuid identifies a webhook_events row.
  app.get('/admin/webhook-events', async (req, reply) => {
    const query = parseOrReply(ListQuery, req.query, reply);
    if (!query) return;
    const { status, type, limit } = query;

    const conditions = [];
    if (status) conditions.push(eq(webhookEvents.status, status));
    if (type) conditions.push(eq(webhookEvents.type, type));

    // The list view never renders `payload` (the full raw Stripe event JSON)
    // - it's only shown for one row at a time, on demand, via the detail
    // route below. Excluding it here avoids pulling and shipping up to
    // `limit` full event bodies on every page load. See the /improve audit.
    const rows = await db
      .select({
        stripeEventId: webhookEvents.stripeEventId,
        type: webhookEvents.type,
        apiVersion: webhookEvents.apiVersion,
        eventCreatedAt: webhookEvents.eventCreatedAt,
        receivedAt: webhookEvents.receivedAt,
        processingStartedAt: webhookEvents.processingStartedAt,
        processedAt: webhookEvents.processedAt,
        status: webhookEvents.status,
        attempts: webhookEvents.attempts,
        nextAttemptAt: webhookEvents.nextAttemptAt,
        lastError: webhookEvents.lastError,
      })
      .from(webhookEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(webhookEvents.receivedAt))
      .limit(limit);

    return reply.send({ events: rows });
  });

  // Full row, including `payload` - fetched on demand when the admin UI
  // expands a single event, rather than on every list load.
  app.get('/admin/webhook-events/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.stripeEventId, id));
    if (!row) {
      return reply.code(404).send({ error: 'webhook event not found' });
    }
    return reply.send(row);
  });

  // Resets a row to 'received' with a clean attempt budget, so the next
  // processor tick claims and re-applies it - a manual "try this again"
  // action, distinct from the automatic backoff/retry counter (§5.7).
  app.post('/admin/webhook-events/:id/replay', async (req, reply) => {
    const { id } = req.params as { id: string };

    const ok = await resetWebhookEventForReplay(id);
    if (!ok) {
      return reply.code(404).send({ error: 'webhook event not found' });
    }

    return reply.send({ stripeEventId: id, status: 'received' });
  });
}

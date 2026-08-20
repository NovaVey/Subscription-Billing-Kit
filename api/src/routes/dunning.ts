import { and, asc, desc, eq, gte, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { customers, dunningState, invoices, subscriptionEvents, subscriptions } from '../db/schema.js';
import { loadSubscriptionOr404 } from '../lib/lookups.js';
import { parseOrReply } from '../lib/validate.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const ResolveBody = z.object({
  resolution: z.enum(['recovered', 'canceled', 'manual']),
  note: z.string().min(1),
});

export async function dunningRoutes(app: FastifyInstance) {
  // Subscriptions in stage >= 1 (§6) - an unresolved cycle, regardless of
  // how far it has escalated. Grouped/sorted by stage for the admin queue
  // (§7): worst-off subscriptions first.
  app.get('/dunning/queue', async (_req, reply) => {
    const rows = await db
      .select({
        subscriptionId: dunningState.subscriptionId,
        stage: dunningState.stage,
        enteredStageAt: dunningState.enteredStageAt,
        nextActionAt: dunningState.nextActionAt,
        noticesSent: dunningState.noticesSent,
        triggeringInvoiceId: dunningState.triggeringInvoiceId,
        planCode: subscriptions.planCode,
        subscriptionStatus: subscriptions.status,
        customerEmail: customers.email,
        customerExternalRef: customers.externalRef,
        invoiceAmountDueMinor: invoices.amountDueMinor,
        invoiceCurrency: invoices.currency,
      })
      .from(dunningState)
      .innerJoin(subscriptions, eq(subscriptions.id, dunningState.subscriptionId))
      .innerJoin(customers, eq(customers.id, subscriptions.customerId))
      .leftJoin(invoices, eq(invoices.id, dunningState.triggeringInvoiceId))
      .where(and(gte(dunningState.stage, 1), isNull(dunningState.resolvedAt)))
      .orderBy(desc(dunningState.stage), asc(dunningState.enteredStageAt));

    const now = Date.now();
    return reply.send({
      queue: rows.map((row) => ({
        subscriptionId: row.subscriptionId,
        stage: row.stage,
        daysInStage: row.enteredStageAt ? Math.floor((now - row.enteredStageAt.getTime()) / DAY_MS) : null,
        nextActionAt: row.nextActionAt,
        triggeringInvoiceId: row.triggeringInvoiceId,
        amountAtRiskMinor: row.invoiceAmountDueMinor ?? null,
        currency: row.invoiceCurrency ?? null,
        noticesSent: row.noticesSent,
        planCode: row.planCode,
        subscriptionStatus: row.subscriptionStatus,
        customerEmail: row.customerEmail,
        customerExternalRef: row.customerExternalRef,
      })),
    });
  });

  // Manual resolution (§6) - always writes a subscription_events row (§5.8:
  // no admin mutation may bypass the audit trail), even though resolving
  // dunning doesn't itself change subscriptions.status.
  app.post('/dunning/:id/resolve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseOrReply(ResolveBody, req.body, reply);
    if (!body) return;
    const { resolution, note } = body;

    const subRow = await loadSubscriptionOr404(id, reply);
    if (!subRow) return;

    const [existing] = await db.select().from(dunningState).where(eq(dunningState.subscriptionId, id));
    if (!existing) {
      return reply.code(404).send({ error: 'no dunning cycle for this subscription' });
    }
    if (existing.resolvedAt) {
      return reply.code(409).send({ error: 'dunning cycle is already resolved' });
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(dunningState)
        .set({ resolvedAt: now, resolution, stage: 0, nextActionAt: null })
        .where(eq(dunningState.subscriptionId, id));

      await tx.insert(subscriptionEvents).values({
        subscriptionId: id,
        fromStatus: subRow.status,
        toStatus: subRow.status,
        reason: 'manual:api',
        actor: 'api',
        note: `dunning resolved (${resolution}): ${note}`,
      });
    });

    return reply.send({ subscriptionId: id, resolution });
  });
}

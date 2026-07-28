import { desc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { reconciliationRuns } from '../db/schema.js';
import { runReconciliation } from '../billing/reconcile.js';

const RunBody = z.object({
  period_start: z.iso.datetime(),
  period_end: z.iso.datetime(),
  currency: z.string().min(1),
});

export async function reconciliationRoutes(app: FastifyInstance) {
  app.get('/admin/reconciliation', async (_req, reply) => {
    const runs = await db
      .select()
      .from(reconciliationRuns)
      .orderBy(desc(reconciliationRuns.ranAt))
      .limit(50);
    return reply.send({ runs });
  });

  app.post('/admin/reconciliation/run', async (req, reply) => {
    const parsed = RunBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const { period_start, period_end, currency } = parsed.data;
    const periodStart = new Date(period_start);
    const periodEnd = new Date(period_end);
    if (periodEnd <= periodStart) {
      return reply.code(400).send({ error: 'period_end must be after period_start' });
    }

    const result = await runReconciliation({ periodStart, periodEnd, currency });
    return reply.send(result);
  });
}

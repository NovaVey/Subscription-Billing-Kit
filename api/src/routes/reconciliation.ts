import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { reconciliationRuns } from '../db/schema.js';
import { runReconciliation } from '../billing/reconcile.js';
import { parseOrReply, parseUuidParam } from '../lib/validate.js';

const RunBody = z.object({
  period_start: z.iso.datetime(),
  period_end: z.iso.datetime(),
  currency: z.string().min(1),
});

export async function reconciliationRoutes(app: FastifyInstance) {
  app.get('/admin/reconciliation', async (_req, reply) => {
    // The list view's run-history table only shows summary fields - `report`
    // is only read for one selected run at a time, via the detail route
    // below. Excluding it here avoids pulling and shipping the full
    // mismatch report for up to 50 runs on every page load. See the
    // /improve audit.
    const runs = await db
      .select({
        id: reconciliationRuns.id,
        periodStart: reconciliationRuns.periodStart,
        periodEnd: reconciliationRuns.periodEnd,
        ranAt: reconciliationRuns.ranAt,
        currency: reconciliationRuns.currency,
        stripeTotalMinor: reconciliationRuns.stripeTotalMinor,
        localTotalMinor: reconciliationRuns.localTotalMinor,
        invoiceCountStripe: reconciliationRuns.invoiceCountStripe,
        invoiceCountLocal: reconciliationRuns.invoiceCountLocal,
        mismatchCount: reconciliationRuns.mismatchCount,
      })
      .from(reconciliationRuns)
      .orderBy(desc(reconciliationRuns.ranAt))
      .limit(50);
    return reply.send({ runs });
  });

  // Full row, including `report` - fetched on demand when the admin UI
  // drills into a single run, rather than on every list load.
  app.get('/admin/reconciliation/:id', async (req, reply) => {
    const id = parseUuidParam(req, reply);
    if (!id) return;
    const [row] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, id));
    if (!row) {
      return reply.code(404).send({ error: 'reconciliation run not found' });
    }
    return reply.send(row);
  });

  app.post('/admin/reconciliation/run', async (req, reply) => {
    const body = parseOrReply(RunBody, req.body, reply);
    if (!body) return;
    const { period_start, period_end, currency } = body;
    const periodStart = new Date(period_start);
    const periodEnd = new Date(period_end);
    if (periodEnd <= periodStart) {
      return reply.code(400).send({ error: 'period_end must be after period_start' });
    }

    const result = await runReconciliation({ periodStart, periodEnd, currency });
    return reply.send(result);
  });
}

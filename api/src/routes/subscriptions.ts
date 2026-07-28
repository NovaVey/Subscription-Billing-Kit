import { and, asc, desc, eq, ilike, inArray, isNull, lt, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { z } from 'zod';
import { stripe } from '../stripe/client.js';
import { subscriptionCancelKey, subscriptionPlanChangeKey, subscriptionResumeKey } from '../stripe/idempotency.js';
import { syncSubscriptionFromStripe } from '../stripe/sync.js';
import { db } from '../db/client.js';
import { customers, dunningState, invoices, subscriptionEvents, subscriptionItems, subscriptions } from '../db/schema.js';

const ProrationBehavior = z.enum(['create_prorations', 'none', 'always_invoice']);

const ListQuery = z.object({
  status: z.string().optional(),
  q: z.string().optional(),
  cursor: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// MRR is a display-only derived metric, not a currency-decimal conversion
// - money.ts's "nothing outside it divides by 100" rule is about the
// zero-decimal-currency bug, not about normalizing a yearly/weekly/daily
// price to a monthly-equivalent figure. Interval count (e.g. "every 3
// months") isn't stored on subscription_items (a pre-existing gap from
// Phase 3, out of scope here), so this assumes interval_count=1.
function computeMrrMinor(
  items: readonly { unitAmountMinor: number; quantity: number; recurringInterval: string | null }[],
): number {
  let total = 0;
  for (const item of items) {
    const base = item.unitAmountMinor * item.quantity;
    switch (item.recurringInterval) {
      case 'year':
        total += base / 12;
        break;
      case 'week':
        total += base * (52 / 12);
        break;
      case 'day':
        total += base * (365 / 12);
        break;
      case 'month':
      default:
        total += base;
        break;
    }
  }
  return Math.round(total);
}

const PlanChangeBody = z.object({
  price_id: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  proration_behavior: ProrationBehavior.default('create_prorations'),
});

const PreviewQuery = z.object({
  price_id: z.string().min(1),
  quantity: z.coerce.number().int().positive().default(1),
  proration_behavior: ProrationBehavior.default('create_prorations'),
});

const CancelBody = z.object({
  at_period_end: z.boolean(),
});

// A line item is a proration if either parent variant says so - which
// parent is populated depends on what generated the line. Nested under
// `parent` in this API version (not a top-level `proration` flag), the
// same Basil-shaped restructuring as invoice.parent and PaymentIntent's
// missing .invoice field (docs/ARCHITECTURE.md).
function isProrationLine(line: Stripe.InvoiceLineItem): boolean {
  return (
    line.parent?.invoice_item_details?.proration ??
    line.parent?.subscription_item_details?.proration ??
    false
  );
}

async function loadActiveItem(localSubscriptionId: string) {
  const [itemRow] = await db
    .select()
    .from(subscriptionItems)
    .where(
      and(
        eq(subscriptionItems.subscriptionId, localSubscriptionId),
        isNull(subscriptionItems.removedAt),
      ),
    );
  return itemRow;
}

// Re-fetches with the item price expanded and syncs through the same path
// a webhook would (§5.6) - the mutation response itself is not trusted for
// projection, even though Stripe returns the updated object directly.
async function resyncAfterMutation(
  stripeSubscriptionId: string,
  meta: { reason: string; actor: string; note: string },
) {
  const fresh = await stripe.subscriptions.retrieve(stripeSubscriptionId, {
    expand: ['items.data.price'],
  });
  return syncSubscriptionFromStripe(fresh, {
    reason: meta.reason,
    actor: meta.actor,
    note: meta.note,
    lastEventAt: new Date(),
    forceRecord: true,
  });
}

export async function subscriptionRoutes(app: FastifyInstance) {
  // ?status=&q=&cursor= (§6) - q searches the customer's email or
  // external_ref. Cursor is the createdAt of the last row on the previous
  // page (keyset pagination) - simple and sufficient at this tool's scale,
  // not an offset that drifts as rows are inserted between page loads.
  app.get('/subscriptions', async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const { status, q, cursor, limit } = parsed.data;

    const conditions = [];
    if (status) conditions.push(eq(subscriptions.status, status));
    if (cursor) conditions.push(lt(subscriptions.createdAt, new Date(cursor)));
    if (q) conditions.push(or(ilike(customers.email, `%${q}%`), ilike(customers.externalRef, `%${q}%`)));

    const rows = await db
      .select({
        id: subscriptions.id,
        status: subscriptions.status,
        planCode: subscriptions.planCode,
        currency: subscriptions.currency,
        nextPeriodEndDerived: subscriptions.nextPeriodEndDerived,
        createdAt: subscriptions.createdAt,
        customerEmail: customers.email,
        customerExternalRef: customers.externalRef,
        dunningStage: dunningState.stage,
      })
      .from(subscriptions)
      .innerJoin(customers, eq(customers.id, subscriptions.customerId))
      .leftJoin(dunningState, eq(dunningState.subscriptionId, subscriptions.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(subscriptions.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const subIds = page.map((row) => row.id);
    const itemRows =
      subIds.length > 0
        ? await db
            .select()
            .from(subscriptionItems)
            .where(and(inArray(subscriptionItems.subscriptionId, subIds), isNull(subscriptionItems.removedAt)))
        : [];
    const itemsBySubscription = new Map<string, typeof itemRows>();
    for (const item of itemRows) {
      const list = itemsBySubscription.get(item.subscriptionId) ?? [];
      list.push(item);
      itemsBySubscription.set(item.subscriptionId, list);
    }

    return reply.send({
      subscriptions: page.map((row) => ({
        id: row.id,
        status: row.status,
        planCode: row.planCode,
        currency: row.currency,
        mrrMinor: computeMrrMinor(itemsBySubscription.get(row.id) ?? []),
        nextPeriodEndDerived: row.nextPeriodEndDerived,
        dunningStage: row.dunningStage ?? 0,
        customerEmail: row.customerEmail,
        customerExternalRef: row.customerExternalRef,
      })),
      nextCursor: hasMore ? page[page.length - 1]!.createdAt.toISOString() : null,
    });
  });

  app.get('/subscriptions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const [subRow] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
    if (!subRow) {
      return reply.code(404).send({ error: 'subscription not found' });
    }
    const [customerRow] = await db.select().from(customers).where(eq(customers.id, subRow.customerId));

    const items = await db
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, id));
    const timeline = await db
      .select()
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.subscriptionId, id))
      .orderBy(asc(subscriptionEvents.occurredAt));
    const invoiceRows = await db
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, id))
      .orderBy(desc(invoices.periodStart));
    const [dunningRow] = await db.select().from(dunningState).where(eq(dunningState.subscriptionId, id));

    return reply.send({
      subscription: subRow,
      customer: customerRow ?? null,
      items,
      timeline,
      invoices: invoiceRows,
      dunning: dunningRow ?? null,
    });
  });

  app.get('/subscriptions/:id/preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PreviewQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const { price_id, quantity, proration_behavior } = parsed.data;

    const [subRow] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
    if (!subRow) {
      return reply.code(404).send({ error: 'subscription not found' });
    }
    const itemRow = await loadActiveItem(id);
    if (!itemRow) {
      return reply.code(409).send({ error: 'subscription has no active item to change' });
    }

    const preview = await stripe.invoices.createPreview({
      subscription: subRow.stripeSubscriptionId,
      subscription_details: {
        items: [{ id: itemRow.stripeItemId, price: price_id, quantity }],
        proration_behavior,
      },
    });

    return reply.send({
      currency: preview.currency,
      amount_due: preview.amount_due,
      total: preview.total,
      lines: preview.lines.data.map((line) => ({
        description: line.description,
        amount: line.amount,
        proration: isProrationLine(line),
      })),
    });
  });

  app.post('/subscriptions/:id/plan', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PlanChangeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const { price_id, quantity, proration_behavior } = parsed.data;

    const [subRow] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
    if (!subRow) {
      return reply.code(404).send({ error: 'subscription not found' });
    }
    const itemRow = await loadActiveItem(id);
    if (!itemRow) {
      return reply.code(409).send({ error: 'subscription has no active item to change' });
    }

    const requestedAt = new Date();
    await stripe.subscriptions.update(
      subRow.stripeSubscriptionId,
      {
        items: [{ id: itemRow.stripeItemId, price: price_id, quantity }],
        proration_behavior,
      },
      { idempotencyKey: subscriptionPlanChangeKey(id, price_id, requestedAt) },
    );

    const result = await resyncAfterMutation(subRow.stripeSubscriptionId, {
      reason: 'manual:api',
      actor: 'api',
      note: `plan changed to ${price_id} (qty ${quantity}, proration_behavior=${proration_behavior})`,
    });

    return reply.send({ id: result.id, status: result.toStatus });
  });

  app.post('/subscriptions/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = CancelBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', details: parsed.error.flatten() });
    }
    const { at_period_end } = parsed.data;

    const [subRow] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
    if (!subRow) {
      return reply.code(404).send({ error: 'subscription not found' });
    }

    const requestedAt = new Date();
    const idempotencyKey = subscriptionCancelKey(id, at_period_end, requestedAt);

    if (at_period_end) {
      await stripe.subscriptions.update(
        subRow.stripeSubscriptionId,
        { cancel_at_period_end: true },
        { idempotencyKey },
      );
    } else {
      await stripe.subscriptions.cancel(subRow.stripeSubscriptionId, undefined, { idempotencyKey });
    }

    const result = await resyncAfterMutation(subRow.stripeSubscriptionId, {
      reason: 'manual:api',
      actor: 'api',
      note: at_period_end ? 'canceled at period end' : 'canceled immediately',
    });

    return reply.send({ id: result.id, status: result.toStatus });
  });

  app.post('/subscriptions/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string };

    const [subRow] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
    if (!subRow) {
      return reply.code(404).send({ error: 'subscription not found' });
    }

    const requestedAt = new Date();
    const idempotencyKey = subscriptionResumeKey(id, requestedAt);

    if (subRow.status === 'paused') {
      await stripe.subscriptions.resume(subRow.stripeSubscriptionId, {}, { idempotencyKey });
    } else if (subRow.cancelAtPeriodEnd) {
      await stripe.subscriptions.update(
        subRow.stripeSubscriptionId,
        { cancel_at_period_end: false },
        { idempotencyKey },
      );
    } else {
      return reply.code(409).send({
        error: 'subscription is neither paused nor scheduled to cancel at period end - nothing to resume',
      });
    }

    const result = await resyncAfterMutation(subRow.stripeSubscriptionId, {
      reason: 'manual:api',
      actor: 'api',
      note: 'resumed',
    });

    return reply.send({ id: result.id, status: result.toStatus });
  });
}

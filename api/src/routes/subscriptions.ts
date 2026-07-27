import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { z } from 'zod';
import { stripe } from '../stripe/client.js';
import { subscriptionCancelKey, subscriptionPlanChangeKey, subscriptionResumeKey } from '../stripe/idempotency.js';
import { syncSubscriptionFromStripe } from '../stripe/sync.js';
import { db } from '../db/client.js';
import { invoices, subscriptionEvents, subscriptionItems, subscriptions } from '../db/schema.js';

const ProrationBehavior = z.enum(['create_prorations', 'none', 'always_invoice']);

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
  app.get('/subscriptions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const [subRow] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
    if (!subRow) {
      return reply.code(404).send({ error: 'subscription not found' });
    }

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

    return reply.send({ subscription: subRow, items, timeline, invoices: invoiceRows });
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

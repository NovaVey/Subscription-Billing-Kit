import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { z } from 'zod';
import { stripe } from '../stripe/client.js';
import {
  clientIdempotencyToken,
  subscriptionCancelKey,
  subscriptionPlanChangeKey,
  subscriptionResumeKey,
} from '../stripe/idempotency.js';
import { syncSubscriptionFromStripe, TIERED_PRICING_SENTINEL_MINOR } from '../stripe/sync.js';
import { db } from '../db/client.js';
import { customers, dunningState, invoices, subscriptionEvents, subscriptionItems, subscriptions } from '../db/schema.js';
import { loadSubscriptionOr404 } from '../lib/lookups.js';
import { parseOrReply, parseUuidParam } from '../lib/validate.js';

const ProrationBehavior = z.enum(['create_prorations', 'none', 'always_invoice']);

const ListQuery = z.object({
  status: z.string().optional(),
  q: z.string().optional(),
  // Opaque - see encodeCursor/decodeCursor below. Was a bare ISO datetime
  // string until the tiebreaker fix (finding #25, deep bug hunt); no
  // longer parsed as one here since a cursor now also carries the row id.
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// createdAt alone is not a stable sort key: it's written from the
// application's millisecond-precision `new Date()` (not the DB's now()),
// so two rows - e.g. two customer.subscription.created webhooks processed
// within the same millisecond - can tie. Without a secondary key, only one
// tied row fits in a page; the other's createdAt equals the cursor, so the
// next page's `< cursor` predicate strictly excludes it forever, even
// though it still exists and matches the filter. (created_at, id) as a
// row-value comparison, both DESC, gives a total order with no ties -
// `id` doesn't need to mean anything, just to break ties deterministically.
// The cursor itself stays fully opaque to callers (base64url JSON) so this
// encoding can change again later without a breaking API change. See the
// deep bug hunt.
interface SubscriptionCursor {
  createdAt: string; // ISO
  id: string;
}

function encodeCursor(c: SubscriptionCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(raw: string): SubscriptionCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { createdAt?: unknown }).createdAt !== 'string' ||
      typeof (parsed as { id?: unknown }).id !== 'string' ||
      Number.isNaN(new Date((parsed as { createdAt: string }).createdAt).getTime())
    ) {
      return null;
    }
    return parsed as SubscriptionCursor;
  } catch {
    return null;
  }
}

// MRR is a display-only derived metric, not a currency-decimal conversion
// - money.ts's "nothing outside it divides by 100" rule is about the
// zero-decimal-currency bug, not about normalizing a yearly/weekly/daily
// price to a monthly-equivalent figure. Interval count (e.g. "every 3
// months") isn't stored on subscription_items (a pre-existing gap from
// Phase 3, out of scope here), so this assumes interval_count=1.
//
// A tiered/graduated/package-priced item (sync.ts stores
// TIERED_PRICING_SENTINEL_MINOR for it, never a real amount) has no single
// flat unit_amount to multiply by quantity - summing the sentinel in would
// silently corrupt the total in a different, even more misleading way than
// the old "reads as 0" bug this replaces. It's excluded from the sum
// instead, and `hasTieredPricing` tells the caller the returned figure is
// an undercount rather than the whole story. See the deep bug hunt.
function computeMrrMinor(
  items: readonly { unitAmountMinor: number; quantity: number; recurringInterval: string | null }[],
): { mrrMinor: number; hasTieredPricing: boolean } {
  let total = 0;
  let hasTieredPricing = false;
  for (const item of items) {
    if (item.unitAmountMinor === TIERED_PRICING_SENTINEL_MINOR) {
      hasTieredPricing = true;
      continue;
    }
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
  return { mrrMinor: Math.round(total), hasTieredPricing };
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
    const query = parseOrReply(ListQuery, req.query, reply);
    if (!query) return;
    const { status, q, cursor, limit } = query;

    const conditions = [];
    if (status) conditions.push(eq(subscriptions.status, status));
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        return reply.code(400).send({ error: 'invalid cursor' });
      }
      conditions.push(
        sql`(${subscriptions.createdAt}, ${subscriptions.id}) < (${new Date(decoded.createdAt)}, ${decoded.id})`,
      );
    }
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
      .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
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
      subscriptions: page.map((row) => {
        const { mrrMinor, hasTieredPricing } = computeMrrMinor(itemsBySubscription.get(row.id) ?? []);
        return {
          id: row.id,
          status: row.status,
          planCode: row.planCode,
          currency: row.currency,
          mrrMinor,
          hasTieredPricing,
          nextPeriodEndDerived: row.nextPeriodEndDerived,
          dunningStage: row.dunningStage ?? 0,
          customerEmail: row.customerEmail,
          customerExternalRef: row.customerExternalRef,
        };
      }),
      nextCursor: hasMore
        ? encodeCursor({ createdAt: page[page.length - 1]!.createdAt.toISOString(), id: page[page.length - 1]!.id })
        : null,
    });
  });

  app.get('/subscriptions/:id', async (req, reply) => {
    const id = parseUuidParam(req, reply);
    if (!id) return;

    const subRow = await loadSubscriptionOr404(id, reply);
    if (!subRow) return;

    // customerRow is the only query below that depends on subRow's data
    // (customerId) - everything else only needs the path param `id`, so
    // there's no reason to pay 5 sequential round trips when 2 stages
    // (this 404 check, then these 5 together) is achievable. See the
    // /improve audit.
    const [customerRow, items, timeline, invoiceRows, [dunningRow]] = await Promise.all([
      db.select().from(customers).where(eq(customers.id, subRow.customerId)).then(([row]) => row),
      db.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, id)),
      db
        .select()
        .from(subscriptionEvents)
        .where(eq(subscriptionEvents.subscriptionId, id))
        .orderBy(asc(subscriptionEvents.occurredAt)),
      db.select().from(invoices).where(eq(invoices.subscriptionId, id)).orderBy(desc(invoices.periodStart)),
      db.select().from(dunningState).where(eq(dunningState.subscriptionId, id)),
    ]);

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
    const id = parseUuidParam(req, reply);
    if (!id) return;
    const query = parseOrReply(PreviewQuery, req.query, reply);
    if (!query) return;
    const { price_id, quantity, proration_behavior } = query;

    const subRow = await loadSubscriptionOr404(id, reply);
    if (!subRow) return;
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
    const id = parseUuidParam(req, reply);
    if (!id) return;
    const body = parseOrReply(PlanChangeBody, req.body, reply);
    if (!body) return;
    const { price_id, quantity, proration_behavior } = body;

    const subRow = await loadSubscriptionOr404(id, reply);
    if (!subRow) return;
    const itemRow = await loadActiveItem(id);
    if (!itemRow) {
      return reply.code(409).send({ error: 'subscription has no active item to change' });
    }

    const idempotency = { clientToken: clientIdempotencyToken(req), requestedAt: new Date() };
    await stripe.subscriptions.update(
      subRow.stripeSubscriptionId,
      {
        items: [{ id: itemRow.stripeItemId, price: price_id, quantity }],
        proration_behavior,
      },
      { idempotencyKey: subscriptionPlanChangeKey(id, price_id, idempotency) },
    );

    const result = await resyncAfterMutation(subRow.stripeSubscriptionId, {
      reason: 'manual:api',
      actor: 'api',
      note: `plan changed to ${price_id} (qty ${quantity}, proration_behavior=${proration_behavior})`,
    });

    return reply.send({ id: result.id, status: result.toStatus });
  });

  app.post('/subscriptions/:id/cancel', async (req, reply) => {
    const id = parseUuidParam(req, reply);
    if (!id) return;
    const body = parseOrReply(CancelBody, req.body, reply);
    if (!body) return;
    const { at_period_end } = body;

    const subRow = await loadSubscriptionOr404(id, reply);
    if (!subRow) return;

    const idempotency = { clientToken: clientIdempotencyToken(req), requestedAt: new Date() };
    const idempotencyKey = subscriptionCancelKey(id, at_period_end, idempotency);

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
    const id = parseUuidParam(req, reply);
    if (!id) return;

    const subRow = await loadSubscriptionOr404(id, reply);
    if (!subRow) return;

    const idempotency = { clientToken: clientIdempotencyToken(req), requestedAt: new Date() };
    const idempotencyKey = subscriptionResumeKey(id, idempotency);

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

// Creates the demo product catalog (Starter/Pro/Scale, monthly + annual) in
// Stripe test mode and writes the resulting ids to catalog.json at the repo
// root. Safe to re-run: it looks for products/prices it already tagged via
// metadata before creating new ones, so re-running never creates duplicates
// or orphaned test-mode objects.
//
// Prices below are placeholder demo figures for exercising the billing
// kit's mechanics (state machine, dunning, reconciliation) — swap them for
// real pricing before using this for an actual client catalog.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import type Stripe from 'stripe';
import { stripe } from '../api/src/stripe/client.js';
import { toMinor } from '../api/src/lib/money.js';

const CURRENCY = 'usd';
const SEED_TAG = 'billing-kit-seed-catalog';

interface PlanDefinition {
  code: string;
  name: string;
  description: string;
  monthlyPrice: number;
  annualPrice: number;
}

const PLANS: PlanDefinition[] = [
  {
    code: 'starter',
    name: 'Starter',
    description: 'For solo builders getting off the ground.',
    monthlyPrice: 29,
    annualPrice: 290, // ~2 months free vs. monthly
  },
  {
    code: 'pro',
    name: 'Pro',
    description: 'For growing teams that need the full toolkit.',
    monthlyPrice: 79,
    annualPrice: 790,
  },
  {
    code: 'scale',
    name: 'Scale',
    description: 'For organizations running billing at volume.',
    monthlyPrice: 199,
    annualPrice: 1990,
  },
];

type Interval = 'month' | 'year';
const INTERVALS: Interval[] = ['month', 'year'];

interface CatalogPriceEntry {
  priceId: string;
  unitAmountMinor: number;
  interval: Interval;
}

interface CatalogPlanEntry {
  productId: string;
  name: string;
  prices: Record<Interval, CatalogPriceEntry>;
}

interface Catalog {
  generatedAt: string;
  currency: string;
  apiVersion: string;
  plans: Record<string, CatalogPlanEntry>;
}

async function findExistingProduct(planCode: string): Promise<Stripe.Product | undefined> {
  for await (const product of stripe.products.list({ limit: 100 })) {
    if (product.metadata['seed_tag'] === SEED_TAG && product.metadata['plan_code'] === planCode) {
      return product;
    }
  }
  return undefined;
}

async function findOrCreateProduct(plan: PlanDefinition): Promise<Stripe.Product> {
  const existing = await findExistingProduct(plan.code);
  if (existing) return existing;

  return stripe.products.create(
    {
      name: plan.name,
      description: plan.description,
      metadata: { seed_tag: SEED_TAG, plan_code: plan.code },
    },
    { idempotencyKey: `seed-catalog:product:${plan.code}` },
  );
}

async function findExistingPrice(
  productId: string,
  planCode: string,
  interval: Interval,
): Promise<Stripe.Price | undefined> {
  for await (const price of stripe.prices.list({ product: productId, limit: 100 })) {
    if (
      price.metadata['seed_tag'] === SEED_TAG &&
      price.metadata['plan_code'] === planCode &&
      price.recurring?.interval === interval
    ) {
      return price;
    }
  }
  return undefined;
}

async function findOrCreatePrice(
  product: Stripe.Product,
  plan: PlanDefinition,
  interval: Interval,
): Promise<Stripe.Price> {
  const existing = await findExistingPrice(product.id, plan.code, interval);
  if (existing) return existing;

  const displayAmount = interval === 'month' ? plan.monthlyPrice : plan.annualPrice;
  const unitAmount = toMinor(displayAmount, CURRENCY);

  return stripe.prices.create(
    {
      product: product.id,
      currency: CURRENCY,
      unit_amount: unitAmount,
      recurring: { interval },
      metadata: { seed_tag: SEED_TAG, plan_code: plan.code },
    },
    { idempotencyKey: `seed-catalog:price:${plan.code}:${interval}` },
  );
}

async function main() {
  const catalog: Catalog = {
    generatedAt: new Date().toISOString(),
    currency: CURRENCY,
    apiVersion: stripe.getApiField('version') as string,
    plans: {},
  };

  for (const plan of PLANS) {
    const product = await findOrCreateProduct(plan);
    console.log(`[seed-catalog] product ${plan.code} -> ${product.id}`);

    const prices = {} as Record<Interval, CatalogPriceEntry>;
    for (const interval of INTERVALS) {
      const price = await findOrCreatePrice(product, plan, interval);
      prices[interval] = {
        priceId: price.id,
        unitAmountMinor: price.unit_amount ?? 0,
        interval,
      };
      console.log(`[seed-catalog]   ${interval} price -> ${price.id} (${price.unit_amount} ${CURRENCY})`);
    }

    catalog.plans[plan.code] = { productId: product.id, name: plan.name, prices };
  }

  const outPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../catalog.json');
  await fs.writeFile(outPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  console.log(`[seed-catalog] wrote ${outPath}`);
}

main().catch((err) => {
  console.error('[seed-catalog] failed:', err);
  process.exit(1);
});

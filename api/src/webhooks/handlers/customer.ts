import type Stripe from 'stripe';
import { stripe } from '../../stripe/client.js';
import { db } from '../../db/client.js';
import { customers } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';

export interface HandlerResult {
  skipped?: boolean;
  skipReason?: string;
}

export async function handleCustomerEvent(event: Stripe.Event): Promise<HandlerResult> {
  const customerId = (event.data.object as { id: string }).id;

  if (event.type === 'customer.deleted') {
    // No `deleted`/`is_deleted` column exists on customers (§4), and this
    // row is referenced by historical subscriptions/invoices - a deleted
    // Stripe customer must not make billing history disappear. Deliberate
    // no-op, not an oversight.
    logger.info(
      { customerId },
      'customer.deleted received — local customer row kept as historical record',
    );
    return {};
  }

  // Re-fetch rather than trust the payload (§5.6): the payload is a
  // snapshot from when the event fired, not necessarily what's true now.
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) {
    logger.warn({ customerId }, 'customer no longer exists on re-fetch');
    return {};
  }

  if (!customer.email) {
    logger.warn({ customerId }, 'Stripe customer has no email; storing an empty string');
  }

  const externalRef = typeof customer.metadata?.['external_ref'] === 'string'
    ? customer.metadata['external_ref']
    : undefined;

  await db
    .insert(customers)
    .values({
      stripeCustomerId: customer.id,
      email: customer.email ?? '',
      name: customer.name ?? null,
      delinquent: customer.delinquent ?? false,
      ...(externalRef !== undefined ? { externalRef } : {}),
    })
    .onConflictDoUpdate({
      target: customers.stripeCustomerId,
      set: {
        email: customer.email ?? '',
        name: customer.name ?? null,
        delinquent: customer.delinquent ?? false,
        updatedAt: new Date(),
        // Only touch external_ref when Stripe metadata actually carries one
        // - never overwrite an existing value with a blank on a bare re-sync.
        ...(externalRef !== undefined ? { externalRef } : {}),
      },
    });

  return {};
}

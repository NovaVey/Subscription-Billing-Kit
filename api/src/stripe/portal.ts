import { stripe } from './client.js';
import { portalSessionKey, type IdempotencyContext } from './idempotency.js';
import { env } from '../env.js';

export interface CreatePortalSessionInput {
  stripeCustomerId: string;
  returnUrl: string;
  idempotency: IdempotencyContext;
}

export async function createPortalSession(input: CreatePortalSessionInput): Promise<{ url: string }> {
  const session = await stripe.billingPortal.sessions.create(
    {
      customer: input.stripeCustomerId,
      return_url: input.returnUrl,
      ...(env.STRIPE_PORTAL_CONFIG_ID ? { configuration: env.STRIPE_PORTAL_CONFIG_ID } : {}),
    },
    { idempotencyKey: portalSessionKey(input.stripeCustomerId, input.idempotency) },
  );

  return { url: session.url };
}

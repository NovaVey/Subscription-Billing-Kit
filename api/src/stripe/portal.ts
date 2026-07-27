import { stripe } from './client.js';
import { portalSessionKey } from './idempotency.js';
import { env } from '../env.js';

export interface CreatePortalSessionInput {
  stripeCustomerId: string;
  returnUrl: string;
  requestedAt: Date;
}

export async function createPortalSession(input: CreatePortalSessionInput): Promise<{ url: string }> {
  const session = await stripe.billingPortal.sessions.create(
    {
      customer: input.stripeCustomerId,
      return_url: input.returnUrl,
      ...(env.STRIPE_PORTAL_CONFIG_ID ? { configuration: env.STRIPE_PORTAL_CONFIG_ID } : {}),
    },
    { idempotencyKey: portalSessionKey(input.stripeCustomerId, input.requestedAt) },
  );

  return { url: session.url };
}

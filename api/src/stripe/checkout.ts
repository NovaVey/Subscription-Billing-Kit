import { stripe } from './client.js';
import { checkoutSessionKey } from './idempotency.js';
import { env } from '../env.js';

export interface CreateCheckoutSessionInput {
  stripeCustomerId: string;
  priceId: string;
  quantity: number;
  requestedAt: Date;
}

export async function createCheckoutSession(input: CreateCheckoutSessionInput): Promise<{ url: string }> {
  const session = await stripe.checkout.sessions.create(
    {
      customer: input.stripeCustomerId,
      mode: 'subscription',
      line_items: [{ price: input.priceId, quantity: input.quantity }],
      success_url: `${env.APP_BASE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.APP_BASE_URL}/checkout/cancel`,
    },
    {
      idempotencyKey: checkoutSessionKey(
        input.stripeCustomerId,
        input.priceId,
        input.quantity,
        input.requestedAt,
      ),
    },
  );

  if (!session.url) {
    throw new Error(`Stripe returned no url for checkout session ${session.id}`);
  }

  return { url: session.url };
}

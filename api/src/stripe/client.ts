import Stripe from 'stripe';
import { env } from '../env.js';

// The API version is env-driven by design (§5.1 of the build spec): the
// Stripe client must never rely on the account's dashboard default, so the
// literal type Stripe's SDK expects here is deliberately widened to string.
export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: env.STRIPE_API_VERSION as Stripe.LatestApiVersion,
  typescript: true,
});

export interface StripeConnectivity {
  ok: boolean;
  accountId?: string;
  error?: string;
}

// Startup/health probe: confirms the secret key and pinned API version are
// actually accepted by Stripe. A version Stripe no longer recognises, or a
// key that doesn't match the version's account, fails here rather than
// surfacing later as a field that's silently undefined mid-request.
export async function checkStripeConnectivity(): Promise<StripeConnectivity> {
  try {
    const account = await stripe.accounts.retrieveCurrent();
    return { ok: true, accountId: account.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

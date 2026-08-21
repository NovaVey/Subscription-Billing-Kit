import type { FastifyRequest } from 'fastify';

// Shared by every public (no-admin-key) mutating route that accepts a bare
// customer_id (checkout.ts, portal.ts) - neither endpoint authenticates
// the caller beyond that UUID being well-formed and existing (§ D-033),
// so anyone who obtains one customer's id (a leaked referrer header,
// browser history, an insecure email link) could otherwise call either
// endpoint in an unbounded loop: minting unbounded live Stripe Billing
// Portal links (view invoices/payment methods, cancel or change that
// customer's subscription with no further auth), or driving unbounded
// stripe.checkout.sessions.create calls against the account's Stripe API
// quota. Keyed by IP *and* customer_id together - an attacker needs both a
// different IP and a different customer_id to open a fresh bucket, not
// just one or the other. `hook: 'preHandler'` (not the plugin's default
// `onRequest`, which runs before body parsing) is what makes req.body
// available here at all. See the deep bug hunt (finding #27).
export function perCustomerRateLimit(max: number) {
  return {
    max,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator: (req: FastifyRequest) => {
      const customerId = (req.body as { customer_id?: unknown } | undefined)?.customer_id;
      return `${req.ip}:${typeof customerId === 'string' ? customerId : ''}`;
    },
  };
}

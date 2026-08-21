import { z } from 'zod';

// STRIPE_API_VERSION has no default on purpose: the Stripe client must never
// fall back to the account's dashboard default. See docs/ARCHITECTURE.md §5.1.
export const EnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message: 'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    }),
  STRIPE_SECRET_KEY: z
    .string()
    .min(1, 'STRIPE_SECRET_KEY is required')
    .refine((v) => v.startsWith('sk_test_') || v.startsWith('sk_live_') || v.startsWith('rk_'), {
      message: 'STRIPE_SECRET_KEY does not look like a Stripe secret or restricted key',
    }),
  STRIPE_API_VERSION: z
    .string()
    .min(1, 'STRIPE_API_VERSION is required — pin it deliberately, see docs/ARCHITECTURE.md §5.1'),
  // Optional at the schema level so the app can still boot and serve /health
  // without it — but the webhook route (Phase 2) refuses every request with a
  // loud 500 if it's missing, rather than silently misbehaving. See
  // api/src/webhooks/receiver.ts.
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PORTAL_CONFIG_ID: z.string().optional(),
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  API_BASE_URL: z.string().url().default('http://localhost:3000'),
  // Strict-equality (`v === 'true'`) silently maps every unrecognized
  // value - 'True', '1', 'yes', a typo - to false with no boot-time
  // warning, indistinguishable from a deliberate "dunning off". Every
  // subscription entering a failed-payment cycle from that point never
  // gets escalated or notified, with nothing surfacing it. Validated
  // against an explicit accepted set instead, case-insensitively, and
  // fails boot loudly on anything else. See the deep bug hunt.
  DUNNING_ENABLED: z
    .string()
    .optional()
    .default('true')
    .transform((v, ctx) => {
      const normalized = v.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
      ctx.addIssue({
        code: 'custom',
        message: `DUNNING_ENABLED must be one of true/false/1/0/yes/no/on/off (case-insensitive) — got "${v}"`,
      });
      return z.NEVER;
    }),
  WEBHOOK_LEASE_SECONDS: z.coerce.number().int().positive().default(300),
  RECONCILE_TZ: z.string().default('UTC'),
  // Shared-secret admin access control (Phase 10) - gates every admin route
  // (subscriptions, invoices, dunning, reconciliation, webhook-events admin
  // endpoints) but never the public customer/checkout/portal routes or the
  // webhook receiver itself, which Stripe's own signature already verifies.
  // See docs/DECISIONS.md D-033 for why shared keys rather than user accounts.
  ADMIN_API_KEY: z.string().min(1, 'ADMIN_API_KEY is required'),
  ADMIN_READONLY_KEY: z.string().min(1, 'ADMIN_READONLY_KEY is required'),
}).superRefine((v, ctx) => {
  // resolveAdminRole() checks the write key first - if an operator ever set
  // both to the same value (a copy-paste mistake), the "read-only" key would
  // silently resolve to full write access. Fail boot loudly instead.
  if (v.ADMIN_API_KEY === v.ADMIN_READONLY_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['ADMIN_READONLY_KEY'],
      message: 'ADMIN_READONLY_KEY must differ from ADMIN_API_KEY',
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

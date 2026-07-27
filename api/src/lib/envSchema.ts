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
  DUNNING_ENABLED: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v === 'true'),
  WEBHOOK_LEASE_SECONDS: z.coerce.number().int().positive().default(300),
  RECONCILE_TZ: z.string().default('UTC'),
});

export type Env = z.infer<typeof EnvSchema>;

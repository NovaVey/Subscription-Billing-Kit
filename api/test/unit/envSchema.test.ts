import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../../src/lib/envSchema.js';

const validEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/billing',
  STRIPE_SECRET_KEY: 'sk_test_abc123',
  STRIPE_API_VERSION: '2025-03-31.basil',
  ADMIN_API_KEY: 'test-write-key',
  ADMIN_READONLY_KEY: 'test-readonly-key',
};

describe('EnvSchema', () => {
  it('rejects a config missing the required Stripe/DB fields', () => {
    const result = EnvSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toEqual(
        expect.arrayContaining(['DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_API_VERSION']),
      );
    }
  });

  it('never defaults STRIPE_API_VERSION — it must be pinned explicitly', () => {
    const result = EnvSchema.safeParse({ ...validEnv, STRIPE_API_VERSION: undefined });
    expect(result.success).toBe(false);
  });

  it('rejects a DATABASE_URL that is not a postgres connection string', () => {
    const result = EnvSchema.safeParse({ ...validEnv, DATABASE_URL: 'mysql://x' });
    expect(result.success).toBe(false);
  });

  it('rejects a STRIPE_SECRET_KEY that does not look like a Stripe key', () => {
    const result = EnvSchema.safeParse({ ...validEnv, STRIPE_SECRET_KEY: 'not-a-key' });
    expect(result.success).toBe(false);
  });

  it('parses DUNNING_ENABLED="false" as false, not as a truthy string', () => {
    const result = EnvSchema.safeParse({ ...validEnv, DUNNING_ENABLED: 'false' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.DUNNING_ENABLED).toBe(false);
  });

  it('defaults DUNNING_ENABLED to true when unset', () => {
    const result = EnvSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.DUNNING_ENABLED).toBe(true);
  });

  it.each(['true', 'True', 'TRUE', '1', 'yes', 'YES', 'on'])(
    'accepts DUNNING_ENABLED=%s as true',
    (value) => {
      const result = EnvSchema.safeParse({ ...validEnv, DUNNING_ENABLED: value });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.DUNNING_ENABLED).toBe(true);
    },
  );

  it.each(['false', 'False', 'FALSE', '0', 'no', 'NO', 'off'])(
    'accepts DUNNING_ENABLED=%s as false',
    (value) => {
      const result = EnvSchema.safeParse({ ...validEnv, DUNNING_ENABLED: value });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.DUNNING_ENABLED).toBe(false);
    },
  );

  it.each(['enabled', 'nope', 'True1', ' ', 'null'])(
    'rejects an unrecognized DUNNING_ENABLED=%s at boot instead of silently defaulting to false',
    (value) => {
      const result = EnvSchema.safeParse({ ...validEnv, DUNNING_ENABLED: value });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((i) => i.path.join('.'))).toContain('DUNNING_ENABLED');
      }
    },
  );

  it('defaults WEBHOOK_LEASE_SECONDS to 300 and RECONCILE_TZ to UTC', () => {
    const result = EnvSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.WEBHOOK_LEASE_SECONDS).toBe(300);
      expect(result.data.RECONCILE_TZ).toBe('UTC');
    }
  });

  it('rejects ADMIN_API_KEY and ADMIN_READONLY_KEY being set to the same value', () => {
    const result = EnvSchema.safeParse({ ...validEnv, ADMIN_READONLY_KEY: validEnv.ADMIN_API_KEY });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toContain('ADMIN_READONLY_KEY');
    }
  });
});

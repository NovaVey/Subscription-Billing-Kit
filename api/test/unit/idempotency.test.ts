import { describe, expect, it } from 'vitest';
import {
  checkoutSessionKey,
  customerCreateKey,
  portalSessionKey,
  subscriptionCancelKey,
  subscriptionPlanChangeKey,
  subscriptionResumeKey,
} from '../../src/stripe/idempotency.js';

describe('idempotency keys are deterministic for the same operation', () => {
  it('produces the same customer-create key for the same external_ref, called any number of times', () => {
    const a = customerCreateKey('org_42');
    const b = customerCreateKey('org_42');
    const c = customerCreateKey('org_42');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('produces different customer-create keys for different external_refs', () => {
    expect(customerCreateKey('org_42')).not.toBe(customerCreateKey('org_43'));
  });

  it('produces the same checkout-session key for identical inputs, including the same requestedAt', () => {
    const requestedAt = new Date('2026-01-15T12:00:00.000Z');
    const a = checkoutSessionKey('cust_1', 'price_1', 2, requestedAt);
    const b = checkoutSessionKey('cust_1', 'price_1', 2, requestedAt);
    expect(a).toBe(b);
  });

  it('produces a different checkout-session key when any single input differs', () => {
    const requestedAt = new Date('2026-01-15T12:00:00.000Z');
    const base = checkoutSessionKey('cust_1', 'price_1', 2, requestedAt);
    expect(checkoutSessionKey('cust_2', 'price_1', 2, requestedAt)).not.toBe(base);
    expect(checkoutSessionKey('cust_1', 'price_2', 2, requestedAt)).not.toBe(base);
    expect(checkoutSessionKey('cust_1', 'price_1', 3, requestedAt)).not.toBe(base);
    expect(checkoutSessionKey('cust_1', 'price_1', 2, new Date('2026-01-15T12:00:01.000Z'))).not.toBe(
      base,
    );
  });

  it('produces the same portal-session key for identical inputs', () => {
    const requestedAt = new Date('2026-01-15T12:00:00.000Z');
    expect(portalSessionKey('cust_1', requestedAt)).toBe(portalSessionKey('cust_1', requestedAt));
  });

  it('produces the same plan-change key for identical inputs, matching the sub:{id}:plan:{price_id}:{requested_at_iso} shape', () => {
    const requestedAt = new Date('2026-01-15T12:00:00.000Z');
    const key = subscriptionPlanChangeKey('sub_local_1', 'price_pro_monthly', requestedAt);
    expect(key).toBe(subscriptionPlanChangeKey('sub_local_1', 'price_pro_monthly', requestedAt));
    expect(key).toBe('sub:sub_local_1:plan:price_pro_monthly:2026-01-15T12:00:00.000Z');
  });

  it('produces the same cancel key for identical inputs, and a different one for a different at_period_end', () => {
    const requestedAt = new Date('2026-01-15T12:00:00.000Z');
    const a = subscriptionCancelKey('sub_1', true, requestedAt);
    const b = subscriptionCancelKey('sub_1', true, requestedAt);
    expect(a).toBe(b);
    expect(subscriptionCancelKey('sub_1', false, requestedAt)).not.toBe(a);
  });

  it('produces the same resume key for identical inputs', () => {
    const requestedAt = new Date('2026-01-15T12:00:00.000Z');
    expect(subscriptionResumeKey('sub_1', requestedAt)).toBe(subscriptionResumeKey('sub_1', requestedAt));
  });
});

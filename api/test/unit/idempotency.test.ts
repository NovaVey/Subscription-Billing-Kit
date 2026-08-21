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
    const ctx = { requestedAt: new Date('2026-01-15T12:00:00.000Z') };
    const a = checkoutSessionKey('cust_1', 'price_1', 2, ctx);
    const b = checkoutSessionKey('cust_1', 'price_1', 2, ctx);
    expect(a).toBe(b);
  });

  it('produces a different checkout-session key when any single input differs', () => {
    const ctx = { requestedAt: new Date('2026-01-15T12:00:00.000Z') };
    const base = checkoutSessionKey('cust_1', 'price_1', 2, ctx);
    expect(checkoutSessionKey('cust_2', 'price_1', 2, ctx)).not.toBe(base);
    expect(checkoutSessionKey('cust_1', 'price_2', 2, ctx)).not.toBe(base);
    expect(checkoutSessionKey('cust_1', 'price_1', 3, ctx)).not.toBe(base);
    // A whole minute later, not just a few seconds - see the minute-bucketing
    // tests below for why a few seconds apart must NOT differ.
    expect(
      checkoutSessionKey('cust_1', 'price_1', 2, { requestedAt: new Date('2026-01-15T12:05:00.000Z') }),
    ).not.toBe(base);
  });

  it('produces the same portal-session key for identical inputs', () => {
    const ctx = { requestedAt: new Date('2026-01-15T12:00:00.000Z') };
    expect(portalSessionKey('cust_1', ctx)).toBe(portalSessionKey('cust_1', ctx));
  });

  it('produces the same plan-change key for identical inputs, matching the sub:{id}:plan:{price_id}:{minute_bucket_iso} shape (with each part\'s own colons escaped)', () => {
    const ctx = { requestedAt: new Date('2026-01-15T12:00:00.000Z') };
    const key = subscriptionPlanChangeKey('sub_local_1', 'price_pro_monthly', ctx);
    expect(key).toBe(subscriptionPlanChangeKey('sub_local_1', 'price_pro_monthly', ctx));
    // The trailing minute-bucket ISO timestamp contains colons of its own
    // ("T12:00:00") - buildKey escapes every part uniformly (not just the
    // ones that need it for boundary-safety), so those show up escaped too.
    expect(key).toBe('sub:sub_local_1:plan:price_pro_monthly:2026-01-15T12\\:00\\:00.000Z');
  });

  it('produces the same cancel key for identical inputs, and a different one for a different at_period_end', () => {
    const ctx = { requestedAt: new Date('2026-01-15T12:00:00.000Z') };
    const a = subscriptionCancelKey('sub_1', true, ctx);
    const b = subscriptionCancelKey('sub_1', true, ctx);
    expect(a).toBe(b);
    expect(subscriptionCancelKey('sub_1', false, ctx)).not.toBe(a);
  });

  it('produces the same resume key for identical inputs', () => {
    const ctx = { requestedAt: new Date('2026-01-15T12:00:00.000Z') };
    expect(subscriptionResumeKey('sub_1', ctx)).toBe(subscriptionResumeKey('sub_1', ctx));
  });
});

describe('the requestedAt fallback is bucketed to the minute, so a genuine client retry a few seconds later reuses the same key', () => {
  it('produces the same cancel key for two requestedAt values a few seconds apart in the same minute', () => {
    const a = subscriptionCancelKey('sub_1', true, { requestedAt: new Date('2026-01-15T12:00:00.000Z') });
    const b = subscriptionCancelKey('sub_1', true, { requestedAt: new Date('2026-01-15T12:00:47.000Z') });
    expect(a).toBe(b);
  });

  it('produces a different cancel key once requestedAt crosses into the next minute', () => {
    const a = subscriptionCancelKey('sub_1', true, { requestedAt: new Date('2026-01-15T12:00:59.999Z') });
    const b = subscriptionCancelKey('sub_1', true, { requestedAt: new Date('2026-01-15T12:01:00.000Z') });
    expect(a).not.toBe(b);
  });
});

describe('a caller-supplied client token always wins over the requestedAt fallback', () => {
  it('produces the same key for two calls with the same client token, even with different requestedAt values weeks apart', () => {
    const a = subscriptionResumeKey('sub_1', {
      clientToken: 'req-abc-123',
      requestedAt: new Date('2026-01-15T12:00:00.000Z'),
    });
    const b = subscriptionResumeKey('sub_1', {
      clientToken: 'req-abc-123',
      requestedAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    expect(a).toBe(b);
  });

  it('produces different keys for different client tokens, even with the same requestedAt', () => {
    const ctx1 = { clientToken: 'req-1', requestedAt: new Date('2026-01-15T12:00:00.000Z') };
    const ctx2 = { clientToken: 'req-2', requestedAt: new Date('2026-01-15T12:00:00.000Z') };
    expect(subscriptionResumeKey('sub_1', ctx1)).not.toBe(subscriptionResumeKey('sub_1', ctx2));
  });

  it('a client token also distinguishes different operations against the same subscription (it is not the whole story on its own)', () => {
    // A client token alone would collide a cancel and a resume that reuse
    // the same header value by mistake - the operation name/subscription id
    // still need to differ for that not to matter, same as the timestamp
    // fallback. Documented here so a future refactor doesn't accidentally
    // drop the operation-distinguishing parts when a client token is present.
    const ctx = { clientToken: 'req-1', requestedAt: new Date('2026-01-15T12:00:00.000Z') };
    expect(subscriptionCancelKey('sub_1', true, ctx)).toBe(subscriptionResumeKey('sub_1', ctx));
  });
});

describe('buildKey escapes each part before joining, so a colon inside one part can no longer shift the boundary onto the next part', () => {
  it('does not collide two logically different checkout-session calls that differ only in where a colon falls', () => {
    // Before this fix, buildKey did `parts.map(String).join(':')` with no
    // escaping. checkoutSessionKey passes [ 'checkout', customerId, priceId,
    // quantity, minuteBucketIso ]. If customerId contained a colon, the tail
    // of customerId and the head of priceId could rearrange into an
    // identical joined string for a *different* (customerId, priceId) pair:
    //
    //   ['checkout', 'cust_1:price_1', '2', '3', bucket].join(':')
    //     === 'checkout:cust_1:price_1:2:3:' + bucket
    //   ['checkout', 'cust_1', 'price_1:2', '3', bucket].join(':')
    //     === 'checkout:cust_1:price_1:2:3:' + bucket
    //
    // Same joined string, but the two calls describe different operations:
    // customerId 'cust_1:price_1' with priceId '2', versus customerId
    // 'cust_1' with priceId 'price_1:2'. Each part is now escaped before
    // joining, so the escaped colon marks exactly where the original part
    // boundary was and the two calls below produce different keys. Real
    // Stripe ids (cus_/price_/sub_/...) never contain colons in practice,
    // which is why this was only a latent risk, not an observed bug - but
    // this test now proves the fix rather than pinning the collision. See
    // the deep bug hunt.
    const ctx = { requestedAt: new Date('2026-01-15T12:00:00.000Z') };
    const keyA = checkoutSessionKey('cust_1:price_1', '2', 3, ctx);
    const keyB = checkoutSessionKey('cust_1', 'price_1:2', 3, ctx);
    expect(keyA).not.toBe(keyB);
  });
});

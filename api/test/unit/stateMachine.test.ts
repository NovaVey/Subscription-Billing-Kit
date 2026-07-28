import { describe, expect, it } from 'vitest';
import { ALL_STATUSES, isExpectedTransition, type SubscriptionStatus } from '../../src/billing/stateMachine.js';

// A literal, test-owned copy of every (from, to) pair's expected value -
// transcribed by hand from src/billing/stateMachine.ts's EXPECTED_TRANSITIONS
// table (plus the from=null and from===to override rules), kept as data
// here rather than imported, so a future edit that silently drops or swaps
// one entry in the source table fails this test instead of passing it
// vacuously. The 6 tests below only sample ~29 of these 64 pairs by name;
// this is the one that checks every entry's actual value, not just its type.
const EXPECTED_TRANSITION_TABLE: Record<SubscriptionStatus, Record<SubscriptionStatus, boolean>> = {
  trialing: {
    trialing: true,
    active: true,
    past_due: true,
    unpaid: true,
    paused: true,
    canceled: true,
    incomplete: false,
    incomplete_expired: false,
  },
  active: {
    trialing: false,
    active: true,
    past_due: true,
    unpaid: true,
    paused: true,
    canceled: true,
    incomplete: false,
    incomplete_expired: false,
  },
  past_due: {
    trialing: false,
    active: true,
    past_due: true,
    unpaid: true,
    paused: false,
    canceled: true,
    incomplete: false,
    incomplete_expired: false,
  },
  unpaid: {
    trialing: false,
    active: true,
    past_due: true,
    unpaid: true,
    paused: false,
    canceled: true,
    incomplete: false,
    incomplete_expired: false,
  },
  paused: {
    trialing: false,
    active: true,
    past_due: false,
    unpaid: false,
    paused: true,
    canceled: true,
    incomplete: false,
    incomplete_expired: false,
  },
  canceled: {
    trialing: false,
    active: false,
    past_due: false,
    unpaid: false,
    paused: false,
    canceled: true,
    incomplete: false,
    incomplete_expired: false,
  },
  incomplete: {
    trialing: false,
    active: true,
    past_due: false,
    unpaid: false,
    paused: false,
    canceled: true,
    incomplete: true,
    incomplete_expired: true,
  },
  incomplete_expired: {
    trialing: false,
    active: false,
    past_due: false,
    unpaid: false,
    paused: false,
    canceled: false,
    incomplete: false,
    incomplete_expired: true,
  },
};

describe('every state machine transition is covered', () => {
  it('matches the exact expected value for all 64 (from, to) pairs across all 8 statuses', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        expect(isExpectedTransition(from, to)).toBe(EXPECTED_TRANSITION_TABLE[from][to]);
      }
    }
  });

  it('treats the first sighting of a subscription (from=null) as always expected', () => {
    for (const to of ALL_STATUSES) {
      expect(isExpectedTransition(null, to)).toBe(true);
    }
  });

  it('treats a re-sync with no status change as always expected, not a transition', () => {
    for (const status of ALL_STATUSES) {
      expect(isExpectedTransition(status, status)).toBe(true);
    }
  });

  it('treats terminal statuses (canceled, incomplete_expired) as having no expected outbound transition', () => {
    const terminal: SubscriptionStatus[] = ['canceled', 'incomplete_expired'];
    for (const from of terminal) {
      for (const to of ALL_STATUSES) {
        if (to === from) continue;
        expect(isExpectedTransition(from, to)).toBe(false);
      }
    }
  });

  it('recognizes common expected lifecycle transitions', () => {
    expect(isExpectedTransition('trialing', 'active')).toBe(true);
    expect(isExpectedTransition('active', 'past_due')).toBe(true);
    expect(isExpectedTransition('past_due', 'active')).toBe(true);
    expect(isExpectedTransition('past_due', 'canceled')).toBe(true);
    expect(isExpectedTransition('incomplete', 'active')).toBe(true);
    expect(isExpectedTransition('incomplete', 'incomplete_expired')).toBe(true);
  });

  it('flags a status jumping backward from active to incomplete as unexpected (still applies - Stripe is the source of truth)', () => {
    expect(isExpectedTransition('active', 'incomplete')).toBe(false);
  });

  it('flags resurrecting a canceled subscription as unexpected', () => {
    expect(isExpectedTransition('canceled', 'active')).toBe(false);
  });
});

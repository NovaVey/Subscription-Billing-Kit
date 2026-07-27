import { describe, expect, it } from 'vitest';
import { ALL_STATUSES, isExpectedTransition, type SubscriptionStatus } from '../../src/billing/stateMachine.js';

describe('every state machine transition is covered', () => {
  it('returns a defined boolean for every (from, to) pair across all 8 statuses — none fall through undefined', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const result = isExpectedTransition(from, to);
        expect(typeof result).toBe('boolean');
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

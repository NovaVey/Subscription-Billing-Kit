// Create/advance/teardown helpers for Stripe test clocks (§5.12). Needed
// from Phase 5 on for exercising the dunning stage machine in seconds
// instead of days - not just for scripts/test-clock-demo.ts (Phase 9).
//
// Verified against the installed Stripe SDK's own type definitions
// (node_modules/stripe/.../TestHelpers/TestClocks.d.ts), not recalled from
// memory: `stripe.testHelpers.testClocks`, params are `frozen_time` (Unix
// seconds), and deletion is `.del()`, not `.delete()`.
import { stripe } from '../api/src/stripe/client.js';

export interface TestClockHandle {
  id: string;
  frozenTime: Date;
}

function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

// Creates a new test clock frozen at the given time. Attach a customer to
// it at creation time via `stripe.customers.create({ test_clock: id, ... })`
// - test clocks are created empty; this helper doesn't presume what the
// caller wants to simulate.
export async function createTestClock(frozenTime: Date, name?: string): Promise<TestClockHandle> {
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: toUnixSeconds(frozenTime),
    ...(name ? { name } : {}),
  });
  return { id: clock.id, frozenTime: new Date(clock.frozen_time * 1000) };
}

const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 60_000;

// Advancing a test clock is asynchronous - Stripe replays every event the
// jump generates (renewals, invoices, payment attempts, webhooks) in the
// background, and the clock's status moves advancing -> ready only once
// that settles. A bare `.advance()` call returns immediately, well before
// any of that has happened, so this polls status until it's ready (or
// fails loudly on internal_failure) rather than handing back control early.
export async function advanceTestClock(clockId: string, to: Date): Promise<TestClockHandle> {
  let clock = await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: toUnixSeconds(to) });

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (clock.status === 'advancing') {
    if (Date.now() > deadline) {
      throw new Error(`test clock ${clockId} did not finish advancing within ${POLL_TIMEOUT_MS}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    clock = await stripe.testHelpers.testClocks.retrieve(clockId);
  }

  if (clock.status === 'internal_failure') {
    throw new Error(`test clock ${clockId} entered internal_failure advancing to ${to.toISOString()}`);
  }

  return { id: clock.id, frozenTime: new Date(clock.frozen_time * 1000) };
}

// Deletes a test clock and cascades to every customer/subscription/etc.
// attached to it. Test clocks and their objects persist in the account
// otherwise (§5.12) - every caller of createTestClock must pair it with
// this, not just the demo script.
export async function teardownTestClock(clockId: string): Promise<void> {
  await stripe.testHelpers.testClocks.del(clockId);
}

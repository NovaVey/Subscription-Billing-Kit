# Subscription state machine

The full logic lives in `api/src/billing/stateMachine.ts`; this document explains what it's for and how to read it, not just what it says.

## The eight statuses

`SubscriptionStatus` mirrors Stripe's own `Subscription.status` enum exactly — there is no separate internal vocabulary to keep in sync with theirs:

`trialing` · `active` · `past_due` · `unpaid` · `paused` · `canceled` · `incomplete` · `incomplete_expired`

## What the table is for — and what it isn't

`EXPECTED_TRANSITIONS` (and the `isExpectedTransition(from, to)` function built on it) is a statement of what's **expected**, not what's **allowed**. Stripe is always the source of truth: this codebase never rejects a transition, never refuses to apply one, and never validates an incoming webhook against this table before projecting it. Every transition — expected or not — gets applied to the local `subscriptions` row and written to `subscription_events`. The table only changes two things when a transition falls outside it: a warning gets logged (`unexpected subscription state transition — applying anyway, Stripe is the source of truth`), and the admin UI's event timeline (`web/src/pages/SubscriptionDetailPage.tsx`) renders that row differently so nothing is silently swallowed.

This distinction matters because Stripe's real subscription lifecycle is messier than any diagram — dunning settings, manual dashboard edits, disputes, and account-level configuration can all produce a status change that doesn't match a textbook lifecycle. A system that refused unexpected transitions would drift from Stripe's own truth the first time reality didn't match the diagram; one that just applies everything and *flags* the surprising ones stays correct while still surfacing the surprise to a human.

## The transition table

Each row is a `from` status; each column is a `to` status. **Y** means expected, **·** means unexpected (still applied, just logged and flagged).

| from ↓ / to → | trialing | active | past_due | unpaid | paused | canceled | incomplete | incomplete_expired |
|---|---|---|---|---|---|---|---|---|
| **trialing** | — | Y | Y | Y | Y | Y | · | · |
| **active** | · | — | Y | Y | Y | Y | · | · |
| **past_due** | · | Y | — | Y | · | Y | · | · |
| **unpaid** | · | Y | Y | — | · | Y | · | · |
| **paused** | · | Y | · | · | — | Y | · | · |
| **canceled** | · | · | · | · | · | — (terminal) | · | · |
| **incomplete** | · | Y | · | · | · | Y | — | Y |
| **incomplete_expired** | · | · | · | · | · | · | · | — (terminal) |

Two rules apply on top of this table, checked before it, and they're not encoded as table entries:

- **First sighting is always expected.** `isExpectedTransition(null, to)` is `true` for every status — a subscription's very first webhook has no prior status to compare against, so there's nothing to be "unexpected" relative to.
- **A re-sync with no status change is always expected, and isn't a transition at all.** `isExpectedTransition(status, status)` is `true` — Stripe re-delivering the same status (a metadata-only update, a retried webhook) is normal traffic, not a lifecycle event, even though a `subscription_events` row still gets written for it if a manual admin action forced one (see below).

`canceled` and `incomplete_expired` are the two terminal statuses: nothing is expected to follow either of them, matching a subscription that's genuinely done.

## Every transition writes an audit row — no exceptions

`recordTransition()` is the single place a `subscription_events` row gets written, whether the transition came from a webhook or a manual admin action (`routes/subscriptions.ts`'s cancel/resume/plan-change endpoints). This is deliberate: the audit trail is only trustworthy if there's exactly one door into it, not a webhook-only path with admin actions bolted on separately.

Webhook-driven syncs only write a row when `fromStatus !== toStatus` by default — otherwise a routine metadata refresh would flood the timeline with no-op rows. Manual admin actions are different: a plan change or a `cancel_at_period_end=true` request is a real, notable action even when it doesn't move `status` at all (`active` stays `active`). `syncSubscriptionFromStripe()`'s `forceRecord` option exists for exactly this — every manual mutation route passes it, so the audit trail always shows *something* happened, with a `reason='manual:<actor>'` and a human-readable `note`, even when the status column didn't budge.

## How a webhook actually gets here

`handleSubscriptionEvent()` (`api/src/webhooks/handlers/subscription.ts`) is the single dispatch point for every `customer.subscription.*` event type — `created`, `updated`, `deleted`, `paused`, `resumed`, `trial_will_end`, all of it. There's no per-event-type branching for what to project; the handler always re-fetches the subscription from the Stripe API (§5.6 — never trust the payload) and re-syncs it through `syncSubscriptionFromStripe()`, which is what actually calls `recordTransition()` and decides expected-vs-not via the table above. The one exception is `customer.subscription.deleted`, which additionally closes any open dunning cycle as `resolution='canceled'` (see `docs/ARCHITECTURE.md`'s dunning sections and D-023) — there's nothing left to collect on a subscription that's actually gone.

Before any of that, a staleness guard compares the incoming event's `event.created` against the row's `last_event_at`; an older event is marked `skipped` and never reaches the table at all. This is what makes out-of-order delivery safe: combined with always re-fetching current truth rather than trusting the payload, it doesn't matter whether Stripe's `created` webhook arrives after its `canceled` webhook — the stale one is discarded before it can revert anything.

## Verifying this yourself

- `api/test/unit/stateMachine.test.ts` asserts the exact expected value for all 64 `(from, to)` pairs against a literal, independently-transcribed table (not imported from the source), plus the `null`-and-self-transition rules.
- `api/test/integration/subscriptionProjection.test.ts` proves the staleness guard against two concrete out-of-order scenarios: a subscription created then immediately canceled, delivered out of order, and a later update that must not be reverted by a stale one arriving after it.
- `api/test/integration/checkoutPortalPlanChange.test.ts` proves the `forceRecord` audit-row guarantee: canceling at period end leaves `status='active'` but still writes a `manual:api` row.

See `docs/DECISIONS.md` (D-006 — re-fetching rather than trusting the payload; D-017 — the staleness guard; D-020 — the `forceRecord` audit-row flag) and `docs/ARCHITECTURE.md`'s Phase 3 sections for the design reasoning behind each of these choices.

# Architecture

This document explains the non-obvious design decisions in this codebase, in the order the phases that introduced them. Each section names the bug it prevents.

## Pin the API version, read billing periods from items (Phase 0 / Phase 1)

The Stripe client (`api/src/stripe/client.ts`) is constructed with an explicit `apiVersion` read from `STRIPE_API_VERSION`. It never falls back to the account's dashboard default.

Why this matters: Stripe's Basil release (2025-03-31) removed `current_period_start` / `current_period_end` from the `Subscription` object and moved them onto subscription items (`items.data[].current_period_start` / `current_period_end`). Code written against the old top-level fields didn't error — it kept getting `200 OK` with those fields simply `undefined`. The renewal date silently became `null` everywhere it was read. Later API versions also allow mixed billing intervals on a single subscription, so there is no single subscription-level period to fall back to even if you wanted one.

Consequences enforced in this codebase:
- Periods are stored on `subscription_items`, never on `subscriptions` (from Phase 1 onward).
- `subscriptions.next_period_end_derived` is computed as the minimum item period end and is labelled "derived" everywhere it's displayed.
- The webhook endpoint's configured API version in the Stripe dashboard must match `STRIPE_API_VERSION`. A mismatch there is the same bug wearing a different hat — see `docs/RUNBOOK.md`.
- `/health` (`api/src/routes/health.ts`) reports the pinned version on every call. `api/src/env.ts` fails to boot the process if `STRIPE_API_VERSION` isn't set — there is no implicit default to fall back to.
- Every Stripe field this codebase reads is checked against that pinned version's API reference before being written into a handler, not recalled from memory.

_(Further sections — signature verification, ledger ordering, idempotency, the state machine, money handling, dunning, reconciliation, test clocks — are added here as the phases that implement them land.)_

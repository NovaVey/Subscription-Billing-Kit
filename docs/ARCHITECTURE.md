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

## Money is currency-aware minor units (Phase 1)

`api/src/lib/money.ts` is the only place in this codebase allowed to multiply or divide an amount by 100. Everywhere else, amounts move around as opaque `amountMinor` integers with an attached `currency` — never a JS float representing dollars.

Why this matters: not every currency has two decimal places. Stripe expresses ¥1000 as `1000`, not `100000` — code that divides by 100 to display an amount is wrong by 100× for zero-decimal currencies, in the direction of undercharging or over-refunding.

A more specific trap, confirmed against Stripe's current currencies reference rather than assumed from memory: **UGX (Ugandan Shilling) is deliberately excluded from this codebase's zero-decimal set**, even though it conceptually became a zero-decimal currency. Stripe kept UGX's API amounts two-decimal for backward compatibility — the decimal digits are always `"00"`, but you still multiply by 100. ISK has the same carve-out. Treating UGX as zero-decimal here would silently undercharge every UGX invoice by 100× — the same bug this module exists to prevent, just approached from the opposite, more counter-intuitive direction. (HUF and TWD have a related zero-decimal-*style* rounding rule too, but it only applies to manual payouts, which this service never issues — they stay ordinary two-decimal currencies here.)

Consequences enforced in this codebase:
- `toMinor(displayAmount, currency)` / `toDisplay(amountMinor, currency)` are the only conversion points, and both consult the same `isZeroDecimalCurrency` check.
- `addSameCurrency(amounts)` throws on mixed currencies rather than coercing — there's no single correct answer to "$5 + ¥500," and picking one silently would hide the bug instead of surfacing it. Reconciliation totals (Phase 6) and any "amount at risk" figure are always per-currency for the same reason.
- Stripe timestamps are Unix **seconds**; `api/src/lib/time.ts` owns every conversion in both directions so a stray `× 1000` (or missing one) can't land a date in 1970 or the year 55000 undetected.

## The full data model lands in one migration (Phase 1)

All ten tables from the schema spec (`webhook_events`, `customers`, `subscriptions`, `subscription_items`, `subscription_events`, `invoices`, `payment_attempts`, `dunning_state`, `dunning_notices`, `reconciliation_runs`) are defined together in `api/src/db/schema.ts` and generated into a single Drizzle migration, verified to apply cleanly to an empty Postgres before being trusted. `reconciliation_runs`'s totals use `bigint` (number-mode, safe to 2^53−1) rather than `integer` — a 90-day total in minor units overflows a 4-byte integer above roughly $21.5M, and per-invoice amounts realistically never will, so only the aggregate columns need the wider type. `dunning_notices` carries a `unique(subscription_id, stage)` constraint from the start — the database enforcing "one notice per stage" from day one, not bolted on later once a duplicate-email incident forces the issue.

_(Further sections — signature verification, ledger ordering, idempotency, the state machine, dunning, reconciliation, test clocks — are added here as the phases that implement them land.)_

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

## Signature verification uses the raw body (Phase 2)

`api/src/webhooks/receiver.ts` registers its own `application/json` content-type parser — scoped to that route only, via Fastify's plugin encapsulation, so every other route keeps normal JSON parsing — that hands back the untouched request `Buffer`, never a parsed-then-restringified object.

Why this matters: Stripe signs the *exact bytes* it sent. Parsing the body to JSON and re-serializing it before verifying (or verifying against `JSON.stringify(req.body)`) can produce a byte sequence that differs from what was signed — key ordering, whitespace, and especially non-ASCII characters can all round-trip differently than the original. This works fine against every hand-typed test payload and then fails unpredictably in production the first time a customer's name has an accented character or an emoji in it. It's arguably *the* most common Stripe webhook integration bug. The route's own test (`raw-body-parsing-survives-non-ascii-metadata`) sends real non-ASCII content through the full pipeline and checks it round-trips exactly.

## Persist, ack, then process — and only ack what's committed (Phase 2)

The receiver does exactly three things, in order: verify signature, insert into `webhook_events`, return `200`. No business logic runs in the request handler (that's the processor, Phase 3) — a slow downstream handler must never be able to make Stripe think a delivery timed out and retry it.

The ordering is the point, enforced directly in `receiver.ts`: **`200` is returned only after the ledger insert has resolved successfully.** A signature failure returns `400` before any DB write is attempted. A DB failure during the insert returns `500` — never `200` — so Stripe retries instead of concluding the event was delivered. Returning `200` on a failed persist is a silent, permanent data-loss path: Stripe stops retrying, the event is gone, and every dashboard still looks green.

## Inbound idempotency is the primary key (Phase 2)

`stripe_event_id` is `webhook_events`'s primary key, and the insert (`api/src/webhooks/ledger.ts`) is `on conflict do nothing`. Replaying the same event any number of times produces exactly one row — tested by sending one signed fixture through the receiver 10 times in a row and asserting the row count never moves past 1.

## An unhandled pool error can crash the whole process (Phase 2, found while verifying the above)

While demonstrating "DB down → `500`" for this phase's checkpoint by actually stopping the local Postgres mid-request, the *first* attempt didn't produce a `500` at all — it took the entire Node process down. `pg.Pool` emits an `'error'` event when an already-connected, idle client hits a connection-level problem (the backend restarting, a network drop, an admin killing the connection — exactly what stopping Postgres does to any idle pooled client). Node's `EventEmitter` treats an *unhandled* `'error'` event as fatal and throws, crashing the process. Without a listener, a routine database restart doesn't degrade the service — it takes it down entirely, for every in-flight request, not just the one that happened to be running a query.

Fixed with a single `pool.on('error', ...)` in `api/src/db/client.ts` that logs and does nothing else. Re-ran the exact same "stop Postgres mid-request" demonstration afterward: the request correctly got a `500`, and the process stayed up to serve the next one once Postgres came back. This is the kind of failure mode that's invisible in code review and only shows up when something actually kills the database while the app is running — which is exactly what happened here.

_(Further sections — the state machine, dunning, reconciliation, test clocks — are added here as the phases that implement them land.)_

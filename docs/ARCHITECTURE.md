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

## Never trust the payload for current state (Phase 3)

Every handler in `api/src/webhooks/handlers/` re-fetches the object from the Stripe API by id before writing anything, rather than projecting `event.data.object` directly. The payload is a snapshot from the moment the event fired; the API tells you what's true *now*. This is what kills out-of-order bugs: no matter what order events are actually processed in, each handler invocation converges on the real current state, not a stale snapshot from whenever Stripe happened to send it.

## The staleness guard protects the audit trail, not the data (Phase 3)

`subscriptions.last_event_at` and `invoices.last_event_at` record the `event.created` of the newest event applied to that row. Before doing anything else, `handlers/subscription.ts` and `handlers/invoice.ts` compare the incoming event's `created` timestamp against it; an older event is marked `skipped` on its `webhook_events` row and nothing else happens — no re-fetch, no write, no `subscription_events` row.

The reasoning here is subtler than "the re-fetch might return wrong data" — it never does, since re-fetching always returns whatever is true *right now*, regardless of which event triggered it. What the guard actually protects is the **audit trail and per-event-type semantics**: applying an older "created" event's logic *after* a newer "canceled" event has already been processed would write a `subscription_events` row that reads as nonsense on the timeline (a `-> trialing` transition appearing chronologically after a `-> canceled` one), and could re-trigger side effects tied to that specific event type. The guard is what makes delivery order stop mattering *for the parts that re-fetching alone can't fix*. Two tests exercise this directly by feeding events out of order and asserting the older one is skipped and the newer state survives untouched: `subscription-created-then-immediately-canceled-out-of-order` and `an-event-that-arrives-late-does-not-overwrite-newer-state`.

## The state machine is explicit and total (Phase 3)

`api/src/billing/stateMachine.ts` mirrors Stripe's own eight-value `Subscription.status` enum exactly and holds a transition table describing what's *expected* from each status — not what's *allowed*. Stripe is always the source of truth: every transition, expected or not, gets applied and written to `subscription_events` via `recordTransition()`. An unexpected transition only changes two things — a warning gets logged, and (Phase 7) the admin timeline renders it differently — it never blocks anything. There's no `expected` column in `subscription_events` (the schema doesn't have one); both the processor's warning and the future admin UI call the same `isExpectedTransition()` function rather than storing a redundant, driftable flag.

## Periods land on subscription_items, never on subscriptions (Phase 3, applying §5.1)

`projectSubscription()` in `handlers/subscription.ts` writes each Stripe subscription item's `current_period_start`/`current_period_end` onto its own `subscription_items` row, and computes `subscriptions.next_period_end_derived` in application code as the minimum of those — there is no code path that reads a period off the `Subscription` object itself, because post-Basil that value doesn't exist there. Tested directly with a mixed-interval subscription (one monthly item, one annual item, different period ends): both items store their own, independently correct periods, and the derived field picks the sooner of the two.

## Two more Basil-shaped surprises, found by checking the SDK's types instead of assuming (Phase 3)

The Basil period-fields change (§5.1) is the one this project was built to demonstrate handling. Verifying every field against the pinned API version's actual types (the installed `stripe` package's `.d.ts` files, generated from Stripe's own OpenAPI spec) surfaced two more, structurally identical traps:

- **An invoice's subscription isn't `invoice.subscription` anymore.** It lives at `invoice.parent.subscription_details.subscription`, where `parent` is a discriminated union (`parent.type` is `'subscription_details'` or `'quote_details'`). The old top-level field doesn't exist in this API version at all — code written against it wouldn't error, it would just always see `undefined` and treat every subscription invoice as a one-off. `handlers/invoice.ts`'s `resolveSubscriptionRef()` is the one place this gets read.
- **`PaymentIntent` has no `.invoice` field at all.** The link now only exists on `InvoicePayment`, queried by `stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: id } })`. `handlers/paymentIntent.ts`'s `findInvoiceIdForPaymentIntent()` does this lookup rather than reading a field that no longer exists.

Both are exactly the Basil bug's shape — a plausible, commonly-assumed field silently absent, no error, no exception — just on different objects. This is the concrete case for §0 rule 9: every Stripe field this codebase reads is checked against the pinned version's actual reference before being written into a handler, not recalled from memory or copied from an older tutorial.

## The processor claims work outside the transaction that flips its status (Phase 3)

`api/src/webhooks/processor.ts`'s `claimBatch()` is a short transaction: `SELECT ... FOR UPDATE SKIP LOCKED` a batch of `received` rows whose backoff has elapsed, immediately flip them to `processing` with `processing_started_at = now()`, commit. The actual handler work — including the Stripe API re-fetch — happens *after* that transaction has already committed, never inside it. Holding a database transaction (and its row locks) open across a slow external network call would serialize work that `SKIP LOCKED` is specifically meant to parallelize, and would hold locks for however long Stripe's API takes to respond instead of however long the local write takes.

This is also why a lease-based reaper exists instead of relying on transaction rollback: since the claim transaction is short and already committed, a worker that dies *after* claiming a row but *before* finishing it leaves that row genuinely stuck at `status='processing'` — there's no open transaction left to roll back. `api/src/webhooks/reaper.ts` runs on its own interval, returns any row whose lease (`WEBHOOK_LEASE_SECONDS`) has expired back to `received` (incrementing `attempts`), or parks it `failed` if that reaping would push `attempts` to the cap. Both the reaper and a genuine handler failure share the same backoff/park logic and the same `attempts` counter — a worker that keeps crashing on one event and one that keeps throwing on it are, from the ledger's point of view, indistinguishable failure modes, and both eventually stop retrying rather than looping forever.

_(Further sections — dunning, reconciliation, test clocks — are added here as the phases that implement them land.)_

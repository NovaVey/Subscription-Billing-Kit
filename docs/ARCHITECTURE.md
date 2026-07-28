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

## Outbound idempotency: one module owns every key (Phase 4)

`api/src/stripe/idempotency.ts` is the only place a mutating outbound Stripe call's `idempotencyKey` gets built. No route or helper constructs its own. This matters because outbound idempotency is where the money actually goes missing: a checkout session or plan-change call that times out on our side *after* Stripe already processed it, followed by a naive retry with no key (or a fresh one), creates a second Stripe object — and for a subscription, bills the customer twice. Inbound idempotency (the webhook ledger's primary key) gets all the design attention in most integrations; this is the outbound half of the same problem.

Two different idempotency strategies are used deliberately, by operation shape:
- **Customer creation is keyed on `external_ref` alone** — no timestamp. The same `external_ref` must never produce two Stripe customers, no matter how much later a retry arrives, so `customerCreateKey()` is fully deterministic forever. This is also backed by a local-first check in the route (`routes/customers.ts`): Stripe's own idempotency keys expire after a retention window (currently 24h), so a request for an `external_ref` that already has a local row returns that row directly without calling Stripe again at all, rather than depending on Stripe's cache still being warm.
- **Checkout sessions, portal sessions, plan changes, cancellations, and resumes are keyed on the operation's identity plus a `requestedAt` timestamp the caller captures once**, per the `sub:{id}:plan:{price_id}:{requested_at_iso}` shape from §5.5. These operations are legitimately repeatable over a subscription's lifetime (a customer can change plans more than once), so a permanent key would be wrong — but a retry of *this specific* request (our own code catching a network error and retrying the same Stripe call, not a brand-new HTTP request from our API's caller) reuses the same `requestedAt` and reproduces the same key.

## Manual admin actions always write to the audit trail, even when status doesn't change (Phase 4)

`api/src/stripe/sync.ts`'s `syncSubscriptionFromStripe()` only calls `recordTransition()` when `fromStatus !== toStatus` by default — the right behavior for webhook-driven syncs, where writing a row for every metadata-only update would flood the timeline with noise. But §5.8 is explicit that "no admin mutation may bypass" the audit trail, and a plan change is exactly the case where `status` typically *doesn't* change (`active` stays `active`) even though a real, notable action just happened. The `forceRecord` option exists for exactly this: `routes/subscriptions.ts`'s cancel/resume/plan-change routes always pass it, so a `subscription_events` row with `reason='manual:api'` and a descriptive `note` lands regardless of whether `status` moved. Tested directly: canceling with `at_period_end=true` leaves `status='active'` but still produces a `manual:api` audit row.

## Admin actions re-fetch and re-sync rather than trusting the mutation response (Phase 4)

Stripe's `update`/`cancel`/`resume` calls return the subscription's new state directly — but `routes/subscriptions.ts` doesn't project that response. It calls `stripe.subscriptions.retrieve(id, {expand: ['items.data.price']})` immediately afterward and syncs *that*, through the identical `syncSubscriptionFromStripe()` path a webhook uses. This is the same §5.6 discipline applied to writes, not just reads: trusting the mutation response's shape directly would mean remembering to pass the right `expand` on every mutating call site, forever, or risk `item.price` silently being a bare id string instead of the full object the projection code expects. One extra API call buys one fewer place this can quietly break.

_(Further sections — reconciliation, test clocks in the demo — are added here as the phases that implement them land.)_

## The dunning stage machine is a fixed table, not a retry loop (Phase 5)

`api/src/billing/dunning.ts` implements §5.10 as an explicit escalation table (`STAGE_GAP_DAYS`), the same discipline `stateMachine.ts` uses for subscription status. Stripe Smart Retries already owns re-charging a failed invoice (D-014); this system only ever does two things in response - sends a notice, and records a stage - never a second, parallel retry schedule of its own.

Resolution is keyed to the specific invoice that opened the cycle (`dunning_state.triggering_invoice_id`), not the subscription or customer, so a second, unrelated invoice being paid can't clear a cycle it has nothing to do with (D-012). Escalation timing reads the stage-to-stage gaps in §5.10's table as relative to whichever stage a cycle just entered, not cumulative from the cycle's original open - `dunning_state`'s single, mutable `entered_stage_at` column is the schema-level evidence for that reading (D-021).

## A cycle's stage-advance and its notice are armed together; sending is a separate, retriable pass (Phase 5)

Every escalation (`escalateDueCycles()`) does two things in one transaction: advances `dunning_state.stage` (guarded by an optimistic `where stage = fromStage`, so a row a concurrent tick already moved is skipped rather than double-escalated) and arms the target stage's `dunning_notices` row with `sent_at` left null. Actually calling the email adapter and confirming `sent_at` happens afterward, in a completely separate pass (`sendUnsentDunningNotices()`) that scans *every* notice row with `sent_at is null` system-wide - not just ones this tick's own escalation just armed.

This split is what makes the crash-safety property in D-013/D-022 real rather than aspirational: a crash between the escalation transaction committing and the send confirming leaves a `dunning_notices` row that is durably armed but unsent. Nothing about `dunning_state` changed in that window (stage already advanced, so the escalation pass's own selection criteria won't touch this cycle again), so if the send pass were coupled to the escalation pass, that notice would be stranded forever. Decoupling them means the next tick's send pass finds it and sends it, exactly once - `sent_at is null` is checked immediately before sending and written immediately after, so a second pass over the same row after a successful send is a no-op, not a re-send.

Opening a brand-new cycle (`openDunningCycleOnPaymentFailed()`) and re-arming an in-progress cycle's notice use the same underlying upsert, but with different reset semantics: opening a cycle is only ever reached when the caller already knows no cycle is currently open, so any existing stage-1 notice row must be stale, left over from an earlier, already-resolved cycle - safe to reset unconditionally. Mid-cycle escalation must never do that (it would erase a same-cycle send that already succeeded right before a crash), so it only inserts if no row exists yet.

## Dunning stage 4 is an access change, not a notification; the integrating product enforces access, not this kit (Phase 5)

§5.10's table describes stages 1-3 as communications (banner, email, second email, final notice) and stage 4 as "access revoked, marked terminal" - a state change, not a fourth email. `dunning_state.stage` itself is the signal a consuming product reads (via `GET /dunning/queue` or `GET /subscriptions/:id`) to decide what "downgraded" (`stage >= 3`) or "revoked" (`stage >= 4`) means for its own UI and feature gates; this kit is billing infrastructure (§1), not the SaaS product itself, so it stops at recording and exposing that state rather than inventing a parallel `access_revoked` flag §4's schema doesn't define (D-024).

A subscription actually being deleted in Stripe (`customer.subscription.deleted`) and a cycle merely timing out to stage 4 both reach the same stage number, but only the former closes the cycle (`resolved_at` set, `resolution='canceled'`) - there's nothing left to collect on a deleted subscription. A cycle parked at stage 4 by the timeout alone stays open, because a late `invoice.paid` on the triggering invoice can still recover it (D-023).

## Test clock helpers exist from Phase 5, verified against the SDK's actual types (Phase 5)

`scripts/test-clock.ts` (`createTestClock`/`advanceTestClock`/`teardownTestClock`) wraps `stripe.testHelpers.testClocks`, verified against the installed SDK's own `TestHelpers/TestClocks.d.ts` rather than assumed: params are `frozen_time` in Unix seconds, and deletion is `.del()`, not the more commonly assumed `.delete()`. Advancing a clock is asynchronous - Stripe replays every event the jump generates in the background, and the clock's `status` only reaches `'ready'` once that settles - so `advanceTestClock()` polls status rather than returning as soon as the `.advance()` call itself resolves, which happens well before the simulated events do.

This sandbox has no network path to `api.stripe.com` (unchanged since Phase 0), so these helpers are written and type-verified but not exercised against a real test clock from here. The dunning stage machine's escalation arc (stage 1 through terminal, then recovery) is instead verified deterministically in `test/integration/dunning.test.ts` by backdating `dunning_state.next_action_at` and calling `runDunningTick()` directly - proving the same tick logic a real test clock's time jump would exercise, without needing the network access to actually jump simulated time. (A real test clock run against the deployed service, from a machine with actual internet access, later confirmed this end to end - see `PROGRESS.md`'s "live test-clock verification" entries, including the ~1 hour renewal-invoice draft window documented in D-025 below.)

## Reconciliation compares two independent views of the same invoices, never just their totals (Phase 6)

`api/src/billing/reconcile.ts` splits into a pure classifier (`classifyInvoices()`) and an I/O wrapper (`runReconciliation()`), the same separation `stateMachine.ts` and `billing/dunning.ts` use - the classifier takes two plain lists of `{stripeInvoiceId, status, amountDueMinor, amountPaidMinor}` snapshots and returns every disagreement, so it's fully unit-testable without a database or the Stripe SDK. Every Stripe invoice absent locally is `missing_local` (usually a dropped webhook); every local invoice absent from Stripe is `orphan_local` (usually a bad backfill); a shared invoice with any differing field produces one `field_drift` entry per differing field, naming the field and both values, rather than one vague "mismatch" entry per invoice.

Totals alone would hide the case that matters most: a missing invoice and an extra one of equal value net to zero (§5.11's own framing, verified directly in `test/unit/reconcile.test.ts`). The headline totals (`stripe_total_minor`/`local_total_minor`) exist as a per-currency sanity check on top of the detailed report, not instead of it - see D-026 for why they sum `amount_paid_minor` specifically.

`runReconciliation()` bounds the comparison by each local invoice's `finalized_at` and Stripe's own `created` filter on `GET /v1/invoices` - the closest matching concept to "when was this invoice issued" that both sides actually have, since §4's schema has no dedicated invoice creation timestamp (D-025). Stripe's List Invoices endpoint has no `currency` filter at all (checked against the pinned version's actual parameter list, not assumed), so every invoice in the date window is fetched and filtered to the requested currency in application code (D-027) - consistent with reconciliation always operating on one currency at a time.

"Yesterday" for the nightly job is computed explicitly in `RECONCILE_TZ` (`computeYesterdayWindow()`), not server-local time - the exact ambiguity §5.11 warns shows up as a phantom mismatch twice a year. Implemented with `Intl.DateTimeFormat` rather than a date-timezone library, since none is in the approved stack; the one accepted imprecision is that a "yesterday" window spanning an actual DST transition uses a single UTC offset for both boundaries; see D-025's neighbor decisions for the general pattern of accepting narrow, documented edge cases here rather than adding a dependency to close them completely. Unlike the dunning tick, the nightly run has no in-process interval - `scripts/reconcile-nightly.ts` is meant for an external cron, since once-a-day work has no dev-testing reason to run on a fast loop (D-028).

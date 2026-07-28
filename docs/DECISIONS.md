# Decisions

Why this system is built the way it is. One entry per non-obvious call, written
when the call is made.

`PROGRESS.md` records state and goes stale. This file records reasoning and
stays true. If someone asks "why did you do it that way" and the answer isn't
here, the answer is already lost.

Entries D-001 to D-014 were settled by the build spec before Phase 0. Later
entries come from build decisions and continue the numbering. Never delete an
entry — supersede it with a new one and mark the old one `superseded by D-0NN`.

**Template**

## D-0NN — <the decision, in one sentence>
**Date:** YYYY-MM-DD · **Phase:** N · **Status:** settled
**Decision:** what we do.
**Alternative rejected:** what we could have done instead.
**Why it lost:** the failure it causes or the cost it carries.
**Revisit if:** the condition that would reopen this.

---

## D-001 — Pin the Stripe API version explicitly
**Date:** 2026-07-27 · **Phase:** 0 · **Status:** settled
**Decision:** The Stripe client is constructed with an explicit apiVersion from env. `/health` reports it. The dashboard webhook endpoint must match.
**Alternative rejected:** Use the account's default API version.
**Why it lost:** Stripe's Basil release (2025-03-31) moved fields off the Subscription object. Accounts on the default version got 200 OK responses with those fields silently undefined — no error, no exception, just null renewal dates in production.
**Revisit if:** Never unpinned. Version bumps are a deliberate, tested change with a fixture re-capture.

## D-002 — Billing periods live on subscription items, not on the subscription
**Date:** 2026-07-27 · **Phase:** 1 · **Status:** settled
**Decision:** `subscription_items` holds `current_period_start`/`current_period_end`. `subscriptions.next_period_end_derived` is min(items) and labelled derived everywhere it surfaces.
**Alternative rejected:** Keep a single period pair on the subscription row.
**Why it lost:** Post-Basil those fields don't exist on the subscription object, and mixed-interval subscriptions mean there is no single correct period to fall back to.
**Revisit if:** Never. Reverting reintroduces the exact silent-null bug this repo exists to demonstrate handling.

## D-003 — Return 200 only after the webhook insert commits
**Date:** 2026-07-27 · **Phase:** 2 · **Status:** settled
**Decision:** Verify signature, insert, commit, then 200. Persist failure returns 500.
**Alternative rejected:** Ack immediately, persist asynchronously.
**Why it lost:** A 200 tells Stripe the event was delivered and retries stop. If the insert then fails, the event is gone permanently — and every dashboard still looks healthy.
**Revisit if:** Never.

## D-004 — Business logic runs in a separate processor, not in the webhook handler
**Date:** 2026-07-27 · **Phase:** 3 · **Status:** settled
**Decision:** The receiver only persists. A processor loop applies events.
**Alternative rejected:** Handle events inline in the request.
**Why it lost:** Stripe retries on slow responses. Inline handling couples processing time to delivery semantics, so a slow API call becomes a duplicate event.
**Revisit if:** Never.

## D-005 — Postgres SKIP LOCKED as the queue, not Redis or BullMQ
**Date:** 2026-07-27 · **Phase:** 3 · **Status:** settled
**Decision:** The processor claims rows with `FOR UPDATE SKIP LOCKED` plus a lease column.
**Alternative rejected:** A dedicated queue (BullMQ + Redis).
**Why it lost:** Postgres is already a hard dependency; Redis would be a second one for no gain at this volume, and it splits the source of truth across two stores during incident triage.
**Revisit if:** Sustained webhook volume makes the polling loop a bottleneck, or ordering guarantees beyond D-007 become necessary.

## D-006 — Re-fetch objects from the Stripe API instead of trusting the payload
**Date:** 2026-07-27 · **Phase:** 3 · **Status:** settled
**Decision:** On processing, fetch the object by id and project that.
**Alternative rejected:** Project the webhook payload directly — fewer API calls, faster, cheaper.
**Why it lost:** The payload is a snapshot from when the event fired. Out-of-order delivery then writes stale state over fresh state. The extra call buys correctness under the exact conditions that break naive integrations.
**Revisit if:** Rate limits become a constraint at high volume; even then, only for event types where staleness is provably harmless.

## D-007 — Lease plus reaper, not bare SKIP LOCKED
**Date:** 2026-07-27 · **Phase:** 3 · **Status:** settled
**Decision:** Claimed rows record `processing_started_at`; a reaper returns rows past `WEBHOOK_LEASE_SECONDS` to `received`.
**Alternative rejected:** Rely on SKIP LOCKED alone.
**Why it lost:** A worker killed mid-event (deploy, OOM) leaves its row in `processing` forever and the event is never applied. Silent, and invisible until reconciliation catches the downstream drift weeks later.
**Revisit if:** Lease length needs tuning — that's a config change, not a design change.

## D-008 — Outbound idempotency keys built centrally
**Date:** 2026-07-27 · **Phase:** 4 · **Status:** settled
**Decision:** Every mutating Stripe call carries a deterministic key from `idempotency.ts`. No call site builds its own.
**Alternative rejected:** Rely on inbound idempotency only, or let each call site construct keys ad hoc.
**Why it lost:** A timed-out create call that actually succeeded, then retried, creates a second subscription and double-bills. Inbound idempotency gets the attention; outbound is where money actually goes missing. Ad hoc keys drift and stop matching on retry.
**Revisit if:** Never.

## D-009 — Money is currency-aware minor units, never "cents"
**Date:** 2026-07-27 · **Phase:** 1 · **Status:** settled
**Decision:** `money.ts` takes a currency with every amount, keeps a zero-decimal set, and is the only module that scales amounts.
**Alternative rejected:** Name everything `_cents` and divide by 100 to display.
**Why it lost:** JPY, KRW and others are zero-decimal. ¥1000 is `1000`, not `100000`. Dividing by 100 is wrong by 100x, in the direction of undercharging or over-refunding.
**Revisit if:** Never.

## D-010 — Totals are per currency and never summed across currencies
**Date:** 2026-07-27 · **Phase:** 6 · **Status:** settled
**Decision:** Reconciliation runs are scoped to one currency. No aggregate revenue figure spans currencies anywhere.
**Alternative rejected:** Convert to a base currency for a single headline number.
**Why it lost:** Conversion requires picking a rate and a date, which makes the number an opinion. A reconciliation report whose totals are an opinion cannot prove anything.
**Revisit if:** A client explicitly wants a converted view — then it's a separate, clearly-labelled report, not the reconciliation.

## D-011 — bigint for reconciliation totals
**Date:** 2026-07-27 · **Phase:** 1 · **Status:** settled
**Decision:** `reconciliation_runs` totals are bigint. Per-invoice amounts stay integer.
**Alternative rejected:** integer throughout.
**Why it lost:** A 90-day total in minor units overflows int4 above roughly $21.5M. Per-invoice amounts realistically don't.
**Revisit if:** Never.

## D-012 — Dunning is keyed to the triggering invoice
**Date:** 2026-07-27 · **Phase:** 5 · **Status:** settled
**Decision:** `dunning_state.triggering_invoice_id` records what opened the cycle; only that invoice being paid resolves it. Invoices with no subscription never open a cycle.
**Alternative rejected:** Key dunning to the subscription and resolve on any `invoice.paid`.
**Why it lost:** A customer with two subscriptions, or one paid one-off invoice, would clear a dunning cycle it has nothing to do with — restoring access to someone who still hasn't paid.
**Revisit if:** Never.

## D-013 — One notice per stage enforced by a unique constraint
**Date:** 2026-07-27 · **Phase:** 5 · **Status:** settled
**Decision:** `unique (subscription_id, stage)` on `dunning_notices`, with `queued_at` written before send and `sent_at` after.
**Alternative rejected:** An application-level check before sending.
**Why it lost:** A crash between the check and the write lets the next tick send a second email. The database can enforce this unconditionally; application logic can only enforce it when it happens to be running.
**Revisit if:** Multi-channel notices per stage are needed — then the constraint gains the channel column rather than being dropped.

## D-014 — Dunning notifies and downgrades; it never retries charges
**Date:** 2026-07-27 · **Phase:** 5 · **Status:** settled
**Decision:** This system sends notices and flips access flags. Stripe Smart Retries owns re-charging.
**Alternative rejected:** Our own retry schedule.
**Why it lost:** Two independent retry schedules against one invoice risks double charges, and Stripe's retry timing is tuned on far more data than we have.
**Revisit if:** A client has Smart Retries disabled and explicitly wants us to own it — a scoped change, quoted separately.

## D-015 — UGX (and ISK) are excluded from the zero-decimal set
**Date:** 2026-07-27 · **Phase:** 1 · **Status:** settled
**Decision:** `money.ts`'s zero-decimal currency set omits UGX and ISK, even though both are conceptually zero-decimal currencies today.
**Alternative rejected:** Include every currency that's "really" zero-decimal, going by general currency knowledge.
**Why it lost:** Confirmed against Stripe's current currencies reference rather than assumed from memory: Stripe kept UGX and ISK API amounts two-decimal for backward compatibility (the decimal digits are always `"00"`, but the API still expects amounts multiplied by 100). Adding them to the zero-decimal set would silently undercharge every UGX or ISK invoice by 100x — the same class of bug D-001 exists to prevent, just discovered from the opposite direction: assuming a currency is zero-decimal without checking, instead of assuming it isn't.
**Revisit if:** Stripe changes UGX/ISK's API treatment (their currencies reference is the source of truth to recheck, not this entry).

## D-016 — The pg Pool gets an explicit `'error'` listener
**Date:** 2026-07-27 · **Phase:** 2 · **Status:** settled
**Decision:** `api/src/db/client.ts`'s `pool.on('error', ...)` logs idle-client connection errors instead of leaving them unhandled.
**Alternative rejected:** No listener — the pattern most `pg.Pool` examples (including Stripe/Node tutorials in general) show by default.
**Why it lost:** Discovered live while demonstrating Phase 2's "DB down → 500" checkpoint by actually stopping Postgres mid-request: without this listener, the idle client's connection-terminated error was an *unhandled* `EventEmitter` `'error'` event, which Node treats as fatal — it crashed the entire process, taking down every in-flight request, not just the one that happened to be querying. A routine database restart shouldn't be able to take the whole service offline.
**Revisit if:** Never — this listener costs nothing and the failure mode it prevents is total.

## D-017 — The staleness guard compares timestamps, it doesn't re-derive correctness from re-fetching
**Date:** 2026-07-27 · **Phase:** 3 · **Status:** settled
**Decision:** `handlers/subscription.ts` and `handlers/invoice.ts` compare `event.created` against the row's `last_event_at` *before* re-fetching, and skip entirely (no re-fetch, no write) if the event is older.
**Alternative rejected:** Always re-fetch and let the API's current-truth response naturally overwrite whatever an older event would have shown — skip the timestamp check as redundant, since a re-fetch never returns stale data.
**Why it lost:** Re-fetching does always return current truth, so the data itself is never actually wrong — but *applying an older event's semantics after a newer one* would still write a misleading `subscription_events` row (e.g. a `-> trialing` transition appearing chronologically after an already-recorded `-> canceled` one) and could re-run side effects tied to that specific event type. The guard protects the audit trail and event-specific logic, not the projected data.
**Revisit if:** Never — this is a correctness property, not a performance optimization that could be safely dropped.

## D-018 — Invoice's subscription reference and PaymentIntent's invoice reference, verified against the SDK's types instead of assumed
**Date:** 2026-07-27 · **Phase:** 3 · **Status:** settled
**Decision:** `handlers/invoice.ts` reads `invoice.parent.subscription_details.subscription` (not `invoice.subscription`); `handlers/paymentIntent.ts` resolves the linked invoice via `stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: id } })` (not `paymentIntent.invoice`).
**Alternative rejected:** Read `invoice.subscription` and `paymentIntent.invoice` directly — the shape assumed by most existing tutorials, blog posts, and this pinned version's predecessors.
**Why it lost:** Checked against the installed Stripe SDK's own type definitions (generated from Stripe's OpenAPI spec for this exact pinned version) rather than recalled from memory or copied from older material: neither field exists on either object in this API version. Both are the Basil period-fields bug's exact shape — a plausible field silently absent, no error, no exception — just discovered on two different objects instead of one.
**Revisit if:** Never, unless a future API version restructures these again — in which case the fix is the same discipline that caught it here: check the pinned version's actual types before writing the handler.

## D-019 — Customer creation is keyed on external_ref forever; other mutations are keyed on external_ref + a captured timestamp
**Date:** 2026-07-27 · **Phase:** 4 · **Status:** settled
**Decision:** `customerCreateKey()` never expires (no timestamp component) and is backed by a local-first DB check. `checkoutSessionKey()`, `portalSessionKey()`, and the subscription plan-change/cancel/resume keys all include a `requestedAt` the caller captures once per logical request.
**Alternative rejected:** Use the same "operation identity + timestamp" shape for every mutating call, including customer creation.
**Why it lost:** A customer should only ever exist once per `external_ref`, permanently — a timestamped key would let a retry arriving after Stripe's idempotency-key retention window (currently 24h) create a second Stripe customer. Checkout sessions, plan changes, and cancellations are different: they're legitimately repeatable actions over a subscription's lifetime, so a permanent key would incorrectly block a second, genuinely new plan change to the same price at a later date.
**Revisit if:** Never for customer creation. For the timestamped operations, revisit only if evidence shows retries commonly arrive later than intended (e.g. a slow client-side retry loop) - the fix would be widening the local-first check pattern, not changing the key shape.

## D-020 — Manual admin actions force an audit row via an explicit flag, not by inferring "was this manual"
**Date:** 2026-07-27 · **Phase:** 4 · **Status:** settled
**Decision:** `syncSubscriptionFromStripe()` takes an explicit `forceRecord` option. Webhook-driven calls leave it unset (record only on status change); the cancel/resume/plan-change routes always pass `forceRecord: true`.
**Alternative rejected:** Have `syncSubscriptionFromStripe()` infer "this was a manual action" from context (e.g., checking whether `stripeEventId` is null).
**Why it lost:** An explicit flag says what the caller intends; inferring it from the absence of a webhook event id is indirect and would silently change behavior if a future caller ever synced from a manual action that happened to have an event id available (or vice versa). §5.8 requires every manual mutation to hit the audit trail regardless of whether status changed - that requirement belongs at the call site that knows it's handling a manual action, not buried in a heuristic.
**Revisit if:** Never — this is a one-line flag, not a maintenance burden.

## D-021 — Escalation gaps are measured from the stage just entered, not cumulatively from the cycle's original open
**Date:** 2026-07-27 · **Phase:** 5 · **Status:** settled
**Decision:** `nextActionAtForStage()` computes each escalation's due time as `entered_stage_at + gap`, where the 3/7/14-day gaps from §5.10's table apply relative to whichever stage a cycle just entered — day 0 opens stage 1, +3 days from *that* escalates to stage 2, +7 days from *stage 2's own entry* escalates to stage 3, +14 days from *stage 3's own entry* reaches stage 4.
**Alternative rejected:** Read the table as a fixed, cumulative timeline from the cycle's original open (day 0/3/7/14 all measured from the first `invoice.payment_failed`).
**Why it lost:** Both readings are grammatically defensible from the table's text alone, but `dunning_state` only has a single, mutable `entered_stage_at` column — no separate "cycle opened at" timestamp. A cumulative-from-open design would need that second column to know how much time has elapsed since the cycle *started*, independent of the current stage; its absence from §4's schema is the deciding evidence for the relative reading, not a guess.
**Revisit if:** A real dunning cadence review calls for cumulative timing — that would need a schema change (an `opened_at` column) alongside it, not just a code change.

## D-022 — Notice escalation and notice sending are two separate passes, not one atomic step
**Date:** 2026-07-27 · **Phase:** 5 · **Status:** settled
**Decision:** `runDunningTick()` runs an escalation pass (advance `dunning_state.stage` and arm the target `dunning_notices` row, `sent_at` left null, in one transaction) and then a send pass that scans *every* `dunning_notices` row with `sent_at is null` system-wide — not just the ones this tick's own escalation pass just armed — and sends each exactly once.
**Alternative rejected:** Advance the stage, write the notice row, call the email adapter, and record `sent_at`, all as steps of one continuous operation per due cycle.
**Why it lost:** A crash after the stage-advance-plus-arm transaction commits but before the send confirms would otherwise strand that notice forever — the escalation pass's own selection criteria (`stage = fromStage AND next_action_at <= now`) no longer matches a row whose stage has already advanced, so nothing would ever retry the send. A decoupled, system-wide "send anything unsent" pass is what actually satisfies D-013's crash-safety property, not the unique constraint alone.
**Revisit if:** Never, unless notices gain their own independent retry/backoff schedule distinct from the tick interval.

## D-023 — `customer.subscription.deleted` closes an open dunning cycle as `resolution='canceled'`; a pure stage-4 timeout does not
**Date:** 2026-07-27 · **Phase:** 5 · **Status:** settled
**Decision:** `closeDunningOnSubscriptionDeleted()` sets `stage=4`, `resolved_at=now()`, `resolution='canceled'` when a subscription is actually deleted while a cycle is open. Reaching stage 4 purely by the +14-day timeout (§5.10's table) advances `stage` and stops escalating, but leaves `resolved_at`/`resolution` null — the cycle stays open, just parked at its terminal stage.
**Alternative rejected:** Treat both stage-4 triggers identically - just a stage number, no distinct resolution.
**Why it lost:** `dunning_state.resolution`'s enum (`recovered`/`canceled`/`manual`) has no other event in this codebase that could ever produce `'canceled'` - the table's own vocabulary implies it exists for exactly this case. A subscription that's actually gone in Stripe has nothing left to collect on, so closing the cycle is correct; a subscription merely stuck at stage 4 while still nominally active might still recover via a late `invoice.paid` on the triggering invoice, so it must stay open.
**Revisit if:** Never.

## D-024 — Stage 4 sends no notice; access enforcement is the integrating product's job, not this kit's
**Date:** 2026-07-27 · **Phase:** 5 · **Status:** settled
**Decision:** `escalateDueCycles()` arms and sends a notice for stages 1-3 only. Stage 4's action per §5.10's table is "access revoked, marked terminal" - a state change this kit records as `dunning_state.stage`, not a communication it sends and not a feature flag it flips anywhere else.
**Alternative rejected:** Add a `feature_downgraded`/`access_revoked` boolean (or similar) to `dunning_state` and a fourth notice template for stage 4.
**Why it lost:** §4's schema is the exhaustive table list for this build; inventing a new column for "access state" would duplicate information the `stage` integer already carries ordinally (`stage >= 3` is the downgrade signal, `stage >= 4` is the revoked signal) for a system whose job, per §1, is billing infrastructure - not the SaaS product's own feature-gating. The integrating product reads `dunning_state.stage` (via `GET /dunning/queue` or `GET /subscriptions/:id`) and decides what "downgraded" or "revoked" means for its own UI and access checks. Table rows 1-3 describe communications (banner, email, second email, final notice); row 4 describes a state change - the asymmetry in the spec's own wording is the signal, not an oversight to paper over.
**Revisit if:** A client's product can't do its own stage-based gating and needs this kit to expose a purpose-built boolean - a scoped addition, not a reinterpretation of what exists today.

## D-025 — Reconciliation windows are bounded by `finalized_at`, not `period_start`/`period_end`
**Date:** 2026-07-28 · **Phase:** 6 · **Status:** settled
**Decision:** `runReconciliation()` compares Stripe invoices created in a date range against local invoices whose `finalized_at` falls in that same range.
**Alternative rejected:** Bound the comparison by `invoices.period_start`/`period_end` (the columns already on the table).
**Why it lost:** `period_start`/`period_end` describe the *service period* an invoice bills for, not when the invoice itself was issued - a one-off invoice or an annual subscription's single invoice can have a service period spanning far outside the reconciliation window while being issued squarely inside it. Reconciliation asks "what did Stripe issue in this window," the same question `stripe.invoices.list({ created })` answers on Stripe's side - `finalized_at` is the closest matching concept §4's schema already has, without inventing a new "created" column for invoices.
**Revisit if:** The ~1 hour gap between an invoice's real creation and its finalization (see the Phase 5 test-clock verification in `PROGRESS.md`) ever causes a reconciliation window boundary to visibly misclassify an invoice - the fix would be adding a dedicated `created_at` column, a schema change, not a code change.

## D-026 — Reconciliation's headline total is amount actually collected, not amount billed
**Date:** 2026-07-28 · **Phase:** 6 · **Status:** settled
**Decision:** `reconciliation_runs.stripe_total_minor`/`local_total_minor` sum each side's `amount_paid_minor` across the window, per currency.
**Alternative rejected:** Sum `amount_due_minor` (total billed) instead, or report both.
**Why it lost:** §1 frames the problem reconciliation solves as "does what we billed match what Stripe collected" - the number a client actually wants to see agree is money that moved, not money that was merely invoiced. The detailed `report` entries already catch `amount_due_minor` drift per invoice regardless of this choice, so nothing is lost by picking one figure for the headline total.
**Revisit if:** A client specifically wants billed-vs-collected shown side by side - additive (a second total column), not a reversal of this one.

## D-027 — Currency filtering happens client-side, after fetching Stripe's invoice list
**Date:** 2026-07-28 · **Phase:** 6 · **Status:** settled
**Decision:** `runReconciliation()` fetches every Stripe invoice in the `created` date range (Stripe's only list-level date filter for invoices) and discards ones not matching the requested currency in application code.
**Alternative rejected:** Assume a `currency` query parameter exists on Stripe's List Invoices endpoint.
**Why it lost:** Checked against the pinned version's actual API reference (§0 rule 9) rather than assumed: `GET /v1/invoices` has no `currency` filter parameter at all - only `collection_method`, `created`, `customer`, `due_date`, `status`, `subscription`, and pagination cursors. A reconciliation run already only ever asks about one currency at a time (§5.9/§5.10: totals are never summed across currencies), so the extra client-side filter is cheap and correct, just not push-down-able to Stripe's own query.
**Revisit if:** Stripe adds a currency filter to this endpoint - worth revisiting only if reconciliation windows start returning enough invoices that fetching every currency's worth becomes a real cost, which hasn't been observed.

## D-028 — Reconciliation is a cron-invoked script only; no in-process interval
**Date:** 2026-07-28 · **Phase:** 6 · **Status:** settled
**Decision:** `scripts/reconcile-nightly.ts` is the only way the nightly job runs - there is no `setInterval` for it in `webhooks/worker.ts`, unlike the dunning tick.
**Alternative rejected:** Give reconciliation its own short-interval loop in the same in-process worker as the webhook processor/reaper/dunning tick, matching §5.12's "every 15 min in dev, cron in prod" framing for dunning.
**Why it lost:** §5.11 describes reconciliation as "nightly job + on-demand run" without that same dev-interval language - a once-a-day job has no dev-testing reason to run every few minutes the way dunning's escalation logic did (dunning needed a fast loop specifically so a test clock's simulated days could be observed ticking forward in real seconds). The on-demand path (`POST /admin/reconciliation/run`) already covers ad hoc/manual runs and testing.
**Revisit if:** A client wants automatic nightly runs without relying on their own infrastructure's cron - at that point this could move into the in-process worker gated by a check like "has today's run already happened," not a bare interval.

## D-029 — CORS is scoped to `APP_BASE_URL`, not a wildcard or a new env var
**Date:** 2026-07-28 · **Phase:** 7 · **Status:** settled
**Decision:** `app.ts` registers `@fastify/cors` with `origin: env.APP_BASE_URL`.
**Alternative rejected:** `origin: true` (reflect any requesting origin), or a new `ADMIN_UI_ORIGIN` env var.
**Why it lost:** §2 already defines `APP_BASE_URL` as "the admin UI's own base URL" (`http://localhost:5173` in dev); it names exactly the one origin that legitimately calls these admin endpoints from a browser. A wildcard would work but would let any web page's script call the admin API using an admin's cookies/credentials if one were ever added - unnecessary exposure for a value already available. Inventing a second env var for the same fact the config already states would be redundant, not more precise.
**Revisit if:** The admin UI is ever served from more than one origin (e.g. a staging domain and a production domain simultaneously) - at that point `origin` would need to become a list, sourced from config, not a hypothetical guess now.

## D-030 — The admin UI keeps its own `money.ts`/`format.ts`, not a shared package
**Date:** 2026-07-28 · **Phase:** 7 · **Status:** settled
**Decision:** `web/src/lib/money.ts` re-declares the zero-decimal currency set from `api/src/lib/money.ts` rather than importing the API's module directly.
**Alternative rejected:** Add a `packages/shared` workspace both `api` and `web` depend on, exporting one canonical `money.ts`.
**Why it lost:** §3's repo layout names exactly `/api`, `/web`, `/docs`, `/scripts` - no shared package. The API's `money.ts` does more than the frontend needs (`toMinor`, `addSameCurrency`, mixed-currency guards) and is written for server-side correctness (throwing on mixed currencies before a charge is created); the frontend only ever needs one direction - display - so a smaller, purpose-built module is simpler than importing a cross-workspace dependency for a single shared constant. The zero-decimal list itself is Stripe's own published fact, not something that drifts independently on either side, so keeping both copies in sync by hand is a one-line diff if Stripe ever changes it, not an ongoing coordination cost.
**Revisit if:** A third consumer of this money logic appears (a second frontend, a CLI), at which point a real shared package pays for itself.

## D-031 — react-router-dom, chosen explicitly since §2 doesn't name a router
**Date:** 2026-07-28 · **Phase:** 7 · **Status:** settled
**Decision:** `web`'s six screens route through `react-router-dom`'s `createBrowserRouter`.
**Alternative rejected:** Hand-rolled routing (a switch on `window.location.pathname`), or a different router library.
**Why it lost:** §2 lists "React + Vite + Tailwind for the admin UI" but doesn't name a router, and §0 rule 5 says to ask before adding any dependency not listed - asked directly, and `react-router-dom` was the answer, as the standard, actively-maintained choice for exactly this shape of app (nested layout, six top-level routes, one with a dynamic `:id` segment).
**Revisit if:** Never, at this app's scale - a hand-rolled router would only pay off if this became a single-page app with no distinct routes at all, which isn't the direction §7 describes.

## D-032 — `GET /subscriptions/:id` gained a `customer` field; this was a pre-existing gap, not new scope
**Date:** 2026-07-28 · **Phase:** 7 · **Status:** settled
**Decision:** The subscription detail route now also selects and returns the linked `customers` row (email, external ref) alongside `subscription`, `items`, `timeline`, `invoices`, `dunning`.
**Alternative rejected:** Leave the route as-is and have the frontend make a second request (or accept showing only `customer_id`) for the detail screen's header.
**Why it lost:** §7's subscription detail screen is specified as "header facts, item list... event timeline... invoice list, actions" - a customer's email is the header's most basic fact, and the frontend has no other endpoint that maps a `customer_id` to an email. This was the same class of gap as the missing `dunning` field this route already had before Phase 7 (§6 says this endpoint returns "dunning" - it didn't until now either) - both existed because nothing before the admin UI needed them, not because they were deliberately deferred.
**Revisit if:** Never - this is the minimum the specified screen needs, not speculative extra surface.

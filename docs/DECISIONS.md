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

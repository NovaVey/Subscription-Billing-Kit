# Delivery

## Acceptance

The test suite passes on your account, in test mode — and a reconciliation run over your last 90 days of billing reports zero unexplained mismatches.

That's the whole pitch. Not "we integrated Stripe" — anyone can do that in an afternoon. The claim is that your webhooks, your subscriptions, and your invoices are provably in agreement with what Stripe actually has, and that agreement is something you can re-check yourself, on demand, forever, not just something you were told once at handover.

## Deliverables

- **Webhook ingestion with replay and recovery.** Every event lands in a durable ledger before anything else happens to it, keyed on Stripe's own event id so a duplicate delivery is a no-op. A worker that dies mid-event gets its work reclaimed automatically. A failed event can be replayed — from the admin UI, the API, or a CLI script — once whatever caused the failure is fixed.
- **Subscription sync with per-item periods.** Your local subscription state is projected from Stripe's own API, not trusted from webhook payloads, and correctly handles the fact that billing periods live on subscription items — not the subscription itself — including subscriptions that mix billing intervals.
- **Dunning workflow, with your copy.** A four-stage escalation (in-app notice → second notice → downgrade warning → access revoked) keyed to the specific invoice that triggered it, so an unrelated payment can't accidentally clear a real delinquency. Ships with placeholder copy; your actual notice copy goes in before launch, or we draft it with you.
- **Reconciliation report.** A nightly job (plus on-demand runs from the admin UI) that compares Stripe's own invoice records against yours for every period, classifies every discrepancy by type, and stores the result so you have a running history — not just a one-time check.
- **Admin screens, gated by a read or write key.** Subscriptions, subscription detail with a full event timeline, the dunning queue, invoices, the webhook log with replay, and reconciliation history — everything above, visible and actionable without a database client. A shared write key unlocks every action; a separate read-only key lets someone browse without being able to mutate anything.
- **Test suite.** Every failure mode this kit closes is backed by a named test, run in two suites (fast unit tests, slower integration tests against a real database) so the fast suite stays fast enough to run on every change.
- **Runbook.** `docs/RUNBOOK.md` — environment variables, deployment steps, and the two webhook gotchas that cost the most time on any Stripe integration (a wrong signing secret and a mismatched per-endpoint API version), spelled out before they cost you an afternoon too.
- **One handover call.** Walking through the admin UI, the runbook, and whatever's specific to your Stripe setup.

## Timeline

2–3 weeks.

## What I need from you

- Stripe account access — test mode first; a restricted API key scoped to what this integration actually touches, not a full secret key.
- Your current pinned API version (Stripe Dashboard → Developers → API keys shows it, or ask support if you're not sure — this is worth getting right from day one, not discovering later).
- Your plan structure — products, prices, billing intervals, any usage-based or metered pricing (see Out of scope below).
- Your dunning email copy, or explicit approval for me to draft it.
- One technical contact who can answer questions about the above without a scheduling loop.

## Out of scope

- Custom pricing models beyond standard subscription plans (metered billing, tiered/graduated pricing, per-seat calculations).
- Tax/VAT handling — this kit assumes Stripe Tax or your own tax handling is configured separately.
- Invoicing outside Stripe (a separate invoicing system, manual invoices not created through this pipeline).
- Migration from another billing processor — quoted separately, since the shape of that work depends entirely on what you're migrating from.

---
name: Claude Code
description: Lessons learned working on the Subscription Billing Kit - practical reminders for deployment, testing, and verification discipline when building/reviewing this codebase (or similar Stripe/Fastify/Postgres backends with an admin web UI).
when_to_use: Before merging a PR that adds env vars, writing or reviewing integration tests, producing a demo/screenshot deliverable, generating secrets, or acting on a feature request that references something not obviously in the codebase.
user-invocable: true
---

# Lessons from building the Subscription Billing Kit

Concrete, non-generic lessons from real incidents in this project. Apply
these when doing similar work here (or on a similar Stripe/Fastify/Postgres
service with an admin UI), not as generic advice.

## 1. Audit new required env vars against already-deployed environments

Before merging a change that introduces a new required environment
variable, check whether it's already set on the live deployment (e.g. via
`railway_list_variables`). A var that's fine in local `.env` can crash the
next deploy if it's missing on Railway/production. Do this check *before*
merging, not after a crashed deploy forces a rollback.

## 2. `app.inject()` is not a real browser - verify with a real client too

Fastify's `app.inject()` test harness does not set `Content-Type` on a
bodyless POST the way a real browser's `fetch()` does. This let
`resumeSubscription()` and `replayWebhookEvent()` silently 400 in the real
web UI (`FST_ERR_CTP_EMPTY_JSON_BODY`) for an entire phase's worth of work,
invisible to 180+ passing automated tests. Any route that sometimes sends
no body needs to be exercised through an actual browser/`fetch()` call (or
equivalent real HTTP client) at least once, not just through the in-process
test harness.

## 3. A bug fixed in one place may exist in other places too

When you fix a request-shape or logic bug in one call site, grep the rest
of the codebase for the same pattern before calling it done. (The
conditional `Content-Type` header fix in `web/src/lib/api.ts` request() is
a single shared helper here, so it fixed all callers at once - but don't
assume that's always true; check.)

## 4. Test/verification tooling needs the same scrutiny as production code

`scripts/smoke-test.ts` initially had auth-gate checks that silently passed
for the wrong reason (a 400 from Zod validation, not a genuine 404-before-
Stripe check) because some routes were called with no body. A test that
"passes" isn't proof of anything until you've confirmed it's failing for
the right reason when the code under test is wrong. Review test code
adversarially, the same way you'd review a payment-handling code path.

## 5. Inspect the actual deliverable, not just that automation didn't throw

A Playwright script completing without throwing does not mean the
recording/screenshot is correct. The first full-walkthrough demo video
silently captured a real error toast (the bug in lesson #2) because nothing
checked the *content* of what was recorded, only that each step ran. Always
look at the actual screenshot/video/output before sending it.

## 6. Don't print freshly-generated secrets into chat by default

Generating a new key and then displaying it in a chat response effectively
"uses it up" as a private value, even if the storage location (e.g. a
Railway env var) is correct. Default to setting secrets through tool calls
only and confirming success without echoing the value - point the user to
the dashboard/vault instead. Only show a generated value if explicitly
asked to.

## 7. If a requested feature/action doesn't exist, ask - don't silently substitute

When a request names something not present in the codebase (e.g. "show
deletion" when subscriptions are only ever canceled, never deleted), stop
and ask which real action they mean rather than guessing and building the
closest approximation.

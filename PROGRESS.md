# Progress

Running log of what's been built, by phase. This is how a new session resumes: read the latest entry, check the open questions, don't redo what's already here.

## Phase 0 — Scaffold

**Date:** 2026-07-27

**Status:** Code complete and committed (`da0a15e`). Checkpoint resolved — see "Checkpoint resolution" below. Ready for Phase 1.

**Files touched:**
- `package.json` (root, npm workspaces — `api` only for now, `web` joins in Phase 7)
- `tsconfig.base.json` (shared strict TS config)
- `api/package.json`, `api/tsconfig.json`, `api/eslint.config.js`
- `api/vitest.unit.config.ts`, `api/vitest.integration.config.ts`
- `api/drizzle.config.ts`
- `api/src/lib/envSchema.ts` (pure Zod schema, unit-testable without side effects)
- `api/src/env.ts` (loads `.env` from repo root, parses `envSchema`, exits loudly on invalid config)
- `api/src/lib/logger.ts` (pino, pretty in dev)
- `api/src/stripe/client.ts` (Stripe client pinned to `STRIPE_API_VERSION`; `checkStripeConnectivity()` probes `accounts.retrieve()`)
- `api/src/db/client.ts` (pg `Pool` + drizzle wrapper; `checkDbConnectivity()` runs `select 1`)
- `api/src/db/schema.ts` (empty placeholder — tables land in Phase 1)
- `api/src/db/migrate.ts`, `api/src/db/migrations/` (wired, empty until Phase 1 generates migrations)
- `api/src/app.ts`, `api/src/index.ts` (Fastify boot, listens on host/port derived from `API_BASE_URL`)
- `api/src/routes/health.ts` (`GET /health` — db status, stripe status, pinned api version)
- `api/test/unit/envSchema.test.ts`
- `.env.example` (root)
- `README.md` (skeleton — non-goals, setup, status pointer to this file)
- `docs/ARCHITECTURE.md` (started; §5.1 API-version-pinning rule documented)

**Decisions made:**
- Single npm workspace root (`api`, `web` added in Phase 7) rather than separate repos — matches §3 repo layout.
- `.env` / `.env.example` live at repo root, not inside `api/`, since the spec presents the env list as one shared block and `/web` will need some of the same values later (`APP_BASE_URL`, `API_BASE_URL`).
- ESM throughout (`"type": "module"`), `tsx` for dev, `tsc` for build — no ts-node.
- `envSchema.ts` is split from `env.ts` specifically so unit tests can exercise the Zod schema without triggering the eager, side-effecting `env` singleton (which calls `process.exit(1)` on invalid config — correct for the real process, wrong for a test run).
- No `PORT` env var added beyond the fixed §2 list — the Fastify listen port/host are derived from `API_BASE_URL`.
- "Fails loudly if the SDK cannot honour it" (§0 rule 8, Phase 0 exit) is implemented as: `STRIPE_API_VERSION` is a required, non-defaulted env var — missing it crashes boot immediately with a clear message. Network/version-mismatch reachability to Stripe itself is a *runtime* concern surfaced via `/health`, not a boot-time crash, so the process can still come up and report "degraded" when Stripe or Postgres is temporarily unreachable.
- `STRIPE_SECRET_KEY` is validated to start with `sk_test_`, `sk_live_`, or `rk_` — a cheap guard against pasting the wrong kind of key.
- Dependencies installed at their current latest where safe: `drizzle-orm` was bumped from an initially-pinned `^0.36.4` to `^0.45.2` after `npm audit` flagged a high-severity SQL-injection advisory (GHSA-gpj5-g38j-94v9) in earlier versions — `drizzle-kit` bumped alongside it to `^0.31.10`. `stripe`, `pg`, `pino`, `zod`, `dotenv`, `tsx`, `vitest`, `@types/*` all bumped to current latest. `typescript` was deliberately held at `^5.9.3` (not the `7.0.2` "latest" tag) and `eslint` held at `^9.15.0` (not `10.x`) to avoid stacking two unverified compiler/linter major-generation jumps on top of the dependency changes already made this phase; revisit later if there's a reason to.
- Health check for Stripe connectivity uses `stripe.accounts.retrieveCurrent()` (added in newer SDK majors) rather than the old zero-arg `accounts.retrieve()`, which now requires an explicit id argument.
- Verified locally: missing/invalid `.env` crashes boot with a listed, human-readable error (not a raw stack trace); with schema-valid-but-unreachable dummy credentials, the process boots cleanly and `GET /health` returns `503` with `{status: "degraded", db: {ok:false,...}, stripe: {ok:false,...}, apiVersion}` — i.e. bad *config* fails loudly at boot, bad *connectivity* is a runtime health status, not a crash.

**Checkpoint resolution (2026-07-27, same day):**
1. **Railway Postgres** — provisioned via `templateDeployV2` using Railway's own verified `postgres` template (`ghcr.io/railwayapp-templates/postgres-ssl:18`, not a bare Docker image), in the existing "Upwork Portfolio" project. Deployed with a persistent volume (`RAILWAY_VOLUME_ID` present, mounted at `/var/lib/postgresql/data`) and an auto-generated password. Service id `634536e4-20f6-4933-9651-66bc02f26e80`. The pre-existing `Subscription-Billing-Kit` app service's `DATABASE_URL` variable was set to `${{Postgres.DATABASE_URL}}` (Railway variable reference, private network URL) for when it deploys in Phase 9. This is the **dev** database; a separate **demo** database is still needed before Phase 9's deploy per §2.
2. **Stripe API version** — pinned to `2026-06-24.dahlia`, current per Stripe's own docs at the time of this session. Set in local `.env`.
3. **`STRIPE_SECRET_KEY`** — a restricted key (`rk_test_...`) was created in the Dashboard, scoped to least-privilege (Customers, Subscriptions, Products, Prices, Checkout Sessions, Customer Portal, Invoices, PaymentIntents: write; Events, Balance, Account: read; everything else none) rather than a full secret key — Stripe's own guidance specifically recommends restricted keys "when giving a key to an AI agent." Pasted by the user directly into this session and written only to the gitignored local `.env`, never committed or logged elsewhere.
4. **Stripe CLI** — still not installed in this container; still a Phase 2 dependency, unresolved for now.

**Sandbox network limitation discovered (important for future sessions):** this session's execution environment cannot reach the public internet except through an HTTPS-only, allow-listed proxy. Two consequences hit during this checkpoint:
- Direct calls to `api.stripe.com` from this sandbox (via `curl` or the app's own Stripe SDK call) fail with `403 CONNECT tunnel failed` — the host isn't on the egress allowlist. The Stripe MCP connector (separate credentials, runs outside this restriction) still works fine and was used for research (docs, account info). The app's own Stripe connectivity has *not* been live-verified from this container — it will be the first time the app runs somewhere with real egress (the user's machine, or deployed).
- Raw TCP to the new Postgres's public proxy (`sakura.proxy.rlwy.net:14822`) isn't proxied at all — the connection doesn't get refused, it hangs. This surfaced a real bug independent of the sandbox: `api/src/db/client.ts`'s `pg.Pool` had no `connectionTimeoutMillis`, so `checkDbConnectivity()` (and therefore `/health`) hung for **134 seconds** before the OS-level TCP timeout finally fired. Fixed by setting `connectionTimeoutMillis: 5_000` — verified the same unreachable-DB case now fails in ~5s instead. This fix matters in production too, not just here: an unreachable DB should make `/health` fail fast, not hang callers (load balancers, uptime checks) for minutes.
- Net effect: DB and Stripe connectivity are implemented and structurally verified (dummy credentials correctly produce `503` + per-service error, fast now for DB), but **not yet live-verified end-to-end** from any environment with real network access. That's the first thing to confirm at the start of Phase 1/2 work, ideally by running `npm run dev` and hitting `/health` from the user's own machine or CI.

**Update:** DB connectivity *was* live-verified during Phase 1 (see below) — but against a local Postgres, not yet against the real Railway one. Stripe connectivity is still unverified end-to-end from any environment with real internet access.

## Phase 1 — Schema, money, time

**Date:** 2026-07-27

**Status:** Code complete, all exit criteria met, committed.

**Files touched:**
- `api/src/db/schema.ts` — all 10 tables from §4, as Drizzle table definitions
- `api/src/db/migrations/0000_brave_absorbing_man.sql` — generated migration
- `api/src/lib/money.ts`, `api/src/lib/time.ts`
- `api/test/unit/money.test.ts`, `api/test/unit/time.test.ts`
- `scripts/seed-catalog.ts` (new `/scripts` directory)
- `tsconfig.json`, `eslint.config.js` (new, at repo root — typecheck/lint coverage for `/scripts`, which imports from `api/src`)
- `package.json` (root) — added `seed:catalog` script, root `typecheck`/`lint` now also cover `/scripts`
- `.gitignore` — added `catalog.json` (account-specific generated output, not committed)
- `docs/ARCHITECTURE.md` — money/zero-decimal section and schema section added
- `docs/DECISIONS.md` — D-015 added (UGX/ISK zero-decimal exclusion)

**Decisions made:**
- Schema transcribed directly from §4 with no changes — column names, types, indexes, and FK actions (e.g. `subscription_items` → `subscriptions` `ON DELETE CASCADE`) all match. Used Drizzle's modern array-style `extraConfig` (the object-style form is deprecated in the installed `drizzle-orm`/`drizzle-kit` versions).
- `reconciliation_runs`'s two total columns use `bigint('...', { mode: 'number' })` — safe up to 2^53−1, which comfortably covers the "$21.5M overflow" concern from §4 while staying a plain JS number instead of a native `BigInt` (simpler for the reconciliation code and its tests to work with).
- `money.ts`'s zero-decimal set was checked against Stripe's current currencies documentation rather than typed from memory, and deliberately **excludes UGX and ISK** — see D-015 in `docs/DECISIONS.md`. This is exactly the kind of Basil-style "looks right, is 100x wrong" trap the whole project is about, just caught during implementation instead of in production.
- `/scripts` sits outside the `api` npm workspace (per §3's repo layout) but imports directly from `api/src/*` via relative paths — works because npm workspaces hoist shared dependencies to the root `node_modules`. Added a root-level `tsconfig.json` and `eslint.config.js` so `/scripts` gets the same typecheck/lint coverage as `api/`, rather than being an unchecked blind spot.
- `scripts/seed-catalog.ts` is designed to be safely re-run: it looks up existing products/prices by a `seed_tag`/`plan_code` metadata pair before creating anything, so running it twice never creates duplicate catalog entries. This is separate from (and doesn't replace) the outbound-idempotency-key infrastructure (`idempotency.ts`) scoped to Phase 4 — the script also passes a deterministic `idempotencyKey` on its own create calls as a second, narrower safety net.
- Catalog prices (Starter $29/$290/yr, Pro $79/$790/yr, Scale $199/$1990/yr, all USD) are placeholder demo figures for exercising the billing kit's mechanics — not real client pricing. Documented as such in the script's header comment.
- `catalog.json` is gitignored, not committed — it's generated, account-specific output (Stripe test-mode product/price ids tied to *this* sandbox), analogous to `.env`. A stranger cloning the repo runs `seed-catalog.ts` themselves and gets their own ids, per the README's "running in under 10 minutes" goal.

**How the exit criteria were actually verified (worth reading — the sandbox's network restriction from Phase 0 shaped this):**
- **"Migrations run clean on an empty DB"** — the Railway Postgres from Phase 0 is still unreachable from this sandbox (raw TCP to its public proxy has no egress path at all, as documented in Phase 0's entry). Installed Postgres 16 locally in this sandbox instead (it was already available via apt), created an empty `billing_kit_test` database, and ran the actual `npm run db:migrate` script (not just raw `psql -f`) against it — all 10 tables, 17 foreign keys, and 7 indexes created with no errors (one harmless Postgres NOTICE about a long auto-generated FK constraint name being truncated to the 63-byte identifier limit — cosmetic, not a defect). Also pointed the running app at this local DB and confirmed `GET /health` reports `db.ok: true` end-to-end through the real pool/drizzle/health-route code path — the first time DB connectivity has been proven end-to-end in this project, just not yet against the actual Railway dev database.
- **"Catalog seeded"** — `scripts/seed-catalog.ts` itself could not be *executed* from this sandbox for the same reason `/health`'s Stripe check can't reach `api.stripe.com` directly (Phase 0's proxy-allowlist finding). Used the Stripe MCP connector (separate egress path) to perform the identical sequence of calls the script would make — same metadata tagging scheme, same product/price shape — and hand-wrote `catalog.json` from the real, returned ids. The 3 products / 6 prices genuinely exist in the connected Stripe sandbox (`acct_1TkxuuLVBwTnHcyi`) right now. The script's logic is typechecked, linted, and structurally sound, but hasn't been *executed* end-to-end yet — that should happen the first time this runs somewhere with normal internet access, as a sanity check that it correctly finds these already-tagged objects and creates nothing new.
- **"Money and time helpers fully unit-tested including JPY and a mixed-currency throw"** — 25/25 unit tests passing across `envSchema.test.ts` (7), `money.test.ts` (11), `time.test.ts` (7, covering both round-trip directions and a year-55000 canary check).

**Open items carried forward:**
1. Live end-to-end verification of the app against the *real* Railway Postgres and the *real* Stripe API is still outstanding — needs an environment with normal internet access (first thing to check in Phase 2, or sooner if convenient).
2. A separate **demo** Postgres database (distinct from dev) is still needed before Phase 9's deploy, per §2.
3. Stripe CLI is still not installed anywhere available to this project — needed starting Phase 2 for `stripe listen`/`stripe trigger`.

**Infrastructure note for future sessions in this sandbox:** Postgres 16 is installed locally (via apt, already present in this container image) and running as a system service (`service postgresql start`; `pg_lsclusters` to check). A `billing_kit_test` database exists there with Phase 1's schema already migrated, reachable at `postgresql://postgres:localtest@localhost:5432/billing_kit_test`. Since this sandbox's network policy blocks reaching the real Railway Postgres entirely (raw TCP, no egress path — see Phase 0's entry), this local instance is the only way to run anything DB-related from *this specific container* — including §9's integration tests, which need a real, throwaway Postgres. It will not persist across a fresh container/session; recreate it (`service postgresql start`, `CREATE DATABASE`, `npm run db:migrate` with `DATABASE_URL` pointed at it) if a new session needs it and the Railway DB is still unreachable.

## Phase 2 — Webhook receiver + ledger

**Date:** 2026-07-27

**Status:** Code complete, all exit criteria verified both by an automated integration suite and by a live manual demonstration. Committed.

**Files touched:**
- `api/src/webhooks/receiver.ts` — `POST /webhooks/stripe`, its own scoped raw-body content-type parser, signature verification, persist-then-ack
- `api/src/webhooks/ledger.ts` — `recordWebhookEvent()`, the on-conflict-do-nothing insert
- `api/src/app.ts` — registers `webhookRoutes` as its own plugin (encapsulation keeps the raw-body parser off every other route)
- `api/src/db/client.ts` — added `pool.on('error', ...)` (see below — a real bug found live, not planned work)
- `api/src/lib/envSchema.ts` — comment clarifying `STRIPE_WEBHOOK_SECRET`'s optional-at-schema/hard-required-at-route-runtime design
- `api/test/integration/webhookReceiver.test.ts`, `webhookNonAscii.test.ts`, `webhookDbDown.test.ts`, `helpers/webhookFixture.ts`
- `docs/ARCHITECTURE.md` — raw body, persist-ack-process ordering, inbound idempotency, and the pool-error finding
- `docs/DECISIONS.md` — D-016 (pool error listener)
- `.env` — `STRIPE_WEBHOOK_SECRET` set to a locally-generated dev secret (see verification notes below for why)

**Decisions made:**
- Raw-body parsing is scoped via Fastify plugin encapsulation (`app.register(webhookRoutes)` with its own `addContentTypeParser` inside), not a global override — every other route keeps normal JSON parsing. This is the standard, documented Fastify pattern for exactly this need, not a workaround.
- `STRIPE_WEBHOOK_SECRET` stays *optional* in the Zod env schema (so the app can still boot and serve `/health` without it) but the webhook route itself refuses every request with a `500` if it's unset — a config problem, deliberately not a `400`, since `400` tells Stripe "don't retry" and this is recoverable the moment the secret is configured.
- No `idempotency.ts` module yet — that's explicitly Phase 4 scope (outbound calls). Phase 2's idempotency is purely inbound (`stripe_event_id` primary key + `on conflict do nothing`), which is all this phase needs.

**How the exit criteria were verified — two layers, both passing:**

1. **Automated integration tests** (`npm run test:integration`, against the local `billing_kit_test` Postgres — real network access to Stripe still isn't available from this sandbox, so fixtures are signed locally): Stripe's own SDK exposes `stripe.webhooks.generateTestHeaderString({ payload, secret })` for exactly this purpose — signature verification is a pure local HMAC operation, so a correctly-signed fixture exercises the real signature-checking code path with no network call to Stripe needed at all.
   - A validly-signed event → `200`, one row.
   - The same signed payload replayed 10 times → `200` every time, still exactly one row.
   - A tampered signature → `400`, zero rows, warning logged.
   - A missing `stripe-signature` header → `400`.
   - Non-ASCII content in the event payload (`Zoë Müller — 田中太郎 — Ñoño 🎉`) → `200`, and the stored `jsonb` payload round-trips the exact string.
   - DB unreachable (`pool.end()`, isolated to its own test file so it can't affect other integration tests) → `500`, not `200`.
   - 6/6 passing.

2. **Live manual demonstration**, per this phase's explicit checkpoint — built the real server, pointed `.env` at the local Postgres, generated real signed fixtures with a small throwaway script (not committed), and used actual `curl` + `psql`:
   - Sent one signed event 3 times → `200` all three times, exactly one row in `webhook_events` via `psql`.
   - Stopped the local Postgres service (`service postgresql stop`) mid-session and POSTed a webhook — **this crashed the entire Node process** instead of returning `500`. Root cause: `pg.Pool` emits `'error'` on an idle client hitting a connection-level failure, and an unhandled `EventEmitter` `'error'` event is fatal to Node. Fixed with `pool.on('error', ...)` in `db/client.ts` (see D-016). Rebuilt, repeated the exact same demonstration: this time got a clean `500`, and the server stayed up. Restarted Postgres and resent the same event — `200`, and the row landed with no duplicate.
   - This was a genuine bug caught by actually performing the checkpoint's literal instructions ("with the DB stopped...") rather than only reasoning about the failure mode abstractly — the kind of thing this whole project exists to catch.
   - `stripe listen --forward-to ...` / `stripe trigger customer.created` themselves were not run — the Stripe CLI still isn't available in this sandbox, and this sandbox still can't reach `api.stripe.com` directly (Phase 0's finding). The locally-signed-fixture approach exercises the identical code path (everything downstream of "a validly-signed payload arrived"), which is what actually matters for this phase's logic; running the literal CLI commands is still worth doing the first time this runs somewhere with normal Stripe connectivity.

**Open items carried forward:**
1. Still true from Phase 1: live end-to-end verification against the real Railway Postgres and real Stripe API needs an environment with normal internet access.
2. Stripe CLI still not installed/available anywhere in this project's reach — needed from here on for `stripe listen`/`stripe trigger`, and for Phase 5's test clocks.
3. A separate demo Postgres database is still needed before Phase 9.

## Phase 3 — Processor, reaper, state machine

**Date:** 2026-07-27

**Status:** Code complete, all exit criteria verified via a mocked-Stripe-client integration suite (no explicit CHECKPOINT for this phase per the build spec). Committed.

**Files touched:**
- `api/src/billing/stateMachine.ts` — the 8-status transition table, `isExpectedTransition()`, `recordTransition()` (writes `subscription_events`)
- `api/src/webhooks/handlers/customer.ts`, `subscription.ts`, `invoice.ts`, `paymentIntent.ts`
- `api/src/webhooks/processor.ts` — `FOR UPDATE SKIP LOCKED` claim, dispatch, exponential backoff, park-at-5
- `api/src/webhooks/reaper.ts` — reclaims stale `processing` rows
- `api/src/webhooks/worker.ts` — in-process interval loops (processor every 2s, reaper every 30s), wired into `index.ts`
- `api/src/db/client.ts` — added `Executor` type (shared between `db` and `db.transaction()`'s `tx`)
- `api/test/unit/stateMachine.test.ts`
- `api/test/integration/helpers/stripeFixtures.ts`, `subscriptionProjection.test.ts`, `reaperRecovery.test.ts`, `handlersBasic.test.ts`
- `api/vitest.integration.config.ts` — added `fileParallelism: false` (see below)
- `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (D-017, D-018)

**Decisions made:**
- The processor's claim step (`SELECT ... FOR UPDATE SKIP LOCKED` + flip to `processing`) is a short transaction; the actual handler work — including the Stripe API re-fetch — happens *after* it commits, never inside it. Holding a transaction open across a network call would hold row locks far longer than necessary and defeat the point of `SKIP LOCKED`.
- No separate worker process/service — the processor and reaper run as `setInterval` loops in the same Node process as the HTTP server (`.unref()`'d so they don't keep the process alive on their own). Matches D-005's "Postgres as the queue, not a second infrastructure dependency."
- The staleness guard (§5.7) is about protecting the *audit trail and event-specific side effects*, not the projected data — re-fetching always returns current truth regardless of processing order. See D-017 and the ARCHITECTURE.md section for the full reasoning; this took a real pass of thinking through *why* the guard is needed before implementing it, since the naive "re-fetch fixes ordering" argument doesn't fully hold.
- `customer.deleted` and a draft `invoice.deleted` (re-fetch 404s) are handled explicitly rather than falling through: a deleted Stripe customer's local row is kept as historical record (no schema column exists to mark it, and FK-referenced billing history shouldn't disappear); a deleted draft invoice's local row (if any) is removed, since it never represented a real, collectible invoice.
- `vitest.integration.config.ts` gained `fileParallelism: false`. Found this was necessary while writing the reaper test: vitest runs test *files* in parallel by default, and the reaper's query (`status='processing' AND processing_started_at < cutoff`) matches rows from *any* test file sharing the same physical database — a genuine cross-test contamination risk, not a hypothetical one. Sequential execution costs wall-clock time, which §9 explicitly says integration tests don't need to economize on.

**Two more Basil-shaped findings (§0 rule 9 doing its job again):** verifying every field against the installed Stripe SDK's own type definitions (not memory, not older tutorials) surfaced that `invoice.subscription` doesn't exist in this API version — it's `invoice.parent.subscription_details.subscription` — and that `PaymentIntent` has no `.invoice` field at all anymore (resolved instead via `stripe.invoicePayments.list(...)`). Both are documented in `docs/ARCHITECTURE.md` and as D-018. Same failure shape as the period-fields change this whole project is built around, just caught during implementation instead of in a production incident.

**How the exit criteria were verified:** this sandbox still can't reach `api.stripe.com` (Phase 0's finding, unchanged) and still has no Stripe CLI, so `stripe trigger`-driven verification wasn't possible here. Verified instead with an integration suite that mocks only the Stripe SDK calls (`vi.mock` on `src/stripe/client.js`, replacing `.retrieve()`/`.list()` with fixtures built from the *verified* real API shapes) while using the real local Postgres for every DB read/write and the real, unmocked processor/reaper/handler code — the only thing not real is the network hop to Stripe itself:
- `subscription-periods-are-read-from-items-not-from-the-subscription` and `a-mixed-interval-subscription-stores-a-period-per-item` — a two-item subscription (monthly + annual, different period ends) projects both items with independently correct periods, and `next_period_end_derived` picks the sooner one.
- `subscription-created-then-immediately-canceled-out-of-order` and `an-event-that-arrives-late-does-not-overwrite-newer-state` — events fed out of order; the older one is skipped (`webhook_events.status='skipped'`), the newer state survives, and the stale event's handler never even calls the Stripe API a second time (asserted via mock call count).
- `a-worker-killed-mid-event-has-its-row-reaped-and-reprocessed` — a row manually set to `processing` with a `processing_started_at` older than `WEBHOOK_LEASE_SECONDS` is returned to `received` by the reaper and then successfully processed on the next tick; a second case confirms a row that would exceed `MAX_ATTEMPTS` is parked `failed` instead of re-queued.
- `every-state-machine-transition-is-covered` — unit-tested directly against the transition table (all 64 (from, to) combinations resolve to a defined boolean; terminal states, backward jumps, and the null/no-op cases are asserted explicitly).
- The customer, invoice (including the `parent.subscription_details` resolution and the one-off/no-subscription case), and payment-intent (including the "no linked invoice" case) handlers are each exercised directly in `handlersBasic.test.ts`.
- 17/17 integration tests passing, 32/32 unit tests passing, clean typecheck/lint/build throughout.

**Open items carried forward (unchanged from Phase 2, still true):**
1. Live end-to-end verification against the real Railway Postgres and real Stripe API still needs an environment with normal internet access — nothing in Phase 3 changed this; everything here was verified against the local Postgres with a mocked Stripe client.
2. Stripe CLI still not installed/available — needed for Phase 5's test clocks especially.
3. A separate demo Postgres database is still needed before Phase 9.

## Phase 4 — Checkout, portal, plan changes

**Date:** 2026-07-27

**Status:** Code complete, all exit criteria verified. Checkpoint resolved by user's explicit choice (see below). Committed.

**Files touched:**
- `api/src/stripe/idempotency.ts` — every outbound idempotency key, one module
- `api/src/stripe/sync.ts` (new) — `syncCustomerFromStripe()` / `syncSubscriptionFromStripe()`, extracted from the Phase 3 webhook handlers so admin routes can reuse the identical projection path
- `api/src/webhooks/handlers/customer.ts`, `subscription.ts` — slimmed down to call into `sync.ts`, behavior unchanged (re-verified against the full Phase 2/3 suite after the refactor)
- `api/src/stripe/checkout.ts`, `api/src/stripe/portal.ts`
- `api/src/routes/customers.ts`, `checkout.ts`, `portal.ts`, `subscriptions.ts` — wired into `app.ts`
- `api/db/client.ts` — no changes needed beyond what Phase 3 already added
- `api/test/unit/idempotency.test.ts`
- `api/test/integration/checkoutPortalPlanChange.test.ts`
- `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (D-019, D-020)

**Decisions made:**
- Extracted `stripe/sync.ts` out of the Phase 3 webhook handlers specifically so this phase's admin routes (cancel/resume/plan-change) project subscriptions through the *exact same code path* a webhook does, rather than duplicating the items/periods projection logic in two places that could drift apart.
- Customer creation is idempotent *forever* (keyed on `external_ref` alone, backed by a local-first DB check) — everything else (checkout, portal, plan-change, cancel, resume) is keyed on the operation plus a captured `requestedAt`, since those are legitimately repeatable actions over a subscription's lifetime. See D-019.
- Admin mutations (cancel/resume/plan-change) never trust the Stripe mutation response's shape — they re-fetch via `retrieve(id, {expand: ['items.data.price']})` immediately after, and sync *that*, applying §5.6's "never trust the payload" discipline to writes as well as reads.
- `syncSubscriptionFromStripe()` gained a `forceRecord` option so manual actions always write a `subscription_events` audit row (§5.8), even when - as with most plan changes - `status` itself doesn't change. See D-020.
- `GET /subscriptions/:id` and the resume endpoint's dual-branch logic (un-set `cancel_at_period_end` vs. call Stripe's dedicated `.resume()` for a `paused` subscription) went a little beyond the phase's literal exit criteria, but were cheap and directly useful for verifying this phase's own work.
- A fourth Basil-shaped restructuring turned up while building the plan-change preview: `InvoiceLineItem` has no top-level `proration` flag either — it's nested under `line.parent.invoice_item_details.proration` / `line.parent.subscription_item_details.proration`, the same discriminated-union shape as `invoice.parent`. Implemented correctly (`isProrationLine()` in `routes/subscriptions.ts`) rather than skipped, since by this point verifying against the SDK's types first was already the default habit, not extra effort.

**How the exit criteria were verified, and the checkpoint's resolution:** this sandbox still can't reach `api.stripe.com` (unchanged since Phase 0) and has no path for a real webhook delivery into this container - so a single, unbroken "click checkout, see it land locally" demo was never achievable here regardless of which pieces got bridged or faked. Presented this tradeoff directly and asked how to satisfy the checkpoint; the choice was the mocked-but-faithful integration suite over a real-Stripe-but-proves-nothing-about-our-code browser demo. Delivered:
- `POST /customers` twice with the same `external_ref` → one local row, one Stripe API call (the second short-circuits on the local-first check) - this is `a-retried-create-call-with-the-same-idempotency-key-creates-one-subscription`'s customer-creation analogue.
- `POST /checkout/sessions` returns a real-shaped Stripe-hosted URL; 404 for an unknown customer.
- `POST /portal/sessions` returns a portal URL.
- `plan-change-preview-matches-the-invoice-stripe-actually-issues` - the preview amount is asserted to pass through unmodified, proving our code doesn't recompute or round Stripe's own proration numbers.
- Cancel (`at_period_end=true`) and resume both proven to write a `manual:api` audit row even though `status` stays `active` throughout - the concrete case D-020 exists for.
- 9/9 new integration tests, 26/26 total integration tests (all of Phase 2/3's still passing after the `sync.ts` refactor), 40/40 unit tests (8 new for idempotency-key determinism).

**Open items carried forward:**
1. Live end-to-end verification against the real Railway Postgres and real Stripe API still needs an environment with normal internet access - unchanged since Phase 0.
2. Stripe CLI still not installed/available - needed for Phase 5's test clocks especially.
3. A separate demo Postgres database is still needed before Phase 9.
4. `GET /subscriptions` (list, with filters) and `GET /invoices` from §6's API surface weren't built this phase - deferred to whenever Phase 7's admin UI actually needs them, since they weren't part of Phase 4's stated scope and adding them speculatively wasn't warranted.

## Infrastructure: CI workflow (between Phase 4 and Phase 5)

PR #1 (Phases 0-4) merged into `main` with no CI gate at all - this repo had no `.github/workflows` directory yet, so "merge when green" had nothing to check against. Added `.github/workflows/ci.yml`: on every PR and push to `main`, runs `typecheck` → `lint` → `build` → `db:migrate` → `test:unit` → `test:integration` against a fresh `postgres:16` service container, on Node 20. The Stripe secret/webhook-secret env vars are placeholder strings that only need to satisfy `envSchema.ts`'s shape validation (`sk_test_...` / `whsec_...` prefixes) - every Stripe call in the suite is mocked, so CI never needs real credentials or network access to `api.stripe.com`, matching this sandbox's own constraint.

Verified the exact command sequence locally first (against this sandbox's local Postgres 16 instance, with the same env var values CI will use) before pushing: typecheck clean, lint clean, build clean, migrations apply cleanly, 40/40 unit tests and 26/26 integration tests pass.

**Open item:** branch protection / rulesets on `main` (require PR, require this new CI check, block force-push) still need to be configured in the GitHub UI - no tool in this session's GitHub MCP server can create repository rulesets, so that step is manual.

## Infrastructure: run migrations on boot (between Phase 4 and Phase 5)

Discovered that Railway has a service (in the "Upwork Portfolio" project) auto-deploying this repo's `main` branch on every push - separately from this build's own phase-by-phase Railway/Postgres provisioning back in Phase 0. Two problems surfaced from its build logs:
1. `STRIPE_SECRET_KEY` / `STRIPE_API_VERSION` were only ever set in this sandbox's local, gitignored `.env` - never configured as real Railway environment variables. Fixed by setting both directly on the Railway service via the Railway MCP connector, using the same real pinned values used throughout this build.
2. Once the app booted, the webhook processor/reaper ticks failed continuously - the real Railway Postgres has never had `npm run db:migrate` run against it (every migration so far, every phase, ran only against this sandbox's local throwaway `billing_kit_test` - see Phase 1's entry on why: this sandbox cannot reach the real Railway Postgres over raw TCP at all, re-confirmed here). Fixed at the source rather than as a one-off: changed `api/package.json`'s `start` script from `node dist/index.js` to `node dist/db/migrate.js && node dist/index.js`, so every deploy applies any pending migrations before serving traffic. Drizzle's migrator tracks its own applied-migrations table, so this is idempotent - a no-op on deploys with nothing new to apply.

Verified locally: ran the exact new start sequence (`node dist/db/migrate.js && node dist/index.js`) against this sandbox's local Postgres - migration step reports `migrations applied` and the server then boots and listens normally. Confirmed on Railway itself after pushing: the previously-failing deployment now builds, migrates, and boots with the processor/reaper ticking cleanly.

**Open items carried forward:**
1. `STRIPE_WEBHOOK_SECRET` is still not set on Railway - the local sandbox's value was generated for local `stripe listen` testing and is **not** the deployed endpoint's real signing secret (per the runbook note in the phase 9 spec: these are always different values). Creating the real webhook endpoint against this Railway deployment's public URL requires either a real Stripe Dashboard session or API access this sandbox doesn't have - unchanged blocker, carried forward.
2. No public domain is provisioned for this Railway service yet (`railway_list_domains` returned none) - needed before Checkout/portal return URLs or a real webhook endpoint can point at it.

## Phase 5 — Test clock helpers + dunning engine

**Date:** 2026-07-27

**Status:** Code complete, all exit criteria verified via a deterministic integration suite (no live Stripe test clock available from this sandbox - see below). Committed.

**Files touched:**
- `api/src/billing/emailAdapter.ts` — `EmailAdapter` interface, `ConsoleEmailAdapter` default implementation
- `api/src/billing/dunning.ts` — the stage machine: `openDunningCycleOnPaymentFailed`, `resolveDunningOnInvoicePaid`, `closeDunningOnSubscriptionDeleted`, `runDunningTick` (escalation pass + decoupled send pass), plus exported pure helpers `nextActionAtForStage`/`templateForStage`/`STAGE_GAP_DAYS` for unit testing
- `api/src/webhooks/handlers/invoice.ts` — wraps the invoice upsert and its dunning side effect (open on `invoice.payment_failed`, resolve on `invoice.paid`) in one transaction
- `api/src/webhooks/handlers/subscription.ts` — closes an open cycle as `resolution='canceled'` on `customer.subscription.deleted`
- `api/src/webhooks/worker.ts` — dunning tick added as a third in-process interval (15 min), gated by `env.DUNNING_ENABLED`
- `api/src/routes/dunning.ts` (new) — `GET /dunning/queue`, `POST /dunning/:id/resolve`; wired into `app.ts`
- `scripts/test-clock.ts` (new) — `createTestClock`/`advanceTestClock`/`teardownTestClock`, verified against the installed Stripe SDK's own `TestHelpers/TestClocks.d.ts`
- `scripts/dunning-tick.ts` (new) — one-shot entry point for a production cron (§5.12); root `package.json` gained `dunning:tick`
- `api/test/unit/dunning.test.ts` — escalation timing and template-selection pure-logic coverage
- `api/test/integration/dunning.test.ts` — the 5 named §9 dunning tests, plus a sixth exercising the full stage 1→3→recovered arc deterministically
- `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (D-021 through D-024; D-012/D-013/D-014 were already seeded pre-Phase-0 and matched this implementation directly)

**Decisions made:**
- Escalation gaps (3/7/14 days, §5.10) are read as relative to whichever stage a cycle just entered, not cumulative from the cycle's original open — `dunning_state`'s single, mutable `entered_stage_at` column (no separate "cycle opened at" timestamp) is the schema-level evidence for that reading over the other equally-plausible one. See D-021.
- Escalating a stage and sending that stage's notice are two separate, decoupled steps: the escalation transaction advances `dunning_state.stage` and arms the notice row (`sent_at` left null); a completely separate pass scans *every* unsent notice system-wide and sends it. This is what actually makes the "one notice per stage" unique constraint (D-013, pre-seeded) crash-safe in practice — a crash between the two steps would otherwise strand the notice forever, since the escalation pass's own selection criteria stop matching a cycle once its stage has already advanced. See D-022.
- `customer.subscription.deleted` closes an open cycle as `resolution='canceled'` (nothing left to collect on a deleted subscription); a pure +14-day timeout to stage 4 only advances `stage` and leaves the cycle open, since a late `invoice.paid` on the triggering invoice can still recover it. This is the only event in the whole system that could ever produce `resolution='canceled'`, which is the deciding evidence it belongs here. See D-023.
- Stage 4 sends no notice (§5.10's table describes it as an access change, not a communication, unlike stages 1-3) and this kit does not invent a new "access revoked" column — `dunning_state.stage` itself is the signal an integrating product reads to decide what downgrading or revoking access means for its own UI. See D-024.
- `routes/dunning.ts` is its own file rather than the `routes/admin.ts` named in §3's original repo layout — Phase 4 already established one-file-per-API-concern (`checkout.ts`, `portal.ts` instead of a combined admin file), and this phase follows that precedent rather than retrofitting a file name that was never actually used.

**How the exit criteria were verified, and why not via a real test clock:** this sandbox still has no network path to `api.stripe.com` (unchanged since Phase 0), so `scripts/test-clock.ts` is written and verified against the installed SDK's real type definitions but never actually exercised against Stripe from here — the same constraint that shaped every prior phase's checkpoint. The stage-machine behavior the exit criteria actually care about (a cycle escalating through every stage and recovering) doesn't depend on Stripe's test-clock API itself, only on the tick logic that would run regardless of what advanced the clock — so `test/integration/dunning.test.ts` proves it deterministically by backdating `dunning_state.next_action_at` and calling `runDunningTick()` directly, exercising the exact same code path a real test clock's time jump would trigger:
- `payment-failed-then-paid-clears-dunning-in-one-tick` — a cycle opens on `invoice.payment_failed` and resolves on `invoice.paid` for the *same* invoice, with no tick needed in between (resolution is synchronous with the webhook handler, only escalation needs the scheduled tick).
- `paying-an-unrelated-invoice-does-not-clear-dunning` — a second, different invoice for the same subscription being paid leaves the cycle open at stage 1, still pointed at the original triggering invoice.
- `a-one-off-invoice-failure-never-opens-a-dunning-cycle` — a `payment_failed` invoice with `parent: null` (no subscription link) produces no `dunning_state` row at all.
- `dunning-never-sends-two-notices-for-one-stage` — a cycle due for escalation, ticked twice in a row, escalates exactly once and sends exactly one email for the new stage.
- `crash-between-notice-write-and-send-does-not-double-email` — a `dunning_notices` row seeded to look exactly like a crash left it (armed, `sent_at` null, stage already advanced), ticked twice, sends exactly once.
- A sixth test drives a cycle from stage 1 through stage 3 via repeated ticks (backdating `next_action_at` each time), confirms exactly one notice per stage 1/2/3 all marked sent, then resolves it via `invoice.paid` — the full arc the phase's exit criteria describe, short of the literal test-clock/teardown mechanics.
- 6/6 new integration tests, 32/32 integration tests total, 45/45 unit tests (5 new for escalation timing), clean typecheck/lint/build. A live boot (`GET /health`, `GET /dunning/queue`) against the local Postgres confirmed the new route serves cleanly end-to-end.

**Open items carried forward:**
1. Live end-to-end verification against the real Railway Postgres and real Stripe API (including an actual test-clock run) still needs an environment with normal internet access — unchanged since Phase 0.
2. `STRIPE_WEBHOOK_SECRET` still isn't set on Railway, and no public domain is provisioned there yet — carried forward from the migrate-on-boot infrastructure fix above.
3. A separate demo Postgres database is still needed before Phase 9.
4. `scripts/test-clock-demo.ts` (Phase 9's unattended demo arc) intentionally not built this phase — it's explicitly scoped to Phase 9 in §8, and needs the same live Stripe access this sandbox doesn't have to be worth writing before then.

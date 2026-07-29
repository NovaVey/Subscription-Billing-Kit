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

## Infrastructure: real webhook endpoint + public domain (between Phase 5 and Phase 6)

Closed out two of the open items carried forward from the migrate-on-boot fix, using the Railway and Stripe MCP connectors (both reach their respective APIs directly, unlike this sandbox's own network, which still can't reach either `api.stripe.com` or the Railway service's own public domain).

- **Public domain:** `railway_create_service_domain` was called twice. The first call (no explicit `targetPort`) produced `subscription-billing-kit-production.up.railway.app`, which never routed traffic to the container in practice - a real event fired at it produced no incoming request in the deployment's logs after 20+ seconds. The second call, with `targetPort: 3000` set explicitly (matching `API_BASE_URL`'s default port the app actually binds), produced a second domain, `subscription-billing-kit-production-0f5e.up.railway.app`, which works. **This second domain is the one in actual use** - the first is an inert leftover; no tool in this session can delete a Railway-provided service domain, so it stays, harmlessly unused.
- **Real webhook endpoint:** created via the Stripe MCP connector's generic API tools (`PostWebhookEndpoints`), pinned to `api_version: 2026-06-24.dahlia` (matching this project's pinned version exactly, per the runbook note that a mismatched per-endpoint version is a silent-400 trap) and subscribed to exactly the event types this system's processor dispatches on (`customer.*`, `customer.subscription.*` including `paused`/`resumed`/`trial_will_end`, the `invoice.*` types the dunning engine and invoice projection care about, and `payment_intent.payment_failed`) rather than `['*']` - deliberate, not exhaustive, matching this codebase's general preference for explicit tables over blanket handling.
- The endpoint's real signing secret (returned only once, at creation) was set as `STRIPE_WEBHOOK_SECRET` on the Railway service - **distinct from, and not to be confused with,** the local sandbox's `.env` value, which is only ever valid for local `stripe listen` forwarding (per the Phase 9 runbook note already in the spec).

**Verified live, end-to-end, for the first time in this project:** created two real, throwaway test-mode customers via the Stripe MCP (`webhook-pipe-check@example.com`, tagged in `description`/`metadata.purpose` as verification-only) to generate real `customer.created` events. The first, sent to the non-working domain, never arrived. The second, sent to the port-explicit domain after updating the webhook endpoint's `url` (`PostWebhookEndpointsWebhookEndpoint`), arrived and was processed within seconds - Railway's runtime logs show `incoming request` → `webhook event persisted` → `request completed`, meaning the full path (Stripe test-mode account → real internet → this Railway deployment → its raw-body signature verification → the real Postgres `webhook_events` table) is now proven correct outside of any mock, for the first time in this project. The two throwaway customers remain in the Stripe test-mode account - no delete-customer operation is exposed via this session's Stripe MCP tools, and they're low-stakes (test mode, clearly tagged) to leave.

**Open items now resolved:** items 2 and 3 above (webhook secret, public domain) are done. Remaining:
1. Live end-to-end verification of the *dunning engine specifically* against a real Stripe test clock still needs the Stripe CLI or a session with full interactive Dashboard/API access for test-clock-driven time travel - the webhook pipe itself is now proven live, but no test clock has actually been created and advanced against this deployment.
2. A separate demo Postgres database is still needed before Phase 9.
3. The inert first Railway domain (`subscription-billing-kit-production.up.railway.app`, no working target) is harmless but should be deleted via the Railway dashboard directly if a future session gets one - no MCP tool here supports it.

## Infrastructure: live test-clock verification of the dunning engine (resolves open item 1 above)

Closed out the one remaining "needs real internet access" item from a real Windows machine (Git Bash), not this sandbox - this sandbox still can't reach either `api.stripe.com` or the deployed Railway service directly. Walked through cloning the repo, filling in `.env` with the real `STRIPE_SECRET_KEY` and the Railway Postgres's *public* proxy `DATABASE_URL` (not the `.railway.internal` one, which only resolves inside Railway's own network), and running `scripts/test-clock.ts`'s helpers directly via a throwaway script.

Two real findings surfaced along the way, both now resolved:
- The restricted Stripe key didn't have **Test Clocks Write** (`billing_clock_write`) permission - it was scoped down deliberately from Phase 0 and test clocks were never exercised until now. Fixed in the Stripe Dashboard by adding just that one permission to the existing key.
- Stripe's special test `PaymentMethod` tokens (`pm_card_visa`, `pm_card_chargeCustomerFail`) each resolve to a **new** underlying `PaymentMethod` object on every reference - attaching one and then reusing the same token string in a second call (rather than the `id` the first call returned) referred to two different objects. Fixed by capturing `attach()`'s return value and reusing its real `pm_...` id.
- Renewal invoices sit in a **~1 hour draft window** before Stripe auto-finalizes and attempts payment (confirmed against Stripe's own docs, not assumed) - advancing a test clock only 10 minutes past the period end left the renewal invoice permanently stuck at `invoice.created`/`draft`. Advancing at least ~1 hour past the period end (used 2 hours for margin) let Stripe carry it through finalization and the failed payment attempt within the same clock advancement.

**Verified, live, for real:** a real Stripe test clock drove a real subscription (`sub_1TxyYOLVBwTnHcyiw18aMbap`) through a successful first invoice, a payment-method swap to Stripe's "decline after attaching" test token, and a failed renewal. The resulting `invoice.payment_failed` webhook was delivered to the real Railway deployment, processed with zero errors, and opened a real dunning cycle - confirmed via `GET /dunning/queue` on the live service: `stage: 1`, `nextActionAt` exactly 3 days out (matching the stage-1 escalation gap from `STAGE_GAP_DAYS`, §5.10), `triggeringInvoiceId` correctly pointed at the failed invoice, and the local `subscriptions.status` correctly reflecting Stripe's own `past_due` transition. This is the first time any part of the dunning engine has been exercised against real Stripe infrastructure rather than mocks or backdated timestamps.

**Also confirmed, completing the full arc:** the deployed app's own in-process dunning tick (the 15-minute interval, not a manually-forced one) picked up the armed-but-unsent stage-1 notice on its own and sent it via the console adapter - visible in Railway's runtime logs as `dunning notice (console adapter - no real email sent)`, about 2 minutes after the cycle opened, entirely unprompted. Manually running `npm run dunning:tick` afterward correctly reported `{"escalated":0,"sent":0,"failed":0}` - nothing left to do, not a failure. Tearing down both test clocks (`teardownTestClock()`) cascaded a real `customer.subscription.deleted` event for the dunning-cycle subscription, which correctly closed it via `closeDunningOnSubscriptionDeleted()` (D-023) - confirmed by `GET /dunning/queue` returning `{"queue":[]}` afterward. Every stage of the dunning engine - open, escalate, send, and close-on-deletion - is now proven against real Stripe infrastructure end to end, not mocks or backdated timestamps.

**Open items now resolved:** item 1 above (live test-clock verification) is done, including confirmed teardown of both test clocks used. Remaining, unchanged:
1. A separate demo Postgres database is still needed before Phase 9.
2. The inert first Railway domain is still there, still harmless, still needs a manual dashboard deletion.

## Phase 6 — Reconciliation

**Date:** 2026-07-28

**Status:** Code complete, all exit criteria verified via a mocked-Stripe-client integration suite (no CHECKPOINT for this phase per the build spec). Committed.

**Files touched:**
- `api/src/billing/reconcile.ts` (new) — `classifyInvoices` (pure: field_drift/missing_local/orphan_local classification + per-currency totals), `computeYesterdayWindow` (pure: TZ-bounded "yesterday" via `Intl.DateTimeFormat`, no date library), `runReconciliation` (Stripe fetch + local query + classify + store)
- `api/src/routes/reconciliation.ts` (new) — `GET /admin/reconciliation` (list runs), `POST /admin/reconciliation/run` ({period_start, period_end, currency}); wired into `app.ts`
- `scripts/reconcile-nightly.ts` (new) — cron-invoked entry point: computes yesterday's window in `RECONCILE_TZ`, runs once per distinct currency found in local invoices; root `package.json` gained `reconcile:nightly`
- `api/test/unit/reconcile.test.ts` — classification correctness (drift/missing/orphan/clean), the "missing + orphan of equal value don't net to clean" case §5.11 calls out explicitly, and `computeYesterdayWindow`'s TZ-boundary correctness (UTC vs `America/New_York` given the same instant)
- `api/test/integration/reconciliation.test.ts` — the 3 named §9 tests (status drift, amount drift, missing_local) plus orphan_local and a clean-period-stores-zero case, each in the phase's own exit criteria
- `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (D-025 through D-028)

**Decisions made:**
- Reconciliation windows are bounded by each local invoice's `finalized_at`, matched against Stripe's own `created` filter on `GET /v1/invoices` - the closest existing concept to "when was this invoice issued," since §4's schema has no dedicated invoice-creation column and inventing one wasn't warranted for a window that only needs day-level precision. See D-025.
- The headline `stripe_total_minor`/`local_total_minor` sum `amount_paid_minor` (money actually collected) rather than `amount_due_minor` (money billed) - directly answering §1's framing of the problem ("does what we billed match what Stripe collected"), while the detailed report entries still catch amount_due drift per invoice regardless. See D-026.
- Stripe's List Invoices endpoint has no `currency` query parameter at all (checked against the pinned version's actual parameter list, not assumed) - every invoice in the date window is fetched and filtered to the requested currency in application code. See D-027.
- No in-process interval for the nightly job, unlike the dunning tick - `scripts/reconcile-nightly.ts` is a cron-invoked script only, since §5.11 doesn't carry the same "fast loop for dev testing" framing §5.12 gives dunning, and the on-demand API route already covers manual/test runs. See D-028.
- `classifyInvoices()` is a pure function (plain snapshot objects in, a report + totals out) with no Stripe SDK or Drizzle row type dependency, mirroring the split already established between `stateMachine.ts`/`recordTransition()` and `billing/dunning.ts`'s `nextActionAtForStage()`/the DB-touching escalation functions - the part worth unit-testing in isolation is kept free of I/O.

**How the exit criteria were verified:** this sandbox still can't reach `api.stripe.com` (unchanged since Phase 0), so `stripe.invoices.list` is mocked (`vi.mock` on `src/stripe/client.js`, matching every prior phase's pattern) while local Postgres reads/writes are real:
- `reconciliation-catches-a-status-drift` / `reconciliation-catches-an-amount-drift` - a local invoice deliberately seeded with a different `status`/`amount_due_minor` than its mocked Stripe counterpart produces exactly one `field_drift` entry naming the differing field and both values.
- `reconciliation-catches-an-invoice-stripe-has-and-we-do-not` - a mocked Stripe invoice with no local row produces `missing_local`.
- An added `orphan_local` test (a local invoice with no Stripe counterpart, matching this phase's own exit criteria even though §9 doesn't name it exactly) and a clean-period test (matching sets → `mismatchCount: 0`, equal totals, and the stored `reconciliation_runs` row reflecting both) round out the phase's stated exit criteria.
- A unit test proves totals alone would hide the case §5.11 calls out by name: a missing invoice and an orphan invoice of equal value net to equal totals on both sides, while the detailed report still reports both.
- 5/5 new integration tests, 37/37 integration tests total, 53/53 unit tests (7 new: 5 classification, 2 TZ-window), clean typecheck/lint/build. A live boot check confirmed both new routes respond correctly, including Zod's per-field validation errors on a malformed `POST /admin/reconciliation/run` body.

**Resolved:** the inert first Railway domain (`subscription-billing-kit-production.up.railway.app`, no working target port) was manually deleted from the Railway dashboard. Confirmed via `railway_list_domains`: only `subscription-billing-kit-production-0f5e.up.railway.app` (`targetPort: 3000`, the one actually wired to the live Stripe webhook endpoint) remains.

## Infrastructure: live run of `reconcile-nightly.ts`, and a real orphan_local finding

Run from the same machine as the dunning engine's live test-clock verification (this sandbox still can't reach the real Railway Postgres or `api.stripe.com`), closing out the remaining "needs a live run" open item.

- `npm run reconcile:nightly` for "yesterday" (UTC) reported a correctly-empty, zero-mismatch run - the test-clock verification's invoices were created *today* relative to when this ran, so an empty prior-day window is the correct answer, not a miss.
- `POST /admin/reconciliation/run` for an explicit window covering the actual invoices (from the Phase 5 dunning verification) surfaced a real, correctly-classified discrepancy: `invoiceCountStripe: 0`, `invoiceCountLocal: 2`, both local invoice rows (`in_1TxyX0LVBwTnHcyir8B3KgXj`, `in_1TxyYOLVBwTnHcyiQXKnghcd`) flagged `orphan_local`, `localTotalMinor: 5800` ($58.00 - two $29 Starter-plan invoices) at risk.

**Root cause, and why this is correct behavior, not a bug:** tearing down the test clocks used for that verification deleted the whole object graph on Stripe's side - customer, subscription, *and* invoices, not just the first two. This system deliberately never mirrors that kind of deletion locally (the same philosophy `customer.deleted` already follows - keep the local row as a historical record rather than delete it because Stripe's copy is gone), so the local invoice rows correctly persisted and reconciliation correctly flagged the resulting divergence. This is the live version of `test/integration/reconciliation.test.ts`'s `orphan_local` case, now demonstrated against genuinely divergent real data rather than a mock - both open items below are effectively closed by this and the domain deletion above.

**Open items now resolved (both):**
1. Reconciliation's live-run verification is done, above.
2. A dedicated demo Postgres exists: the user added it via the Railway dashboard's "Add PostgreSQL" flow (a proper managed volume, `RAILWAY_VOLUME_ID` confirmed present - not a bare-image container, which would lose data on every redeploy). Its internal `DATABASE_URL` (`postgres-zrmr.railway.internal`) was wired into the Subscription-Billing-Kit service via Railway's API. The resulting redeploy's logs confirm `migrations applied` and a clean boot against the new, empty database - all ten tables created fresh, no data carried over from the old shared "Postgres" service (by design: the old one is still shared with unrelated other projects in "Upwork Portfolio" and was never meant to be this kit's dedicated store).

**No open items remain from Phases 0-6.** The one thing worth noting for Phase 9: the demo database is currently empty (fresh schema, no seeded customers/subscriptions/invoices) - seeding it with realistic demo data is explicitly Phase 9's job ("deployed demo on Railway with seeded data"), not done here.

## Phase 7 — Admin UI

**Date:** 2026-07-28

**Status:** Code complete, all four backend endpoint gaps filled and tested, all six §7 screens built and wired to the real API, verified end to end locally. This phase has an explicit CHECKPOINT (screenshots of subscriptions list, subscription detail, dunning queue) - reported below, awaiting reply before Phase 8.

**Backend files touched (filling §6 gaps that predate this phase):**
- `api/src/routes/subscriptions.ts` — added `GET /subscriptions` (list: `status`/`q`/`cursor`/`limit`, keyset pagination, per-row MRR computed from non-removed items, joined customer + dunning stage); added the joined `customer` row and `dunning` state to the existing `GET /subscriptions/:id` (both were pre-existing §6 gaps, not new scope - see D-032)
- `api/src/routes/invoices.ts` (new) — `GET /invoices` (`customer_id`/`status`/`limit`, joined customer email)
- `api/src/routes/webhookEvents.ts` (new) — `GET /admin/webhook-events` (`status`/`type`/`limit`), `POST /admin/webhook-events/:id/replay` (resets a row to a clean `received` state - `attempts`, `next_attempt_at`, `processing_started_at`, `processed_at`, `last_error` all cleared)
- `api/src/app.ts` — registered both new route files; added `@fastify/cors` scoped to `env.APP_BASE_URL` (D-029) - a gap that only surfaced once a browser, not `curl` or a test, actually called the API cross-origin
- `api/test/integration/adminEndpoints.test.ts` (new) — 13 tests covering all four endpoints plus the customer/dunning additions to `GET /subscriptions/:id`

**Frontend: `/web` scaffolded fresh (Vite + React + TypeScript + Tailwind + react-router-dom, D-031):**
- `web/src/index.css` — §7's exact design tokens (`paper #FBFAF7`, `ink #14161A`, `rule #DFDCD4`, `alert #B4501E`, `settled #2F6B4F`; a `.num` tabular-nums monospace utility every amount/id/timestamp routes through); `prefers-reduced-motion` respected; visible focus rings
- `web/src/lib/money.ts`, `web/src/lib/format.ts` — frontend's own money/timestamp formatting, mirroring the API's zero-decimal discipline and the timeline's bank-statement timestamp shape rather than importing the API's module directly (D-030)
- `web/src/lib/api.ts`, `web/src/lib/types.ts` — typed fetch client and response shapes for every §6 endpoint the UI calls
- `web/src/components/` — `Layout` (nav across the six screens), `StatusTag` (short word + colored left rule, never a pill), `Amount`, `Modal`, `Toast` (buttons name the action, the toast repeats that word), `States` (empty/error/loading)
- `web/src/pages/` — all six screens: `SubscriptionsListPage`, `SubscriptionDetailPage` (header facts, per-item periods, the event timeline as the signature element, invoice list, cancel/resume/change-plan-with-proration-preview-modal), `DunningQueuePage` (grouped by stage, manual resolve modal), `InvoicesPage`, `WebhookLogPage` (expandable payload, replay), `ReconciliationPage` (run history, on-demand run, drill-in to the field-level diff table)
- Root `package.json`/`eslint.config.js` updated to add `web` as a third workspace, with its own `eslint.config.js` matching `api`'s pattern (replacing the Vite template's default `oxlint`, for one lint tool across the whole repo)

**Decisions made (D-029 through D-032, full detail in `docs/DECISIONS.md`):**
- CORS is scoped to `APP_BASE_URL` specifically, not a wildcard or a new env var - that config value already names the one origin meant to call these endpoints. See D-029.
- The frontend keeps its own small `money.ts`/`format.ts` rather than a shared package, since §3's repo layout doesn't define one and the frontend only ever needs the display direction of the API's money logic. See D-030.
- `react-router-dom` chosen via an explicit question, since §2 names the rest of the stack but not a router. See D-031.
- `GET /subscriptions/:id`'s new `customer` field is a pre-existing gap being filled, not new scope - the same category as the `dunning` field it was already missing before this phase. See D-032.

**How the exit criteria were verified:**
- `npm run typecheck` / `npm run lint` clean across all three workspaces (root, `api`, `web`).
- `api`: 50/50 integration tests, 53/53 unit tests green (13 of the integration tests are new, covering the four filled endpoint gaps).
- Both apps booted locally and exercised with real HTTP traffic end to end - not just unit tests. This sandbox still has no route to the real demo Postgres on Railway or to `api.stripe.com` (unchanged since Phase 0), so verification used the local dev Postgres (`billing_kit_test`), seeded with three representative subscriptions (a EUR trial, an active USD plan, and a USD plan mid-dunning-cycle with a real past-due invoice) via a throwaway script that was deleted afterward along with the rows it created - nothing from this walkthrough is in the repo or the committed history.
- This local walkthrough is what caught the CORS gap (D-029): the first attempt to load the subscriptions list from the browser failed with "Failed to fetch," which turned out to be the browser correctly blocking a cross-origin request with no `Access-Control-Allow-Origin` header - not a frontend bug. Fixed, then reverified.
- Playwright (pre-installed in this environment) drove the running app and captured all six screens, plus the dunning-resolve modal, the webhook payload expand/collapse toggle, and a 390px-wide mobile view of the subscriptions list, to confirm interactivity and responsiveness beyond a static screenshot. The three CHECKPOINT screens are attached to this report.

**Open items carried forward:** none new. The existing standing item - seeding the real deployed demo database - is still explicitly Phase 9's job, not this one.

## Phase 8 — Test suite

**Date:** 2026-07-28

**Status:** Complete. Both suites green, unit suite well under the 30s budget, coverage report committed to the README per this phase's exit criteria.

This phase's actual job wasn't writing new tests from scratch - almost all of §9's 25 named tests already existed from prior phases - it was auditing whether they genuinely prove what their names claim, since a plausibly-named `it()` that asserts something weaker is worse than an honest gap (it hides the gap instead of flagging it). Ran that audit via two parallel agents, each independently re-reading every test file's actual assertions (not just the `it()` description strings) against the exact 25 named tests in the build spec's §9.

**Findings, and what was fixed:**
- `every-state-machine-transition-is-covered` (unit) was **weak**: the exhaustive 64-pair loop only asserted `typeof result === 'boolean'`, proving no pair throws or returns `undefined`, but not that the value was *correct* - roughly half the 64 `(from, to)` pairs in `stateMachine.ts`'s `EXPECTED_TRANSITIONS` table were never checked against their actual expected value, so a swapped or dropped entry there would have passed silently. Fixed by adding a literal, test-owned 64-entry expected-value table (transcribed by hand, not imported from the source) and asserting every pair against it exactly.
- `replaying-the-same-event-100-times-changes-nothing` (integration) was **weak**: the existing test replayed the event 10 times, not 100. The property was genuinely proven either way, but the literal number in the spec's own test name was silently understated. Fixed by bumping the loop to exactly 100.
- `a-retried-create-call-with-the-same-idempotency-key-creates-one-subscription` (integration) was a genuine **gap**: this system creates subscriptions via Stripe Checkout + a webhook-driven projection, not a direct "create subscription" call, and the existing customer-retry test exercises a completely different mechanism (`external_ref`, no timestamp, a local pre-check that short-circuits before ever calling Stripe twice) that proves nothing about checkout-session/subscription creation's own timestamp-bearing key. Investigating this precisely (reading `routes/checkout.ts`, `stripe/checkout.ts`, `stripe/idempotency.ts`) surfaced a real, previously-undocumented architectural limit: the route mints a fresh `requestedAt` on every HTTP call, so only *this codebase's own* retry-with-the-same-`requestedAt` is actually deduplicated by Stripe - a client double-submitting the route is not. Documented in `docs/ARCHITECTURE.md`, and closed with a new test that calls `createCheckoutSession()` directly with a shared `requestedAt` across a simulated transient failure and retry, asserts the identical `idempotencyKey` was sent both times, then feeds the one resulting `customer.subscription.created` event through the real pipeline and confirms exactly one local subscription row.
- `plan-change-preview-matches-the-invoice-stripe-actually-issues` (integration) was **weak**: it only checked that the preview endpoint passed Stripe's number through unmodified and that the plan-change call's idempotency key matched a format regex - it never simulated the invoice Stripe would actually issue or compared it against the preview. Fixed by simulating that invoice (`amount_due` equal to the preview's figure) through `handleInvoiceEvent`, then asserting the persisted `invoices` row's `amountDueMinor` matches the preview's `amount_due` - an actual cross-check, not two literals typed the same by coincidence.
- `webhook-with-a-bad-signature-is-rejected-and-logged` (integration) was **weak**: thoroughly proved "rejected" (400, zero rows persisted) but never checked "and logged" at all - grepping the whole suite found no logger assertions anywhere. Fixed with a standalone Fastify app (registering the same `webhookRoutes` plugin `app.ts` uses) wired to a pino instance whose destination is a captured in-memory array, so the actual NDJSON warn-level log lines `receiver.ts` writes could be asserted against directly for both the tampered-signature and missing-header cases.
- All other 21 of the 25 named tests were independently reconfirmed to genuinely prove their claimed behavior against the real implementation, not just a similarly-titled assertion.

**Additional real gaps found independently, outside the §9 list, while wiring up coverage:**
- `routes/dunning.ts` (`GET /dunning/queue`, `POST /dunning/:id/resolve`) and `routes/reconciliation.ts` (`GET /admin/reconciliation`, `POST /admin/reconciliation/run`) had **zero** HTTP-level test coverage (15-20% in the coverage report) - `dunning.test.ts` and `reconciliation.test.ts` both call the underlying business-logic functions (`runDunningTick`, `runReconciliation`) directly and never hit the actual routes with `app.inject`. New file `test/integration/dunningReconciliationRoutes.test.ts` (9 tests) closes this, covering both routes' success and error paths (404/409/400).
- `GET /health` - Phase 0's own exit criterion and the first line of §6's API surface - had never once been asserted by an automated test, only checked manually with `curl` throughout the project. New file `test/integration/health.test.ts` (2 tests) covers both the healthy (200) and degraded (503, Stripe unreachable) paths, and asserts the pinned API version is reported in both.

**Files touched:**
- `api/test/unit/stateMachine.test.ts` - replaced the weak type-only sweep with a literal 64-entry expected-value table
- `api/test/integration/webhookReceiver.test.ts` - 10→100 replay count; added a captured-log assertion for both signature-rejection paths
- `api/test/integration/checkoutPortalPlanChange.test.ts` - new "retried create call" test; extended the plan-change-preview test with an actual issued-invoice cross-check
- `api/test/integration/dunningReconciliationRoutes.test.ts` (new) - HTTP-level tests for the dunning and reconciliation admin routes
- `api/test/integration/health.test.ts` (new) - `GET /health` healthy and degraded paths
- `api/vitest.unit.config.ts`, `api/vitest.integration.config.ts` - added `@vitest/coverage-v8` config (`text`/`text-summary`/`json-summary` reporters, excluding migrations and `index.ts`)
- `api/package.json` - added `test:unit:coverage`, `test:integration:coverage`
- `README.md` - new "Testing" section: how to run each suite, the 115-test/two-suite-green summary, the coverage table, and why unit/integration coverage are reported separately rather than merged (they deliberately exercise different layers, per the test-plan split)
- `docs/ARCHITECTURE.md` - documented the outbound-idempotency scope limit surfaced by the audit (own-retry-only, not client-double-submit) as a real, load-bearing fact for integrators, not just a testing note

**Verification:** typecheck/lint clean across all three workspaces; 53/53 unit tests (up from 53 - no new unit tests, one strengthened), 62/62 integration tests (up from 50: 9 dunning/reconciliation route tests + 2 health tests + 1 retry-idempotency test); unit suite runs in ~1.5s, comfortably under the 30s budget. Coverage: unit-only 15.84% lines (expected - routes/handlers/webhooks are integration-tested by design), integration-only 79.07% lines (up from 73.07% before this phase's route-coverage fixes).

**Open items carried forward:** none. The double-submit gap documented in `docs/ARCHITECTURE.md` above is a known, accepted product limitation flagged for a future decision, not a bug to silently fix in this phase.

## Phase 9 — Docs, demo, packaging

**Date:** 2026-07-29

**Status:** Complete. All four docs written, the demo script and the previously-missing `replay-event.ts` script both built and verified, and every doc/script adversarially fact-checked with every real finding fixed. Two exit-criteria items are explicitly, transparently unresolved by mutual agreement with the client (see "Open items" below) rather than silently skipped or faked.

This phase's job was turning four phases of working code into something a client can actually evaluate and run: a state-machine reference, an operational runbook, a packaging/pitch doc, a README that leads with the failure modes closed rather than the stack used, and an unattended demo that proves the full trial-to-recovery arc without anyone waiting on real calendar days.

**Docs written:**
- `docs/STATE-MACHINE.md` — the 8 statuses, the "expected vs. allowed" philosophy (Stripe is always the source of truth; an unexpected transition is still applied, just logged and flagged, never rejected), the full transition table, the `forceRecord` audit-row guarantee, and how a webhook actually reaches the table (`handleSubscriptionEvent` as the single dispatch point).
- `docs/RUNBOOK.md` — env var reference, first-time local setup, deploying, the two webhook gotchas required verbatim by §9 (wrong signing secret; mismatched per-endpoint API version), a crons-vs-in-process-ticks table, three ways to replay a failed webhook, a troubleshooting table, and Windows notes.
- `docs/DELIVERY.md` — the client-facing packaging doc per §12's template: Acceptance leading (as the spec instructs — "that's the whole pitch"), Deliverables, a 2-3 week Timeline, What I need from you, Out of scope.
- `README.md` — full rewrite per §11: opens with the failure-mode framing, a 14-row failure-mode table (every row linking to the real test file that proves it), a Screenshots section (6 images copied into `docs/screenshots/` from the Phase 7 checkpoint captures), Non-goals, Setup, Testing (retained from Phase 8), Stack deliberately last ("nobody hires on stack"), Repo layout.

**Scripts built:**
- `scripts/test-clock-demo.ts` — the unattended full-arc demo (trial → renewal → failed payment → dunning stage 3 → recovery) §5.12/§9 call for. The key design point: it calls the exact same `runDunningTick(now)` production code the real cron calls, just supplying an advancing simulated `now` instead of real wall-clock time — the same compression principle as Stripe's own test clocks, applied to the dunning side that Stripe's test clocks can't reach. Every webhook a real deployment would receive is instead delivered through a `deliverEvent()` helper that inserts a genuine `webhook_events` ledger row before calling the same handler functions the real receiver dispatches to (`handleCustomerEvent`/`handleSubscriptionEvent`/`handleInvoiceEvent`), so nothing about the handler code path differs from production.
- `scripts/replay-event.ts` — a genuine gap: §3's repo layout named this file but it was never built in any prior phase (the HTTP route did the same job, but never as a standalone script). Mirrors `routes/webhookEvents.ts`'s replay logic exactly. Smoke-tested against the local test database: inserted a fake failed row, ran the script, confirmed it reset to `received` with attempts/backoff/lease cleared.

**Adversarial fact-check (workflow, 4 parallel agents — one per new/rewritten doc, one over both scripts):**
- README: the zero-decimal-currency row overclaimed that `money.ts` is "the only place any amount is scaled; nothing else divides or multiplies by 100" — false, since `web/src/lib/money.ts` is a deliberate, D-030-documented display-only mirror that does its own `/100`. Fixed by scoping the claim to the API/backend and pointing to D-030.
- RUNBOOK: five env vars with Zod `.default()` values (`APP_BASE_URL`, `API_BASE_URL`, `DUNNING_ENABLED`, `WEBHOOK_LEASE_SECONDS`, `RECONCILE_TZ`) were labelled "Yes" (required) instead of "Optional (defaults to X)". Fixed. Also fixed: "`npm run build` compiles both" (it only compiles the API — `build:web` is separate); the replay route's param documented as `:stripe_event_id` when the actual Fastify param is `:id`; and a self-contradiction where the gotchas intro claimed both "fail the exact same way: a silent 400" while the Troubleshooting table (correctly) distinguishes gotcha #2 as a 200-with-corrupted-fields failure — reworded the intro to match the table.
- STATE-MACHINE: the closing citation credited D-001/D-002/D-020 for the transition table, staleness guard, and audit-row content — D-001 (API version pinning) and D-002 (periods on items) are unrelated Phase 0/1 decisions. Corrected to D-006 (re-fetch truth), D-017 (staleness guard), D-020 (`forceRecord`), verified each against `docs/DECISIONS.md` to actually match.
- `test-clock-demo.ts` — three real bugs, all would have surfaced only on an actual run:
  1. **FK violation on first real run.** `subscription_events.stripe_event_id` has a real foreign key to `webhook_events.stripe_event_id`; the original draft called handlers with a synthetic event object that was never backed by a ledger row, so the first recorded transition with a non-null `stripeEventId` would crash. Fixed by introducing `deliverEvent()`, which inserts the ledger row first.
  2. **Cleanup gap.** The dunning arc creates `dunning_notices` rows (a real FK to `subscriptions.id`), but the teardown block never deleted them before deleting `subscriptions` — would fail the FK constraint and silently leak rows on every re-run. Fixed by adding the delete, first, in FK order.
  3. **Late id capture.** `localSubscriptionId`/`localCustomerId` were only assigned after the payment-failure section succeeded, so an earlier thrown error (a real risk given test-clock timing) would leave cleanup unable to find what to clean up. Fixed by capturing both ids immediately after `customer.subscription.created` is delivered.

**Files touched:**
- `docs/STATE-MACHINE.md`, `docs/RUNBOOK.md`, `docs/DELIVERY.md` (new)
- `README.md` (full rewrite)
- `docs/screenshots/*.png` (6 new files, copied from the Phase 7 checkpoint captures so the README's links resolve to real committed images)
- `scripts/test-clock-demo.ts`, `scripts/replay-event.ts` (new)
- `package.json` (root) — added the `replay-event` script

**Verification:** typecheck and lint clean across all three workspaces after the `test-clock-demo.ts` fixes; 53/53 unit tests, 62/62 integration tests, both suites still green with no regressions from this phase's changes (no test files were touched — this phase only added docs and standalone scripts outside the test tree).

**Open items — both explicitly raised and, per the client's own choice, deferred rather than built or worked around:**
- **Seeding the live deployed demo (Railway + Stripe).** This sandbox has no path to run `test-clock-demo.ts` against the actual deployed environment: no raw network route to `api.stripe.com` or the deployed Railway Postgres, Railway's MCP tools expose no SQL-execution capability for a non-Supabase Postgres service, and the Stripe MCP's generic API tools don't expose the `/v1/test_helpers/*` test-clock namespace at all. The script itself is built, smoke-testable, and ready to run from any machine with real network access to both services — it just can't be executed from here. Presented via `AskUserQuestion`; the client chose to skip it for now rather than have new workaround scope built.
- **Read-only admin access control.** The admin UI currently has no authentication/authorization layer distinguishing read-only from full-access users. This was never in any prior phase's scope and would be new, undiscussed work. Presented alongside the item above; the client chose to skip it for now.

Both remain here as disclosed, known gaps for whoever picks this up next — not silently absent.

## Phase 10 — Admin access control

**Date:** 2026-07-29

**Status:** Complete. Closes the "read-only admin access control" item Phase 9 left open. This was never in the original spec — raised as a gap during Phase 9, scoped out on request, then built once the client explicitly asked for it.

Before this phase, every admin route (subscriptions, invoices, dunning, reconciliation, webhook-events admin endpoints) had **zero** access control — not a missing read-only tier, no gate of any kind. Any direct HTTP call, not just browser traffic CORS restricts, could read or mutate anything with no credential at all.

**What was built:** a shared-secret gate, not full user accounts (see `docs/DECISIONS.md` D-033 for why). Two env vars — `ADMIN_API_KEY` (full read+write) and `ADMIN_READONLY_KEY` (GET only) — checked via `Authorization: Bearer <key>` against every admin route. The public customer/checkout/portal routes and the webhook receiver stay ungated, since they're meant for an external storefront and Stripe respectively, not an admin.

- `api/src/lib/adminAuth.ts` (new) — `resolveAdminRole()` is a pure function (keys passed in, not read from the `env` singleton internally) so it's unit-testable without side effects, the same reason `envSchema.ts` was split from `env.ts` back in Phase 0. Compares candidate keys via SHA-256 digest + `timingSafeEqual` rather than a direct string compare, so neither a timing side-channel nor a length-mismatch throw leaks anything about the real key. `adminAuthPreHandler` is the Fastify preHandler that actually gates requests: 401 with no/wrong key, 403 if a read-only key hits anything but GET or HEAD.
- `api/src/app.ts` — the five admin route registrations (`subscriptionRoutes`, `dunningRoutes`, `reconciliationRoutes`, `invoiceRoutes`, `webhookEventRoutes`) moved into a single encapsulated Fastify plugin scope with `adminAuthPreHandler` as its one `preHandler` hook, using the same encapsulation mechanism `webhookRoutes` already relies on for its own scoped raw-body parser. `/customers`, `/checkout/sessions`, `/portal/sessions`, `/health`, and `/webhooks/stripe` stay outside this scope, untouched.
- `api/src/lib/envSchema.ts`, `.env`, `.env.example`, `.github/workflows/ci.yml` — the two new required env vars, with a CI-only placeholder pair clearly marked as not real secrets. A `superRefine` rejects boot if the two are ever set to the same value.
- Every existing integration test that hits an admin route over HTTP (`adminEndpoints.test.ts`, `dunningReconciliationRoutes.test.ts`, the `/subscriptions/*` calls in `checkoutPortalPlanChange.test.ts`) now sends the write key via a new shared `test/integration/helpers/adminAuth.ts` — none of their existing assertions changed, they just needed a credential to keep reaching the routes they were already testing.
- `api/test/unit/adminAuth.test.ts` (new, 10 tests) — role resolution for both keys, a key matching neither, a missing header, a header without the `Bearer` scheme, an empty token, case sensitivity on the key itself, prefix/superstring near-misses, and the `Bearer` scheme's own case-insensitivity.
- `api/test/integration/adminAccessControl.test.ts` (new, 58 tests, table-driven over all 7 admin GET routes and 6 admin mutating routes) — proves the gate itself, not the business logic behind each route (that's already covered where each route's own tests live): every admin route rejects with 401 given no header or a key matching neither tier; the read-only key is allowed on every GET and rejected with 403 (not 401 — the key is valid, just insufficient) on every mutating route; the write key passes the gate on both; a HEAD request with the read-only key is treated the same as GET; and the public/special routes (`/health`, `/customers`, `/checkout/sessions`, `/portal/sessions`, `/webhooks/stripe`) all reach their own validation/signature logic rather than being blocked by this gate at all.
- `web/src/lib/adminKey.ts` (new) — get/set/clear against `sessionStorage`, not `localStorage`, so the key clears when the tab closes rather than persisting indefinitely on a shared machine. The trade-off this accepts (any XSS in the bundle could read it, unlike an httpOnly cookie) is documented directly in the file's comment, not left implicit.
- `web/src/lib/api.ts` — `request()` attaches the stored key as the `Authorization` header on every call; a 401 response clears the stored key and reloads the page so the gate reprompts, rather than surfacing a confusing "unauthorized" toast on whatever page happened to be open. A 5-second watchdog rejects the in-flight promise if the reload is ever delayed, so a caller's `finally` (busy/loading state) can't hang forever waiting on a navigation that didn't happen.
- `web/src/components/AdminGate.tsx` (new) — a plain key-entry form, deliberately not styled as a real login (there's no account behind it), wrapping the whole app in `main.tsx`. A 403 from a mutating action with the read-only key surfaces through each page's existing error/toast handling — no separate client-side read-only UI mode was built, since the server-side 403 already covers it correctly.

**Adversarial review (workflow, 4 parallel agents — adminAuth internals, the web-side gate, test-coverage completeness, docs accuracy) and what it found:**
- Real, fixed: `resolveAdminRole` originally short-circuited on a write-key match (one `safeEqual` call) versus two for anything else — a real, if narrow, timing asymmetry. Fixed by always evaluating both comparisons regardless of the first result.
- Real, fixed: the `Bearer` scheme check was case-sensitive (`'Bearer '` only), rejecting a spec-legal `'bearer <key>'` or `'BEARER <key>'` even with a fully valid key (RFC 7235 defines the auth-scheme token as case-insensitive). Fixed with a case-insensitive regex match.
- Real, fixed: Fastify registers a HEAD sibling for every GET route by default; the read-only-key check only special-cased `GET`, so a legitimate read-only HEAD request was incorrectly rejected with 403. Fixed by allowing HEAD alongside GET.
- Real, fixed: nothing prevented `ADMIN_API_KEY` and `ADMIN_READONLY_KEY` from being configured identically — since the write key is checked first, that misconfiguration would silently turn the "read-only" key into a full write key. Fixed with an `envSchema.ts` cross-field check that fails boot loudly instead.
- Real, fixed (test gap): `adminAccessControl.test.ts`'s route matrix only covered 2 of `subscriptionRoutes`' 6 endpoints (`GET /subscriptions` and `POST /subscriptions/:id/cancel`) — `GET /subscriptions/:id`, `GET /subscriptions/:id/preview`, `POST /subscriptions/:id/plan`, and `POST /subscriptions/:id/resume` were silently absent from the dedicated auth-gate suite (their business logic was tested elsewhere, but not that the gate itself covers them). Fixed by adding all four.
- Real, fixed (docs): PROGRESS.md's own first draft of this entry said "six admin route registrations" — it's five. README's test-count summary (115 tests / 53 unit + 62 integration) was the pre-Phase-10 figure, sitting a few lines below the new admin-gate paragraph in the same file — updated along with the coverage table.
- Real, disclosed rather than built: the web-side 401 handler originally returned a promise that never resolved (relying on `window.location.reload()` tearing down the page before anyone could observe it) — added a 5-second watchdog so a blocked/delayed reload can't hang a button's busy-state forever, and documented the sessionStorage-vs-httpOnly-cookie XSS trade-off directly in `adminKey.ts` rather than leaving it unstated. A related finding (`AdminGate`'s local `authenticated` state can be briefly stale relative to `sessionStorage` during the reload window) was assessed as having no security consequence — the pending reload erases the stale state within the same tick cycle — and left as-is rather than adding state-sync complexity for a sub-second window with no actual impact.
- No issue, verified rather than assumed: the Fastify plugin encapsulation actually scopes `adminAuthPreHandler` to only the five route modules registered inside `adminScope` (confirmed by reading `fastify`'s own `plugin-override.js` — each `register()` call snapshots the parent's hook list at that moment, so the hook can't leak sideways to `app`'s other children); multiple `Authorization` headers in one request can't smuggle a second identity (Node's HTTP parser keeps only the first occurrence); and no route anywhere is registered outside its intended scope or duplicated across scopes.

**Verification:** typecheck and lint clean across all three workspaces. 63/63 unit tests (up from 53 — 10 new), 120/120 integration tests (up from 62 — 58 new, plus the existing admin-route tests now carrying the write-key header). `npm run build --workspace=web` succeeds. Coverage: unit-only 17.43% lines (up from 15.84%), integration-only 81.37% lines (up from 79.07%). Beyond the automated suites, manually verified against a real running instance (not just `app.inject`): booted the API and admin UI locally, `curl`-verified the 401/200/200/403 sequence (no key / write key / read key on GET / read key on POST) directly against the live server, then drove the actual browser UI with Playwright — confirmed the gate blocks on first load, a wrong key gets rejected and reprompts (the 401→clear→reload path), the real read-only key unlocks the UI and loads real data from the local database end to end, and a mutating call made through that same authenticated page session comes back 403.

**Open items:** none new. This closes the "read-only admin access control" item Phase 9 left open; the live-deployed-demo-seeding item from Phase 9 remains open, unchanged (still a hard sandbox network limitation, not something this phase touched).

**Post-merge incident:** this PR's merge crashed the already-deployed Railway service. `ADMIN_API_KEY`/`ADMIN_READONLY_KEY` are required in `envSchema.ts` with no default, but the deployed environment only ever had the pre-existing vars (`DATABASE_URL`, `STRIPE_*`) set on it — nothing about merging a PR pushes new env vars to an existing deployment, only `.env.example` documented that they'd need to exist. The next boot after the merge failed with `Invalid environment configuration: ADMIN_API_KEY/ADMIN_READONLY_KEY: expected string, received undefined`. Fixed by generating two new random keys and setting them directly on the deployed service (Railway API), which triggered a redeploy that came up clean (migrations applied, server listening, confirmed via runtime logs). Added a caution to `docs/RUNBOOK.md`'s Deploying section so a future required-env-var addition gets set on existing deployments before merging, not discovered as a crash after.

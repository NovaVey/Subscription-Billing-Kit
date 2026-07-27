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

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

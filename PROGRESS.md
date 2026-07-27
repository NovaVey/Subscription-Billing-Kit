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

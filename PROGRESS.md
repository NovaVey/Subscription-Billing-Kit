# Progress

Running log of what's been built, by phase. This is how a new session resumes: read the latest entry, check the open questions, don't redo what's already here.

## Phase 0 — Scaffold

**Date:** 2026-07-27

**Status:** Code complete, pending CHECKPOINT confirmation before Phase 1.

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

**Open questions (blocking Phase 1 — see checkpoint message):**
1. Railway Postgres — an "Upwork Portfolio" project with a `Subscription-Billing-Kit` service already exists (pre-provisioned), but no Postgres database is attached to it yet. Needs a decision: provision one now (dev + a separate demo DB per §2), or is there an existing `DATABASE_URL` to use?
2. Stripe API version to pin — connected Stripe account is a sandbox ("Nova Vey sandbox", `acct_1TkxuuLVBwTnHcyi`). The account's API version isn't exposed over the API (only in Workbench), so this needs to come from you.
3. `STRIPE_SECRET_KEY` (test mode) — not something to paste into a committed file or chat log carelessly; need a decision on how it's supplied (direct to Railway env vars vs. a `.env` I set locally in this session).
4. Stripe CLI isn't installed in this container — fine for Phase 0, will need it (or an equivalent) from Phase 2 onward for `stripe listen` / `stripe trigger`.

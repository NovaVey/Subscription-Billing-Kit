# Subscription-Billing-Kit

Stripe subscription billing that survives production: idempotent webhook ledger with replay, a total subscription state machine, dunning workflow, and nightly reconciliation. TypeScript, Fastify, Postgres — every failure mode covered by a named test.

> **Status: Phase 8 (test suite) complete.** This README is a skeleton and will get the full §11 treatment in Phase 9. See `PROGRESS.md` for the current state and decision log.

## Non-goals

This service never touches raw card data, never renders a card form, and never stores a PAN. [Stripe Checkout](https://stripe.com/docs/payments/checkout) and the [Customer Portal](https://stripe.com/docs/customer-management) handle all of it.

## Requirements

- Node.js 20+
- A Postgres database (Railway in dev/demo)
- A Stripe account in test mode, and the Stripe CLI for local webhook forwarding

## Setup

```
npm install
cp .env.example .env
# fill in .env — see docs/ARCHITECTURE.md §5.1 before setting STRIPE_API_VERSION
npm run dev
```

`GET /health` reports Postgres connectivity, Stripe connectivity, and the pinned Stripe API version.

## Testing

```
npm run test:unit --workspace=api          # fast, no external services — target under 30s
npm run test:integration --workspace=api   # real Postgres + a mocked Stripe client, no time budget
npm run test:unit:coverage --workspace=api
npm run test:integration:coverage --workspace=api
```

Every test is named after the specific failure it prevents (see `docs/ARCHITECTURE.md` and the test files themselves) — 19 integration + 6 unit tests are named directly in the project brief's §9, plus additional tests covering the admin API surface, the admin UI's supporting routes, and `/health`.

**115 tests, both suites green:** 53 unit (~1.5s) + 62 integration (~12s).

Coverage below is `%Lines` from `@vitest/coverage-v8`, run separately per suite since they exercise different layers on purpose — unit tests cover pure logic in isolation (`money.ts`, `time.ts`, `stateMachine.ts`, `idempotency.ts`, `reconcile.ts`'s classifier), while routes, webhook handlers, and the processor/reaper are deliberately only exercised through the integration suite against a real database, per the test-plan split in `docs/ARCHITECTURE.md`. Reading the unit number on its own understates coverage for exactly that reason — the two numbers answer different questions, not the same question twice.

| Suite | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| Unit only | 15.78% | 11.04% | 26.42% | 15.84% |
| Integration only | 78.31% | 65.46% | 77.14% | 79.07% |

The remaining uncovered lines are almost entirely process bootstrapping that isn't meaningful to unit-test in isolation: `index.ts` (excluded from the report entirely), `webhooks/worker.ts`'s `setInterval` wiring, and `db/migrate.ts`'s CLI entry point.

## Repo layout

See `PROGRESS.md` for what exists today. The target layout is documented in the project brief; `/api` is the Fastify service, `/web` (from Phase 7) is the admin UI, `/docs` holds architecture and runbook docs, `/scripts` holds operational scripts (catalog seeding, test clocks, event replay).

## License

MIT — see `LICENSE`.

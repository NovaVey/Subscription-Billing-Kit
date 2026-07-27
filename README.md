# Subscription-Billing-Kit

Stripe subscription billing that survives production: idempotent webhook ledger with replay, a total subscription state machine, dunning workflow, and nightly reconciliation. TypeScript, Fastify, Postgres — every failure mode covered by a named test.

> **Status: Phase 0 (scaffold) in progress.** This README is a skeleton and will be filled in per `docs/DELIVERY.md` §11 as each phase lands. See `PROGRESS.md` for the current state and decision log.

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

## Repo layout

See `PROGRESS.md` for what exists today. The target layout is documented in the project brief; `/api` is the Fastify service, `/web` (from Phase 7) is the admin UI, `/docs` holds architecture and runbook docs, `/scripts` holds operational scripts (catalog seeding, test clocks, event replay).

## License

MIT — see `LICENSE`.

# Runbook

Operational reference for running this service — local dev, deploying, and the two gotchas that cost real time on this exact project.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | `postgres://` or `postgresql://` connection string. |
| `STRIPE_SECRET_KEY` | Yes | `sk_test_...`, `sk_live_...`, or a restricted `rk_...` key. |
| `STRIPE_API_VERSION` | Yes, no default | Pinned deliberately — see §5.1 in `docs/ARCHITECTURE.md`. Never falls back to the account's dashboard default. |
| `STRIPE_WEBHOOK_SECRET` | Optional at boot, required at runtime | The app still starts and serves `/health` without it, but every webhook is rejected with a loud 500 until it's set — see the gotcha below. |
| `STRIPE_PORTAL_CONFIG_ID` | Optional | Only needed if you use a non-default Customer Portal configuration. |
| `APP_BASE_URL` | Optional (defaults `http://localhost:5173`) | The admin UI's own origin — also what CORS is scoped to (see `docs/DECISIONS.md` D-029). Set it explicitly outside dev. |
| `API_BASE_URL` | Optional (defaults `http://localhost:3000`) | Where the API itself is reachable. Set it explicitly outside dev. |
| `DUNNING_ENABLED` | Optional (defaults `true`) | Gates the in-process 15-minute dunning tick (dev). Set `false` to disable it without redeploying — e.g. if `scripts/dunning-tick.ts` is scheduled externally instead. |
| `WEBHOOK_LEASE_SECONDS` | Optional (defaults `300`) | How long a claimed `processing` row can stay claimed before the reaper reclaims it. |
| `RECONCILE_TZ` | Optional (defaults `UTC`) | The timezone `computeYesterdayWindow()` bounds the nightly reconciliation window in. |
| `ADMIN_API_KEY` | Yes | Full read+write access to every admin route (subscriptions, invoices, dunning, reconciliation, webhook-events admin endpoints). Generate a long random string; never reuse across environments. See `docs/DECISIONS.md` D-033. |
| `ADMIN_READONLY_KEY` | Yes | Same routes, GET only - any mutating call with this key gets a 403. Neither key gates `/customers`, `/checkout/sessions`, `/portal/sessions`, or `/webhooks/stripe`, which stay open to the storefront/Stripe respectively. |

## First-time local setup

```
npm install
cp .env.example .env
# fill in .env — see docs/ARCHITECTURE.md §5.1 before setting STRIPE_API_VERSION
npm run db:migrate
npm run seed:catalog        # creates Starter/Pro/Scale products+prices in Stripe test mode, writes catalog.json
npm run dev                 # API on API_BASE_URL (default :3000)
npm run dev:web             # admin UI on :5173, separate terminal
stripe listen --forward-to localhost:3000/webhooks/stripe
```

Opening the admin UI for the first time in a tab prompts for an admin key - paste `ADMIN_API_KEY` for full access or `ADMIN_READONLY_KEY` to browse without being able to mutate anything. It's held in that tab's `sessionStorage`, not saved anywhere else, and clears when the tab closes.

`stripe listen` prints its own `whsec_...` — that's the value for `STRIPE_WEBHOOK_SECRET` **locally only**. Keep reading before reusing it anywhere else.

## Deploying

`npm start` runs `node dist/db/migrate.js && node dist/index.js` — migrations apply on every boot, so a deploy is never blocked on a manual migration step. `npm run build` compiles the API; `npm run build:web` compiles the admin UI separately.

If you're on Railway specifically: a service domain created without an explicit target port can silently fail to route any traffic to the container at all — no error, the domain just never receives a request. Always set the target port explicitly to match `API_BASE_URL`'s port.

## The two gotchas that will cost you an afternoon if you miss them

Neither one crashes anything, and `/health` still reports green — the app looks fine either way. Gotcha #1 fails loudly-but-invisibly-to-you: a silent 400 on every webhook delivery, visible only in Stripe's dashboard as a string of failed attempts. Gotcha #2 is quieter still: deliveries return 200, but with fields silently wrong or missing on the received payload — see the Troubleshooting table below for how to tell them apart.

**1. The deployed endpoint's signing secret is not the one `stripe listen` prints.**

`stripe listen`'s secret is a local-forwarding secret, valid only for events it relays to your machine during that session. A real webhook endpoint — created via the Stripe Dashboard or the API, pointed at your deployed URL — gets issued its **own**, separate signing secret the moment it's created, shown to you exactly once. That deployed secret, not the CLI's, is what belongs in the deployed environment's `STRIPE_WEBHOOK_SECRET`. Mixing them up (shipping the CLI's local secret to production, or trying to use the deployed endpoint's secret with `stripe listen`) fails signature verification 100% of the time, and `webhooks/receiver.ts` correctly rejects every one of those events with 400 — which is the *correct* behavior for a genuinely wrong secret, not a bug to work around.

**2. The deployed endpoint's API version is configured per-endpoint in the dashboard, separately from `STRIPE_API_VERSION`.**

Every webhook endpoint in Stripe — including one created via the API — has its own pinned API version, independent of the version your SDK client requests on outbound calls. If the endpoint's configured version doesn't match `STRIPE_API_VERSION`, incoming event payloads can be shaped for a *different* API version than the one this codebase's handlers were written against — the exact Basil period-field failure mode this whole project exists to prevent (§5.1), just arriving via the webhook side instead of an outbound SDK call. Always confirm the endpoint's dashboard-configured version matches `STRIPE_API_VERSION` exactly when creating or updating it.

## Crons vs the in-process ticks

| Job | Dev | Production |
|---|---|---|
| Webhook processor + reaper | Always-on interval in `webhooks/worker.ts` | Same — this one has no standalone script, it's meant to run inside the long-lived API process. |
| Dunning tick | Same in-process interval, every 15 minutes, gated by `DUNNING_ENABLED` | `npm run dunning:tick` (`scripts/dunning-tick.ts`) on an external cron — a long-lived process's timer isn't something a prod scheduler points at. |
| Reconciliation | On-demand only (`POST /admin/reconciliation/run`, or the admin UI) | `npm run reconcile:nightly` (`scripts/reconcile-nightly.ts`) on an external cron, once per currency found in local invoices. |

## Replaying a failed webhook event

Three equivalent ways to reset a `webhook_events` row back to a clean `received` state (status, attempts, backoff, and lease all cleared — a manual "try this again," distinct from the automatic backoff/retry the processor already does on its own):

1. Admin UI → Webhook log → **Replay** button on the row.
2. `POST /admin/webhook-events/:id/replay` (the route param is named `:id`, but the value expected there is the Stripe event id).
3. `npm run replay-event -- <stripe_event_id>` (`scripts/replay-event.ts`) when the API isn't reachable — e.g. during an incident, or scripted against the database directly.

The next processor tick claims the reset row and re-applies it.

## Troubleshooting

| Symptom | Likely cause | Where to look |
|---|---|---|
| Every webhook returns 400 | Wrong signing secret for this environment (see gotcha #1) | Compare the deployed endpoint's secret (Stripe Dashboard → Webhooks → your endpoint) against `STRIPE_WEBHOOK_SECRET`. |
| Webhooks return 200 but fields end up `null`/`undefined` that shouldn't be | API version mismatch between the endpoint and `STRIPE_API_VERSION` (see gotcha #2) | Stripe Dashboard → Webhooks → your endpoint → API version. |
| `/health` returns 500 or `db.ok: false` | Postgres unreachable, or `DATABASE_URL` wrong | Check the connection string; `checkDbConnectivity()` runs `select 1`. |
| A `webhook_events` row is stuck `processing` | A worker died mid-event (deploy, OOM) | Wait for `WEBHOOK_LEASE_SECONDS` — the reaper reclaims it automatically and logs a warning. |
| A row is `status='failed'` | It hit 5 attempts (`MAX_ATTEMPTS`) without succeeding | Check `last_error` on the row (admin UI Webhook log, expandable payload), fix the underlying cause, then replay it (see above). |
| A dunning cycle never resolves after the invoice was paid | The payment landed on a *different* invoice for the same subscription | Resolution is keyed to the specific `triggering_invoice_id` by design (D-012) — check `GET /subscriptions/:id`'s `dunning.triggeringInvoiceId` against the invoice that was actually paid; use the admin UI's manual resolve if it's a legitimate recovery through another channel. |
| A reconciliation run reports `orphan_local` entries | A local invoice row has no Stripe counterpart — often a deleted Stripe test object (e.g. a torn-down test clock cascades deleting its customer, subscription, and invoices) that this system deliberately never mirrors locally | Confirm the Stripe object is genuinely gone (not a transient list-API issue) before treating it as data corruption. |

## Windows notes

Editing `.env` in Git Bash: `notepad .env` opens it in a real GUI editor. If `curl`/Stripe CLI calls against a real HTTPS endpoint fail with a schannel `CRYPT_E_NO_REVOCATION_CHECK` error, that's a Windows-specific certificate-revocation-check network issue, not a bad certificate — retry with `curl --ssl-no-revoke`.

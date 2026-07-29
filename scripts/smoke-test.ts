// Live smoke test against a *running* instance - local, CI, or deployed -
// over real HTTP, not in-process imports like the other scripts/*.ts files.
// This checks a different thing than `npm run test:integration`: that suite
// proves business logic against a real database with a *mocked* Stripe
// client; this proves the actual deployed wiring (every route reachable,
// the admin auth gate enforced correctly, Stripe connectivity as reported
// by /health) - the exact layer that was never automatically checked before
// the Phase 10 deploy incident (a required env var missing on the deployed
// service, invisible to any local test run).
//
// Usage:
//   npm run smoke-test -- --base-url https://your-deployed-url
//   BASE_URL=... ADMIN_API_KEY=... ADMIN_READONLY_KEY=... npm run smoke-test
//
// Two tiers, reported separately:
//   - Tier 1 (always runs): every route's auth gate, input validation, and
//     404-before-any-Stripe-call behavior - confirmed by reading each
//     handler's own source that the local lookup happens before any
//     `stripe.*` call, so these are safe to run with zero Stripe network
//     access (this sandbox, most CI runners).
//   - Tier 2 (gated on /health reporting Stripe reachable): one genuine
//     round trip through Stripe - creating a customer, then confirming a
//     repeat call with the same external_ref is idempotent - only attempted
//     where Stripe is actually reachable, so this script degrades to
//     "SKIPPED, no Stripe network" rather than a false failure when run from
//     an environment like this one. Deliberately just the one check: every
//     Tier 2 check leaves permanent state behind (there's no delete route
//     anywhere in this API), so the very first run against any given target
//     permanently creates one real Stripe Customer and one `customers` row
//     (external_ref='smoke-test-canary') - re-running is safe (the same
//     idempotency this check is proving), but that first-run residue is a
//     real, accepted trade-off, not an oversight.

function parseArgs(argv: string[]): { baseUrl: string; writeKey: string; readonlyKey: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i]?.startsWith('--')) {
      flags.set(argv[i]!.slice(2), argv[i + 1] ?? '');
      i += 1;
    }
  }
  const baseUrl = flags.get('base-url') ?? process.env['BASE_URL'] ?? 'http://localhost:3000';
  const writeKey = flags.get('write-key') ?? process.env['ADMIN_API_KEY'] ?? '';
  const readonlyKey = flags.get('readonly-key') ?? process.env['ADMIN_READONLY_KEY'] ?? '';
  if (!writeKey || !readonlyKey) {
    throw new Error(
      'ADMIN_API_KEY and ADMIN_READONLY_KEY are required (env vars, or --write-key/--readonly-key) - ' +
        'this smoke test proves the auth gate itself, so it needs real credentials for the target instance.',
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), writeKey, readonlyKey };
}

type Status = 'pass' | 'fail' | 'skip';
interface Result {
  name: string;
  status: Status;
  detail?: string;
}
const results: Result[] = [];

async function req(
  baseUrl: string,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 8000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}${path}`, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, status: 'pass' });
    console.log(`[smoke-test] PASS  ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'fail', detail });
    console.log(`[smoke-test] FAIL  ${name} - ${detail}`);
  }
}

function skip(name: string, reason: string): void {
  results.push({ name, status: 'skip', detail: reason });
  console.log(`[smoke-test] SKIP  ${name} - ${reason}`);
}

function assertStatus(res: Response, expected: number, label: string): void {
  if (res.status !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${res.status}`);
  }
}

const FAKE_ID = '00000000-0000-0000-0000-000000000000';

async function main() {
  const { baseUrl, writeKey, readonlyKey } = parseArgs(process.argv.slice(2));
  const writeAuth = { authorization: `Bearer ${writeKey}` };
  const readAuth = { authorization: `Bearer ${readonlyKey}` };
  console.log(`[smoke-test] target: ${baseUrl}`);

  // --- Tier 1: health ---
  let stripeReachable = false;
  await check('GET /health responds', async () => {
    const res = await req(baseUrl, '/health');
    if (res.status !== 200 && res.status !== 503) {
      throw new Error(`unexpected status ${res.status}`);
    }
    const body = (await res.json()) as { db?: { ok?: boolean }; stripe?: { ok?: boolean } };
    if (typeof body.db?.ok !== 'boolean' || typeof body.stripe?.ok !== 'boolean') {
      throw new Error(`missing db.ok/stripe.ok in response: ${JSON.stringify(body)}`);
    }
    stripeReachable = body.stripe.ok;
    if (!body.db.ok) throw new Error('db.ok is false - Postgres unreachable');
  });

  // --- Tier 1: admin auth gate, every admin route ---
  const adminGetRoutes = [
    '/subscriptions',
    `/subscriptions/${FAKE_ID}`,
    `/subscriptions/${FAKE_ID}/preview?price_id=price_x&quantity=1`,
    '/invoices',
    '/dunning/queue',
    '/admin/reconciliation',
    '/admin/webhook-events',
  ];
  // A body is included wherever the route requires one, so the write-key
  // check below genuinely reaches each handler's local-lookup/404 path
  // rather than stopping at Zod's own 400 first (which would still satisfy
  // "not 401/403" without ever proving the gate actually passed the request
  // through) - confirmed safe to do (no Stripe call before the 404) by
  // reading each handler's source. /admin/reconciliation/run is deliberately
  // left bodyless here: unlike the others, reaching past its own validation
  // would call the real Stripe API (see the dedicated invalid-window check
  // below, which proves its 400-before-Stripe behavior on purpose instead).
  const adminMutatingRoutes = [
    { method: 'POST', url: `/subscriptions/${FAKE_ID}/plan`, body: { price_id: 'price_x', quantity: 1, proration_behavior: 'create_prorations' } },
    { method: 'POST', url: `/subscriptions/${FAKE_ID}/cancel`, body: { at_period_end: true } },
    { method: 'POST', url: `/subscriptions/${FAKE_ID}/resume` },
    { method: 'POST', url: `/dunning/${FAKE_ID}/resolve`, body: { resolution: 'manual', note: 'smoke-test' } },
    { method: 'POST', url: '/admin/reconciliation/run' },
    { method: 'POST', url: '/admin/webhook-events/evt_does_not_exist/replay' },
  ];

  for (const url of adminGetRoutes) {
    await check(`GET ${url} rejects with no key`, async () => {
      assertStatus(await req(baseUrl, url), 401, 'no key');
    });
    await check(`GET ${url} allows the read-only key`, async () => {
      const res = await req(baseUrl, url, { headers: readAuth });
      if (res.status === 401 || res.status === 403) throw new Error(`got ${res.status}`);
    });
  }
  for (const route of adminMutatingRoutes) {
    const bodyInit = route.body
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(route.body) }
      : {};
    await check(`${route.method} ${route.url} rejects with no key`, async () => {
      assertStatus(await req(baseUrl, route.url, { method: route.method, ...bodyInit }), 401, 'no key');
    });
    await check(`${route.method} ${route.url} rejects the read-only key with 403`, async () => {
      assertStatus(
        await req(baseUrl, route.url, {
          method: route.method,
          ...bodyInit,
          headers: { ...bodyInit.headers, ...readAuth },
        }),
        403,
        'readonly key',
      );
    });
    await check(`${route.method} ${route.url} allows the write key past the gate`, async () => {
      const res = await req(baseUrl, route.url, {
        method: route.method,
        ...bodyInit,
        headers: { ...bodyInit.headers, ...writeAuth },
      });
      if (res.status === 401 || res.status === 403) throw new Error(`got ${res.status}`);
    });
  }

  // --- Tier 1: public/special routes stay ungated ---
  await check('POST /customers reaches its own validation, not the admin gate', async () => {
    assertStatus(await req(baseUrl, '/customers', { method: 'POST', body: '{}' }), 400, 'body validation');
  });
  await check('POST /checkout/sessions with an unknown customer_id returns 404 (no Stripe call reached)', async () => {
    const res = await req(baseUrl, '/checkout/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customer_id: FAKE_ID, price_id: 'price_x', quantity: 1 }),
    });
    assertStatus(res, 404, 'unknown customer');
  });
  await check('POST /portal/sessions with an unknown customer_id returns 404 (no Stripe call reached)', async () => {
    const res = await req(baseUrl, '/portal/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customer_id: FAKE_ID, return_url: 'https://example.com' }),
    });
    assertStatus(res, 404, 'unknown customer');
  });
  await check('POST /webhooks/stripe with no signature returns 400, not blocked by admin auth', async () => {
    const res = await req(baseUrl, '/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assertStatus(res, 400, 'missing signature');
  });
  await check('POST /admin/reconciliation/run rejects an invalid window before any Stripe call', async () => {
    const res = await req(baseUrl, '/admin/reconciliation/run', {
      method: 'POST',
      headers: { ...writeAuth, 'content-type': 'application/json' },
      body: JSON.stringify({
        period_start: '2026-01-02T00:00:00.000Z',
        period_end: '2026-01-01T00:00:00.000Z',
        currency: 'usd',
      }),
    });
    assertStatus(res, 400, 'invalid window');
  });

  // --- Tier 1: listing endpoints return a well-shaped body ---
  const listings: Array<[string, string]> = [
    ['/subscriptions', 'subscriptions'],
    ['/invoices', 'invoices'],
    ['/dunning/queue', 'queue'],
    ['/admin/reconciliation', 'runs'],
    ['/admin/webhook-events', 'events'],
  ];
  for (const [url, key] of listings) {
    await check(`GET ${url} returns a well-shaped body with the write key`, async () => {
      const res = await req(baseUrl, url, { headers: writeAuth });
      assertStatus(res, 200, 'listing');
      const body = (await res.json()) as Record<string, unknown>;
      if (!Array.isArray(body[key])) throw new Error(`expected an array at "${key}", got ${JSON.stringify(body)}`);
    });
  }

  // --- Tier 2: only where /health said Stripe is actually reachable ---
  if (!stripeReachable) {
    skip('POST /customers is idempotent on a repeated external_ref', 'Stripe unreachable per /health - see the disclosed network limitation in docs/ARCHITECTURE.md');
  } else {
    await check('POST /customers is idempotent on a repeated external_ref', async () => {
      const payload = { external_ref: 'smoke-test-canary', email: 'smoke-test@example.com' };
      const first = await req(baseUrl, '/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 15000,
      });
      if (first.status !== 200 && first.status !== 201) throw new Error(`first call: got ${first.status}`);
      const firstBody = (await first.json()) as { id: string };
      const second = await req(baseUrl, '/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assertStatus(second, 200, 'retry');
      const secondBody = (await second.json()) as { id: string };
      if (secondBody.id !== firstBody.id) throw new Error('retry created a second customer row');
    });
  }

  // --- Summary ---
  const failed = results.filter((r) => r.status === 'fail');
  const skipped = results.filter((r) => r.status === 'skip');
  console.log(
    `[smoke-test] ${results.length - failed.length - skipped.length}/${results.length} passed, ${skipped.length} skipped, ${failed.length} failed`,
  );
  if (failed.length > 0) {
    console.log('[smoke-test] failures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[smoke-test] failed:', err);
  process.exitCode = 1;
});

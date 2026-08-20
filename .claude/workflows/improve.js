export const meta = {
  name: 'improve',
  description: 'Audit the repo for code-quality bugs, test coverage gaps, and doc/code drift, with adversarial verification',
  phases: [
    { title: 'Code Quality Review', detail: 'bugs / simplification / efficiency across api/ and web/' },
    { title: 'Code Quality Verify', detail: 'adversarially verify each finding before reporting it' },
    { title: 'Test Coverage Audit', detail: 'find undertested code paths in api/ and web/, propose tests' },
    { title: 'Docs Accuracy Audit', detail: 'fact-check README + docs/*.md against the actual current code' },
  ],
}

// --- Code quality: bugs / simplification / efficiency, each independently reviewed then adversarially verified ---

const DIMENSIONS = [
  {
    key: 'bugs',
    prompt: `You are reviewing the Subscription Billing Kit repo (Fastify + Postgres/Drizzle API in api/, Stripe subscription billing, webhook processing, dunning, reconciliation, admin-gated REST routes, plus a React/Vite admin UI in web/) for CORRECTNESS BUGS.

Focus especially on: money/currency handling (api/src/lib/money.ts and its callers), Stripe webhook signature verification and idempotency (api/src/webhooks/), the subscription state machine (api/src/billing/stateMachine.ts) and its webhook handlers (api/src/webhooks/handlers/*), dunning escalation logic (api/src/billing/dunning.ts), reconciliation logic (api/src/billing/reconcile.ts), admin auth gating (api/src/lib/adminAuth.ts), outbound Stripe idempotency (api/src/stripe/idempotency.ts, api/src/stripe/sync.ts) - and the web UI's request-shape assumptions (web/src/lib/api.ts and its callers: does every fetch that should carry no body actually avoid a Content-Type header, do all callers handle 401/403/404 consistently, are loading/busy states reset on every code path including errors).

Look for: incorrect edge-case handling, off-by-one errors, race conditions, unhandled promise rejections, incorrect Stripe API version assumptions, type mismatches, and logic that contradicts what the code's own comments/docs claim it does. For each finding report file, line, a one-sentence summary of the defect, and a concrete failure scenario (specific input/state -> wrong output/crash). Be conservative - only report things you are confident are genuine bugs, not style preferences.`,
  },
  {
    key: 'simplify',
    prompt: `Review the same repo (Subscription Billing Kit: api/ Fastify+Postgres+Drizzle backend, web/ React+Vite admin UI, scripts/) for SIMPLIFICATION AND REUSE opportunities: duplicated logic that should be extracted into a shared helper, overly complex code that could be simpler without behavior change, dead code or unused exports, and inconsistent patterns between similar call sites (e.g. api routes that duplicate validation/error-handling logic instead of sharing it, or web/src pages that duplicate fetch/error-toast/busy-state patterns instead of a shared hook).

For each finding report file, line, the current pattern, and the simpler equivalent. Only report changes that are safe and behavior-preserving - do not suggest anything that would change externally observable behavior (API responses, DB schema, UI text/flow).`,
  },
  {
    key: 'efficiency',
    prompt: `Review the same repo (Subscription Billing Kit: api/ Fastify+Postgres+Drizzle backend, web/ React+Vite admin UI, scripts/) for EFFICIENCY issues: N+1 database queries, missing indexes implied by real query patterns, unnecessary sequential awaits that could run in parallel, unbounded loops/polling intervals, or web UI code that re-fetches more than necessary or re-renders unnecessarily.

For each finding report file, line, the inefficiency, and roughly how much it costs (e.g. "N+1 query - one query per subscription instead of a single join/IN query, O(n) round trips to Postgres on a list endpoint that could be O(1)"). Only report things with a real, non-trivial cost - skip micro-optimizations.`,
  },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string' },
          failure_scenario: { type: 'string' },
        },
        required: ['file', 'summary', 'failure_scenario'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    isReal: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
  required: ['isReal', 'reasoning'],
}

phase('Code Quality Review')
log('Reviewing bugs / simplification / efficiency in parallel, verifying each finding as its dimension finishes')

const reviewResults = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `review:${d.key}`, phase: 'Code Quality Review', schema: FINDINGS_SCHEMA }),
  (review, dimension) => {
    const findings = (review?.findings || []).slice(0, 12) // bound verification cost per dimension
    if (review?.findings && review.findings.length > 12) {
      log(`${dimension.key}: ${review.findings.length} findings, verifying first 12`)
    }
    return parallel(
      findings.map(f => () =>
        agent(
          `Try to REFUTE this claimed ${dimension.key} issue by reading the actual code at the given location.\nFile: ${f.file}${f.line ? ':' + f.line : ''}\nClaim: ${f.summary}\nFailure scenario: ${f.failure_scenario}\n\nIf you cannot confirm this is a real, currently-existing issue in the code as written, set isReal=false. Default to isReal=false if you are not fully certain (do not give benefit of the doubt to a vague or unverifiable claim).`,
          { label: `verify:${dimension.key}`, phase: 'Code Quality Verify', schema: VERDICT_SCHEMA },
        ).then(v => ({ ...f, dimension: dimension.key, verdict: v })),
      ),
    )
  },
)

const codeQualityFindings = reviewResults
  .filter(Boolean)
  .flat()
  .filter(Boolean)
  .filter(f => f.verdict?.isReal)

log(`Code quality: ${codeQualityFindings.length} findings survived adversarial verification`)

// --- Test coverage gaps: backend and frontend audited independently ---

const GAPS_SCHEMA = {
  type: 'object',
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          area: { type: 'string' },
          missing: { type: 'string' },
          proposedTest: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['area', 'missing', 'proposedTest', 'priority'],
      },
    },
  },
  required: ['gaps'],
}

phase('Test Coverage Audit')

const [backendGaps, frontendGaps] = await parallel([
  () =>
    agent(
      `Audit test coverage for the API in this Stripe subscription billing repo (api/src, scripts/). Tests live under api/test/unit and api/test/integration (see api/vitest.unit.config.ts and api/vitest.integration.config.ts for the split). Compare what's actually tested against the source, especially business-critical logic: billing/stateMachine.ts, billing/dunning.ts, billing/reconcile.ts, webhooks/handlers/*, webhooks/processor.ts, webhooks/reaper.ts, stripe/idempotency.ts, stripe/sync.ts, lib/money.ts, lib/time.ts, routes/*.ts, lib/adminAuth.ts.

Identify: (a) source files or exported functions with NO corresponding test at all, (b) functions that have some tests but are missing coverage for known-tricky edge cases (currency rounding, timezone boundaries, out-of-order webhook delivery, dunning stage transitions, idempotency key collisions, admin key auth edge cases), and (c) any test that doesn't actually assert anything meaningful. For each gap report: area/file, what's missing, a concrete proposed test case (input -> expected behavior) - describe it in prose, do not write the test code - and a priority (high/medium/low) based on how business-critical the untested path is.`,
      { label: 'coverage:api', phase: 'Test Coverage Audit', schema: GAPS_SCHEMA },
    ),
  () =>
    agent(
      `Audit test coverage for the admin web UI (web/src) in this Stripe subscription billing repo. First confirm whether there are any frontend tests at all (search for *.test.* / *.spec.* files and a test runner config under web/). If there are effectively none, say so explicitly and propose the highest-value ones to add first, prioritizing flows with real production risk: the cancel-subscription confirmation flow, any POST/DELETE action that sends no request body (a real bug shipped here once: Fastify rejects "Content-Type: application/json" paired with an empty body, and web/src/lib/api.ts's shared request() helper is the one place this is currently handled correctly - a regression there would silently break every no-body action again), 401/403 error-toast handling, and the plan-change preview/apply flow.

For each gap report: area/file, what's missing, a concrete proposed test case (input/interaction -> expected behavior) - describe it in prose, do not write the test code - and a priority (high/medium/low).`,
      { label: 'coverage:web', phase: 'Test Coverage Audit', schema: GAPS_SCHEMA },
    ),
])

const coverageGaps = [...(backendGaps?.gaps || []), ...(frontendGaps?.gaps || [])]
log(`Test coverage: ${coverageGaps.length} gaps proposed`)

// --- Docs accuracy: fact-check documented claims against the real current code ---

const DISCREPANCY_SCHEMA = {
  type: 'object',
  properties: {
    discrepancies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          docFile: { type: 'string' },
          docLocation: { type: 'string' },
          claim: { type: 'string' },
          actual: { type: 'string' },
          codeLocation: { type: 'string' },
        },
        required: ['docFile', 'claim', 'actual'],
      },
    },
  },
  required: ['discrepancies'],
}

phase('Docs Accuracy Audit')

const [operationalDocs, designDocs] = await parallel([
  () =>
    agent(
      `Fact-check README.md, docs/RUNBOOK.md, and docs/DELIVERY.md in this repo against the ACTUAL current code behavior (not what the docs claim). For every concrete technical claim (env var requirements/defaults, endpoint paths/methods, CLI script usage and flags, deployment steps, feature flags), verify it against the real source in api/src, scripts/, and web/. Report every discrepancy: what the doc claims, what the code actually does, the doc's location (file + heading), and the code's location (file:line). Only report genuine mismatches, not omission of trivial detail.`,
      { label: 'docs:operational', phase: 'Docs Accuracy Audit', schema: DISCREPANCY_SCHEMA },
    ),
  () =>
    agent(
      `Fact-check docs/ARCHITECTURE.md, docs/DECISIONS.md, and docs/STATE-MACHINE.md in this repo against the ACTUAL current code. Verify the documented subscription state machine transition table against api/src/billing/stateMachine.ts, verify each numbered decision in DECISIONS.md is still reflected in the code as written (not superseded by a later change), and verify the described module layout/architecture actually matches the real file structure. Report every discrepancy: what the doc claims, what the code actually does, the doc's location (file + heading), and the code's location (file:line). Only report genuine mismatches.`,
      { label: 'docs:design', phase: 'Docs Accuracy Audit', schema: DISCREPANCY_SCHEMA },
    ),
])

const docDiscrepancies = [...(operationalDocs?.discrepancies || []), ...(designDocs?.discrepancies || [])]
log(`Docs accuracy: ${docDiscrepancies.length} discrepancies found`)

return {
  codeQuality: {
    total: codeQualityFindings.length,
    findings: codeQualityFindings,
  },
  testCoverage: {
    total: coverageGaps.length,
    gaps: coverageGaps,
  },
  docsAccuracy: {
    total: docDiscrepancies.length,
    discrepancies: docDiscrepancies,
  },
}

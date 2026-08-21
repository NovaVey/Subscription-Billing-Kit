// datetime-local input values are timezone-naive - `new Date('2026-05-01T09:00')`
// is interpreted in whatever timezone the process is running in. Force a
// specific, non-UTC zone here so the test is deterministic regardless of the
// host/CI machine's default TZ, and so it actually exercises an offset
// conversion (UTC would make a reordering/truncation bug invisible since
// local time and UTC would be identical). Node/V8 in this project's vitest
// setup (Node 22, vitest 4, jsdom, default 'forks' pool - see vitest.config.ts)
// reads process.env.TZ per Date construction rather than caching a
// process-wide default at startup, so assigning it here, before any Date is
// constructed anywhere in this file (including inside imported modules'
// module-level code, none of which touch Date), is sufficient - no
// beforeAll/reset-cache workaround was needed. This was verified empirically
// against this exact file (see report).
process.env.TZ = 'America/New_York';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { ReconciliationPage } from '../../src/pages/ReconciliationPage';
import { ToastProvider } from '../../src/components/Toast';
import type { ReconciliationRun, ReconciliationRunDetail, ReconciliationRunResult } from '../../src/lib/types';
import { server } from '../mswServer';

const BASE_URL = 'http://localhost:3000';

function renderPage() {
  server.use(http.get(`${BASE_URL}/admin/reconciliation`, () => HttpResponse.json({ runs: [] })));
  return render(
    <ToastProvider>
      <ReconciliationPage />
    </ToastProvider>,
  );
}

describe('ReconciliationPage run form period conversion', () => {
  it('sends the exact ISO conversion of the picked datetime-local period values (and currency) in the run request body', async () => {
    const captured: { body: unknown } = { body: null };
    server.use(
      http.post(`${BASE_URL}/admin/reconciliation/run`, async ({ request }) => {
        captured.body = await request.json();
        const result: ReconciliationRunResult = {
          runId: 'run_test_1',
          entries: [],
          stripeTotalMinor: 0,
          localTotalMinor: 0,
          mismatchCount: 0,
          invoiceCountStripe: 0,
          invoiceCountLocal: 0,
        };
        return HttpResponse.json(result);
      }),
    );

    const user = userEvent.setup();
    renderPage();

    // Wait for the initial (empty) run-history load to settle before
    // interacting, matching this repo's other page tests.
    await screen.findByText('No reconciliation runs yet. Run one above, or wait for the nightly job.');

    await user.type(screen.getByLabelText('Period start'), '2026-05-01T09:00');
    await user.type(screen.getByLabelText('Period end'), '2026-05-01T17:00');
    const currencyInput = screen.getByLabelText('Currency');
    await user.clear(currencyInput);
    await user.type(currencyInput, 'eur');

    await user.click(screen.getByRole('button', { name: 'Run reconciliation' }));

    // Wait for the run to complete (the detail section renders once
    // `setSelected` runs in the success path) before asserting on the
    // captured request body.
    expect(await screen.findByText('Zero mismatches for this run.')).toBeInTheDocument();

    // Computed the same way the component computes it (via `new Date(...)`
    // under this file's forced TZ), not a hardcoded guessed UTC offset -
    // this still catches reordering, truncation, or an off-by-one in
    // handleRun's conversion because the two picked values are distinct.
    const expectedStart = new Date('2026-05-01T09:00').toISOString();
    const expectedEnd = new Date('2026-05-01T17:00').toISOString();
    // Sanity: under the forced America/New_York (EDT, UTC-4 in May) zone
    // these must actually differ from a naive "treat as UTC" reading -
    // otherwise the assertion below wouldn't be able to catch a reordering
    // or off-by-one bug in the component's conversion.
    expect(expectedStart).toBe('2026-05-01T13:00:00.000Z');
    expect(expectedEnd).toBe('2026-05-01T21:00:00.000Z');

    expect(captured.body).toEqual({
      period_start: expectedStart,
      period_end: expectedEnd,
      currency: 'eur',
    });
  });
});

describe('ReconciliationPage drill-in race', () => {
  it('discards a stale drill-in response that resolves after a newer drill-in was clicked', async () => {
    const runA: ReconciliationRun = {
      id: 'run_a',
      periodStart: '2026-05-01T00:00:00.000Z',
      periodEnd: '2026-05-02T00:00:00.000Z',
      ranAt: '2026-05-02T00:05:00.000Z',
      currency: 'usd',
      stripeTotalMinor: 100,
      localTotalMinor: 100,
      invoiceCountStripe: 1,
      invoiceCountLocal: 1,
      mismatchCount: 1,
    };
    const runB: ReconciliationRun = { ...runA, id: 'run_b', ranAt: '2026-05-03T00:05:00.000Z' };
    const detailA: ReconciliationRunDetail = {
      ...runA,
      report: [{ type: 'missing_local', stripeInvoiceId: 'in_stale_from_a' }],
    };
    const detailB: ReconciliationRunDetail = {
      ...runB,
      report: [{ type: 'missing_local', stripeInvoiceId: 'in_fresh_from_b' }],
    };

    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    server.use(
      http.get(`${BASE_URL}/admin/reconciliation`, () => HttpResponse.json({ runs: [runA, runB] })),
      http.get(`${BASE_URL}/admin/reconciliation/:id`, async ({ params }) => {
        if (params['id'] === 'run_a') {
          // Held back until run_b's drill-in (clicked after this one) has
          // already resolved, reproducing the out-of-order arrival.
          await gateA;
          return HttpResponse.json(detailA);
        }
        return HttpResponse.json(detailB);
      }),
    );

    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ReconciliationPage />
      </ToastProvider>,
    );

    const drillInButtons = await screen.findAllByRole('button', { name: 'Drill in' });
    expect(drillInButtons).toHaveLength(2);

    // Click run_a's "Drill in" first - its request is now in flight and
    // gated on gateA.
    await user.click(drillInButtons[0]!);
    // Click run_b's "Drill in" before run_a's response has landed.
    await user.click(drillInButtons[1]!);

    // run_b resolved immediately - its (fresher) detail is showing.
    expect(await screen.findByText('in_fresh_from_b')).toBeInTheDocument();

    // Now let run_a's stale response land.
    releaseA();
    await vi.waitFor(() => {
      expect(screen.queryAllByRole('button', { name: 'Loading…' })).toHaveLength(0);
    });

    // The stale response must not have overwritten `selected` - run_b's
    // detail (the one the user actually asked to see last) is still shown,
    // and run_a's stale row never appears.
    expect(screen.getByText('in_fresh_from_b')).toBeInTheDocument();
    expect(screen.queryByText('in_stale_from_a')).not.toBeInTheDocument();
  });
});

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
import { describe, expect, it } from 'vitest';
import { ReconciliationPage } from '../../src/pages/ReconciliationPage';
import { ToastProvider } from '../../src/components/Toast';
import type { ReconciliationRunResult } from '../../src/lib/types';
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

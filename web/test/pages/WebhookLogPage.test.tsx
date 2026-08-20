import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { WebhookLogPage } from '../../src/pages/WebhookLogPage';
import { ToastProvider } from '../../src/components/Toast';
import type { WebhookEvent } from '../../src/lib/types';
import { server } from '../mswServer';

const rowA: WebhookEvent = {
  stripeEventId: 'evt_a',
  type: 'invoice.payment_failed',
  apiVersion: '2024-06-20',
  eventCreatedAt: '2026-08-19T10:00:00.000Z',
  receivedAt: '2026-08-19T10:00:01.000Z',
  processingStartedAt: null,
  processedAt: '2026-08-19T10:00:02.000Z',
  status: 'processed',
  attempts: 1,
  nextAttemptAt: null,
  lastError: null,
};

const rowB: WebhookEvent = {
  stripeEventId: 'evt_b',
  type: 'customer.subscription.updated',
  apiVersion: '2024-06-20',
  eventCreatedAt: '2026-08-19T11:00:00.000Z',
  receivedAt: '2026-08-19T11:00:01.000Z',
  processingStartedAt: null,
  processedAt: '2026-08-19T11:00:02.000Z',
  status: 'processed',
  attempts: 1,
  nextAttemptAt: null,
  lastError: null,
};

function renderPage() {
  render(
    <ToastProvider>
      <WebhookLogPage />
    </ToastProvider>,
  );
}

// Rows render in listWebhookEvents' response order with no client-side sort,
// so getAllByRole('row') is [thead row, row A, row B] once loaded.
async function getDataRows() {
  await screen.findByText(rowA.type);
  const rows = screen.getAllByRole('row');
  return { rowAEl: rows[1], rowBEl: rows[2] };
}

beforeEach(() => {
  server.use(http.get('http://localhost:3000/admin/webhook-events', () => HttpResponse.json({ events: [rowA, rowB] })));
});

describe('WebhookLogPage per-row Replay busy state', () => {
  it('scopes the busy/disabled Replay state to the clicked row, then shows a success indicator once it resolves', async () => {
    let releaseReplay!: () => void;
    const pending = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    server.use(
      http.post('http://localhost:3000/admin/webhook-events/evt_a/replay', async () => {
        await pending;
        return HttpResponse.json({ stripeEventId: 'evt_a', status: 'processing' });
      }),
    );

    const user = userEvent.setup();
    renderPage();

    const { rowAEl, rowBEl } = await getDataRows();
    const replayA = within(rowAEl).getByRole('button', { name: 'Replay' });
    const replayB = within(rowBEl).getByRole('button', { name: 'Replay' });

    expect(replayA).toBeEnabled();
    expect(replayB).toBeEnabled();

    await user.click(replayA);

    // Busy state is per-row: A is disabled while its request is in flight,
    // B is untouched.
    expect(replayA).toBeDisabled();
    expect(replayB).toBeEnabled();

    releaseReplay();

    expect(await screen.findByRole('status')).toHaveTextContent('Replayed');
    expect(replayA).toBeEnabled();
    expect(replayB).toBeEnabled();
  });

  it('re-enables Replay (not stuck disabled) and shows an alert-toned failure message when the request fails', async () => {
    // Held pending like the success case above, so the busy state is
    // actually observable before the rejection resolves it away - an
    // immediately-rejecting mock can settle before the assertion runs.
    let releaseReplay!: () => void;
    const pending = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    server.use(
      http.post('http://localhost:3000/admin/webhook-events/evt_a/replay', async () => {
        await pending;
        return HttpResponse.json({ error: 'Stripe rejected the replay' }, { status: 502 });
      }),
    );

    const user = userEvent.setup();
    renderPage();

    const { rowAEl } = await getDataRows();
    const replayA = within(rowAEl).getByRole('button', { name: 'Replay' });

    await user.click(replayA);
    expect(replayA).toBeDisabled();

    releaseReplay();

    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('Stripe rejected the replay');
    expect(toast).toHaveClass('border-alert');

    // Failure still clears the busy state via the handler's `finally`.
    expect(replayA).toBeEnabled();
  });
});

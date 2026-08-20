import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { DunningQueuePage } from '../../src/pages/DunningQueuePage';
import { ToastProvider } from '../../src/components/Toast';
import type { DunningQueueRow } from '../../src/lib/types';
import { server } from '../mswServer';

const queueRow: DunningQueueRow = {
  subscriptionId: 'sub_dunning_1',
  stage: 2,
  daysInStage: 3,
  nextActionAt: '2026-08-21T00:00:00.000Z',
  triggeringInvoiceId: 'in_abc123',
  amountAtRiskMinor: 4999,
  currency: 'usd',
  noticesSent: 2,
  planCode: 'pro-monthly',
  subscriptionStatus: 'past_due',
  customerEmail: 'dunning@example.com',
  customerExternalRef: null,
};

let capturedResolveBody: unknown;

function renderPage() {
  render(
    <MemoryRouter>
      <ToastProvider>
        <DunningQueuePage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  capturedResolveBody = undefined;
  server.use(
    http.get('http://localhost:3000/dunning/queue', () => HttpResponse.json({ queue: [queueRow] })),
    http.post('http://localhost:3000/dunning/:id/resolve', async ({ request, params }) => {
      capturedResolveBody = await request.json();
      return HttpResponse.json({ subscriptionId: params.id, resolution: 'recovered' });
    }),
  );
});

async function openResolveModal(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText(queueRow.customerEmail);
  await user.click(screen.getByRole('button', { name: 'Resolve' }));
  return screen.getByRole('dialog', { name: `Resolve dunning for ${queueRow.customerEmail}` });
}

describe('DunningQueuePage resolve modal note guard', () => {
  it('disables Resolve while the note is empty, and keeps it disabled for a whitespace-only note', async () => {
    const user = userEvent.setup();
    renderPage();

    const dialog = await openResolveModal(user);
    const resolveButton = within(dialog).getByRole('button', { name: 'Resolve' });
    expect(resolveButton).toBeDisabled();

    // The component's guard is `!note.trim() || busy` - a whitespace-only
    // note trims to '', so it must stay disabled too, not just the fully
    // empty case.
    await user.type(within(dialog).getByLabelText('Note'), '   ');
    expect(resolveButton).toBeDisabled();
  });

  it('enables Resolve once a real note is entered, and submits the selected resolution and note verbatim', async () => {
    const user = userEvent.setup();
    renderPage();

    const dialog = await openResolveModal(user);
    const resolveButton = within(dialog).getByRole('button', { name: 'Resolve' });

    await user.type(within(dialog).getByLabelText('Note'), 'Customer called, card was expired, updated manually.');
    await user.selectOptions(within(dialog).getByLabelText('Resolution'), 'manual');
    expect(resolveButton).toBeEnabled();

    await user.click(resolveButton);

    expect(capturedResolveBody).toEqual({
      resolution: 'manual',
      note: 'Customer called, card was expired, updated manually.',
    });

    // Modal closes.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Success indicator (toast) appears.
    expect(await screen.findByRole('status')).toHaveTextContent('Resolved');
  });
});

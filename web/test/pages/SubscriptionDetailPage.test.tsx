import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { SubscriptionDetailPage } from '../../src/pages/SubscriptionDetailPage';
import { ToastProvider } from '../../src/components/Toast';
import type { SubscriptionDetailResponse } from '../../src/lib/types';
import { server } from '../mswServer';

const BASE_URL = 'http://localhost:3000';
const SUB_ID = 'sub_row_1';

function buildDetail(overrides: Partial<SubscriptionDetailResponse> = {}): SubscriptionDetailResponse {
  return {
    subscription: {
      id: SUB_ID,
      customerId: 'cust_1',
      stripeSubscriptionId: 'sub_1Naaa00000000000',
      status: 'active',
      planCode: 'pro_monthly',
      currency: 'usd',
      trialEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      nextPeriodEndDerived: '2026-09-20T00:00:00.000Z',
      lastEventAt: '2026-08-01T12:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-08-01T12:00:00.000Z',
    },
    customer: {
      id: 'cust_1',
      externalRef: 'ext-1',
      stripeCustomerId: 'cus_1aaa',
      email: 'jane@example.com',
      name: 'Jane Doe',
      delinquent: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    items: [
      {
        id: 'item_1',
        subscriptionId: SUB_ID,
        stripeItemId: 'si_1aaa',
        priceId: 'price_basic',
        quantity: 1,
        unitAmountMinor: 1900,
        currency: 'usd',
        recurringInterval: 'month',
        currentPeriodStart: '2026-08-01T00:00:00.000Z',
        currentPeriodEnd: '2026-09-01T00:00:00.000Z',
        removedAt: null,
      },
    ],
    timeline: [
      {
        id: 'evt_1',
        subscriptionId: SUB_ID,
        fromStatus: null,
        toStatus: 'active',
        reason: 'subscription_created',
        actor: 'stripe',
        note: null,
        stripeEventId: 'evt_stripe_1',
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    invoices: [],
    dunning: null,
    ...overrides,
  };
}

function renderPage() {
  server.use(
    http.get(`${BASE_URL}/subscriptions/:id`, () => HttpResponse.json(buildDetail())),
  );
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/subscriptions/${SUB_ID}`]}>
        <Routes>
          <Route path="/subscriptions/:id" element={<SubscriptionDetailPage />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

async function waitForLoaded() {
  await screen.findByText('jane@example.com');
}

beforeEach(() => {
  sessionStorage.clear();
});

describe('SubscriptionDetailPage cancel confirmation flow', () => {
  it('cancel at period end shows access-continues copy and sends { at_period_end: true } on confirm', async () => {
    let capturedBody: unknown = null;
    let capturedContentType: string | null = null;
    server.use(
      http.post(`${BASE_URL}/subscriptions/${SUB_ID}/cancel`, async ({ request }) => {
        capturedBody = await request.json();
        capturedContentType = request.headers.get('content-type');
        return HttpResponse.json({ id: SUB_ID, status: 'canceled' });
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: 'Cancel at period end' }));

    const dialog = screen.getByRole('dialog', { name: 'Confirm cancellation' });
    expect(within(dialog).getByText(/keeps access until then/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Yes, cancel' }));

    expect(capturedBody).toEqual({ at_period_end: true });
    expect(capturedContentType).toBe('application/json');
    expect(await screen.findByText('Canceled at period end')).toBeInTheDocument();
  });

  it('cancel immediately shows the irreversible warning and sends { at_period_end: false } on confirm', async () => {
    let capturedBody: unknown = null;
    server.use(
      http.post(`${BASE_URL}/subscriptions/${SUB_ID}/cancel`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ id: SUB_ID, status: 'canceled' });
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: 'Cancel immediately' }));

    const dialog = screen.getByRole('dialog', { name: 'Confirm cancellation' });
    expect(
      within(dialog).getByText(/cannot be undone/i),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Yes, cancel' }));

    expect(capturedBody).toEqual({ at_period_end: false });
    expect(await screen.findByText('Canceled')).toBeInTheDocument();
  });

  it('never sends a cancel request when the operator backs out via "Never mind"', async () => {
    let cancelCallCount = 0;
    server.use(
      http.post(`${BASE_URL}/subscriptions/${SUB_ID}/cancel`, () => {
        cancelCallCount += 1;
        return HttpResponse.json({ id: SUB_ID, status: 'canceled' });
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    // Open via "Cancel at period end"...
    await user.click(screen.getByRole('button', { name: 'Cancel at period end' }));
    await user.click(screen.getByRole('button', { name: 'Never mind' }));
    expect(screen.queryByRole('dialog', { name: 'Confirm cancellation' })).not.toBeInTheDocument();

    // ...and via "Cancel immediately" too - neither path should ever fire the request.
    await user.click(screen.getByRole('button', { name: 'Cancel immediately' }));
    await user.click(screen.getByRole('button', { name: 'Never mind' }));
    expect(screen.queryByRole('dialog', { name: 'Confirm cancellation' })).not.toBeInTheDocument();

    expect(cancelCallCount).toBe(0);
  });

  it('disables "Yes, cancel" and shows a busy label while the request is in flight', async () => {
    server.use(
      http.post(
        `${BASE_URL}/subscriptions/${SUB_ID}/cancel`,
        () => new Promise(() => {}), // never resolves - simulates an in-flight request
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: 'Cancel at period end' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm cancellation' });
    await user.click(within(dialog).getByRole('button', { name: 'Yes, cancel' }));

    const busyButton = within(dialog).getByRole('button', { name: 'Canceling…' });
    expect(busyButton).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Never mind' })).toBeDisabled();
  });

  it('closes the modal and shows the server failure reason when cancel fails', async () => {
    server.use(
      http.post(`${BASE_URL}/subscriptions/${SUB_ID}/cancel`, () =>
        HttpResponse.json({ error: 'Stripe rejected the cancellation' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: 'Cancel at period end' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm cancellation' });
    await user.click(within(dialog).getByRole('button', { name: 'Yes, cancel' }));

    // finally-block behavior: the modal closes even though the request failed.
    expect(await screen.findByText('Stripe rejected the cancellation')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Confirm cancellation' })).not.toBeInTheDocument();

    const toast = screen.getByText('Stripe rejected the cancellation');
    expect(toast.className).toMatch(/border-alert/);
  });
});

describe('SubscriptionDetailPage plan-change preview/apply gating', () => {
  async function openPlanModal(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Change plan' }));
    return screen.getByRole('dialog', { name: 'Change plan' });
  }

  it('disables preview with an empty price and apply with no preview yet', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    const dialog = await openPlanModal(user);
    expect(within(dialog).getByRole('button', { name: 'Preview proration' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Apply plan change' })).toBeDisabled();
  });

  it('previews proration with the current form values and enables apply on success', async () => {
    // A plain container object (rather than a bare `let`) so reading
    // `.url` after the request-handler closure runs isn't misnarrowed by
    // TS's control-flow analysis back to the pre-assignment `null`.
    const captured: { url: URL | null; method: string | null } = { url: null, method: null };
    server.use(
      http.get(`${BASE_URL}/subscriptions/${SUB_ID}/preview`, ({ request }) => {
        captured.url = new URL(request.url);
        captured.method = request.method;
        return HttpResponse.json({ currency: 'usd', amount_due: 1234, total: 1234, lines: [] });
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    const dialog = await openPlanModal(user);
    await user.type(within(dialog).getByLabelText('Price id'), 'price_pro');
    await user.click(within(dialog).getByRole('button', { name: 'Preview proration' }));

    expect(await within(dialog).findByText('Amount due now')).toBeInTheDocument();
    expect(captured.method).toBe('GET');
    expect(captured.url?.searchParams.get('price_id')).toBe('price_pro');
    expect(captured.url?.searchParams.get('quantity')).toBe('1');
    expect(captured.url?.searchParams.get('proration_behavior')).toBe('create_prorations');
    expect(within(dialog).getByText('USD 12.34')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Apply plan change' })).toBeEnabled();
  });

  it('renders the preview error and keeps apply disabled when preview fails', async () => {
    server.use(
      http.get(`${BASE_URL}/subscriptions/${SUB_ID}/preview`, () =>
        HttpResponse.json({ error: 'No such price' }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    const dialog = await openPlanModal(user);
    await user.type(within(dialog).getByLabelText('Price id'), 'price_bad');
    await user.click(within(dialog).getByRole('button', { name: 'Preview proration' }));

    expect(await within(dialog).findByText('No such price')).toBeInTheDocument();
    expect(within(dialog).queryByText('Amount due now')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Apply plan change' })).toBeDisabled();
  });

  it('applies the plan change with the previewed field values and closes on success', async () => {
    let capturedBody: unknown = null;
    server.use(
      http.get(`${BASE_URL}/subscriptions/${SUB_ID}/preview`, () =>
        HttpResponse.json({ currency: 'usd', amount_due: 500, total: 500, lines: [] }),
      ),
      http.post(`${BASE_URL}/subscriptions/${SUB_ID}/plan`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ id: SUB_ID, status: 'active' });
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    const dialog = await openPlanModal(user);
    await user.type(within(dialog).getByLabelText('Price id'), 'price_pro');
    await user.click(within(dialog).getByRole('button', { name: 'Preview proration' }));
    await within(dialog).findByText('Amount due now');

    await user.click(within(dialog).getByRole('button', { name: 'Apply plan change' }));

    expect(capturedBody).toEqual({
      price_id: 'price_pro',
      quantity: 1,
      proration_behavior: 'create_prorations',
    });
    expect(await screen.findByText('Plan changed')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Change plan' })).not.toBeInTheDocument();
  });
});

describe('SubscriptionDetailPage stale preview after form edit', () => {
  it('clears an already-fetched preview and re-disables apply when quantity changes afterward', async () => {
    server.use(
      http.get(`${BASE_URL}/subscriptions/${SUB_ID}/preview`, () =>
        HttpResponse.json({ currency: 'usd', amount_due: 100, total: 100, lines: [] }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await waitForLoaded();

    await user.click(screen.getByRole('button', { name: 'Change plan' }));
    const dialog = screen.getByRole('dialog', { name: 'Change plan' });

    await user.type(within(dialog).getByLabelText('Price id'), 'price_pro');
    await user.click(within(dialog).getByRole('button', { name: 'Preview proration' }));
    await within(dialog).findByText('Amount due now');
    expect(within(dialog).getByRole('button', { name: 'Apply plan change' })).toBeEnabled();

    // Edit quantity WITHOUT re-clicking preview - the stale amount-due-100
    // preview (computed at quantity 1) must not survive this edit.
    const quantityInput = within(dialog).getByLabelText('Quantity');
    await user.clear(quantityInput);
    await user.type(quantityInput, '5');

    expect(within(dialog).queryByText('Amount due now')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Apply plan change' })).toBeDisabled();
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { SubscriptionsListPage } from '../../src/pages/SubscriptionsListPage';
import type { SubscriptionListRow } from '../../src/lib/types';
import { server } from '../mswServer';

const BASE_URL = 'http://localhost:3000';

function buildRow(overrides: Partial<SubscriptionListRow>): SubscriptionListRow {
  return {
    id: 'sub_default',
    status: 'active',
    planCode: 'pro_monthly',
    currency: 'usd',
    mrrMinor: 1900,
    hasTieredPricing: false,
    nextPeriodEndDerived: '2026-09-20T00:00:00.000Z',
    dunningStage: 0,
    customerEmail: 'default@example.com',
    customerExternalRef: null,
    ...overrides,
  };
}

const PAGE1_ROWS: SubscriptionListRow[] = [
  buildRow({ id: 'sub_page1_a', customerEmail: 'page1-a@example.com' }),
  buildRow({ id: 'sub_page1_b', customerEmail: 'page1-b@example.com' }),
];

const PAGE2_ROWS: SubscriptionListRow[] = [
  buildRow({ id: 'sub_page2_c', customerEmail: 'page2-c@example.com' }),
];

function renderPage() {
  return render(
    <MemoryRouter>
      <SubscriptionsListPage />
    </MemoryRouter>,
  );
}

describe('SubscriptionsListPage load more pagination', () => {
  it('appends page 2 rows to page 1 rows (does not replace them) and carries the active filters + cursor on the load-more request, hiding the button once nextCursor is null', async () => {
    let loadMoreUrl: URL | null = null;
    server.use(
      http.get(`${BASE_URL}/subscriptions`, ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get('cursor');
        if (!cursor) {
          // First page - no cursor yet. Hit on initial mount and again
          // whenever the filters change (status here).
          return HttpResponse.json({ subscriptions: PAGE1_ROWS, nextCursor: 'cursor-2' });
        }
        // Load-more page - capture the request so we can assert the
        // cursor and the active filters were both sent.
        loadMoreUrl = url;
        return HttpResponse.json({ subscriptions: PAGE2_ROWS, nextCursor: null });
      }),
    );

    const user = userEvent.setup();
    renderPage();

    // Initial render: page 1's rows are visible and a "Load more" button
    // is present because nextCursor was truthy.
    expect(await screen.findByText('page1-a@example.com')).toBeInTheDocument();
    expect(screen.getByText('page1-b@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();

    // Set a filter before clicking - it must be re-sent on every
    // subsequent request, including the load-more request.
    await user.selectOptions(screen.getByLabelText('Status'), 'active');
    // Selecting a status re-runs the initial-page effect (cursor-less
    // branch); wait for that refetch to settle before triggering load-more.
    expect(await screen.findByRole('button', { name: 'Load more' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    // Page 2's row appears...
    expect(await screen.findByText('page2-c@example.com')).toBeInTheDocument();
    // ...and page 1's rows are still there - APPENDED, not replaced.
    expect(screen.getByText('page1-a@example.com')).toBeInTheDocument();
    expect(screen.getByText('page1-b@example.com')).toBeInTheDocument();

    // The load-more request carried the cursor and the active status filter.
    expect(loadMoreUrl).not.toBeNull();
    expect(loadMoreUrl!.searchParams.get('cursor')).toBe('cursor-2');
    expect(loadMoreUrl!.searchParams.get('status')).toBe('active');
    expect(loadMoreUrl!.searchParams.get('limit')).toBe('25');

    // nextCursor came back null, so the button is gone.
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Loading…' })).not.toBeInTheDocument();
  });

  it('discards a stale load-more page that resolves after the filter changed, instead of mixing it into the new filter\'s rows', async () => {
    const ACTIVE_ROWS: SubscriptionListRow[] = [
      buildRow({ id: 'sub_active_a', status: 'active', customerEmail: 'active-a@example.com' }),
    ];
    let releaseLoadMore: () => void = () => {};
    const loadMoreGate = new Promise<void>((resolve) => {
      releaseLoadMore = resolve;
    });

    server.use(
      http.get(`${BASE_URL}/subscriptions`, async ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get('cursor');
        const statusParam = url.searchParams.get('status');
        if (!cursor) {
          // Cursor-less: either the initial (unfiltered) load, or the
          // refetch useAsyncData fires once the status filter changes.
          if (statusParam === 'active') {
            return HttpResponse.json({ subscriptions: ACTIVE_ROWS, nextCursor: null });
          }
          return HttpResponse.json({ subscriptions: PAGE1_ROWS, nextCursor: 'cursor-2' });
        }
        // The load-more page for the ORIGINAL (unfiltered) request - held
        // back until the filter change below has already landed, so it
        // arrives late on purpose, reproducing the out-of-order race.
        await loadMoreGate;
        return HttpResponse.json({ subscriptions: PAGE2_ROWS, nextCursor: null });
      }),
    );

    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('page1-a@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    // The load-more request is now in flight and gated on loadMoreGate.

    // Change the filter while that request is still pending - this fires
    // useAsyncData's own (unrelated, cursor-less) refetch, which resolves
    // immediately and replaces `rows` with the new filter's single row.
    await user.selectOptions(screen.getByLabelText('Status'), 'active');
    expect(await screen.findByText('active-a@example.com')).toBeInTheDocument();
    expect(screen.queryByText('page1-a@example.com')).not.toBeInTheDocument();

    // Now let the stale (pre-filter-change) load-more response land.
    releaseLoadMore();
    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Loading…' })).not.toBeInTheDocument();
    });

    // The stale page's row must never appear, and the new filter's row
    // must still be the only one shown - the stale response must not have
    // been appended on top of it.
    expect(screen.queryByText('page2-c@example.com')).not.toBeInTheDocument();
    expect(screen.getByText('active-a@example.com')).toBeInTheDocument();
  });
});

describe('tiered pricing indicator (finding #19, deep bug hunt)', () => {
  it('shows the tiered-pricing note next to MRR when hasTieredPricing is true, and hides it otherwise', async () => {
    server.use(
      http.get(`${BASE_URL}/subscriptions`, () =>
        HttpResponse.json({
          subscriptions: [
            buildRow({ id: 'sub_tiered', customerEmail: 'tiered@example.com', hasTieredPricing: true }),
            buildRow({ id: 'sub_flat', customerEmail: 'flat@example.com', hasTieredPricing: false }),
          ],
          nextCursor: null,
        }),
      ),
    );

    renderPage();

    expect(await screen.findByText('tiered@example.com')).toBeInTheDocument();
    expect(screen.getAllByText('tiered pricing excluded')).toHaveLength(1);
  });
});

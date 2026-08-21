import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAsyncData } from '../../src/lib/hooks';

// A slower, older fetch resolving after a newer one previously won any race
// against it - whichever response happened to land last silently became
// the hook's `data`, regardless of which request was actually the latest
// one the caller cared about. See the deep bug hunt.
describe('useAsyncData request-ordering guard', () => {
  it('does not let an older fetch (still in flight when deps change) overwrite state from the newer fetch that superseded it', async () => {
    let resolveFirst: (value: string) => void = () => {};
    const firstFetch = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    let callCount = 0;
    const fetchFn = vi.fn(() => {
      callCount += 1;
      return callCount === 1 ? firstFetch : Promise.resolve('second');
    });

    const { result, rerender } = renderHook(({ dep }) => useAsyncData(fetchFn, [dep]), {
      initialProps: { dep: 1 },
    });

    // The mount-time fetch (dep=1) is in flight and gated on firstFetch.
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // deps change before it resolves - this fires a second, independent
    // fetch that resolves immediately.
    rerender({ dep: 2 });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe('second');

    // Now let the stale first fetch resolve.
    await act(async () => {
      resolveFirst('first');
      await firstFetch;
    });

    // The stale 'first' response must not have overwritten the newer
    // 'second' one, and must not have flipped `loading` back to true either
    // (it settled after the newer request already finished).
    expect(result.current.data).toBe('second');
    expect(result.current.loading).toBe(false);
  });

  it('does not let a stale response from a superseded manual reload() overwrite the latest call\'s result', async () => {
    let resolveSecondCall: (value: string) => void = () => {};
    const secondCall = new Promise<string>((resolve) => {
      resolveSecondCall = resolve;
    });
    let callCount = 0;
    const fetchFn = vi.fn(() => {
      callCount += 1;
      // The mount-time call (#1) resolves immediately. Call #2 is gated;
      // call #3 (the reload that actually supersedes it) resolves
      // immediately too.
      if (callCount === 1) return Promise.resolve('initial');
      if (callCount === 2) return secondCall;
      return Promise.resolve('third');
    });

    const { result } = renderHook(() => useAsyncData(fetchFn, []));
    await waitFor(() => expect(result.current.data).toBe('initial'));

    // Fire two manual reload()s back to back without awaiting the first -
    // call #2 goes out and is gated; call #3 immediately supersedes it.
    act(() => {
      result.current.reload();
      result.current.reload();
    });
    await waitFor(() => expect(result.current.data).toBe('third'));

    // Let the superseded call #2 resolve late.
    await act(async () => {
      resolveSecondCall('second');
      await secondCall;
    });

    expect(result.current.data).toBe('third');
  });
});

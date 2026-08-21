import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

// Replaces the fetch/loading/error `useEffect` triple duplicated across
// every page (setLoading(true); setError(null); fetchFn().then(setData)
// .catch(err => setError(err.message)).finally(() => setLoading(false))).
// `deps` works the same way a useEffect/useCallback dependency array does -
// pass the values the fetch depends on (filters, ids, ...) so it re-runs
// when they change. See the /improve audit.
export function useAsyncData<T>(
  fetchFn: () => Promise<T>,
  deps: DependencyList,
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A slower, older fetch (e.g. the previous filter's request, still in
  // flight when the filter changes and fires a new one, or a manual
  // reload() called again before the first call resolves) can resolve
  // *after* a newer one. Without an ordering guard, whichever response
  // lands last wins the race and silently overwrites fresher state with
  // stale data - every caller of this hook inherits the bug at once.
  // Incrementing this on every reload() and only committing a response
  // whose id still matches the latest fired request discards exactly the
  // stale ones, regardless of arrival order. See the deep bug hunt.
  const requestIdRef = useRef(0);

  const reload = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    fetchFn()
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        setData(result);
      })
      .catch((err: Error) => {
        if (requestIdRef.current !== requestId) return;
        setError(err.message);
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) return;
        setLoading(false);
      });
    // fetchFn is intentionally excluded from the dependency array - callers
    // pass a fresh closure each render, and re-running only when the
    // caller's own `deps` change (not on every render) is the whole point
    // of this hook. (No react-hooks eslint plugin is configured in this
    // repo to flag this, so no disable comment is needed either.)
  }, deps);

  useEffect(reload, [reload]);

  return { data, loading, error, reload };
}

// Replaces the "set busy -> await action -> clear busy" skeleton duplicated
// across every mutation handler. `run` takes the action at call time
// (rather than binding one action to the hook up front) so a single `busy`
// flag can cover several different mutations from one page when that's the
// existing behavior - e.g. SubscriptionDetailPage disables every mutating
// button (change plan, cancel, resume) while any one of them is in flight,
// not just the one that was clicked. The caller's own action closure keeps
// its own try/catch/notify/side-effect logic (success message, error
// fallback text, and what to do afterward - close a modal, reload data -
// all differ per call site); this hook only owns the busy flag around it.
// See the /improve audit.
export function useAsyncAction(): { run: <T>(action: () => Promise<T>) => Promise<T>; busy: boolean } {
  const [busy, setBusy] = useState(false);

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    setBusy(true);
    try {
      return await action();
    } finally {
      setBusy(false);
    }
  }, []);

  return { run, busy };
}

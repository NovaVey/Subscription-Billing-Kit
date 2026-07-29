import { useState, type FormEvent, type ReactNode } from 'react';
import { getAdminKey, setAdminKey } from '../lib/adminKey';

// A shared-secret gate (Phase 10), not a real login form - there's no user
// account behind it, just a key typed once per browser tab and attached to
// every API call afterward (see lib/api.ts). Whether it's the read-only or
// write key isn't distinguished here; a mutating action sent with the
// read-only key comes back as a 403 from the API and surfaces through each
// page's existing error/toast handling like any other request failure.
export function AdminGate({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(() => getAdminKey() !== null);
  const [key, setKey] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    setAdminKey(key.trim());
    setAuthenticated(true);
  }

  if (authenticated) return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper text-ink">
      <form onSubmit={handleSubmit} className="w-full max-w-sm border border-rule p-6">
        <h1 className="mb-4 text-lg font-semibold tracking-tight">Billing Ledger</h1>
        <label htmlFor="admin-key" className="mb-1 block text-sm text-ink/60">
          Admin key
        </label>
        <input
          id="admin-key"
          type="password"
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="mb-4 w-full border border-rule bg-paper px-3 py-2 text-sm"
          placeholder="paste your read or write key"
        />
        <button
          type="submit"
          className="w-full border border-ink bg-ink px-3 py-2 text-sm font-medium text-paper hover:bg-ink/90"
        >
          Continue
        </button>
      </form>
    </div>
  );
}

import { NavLink, Outlet } from 'react-router-dom';

const NAV = [
  { to: '/subscriptions', label: 'Subscriptions' },
  { to: '/dunning', label: 'Dunning queue' },
  { to: '/invoices', label: 'Invoices' },
  { to: '/webhook-events', label: 'Webhook log' },
  { to: '/reconciliation', label: 'Reconciliation' },
];

export function Layout() {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="border-b border-rule">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-5 sm:flex-row sm:items-baseline sm:justify-between">
          <span className="text-lg font-semibold tracking-tight">Billing Ledger</span>
          <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `border-b pb-0.5 ${isActive ? 'border-ink text-ink' : 'border-transparent text-ink/60 hover:text-ink'}`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}

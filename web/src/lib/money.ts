// Display-only mirror of api/src/lib/money.ts's zero-decimal set. This is
// the frontend's single money-formatting module - every amount in the UI
// routes through formatMoney rather than dividing by 100 inline, for the
// same reason the API's money.ts exists: JPY/KRW/VND and others are
// zero-decimal, and dividing them by 100 undercharges the display by 100x.
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
]);

export function formatMoney(amountMinor: number, currency: string): string {
  const cur = currency.toLowerCase();
  const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.has(cur);
  const display = isZeroDecimal ? amountMinor : amountMinor / 100;
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: isZeroDecimal ? 0 : 2,
    maximumFractionDigits: isZeroDecimal ? 0 : 2,
  }).format(display);
  return `${cur.toUpperCase()} ${formatted}`;
}

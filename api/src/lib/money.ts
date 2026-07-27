export interface Money {
  amountMinor: number;
  currency: string;
}

// Stripe's zero-decimal currencies: the API amount already IS the whole
// currency unit — never multiply or divide by 100 for these. Verified
// against Stripe's currencies reference (docs.stripe.com/currencies), not
// recalled from memory, per docs/ARCHITECTURE.md's rule on Stripe fields.
//
// UGX (Ugandan Shilling) is deliberately excluded even though it
// conceptually became a zero-decimal currency: Stripe kept its API amounts
// two-decimal for backward compatibility (the decimal digits are always
// "00" — see Stripe's "Special cases" currency notes). ISK has the same
// carve-out and was never zero-decimal for API purposes to begin with.
// Treating UGX as zero-decimal here would undercharge by 100x — exactly
// the class of bug this module exists to prevent, just pointed the other
// direction. (HUF and TWD have a related but distinct zero-decimal-style
// rounding rule that applies only to manual payouts, not charges — this
// app never issues payouts, so they stay ordinary two-decimal currencies
// here.)
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

function normalizeCurrency(currency: string): string {
  return currency.toLowerCase();
}

export function isZeroDecimalCurrency(currency: string): boolean {
  return ZERO_DECIMAL_CURRENCIES.has(normalizeCurrency(currency));
}

// Converts a human/display amount (e.g. 19.99) into Stripe minor units
// (1999). For zero-decimal currencies the display amount already IS the
// minor amount (e.g. 500 JPY -> 500), so no scaling happens.
export function toMinor(displayAmount: number, currency: string): number {
  const scale = isZeroDecimalCurrency(currency) ? 1 : 100;
  return Math.round(displayAmount * scale);
}

// Converts Stripe minor units back into a display amount. For zero-decimal
// currencies this is the identity operation.
export function toDisplay(amountMinor: number, currency: string): number {
  const scale = isZeroDecimalCurrency(currency) ? 1 : 100;
  return amountMinor / scale;
}

// Sums same-currency Money values. Throws rather than coercing when
// currencies differ — there is no single correct answer to "$5 + ¥500",
// and silently picking one hides the bug instead of surfacing it.
export function addSameCurrency(amounts: readonly Money[]): Money {
  if (amounts.length === 0) {
    throw new Error('addSameCurrency: cannot sum an empty list — no currency to report');
  }
  const currency = normalizeCurrency(amounts[0]!.currency);
  let total = 0;
  for (const money of amounts) {
    if (normalizeCurrency(money.currency) !== currency) {
      throw new Error(
        `addSameCurrency: mixed currencies (${currency} vs ${normalizeCurrency(money.currency)}) — totals must stay per-currency`,
      );
    }
    total += money.amountMinor;
  }
  return { amountMinor: total, currency };
}

// Stripe timestamps (event.created, subscription.trial_end, invoice fields,
// etc.) are Unix seconds, not milliseconds. A 1000x mixup here produces
// dates in the year 55000 — loud, at least, but only if every call site
// goes through here instead of doing `new Date(x)` or `x * 1000` by hand.

export function fromStripeSeconds(seconds: number): Date {
  return new Date(seconds * 1000);
}

export function toStripeSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

// Many Stripe fields are `number | null` (trial_end, canceled_at, next_payment_attempt, ...).
export function fromStripeSecondsOrNull(seconds: number | null | undefined): Date | null {
  return seconds == null ? null : fromStripeSeconds(seconds);
}

export function toStripeSecondsOrNull(date: Date | null | undefined): number | null {
  return date == null ? null : toStripeSeconds(date);
}

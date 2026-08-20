// Unwraps a Stripe reference field, which can be a bare id string, an
// expanded object carrying an `id`, or absent entirely - the shape fields
// like `invoice.customer` or `invoicePayment.invoice` take depending on
// whether the reference was expanded. Shared by the invoice and
// paymentIntent webhook handlers (previously duplicated verbatim in both).
// See stripe/sync.ts's resolveStripeId for the non-nullable variant used
// when the caller already knows the field is present.
export function resolveId(ref: string | { id: string } | null | undefined): string | undefined {
  if (!ref) return undefined;
  return typeof ref === 'string' ? ref : ref.id;
}

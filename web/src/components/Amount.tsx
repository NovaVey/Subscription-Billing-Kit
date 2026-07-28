import { formatMoney } from '../lib/money';

// Every amount in the app renders through this - right-aligned,
// decimal-aligned, tabular-figure monospace (§7).
export function Amount({ minor, currency, className = '' }: { minor: number; currency: string; className?: string }) {
  return <span className={`num text-right tabular-nums ${className}`}>{formatMoney(minor, currency)}</span>;
}

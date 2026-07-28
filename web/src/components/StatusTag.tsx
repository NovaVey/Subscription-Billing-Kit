const ALERT_STATUSES = new Set([
  'past_due',
  'unpaid',
  'canceled',
  'incomplete_expired',
  'failed',
  'field_drift',
  'missing_local',
  'orphan_local',
]);

const SETTLED_STATUSES = new Set(['active', 'paid', 'processed', 'recovered', 'succeeded', 'received']);

export type Tone = 'alert' | 'settled' | 'neutral';

export function statusTone(status: string): Tone {
  if (ALERT_STATUSES.has(status)) return 'alert';
  if (SETTLED_STATUSES.has(status)) return 'settled';
  return 'neutral';
}

const TONE_CLASSES: Record<Tone, string> = {
  alert: 'border-alert text-alert',
  settled: 'border-settled text-settled',
  neutral: 'border-ink/40 text-ink',
};

// Row status expressed as a short word plus a color rule (§7) - explicitly
// not a rounded chip/pill.
export function StatusTag({ status, tone }: { status: string; tone?: Tone }) {
  const resolvedTone = tone ?? statusTone(status);
  return (
    <span
      className={`inline-block border-l-2 pl-2 text-xs uppercase tracking-wide ${TONE_CLASSES[resolvedTone]}`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

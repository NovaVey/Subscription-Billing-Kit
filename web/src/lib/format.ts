// Bank-statement timestamp format from §7's signature event timeline
// example: "2026-03-04 14:02:11". Every timestamp in the app uses this,
// not a locale-formatted or relative string, so entries stay
// decimal-aligned in the monospace columns they render in.
export function formatTimestamp(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

export function formatDateOnly(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function truncateId(id: string | null | undefined, keep = 14): string {
  if (!id) return '—';
  return id.length > keep ? `${id.slice(0, keep)}…` : id;
}

// Empty states say what to do next; errors say what happened and how to
// fix it (§7).
export function EmptyState({ message }: { message: string }) {
  return <p className="border border-dashed border-rule px-4 py-8 text-center text-sm text-ink/60">{message}</p>;
}

export function ErrorState({ message }: { message: string }) {
  return (
    <p className="border-l-2 border-alert bg-alert/5 px-4 py-3 text-sm text-alert" role="alert">
      {message}
    </p>
  );
}

export function LoadingState() {
  return <p className="px-4 py-8 text-center text-sm text-ink/60">Loading…</p>;
}

import type { ReactNode } from 'react';

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-lg border border-rule bg-paper p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-ink/60 hover:text-ink"
            aria-label="Close"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

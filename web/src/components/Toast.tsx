import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface ToastMessage {
  id: number;
  text: string;
  tone: 'settled' | 'alert';
}

interface ToastContextValue {
  notify: (text: string, tone?: 'settled' | 'alert') => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 1;

// Buttons name the action, and the toast repeats that exact word (§7) - so
// every mutating call site passes the same verb it showed on the button.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([]);

  const notify = useCallback((text: string, tone: 'settled' | 'alert' = 'settled') => {
    const id = nextId++;
    setMessages((prev) => [...prev, { id, text, tone }]);
    setTimeout(() => {
      setMessages((prev) => prev.filter((m) => m.id !== id));
    }, 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {messages.map((m) => (
          <div
            key={m.id}
            role="status"
            className={`border-l-2 bg-ink px-4 py-2 text-sm text-paper ${
              m.tone === 'alert' ? 'border-alert' : 'border-settled'
            }`}
          >
            {m.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}

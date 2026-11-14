import React from 'react';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastEntry {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastProps {
  toasts: ToastEntry[];
  onDismiss: (id: number) => void;
  maxVisible?: number;
}

/**
 * UX-01: tek mesajlık toast yerine kuyruk. "Kaydedildi" ile "senkron başarısız"
 * birbirini ezmez; hata kalıcı olarak işaretlenir (role="alert") ve elle kapatılabilir.
 */
export const Toast: React.FC<ToastProps> = ({ toasts, onDismiss, maxVisible = 4 }) => {
  if (toasts.length === 0) return null;
  const visible = toasts.slice(-maxVisible);

  return (
    <div id="toast" className="toast-stack" role="region" aria-label="Bildirimler">
      {visible.map((toast) => {
        const isError = toast.kind === 'error';
        return (
          <div
            key={toast.id}
            className={`toast-item toast-item-${toast.kind}`}
            role={isError ? 'alert' : 'status'}
            aria-live={isError ? 'assertive' : 'polite'}
          >
            <span className="toast-item-text">{toast.message}</span>
            <button
              type="button"
              className="toast-dismiss"
              aria-label="Bildirimi kapat"
              onClick={() => onDismiss(toast.id)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
};

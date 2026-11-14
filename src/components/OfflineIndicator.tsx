import React from 'react';
import { t } from '../i18n/index.ts';

interface OfflineIndicatorProps {
  isOnline: boolean;
  pendingSync: boolean;
  unpersistedWarning?: boolean;
  /** SEC-04: art arda başarısız gönderim sayısı ve tükenme durumu. */
  queueFailure?: { attempts: number; exhausted: boolean } | null;
  maxQueueAttempts?: number;
}

export const OfflineIndicator: React.FC<OfflineIndicatorProps> = ({
  isOnline,
  pendingSync,
  unpersistedWarning = false,
  queueFailure = null,
  maxQueueAttempts = 5,
}) => {
  const dict = t();

  if (isOnline && !pendingSync && !unpersistedWarning && !queueFailure) {
    return null;
  }

  const failureExhausted = Boolean(queueFailure?.exhausted);
  const severity = unpersistedWarning || failureExhausted ? 'alert' : 'status';

  const message = unpersistedWarning
    ? dict.offlineQuotaWarning
    : queueFailure
      ? failureExhausted
        ? `Değişiklikler ${maxQueueAttempts} denemede gönderilemedi. Yerel kayıt korunuyor; bağlantı düzelince "Yeniden dene" ile gönderin.`
        : `Değişiklikler gönderilemedi (${queueFailure.attempts}/${maxQueueAttempts}). Otomatik olarak yeniden denenecek.`
      : !isOnline
        ? dict.offlineBanner
        : dict.offlinePendingSync;

  return (
    <div className="offline-indicator-banner" role={severity} aria-live={severity === 'alert' ? 'assertive' : 'polite'}>
      <span className="offline-indicator-text">{message}</span>
      {queueFailure && (
        <button
          type="button"
          className="offline-indicator-retry"
          onClick={() => window.dispatchEvent(new CustomEvent('cinetrack:force-flush-queue'))}
        >
          Yeniden dene
        </button>
      )}
    </div>
  );
};

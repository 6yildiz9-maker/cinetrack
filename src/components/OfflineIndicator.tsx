import React from 'react';
import { t } from '../i18n';

interface OfflineIndicatorProps {
  isOnline: boolean;
  pendingSync: boolean;
  unpersistedWarning?: boolean;
}

export const OfflineIndicator: React.FC<OfflineIndicatorProps> = ({
  isOnline,
  pendingSync,
  unpersistedWarning = false,
}) => {
  const dict = t();

  if (isOnline && !pendingSync && !unpersistedWarning) {
    return null;
  }

  const message = unpersistedWarning
    ? dict.offlineQuotaWarning
    : !isOnline
      ? dict.offlineBanner
      : dict.offlinePendingSync;

  return (
    <div
      className="offline-indicator-banner"
      role={unpersistedWarning ? 'alert' : 'status'}
      aria-live={unpersistedWarning ? 'assertive' : 'polite'}
    >
      <span className="offline-indicator-text">{message}</span>
    </div>
  );
};

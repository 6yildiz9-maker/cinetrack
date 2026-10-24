import React from 'react';
import { t } from '../i18n';

interface OfflineIndicatorProps {
  isOnline: boolean;
  pendingSync: boolean;
}

export const OfflineIndicator: React.FC<OfflineIndicatorProps> = ({ isOnline, pendingSync }) => {
  const dict = t();

  if (isOnline && !pendingSync) {
    return null;
  }

  return (
    <div className="offline-indicator-banner" role="status" aria-live="polite">
      <span className="offline-indicator-text">
        {!isOnline ? dict.offlineBanner : dict.offlinePendingSync}
      </span>
    </div>
  );
};

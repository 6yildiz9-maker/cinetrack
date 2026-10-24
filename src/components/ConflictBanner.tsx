import React from 'react';
import { type ServerConflictDetail } from '../services/api';
import { t } from '../i18n';

interface ConflictBannerProps {
  conflict: ServerConflictDetail | null;
  onKeepLocal: () => void;
  onUseServer: () => void;
  onDismiss: () => void;
}

export const ConflictBanner: React.FC<ConflictBannerProps> = ({
  conflict,
  onKeepLocal,
  onUseServer,
  onDismiss,
}) => {
  const dict = t();
  if (!conflict) return null;

  return (
    <div className="conflict-banner" role="alert">
      <div className="conflict-banner-body">
        <strong className="conflict-banner-title">{dict.conflictTitle}:</strong>{' '}
        <span>{conflict.message}</span>
      </div>
      <div className="conflict-banner-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={onKeepLocal}>
          {dict.keepLocalButton}
        </button>
        {conflict.serverDocument && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onUseServer}>
            {dict.useServerButton}
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss} aria-label="Uyarısı kapat">
          Kapat
        </button>
      </div>
    </div>
  );
};

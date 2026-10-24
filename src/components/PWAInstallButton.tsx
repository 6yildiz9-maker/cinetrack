import React, { useState } from 'react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { t } from '../i18n';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const dict = t();

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className="btn btn-secondary pwa-install-btn"
        title={dict.installApp}
        aria-label={dict.installApp}
      >
        <svg className="icon" aria-hidden="true">
          <use href="#icon-download" />
        </svg>
        <span className="pwa-install-label">{dict.installApp}</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="btn btn-secondary pwa-install-btn"
          title={dict.installIos}
          aria-label={dict.installIos}
        >
          <svg className="icon" aria-hidden="true">
            <use href="#icon-download" />
          </svg>
          <span className="pwa-install-label">{dict.installIos}</span>
        </button>

        {showIOSGuide && (
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="ios-pwa-title">
            <div className="modal-panel pwa-ios-modal">
              <div className="modal-header">
                <h3 id="ios-pwa-title">iPhone / iPad Ana Ekran Kurulumu</h3>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Kapat"
                >
                  <svg className="icon" aria-hidden="true">
                    <use href="#icon-close" />
                  </svg>
                </button>
              </div>
              <div className="pwa-ios-steps">
                <p>1. Safari araç çubuğundaki <strong>Paylaş</strong> düğmesine dokunun.</p>
                <p>2. Menüde aşağı kaydırıp <strong>Ana Ekrana Ekle</strong> seçeneğini seçin.</p>
              </div>
              <div className="modal-footer-actions">
                <button type="button" className="btn btn-primary" onClick={() => setShowIOSGuide(false)}>
                  Anladım
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

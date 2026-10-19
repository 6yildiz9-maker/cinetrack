import React, { useState } from 'react';

interface ImportChoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (mode: 'overwrite' | 'merge') => void;
}

export const ImportChoiceModal: React.FC<ImportChoiceModalProps> = ({ isOpen, onClose, onConfirm }) => {
  const [mode, setMode] = useState<'overwrite' | 'merge'>('overwrite');

  if (!isOpen) return null;

  return (
    <div
      id="importChoiceModal"
      className="modal-wrap open"
      aria-hidden="false"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <article
        className="modal import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="importChoiceTitle"
        tabIndex={-1}
      >
        <button
          className="modal-close"
          type="button"
          onClick={onClose}
          aria-label="İçe aktarmayı iptal et"
        >
          <svg className="icon" aria-hidden="true">
            <use href="#icon-close"></use>
          </svg>
        </button>

        <div className="custom-form">
          <div>
            <h2 id="importChoiceTitle" className="detail-title">
              Yedek içe aktarma
            </h2>
            <p className="detail-meta">
              Bu içe aktarmada mevcut listeyi nasıl kullanmak istersiniz?
            </p>
          </div>

          <label className="choice-option">
            <input
              type="radio"
              name="importMode"
              value="overwrite"
              checked={mode === 'overwrite'}
              onChange={() => setMode('overwrite')}
            />{' '}
            Mevcut listenin üzerine yaz
          </label>

          <label className="choice-option">
            <input
              type="radio"
              name="importMode"
              value="merge"
              checked={mode === 'merge'}
              onChange={() => setMode('merge')}
            />{' '}
            Mevcut liste ile birleştir
          </label>

          <div className="detail-actions">
            <button
              id="confirmImportButton"
              className="btn btn-primary"
              type="button"
              onClick={() => onConfirm(mode)}
            >
              İçe aktar
            </button>
            <button id="cancelImportButton" className="btn" type="button" onClick={onClose}>
              İptal
            </button>
          </div>
        </div>
      </article>
    </div>
  );
};

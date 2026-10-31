import React, { useState, useEffect } from 'react';
import { displayTitle, formatMediaDates, getPoster, handleImageError } from '../utils/helpers';
import { SavedItem } from '../core/cinetrack-core';
import { useDialogAccessibility } from '../utils/useDialogAccessibility';

interface QuickSaveModalProps {
  item: any | null;
  savedItem?: SavedItem;
  isOpen: boolean;
  onClose: () => void;
  onSave: (
    item: any,
    status: 'watching' | 'watchlist' | 'completed',
    rating: number | ''
  ) => void;
  onRemove: (item: any) => void;
}

export const QuickSaveModal: React.FC<QuickSaveModalProps> = ({
  item,
  savedItem,
  isOpen,
  onClose,
  onSave,
  onRemove,
}) => {
  const [selectedStatus, setSelectedStatus] = useState<'watching' | 'watchlist' | 'completed'>('watchlist');
  const [personalRating, setPersonalRating] = useState<number | ''>('');
  const dialogRef = useDialogAccessibility(isOpen, onClose);

  useEffect(() => {
    if (item && isOpen) {
      setSelectedStatus(savedItem?.status || 'watchlist');
      setPersonalRating(
        savedItem && savedItem.personal_rating !== '' && Number(savedItem.personal_rating) > 0
          ? Number(savedItem.personal_rating)
          : ''
      );
    }
  }, [item, isOpen, savedItem]);

  if (!isOpen || !item) return null;

  const title = displayTitle(item);
  const poster = getPoster(item);
  const dates = formatMediaDates(item, savedItem);
  const kind = item.media_type === 'tv' ? 'Dizi' : 'Film';
  const ratingText = personalRating ? `${personalRating}/10` : 'Puan verilmedi';

  const handleSave = () => {
    const effectiveStatus =
      typeof personalRating === 'number' && personalRating > 0 && selectedStatus === 'watchlist'
        ? 'completed'
        : selectedStatus;
    onSave(item, effectiveStatus, personalRating);
    onClose();
  };

  const handleRemove = () => {
    onRemove(item);
    onClose();
  };

  return (
    <div
      id="quickSaveModal"
      className="modal-wrap open"
      aria-hidden="false"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <article
        ref={dialogRef}
        className="modal quick-save-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quickSaveTitle"
        tabIndex={-1}
      >
        <button className="modal-close" type="button" onClick={onClose} aria-label="Kapat">
          <svg className="icon" aria-hidden="true">
            <use href="#icon-close"></use>
          </svg>
        </button>

        <div className="quick-save-content">
          <div className="quick-save-header">
            {poster && (
              <img
                id="quickSavePoster"
                className="quick-save-thumb"
                src={poster}
                alt=""
                referrerPolicy="no-referrer"
                onError={(e) => handleImageError(e, poster, 'w185')}
              />
            )}
            <div className="quick-save-info">
              <span id="quickSaveBadge" className="badge-mini">
                {kind}
              </span>
              <h2 id="quickSaveTitle" className="quick-save-title">
                {title}
              </h2>
              <div id="quickSaveMeta" className="quick-save-meta">
                {dates}
                {item.vote_average ? ` · ⭐ ${Number(item.vote_average).toFixed(1)}` : ''}
              </div>
            </div>
          </div>

          <div className="quick-save-body">
            <label className="quick-save-label">İzleme Durumu</label>
            <div className="quick-status-grid" id="quickStatusGrid">
              <button
                type="button"
                className={`quick-status-opt ${selectedStatus === 'watchlist' ? 'active' : ''}`}
                onClick={() => setSelectedStatus('watchlist')}
              >
                <span className="status-opt-icon">📌</span>
                <div className="status-opt-text">
                  <strong>İzlenecek</strong>
                  <small>Daha sonra izlemek için listene ekle</small>
                </div>
              </button>

              <button
                type="button"
                className={`quick-status-opt ${selectedStatus === 'watching' ? 'active' : ''}`}
                onClick={() => setSelectedStatus('watching')}
              >
                <span className="status-opt-icon">▶️</span>
                <div className="status-opt-text">
                  <strong>İzliyorum</strong>
                  <small>Şu anda takip ettiğin yapım</small>
                </div>
              </button>

              <button
                type="button"
                className={`quick-status-opt ${selectedStatus === 'completed' ? 'active' : ''}`}
                onClick={() => setSelectedStatus('completed')}
              >
                <span className="status-opt-icon">✅</span>
                <div className="status-opt-text">
                  <strong>Tamamlandı</strong>
                  <small>İzlemeyi bitirdin</small>
                </div>
              </button>
            </div>

            <div id="quickSaveRatingWrap" style={{ marginTop: '14px' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '6px',
                }}
              >
                <span style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 700 }}>
                  Kişisel Puanınız (İsteğe bağlı)
                </span>
                <span
                  id="quickRatingScoreText"
                  style={{ fontSize: '11px', color: '#fbbf24', fontWeight: 800 }}
                >
                  {ratingText}
                </span>
              </div>
              <div id="quickStarRating" className="stars" role="radiogroup" aria-label="Hızlı puanlama">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((star) => (
                  <button
                    key={star}
                    type="button"
                    className={`star-button quick-star-btn ${
                      personalRating && star <= personalRating ? 'is-selected' : ''
                    }`}
                    onClick={() => {
                      setPersonalRating(star);
                      if (selectedStatus === 'watchlist') {
                        setSelectedStatus('completed');
                      }
                    }}
                  >
                    {star}
                  </button>
                ))}
                <button
                  id="clearQuickRating"
                  className="star-clear"
                  type="button"
                  onClick={() => setPersonalRating('')}
                >
                  Temizle
                </button>
              </div>
            </div>
          </div>

          <div className="quick-save-footer">
            {savedItem && (
              <button
                id="quickSaveRemove"
                className="btn btn-danger"
                type="button"
                onClick={handleRemove}
              >
                Listeden Kaldır
              </button>
            )}
            <button className="btn" type="button" onClick={onClose}>
              İptal
            </button>
            <button
              id="quickSaveSubmit"
              className="btn btn-primary"
              type="button"
              onClick={handleSave}
            >
              {savedItem ? 'Değişiklikleri Kaydet' : 'Kaydet'}
            </button>
          </div>
        </div>
      </article>
    </div>
  );
};

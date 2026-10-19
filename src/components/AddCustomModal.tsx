import React, { useState } from 'react';

interface AddCustomModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (item: any, status: 'watching' | 'watchlist' | 'completed') => void;
}

export const AddCustomModal: React.FC<AddCustomModalProps> = ({ isOpen, onClose, onAdd }) => {
  const [title, setTitle] = useState('');
  const [mediaType, setMediaType] = useState<'movie' | 'tv'>('movie');
  const [year, setYear] = useState('');
  const [rating, setRating] = useState('');
  const [poster, setPoster] = useState('');
  const [status, setStatus] = useState<'watching' | 'watchlist' | 'completed'>('watchlist');
  const [errorMsg, setErrorMsg] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) return;

    let posterUrl = '';
    const cleanPoster = poster.trim();
    if (cleanPoster) {
      try {
        const parsed = new URL(cleanPoster);
        if (parsed.protocol !== 'https:') {
          setErrorMsg('Poster adresi HTTPS olmalı.');
          return;
        }
        posterUrl = parsed.href;
      } catch {
        setErrorMsg('Geçerli bir HTTPS poster adresi girin.');
        return;
      }
    }

    const newItem = {
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      media_type: mediaType,
      title: cleanTitle,
      release_date: year ? `${year}-01-01` : '',
      vote_average: rating ? Number(rating) : 0,
      poster_url: posterUrl,
      genre_ids: [],
      overview: '',
      custom: true,
    };

    onAdd(newItem, status);
    setTitle('');
    setYear('');
    setRating('');
    setPoster('');
    setErrorMsg('');
    onClose();
  };

  return (
    <div
      id="addModal"
      className="modal-wrap open"
      aria-hidden="false"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <article
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="addModalTitle"
        tabIndex={-1}
      >
        <button className="modal-close" type="button" onClick={onClose} aria-label="Kapat">
          <svg className="icon" aria-hidden="true">
            <use href="#icon-close"></use>
          </svg>
        </button>

        <form id="customForm" className="custom-form" onSubmit={handleSubmit}>
          <div>
            <h2 id="addModalTitle" className="detail-title" style={{ marginBottom: '5px' }}>
              Özel içerik ekle
            </h2>
            <div className="detail-meta">
              TMDB kataloğunda bulamadığınız içeriği listenize ekleyin.
            </div>
          </div>

          <label>
            Başlık
            <input
              id="customTitle"
              className="field"
              type="text"
              required
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Örn. The Matrix"
            />
          </label>

          <div className="custom-fields">
            <label>
              İçerik türü
              <select
                id="customType"
                value={mediaType}
                onChange={(e) => setMediaType(e.target.value as any)}
              >
                <option value="movie">Film</option>
                <option value="tv">Dizi</option>
              </select>
            </label>
            <label>
              Yıl
              <input
                id="customYear"
                className="field"
                type="number"
                min="1888"
                max="2100"
                value={year}
                onChange={(e) => setYear(e.target.value)}
                placeholder="2026"
              />
            </label>
          </div>

          <div className="custom-fields">
            <label>
              TMDB puanı
              <input
                id="customRating"
                className="field"
                type="number"
                min="0"
                max="10"
                step="0.1"
                value={rating}
                onChange={(e) => setRating(e.target.value)}
                placeholder="Puan isteğe bağlı"
              />
            </label>
            <label>
              Poster URL
              <input
                id="customPoster"
                className="field"
                type="url"
                value={poster}
                onChange={(e) => {
                  setPoster(e.target.value);
                  setErrorMsg('');
                }}
                placeholder="https://..."
              />
            </label>
          </div>

          {errorMsg && (
            <p style={{ color: '#fb7185', fontSize: '12px', margin: '0 0 10px' }}>{errorMsg}</p>
          )}

          <label>
            İzleme durumu
            <select
              id="customStatus"
              value={status}
              onChange={(e) => setStatus(e.target.value as any)}
            >
              <option value="watchlist">İzlenecek</option>
              <option value="watching">İzliyorum</option>
              <option value="completed">Tamamlandı</option>
            </select>
          </label>

          <button className="btn btn-primary" type="submit">
            Listeme ekle
          </button>
        </form>
      </article>
    </div>
  );
};

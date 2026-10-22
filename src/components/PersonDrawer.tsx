import React, { useState, useEffect } from 'react';
import { displayTitle, formatMediaDates, imageUrl } from '../utils/helpers';
import { SavedItem, findSavedItem, makeMediaKey } from '../core/cinetrack-core';
import { fetchTmdb } from '../services/api';
import { useDialogAccessibility } from '../utils/useDialogAccessibility';

interface PersonDrawerProps {
  personId: number | null;
  personName: string;
  isOpen: boolean;
  savedItems: SavedItem[];
  isFavoriteActor?: boolean;
  onClose: () => void;
  onOpenDetails: (item: any) => void;
  onQuickAdd: (item: any) => void;
  onMarkCompleted: (item: any) => void;
  onQuickSave: (item: any) => void;
  onToggleFavoriteActor?: (actor: any) => void;
}

export const PersonDrawer: React.FC<PersonDrawerProps> = ({
  personId,
  personName,
  isOpen,
  savedItems,
  isFavoriteActor = false,
  onClose,
  onOpenDetails,
  onQuickAdd,
  onMarkCompleted,
  onQuickSave,
  onToggleFavoriteActor,
}) => {
  const [profile, setProfile] = useState<any>(null);
  const [credits, setCredits] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const dialogRef = useDialogAccessibility(isOpen && Boolean(personId), onClose);

  useEffect(() => {
    if (!personId || !isOpen) {
      setProfile(null);
      setCredits([]);
      return;
    }

    setLoading(true);
    let active = true;

    Promise.allSettled([
      fetchTmdb(`/person/${personId}`),
      fetchTmdb(`/person/${personId}/combined_credits`),
    ]).then(async ([profileRes, creditsRes]) => {
      if (!active) return;
      let prof = profileRes.status === 'fulfilled' ? profileRes.value : null;
      let cred = creditsRes.status === 'fulfilled' ? creditsRes.value : null;

      // Turkish fallback to English if bio or cast is empty
      if (!prof?.biography) {
        try {
          prof = await fetchTmdb(`/person/${personId}`, { language: 'en-US' });
        } catch {}
      }
      if (!cred?.cast?.length) {
        try {
          cred = await fetchTmdb(`/person/${personId}/combined_credits`, { language: 'en-US' });
        } catch {}
      }

      if (!active) return;
      setProfile(prof);
      setCredits(cred?.cast || []);
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [personId, isOpen]);

  if (!isOpen || !personId) return null;

  const movies = credits
    .filter((c) => c.media_type === 'movie' && (c.title || c.name))
    .sort((a, b) => Number(b.popularity || 0) - Number(a.popularity || 0))
    .filter((item, index, list) => list.findIndex((e) => e.id === item.id) === index)
    .slice(0, 16);

  const shows = credits
    .filter((c) => c.media_type === 'tv' && (c.title || c.name))
    .sort((a, b) => Number(b.popularity || 0) - Number(a.popularity || 0))
    .filter((item, index, list) => list.findIndex((e) => e.id === item.id) === index)
    .slice(0, 16);

  const getSaved = (item: any) => findSavedItem(savedItems, item);

  const renderCreditsList = (list: any[], mediaType: 'movie' | 'tv') => {
    if (list.length === 0) {
      return <p className="person-bio">Bu kategoride yapım bulunamadı.</p>;
    }

    return list.map((item) => {
      const fullItem = { ...item, media_type: mediaType };
      const saved = getSaved(fullItem);
      const title = displayTitle(fullItem);
      const dateStr = formatMediaDates(fullItem, saved);
      const poster = imageUrl(item.poster_path, 'w185');
      const rating = Number(item.vote_average || 0);

      const stateLabel =
        saved?.status === 'completed'
          ? 'Tamamlandı'
          : saved?.status === 'watching'
          ? 'İzliyorum'
          : saved?.status === 'watchlist'
          ? 'Listemde'
          : '';
      const stateIcon =
        saved?.status === 'completed' ? 'icon-check' : saved?.status === 'watching' ? 'icon-play' : 'icon-plus';

      return (
        <article
          key={makeMediaKey(mediaType, item.id)}
          className="person-credit"
          role="button"
          tabIndex={0}
          title={`${title} detaylarını gör`}
          onClick={() => {
            onClose();
            onOpenDetails(fullItem);
          }}
        >
          {poster ? (
            <img src={poster} alt="" loading="lazy" onError={(e) => ((e.target as HTMLElement).hidden = true)} />
          ) : (
            <span className="person-credit-fallback" aria-hidden="true">
              <svg className="icon">
                <use href="#icon-film"></use>
              </svg>
            </span>
          )}

          <div className="person-credit-copy">
            <strong>{title}</strong>
            <span>
              {dateStr}
              {item.character ? ` · ${item.character}` : ''}
            </span>
            {rating > 0 && (
              <span className="credit-rating">
                <svg className="icon">
                  <use href="#icon-star"></use>
                </svg>
                {rating.toFixed(1)}
              </span>
            )}
            {stateLabel && saved && (
              <small className={`credit-state status-${saved.status}`}>
                <svg className="icon" aria-hidden="true">
                  <use href={`#${stateIcon}`}></use>
                </svg>
                {stateLabel}
              </small>
            )}
          </div>

          <div className="credit-actions" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={`credit-action-btn credit-action-watchlist ${saved?.status === 'watchlist' ? 'is-active' : ''}`}
              aria-label={saved?.status === 'watchlist' ? `${title} izlenecekler listesinde (Düzenle)` : `${title} izleneceklere ekle`}
              title={saved?.status === 'watchlist' ? 'İzlenecekler listesinde (Düzenle)' : 'İzlenecekler listesine doğrudan ekle (+)'}
              onClick={() => {
                if (saved?.status === 'watchlist') {
                  onQuickSave(fullItem);
                } else {
                  onQuickAdd(fullItem);
                }
              }}
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-plus"></use>
              </svg>
            </button>

            <button
              type="button"
              className={`credit-action-btn credit-action-completed ${saved?.status === 'completed' ? 'is-active' : ''}`}
              aria-label={saved?.status === 'completed' ? `${title} izlendi olarak kayıtlı (Düzenle)` : `${title} izlendi olarak işaretle`}
              title={saved?.status === 'completed' ? 'İzlendi olarak kayıtlı (Düzenle)' : 'İzlendi listesine doğrudan ekle (✓)'}
              onClick={() => {
                if (saved?.status === 'completed') {
                  onQuickSave(fullItem);
                } else {
                  onMarkCompleted(fullItem);
                }
              }}
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-check"></use>
              </svg>
            </button>
          </div>
        </article>
      );
    });
  };

  return (
    <div id="personPanel" className="person-panel open" aria-hidden="false">
      <button
        className="person-scrim"
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      ></button>
      <section
        ref={dialogRef}
        className="person-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="personPanelTitle"
        aria-describedby="personBio"
        tabIndex={-1}
      >
        <header className="person-drawer-head">
          <div className="person-drawer-head-actor">
            {profile?.profile_path ? (
              <img
                src={imageUrl(profile.profile_path, 'w185')}
                alt=""
                className="person-drawer-avatar"
              />
            ) : (
              <div className="person-drawer-avatar fallback">
                <svg className="icon" aria-hidden="true">
                  <use href="#icon-user"></use>
                </svg>
              </div>
            )}
            <div>
              <h2 id="personPanelTitle" style={{ margin: 0, fontSize: '18px' }}>
                {profile?.name || personName}
              </h2>
              {onToggleFavoriteActor && (
                <button
                  type="button"
                  className={`person-fav-btn ${isFavoriteActor ? 'is-active' : ''}`}
                  onClick={() =>
                    onToggleFavoriteActor({
                      id: personId,
                      name: profile?.name || personName,
                      profile_path: profile?.profile_path || '',
                    })
                  }
                  title={isFavoriteActor ? 'Favorilerden çıkar' : 'Favorilere ekle'}
                >
                  {isFavoriteActor ? '❤️ Favorilerimde' : '🤍 Favoriye Ekle'}
                </button>
              )}
            </div>
          </div>
          <button id="closePersonPanel" className="modal-close" type="button" onClick={onClose} aria-label="Kapat">
            <svg className="icon" aria-hidden="true">
              <use href="#icon-close"></use>
            </svg>
          </button>
        </header>

        <div className="person-drawer-content">
          <p id="personBio" className="person-bio" aria-live="polite">
            {loading
              ? 'Oyuncu bilgileri yükleniyor...'
              : profile?.biography?.trim() || 'Bu oyuncu için biyografi bulunmuyor.'}
          </p>

          <section aria-labelledby="personMoviesTitle">
            <h3 id="personMoviesTitle" className="person-section-title">
              Filmler
            </h3>
            <div id="personMovies" className="person-credit-grid">
              {renderCreditsList(movies, 'movie')}
            </div>
          </section>

          <section aria-labelledby="personShowsTitle">
            <h3 id="personShowsTitle" className="person-section-title">
              Diziler
            </h3>
            <div id="personShows" className="person-credit-grid">
              {renderCreditsList(shows, 'tv')}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
};

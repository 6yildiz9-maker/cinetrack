import React, { useState, useEffect, useMemo } from 'react';
import { displayTitle, imageUrl } from '../utils/helpers';
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

  // Group filmography into:
  // 1. Listemdekiler (Watched / Completed)
  // 2. İzleyeceklerim (Watchlist / Watching)
  // 3. Öneriler / Diğer Yapımları (Not yet saved)
  const groupedCredits = useMemo(() => {
    const unique = credits
      .filter((c) => (c.media_type === 'movie' || c.media_type === 'tv') && (c.title || c.name))
      .filter((item, index, list) => list.findIndex((e) => e.id === item.id) === index)
      .sort((a, b) => Number(b.popularity || 0) - Number(a.popularity || 0));

    const inListWatched: any[] = [];
    const inListToWatch: any[] = [];
    const discoverList: any[] = [];

    for (const c of unique) {
      const saved = findSavedItem(savedItems, c);
      if (saved) {
        if (saved.status === 'completed') {
          inListWatched.push({ ...c, saved });
        } else {
          inListToWatch.push({ ...c, saved });
        }
      } else {
        discoverList.push(c);
      }
    }

    return {
      totalCreditsCount: unique.length,
      inListCount: inListWatched.length + inListToWatch.length,
      inListWatched,
      inListToWatch,
      discoverList: discoverList.slice(0, 16),
    };
  }, [credits, savedItems]);

  if (!isOpen || !personId) return null;

  const renderShelfItem = (item: any) => {
    const title = displayTitle(item);
    const poster = item.poster_path ? imageUrl(item.poster_path, 'w185') : '';
    const year = (item.release_date || item.first_air_date || '').slice(0, 4);
    const saved = findSavedItem(savedItems, item);
    const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
    const fullItem = { ...item, media_type: mediaType };

    return (
      <article
        key={makeMediaKey(mediaType, item.id)}
        className="person-shelf-item"
        onClick={() => onOpenDetails(fullItem)}
        role="button"
        tabIndex={0}
      >
        <div className="person-shelf-poster">
          {poster ? (
            <img src={poster} alt="" loading="lazy" />
          ) : (
            <div className="person-shelf-fallback">
              <svg className="icon">
                <use href="#icon-film"></use>
              </svg>
            </div>
          )}

          <div className="person-shelf-actions" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={`credit-action-btn ${saved?.status === 'watchlist' ? 'is-active' : ''}`}
              aria-label={`${title} izleneceklere ekle`}
              onClick={() => {
                if (saved?.status === 'watchlist') {
                  onQuickSave(fullItem);
                } else {
                  onQuickAdd(fullItem);
                }
              }}
            >
              <svg className="icon" aria-hidden="true">
                <use href={saved?.status === 'watchlist' ? '#icon-check' : '#icon-plus'}></use>
              </svg>
            </button>
            <button
              type="button"
              className={`credit-action-btn credit-action-completed ${saved?.status === 'completed' ? 'is-active' : ''}`}
              aria-label={`${title} izlendi olarak işaretle`}
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
        </div>

        <div className="person-shelf-meta">
          <strong className="clamp-1" title={title}>{title}</strong>
          <span className="tabular-nums">{year || ''}</span>
          {saved && (
            <span className={`person-saved-pill status-${saved.status}`}>
              {saved.status === 'completed' ? 'İzlendi' : saved.status === 'watching' ? 'İzleniyor' : 'Listede'}
            </span>
          )}
        </div>
      </article>
    );
  };

  return (
    <div id="personPanel" className="person-panel open" aria-hidden="false">
      <button
        className="person-scrim"
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <section
        ref={dialogRef}
        className="person-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="personPanelTitle"
        aria-describedby="personSummaryText"
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
              <h2 id="personPanelTitle" className="person-name-heading">
                {profile?.name || personName}
              </h2>
              <p id="personSummaryText" className="person-count-sub tabular-nums">
                {groupedCredits.totalCreditsCount > 0
                  ? `${groupedCredits.totalCreditsCount} yapımda göründü (listemde ${groupedCredits.inListCount})`
                  : 'Filmografi yükleniyor…'}
              </p>
            </div>
          </div>
          <button id="closePersonPanel" className="modal-close" type="button" onClick={onClose} aria-label="Kapat">
            <svg className="icon" aria-hidden="true">
              <use href="#icon-close"></use>
            </svg>
          </button>
        </header>

        <div className="person-drawer-content">
          {profile?.biography && (
            <p id="personBio" className="person-bio clamp-3">
              {profile.biography.trim()}
            </p>
          )}

          {/* 1. Listemdekiler (İzlendi) */}
          {groupedCredits.inListWatched.length > 0 && (
            <section className="person-group-section">
              <h3 className="person-section-title">
                İzlediklerim ({groupedCredits.inListWatched.length})
              </h3>
              <div className="person-horizontal-shelf">
                {groupedCredits.inListWatched.map(renderShelfItem)}
              </div>
            </section>
          )}

          {/* 2. İzleyeceklerim / İzliyorum */}
          {groupedCredits.inListToWatch.length > 0 && (
            <section className="person-group-section">
              <h3 className="person-section-title">
                İzleme Listemde ({groupedCredits.inListToWatch.length})
              </h3>
              <div className="person-horizontal-shelf">
                {groupedCredits.inListToWatch.map(renderShelfItem)}
              </div>
            </section>
          )}

          {/* 3. Öneriler / Diğer Yapımları */}
          <section className="person-group-section">
            <h3 className="person-section-title">
              Önerilen Diğer Yapımları ({groupedCredits.discoverList.length})
            </h3>
            {loading ? (
              <div className="skeleton-line" style={{ width: '80%' }} />
            ) : groupedCredits.discoverList.length > 0 ? (
              <div className="person-horizontal-shelf">
                {groupedCredits.discoverList.map(renderShelfItem)}
              </div>
            ) : (
              <p className="person-empty-hint">Bu oyuncunun tüm yapımları listenizde!</p>
            )}
          </section>
        </div>

        {/* Alt: [+ Favorilerime ekle] Birincil Eylem (Section 6.6) */}
        {onToggleFavoriteActor && (
          <footer className="person-drawer-footer">
            <button
              type="button"
              className={`btn ${isFavoriteActor ? 'btn-ghost' : 'btn-primary'} person-footer-fav-btn`}
              onClick={() =>
                onToggleFavoriteActor({
                  id: personId,
                  name: profile?.name || personName,
                  profile_path: profile?.profile_path || '',
                })
              }
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-star"></use>
              </svg>
              <span>{isFavoriteActor ? 'Favori Oyuncularımdan Çıkar' : 'Favori Oyuncularıma Ekle'}</span>
            </button>
          </footer>
        )}
      </section>
    </div>
  );
};

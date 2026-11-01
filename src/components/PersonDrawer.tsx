import React, { useState, useEffect, useMemo } from 'react';
import { displayTitle, imageUrl, handleImageError } from '../utils/helpers';
import {
  type FavoriteActorInfo,
  type SavedItem,
  findSavedItem,
  loadPersistentPoolData,
  makeMediaKey,
} from '../core/cinetrack-core';
import { fetchTmdb } from '../services/api';
import { loadStockIdb } from '../services/storage-idb';
import { useDialogAccessibility } from '../utils/useDialogAccessibility';
import {
  computePersonTasteCompatibility,
  mergePersonFilmography,
  type MergedPersonWork,
} from '../core/person-insights';
import type { TmdbItem, TmdbPersonCombinedCredits, TmdbPersonDetails } from '../types/tmdb';

interface PersonDrawerProps {
  personId: number | null;
  personName: string;
  profileId?: string;
  isOpen: boolean;
  savedItems: SavedItem[];
  isFavoriteActor?: boolean;
  onClose: () => void;
  onOpenDetails: (item: TmdbItem) => void;
  onQuickAdd: (item: TmdbItem) => void;
  onMarkCompleted: (item: TmdbItem) => void;
  onQuickSave: (item: TmdbItem) => void;
  onToggleFavoriteActor?: (actor: FavoriteActorInfo) => void;
  onOpenInRelationships?: (mediaKey: string) => void;
}

export const PersonDrawer: React.FC<PersonDrawerProps> = ({
  personId,
  personName,
  profileId = 'profile-default',
  isOpen,
  savedItems,
  isFavoriteActor = false,
  onClose,
  onOpenDetails,
  onQuickAdd,
  onMarkCompleted,
  onQuickSave,
  onToggleFavoriteActor,
  onOpenInRelationships,
}) => {
  const [profile, setProfile] = useState<TmdbPersonDetails | null>(null);
  const [combinedCredits, setCombinedCredits] = useState<TmdbPersonCombinedCredits | null>(null);
  const [stockKeys, setStockKeys] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const dialogRef = useDialogAccessibility(isOpen && Boolean(personId), onClose);

  useEffect(() => {
    if (!personId || !isOpen) {
      setProfile(null);
      setCombinedCredits(null);
      return;
    }

    setLoading(true);
    let active = true;

    void loadStockIdb()
      .then((stock) => {
        if (!active) return;
        const keys = new Set<string>();
        for (const m of stock.movies || []) {
          if (m?.id != null) keys.add(makeMediaKey('movie', m.id));
        }
        for (const tItem of stock.tv || []) {
          if (tItem?.id != null) keys.add(makeMediaKey('tv', tItem.id));
        }
        setStockKeys(keys);
      })
      .catch(() => {
        // IDB unavailable
      });

    Promise.allSettled([
      fetchTmdb(`/person/${personId}`),
      fetchTmdb(`/person/${personId}/combined_credits`),
    ]).then(async ([profileRes, creditsRes]) => {
      if (!active) return;
      let prof =
        profileRes.status === 'fulfilled' ? (profileRes.value as TmdbPersonDetails) : null;
      let cred =
        creditsRes.status === 'fulfilled'
          ? (creditsRes.value as TmdbPersonCombinedCredits)
          : null;

      if (!prof?.biography) {
        try {
          prof = (await fetchTmdb(`/person/${personId}`, {
            language: 'en-US',
          })) as TmdbPersonDetails;
        } catch {
          // fallback optional
        }
      }
      if (!cred?.cast?.length && !cred?.crew?.length) {
        try {
          cred = (await fetchTmdb(`/person/${personId}/combined_credits`, {
            language: 'en-US',
          })) as TmdbPersonCombinedCredits;
        } catch {
          // fallback optional
        }
      }

      if (!active) return;
      setProfile(prof);
      setCombinedCredits(cred);
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [personId, isOpen]);

  const relationshipMapKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const s of savedItems) {
      keys.add(makeMediaKey(s.media_type === 'tv' ? 'tv' : 'movie', s.id));
    }
    const moviePool = loadPersistentPoolData(profileId, 'movie').items;
    const tvPool = loadPersistentPoolData(profileId, 'tv').items;
    for (const c of [...moviePool, ...tvPool]) {
      keys.add(makeMediaKey(c.media_type === 'tv' ? 'tv' : 'movie', c.id));
    }
    return keys;
  }, [savedItems, profileId]);

  const mergedWorks = useMemo(
    () =>
      mergePersonFilmography(combinedCredits, {
        savedItems,
        stockKeys,
        relationshipMapKeys,
      }),
    [combinedCredits, savedItems, stockKeys, relationshipMapKeys]
  );

  const insights = useMemo(() => {
    if (!personId) return null;
    return computePersonTasteCompatibility(personId, mergedWorks, savedItems);
  }, [personId, mergedWorks, savedItems]);

  const groupedCredits = useMemo(() => {
    const inListWatched: MergedPersonWork[] = [];
    const inListToWatch: MergedPersonWork[] = [];
    const discoverList: MergedPersonWork[] = [];

    for (const work of mergedWorks) {
      if (work.savedStatus === 'completed') {
        inListWatched.push(work);
      } else if (work.savedStatus === 'watching' || work.savedStatus === 'watchlist') {
        inListToWatch.push(work);
      } else {
        discoverList.push(work);
      }
    }

    return {
      totalCreditsCount: mergedWorks.length,
      inListCount: inListWatched.length + inListToWatch.length,
      inListWatched,
      inListToWatch,
      discoverList: discoverList.slice(0, 20),
    };
  }, [mergedWorks]);

  if (!isOpen || !personId) return null;

  const renderShelfItem = (work: MergedPersonWork) => {
    const title = displayTitle(work);
    const poster = work.poster_path ? imageUrl(work.poster_path, 'w185') : '';
    const year = work.year ? String(work.year) : '';
    const saved = findSavedItem(savedItems, {
      id: work.id,
      media_type: work.resolvedMediaType,
    });
    const fullItem: TmdbItem = {
      ...work,
      media_type: work.resolvedMediaType,
    };

    return (
      <article
        key={work.mediaKey}
        className="person-shelf-item"
        onClick={() => onOpenDetails(fullItem)}
        role="button"
        tabIndex={0}
      >
        <div className="person-shelf-poster">
          {poster ? (
            <img
              src={poster}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(e) => handleImageError(e, poster, 'w500')}
            />
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
          <strong className="clamp-1" title={title}>
            {title}
          </strong>
          <span className="person-role-year tabular-nums">
            {work.roleSummary}
            {year ? ` · ${year}` : ''}
          </span>

          {(work.inStock || work.inRelationshipMap) && (
            <div className="person-availability-line">
              {work.inStock && <span className="person-avail-tag">Stokta</span>}
              {work.inRelationshipMap && onOpenInRelationships ? (
                <button
                  type="button"
                  className="person-map-jump-btn whitespace-nowrap"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenInRelationships(work.mediaKey);
                  }}
                >
                  Haritada Gör
                </button>
              ) : work.inRelationshipMap ? (
                <span className="person-avail-tag">Haritada</span>
              ) : null}
            </div>
          )}

          {saved && (
            <span className={`person-saved-pill status-${saved.status}`}>
              {saved.status === 'completed'
                ? 'İzlendi'
                : saved.status === 'watching'
                  ? 'İzleniyor'
                  : 'Listede'}
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
                referrerPolicy="no-referrer"
                onError={(e) =>
                  handleImageError(e, imageUrl(profile.profile_path || '', 'w185'), 'w185')
                }
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
                  ? `${groupedCredits.totalCreditsCount} yapım (${
                      insights?.directorWorksCount
                        ? `${insights.directorWorksCount} yönetmenlik · `
                        : ''
                    }listemde ${groupedCredits.inListCount})`
                  : 'Filmografi yükleniyor…'}
              </p>
            </div>
          </div>
          <button
            id="closePersonPanel"
            className="modal-close"
            type="button"
            onClick={onClose}
            aria-label="Kapat"
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-close"></use>
            </svg>
          </button>
        </header>

        <div className="person-drawer-content">
          {insights && groupedCredits.totalCreditsCount > 0 && (
            <div className="person-compatibility-banner tabular-nums">
              <strong className="person-compatibility-headline">
                Bu kişiyle {insights.watchedCount} yapım izledin · Uyum puanın %
                {insights.compatibilityPercent}
              </strong>
              <span className="person-compatibility-sub">
                Stokta {insights.inStockCount} yapım · İlişki Haritasında{' '}
                {insights.inRelationshipMapCount} yapım
              </span>
            </div>
          )}

          {profile?.biography && (
            <p id="personBio" className="person-bio clamp-3">
              {profile.biography.trim()}
            </p>
          )}

          {groupedCredits.inListWatched.length > 0 && (
            <section className="person-group-section">
              <h3 className="person-section-title tabular-nums">
                İzlediklerim ({groupedCredits.inListWatched.length})
              </h3>
              <div className="person-horizontal-shelf">
                {groupedCredits.inListWatched.map(renderShelfItem)}
              </div>
            </section>
          )}

          {groupedCredits.inListToWatch.length > 0 && (
            <section className="person-group-section">
              <h3 className="person-section-title tabular-nums">
                İzleme Listemde ({groupedCredits.inListToWatch.length})
              </h3>
              <div className="person-horizontal-shelf">
                {groupedCredits.inListToWatch.map(renderShelfItem)}
              </div>
            </section>
          )}

          <section className="person-group-section">
            <h3 className="person-section-title tabular-nums">
              Önerilen Diğer Yapımları ({groupedCredits.discoverList.length})
            </h3>
            {loading ? (
              <div className="skeleton-line person-skeleton-line" />
            ) : groupedCredits.discoverList.length > 0 ? (
              <div className="person-horizontal-shelf">
                {groupedCredits.discoverList.map(renderShelfItem)}
              </div>
            ) : (
              <p className="person-empty-hint">Bu sanatçının tüm yapımları listenizde!</p>
            )}
          </section>
        </div>

        {onToggleFavoriteActor && (
          <footer className="person-drawer-footer">
            <button
              type="button"
              className={`btn ${isFavoriteActor ? 'btn-ghost' : 'btn-primary'} person-footer-fav-btn whitespace-nowrap`}
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
              <span>
                {isFavoriteActor ? 'Favori Oyuncularımdan Çıkar' : 'Favori Oyuncularıma Ekle'}
              </span>
            </button>
          </footer>
        )}
      </section>
    </div>
  );
};


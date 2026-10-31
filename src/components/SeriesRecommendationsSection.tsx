import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildTasteProfileV3,
  findSavedItem,
  makeMediaKey,
  matchesSelectedGenre,
  type SavedItem,
} from '../core/cinetrack-core';
import {
  backfillSavedSeriesLazy,
  computeUserSeriesUniverses,
  ensureSeriesCollectionLoaded,
  scoreSeriesUniverseGroup,
  type UserSeriesUniverse,
} from '../services/series-service';
import { subscribeSeriesIndex } from '../services/storage-idb';
import type { TmdbItem } from '../types/tmdb';
import { displayTitle } from '../utils/helpers';
import { compareMediaDatesAscending } from '../utils/release-window';
import { MediaCard } from './MediaCard';
import {
  PaginatedMediaModal,
  SCORE_DEBOUNCE_MS,
  SHELF_INITIAL_COUNT,
  sliceShelfItems,
} from './PaginatedMediaModal';

export interface SeriesRecommendationsSectionProps {
  savedItems: SavedItem[];
  dislikedKeys: string[];
  hiddenKeys?: string[];
  genresMap: Record<number, string>;
  mood?: string;
  selectedType?: string;
  selectedGenre?: string;
  selectedSort?: string;
  isDemo?: boolean;
  tmdbSource?: string;
  onOpenDetails: (item: TmdbItem) => void;
  onQuickAdd: (item: TmdbItem) => void;
  onSetStatus: (item: TmdbItem, status: 'watching' | 'watchlist' | 'completed') => void;
  onQuickSave: (item: TmdbItem) => void;
  onToggleDislike?: (key: string) => void;
  onEmptyAction: (action: string) => void;
  onBackToRecommendations?: () => void;
}

const SERIES_ACCORDION_STORAGE_KEY = 'cinetrack.series-accordions.v1';

function loadSeriesAccordionStates(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SERIES_ACCORDION_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'boolean') {
        clean[k] = v;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

export const SeriesRecommendationsSection: React.FC<SeriesRecommendationsSectionProps> = ({
  savedItems,
  dislikedKeys,
  hiddenKeys = [],
  genresMap,
  mood = '',
  selectedType = 'all',
  selectedGenre = '',
  selectedSort = 'popular',
  isDemo = false,
  tmdbSource = 'live',
  onOpenDetails,
  onQuickAdd,
  onSetStatus,
  onQuickSave,
  onToggleDislike,
  onEmptyAction,
  onBackToRecommendations,
}) => {
  const effectiveDemo = Boolean(isDemo || tmdbSource === 'demo');
  const [seriesRevision, setSeriesRevision] = useState<number>(0);
  const [isBackfilling, setIsBackfilling] = useState<boolean>(false);
  const [loadingGroupKeys, setLoadingGroupKeys] = useState<Record<string, boolean>>({});
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(loadSeriesAccordionStates);
  const [shelfLimits, setShelfLimits] = useState<Record<string, number>>({});
  const [modalGroupKey, setModalGroupKey] = useState<string | null>(null);

  const groupMemoRef = useRef<Map<string, { signature: string; items: TmdbItem[] }>>(new Map());
  const hasHydratedScoreRef = useRef<boolean>(false);

  const [debouncedFilters, setDebouncedFilters] = useState(() => ({
    selectedType,
    selectedGenre,
    selectedSort,
  }));

  useEffect(() => {
    if (!hasHydratedScoreRef.current) {
      hasHydratedScoreRef.current = true;
      setDebouncedFilters({ selectedType, selectedGenre, selectedSort });
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedFilters({ selectedType, selectedGenre, selectedSort });
    }, SCORE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [selectedType, selectedGenre, selectedSort]);

  useEffect(() => {
    return subscribeSeriesIndex(() => {
      setSeriesRevision((v) => v + 1);
    });
  }, []);

  // Lazy backfill ONLY when Seriler tab mounts (skips demo mode with 0 requests; max 1 req per unchecked item)
  useEffect(() => {
    let active = true;
    if (savedItems.length === 0) return;

    if (effectiveDemo) {
      void backfillSavedSeriesLazy(savedItems, { isDemo: true });
      return;
    }

    setIsBackfilling(true);
    void backfillSavedSeriesLazy(savedItems, { isDemo: false }).finally(() => {
      if (active) setIsBackfilling(false);
    });

    return () => {
      active = false;
    };
  }, [savedItems, effectiveDemo]);

  // Compute franchise groups strictly from in-memory ct:series-index (0 network requests on filter toggle!)
  const filteredUniverses = useMemo<UserSeriesUniverse[]>(() => {
    void seriesRevision;
    const rawUniverses = computeUserSeriesUniverses(savedItems, {
      includeStubs: !effectiveDemo,
      dislikedKeys,
      hiddenKeys,
    });

    const activeType =
      debouncedFilters.selectedType === 'movie' || debouncedFilters.selectedType === 'tv'
        ? debouncedFilters.selectedType
        : 'all';
    const activeGenre = debouncedFilters.selectedGenre || '';

    const result: UserSeriesUniverse[] = [];
    for (const u of rawUniverses) {
      if (activeType !== 'all' && u.collection.media_type !== activeType) {
        continue;
      }
      if (activeGenre && !u.isStub) {
        const filteredMissing = u.userMissingParts.filter((part) =>
          matchesSelectedGenre(part, activeGenre)
        );
        if (filteredMissing.length === 0) continue;
        result.push({
          ...u,
          userMissingParts: filteredMissing,
        });
      } else {
        result.push(u);
      }
    }
    return result;
  }, [savedItems, dislikedKeys, hiddenKeys, debouncedFilters, effectiveDemo, seriesRevision]);

  // Default the first 2 franchise groups to open if none saved yet
  useEffect(() => {
    if (filteredUniverses.length === 0) return;
    setOpenGroups((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const next: Record<string, boolean> = {};
      filteredUniverses.slice(0, 2).forEach((u) => {
        next[u.collectionKey] = true;
      });
      return next;
    });
  }, [filteredUniverses]);

  // Group-lazy collection loader: fetches /collection/{id} ONLY when an accordion group is opened!
  useEffect(() => {
    if (effectiveDemo) return;
    let active = true;

    for (const u of filteredUniverses) {
      const isOpen = Boolean(openGroups[u.collectionKey]);
      if (!isOpen || !u.isStub || loadingGroupKeys[u.collectionKey]) continue;

      setLoadingGroupKeys((prev) => ({ ...prev, [u.collectionKey]: true }));
      void ensureSeriesCollectionLoaded(u.collectionKey, { isDemo: false }).finally(() => {
        if (active) {
          setLoadingGroupKeys((prev) => ({ ...prev, [u.collectionKey]: false }));
        }
      });
    }

    return () => {
      active = false;
    };
  }, [filteredUniverses, openGroups, effectiveDemo, loadingGroupKeys]);

  const tasteProfile = useMemo(
    () => buildTasteProfileV3(savedItems, { dislikedKeys }),
    [savedItems, dislikedKeys]
  );

  // Per-franchise-group single-pass memoized scoring (never once per owned item!)
  const groupScoredItemsMap = useMemo(() => {
    const map = new Map<string, TmdbItem[]>();
    const savedSig = `${savedItems.length}:${dislikedKeys.length}:${mood}`;

    for (const u of filteredUniverses) {
      const isOpen = Boolean(openGroups[u.collectionKey]);
      if (!isOpen && !groupMemoRef.current.has(u.collectionKey)) {
        map.set(u.collectionKey, []);
        continue;
      }

      const partIdsSig = u.userMissingParts.map((p) => p.id).join(',');
      const sig = `${u.collectionKey}|${partIdsSig}|${savedSig}|${debouncedFilters.selectedSort}`;
      const cached = groupMemoRef.current.get(u.collectionKey);
      if (cached && cached.signature === sig) {
        map.set(u.collectionKey, cached.items);
        continue;
      }

      const baseItems = scoreSeriesUniverseGroup(u, tasteProfile, {
        genreNames: genresMap,
        mood,
      });

      const sorted = [...baseItems];
      if (debouncedFilters.selectedSort === 'rating') {
        sorted.sort((a, b) => Number(b.vote_average || 0) - Number(a.vote_average || 0));
      } else if (debouncedFilters.selectedSort === 'title') {
        sorted.sort((a, b) => displayTitle(a).localeCompare(displayTitle(b), 'tr'));
      } else if (debouncedFilters.selectedSort === 'recent') {
        sorted.sort((a, b) =>
          compareMediaDatesAscending(
            b.release_date || b.first_air_date,
            a.release_date || a.first_air_date
          )
        );
      }

      groupMemoRef.current.set(u.collectionKey, { signature: sig, items: sorted });
      map.set(u.collectionKey, sorted);
    }

    return map;
  }, [filteredUniverses, openGroups, savedItems.length, dislikedKeys.length, mood, debouncedFilters.selectedSort, tasteProfile, genresMap]);

  const toggleGroup = (collectionKey: string) => {
    const next = {
      ...openGroups,
      [collectionKey]: !openGroups[collectionKey],
    };
    setOpenGroups(next);
    try {
      localStorage.setItem(SERIES_ACCORDION_STORAGE_KEY, JSON.stringify(next));
    } catch {}
  };

  const dislikedSet = useMemo(() => new Set(dislikedKeys), [dislikedKeys]);

  const activeModalUniverse = modalGroupKey
    ? filteredUniverses.find((u) => u.collectionKey === modalGroupKey) || null
    : null;

  return (
    <section className="actor-recs-wrap series-universes-wrap" aria-label="Seri ve evren grupları">
      {effectiveDemo && (
        <div className="catalog-source-banner banner-demo" role="status">
          <span className="catalog-source-banner-icon" aria-hidden="true">
            ℹ️
          </span>
          <div>
            <strong>Canlı katalog gerekir:</strong> Örnek katalog (Demo) modunda yeni seri ve koleksiyon sorguları ağ üzerinden çalıştırılmaz. TMDB canlı bağlantısı aktif olduğunda listenizdeki yapımların tüm devam halkaları otomatik olarak gruplanır.
          </div>
        </div>
      )}

      {isBackfilling && filteredUniverses.length === 0 && (
        <div className="progress-step-banner" role="status" aria-live="polite">
          <span>Listenizdeki yapımların seri ve evren bağlantıları kontrol ediliyor…</span>
        </div>
      )}

      {filteredUniverses.length === 0 && !isBackfilling ? (
        <div className="empty-message">
          <strong>
            {effectiveDemo
              ? 'Seri keşfi için canlı katalog gerekir'
              : selectedType !== 'all' || selectedGenre
                ? 'Seçili filtreye uygun eksik seri parçası bulunamadı'
                : 'Listenizdeki serilere ait eksik yapım bulunmuyor'}
          </strong>
          {effectiveDemo
            ? 'Canlı TMDB bağlantısı kurulduğunda izlediğiniz veya listenize eklediğiniz film ve dizilerin devam halkaları burada seri başlıkları altında gruplanır.'
            : selectedType !== 'all' || selectedGenre
              ? 'Tür veya Film/Dizi filtresini sıfırlayarak listenizdeki serilerin diğer tüm parçalarını görebilirsiniz.'
              : 'İzlediğiniz veya listenize eklediğiniz film ve dizilerin devam halkaları ya da yan yapımları bulunduğunda burada seri başlıkları altında otomatik listelenir.'}
          <div className="message-actions">
            {(selectedType !== 'all' || selectedGenre) && (
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => onEmptyAction('clear-filters')}
              >
                Filtreleri temizle
              </button>
            )}
            {onBackToRecommendations && (
              <button className="btn" type="button" onClick={onBackToRecommendations}>
                Önerilere dön
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="actor-chips-strip" role="tablist" aria-label="Seri ve evren kısayolları">
            {filteredUniverses.map((u) => {
              const isOpen = Boolean(openGroups[u.collectionKey]);
              return (
                <button
                  key={u.collectionKey}
                  type="button"
                  className={`actor-strip-chip ${isOpen ? 'is-active' : ''}`}
                  onClick={() => {
                    toggleGroup(u.collectionKey);
                    const el = document.getElementById(`series-group-${u.collectionKey}`);
                    const prefersReducedMotion =
                      typeof window !== 'undefined' &&
                      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                    el?.scrollIntoView({
                      behavior: prefersReducedMotion ? 'auto' : 'smooth',
                      block: 'nearest',
                    });
                  }}
                  aria-expanded={isOpen}
                >
                  <span className="actor-strip-name">{u.displayName}</span>{' '}
                  {!u.isStub && (
                    <span className="actor-strip-count tabular-nums">
                      {u.userMissingParts.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="actor-accordions-container">
            {filteredUniverses.map((u) => {
              const isOpen = Boolean(openGroups[u.collectionKey]);
              const isGroupLoading = Boolean(loadingGroupKeys[u.collectionKey]);
              const items = isOpen
                ? groupScoredItemsMap.get(u.collectionKey) || []
                : [];
              const ownedSummary = u.userOwnedParts
                .slice(0, 2)
                .map((p) => p.title || p.name)
                .filter(Boolean)
                .join(', ');
              const reasonText = ownedSummary
                ? `Listenizdeki "${ownedSummary}" ile aynı seride`
                : `${u.displayName} devam halkası`;

              const currentLimit = shelfLimits[u.collectionKey] ?? SHELF_INITIAL_COUNT;
              const shelfSlice = sliceShelfItems(items, currentLimit);

              return (
                <div
                  key={u.collectionKey}
                  id={`series-group-${u.collectionKey}`}
                  className={`actor-accordion ${isOpen ? 'is-open' : 'is-closed'}`}
                >
                  <div className="actor-accordion-head">
                    <button
                      type="button"
                      className="actor-accordion-trigger"
                      onClick={() => toggleGroup(u.collectionKey)}
                      aria-expanded={isOpen}
                      aria-controls={`series-panel-${u.collectionKey}`}
                    >
                      <span className="accordion-chevron" aria-hidden="true">
                        {isOpen ? '▾' : '▸'}
                      </span>{' '}
                      <span className="actor-accordion-name">{u.displayName}</span>{' '}
                      <span className="actor-accordion-badge tabular-nums">
                        {u.isStub
                          ? 'Halkaları görmek için açın'
                          : `${u.userMissingParts.length} eksik · ${u.userOwnedParts.length} listenizde`}
                      </span>
                      {isGroupLoading && (
                        <>
                          {' '}
                          <span className="actor-load-status is-loading">◔ yükleniyor</span>
                        </>
                      )}
                    </button>

                    <div className="actor-accordion-head-right">
                      {!u.isStub && items.length > 5 && (
                        <button
                          type="button"
                          className="actor-all-view-btn tabular-nums"
                          onClick={() => setModalGroupKey(u.collectionKey)}
                        >
                          Tümünü gör ({items.length}) →
                        </button>
                      )}
                      <button
                        type="button"
                        className="actor-toggle-icon-btn"
                        onClick={() => toggleGroup(u.collectionKey)}
                        aria-label={
                          isOpen
                            ? `${u.displayName} grubunu kapat`
                            : `${u.displayName} grubunu aç`
                        }
                        aria-expanded={isOpen}
                        aria-controls={`series-panel-${u.collectionKey}`}
                      >
                        {isOpen ? '—' : '+'}
                      </button>
                    </div>
                  </div>

                  {isOpen && (
                    <div
                      id={`series-panel-${u.collectionKey}`}
                      className="actor-shelf-panel"
                      role="region"
                      aria-label={`${u.displayName} eksik halkaları`}
                    >
                      {isGroupLoading || (u.isStub && items.length === 0) ? (
                        <div className="actor-shelf-empty">
                          Seri halkaları TMDB koleksiyonundan yükleniyor…
                        </div>
                      ) : items.length === 0 ? (
                        <div className="actor-shelf-empty">
                          Bu serinin yayınlanmış tüm halkaları zaten listenizde bulunuyor.
                        </div>
                      ) : (
                        <div className="actor-horizontal-shelf">
                          {shelfSlice.visible.map((item) => {
                            const mType = item.media_type === 'tv' ? 'tv' : 'movie';
                            const key = makeMediaKey(mType, item.id);
                            return (
                              <div key={key} className="actor-shelf-item">
                                <MediaCard
                                  item={item}
                                  savedItem={findSavedItem(savedItems, item)}
                                  genres={genresMap}
                                  recommendationReason={reasonText}
                                  isDisliked={dislikedSet.has(key)}
                                  size="sm"
                                  context="discover"
                                  showMatch={Boolean(item.tasteScore ?? item.matchScore)}
                                  matchScore={item.tasteScore ?? item.matchScore}
                                  onOpenDetails={onOpenDetails}
                                  onQuickAdd={onQuickAdd}
                                  onSetStatus={onSetStatus}
                                  onQuickSave={onQuickSave}
                                  onToggleDislike={onToggleDislike}
                                />
                              </div>
                            );
                          })}
                          {shelfSlice.remaining > 0 && (
                            <div className="actor-shelf-item shelf-load-more-wrap">
                              <button
                                type="button"
                                className="shelf-load-more-card tabular-nums"
                                onClick={() =>
                                  setShelfLimits((prev) => ({
                                    ...prev,
                                    [u.collectionKey]: currentLimit + SHELF_INITIAL_COUNT,
                                  }))
                                }
                              >
                                <strong>Daha fazla göster</strong>
                                <span>
                                  +{Math.min(SHELF_INITIAL_COUNT, shelfSlice.remaining)} yapım daha
                                  (kalan {shelfSlice.remaining})
                                </span>
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <PaginatedMediaModal
        isOpen={Boolean(activeModalUniverse)}
        title={activeModalUniverse ? `${activeModalUniverse.displayName} — Eksik Yapımlar` : ''}
        subtitle="Listenizdeki yapımlarla aynı seri veya evrende yer alan diğer halkalar"
        items={
          activeModalUniverse
            ? groupScoredItemsMap.get(activeModalUniverse.collectionKey) || []
            : []
        }
        savedItems={savedItems}
        dislikedKeys={dislikedKeys}
        genresMap={genresMap}
        context="discover"
        onClose={() => setModalGroupKey(null)}
        onOpenDetails={onOpenDetails}
        onQuickAdd={onQuickAdd}
        onSetStatus={onSetStatus}
        onQuickSave={onQuickSave}
        onToggleDislike={onToggleDislike}
      />
    </section>
  );
};

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  type FavoriteActorInfo,
  type ActorRecommendationItem,
  type SavedItem,
  findSavedItem,
  makeMediaKey,
  createRequestGate,
  type ActorFetchStatus,
  normalizeFavoriteActors,
  describeActorFetchChipState,
} from '../core/cinetrack-core';
import {
  buildMergedActorCreditsWithStock,
  loadOpenActorCreditsLazy,
  scoreSingleActorMemoized,
  type PerActorSignedMemoEntry,
} from '../services/actor-recommendations-engine';
import { subscribeStockState } from '../services/stock-engine';
import type { TmdbItem, TmdbPersonCreditItem } from '../types/tmdb';
import { MediaCard } from './MediaCard';
import {
  PaginatedMediaModal,
  SCORE_DEBOUNCE_MS,
  SHELF_INITIAL_COUNT,
  sliceShelfItems,
} from './PaginatedMediaModal';

interface ActorRecommendationsSectionProps {
  favoriteActors: FavoriteActorInfo[];
  savedItems: SavedItem[];
  dislikedKeys: string[];
  genresMap: Record<number, string>;
  preferredProviders?: string[];
  providerIndex?: Record<string, Array<{ id: number | string; name?: string }>>;
  selectedType?: string;
  selectedGenre?: string;
  selectedSort?: string;
  onOpenDetails: (item: TmdbItem | ActorRecommendationItem) => void;
  onQuickAdd: (item: TmdbItem | ActorRecommendationItem) => void;
  onSetStatus: (
    item: TmdbItem | ActorRecommendationItem,
    status: 'watching' | 'watchlist' | 'completed'
  ) => void;
  onQuickSave: (item: TmdbItem | ActorRecommendationItem) => void;
  onOpenPerson?: (id: number, name: string) => void;
}

const ACCORDION_STORAGE_KEY = 'cinetrack.actor-accordions.v1';

function loadAccordionStates(): Record<number, boolean> {
  try {
    const raw = localStorage.getItem(ACCORDION_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean: Record<number, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(k);
      if (Number.isInteger(id) && id > 0 && typeof v === 'boolean') {
        clean[id] = v;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

export const ActorRecommendationsSection: React.FC<ActorRecommendationsSectionProps> = ({
  favoriteActors,
  savedItems,
  dislikedKeys,
  genresMap,
  preferredProviders = [],
  providerIndex = {},
  selectedType = 'all',
  selectedGenre = '',
  selectedSort = 'popular',
  onOpenDetails,
  onQuickAdd,
  onSetStatus,
  onQuickSave,
  onOpenPerson,
}) => {
  const validFavoriteActors = useMemo(
    () => normalizeFavoriteActors(favoriteActors),
    [favoriteActors]
  );

  const [actorCreditsMap, setActorCreditsMap] = useState<Record<number, TmdbPersonCreditItem[]>>({});
  const [actorStatuses, setActorStatuses] = useState<Record<number, ActorFetchStatus>>({});
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [enableDiversity, setEnableDiversity] = useState<boolean>(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [rateLimitWarning, setRateLimitWarning] = useState<string | null>(null);
  const [stockRevision, setStockRevision] = useState<number>(0);
  const [shelfLimits, setShelfLimits] = useState<Record<number, number>>({});

  // Accordion open/closed states persisted in localStorage (first 2 open by default)
  const [openAccordions, setOpenAccordions] = useState<Record<number, boolean>>(() => {
    const saved = loadAccordionStates();
    if (Object.keys(saved).length === 0 && validFavoriteActors.length > 0) {
      const initial: Record<number, boolean> = {};
      validFavoriteActors.slice(0, 2).forEach((a) => {
        initial[a.id] = true;
      });
      return initial;
    }
    return saved;
  });

  const [allViewActor, setAllViewActor] = useState<FavoriteActorInfo | null>(null);

  const requestGateRef = useRef(createRequestGate());
  const perActorMemoRef = useRef<Map<number, PerActorSignedMemoEntry>>(new Map());
  const hasRenderedInitialScoreRef = useRef<boolean>(false);

  // Debounce scoring inputs (300ms) after initial render so rapid filter clicks never freeze the UI
  const [debouncedScoringInputs, setDebouncedScoringInputs] = useState(() => ({
    savedItems,
    dislikedKeys,
    selectedType,
    selectedGenre,
    selectedSort,
    enableDiversity,
  }));

  useEffect(() => {
    if (!hasRenderedInitialScoreRef.current) {
      hasRenderedInitialScoreRef.current = true;
      setDebouncedScoringInputs({
        savedItems,
        dislikedKeys,
        selectedType,
        selectedGenre,
        selectedSort,
        enableDiversity,
      });
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedScoringInputs({
        savedItems,
        dislikedKeys,
        selectedType,
        selectedGenre,
        selectedSort,
        enableDiversity,
      });
    }, SCORE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [savedItems, dislikedKeys, selectedType, selectedGenre, selectedSort, enableDiversity]);

  useEffect(() => {
    return subscribeStockState(() => {
      setStockRevision((v) => v + 1);
    });
  }, []);

  const openActorIds = useMemo(
    () =>
      validFavoriteActors
        .filter((actor) => Boolean(openAccordions[actor.id]))
        .map((actor) => actor.id),
    [validFavoriteActors, openAccordions]
  );

  const saveAccordionStates = (states: Record<number, boolean>) => {
    setOpenAccordions(states);
    try {
      localStorage.setItem(ACCORDION_STORAGE_KEY, JSON.stringify(states));
    } catch {}
  };

  const toggleAccordion = (actorId: number) => {
    saveAccordionStates({
      ...openAccordions,
      [actorId]: !openAccordions[actorId],
    });
  };

  const loadOpenCredits = useCallback(
    async (force = false) => {
      if (validFavoriteActors.length === 0 || openActorIds.length === 0) {
        setIsLoading(false);
        return;
      }

      const missingOpenActors = force
        ? validFavoriteActors.filter((a) => openActorIds.includes(a.id))
        : validFavoriteActors.filter(
            (a) => openActorIds.includes(a.id) && !actorCreditsMap[a.id]
          );

      if (missingOpenActors.length === 0) {
        setIsLoading(false);
        return;
      }

      const ticket = requestGateRef.current.begin();
      setIsLoading(true);
      setFetchError(null);
      if (force) {
        setRateLimitWarning(null);
      }

      try {
        const result = await loadOpenActorCreditsLazy({
          actors: missingOpenActors,
          openAccordionIds: openActorIds,
          force,
          signal: ticket.signal,
          onActorStatusChange: (status) => {
            if (!requestGateRef.current.isCurrent(ticket.id)) return;
            setActorStatuses((prev) => ({ ...prev, [status.actorId]: status }));
          },
        });

        if (!requestGateRef.current.isCurrent(ticket.id)) return;

        setActorCreditsMap((prev) => ({ ...prev, ...result.creditsMap }));
        setActorStatuses((prev) => ({ ...prev, ...result.statuses }));
        if (result.rateLimitWarning) {
          setRateLimitWarning(result.rateLimitWarning);
        }
        const loadedCount = Object.keys(result.creditsMap).length;
        if (loadedCount === 0 && !result.rateLimited) {
          setFetchError('Favori oyuncuların içerikleri yüklenirken bir sorun oluştu.');
        }
      } catch (err: unknown) {
        if (!requestGateRef.current.isCurrent(ticket.id)) return;
        console.error('Failed to load actor recommendations:', err);
        setFetchError('Öneriler yüklenirken bir sorun oluştu.');
      } finally {
        if (requestGateRef.current.isCurrent(ticket.id)) {
          setIsLoading(false);
        }
      }
    },
    [validFavoriteActors, openActorIds, actorCreditsMap]
  );

  useEffect(() => {
    void loadOpenCredits(false);
  }, [loadOpenCredits]);

  const excludedKeysSet = useMemo(() => {
    const s = new Set<string>(debouncedScoringInputs.dislikedKeys);
    for (const saved of debouncedScoringInputs.savedItems) {
      s.add(`${saved.media_type === 'tv' ? 'tv' : 'movie'}:${saved.id}`);
    }
    return s;
  }, [debouncedScoringInputs.savedItems, debouncedScoringInputs.dislikedKeys]);

  // Per-actor memoized scoring: scores ONLY open accordions or already-cached actors without cross-actor re-computation
  const actorItemsMap = useMemo(() => {
    void stockRevision;
    const map = new Map<number, ActorRecommendationItem[]>();
    for (const actor of validFavoriteActors) {
      const isOpen = Boolean(openAccordions[actor.id]);
      const loadedCredits = actorCreditsMap[actor.id];
      if (!isOpen && !loadedCredits) {
        map.set(actor.id, []);
        continue;
      }
      const mergedCredits = isOpen
        ? buildMergedActorCreditsWithStock(actor, loadedCredits, excludedKeysSet)
        : loadedCredits || [];

      const scored = scoreSingleActorMemoized(actor, mergedCredits, perActorMemoRef.current, {
        savedItems: debouncedScoringInputs.savedItems,
        dislikedKeys: debouncedScoringInputs.dislikedKeys,
        genresMap,
        preferredProviders,
        providerIndex,
        selectedType: debouncedScoringInputs.selectedType || 'all',
        selectedGenre: debouncedScoringInputs.selectedGenre || '',
        selectedSort: debouncedScoringInputs.selectedSort || 'popular',
        enableDiversity: debouncedScoringInputs.enableDiversity,
      });
      map.set(actor.id, scored);
    }
    return map;
  }, [
    validFavoriteActors,
    openAccordions,
    actorCreditsMap,
    excludedKeysSet,
    debouncedScoringInputs,
    genresMap,
    preferredProviders,
    providerIndex,
    stockRevision,
  ]);

  const totalUniqueCount = useMemo(() => {
    const unique = new Set<string>();
    for (const items of actorItemsMap.values()) {
      for (const it of items) {
        unique.add(makeMediaKey(it.media_type, it.id));
      }
    }
    return unique.size;
  }, [actorItemsMap]);

  if (validFavoriteActors.length === 0) {
    return null;
  }

  return (
    <section className="actor-recs-wrap" aria-labelledby="actorRecsHeading">
      <div className="actor-recs-head">
        <div>
          <div className="actor-recs-title">
            <h3 id="actorRecsHeading">
              Favori Oyuncularımdan Öneriler{' '}
              <span className="tabular-nums">({totalUniqueCount})</span>
            </h3>
          </div>
          <p className="actor-recs-sub">
            Açık oyuncu rafları kalıcı önbellek ve yerel stoktan anında yüklenir; kapalı raflar siz açana kadar ağ isteği yapmaz.
          </p>
        </div>

        <div className="actor-recs-controls">
          {(!selectedSort || selectedSort === 'popular') && !selectedGenre && (
            <button
              type="button"
              className={`actor-recs-tab-btn ${enableDiversity ? 'active' : ''}`}
              onClick={() => setEnableDiversity((v) => !v)}
              title="Aynı türün peş peşe yığılmasını önleyerek farklı türleri dengeler"
              aria-pressed={enableDiversity}
            >
              Çeşitlilik: {enableDiversity ? 'Açık' : 'Kapalı'}
            </button>
          )}

          <button
            type="button"
            className="for-you-head-refresh-btn"
            onClick={() => void loadOpenCredits(true)}
            disabled={isLoading || openActorIds.length === 0}
            title="Açık raflardaki önerileri yenile"
            aria-label="Önerileri yenile"
          >
            <span className={`refresh-icon ${isLoading ? 'spinning' : ''}`} aria-hidden="true">
              ↻
            </span>{' '}
            <span>Yenile</span>
          </button>
        </div>
      </div>

      {rateLimitWarning && (
        <div className="rate-limit-warning-banner" role="status">
          <span>⚠️ {rateLimitWarning}</span>
        </div>
      )}

      <div className="actor-chips-strip" role="tablist" aria-label="Favori oyuncu listesi">
        {validFavoriteActors.map((actor) => {
          const items = actorItemsMap.get(actor.id) || [];
          const isOpen = Boolean(openAccordions[actor.id]);
          const hasLoaded = Boolean(actorCreditsMap[actor.id]);
          return (
            <button
              key={actor.id}
              type="button"
              className={`actor-strip-chip ${isOpen ? 'is-active' : ''}`}
              onClick={() => {
                toggleAccordion(actor.id);
                const el = document.getElementById(`actor-accordion-${actor.id}`);
                const prefersReducedMotion =
                  typeof window !== 'undefined' &&
                  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                el?.scrollIntoView({
                  behavior: prefersReducedMotion ? 'auto' : 'smooth',
                  block: 'nearest',
                });
              }}
              title={
                isOpen || hasLoaded
                  ? `${actor.name} için ${items.length} öneri`
                  : `${actor.name} rafını aç ve filmografiyi yükle`
              }
              aria-expanded={isOpen}
            >
              <span className="actor-strip-name">{actor.name}</span>{' '}
              {(isOpen || hasLoaded) && (
                <span className="actor-strip-count tabular-nums">{items.length}</span>
              )}
            </button>
          );
        })}
      </div>

      {fetchError && (
        <div className="message" role="alert">
          <strong>{fetchError}</strong>
          <button type="button" className="btn" onClick={() => void loadOpenCredits(true)}>
            Tekrar dene
          </button>
        </div>
      )}

      <div className="actor-accordions-container">
        {validFavoriteActors.map((actor) => {
          const items = actorItemsMap.get(actor.id) || [];
          const isOpen = Boolean(openAccordions[actor.id]);
          const status = actorStatuses[actor.id];
          const isActorLoading = status?.status === 'loading';
          const chipState = describeActorFetchChipState(actor, status, isLoading);
          const currentShelfLimit = shelfLimits[actor.id] ?? SHELF_INITIAL_COUNT;
          const shelfSlice = sliceShelfItems(items, currentShelfLimit);

          return (
            <div
              key={actor.id}
              id={`actor-accordion-${actor.id}`}
              className={`actor-accordion ${isOpen ? 'is-open' : 'is-closed'}`}
            >
              <div className="actor-accordion-head">
                <button
                  type="button"
                  className="actor-accordion-trigger"
                  onClick={() => toggleAccordion(actor.id)}
                  aria-expanded={isOpen}
                  aria-controls={`actor-panel-${actor.id}`}
                >
                  <span className="accordion-chevron" aria-hidden="true">
                    {isOpen ? '▾' : '▸'}
                  </span>{' '}
                  <span className="actor-accordion-name">{actor.name}</span>{' '}
                  <span className="actor-accordion-badge tabular-nums">
                    {isOpen || actorCreditsMap[actor.id] ? `${items.length} öneri` : 'Açmak için dokun'}
                  </span>
                  {chipState.state === 'success' && (
                    <>
                      {' '}
                      <span className="actor-load-status is-success" title="Filmografi yüklendi">
                        ✓ yüklü
                      </span>
                    </>
                  )}
                  {isActorLoading && (
                    <>
                      {' '}
                      <span className="actor-load-status is-loading" title="Yükleniyor…">
                        ◔ yükleniyor
                      </span>
                    </>
                  )}
                </button>

                <div className="actor-accordion-head-right">
                  {onOpenPerson && (
                    <button
                      type="button"
                      className="actor-all-view-btn"
                      onClick={() => onOpenPerson(actor.id, actor.name)}
                      title={`${actor.name} profilini aç`}
                    >
                      Profili Gör
                    </button>
                  )}
                  {items.length > 5 && (
                    <button
                      type="button"
                      className="actor-all-view-btn tabular-nums"
                      onClick={() => setAllViewActor(actor)}
                      title={`${actor.name} için tüm ${items.length} öneriyi gör`}
                    >
                      Tümünü gör ({items.length}) →
                    </button>
                  )}
                  <button
                    type="button"
                    className="actor-toggle-icon-btn"
                    onClick={() => toggleAccordion(actor.id)}
                    aria-label={
                      isOpen ? `${actor.name} panelini kapat` : `${actor.name} panelini aç`
                    }
                    aria-expanded={isOpen}
                    aria-controls={`actor-panel-${actor.id}`}
                  >
                    {isOpen ? '—' : '+'}
                  </button>
                </div>
              </div>

              {isOpen && (
                <div
                  id={`actor-panel-${actor.id}`}
                  className="actor-shelf-panel"
                  role="region"
                  aria-label={`${actor.name} önerileri`}
                >
                  {items.length === 0 ? (
                    <div className="actor-shelf-empty">
                      {isActorLoading
                        ? 'İçerikler yükleniyor…'
                        : 'Bu oyuncu için kriterlere uygun öneri bulunamadı veya tüm yapımları listenizde.'}
                    </div>
                  ) : (
                    <div className="actor-horizontal-shelf">
                      {shelfSlice.visible.map((item) => (
                        <div
                          key={makeMediaKey(item.media_type, item.id)}
                          className="actor-shelf-item"
                        >
                          <MediaCard
                            item={item}
                            savedItem={findSavedItem(savedItems, item)}
                            genres={genresMap}
                            size="sm"
                            context="actor"
                            showMatch={true}
                            onOpenDetails={onOpenDetails}
                            onQuickAdd={onQuickAdd}
                            onSetStatus={onSetStatus}
                            onQuickSave={onQuickSave}
                          />
                        </div>
                      ))}
                      {shelfSlice.remaining > 0 && (
                        <div className="actor-shelf-item shelf-load-more-wrap">
                          <button
                            type="button"
                            className="shelf-load-more-card tabular-nums"
                            onClick={() =>
                              setShelfLimits((prev) => ({
                                ...prev,
                                [actor.id]: currentShelfLimit + SHELF_INITIAL_COUNT,
                              }))
                            }
                          >
                            <strong>Daha fazla göster</strong>
                            <span>
                              +{Math.min(SHELF_INITIAL_COUNT, shelfSlice.remaining)} yapım daha (kalan{' '}
                              {shelfSlice.remaining})
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

      <PaginatedMediaModal
        isOpen={Boolean(allViewActor)}
        title={allViewActor ? `${allViewActor.name} — Tüm Öneriler` : ''}
        subtitle="Kişisel zevkine ve puanlarına göre filtrelenmiş yapımlar"
        items={allViewActor ? actorItemsMap.get(allViewActor.id) || [] : []}
        savedItems={savedItems}
        dislikedKeys={dislikedKeys}
        genresMap={genresMap}
        context="actor"
        onClose={() => setAllViewActor(null)}
        onOpenDetails={onOpenDetails}
        onQuickAdd={onQuickAdd}
        onSetStatus={onSetStatus}
        onQuickSave={onQuickSave}
      />
    </section>
  );
};

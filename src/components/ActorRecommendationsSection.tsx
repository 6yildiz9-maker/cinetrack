import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  FavoriteActorInfo,
  ActorRecommendationItem,
  scoreActorRecommendations,
  SavedItem,
  findSavedItem,
  makeMediaKey,
  createRequestGate,
  fetchActorCreditsBatch,
  ActorFetchStatus,
  normalizeFavoriteActors,
  describeActorFetchChipState,
} from '../core/cinetrack-core';
import { fetchTmdbCached, TMDB_CACHE_TTLS } from '../services/api';
import { TmdbItem, TmdbPersonCreditItem } from '../types/tmdb';
import { MediaCard } from './MediaCard';

interface ActorRecommendationsSectionProps {
  favoriteActors: FavoriteActorInfo[];
  savedItems: SavedItem[];
  dislikedKeys: string[];
  genresMap: Record<number, string>;
  preferredProviders?: string[];
  providerIndex?: Record<string, Array<{ id: number | string; name?: string }>>;
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
    return raw ? JSON.parse(raw) : {};
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
  const [isLoading, setIsLoading] = useState<boolean>(() => validFavoriteActors.length > 0);
  const [sortMode, setSortMode] = useState<'best_match' | 'newest' | 'hidden_gems'>('best_match');
  const [typeFilter, setTypeFilter] = useState<'all' | 'movie' | 'tv'>('all');
  const [enableDiversity, setEnableDiversity] = useState<boolean>(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Accordion open/closed states persisted in localStorage
  const [openAccordions, setOpenAccordions] = useState<Record<number, boolean>>(() => {
    const saved = loadAccordionStates();
    // Default the first 2 actors to open if not saved yet
    if (Object.keys(saved).length === 0 && validFavoriteActors.length > 0) {
      const initial: Record<number, boolean> = {};
      validFavoriteActors.slice(0, 2).forEach((a) => {
        initial[a.id] = true;
      });
      return initial;
    }
    return saved;
  });

  // Modal for "Tümünü Gör" per actor
  const [allViewActor, setAllViewActor] = useState<FavoriteActorInfo | null>(null);

  const requestGateRef = useRef(createRequestGate());
  const actorCreditsCacheRef = useRef<
    Map<number, { at: number; credits: TmdbPersonCreditItem[]; status: ActorFetchStatus }>
  >(new Map());

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

  const loadCredits = useCallback(
    async (force = false) => {
      if (validFavoriteActors.length === 0) {
        setActorCreditsMap({});
        setActorStatuses({});
        setIsLoading(false);
        return;
      }

      if (force) {
        actorCreditsCacheRef.current.clear();
      }

      const now = Date.now();
      const cachedCredits: Record<number, TmdbPersonCreditItem[]> = {};
      const cachedStatuses: Record<number, ActorFetchStatus> = {};
      const actorsToFetch: FavoriteActorInfo[] = [];

      for (const actor of validFavoriteActors) {
        const hit = !force ? actorCreditsCacheRef.current.get(actor.id) : undefined;
        if (hit && now - hit.at < TMDB_CACHE_TTLS.ACTOR_CREDITS && hit.status.status !== 'error') {
          cachedCredits[actor.id] = hit.credits;
          cachedStatuses[actor.id] = hit.status;
        } else {
          actorsToFetch.push(actor);
        }
      }

      if (actorsToFetch.length === 0) {
        setActorCreditsMap(cachedCredits);
        setActorStatuses(cachedStatuses);
        setFetchError(null);
        setIsLoading(false);
        return;
      }

      const ticket = requestGateRef.current.begin();
      setActorCreditsMap((prev) => ({ ...prev, ...cachedCredits }));
      setActorStatuses((prev) => ({ ...prev, ...cachedStatuses }));
      setIsLoading(Object.keys(cachedCredits).length === 0);
      setFetchError(null);

      try {
        const result = await fetchActorCreditsBatch(actorsToFetch, {
          concurrency: 3,
          signal: ticket.signal,
          ticketId: ticket.id,
          isCurrentTicket: (id) => requestGateRef.current.isCurrent(id),
          force,
          fetchTmdbFn: fetchTmdbCached,
          onActorStatusChange: (status) => {
            if (!requestGateRef.current.isCurrent(ticket.id)) return;
            setActorStatuses((prev) => ({ ...prev, [status.actorId]: status }));
          },
        });

        if (!requestGateRef.current.isCurrent(ticket.id)) return;

        const fetchedAt = Date.now();
        for (const actor of actorsToFetch) {
          const st = result.statuses[actor.id];
          const cr = (result.creditsMap[actor.id] || []) as TmdbPersonCreditItem[];
          if (st && st.status !== 'error') {
            actorCreditsCacheRef.current.set(actor.id, {
              at: fetchedAt,
              credits: cr,
              status: st,
            });
          }
        }

        setActorCreditsMap({ ...cachedCredits, ...result.creditsMap });
        setActorStatuses({ ...cachedStatuses, ...result.statuses });
        if (result.errorCount > 0 && result.completedCount === 0 && Object.keys(cachedCredits).length === 0) {
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
    [validFavoriteActors]
  );

  useEffect(() => {
    void loadCredits();
  }, [loadCredits]);

  const rawRecommendations = useMemo(() => {
    if (validFavoriteActors.length === 0) return [];
    return scoreActorRecommendations({
      favoriteActors: validFavoriteActors,
      actorCreditsMap,
      savedItems,
      dislikedKeys,
      genresMap,
      providerIndex,
      preferredProviders,
      sortMode,
      enableDiversity,
      maxPerGenre: 4,
    });
  }, [
    validFavoriteActors,
    actorCreditsMap,
    savedItems,
    dislikedKeys,
    genresMap,
    providerIndex,
    preferredProviders,
    sortMode,
    enableDiversity,
  ]);

  const filteredRecommendations = useMemo(() => {
    if (typeFilter === 'all') return rawRecommendations;
    return rawRecommendations.filter((item) => item.media_type === typeFilter);
  }, [rawRecommendations, typeFilter]);

  // Map recommendations per actor
  const actorItemsMap = useMemo(() => {
    const map = new Map<number, ActorRecommendationItem[]>();
    for (const actor of validFavoriteActors) {
      const items = filteredRecommendations.filter((item) =>
        item.matchedActors?.some((a) => a.id === actor.id)
      );
      map.set(actor.id, items);
    }
    return map;
  }, [validFavoriteActors, filteredRecommendations]);

  if (validFavoriteActors.length === 0) {
    return null;
  }

  return (
    <section className="actor-recs-wrap" aria-labelledby="actorRecsHeading">
      <div className="actor-recs-head">
        <div>
          <div className="actor-recs-title">
            <span className="badge badge-kind">Kadro Keşfi</span>
            <h3 id="actorRecsHeading">Favori Oyuncularımdan Öneriler</h3>
          </div>
          <p className="actor-recs-sub">
            Favori oyuncularının yer aldığı, kişisel puanlarına ve kadro sırasına göre seçilmiş yapımlar.
          </p>
        </div>

        <div className="actor-recs-controls">
          <button
            type="button"
            className={`actor-recs-tab-btn ${sortMode === 'best_match' ? 'active' : ''}`}
            onClick={() => setSortMode('best_match')}
            aria-pressed={sortMode === 'best_match'}
            title="En güçlü eşleşen yapımları öne çıkarır"
          >
            En Güçlü Eşleşmeler
          </button>
          <button
            type="button"
            className={`actor-recs-tab-btn ${sortMode === 'hidden_gems' ? 'active' : ''}`}
            onClick={() => setSortMode('hidden_gems')}
            aria-pressed={sortMode === 'hidden_gems'}
            title="Gözden kaçmış, yüksek puanlı yapımları keşfeder"
          >
            Gizli Cevherler
          </button>
          <button
            type="button"
            className={`actor-recs-tab-btn ${sortMode === 'newest' ? 'active' : ''}`}
            onClick={() => setSortMode('newest')}
            aria-pressed={sortMode === 'newest'}
            title="En yeni yapımları gösterir"
          >
            En Yeniler
          </button>

          <select
            className="actor-recs-type-select"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as 'all' | 'movie' | 'tv')}
            aria-label="Öneri içerik türü"
          >
            <option value="all">Tümü ({rawRecommendations.length})</option>
            <option value="movie">Sadece Filmler</option>
            <option value="tv">Sadece Diziler</option>
          </select>

          {sortMode === 'best_match' && (
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
            onClick={() => void loadCredits(true)}
            disabled={isLoading}
            title="Önerileri yenile"
            aria-label="Önerileri yenile"
          >
            <span className={`refresh-icon ${isLoading ? 'spinning' : ''}`} aria-hidden="true">↻</span>{' '}
            <span>Yenile</span>
          </button>
        </div>
      </div>

      {/* Yatay Çip Şeridi: (Al Pacino 9) (Cillian 12) ... */}
      <div className="actor-chips-strip" role="tablist" aria-label="Favori oyuncu listesi">
        {validFavoriteActors.map((actor) => {
          const count = actorItemsMap.get(actor.id)?.length || 0;
          const isOpen = Boolean(openAccordions[actor.id]);
          return (
            <button
              key={actor.id}
              type="button"
              className={`actor-strip-chip ${isOpen ? 'is-active' : ''}`}
              onClick={() => {
                toggleAccordion(actor.id);
                const el = document.getElementById(`actor-accordion-${actor.id}`);
                el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              }}
              title={`${actor.name} için ${count} öneri`}
              aria-expanded={isOpen}
            >
              <span className="actor-strip-name">{actor.name}</span>{' '}
              <span className="actor-strip-count tabular-nums">{count}</span>
            </button>
          );
        })}
      </div>

      {fetchError && (
        <div className="message" role="alert">
          <strong>{fetchError}</strong>
          <button type="button" className="btn" onClick={() => void loadCredits(true)}>
            Tekrar dene
          </button>
        </div>
      )}

      {/* Akordiyon Rafları Listesi */}
      <div className="actor-accordions-container">
        {validFavoriteActors.map((actor) => {
          const items = actorItemsMap.get(actor.id) || [];
          const isOpen = Boolean(openAccordions[actor.id]);
          const status = actorStatuses[actor.id];
          const isActorLoading = status?.status === 'loading';
          const chipState = describeActorFetchChipState(actor, status, isLoading);

          return (
            <div
              key={actor.id}
              id={`actor-accordion-${actor.id}`}
              className={`actor-accordion ${isOpen ? 'is-open' : 'is-closed'}`}
            >
              {/* 56px Yüksekliğinde Akordiyon Başlığı */}
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
                    {items.length} öneri
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
                      className="actor-all-view-btn"
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
                    aria-label={isOpen ? `${actor.name} panelini kapat` : `${actor.name} panelini aç`}
                    aria-expanded={isOpen}
                    aria-controls={`actor-panel-${actor.id}`}
                  >
                    {isOpen ? '—' : '+'}
                  </button>
                </div>
              </div>

              {/* Yatay Raf (Shelf) */}
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
                      {items.map((item) => (
                        <div key={makeMediaKey(item.media_type, item.id)} className="actor-shelf-item">
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
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Tümünü Gör Modalı */}
      {allViewActor && (
        <div
          className="modal-wrap open"
          role="dialog"
          aria-modal="true"
          aria-labelledby="allActorTitle"
          onClick={() => setAllViewActor(null)}
        >
          <div className="modal actor-all-modal" onClick={(e) => e.stopPropagation()}>
            <div className="actor-all-header">
              <div>
                <h3 id="allActorTitle" className="modal-title">
                  {allViewActor.name} — Tüm Öneriler ({actorItemsMap.get(allViewActor.id)?.length || 0})
                </h3>
                <p className="modal-sub">
                  Kişisel zevkine ve puanlarına göre filtrelenmiş yapımlar
                </p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setAllViewActor(null)}
                aria-label="Kapat"
              >
                ✕
              </button>
            </div>
            <div className="actor-all-grid">
              {(actorItemsMap.get(allViewActor.id) || []).map((item) => (
                <MediaCard
                  key={makeMediaKey(item.media_type, item.id)}
                  item={item}
                  savedItem={findSavedItem(savedItems, item)}
                  genres={genresMap}
                  size="md"
                  context="actor"
                  showMatch={true}
                  onOpenDetails={onOpenDetails}
                  onQuickAdd={onQuickAdd}
                  onSetStatus={onSetStatus}
                  onQuickSave={onQuickSave}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  FavoriteActorInfo,
  ActorRecommendationItem,
  scoreActorRecommendations,
  calculateActorRoleBonus,
  SavedItem,
  findSavedItem,
  makeMediaKey,
  createRequestGate,
  fetchActorCreditsBatch,
  ActorFetchStatus,
  normalizeFavoriteActors,
  describeActorFetchChipState,
} from '../core/cinetrack-core';
import { fetchTmdbCached } from '../services/api';
import { displayTitle, getPoster, releaseYear } from '../utils/helpers';
import { TmdbItem, TmdbPersonCreditItem } from '../types/tmdb';

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

const IS_DEV = Boolean(import.meta.env.DEV);

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
  const [showDevPanel, setShowDevPanel] = useState<boolean>(false);
  const [inspectedCardKeys, setInspectedCardKeys] = useState<Set<string>>(new Set());
  const [fetchError, setFetchError] = useState<string | null>(null);

  const requestGateRef = useRef(createRequestGate());

  const loadCredits = useCallback(
    async (force = false) => {
      if (validFavoriteActors.length === 0) {
        setActorCreditsMap({});
        setActorStatuses({});
        setIsLoading(false);
        return;
      }

      const ticket = requestGateRef.current.begin();
      setIsLoading(true);
      setFetchError(null);

      try {
        const result = await fetchActorCreditsBatch(validFavoriteActors, {
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

        setActorCreditsMap(result.creditsMap);
        setActorStatuses(result.statuses);
        if (result.errorCount > 0 && result.completedCount === 0) {
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

  const toggleInspectCard = useCallback((key: string) => {
    setInspectedCardKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

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
      maxPerGenre: 3,
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

  if (validFavoriteActors.length === 0) {
    return null;
  }

  return (
    <section className="actor-recs-wrap" aria-labelledby="actorRecsHeading">
      <div className="actor-recs-head">
        <div>
          <div className="actor-recs-title">
            <span className="actor-recs-badge">Kadro Keşfi</span>
            <h3 id="actorRecsHeading">Oyuncularımdan Öneriler</h3>
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
            title="Gözden kaçmış, yüksek puanlı kaliteli yapımları keşfeder"
          >
            Gizli Cevherler
          </button>
          <button
            type="button"
            className={`actor-recs-tab-btn ${sortMode === 'newest' ? 'active' : ''}`}
            onClick={() => setSortMode('newest')}
            aria-pressed={sortMode === 'newest'}
            title="En yeni vizyona giren ve yakındaki yapımları gösterir"
          >
            En Yeniler & Yakında
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

          {IS_DEV && (
            <button
              type="button"
              className={`actor-recs-dev-toggle ${showDevPanel ? 'active' : ''}`}
              onClick={() => setShowDevPanel((v) => !v)}
              title="Tüm kartlarda 7 sinyal puanını ve ağırlık dökümünü gösterir"
              aria-pressed={showDevPanel}
            >
              {showDevPanel ? 'Algoritma Panelini Gizle' : 'Geliştirici / Sinyal Paneli'}
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
            <span className={`refresh-icon ${isLoading ? 'spinning' : ''}`}>↻</span>
            <span>Yenile</span>
          </button>
        </div>
      </div>

      {/* Oyuncu Bazında İstek Durumu */}
      <div className="actor-status-bar" aria-live="polite">
        <span className="actor-status-label">
          <span>Oyuncu Filmografileri</span>
          <span className="actor-status-meta">(Eşzamanlı limit: 3 · TTL: 2 sa)</span>
        </span>
        {validFavoriteActors.map((actor) => {
          const chip = describeActorFetchChipState(actor, actorStatuses[actor.id], isLoading);
          return (
            <span
              key={actor.id}
              className={`actor-status-chip is-${chip.state}`}
              title={chip.title}
            >
              <span className="actor-status-dot" aria-hidden="true"></span>
              <span className="actor-status-name">{actor.name}</span>
              {chip.state === 'success' && (
                <span className="actor-status-count">({chip.creditsCount})</span>
              )}
              {(chip.state === 'loading' || chip.state === 'pending') && (
                <span className="actor-status-count">…</span>
              )}
            </span>
          );
        })}
      </div>

      {fetchError && (
        <div className="message" role="alert">
          <strong>{fetchError}</strong>
          <button
            type="button"
            className="btn"
            onClick={() => void loadCredits(true)}
          >
            Tekrar dene
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="grid">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton-card" aria-hidden="true"></div>
          ))}
        </div>
      ) : filteredRecommendations.length === 0 ? (
        <div className="actor-recs-empty">
          <strong>Henüz yeni bir öneri bulunamadı</strong>
          <p>
            Favori oyuncularının tüm yapımlarını listene eklemiş olabilirsin veya kriterlere uygun yeni bir yapım henüz bulunamadı.
          </p>
        </div>
      ) : (
        <div className="grid">
          {filteredRecommendations.slice(0, 24).map((item) => {
            const key = makeMediaKey(item.media_type, item.id);
            const title = displayTitle(item);
            const poster = getPoster(item);
            const year = releaseYear(item);
            const kind = item.media_type === 'tv' ? 'Dizi' : 'Film';
            const saved = findSavedItem(savedItems, item);
            const isWatchlist = saved?.status === 'watchlist';
            const isCompleted = saved?.status === 'completed';
            const breakdown = item.signalBreakdown;
            const isInspected = IS_DEV && (showDevPanel || inspectedCardKeys.has(key));

            const confBadgeClass =
              item.confidenceLevel === 'high'
                ? 'conf-high'
                : item.confidenceLevel === 'medium'
                ? 'conf-medium'
                : 'conf-low';

            const confText =
              item.confidenceLevel === 'high'
                ? `%${item.confidenceScore} Yüksek Güven`
                : item.confidenceLevel === 'medium'
                ? `%${item.confidenceScore} Orta Güven`
                : `%${item.confidenceScore} Keşif / Az Veri`;

            return (
              <article key={key} className="card actor-rec-card">
                <div
                  className="poster"
                  role="button"
                  tabIndex={0}
                  aria-label={`${title} detaylarını gör`}
                  onClick={() => onOpenDetails(item)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenDetails(item);
                    }
                  }}
                >
                  <div className="poster-fallback" aria-hidden="true">
                    <svg className="icon">
                      <use href="#icon-film"></use>
                    </svg>
                    <span className="poster-fallback-title">{title}</span>
                  </div>

                  {poster && (
                    <img
                      src={poster}
                      alt=""
                      loading="lazy"
                      onError={(e) => ((e.target as HTMLElement).style.display = 'none')}
                    />
                  )}

                  <span className="badge">{kind}</span>

                  {Number(item.matchScore) > 0 && (
                    <span
                      className="match-badge"
                      title={`Gerçek sinyal uyum puanı: %${item.matchScore}`}
                      aria-label={`Uyum: %${item.matchScore}`}
                    >
                      %{item.matchScore} Uyum
                    </span>
                  )}

                  <span
                    className={`actor-rec-confidence-badge ${confBadgeClass}`}
                    title={`Algoritma Güven Düzeyi: %${item.confidenceScore} (${item.confidenceLevel})`}
                  >
                    {confText}
                  </span>

                  {saved && (
                    <span className={`saved-badge status-${saved.status}`}>
                      <svg className="icon" aria-hidden="true">
                        <use
                          href={
                            saved.status === 'completed'
                              ? '#icon-check'
                              : saved.status === 'watching'
                              ? '#icon-play'
                              : '#icon-bookmark'
                          }
                        ></use>
                      </svg>
                      {saved.status === 'completed'
                        ? 'İzlendi'
                        : saved.status === 'watching'
                        ? 'İzleniyor'
                        : 'İzlenecek'}
                    </span>
                  )}
                </div>

                <div className="card-info actor-rec-card-info">
                  <div>
                    <button
                      className="card-title"
                      type="button"
                      onClick={() => onOpenDetails(item)}
                    >
                      {title}
                    </button>

                    <div className="card-meta">
                      {year && <span className="card-date">{year}</span>}
                      {Number(item.vote_average) > 0 && (
                        <span className="actor-rec-rating">
                          <svg className="icon" aria-hidden="true">
                            <use href="#icon-star"></use>
                          </svg>{' '}
                          {Number(item.vote_average).toFixed(1)}
                        </span>
                      )}
                    </div>

                    <div className="actor-rec-matched-list">
                      {(item.matchedActors || []).map((actor) => {
                        const roleInfo = calculateActorRoleBonus(actor.order);
                        return (
                          <button
                            key={actor.id}
                            type="button"
                            className="actor-rec-matched-pill"
                            title={`${actor.name} filmografisini gör (${roleInfo.label})`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenPerson?.(actor.id, actor.name);
                            }}
                          >
                            <svg className="icon" aria-hidden="true">
                              <use href="#icon-star"></use>
                            </svg>
                            <span>{actor.name}</span>
                            {actor.character && (
                              <span className="actor-rec-character">({actor.character})</span>
                            )}
                            <span className="actor-rec-role-badge">{roleInfo.label}</span>
                          </button>
                        );
                      })}
                    </div>

                    {item.reason && (
                      <div className="actor-rec-reason">
                        <strong>Neden önerildi?</strong>
                        <span>{item.reason}</span>
                      </div>
                    )}

                    {IS_DEV && (
                      <button
                        type="button"
                        className="actor-rec-inspect-btn"
                        onClick={() => toggleInspectCard(key)}
                        title="Bu yapımın sinyal puanlarını ayrıntılı gör"
                      >
                        <span>{isInspected ? 'Sinyal Puanlarını Kapat' : 'Sinyal Puanlarını İncele'}</span>
                      </button>
                    )}

                    {IS_DEV && isInspected && breakdown && (
                      <div className="actor-rec-dev-panel">
                        <div className="actor-rec-dev-header">
                          <span>Algoritma Sinyalleri</span>
                          <span>Skor: %{item.matchScore}</span>
                        </div>

                        <div className="actor-rec-dev-row">
                          <div className="actor-rec-dev-row-top">
                            <span className="actor-rec-dev-label">
                              Oyuncu & Kadro Sırası ({breakdown.actorRoleText}):
                            </span>
                            <span className="actor-rec-dev-val">{breakdown.actorPresence} / 30</span>
                          </div>
                        </div>

                        {breakdown.multiActorBonus > 0 && (
                          <div className="actor-rec-dev-row">
                            <div className="actor-rec-dev-row-top">
                              <span className="actor-rec-dev-label">Çoklu Favori Oyuncu:</span>
                              <span className="actor-rec-dev-val">+{breakdown.multiActorBonus} / 10</span>
                            </div>
                          </div>
                        )}

                        <div className="actor-rec-dev-row">
                          <div className="actor-rec-dev-row-top">
                            <span className="actor-rec-dev-label">Sevilen Tür Uyumu:</span>
                            <span className="actor-rec-dev-val">{breakdown.genreScore} / 20</span>
                          </div>
                        </div>

                        <div className="actor-rec-dev-row">
                          <div className="actor-rec-dev-row-top">
                            <span className="actor-rec-dev-label">Kullanıcı Puan Zevki (1-10):</span>
                            <span className="actor-rec-dev-val">{breakdown.tasteScore} / 15</span>
                          </div>
                          <span className="actor-rec-dev-detail-sub">{breakdown.tasteExplanation}</span>
                        </div>

                        <div className="actor-rec-dev-row">
                          <div className="actor-rec-dev-row-top">
                            <span className="actor-rec-dev-label">TMDB Kalite (Bayes):</span>
                            <span className="actor-rec-dev-val">{breakdown.qualityScore} / 10</span>
                          </div>
                        </div>

                        <div className="actor-rec-dev-row">
                          <div className="actor-rec-dev-row-top">
                            <span className="actor-rec-dev-label">Vizyon & Güncellik:</span>
                            <span className="actor-rec-dev-val">{breakdown.recencyScore} / 5</span>
                          </div>
                        </div>

                        <div className="actor-rec-dev-row">
                          <div className="actor-rec-dev-row-top">
                            <span className="actor-rec-dev-label">
                              Platform Uyumu {breakdown.platformVerified ? '✓ Doğrulandı' : '(Nötr)'}:
                            </span>
                            <span className="actor-rec-dev-val">{breakdown.platformScore} / 10</span>
                          </div>
                        </div>

                        <div className="actor-rec-dev-footer">
                          <span>Ham Toplam: {breakdown.rawTotal} / 100</span>
                          <span>Güven: %{breakdown.confidenceScore}</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="actor-rec-actions">
                    <button
                      type="button"
                      className={`actor-rec-action-btn actor-rec-action-watchlist ${isWatchlist ? 'is-active' : ''}`}
                      title={isWatchlist ? 'İzlenecekler listesinde (Düzenle)' : 'İzlenecek listesine doğrudan ekle'}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isWatchlist) {
                          onQuickSave(item);
                        } else {
                          onQuickAdd(item);
                        }
                      }}
                    >
                      <svg className="icon" aria-hidden="true">
                        <use href={isWatchlist ? '#icon-check' : '#icon-plus'}></use>
                      </svg>
                      <span>{isWatchlist ? 'Listede' : '+ İzle'}</span>
                    </button>

                    <button
                      type="button"
                      className={`actor-rec-action-btn actor-rec-action-completed ${isCompleted ? 'is-active' : ''}`}
                      title={isCompleted ? 'İzlendi olarak işaretli' : 'İzlendi olarak kaydet'}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isCompleted) {
                          onQuickSave(item);
                        } else {
                          onSetStatus(item, 'completed');
                        }
                      }}
                    >
                      <svg className="icon" aria-hidden="true">
                        <use href="#icon-check"></use>
                      </svg>
                      <span>{isCompleted ? 'İzlendi' : '✓ İzlendi'}</span>
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};

export default ActorRecommendationsSection;

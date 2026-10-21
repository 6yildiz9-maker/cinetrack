import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  FavoriteActorInfo,
  ActorRecommendationItem,
  scoreActorRecommendations,
  SavedItem,
  findSavedItem,
  makeMediaKey,
} from '../core/cinetrack-core';
import { fetchTmdbCached } from '../services/api';
import { displayTitle, getPoster, releaseYear } from '../utils/helpers';

interface ActorRecommendationsSectionProps {
  favoriteActors: FavoriteActorInfo[];
  savedItems: SavedItem[];
  dislikedKeys: string[];
  genresMap: Record<number, string>;
  onOpenDetails: (item: any) => void;
  onQuickAdd: (item: any) => void;
  onSetStatus: (item: any, status: 'watching' | 'watchlist' | 'completed') => void;
  onQuickSave: (item: any) => void;
  onOpenPerson?: (id: number, name: string) => void;
}

export const ActorRecommendationsSection: React.FC<ActorRecommendationsSectionProps> = ({
  favoriteActors,
  savedItems,
  dislikedKeys,
  genresMap,
  onOpenDetails,
  onQuickAdd,
  onSetStatus,
  onQuickSave,
  onOpenPerson,
}) => {
  const [actorCreditsMap, setActorCreditsMap] = useState<Record<number, any[]>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [sortMode, setSortMode] = useState<'best_match' | 'newest'>('best_match');
  const [typeFilter, setTypeFilter] = useState<'all' | 'movie' | 'tv'>('all');
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Favori oyuncuların combined_credits verilerini çek
  const loadCredits = useCallback(
    async (force = false) => {
      if (!favoriteActors || favoriteActors.length === 0) {
        setActorCreditsMap({});
        return;
      }

      setIsLoading(true);
      setFetchError(null);
      const newMap: Record<number, any[]> = {};

      try {
        await Promise.all(
          favoriteActors.map(async (actor) => {
            if (!actor || !actor.id) return;
            try {
              // Önce Türkçe ardından İngilizce yedek
              let data: any = null;
              if (!force) {
                data = await fetchTmdbCached(`/person/${actor.id}/combined_credits`, {
                  language: 'tr-TR',
                }).catch(() => null);
              }
              if (!data || !Array.isArray(data.cast) || data.cast.length === 0) {
                data = await fetchTmdbCached(`/person/${actor.id}/combined_credits`, {
                  language: 'en-US',
                }).catch(() => null);
              }
              if (data && Array.isArray(data.cast)) {
                newMap[actor.id] = data.cast;
              } else {
                newMap[actor.id] = [];
              }
            } catch (err) {
              console.warn(`Actor credits fetch error (${actor.id}):`, err);
              newMap[actor.id] = [];
            }
          })
        );
        setActorCreditsMap(newMap);
      } catch (err: any) {
        console.error('Failed to load actor recommendations:', err);
        setFetchError('Öneriler yüklenirken bir sorun oluştu.');
      } finally {
        setIsLoading(false);
      }
    },
    [favoriteActors]
  );

  useEffect(() => {
    loadCredits();
  }, [loadCredits]);

  // Önerileri puanla ve filtrele
  const rawRecommendations = useMemo(() => {
    if (!favoriteActors || favoriteActors.length === 0) return [];
    return scoreActorRecommendations({
      favoriteActors,
      actorCreditsMap,
      savedItems,
      dislikedKeys,
      genresMap,
      sortMode,
    });
  }, [favoriteActors, actorCreditsMap, savedItems, dislikedKeys, genresMap, sortMode]);

  const filteredRecommendations = useMemo(() => {
    if (typeFilter === 'all') return rawRecommendations;
    return rawRecommendations.filter((item) => item.media_type === typeFilter);
  }, [rawRecommendations, typeFilter]);

  if (!favoriteActors || favoriteActors.length === 0) {
    return null;
  }

  return (
    <section className="actor-recs-wrap" aria-labelledby="actorRecsHeading">
      <div className="actor-recs-head">
        <div>
          <div className="actor-recs-title">
            <span className="actor-recs-badge">Öneri Motoru</span>
            <h3 id="actorRecsHeading">🎬 Oyuncularımdan Öneriler</h3>
          </div>
          <p className="actor-recs-sub">
            Favori oyuncularının yer aldığı, henüz izlemediğin ve ilgini çekebilecek yapımlar.
          </p>
        </div>

        <div className="actor-recs-controls">
          <button
            type="button"
            className={`actor-recs-tab-btn ${sortMode === 'best_match' ? 'active' : ''}`}
            onClick={() => setSortMode('best_match')}
            aria-pressed={sortMode === 'best_match'}
          >
            🎯 En Güçlü Eşleşmeler
          </button>
          <button
            type="button"
            className={`actor-recs-tab-btn ${sortMode === 'newest' ? 'active' : ''}`}
            onClick={() => setSortMode('newest')}
            aria-pressed={sortMode === 'newest'}
          >
            ✨ En Yeniler & Yakında
          </button>

          <select
            className="actor-recs-type-select"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as any)}
            aria-label="Öneri içerik türü"
          >
            <option value="all">Tümü ({rawRecommendations.length})</option>
            <option value="movie">Sadece Filmler</option>
            <option value="tv">Sadece Diziler</option>
          </select>

          <button
            type="button"
            className="for-you-head-refresh-btn"
            onClick={() => loadCredits(true)}
            disabled={isLoading}
            title="Önerileri yenile"
            aria-label="Önerileri yenile"
          >
            <span className={`refresh-icon ${isLoading ? 'spinning' : ''}`}>🔄</span>
            <span>Yenile</span>
          </button>
        </div>
      </div>

      {fetchError && (
        <div className="message" style={{ marginBottom: '16px' }}>
          <strong>{fetchError}</strong>
          <button
            type="button"
            className="btn"
            style={{ marginTop: '8px' }}
            onClick={() => loadCredits(true)}
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
          {filteredRecommendations.slice(0, 20).map((item) => {
            const title = displayTitle(item);
            const poster = getPoster(item);
            const year = releaseYear(item);
            const kind = item.media_type === 'tv' ? 'Dizi' : 'Film';
            const saved = findSavedItem(savedItems, item);
            const isWatchlist = saved?.status === 'watchlist';
            const isCompleted = saved?.status === 'completed';

            return (
              <article key={makeMediaKey(item.media_type, item.id)} className="card actor-rec-card">
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

                  <span
                    className="match-badge"
                    title={`Zevk & oyuncu uyumu: %${item.matchScore}`}
                    aria-label={`Uyum: %${item.matchScore}`}
                  >
                    🎯 %{item.matchScore} Uyum
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

                <div className="card-info" style={{ display: 'flex', flexDirection: 'column', flex: 1, justifyContent: 'space-between' }}>
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
                        <span className="rating-pill" style={{ color: '#fbbf24', fontSize: '10px', fontWeight: 800 }}>
                          ⭐ {Number(item.vote_average).toFixed(1)}
                        </span>
                      )}
                    </div>

                    {/* Eşleşen favori oyuncular */}
                    <div style={{ marginTop: '6px' }}>
                      {item.matchedActors.map((actor: any) => (
                        <button
                          key={actor.id}
                          type="button"
                          className="actor-rec-matched-pill"
                          title={`${actor.name} filmografisini gör`}
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
                            <span style={{ color: '#94a3b8', fontWeight: 500 }}>
                              ({actor.character})
                            </span>
                          )}
                        </button>
                      ))}
                    </div>

                    {/* Neden önerildi gerekçe kutusu */}
                    {item.reason && (
                      <div className="actor-rec-reason">
                        <strong>Neden önerildi?</strong>
                        <span>{item.reason}</span>
                      </div>
                    )}
                  </div>

                  {/* Hızlı aksiyon butonları */}
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
                      <svg className="icon" aria-hidden="true" style={{ width: '13px', height: '13px' }}>
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
                      <svg className="icon" aria-hidden="true" style={{ width: '13px', height: '13px' }}>
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

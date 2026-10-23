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
} from '../core/cinetrack-core';
import { fetchTmdbCached } from '../services/api';
import { displayTitle, getPoster, releaseYear } from '../utils/helpers';

interface ActorRecommendationsSectionProps {
  favoriteActors: FavoriteActorInfo[];
  savedItems: SavedItem[];
  dislikedKeys: string[];
  genresMap: Record<number, string>;
  preferredProviders?: string[];
  providerIndex?: Record<string, any[]>;
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
  preferredProviders = [],
  providerIndex = {},
  onOpenDetails,
  onQuickAdd,
  onSetStatus,
  onQuickSave,
  onOpenPerson,
}) => {
  const [actorCreditsMap, setActorCreditsMap] = useState<Record<number, any[]>>({});
  const [actorStatuses, setActorStatuses] = useState<Record<number, ActorFetchStatus>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [sortMode, setSortMode] = useState<'best_match' | 'newest' | 'hidden_gems'>('best_match');
  const [typeFilter, setTypeFilter] = useState<'all' | 'movie' | 'tv'>('all');
  const [enableDiversity, setEnableDiversity] = useState<boolean>(true);
  const [showDevPanel, setShowDevPanel] = useState<boolean>(false);
  const [inspectedCardKeys, setInspectedCardKeys] = useState<Set<string>>(new Set());
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Eski yanıtları engelleme kapısı (RequestGate)
  const requestGateRef = useRef(createRequestGate());

  // Favori oyuncuların combined_credits verilerini sınırlı kuyruk ve in-flight korumasıyla çek
  const loadCredits = useCallback(
    async (force = false) => {
      if (!favoriteActors || favoriteActors.length === 0) {
        setActorCreditsMap({});
        setActorStatuses({});
        return;
      }

      const ticket = requestGateRef.current.begin();
      setIsLoading(true);
      setFetchError(null);

      try {
        const result = await fetchActorCreditsBatch(favoriteActors, {
          concurrency: 3, // Sınırlı kuyruk (max 3 eşzamanlı istek)
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

        // Eski yanıtları engelleme: Eğer bilet eskimişse sonucu yut
        if (!requestGateRef.current.isCurrent(ticket.id)) return;

        setActorCreditsMap(result.creditsMap);
        setActorStatuses(result.statuses);
        if (result.errorCount > 0 && result.completedCount === 0) {
          setFetchError('Favori oyuncuların içerikleri yüklenirken bir sorun oluştu.');
        }
      } catch (err: any) {
        if (!requestGateRef.current.isCurrent(ticket.id)) return;
        console.error('Failed to load actor recommendations:', err);
        setFetchError('Öneriler yüklenirken bir sorun oluştu.');
      } finally {
        if (requestGateRef.current.isCurrent(ticket.id)) {
          setIsLoading(false);
        }
      }
    },
    [favoriteActors]
  );

  useEffect(() => {
    loadCredits();
  }, [loadCredits]);

  // Kart detay teftişini aç/kapat
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

  // Önerileri puanla ve filtrele
  const rawRecommendations = useMemo(() => {
    if (!favoriteActors || favoriteActors.length === 0) return [];
    return scoreActorRecommendations({
      favoriteActors,
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
    favoriteActors,
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

  if (!favoriteActors || favoriteActors.length === 0) {
    return null;
  }

  return (
    <section className="actor-recs-wrap" aria-labelledby="actorRecsHeading">
      <div className="actor-recs-head">
        <div>
          <div className="actor-recs-title">
            <span className="actor-recs-badge">Öneri Motoru v2</span>
            <h3 id="actorRecsHeading">🎬 Oyuncularımdan Öneriler</h3>
          </div>
          <p className="actor-recs-sub">
            Favori oyuncularının yer aldığı, gerçek kullanıcı puanlarına ve kadro sırasına göre kişiselleştirilmiş keşifler.
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
            🎯 En Güçlü Eşleşmeler
          </button>
          <button
            type="button"
            className={`actor-recs-tab-btn ${sortMode === 'hidden_gems' ? 'active' : ''}`}
            onClick={() => setSortMode('hidden_gems')}
            aria-pressed={sortMode === 'hidden_gems'}
            title="Gözden kaçmış, yüksek puanlı kaliteli yapımları keşfeder"
          >
            💎 Gizli Cevherler
          </button>
          <button
            type="button"
            className={`actor-recs-tab-btn ${sortMode === 'newest' ? 'active' : ''}`}
            onClick={() => setSortMode('newest')}
            aria-pressed={sortMode === 'newest'}
            title="En yeni vizyona giren ve yakındaki yapımları gösterir"
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

          {sortMode === 'best_match' && (
            <button
              type="button"
              className={`actor-recs-tab-btn ${enableDiversity ? 'active' : ''}`}
              onClick={() => setEnableDiversity((v) => !v)}
              title="Aynı türün peş peşe yığılmasını önleyerek farklı türleri dengeler"
              aria-pressed={enableDiversity}
            >
              🌈 Çeşitlilik: {enableDiversity ? 'Açık' : 'Kapalı'}
            </button>
          )}

          <button
            type="button"
            className={`actor-recs-dev-toggle ${showDevPanel ? 'active' : ''}`}
            onClick={() => setShowDevPanel((v) => !v)}
            title="Tüm kartlarda 7 sinyal puanını ve ağırlık dökümünü gösterir"
            aria-pressed={showDevPanel}
          >
            🔬 {showDevPanel ? 'Algoritma Panelini Gizle' : 'Geliştirici / Sinyal Paneli'}
          </button>

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

      {/* Oyuncu Bazında İstek Durumu & Kuyruk Bilgisi */}
      <div className="flex flex-wrap items-center gap-2 mb-4 pt-1">
        <span className="text-xs text-slate-400 font-medium flex items-center gap-1.5 mr-1">
          <span>👥 Oyuncu İstekleri</span>
          <span className="text-[10px] text-slate-500 font-mono">(Eşzamanlı limit: 3 · TTL: 2 saat)</span>
          <span>:</span>
        </span>
        {favoriteActors.map((actor) => {
          const st = actorStatuses[actor.id];
          const isCurrentLoading = isLoading && (!st || st.status === 'loading');
          const isError = st?.status === 'error';
          const isEmpty = st?.status === 'empty';
          const isSuccess = st?.status === 'success';

          return (
            <span
              key={actor.id}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium transition-all ${
                isCurrentLoading
                  ? 'bg-amber-500/15 border-amber-500/30 text-amber-300 shadow-sm shadow-amber-950/20'
                  : isError
                  ? 'bg-rose-500/15 border-rose-500/30 text-rose-300'
                  : isEmpty
                  ? 'bg-slate-800/80 border-slate-700/80 text-slate-400'
                  : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
              }`}
              title={
                isCurrentLoading
                  ? `${actor.name}: Kuyrukta yükleniyor...`
                  : isError
                  ? `${actor.name}: ${st?.error || 'Hata'}`
                  : isEmpty
                  ? `${actor.name}: Filmografide uygun içerik bulunamadı`
                  : `${actor.name}: ${st.creditsCount} yapım yüklendi`
              }
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isCurrentLoading
                    ? 'bg-amber-400 animate-pulse'
                    : isError
                    ? 'bg-rose-400'
                    : isEmpty
                    ? 'bg-slate-500'
                    : 'bg-emerald-400'
                }`}
              ></span>
              <span className="truncate max-w-[130px]">{actor.name}</span>
              {isSuccess && <span className="opacity-70 font-mono text-[10px]">({st.creditsCount})</span>}
              {isCurrentLoading && <span className="opacity-70 text-[10px]">...</span>}
            </span>
          );
        })}
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
            const isInspected = showDevPanel || inspectedCardKeys.has(key);

            const confBadgeClass =
              item.confidenceLevel === 'high'
                ? 'conf-high'
                : item.confidenceLevel === 'medium'
                ? 'conf-medium'
                : 'conf-low';

            const confText =
              item.confidenceLevel === 'high'
                ? `🟢 %${item.confidenceScore} Yüksek Güven`
                : item.confidenceLevel === 'medium'
                ? `🟡 %${item.confidenceScore} Orta Güven`
                : `🔵 %${item.confidenceScore} Keşif / Az Veri`;

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

                  <span
                    className="match-badge"
                    title={`Gerçek sinyal uyum puanı: %${item.matchScore}`}
                    aria-label={`Uyum: %${item.matchScore}`}
                  >
                    🎯 %{item.matchScore} Uyum
                  </span>

                  {/* Güven Düzeyi Rozeti */}
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

                    {/* Eşleşen favori oyuncular ve kadro sırası rol verisi */}
                    <div style={{ marginTop: '6px' }}>
                      {item.matchedActors.map((actor: any) => {
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
                              <span style={{ color: '#94a3b8', fontWeight: 500 }}>
                                ({actor.character})
                              </span>
                            )}
                            <span className="actor-rec-role-badge">
                              {roleInfo.label}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Neden önerildi gerekçe kutusu */}
                    {item.reason && (
                      <div className="actor-rec-reason">
                        <strong>Neden önerildi?</strong>
                        <span>{item.reason}</span>
                      </div>
                    )}

                    {/* Geliştirici Sinyal İnceleme Butonu */}
                    <button
                      type="button"
                      className="actor-rec-inspect-btn"
                      onClick={() => toggleInspectCard(key)}
                      title="Bu yapımın sinyal puanlarını ayrıntılı gör"
                    >
                      <span>🔬 {isInspected ? 'Sinyal Puanlarını Kapat' : 'Sinyal Puanlarını İncele'}</span>
                    </button>

                    {/* Geliştirici / Algoritma Paneli (Aşama 2: Sinyal Dökümü) */}
                    {isInspected && breakdown && (
                      <div className="actor-rec-dev-panel">
                        <div className="actor-rec-dev-header">
                          <span>🔬 Algoritma Sinyalleri</span>
                          <span>Skor: %{item.matchScore}</span>
                        </div>

                        {/* Sinyal 1: Oyuncu & Kadro Sırası */}
                        <div className="actor-rec-dev-row">
                          <div className="actor-rec-dev-row-top">
                            <span className="actor-rec-dev-label">🎭 Oyuncu & Kadro Sırası ({breakdown.actorRoleText}):</span>
                            <span className="actor-rec-dev-val">{breakdown.actorPresence} / 30</span>
                          </div>
                          <div className="actor-rec-dev-bar-wrap">
                            <div
                              className="actor-rec-dev-bar"
                              style={{ width: `${(breakdown.actorPresence / 30) * 100}%`, background: '#38bdf8' }}
                            ></div>
                          </div>
                        </div>

                        {/* Sinyal 2: Çoklu Oyuncu Bonusu */}
                        {breakdown.multiActorBonus > 0 && (
                          <div className="actor-rec-dev-row">
                            <div className="actor-rec-dev-row-top">
                              <span className="actor-rec-dev-label">👥 Çoklu Favori Oyuncu:</span>
                              <span className="actor-rec-dev-val" style={{ color: '#fde047' }}>+{breakdown.multiActorBonus} / 10</span>
                            </div>
                            <div className="actor-rec-dev-bar-wrap">
                              <div
                                className="actor-rec-dev-bar"
                                style={{ width: '100%', background: '#eab308' }}
                              ></div>
                            </div>
                          </div>
                        )}

                        {/* Sinyal 3: Tür Uyumu */}
                        <div className="actor-rec-dev-row">
                          <div className="actor-rec-dev-row-top">
                            <span className="actor-rec-dev-label">🏷️ Sevilen Tür Uyumu:</span>
                            <span className="actor-rec-dev-val">{breakdown.genreScore} / 20</span>
                          </div>
                          <div className="actor-rec-dev-bar-wrap">
                            <div
                              className="actor-rec-dev-bar"
                              style={{ width: `${(breakdown.genreScore / 20) * 100}%`, background: '#a855f7' }}
                            ></div>
                          </div>
                        </div>

                        {/* Sinyal 4: Kullanıcı Puan Zevki */}
                        <div className="actor-rec-dev-row">
                          <div className="actor-rec-dev-row-top">
                            <span className="actor-rec-dev-label">🎯 Kullanıcı Puan Zevki (1-10):</span>
                            <span className="actor-rec-dev-val">{breakdown.tasteScore} / 15</span>
                          </div>
                          <div className="actor-rec-dev-bar-wrap">
                            <div
                              className="actor-rec-dev-bar"
                              style={{ width: `${(breakdown.tasteScore / 15) * 100}%`, background: '#ec4899' }}
                            ></div>
                          </div>
                          <span className="actor-rec-dev-detail-sub">{breakdown.tasteExplanation}</span>
                        </div>

                        {/* Sinyal 5: Genel Kalite */}
                        <div className="actor-rec-dev-row">
                          <div className="actor-rec-dev-row-top">
                            <span className="actor-rec-dev-label">⭐ TMDB Kalite (Bayes):</span>
                            <span className="actor-rec-dev-val">{breakdown.qualityScore} / 10</span>
                          </div>
                          <div className="actor-rec-dev-bar-wrap">
                            <div
                              className="actor-rec-dev-bar"
                              style={{ width: `${(breakdown.qualityScore / 10) * 100}%`, background: '#f59e0b' }}
                            ></div>
                          </div>
                        </div>

                        {/* Sinyal 6: Güncellik */}
                        <div className="actor-rec-dev-row">
                          <div className="actor-rec-dev-row-top">
                            <span className="actor-rec-dev-label">📅 Vizyon & Güncellik:</span>
                            <span className="actor-rec-dev-val">{breakdown.recencyScore} / 5</span>
                          </div>
                          <div className="actor-rec-dev-bar-wrap">
                            <div
                              className="actor-rec-dev-bar"
                              style={{ width: `${(breakdown.recencyScore / 5) * 100}%`, background: '#10b981' }}
                            ></div>
                          </div>
                        </div>

                        {/* Sinyal 7: Platform Uyumu */}
                        <div className="actor-rec-dev-row">
                          <div className="actor-rec-dev-row-top">
                            <span className="actor-rec-dev-label">
                              📺 Platform Uyumu {breakdown.platformVerified ? '✓ Doğrulandı' : '(Bilinmiyor, Nötr)'}:
                            </span>
                            <span className="actor-rec-dev-val">{breakdown.platformScore} / 10</span>
                          </div>
                          <div className="actor-rec-dev-bar-wrap">
                            <div
                              className="actor-rec-dev-bar"
                              style={{
                                width: `${(breakdown.platformScore / 10) * 100}%`,
                                background: breakdown.platformVerified ? '#06b6d4' : '#64748b',
                              }}
                            ></div>
                          </div>
                        </div>

                        {/* Alt Özet: Ham Toplam ve Güven */}
                        <div className="actor-rec-dev-footer">
                          <span>Ham Toplam: {breakdown.rawTotal} / 100</span>
                          <span style={{ color: breakdown.confidenceLevel === 'high' ? '#34d399' : '#fbbf24' }}>
                            Güven: %{breakdown.confidenceScore}
                          </span>
                        </div>
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

import React, { useState, useEffect } from 'react';
import { displayTitle, getPoster, imageUrl, releaseYear, RATING_DESCRIPTIONS, extractGenreNames, handleImageError } from '../utils/helpers.ts';
import {
  SavedItem,
  buildSeasonCounts,
  defaultCurrentSeason,
  findSavedItem,
  makeMediaKey,
  getTasteRingLabel,
} from '../core/cinetrack-core.ts';
import { fetchTmdb } from '../services/api.ts';
import { getItemSeriesInfo, indexMovieCollection } from '../services/series-service.ts';
import { subscribeSeriesIndex } from '../services/storage-idb.ts';
import { enrichStockItemsTopCast } from '../services/stock-engine.ts';
import { formatMatchBadge } from '../i18n/index.ts';
import { useDialogAccessibility } from '../utils/useDialogAccessibility.ts';

interface DetailModalProps {
  item: any | null;
  savedItem?: SavedItem;
  savedItems?: SavedItem[];
  isOpen: boolean;
  genresMap: Record<number, string>;
  isDisliked: boolean;
  isHidden?: boolean;
  favoriteActors?: any[];
  onClose: () => void;
  onSave: (
    item: any,
    status: 'watching' | 'watchlist' | 'completed',
    rating: number | '',
    tracking?: any
  ) => void;
  onRemove: (item: any) => void;
  onToggleDislike: (key: string) => void;
  onToggleHide?: (key: string) => void;
  onOpenPerson: (personId: number, personName: string) => void;
  onToggleFavoriteActor?: (actor: any) => void;
  onSelectMedia?: (item: any) => void;
}

export const DetailModal: React.FC<DetailModalProps> = ({
  item,
  savedItem,
  savedItems = [],
  isOpen,
  genresMap,
  isDisliked,
  isHidden = false,
  favoriteActors = [],
  onClose,
  onSave,
  onRemove,
  onToggleDislike,
  onToggleHide,
  onOpenPerson,
  onToggleFavoriteActor,
  onSelectMedia,
}) => {
  const [details, setDetails] = useState<any>(null);
  const [providers, setProviders] = useState<any>(null);
  const [similarItems, setSimilarItems] = useState<any[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [overviewFallbackUsed, setOverviewFallbackUsed] = useState<boolean>(false);
  const [status, setStatus] = useState<'watching' | 'watchlist' | 'completed'>('watchlist');
  const [personalRating, setPersonalRating] = useState<number | ''>('');
  const [currentSeason, setCurrentSeason] = useState<number>(1);
  const [seasonProgress, setSeasonProgress] = useState<Record<number, number>>({});
  const [seasonCounts, setSeasonCounts] = useState<Record<number, number>>({});
  const [, setSeriesRevision] = useState<number>(0);
  const dialogRef = useDialogAccessibility(isOpen, onClose);

  useEffect(() => {
    return subscribeSeriesIndex(() => {
      setSeriesRevision((v) => v + 1);
    });
  }, []);

  useEffect(() => {
    if (!item || !isOpen) {
      setDetails(null);
      setProviders(null);
      setSimilarItems([]);
      setDetailError(null);
      setOverviewFallbackUsed(false);
      return;
    }

    setDetailError(null);
    setOverviewFallbackUsed(false);

    if (item.custom) {
      setDetails({ ...item, media_type: item.media_type || 'movie' });
      return;
    }

    let active = true;
    const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
    fetchTmdb(`/${mediaType}/${item.id}`, { append_to_response: 'credits,videos' })
      .then(async (data) => {
        if (!active || !data) return;
        let resolvedOverview = typeof data.overview === 'string' ? data.overview.trim() : '';
        let usedFallback = false;

        if (!resolvedOverview && !String(item.overview || '').trim()) {
          try {
            const enData = await fetchTmdb(`/${mediaType}/${item.id}`, { language: 'en-US' });
            if (active && typeof enData?.overview === 'string' && enData.overview.trim()) {
              resolvedOverview = enData.overview.trim();
              usedFallback = true;
            }
          } catch {}
        }

        if (!active) return;
        setOverviewFallbackUsed(usedFallback);
        setDetails({
          ...data,
          overview: resolvedOverview || data.overview || '',
          media_type: mediaType,
        });
        if (Array.isArray(data.credits?.cast) && data.credits.cast.length > 0) {
          const top3Ids = data.credits.cast
            .slice(0, 3)
            .map((c: any) => Number(c?.id))
            .filter((n: number) => Number.isInteger(n) && n > 0);
          if (top3Ids.length > 0) {
            void enrichStockItemsTopCast({ [makeMediaKey(mediaType, item.id)]: top3Ids });
          }
        }
        if (mediaType === 'movie' && data.belongs_to_collection?.id) {
          void indexMovieCollection(Number(data.belongs_to_collection.id));
        }
        if (mediaType === 'tv' && data.seasons) {
          const counts = buildSeasonCounts(data);
          setSeasonCounts(counts);
        }
      })
      .catch((err) => {
        if (!active) return;
        console.warn('Details fetch error:', err);
        setDetailError(err?.message || 'İçerik ayrıntıları yüklenemedi.');
      });

    // Fetch providers
    setLoadingProviders(true);
    fetchTmdb(`/${mediaType}/${item.id}/watch/providers`)
      .then((data) => {
        if (!active) return;
        setProviders(data?.results?.TR || null);
      })
      .catch((err) => console.warn('Providers fetch error:', err))
      .finally(() => {
        if (active) setLoadingProviders(false);
      });

    fetchTmdb(`/${mediaType}/${item.id}/similar`)
      .then((data) => {
        if (!active) return;
        setSimilarItems(Array.isArray(data?.results) ? data.results : []);
      })
      .catch((err) => console.warn('Similar fetch error:', err));

    return () => {
      active = false;
    };
  }, [item?.id, item?.media_type, isOpen]);

  useEffect(() => {
    if (!isOpen || !item) return;
    setStatus(savedItem?.status || 'watchlist');
    setPersonalRating(
      savedItem && savedItem.personal_rating !== '' && Number(savedItem.personal_rating) > 0
        ? Number(savedItem.personal_rating)
        : ''
    );

    const initProgress = savedItem?.season_progress || {};
    const initCounts = savedItem?.season_episode_counts || {};
    setSeasonProgress(initProgress);
    if (Object.keys(initCounts).length > 0) {
      setSeasonCounts(initCounts);
    }
    setCurrentSeason(
      Number(savedItem?.current_season) || defaultCurrentSeason(initProgress, initCounts)
    );
  }, [item, isOpen, savedItem]);

  if (!isOpen || !item) return null;

  const currentItem = {
    ...item,
    ...(details || {}),
    media_type: item.media_type || details?.media_type || (item.title ? 'movie' : 'tv'),
  };
  const title = displayTitle(currentItem);
  const backdrop = currentItem.backdrop_path
    ? imageUrl(currentItem.backdrop_path, 'w780')
    : getPoster(currentItem);

  const genresList: string[] = extractGenreNames(currentItem, genresMap);

  const trailer = (currentItem.videos?.results || []).find(
    (v: any) => v.site === 'YouTube' && v.type === 'Trailer'
  );

  const cast = (currentItem.credits?.cast || [])
    .filter((p: any) => p.id != null && p.name)
    .slice(0, 10);

  const crewList: any[] = currentItem.credits?.crew || [];
  const crewOf = (jobs: string[]) => {
    const seen = new Set<string>();
    const picked: Array<{ id: number; name: string }> = [];
    for (const c of crewList) {
      if (!c || typeof c.job !== 'string' || jobs.indexOf(c.job) === -1) continue;
      if (c.id == null || !c.name || seen.has(c.name)) continue;
      seen.add(c.name);
      picked.push({ id: Number(c.id), name: c.name });
      if (picked.length >= 2) break;
    }
    return picked;
  };

  const productionNames: string[] = (currentItem.production_companies || [])
    .map((p: any) => (p && typeof p.name === 'string' ? p.name.trim() : ''))
    .filter(Boolean)
    .slice(0, 2);

  // filmizlehell tarzı yalın künye: yalnızca dolu satırlar gösterilir
  const kunyeRows: Array<{ label: string; persons?: Array<{ id: number; name: string }>; text?: string }> = [
    { label: 'Yönetmen', persons: crewOf(currentItem.media_type === 'tv' ? ['Series Director', 'Director'] : ['Director']) },
    currentItem.media_type === 'tv' ? { label: 'Yaratıcı', persons: crewOf(['Creator']) } : null,
    { label: 'Senaryo', persons: crewOf(['Screenplay', 'Writer', 'Teleplay']) },
    { label: 'Müzik', persons: crewOf(['Original Music Composer', 'Music', 'Songs']) },
    { label: 'Görüntü', persons: crewOf(['Director of Photography']) },
    { label: 'Yapım', persons: crewOf(currentItem.media_type === 'tv' ? ['Executive Producer'] : ['Producer']) },
    productionNames.length > 0 ? { label: 'Şirket', text: productionNames.join(', ') } : null,
  ].filter((row): row is NonNullable<typeof row> => Boolean(row) && Boolean(row!.persons?.length || row!.text));

  const similarList = similarItems
    .filter((s: any) => s && s.id != null && (s.title || s.name))
    .slice(0, 10);

  // TV Seasons & tracker
  const isTv = currentItem.media_type === 'tv' && !currentItem.custom;
  const seasonNumbers = [
    ...new Set([
      ...Object.keys(seasonCounts).map(Number),
      ...Object.keys(seasonProgress).map(Number),
      Number(savedItem?.current_season) || 0,
    ]),
  ]
    .filter((s) => Number.isSafeInteger(s) && s >= 1)
    .sort((a, b) => a - b);
  if (!seasonNumbers.length) seasonNumbers.push(1);

  const handleSeasonEpisodeChange = (season: number, val: number) => {
    const maxVal = seasonCounts[season] || 10000;
    const clamped = Math.max(0, Math.min(maxVal, Math.floor(val)));
    setSeasonProgress((prev) => ({
      ...prev,
      [season]: clamped,
    }));
  };

  let totalEpisodesWatched = 0;
  let knownEpisodesTotal = 0;
  seasonNumbers.forEach((s) => {
    const watched = seasonProgress[s] || 0;
    const count = seasonCounts[s] || 0;
    totalEpisodesWatched += watched;
    knownEpisodesTotal += count;
  });

  const overallPercent = knownEpisodesTotal
    ? Math.min(100, Math.round((totalEpisodesWatched / knownEpisodesTotal) * 100))
    : null;
  const nextEpNum = (seasonProgress[currentSeason] || 0) + 1;

  const handleQuickSetStatus = (newStatus: 'watching' | 'watchlist' | 'completed') => {
    setStatus(newStatus);
    let tracking = {};
    if (isTv) {
      tracking = {
        season_progress: seasonProgress,
        season_episode_counts: seasonCounts,
        current_season: currentSeason,
        next_episode: nextEpNum,
        episodes_watched: totalEpisodesWatched,
      };
    }
    onSave(currentItem, newStatus, personalRating, tracking);
  };

  const handleSave = () => {
    let tracking = {};
    if (isTv) {
      tracking = {
        season_progress: seasonProgress,
        season_episode_counts: seasonCounts,
        current_season: currentSeason,
        next_episode: nextEpNum,
        episodes_watched: totalEpisodesWatched,
      };
    }
    const effectiveStatus =
      typeof personalRating === 'number' && personalRating > 0 && (status === 'watchlist' || !status)
        ? 'completed'
        : status;
    onSave(currentItem, effectiveStatus, personalRating, tracking);
    onClose();
  };

  const handleRemove = () => {
    onRemove(currentItem);
    onClose();
  };

  const itemKey = makeMediaKey(currentItem);

  return (
    <div
      id="detailModal"
      className="modal-wrap open"
      aria-hidden="false"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <article
        ref={dialogRef}
        className="modal detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detailTitle"
        aria-describedby="detailOverview"
        tabIndex={-1}
      >
        <button className="modal-close" type="button" onClick={onClose} aria-label="Kapat">
          <svg className="icon" aria-hidden="true">
            <use href="#icon-close"></use>
          </svg>
        </button>

        {backdrop && (
          <div className="detail-backdrop-wrap">
            <img
              id="detailBackdrop"
              className="detail-backdrop"
              src={backdrop}
              alt=""
              referrerPolicy="no-referrer"
              onError={(e) => handleImageError(e, backdrop, 'w780')}
            />
            <div className="detail-backdrop-gradient" />
          </div>
        )}

        <div className="detail-content">
          <h2 id="detailTitle" className="detail-title font-display">
            {title}
          </h2>

          <div id="detailMeta" className="detail-meta">
            <span className="detail-meta-kind">
              {currentItem.custom ? 'Özel' : currentItem.media_type === 'tv' ? 'Dizi' : 'Film'}
            </span>
            <span>·</span>
            <span className="tabular-nums">{releaseYear(currentItem)}</span>
            {!currentItem.custom && currentItem.vote_average > 0 && (
              <>
                <span>·</span>
                <span className="tabular-nums">★ {Number(currentItem.vote_average).toFixed(1)} TMDB</span>
              </>
            )}
            {currentItem.runtime ? (
              <>
                <span>·</span>
                <span>{currentItem.runtime} dk</span>
              </>
            ) : currentItem.episode_run_time?.[0] ? (
              <>
                <span>·</span>
                <span>{currentItem.episode_run_time[0]} dk/bölüm</span>
              </>
            ) : null}
            {Number(currentItem.matchScore || item?.matchScore) > 0 && (
              <>
                <span>·</span>
                <span className="match-badge tabular-nums">
                  {formatMatchBadge(Number(currentItem.matchScore || item?.matchScore))}
                  {(currentItem.ring || item?.ring) && ` · ${getTasteRingLabel(currentItem.ring || item?.ring)}`}
                </span>
              </>
            )}
          </div>

          {/* Tür Rozetleri */}
          {genresList.length > 0 && (
            <div id="detailGenres" className="detail-tags" aria-label="Türler">
              {genresList.map((genre) => (
                <span key={genre} className="detail-tag">
                  {genre}
                </span>
              ))}
            </div>
          )}

          {/* Tek Satır Segmented Durum Seçici (Section 6.5) */}
          <div className="detail-status-segmented" role="group" aria-label="İzleme Durumu">
            <button
              type="button"
              className={`segmented-status-btn ${savedItem && status === 'completed' ? 'is-active is-completed' : ''}`}
              onClick={() => handleQuickSetStatus('completed')}
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-check"></use>
              </svg>
              <span>{savedItem && status === 'completed' ? 'İzlendi ✓' : 'İzlendi'}</span>
            </button>

            <button
              type="button"
              className={`segmented-status-btn ${savedItem && status === 'watching' ? 'is-active is-watching' : ''}`}
              onClick={() => handleQuickSetStatus('watching')}
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-play"></use>
              </svg>
              <span>{savedItem && status === 'watching' ? 'İzliyorum ▶' : 'İzliyorum'}</span>
            </button>

            <button
              type="button"
              className={`segmented-status-btn ${savedItem && status === 'watchlist' ? 'is-active is-watchlist' : ''}`}
              onClick={() => handleQuickSetStatus('watchlist')}
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-plus"></use>
              </svg>
              <span>{savedItem && status === 'watchlist' ? 'İzlenecek ✓' : 'İzlenecek'}</span>
            </button>

            <button
              type="button"
              className={`segmented-status-btn status-btn-dislike ${isDisliked ? 'is-active' : ''}`}
              onClick={() => onToggleDislike(itemKey)}
              title={isDisliked ? 'İlgilenmiyorum tercihini kaldır' : 'İlgilenmiyorum olarak işaretle (Zevk profiline negatif sinyal gönderir)'}
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-thumbs-down"></use>
              </svg>
              <span>{isDisliked ? 'İlgilenmiyorum ✕' : 'İlgilenmiyorum'}</span>
            </button>

            {onToggleHide && (
              <button
                type="button"
                className={`segmented-status-btn ${isHidden ? 'is-active' : ''}`}
                onClick={() => onToggleHide(itemKey)}
                title={
                  isHidden
                    ? 'Gizlemeyi kaldır'
                    : 'Zevk profilimi etkilemeden keşfet akışından nötr olarak gizle'
                }
              >
                <span>{isHidden ? 'Gizlendi ✓' : 'Gizle'}</span>
              </button>
            )}
          </div>

          {/* Kişisel Puan Yıldızları */}
          <div className="detail-rating-row">
            <span className="rating-label">
              {personalRating
                ? RATING_DESCRIPTIONS[personalRating] || `Kişisel puan: ${personalRating}/10`
                : 'Kişisel puan (10 üzerinden):'}
            </span>
            <div className="stars" role="radiogroup" aria-label="Kişisel Puan">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((star) => (
                <button
                  key={star}
                  className={`star-button ${personalRating && star <= personalRating ? 'is-selected' : ''}`}
                  type="button"
                  role="radio"
                  aria-label={`10 üzerinden ${star}`}
                  aria-checked={personalRating === star}
                  onClick={() => {
                    const nextStatus = 'completed';
                    setStatus(nextStatus);
                    setPersonalRating(star);
                    let tracking = {};
                    if (isTv) {
                      tracking = {
                        season_progress: seasonProgress,
                        season_episode_counts: seasonCounts,
                        current_season: currentSeason,
                        next_episode: nextEpNum,
                        episodes_watched: totalEpisodesWatched,
                      };
                    }
                    onSave(currentItem, nextStatus, star, tracking);
                  }}
                >
                  {star}
                </button>
              ))}
              {personalRating !== '' && (
                <button
                  type="button"
                  className="star-clear"
                  onClick={() => {
                    setPersonalRating('');
                    let tracking = {};
                    if (isTv) {
                      tracking = {
                        season_progress: seasonProgress,
                        season_episode_counts: seasonCounts,
                        current_season: currentSeason,
                        next_episode: nextEpNum,
                        episodes_watched: totalEpisodesWatched,
                      };
                    }
                    onSave(currentItem, status, '', tracking);
                  }}
                >
                  Sıfırla
                </button>
              )}
            </div>
          </div>

          {detailError && (
            <div className="detail-inline-error" role="alert">
              {detailError}
            </div>
          )}

          {overviewFallbackUsed && (
            <span className="detail-overview-fallback-note">
              Türkçe özet bulunamadı; İngilizce özet gösteriliyor.
            </span>
          )}

          <p id="detailOverview" className="detail-overview clamp-3">
            {currentItem.overview || 'Bu içerik için açıklama bulunmuyor.'}
          </p>

          {kunyeRows.length > 0 && (
            <dl id="detailKunye" className="detail-kunye">
              {kunyeRows.map((row) => (
                <div key={row.label} className="detail-kunye-row">
                  <dt>{row.label}</dt>
                  <dd>
                    {row.text ||
                      (row.persons || []).map((p, idx) => (
                        <React.Fragment key={p.id}>
                          {idx > 0 && <span className="detail-kunye-sep"> · </span>}
                          <button
                            type="button"
                            className="detail-kunye-person"
                            onClick={() => onOpenPerson(p.id, p.name)}
                          >
                            {p.name}
                          </button>
                        </React.Fragment>
                      ))}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {/* Neden Önerildi Bölümü */}
          {(() => {
            const entry = currentItem.tasteMapEntry || item?.tasteMapEntry;
            const rawParts: Record<string, number> = entry?.parts || currentItem.parts || item?.parts || {};
            const rawTags: string[] = Array.isArray(entry?.tags)
              ? entry.tags
              : Array.isArray(currentItem.tags)
              ? currentItem.tags
              : [];
            const matchVal = Number(entry?.tasteScore ?? currentItem.tasteScore ?? currentItem.matchScore ?? item?.matchScore ?? 0);
            const lovedSimDetail = currentItem.lovedSimDetail || item?.lovedSimDetail || entry?.lovedSimDetail || null;

            const signalLabels: Record<string, string> = {
              genre: 'Tür Uyumu',
              actor: 'Oyuncu Tercihi',
              genreActor: 'Tür & Kadro Sinerjisi',
              castHarmony: 'Kadro Uyumu',
              director: 'Yönetmen İmzası',
              keywords: 'Tema & Anahtar Kelimeler',
              story: 'Hikâye Örgüsü Yakınlığı',
              lovedSim: 'Sevilen Yapım Benzerliği',
              quality: 'Bayesyen Kalite Sinyali',
              exploration: 'Keşif Dengesi',
              popularity: 'Güncel İlgi',
              context: 'Ruh Hali / Dönem Uyumu',
              franchise: 'Evren / Seri Bağı',
              mediaType: 'Format Tercihi',
              sourceSignal: 'Çoklu Kaynak Doğrulaması',
            };

            const topSignals = Object.entries(rawParts)
              .filter(([k, val]) => signalLabels[k] && typeof val === 'number' && Number.isFinite(val) && val > 0.52)
              .map(([k, val]) => ({
                key: k,
                label: signalLabels[k],
                percent: Math.max(1, Math.min(100, Math.round(val * 100))),
              }))
              .sort((a, b) => b.percent - a.percent)
              .slice(0, 5);

            if (matchVal <= 0 || (topSignals.length === 0 && rawTags.length === 0)) {
              return null;
            }

            return (
              <section className="explain-rec-box cls-reserve-block" aria-labelledby="explainRecTitle">
                <div className="explain-rec-head">
                  <strong id="explainRecTitle">Neden Önerildi?</strong>
                  <span className="explain-rec-score tabular-nums">{formatMatchBadge(matchVal)}</span>
                </div>
                {rawTags.length > 0 && (
                  <div className="explain-rec-tags">
                    {rawTags.map((tag) => (
                      <span key={tag} className="explain-rec-tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                {topSignals.length > 0 && (
                  <div className="explain-rec-signals">
                    {topSignals.map((sig) => (
                      <div key={sig.key} className="explain-rec-row">
                        <span className="explain-rec-label">{sig.label}</span>
                        <svg
                          className="explain-rec-bar"
                          viewBox="0 0 100 6"
                          preserveAspectRatio="none"
                          aria-hidden="true"
                        >
                          <rect
                            className="fill-cinema-gold"
                            x="0"
                            y="0"
                            width={sig.percent}
                            height="6"
                            rx="3"
                          />
                        </svg>
                        <span className="explain-rec-val tabular-nums">{sig.percent}/100</span>
                      </div>
                    ))}
                  </div>
                )}
                {lovedSimDetail && lovedSimDetail.matchedTitle && (
                  <div className="mt-3.5 pt-3 border-t border-white/[0.08]" aria-label="Sevilen yapım benzerlik analizi">
                    <div className="flex items-center justify-between text-xs mb-2">
                      <span className="font-serif font-medium text-cinema-gold">
                        Sevilen Yapımlarla Benzerlik: &ldquo;{lovedSimDetail.matchedTitle}&rdquo;
                      </span>
                      <span className="font-mono text-cinema-text-primary font-semibold">
                        %{Math.round(lovedSimDetail.similarity * 100)}
                      </span>
                    </div>
                    <div className="grid grid-cols-5 gap-1.5 text-center text-[11px]">
                      <div className="bg-white/[0.04] p-1.5 rounded border border-white/[0.05]">
                        <div className="text-[10px] text-cinema-text-muted">Tür</div>
                        <div className="font-mono text-cinema-text-primary mt-0.5 font-medium">
                          %{Math.round(lovedSimDetail.genreSim * 100)}
                        </div>
                      </div>
                      <div className="bg-white/[0.04] p-1.5 rounded border border-white/[0.05]">
                        <div className="text-[10px] text-cinema-text-muted">Hikâye</div>
                        <div className="font-mono text-cinema-text-primary mt-0.5 font-medium">
                          %{Math.round(lovedSimDetail.storySim * 100)}
                        </div>
                      </div>
                      <div className="bg-white/[0.04] p-1.5 rounded border border-white/[0.05]">
                        <div className="text-[10px] text-cinema-text-muted">Oyuncu</div>
                        <div className="font-mono text-cinema-text-primary mt-0.5 font-medium">
                          %{Math.round(lovedSimDetail.castSim * 100)}
                        </div>
                      </div>
                      <div className="bg-white/[0.04] p-1.5 rounded border border-white/[0.05]">
                        <div className="text-[10px] text-cinema-text-muted">Atmosfer</div>
                        <div className="font-mono text-cinema-text-primary mt-0.5 font-medium">
                          %{Math.round(lovedSimDetail.atmosphereSim * 100)}
                        </div>
                      </div>
                      <div className="bg-white/[0.04] p-1.5 rounded border border-white/[0.05]">
                        <div className="text-[10px] text-cinema-text-muted">Dönem</div>
                        <div className="font-mono text-cinema-text-primary mt-0.5 font-medium">
                          %{Math.round(lovedSimDetail.eraSim * 100)}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </section>
            );
          })()}

          {/* CLS Sigortalı Sezon Bölüm Takibi */}
          {isTv && (
            <section id="episodeTracker" className="episode-tracker cls-reserve-block" aria-labelledby="episodeTrackerTitle">
              <strong id="episodeTrackerTitle">Sezon & Bölüm İlerlemesi</strong>
              <div className="season-tracker-head">
                <label htmlFor="currentSeasonSelect">
                  İzlediğim sezon:
                  <select
                    id="currentSeasonSelect"
                    value={currentSeason}
                    onChange={(e) => setCurrentSeason(Number(e.target.value))}
                  >
                    {seasonNumbers.map((s) => (
                      <option key={s} value={s}>
                        Sezon {s}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div id="seasonTrackerRows" className="season-rows">
                {seasonNumbers.map((season) => {
                  const count = seasonCounts[season] || 0;
                  const watched = seasonProgress[season] || 0;
                  const ratio = count ? Math.min(100, Math.round((watched / count) * 100)) : 0;

                  return (
                    <div key={season} className={`season-row ${!count ? 'no-count' : ''}`} data-season={season}>
                      <span>Sezon {season}</span>
                      {count > 0 && (
                        <svg
                          className="season-bar"
                          viewBox="0 0 100 8"
                          preserveAspectRatio="none"
                          aria-hidden="true"
                        >
                          <rect
                            className="fill-cinema-gold"
                            x="0"
                            y="0"
                            width={ratio}
                            height="8"
                            rx="4"
                          />
                        </svg>
                      )}
                      <input
                        type="number"
                        min="0"
                        max={count || 10000}
                        value={watched}
                        onChange={(e) => handleSeasonEpisodeChange(season, Number(e.target.value))}
                        aria-label={`Sezon ${season} izlenen bölüm sayısı`}
                      />
                      <span className="season-total tabular-nums">
                        {count ? `/ ${count} bölüm` : '/ bölüm sayısı bilinmiyor'}
                      </span>
                      {count > 0 && <span className="season-percent tabular-nums">%{ratio}</span>}
                    </div>
                  );
                })}
              </div>

              <p id="seasonTrackerSummary" className="provider-message tabular-nums" aria-live="polite">
                {totalEpisodesWatched > 0
                  ? `Toplam ${totalEpisodesWatched} bölüm izlendi${
                      overallPercent !== null ? ` · genel %${overallPercent}` : ''
                    } · sıradaki bölüm S${currentSeason}B${nextEpNum}`
                  : 'Henüz bölüm işaretlenmedi.'}
              </p>
            </section>
          )}

          {/* CLS Sigortalı Platform Bilgisi (Türkiye) */}
          {!currentItem.custom && (
            <section id="detailProviders" className="provider-section cls-reserve-block" aria-labelledby="providersTitle">
              <strong id="providersTitle" className="person-section-title">
                Türkiye'de Nerede İzlenir?
              </strong>
              {loadingProviders ? (
                <div className="skeleton-line w-3/5" />
              ) : providers ? (
                <div className="provider-groups">
                  {[
                    ['flatrate', 'Abonelik'],
                    ['free', 'Ücretsiz'],
                    ['ads', 'Reklamlı'],
                    ['rent', 'Kiralama'],
                    ['buy', 'Satın Alma'],
                  ]
                    .filter(([key]) => Array.isArray(providers[key]) && providers[key].length > 0)
                    .map(([key, label]) => (
                      <div key={key} className="provider-group">
                        <strong>{label}:</strong>
                        <div className="provider-list">
                          {providers[key].map((p: any) => (
                            <a
                              key={p.provider_id}
                              href={providers.link || 'https://www.themoviedb.org/'}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="provider-link"
                            >
                              {p.logo_path && (
                                <img src={imageUrl(p.logo_path, 'w92')} alt="" loading="lazy" />
                              )}
                              <span>{p.provider_name}</span>
                            </a>
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="provider-message">Türkiye için lisanslı yayın platformu bilgisi bulunamadı.</p>
              )}
            </section>
          )}

          {/* Seri ve Evren Bağlantısı (FEAT-01 #3) */}
          {(() => {
            const seriesInfo = getItemSeriesInfo(currentItem);
            if (!seriesInfo.inSeries || !seriesInfo.collectionName) return null;
            const parts = seriesInfo.collection?.parts || [];
            return (
              <section
                id="detailFranchise"
                className="franchise-section cls-reserve-block"
                aria-labelledby="detailFranchiseTitle"
              >
                <div className="franchise-section-head">
                  <strong id="detailFranchiseTitle" className="person-section-title">
                    Seri & Evren: {seriesInfo.collectionName}
                  </strong>
                  {parts.length > 1 && (
                    <span className="franchise-count tabular-nums">{parts.length} yapım</span>
                  )}
                </div>
                {parts.length > 0 && (
                  <div className="franchise-parts-list">
                    {parts.map((part) => {
                      const isCurrentPart =
                        String(part.id) === String(currentItem.id) &&
                        part.media_type === currentItem.media_type;
                      const partSaved = findSavedItem(savedItems, part);
                      const partYear = (part.release_date || part.first_air_date || '').slice(0, 4);
                      const statusLabel =
                        partSaved?.status === 'completed'
                          ? 'İzlendi'
                          : partSaved?.status === 'watching'
                            ? 'İzleniyor'
                            : partSaved?.status === 'watchlist'
                              ? 'İzlenecek'
                              : '';
                      return (
                        <button
                          key={`${part.media_type}:${part.id}`}
                          type="button"
                          className={`franchise-part-btn ${isCurrentPart ? 'is-current' : ''}`}
                          disabled={isCurrentPart || !onSelectMedia}
                          onClick={() => {
                            if (!isCurrentPart && onSelectMedia) {
                              onSelectMedia({ ...part, media_type: part.media_type });
                            }
                          }}
                        >
                          <span className="franchise-part-year tabular-nums">
                            {partYear || '—'}
                          </span>
                          <span className="franchise-part-title clamp-1">
                            {part.title || part.name}
                          </span>
                          {isCurrentPart ? (
                            <span className="franchise-part-state">Şu an açık</span>
                          ) : statusLabel ? (
                            <span className="franchise-part-state is-saved">{statusLabel}</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })()}

          {/* Kadro Şeridi */}
          {cast.length > 0 && (
            <div id="detailCast" className="detail-cast cls-reserve-block">
              <strong className="cast-heading">Öne Çıkan Oyuncular</strong>
              <div className="cast-row">
                {cast.map((person: any) => {
                  const isFav = favoriteActors.some((a) => a.id === person.id);
                  return (
                    <div key={person.id} className="cast-card-wrap">
                      <button
                        className="cast-card"
                        type="button"
                        onClick={() => onOpenPerson(person.id, person.name)}
                        aria-label={`${person.name} oyuncu profilini aç`}
                      >
                        {person.profile_path ? (
                          <img
                            src={imageUrl(person.profile_path, 'w185')}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            onError={(e) => handleImageError(e, imageUrl(person.profile_path, 'w185'), 'w185')}
                          />
                        ) : (
                          <span className="cast-photo-fallback" aria-hidden="true">
                            <svg className="icon">
                              <use href="#icon-user"></use>
                            </svg>
                          </span>
                        )}
                        <strong>{person.name}</strong>
                        <span>{person.character || ''}</span>
                      </button>
                      <button
                        type="button"
                        className={`cast-fav-btn ${isFav ? 'is-active' : ''}`}
                        title={isFav ? 'Favorilerden çıkar' : 'Favori oyunculara ekle'}
                        aria-label={isFav ? `${person.name} favorilerden çıkar` : `${person.name} favorilere ekle`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleFavoriteActor?.({
                            id: person.id,
                            name: person.name,
                            profile_path: person.profile_path || '',
                            character: person.character || '',
                          });
                        }}
                      >
                        {isFav ? '❤️' : '🤍'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Benzer İçerikler Şeridi */}
          {similarList.length > 0 && (
            <div id="detailSimilar" className="detail-similar">
              <strong className="cast-heading">Benzer İçerikler</strong>
              <div className="similar-row">
                {similarList.map((sim: any) => {
                  const poster = sim.poster_path ? imageUrl(sim.poster_path, 'w185') : '';
                  return (
                    <button
                      key={`${currentItem.media_type}-${sim.id}`}
                      type="button"
                      className="similar-card"
                      onClick={() => onSelectMedia?.({ ...sim, media_type: currentItem.media_type })}
                      aria-label={`${displayTitle(sim)} ayrıntılarını aç`}
                    >
                      {poster ? (
                        <img
                          src={poster}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          onError={(e) => handleImageError(e, poster, 'w185')}
                        />
                      ) : (
                        <span className="similar-photo-fallback" aria-hidden="true" />
                      )}
                      <strong>{displayTitle(sim)}</strong>
                      <span className="similar-meta tabular-nums">
                        {releaseYear(sim)}
                        {Number(sim.vote_average) > 0 ? ` · ★ ${Number(sim.vote_average).toFixed(1)}` : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Fragman */}
          {trailer && (
            <a
              id="detailTrailer"
              className="btn detail-trailer-btn"
              href={`https://www.youtube.com/watch?v=${encodeURIComponent(trailer.key)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-trailer"></use>
              </svg>
              <span>Fragmanı İzle</span>
            </a>
          )}
        </div>

        {/* Sticky Alt Çubuk (Section 6.5) */}
        <div className="modal-sticky-footer">
          {savedItem && (
            <button
              id="removeDetail"
              className="btn btn-danger btn-sm"
              type="button"
              onClick={handleRemove}
            >
              Listeden Çıkar
            </button>
          )}

          <div className="modal-footer-actions">
            <button className="btn" type="button" onClick={onClose}>
              Kapat
            </button>
            <button id="saveDetail" className="btn btn-primary" type="button" onClick={handleSave}>
              {savedItem ? 'Kaydet' : 'Listeme Ekle'}
            </button>
          </div>
        </div>
      </article>
    </div>
  );
};

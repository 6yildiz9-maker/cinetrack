import React, { useState, useEffect } from 'react';
import { displayTitle, getPoster, imageUrl, releaseYear, RATING_DESCRIPTIONS } from '../utils/helpers';
import {
  SavedItem,
  buildSeasonCounts,
  defaultCurrentSeason,
  makeMediaKey,
  getTasteRingLabel,
} from '../core/cinetrack-core';
import { fetchTmdb } from '../services/api';
import { formatMatchBadge } from '../i18n';
import { useDialogAccessibility } from '../utils/useDialogAccessibility';

interface DetailModalProps {
  item: any | null;
  savedItem?: SavedItem;
  isOpen: boolean;
  genresMap: Record<number, string>;
  isDisliked: boolean;
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
  onOpenPerson: (personId: number, personName: string) => void;
  onToggleFavoriteActor?: (actor: any) => void;
}

export const DetailModal: React.FC<DetailModalProps> = ({
  item,
  savedItem,
  isOpen,
  genresMap,
  isDisliked,
  favoriteActors = [],
  onClose,
  onSave,
  onRemove,
  onToggleDislike,
  onOpenPerson,
  onToggleFavoriteActor,
}) => {
  const [details, setDetails] = useState<any>(null);
  const [providers, setProviders] = useState<any>(null);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [overviewFallbackUsed, setOverviewFallbackUsed] = useState<boolean>(false);
  const [status, setStatus] = useState<'watching' | 'watchlist' | 'completed'>('watchlist');
  const [personalRating, setPersonalRating] = useState<number | ''>('');
  const [currentSeason, setCurrentSeason] = useState<number>(1);
  const [seasonProgress, setSeasonProgress] = useState<Record<number, number>>({});
  const [seasonCounts, setSeasonCounts] = useState<Record<number, number>>({});
  const dialogRef = useDialogAccessibility(isOpen, onClose);

  useEffect(() => {
    if (!item || !isOpen) {
      setDetails(null);
      setProviders(null);
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

  const genresList: string[] = currentItem.genres?.length
    ? currentItem.genres.map((g: any) => (typeof g === 'string' ? g : g.name))
    : (currentItem.genre_ids || []).map((id: number) => genresMap[id]).filter(Boolean);

  const trailer = (currentItem.videos?.results || []).find(
    (v: any) => v.site === 'YouTube' && v.type === 'Trailer'
  );

  const cast = (currentItem.credits?.cast || [])
    .filter((p: any) => p.id != null && p.name)
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
    onSave(currentItem, status, personalRating, tracking);
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
            <img id="detailBackdrop" className="detail-backdrop" src={backdrop} alt="" />
            <div className="detail-backdrop-gradient" />
          </div>
        )}

        <div className="detail-content">
          <h2 id="detailTitle" className="detail-title">
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
              title={isDisliked ? 'İlgilenmiyorum tercihini kaldır' : 'İlgilenmiyorum olarak işaretle'}
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-thumbs-down"></use>
              </svg>
              <span>{isDisliked ? 'İlgilenmiyorum ✕' : 'İlgilenmiyorum'}</span>
            </button>
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
                    onSave(currentItem, status, star, tracking);
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
              <section className="explain-rec-box" aria-labelledby="explainRecTitle">
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
                        <span className="explain-rec-bar" aria-hidden="true">
                          <span className="explain-rec-fill" style={{ width: `${sig.percent}%` }} />
                        </span>
                        <span className="explain-rec-val tabular-nums">{sig.percent}/100</span>
                      </div>
                    ))}
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
                      <div className="season-bar" hidden={!count}>
                        <div className="season-bar-fill" style={{ width: `${ratio}%` }}></div>
                      </div>
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
                <div className="skeleton-line" style={{ width: '60%' }} />
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
                            onError={(e) => ((e.target as HTMLElement).style.display = 'none')}
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

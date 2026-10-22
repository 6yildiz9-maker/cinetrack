import React, { useState, useEffect } from 'react';
import { displayTitle, getPoster, imageUrl, releaseYear, RATING_DESCRIPTIONS } from '../utils/helpers';
import {
  SavedItem,
  buildSeasonCounts,
  defaultCurrentSeason,
  sanitizeSeasonProgress,
  makeMediaKey,
  getTasteRingLabel,
} from '../core/cinetrack-core';
import { fetchTmdb } from '../services/api';
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
      return;
    }

    if (item.custom) {
      setDetails({ ...item, media_type: item.media_type || 'movie' });
      return;
    }

    // Fetch full details
    let active = true;
    const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
    fetchTmdb(`/${mediaType}/${item.id}`, { append_to_response: 'credits,videos' })
      .then((data) => {
        if (!active || !data) return;
        setDetails({ ...data, media_type: mediaType });
        if (mediaType === 'tv' && data.seasons) {
          const counts = buildSeasonCounts(data);
          setSeasonCounts(counts);
        }
      })
      .catch((err) => console.warn('Details fetch error:', err));

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
        className="modal"
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

        {backdrop && <img id="detailBackdrop" className="detail-backdrop" src={backdrop} alt="" />}

        <div className="detail-content">
          <h2 id="detailTitle" className="detail-title">
            {title}
          </h2>

          <div id="detailMeta" className="detail-meta">
            {currentItem.custom
              ? 'Özel içerik'
              : currentItem.media_type === 'tv'
              ? 'Dizi'
              : 'Film'}{' '}
            | {releaseYear(currentItem)}
            {!currentItem.custom &&
              currentItem.vote_average &&
              ` | TMDB puanı ${Number(currentItem.vote_average).toFixed(1)}`}
            {currentItem.runtime
              ? ` | ${currentItem.runtime} dk`
              : currentItem.episode_run_time?.[0]
              ? ` | ${currentItem.episode_run_time[0]} dk/bölüm`
              : ''}
            {Number(currentItem.matchScore || item?.matchScore) > 0 && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  background: 'linear-gradient(135deg, #e11d48, #f43f5e)',
                  color: '#ffffff',
                  fontWeight: 800,
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: '6px',
                  marginLeft: '6px',
                  boxShadow: '0 2px 8px rgba(225, 29, 72, 0.4)',
                }}
              >
                🎯 %{Math.round(Number(currentItem.matchScore || item?.matchScore))} Sana Özel Uyumu
                {(currentItem.ring || item?.ring) && ` · ${getTasteRingLabel(currentItem.ring || item?.ring)}`}
              </span>
            )}
          </div>

          <div id="detailGenres" className="detail-tags" aria-label="Türler">
            {genresList.map((genre) => (
              <span key={genre} className="detail-tag">
                {genre}
              </span>
            ))}
          </div>

          {/* Quick List Status Buttons */}
          <div className="detail-quick-status-bar" role="group" aria-label="Hızlı liste durumu">
            <button
              type="button"
              className={`detail-status-pill pill-watchlist ${status === 'watchlist' && savedItem ? 'is-active' : ''}`}
              onClick={() => handleQuickSetStatus('watchlist')}
            >
              <svg className="icon" aria-hidden="true">
                <use href={status === 'watchlist' && savedItem ? '#icon-check' : '#icon-plus'}></use>
              </svg>
              <span>{savedItem && status === 'watchlist' ? 'İzleneceklerde ✓' : '+ İzleneceklere Ekle'}</span>
            </button>
            <button
              type="button"
              className={`detail-status-pill pill-watching ${status === 'watching' && savedItem ? 'is-active' : ''}`}
              onClick={() => handleQuickSetStatus('watching')}
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-play"></use>
              </svg>
              <span>{savedItem && status === 'watching' ? 'İzleniyor ▶' : '▶ İzliyorum'}</span>
            </button>
            <button
              type="button"
              className={`detail-status-pill pill-completed ${status === 'completed' && savedItem ? 'is-active' : ''}`}
              onClick={() => handleQuickSetStatus('completed')}
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-check"></use>
              </svg>
              <span>{savedItem && status === 'completed' ? 'Tamamlandı ✓' : '✓ İzlendi'}</span>
            </button>
            {savedItem && (
              <button
                type="button"
                className="detail-status-pill pill-remove"
                onClick={handleRemove}
                title="Listeden Kaldır"
              >
                ✕ Listeden Çıkar
              </button>
            )}
          </div>

          <p id="detailOverview" className="detail-overview">
            {currentItem.overview || 'Bu içerik için açıklama bulunmuyor.'}
          </p>

          <div id="detailSeasons" className="detail-meta">
            {currentItem.number_of_seasons
              ? `${currentItem.number_of_seasons} sezon | ${currentItem.number_of_episodes || 0} bölüm`
              : ''}
          </div>

          {/* Episode Tracker */}
          {isTv && (
            <section id="episodeTracker" className="episode-tracker" aria-labelledby="episodeTrackerTitle">
              <strong id="episodeTrackerTitle">Bölüm takibi</strong>
              <div className="season-tracker-head">
                <label htmlFor="currentSeasonSelect">
                  İzlediğim sezon
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
                    <div
                      key={season}
                      className={`season-row ${!count ? 'no-count' : ''}`}
                      data-season={season}
                    >
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
                      <span className="season-total">
                        {count ? `/ ${count} bölüm` : '/ bölüm sayısı bilinmiyor'}
                      </span>
                      {count > 0 && <span className="season-percent">%{ratio}</span>}
                    </div>
                  );
                })}
              </div>

              <p id="seasonTrackerSummary" className="provider-message" aria-live="polite">
                {totalEpisodesWatched > 0
                  ? `Toplam ${totalEpisodesWatched} bölüm izlendi${
                      overallPercent !== null ? ` · genel %${overallPercent}` : ''
                    } · sıradaki bölüm S${currentSeason}B${nextEpNum}`
                  : 'Henüz bölüm işaretlenmedi.'}
              </p>
            </section>
          )}

          {/* Watch Providers in Turkey */}
          {!item.custom && (
            <section id="detailProviders" className="provider-section" aria-labelledby="providersTitle">
              <strong id="providersTitle" className="person-section-title">
                Türkiye'de nerede izlenir?
              </strong>
              {loadingProviders ? (
                <p className="provider-message">Yayın seçenekleri yükleniyor...</p>
              ) : providers ? (
                <div className="provider-groups">
                  {[
                    ['flatrate', 'Abonelik'],
                    ['free', 'Ücretsiz'],
                    ['ads', 'Reklamlı'],
                    ['rent', 'Kiralama'],
                    ['buy', 'Satın alma'],
                  ]
                    .filter(([key]) => Array.isArray(providers[key]) && providers[key].length > 0)
                    .map(([key, label]) => (
                      <div key={key} className="provider-group">
                        <strong>{label}</strong>
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
                              {p.provider_name}
                            </a>
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="provider-message">Türkiye için yayın platformu bilgisi bulunamadı.</p>
              )}
            </section>
          )}

          {/* Cast row */}
          {cast.length > 0 && (
            <div id="detailCast" className="detail-cast">
              <strong className="cast-heading">Oyuncular</strong>
              <div className="cast-row">
                {cast.map((person: any) => {
                  const isFav = favoriteActors.some((a) => a.id === person.id);
                  return (
                    <div key={person.id} className="cast-card-wrap">
                      <button
                        className="cast-card"
                        type="button"
                        onClick={() => onOpenPerson(person.id, person.name)}
                        aria-label={`${person.name} oyuncu bilgilerini aç`}
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

          {/* Trailer */}
          {trailer && (
            <a
              id="detailTrailer"
              className="btn btn-small detail-trailer"
              href={`https://www.youtube.com/watch?v=${encodeURIComponent(trailer.key)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-trailer"></use>
              </svg>{' '}
              Fragmanı izle
            </a>
          )}

          <div className="detail-actions">
            <select
              id="detailStatus"
              aria-label="İzleme durumu"
              value={status}
              onChange={(e) => {
                const newStatus = e.target.value as 'watching' | 'watchlist' | 'completed';
                setStatus(newStatus);
                handleQuickSetStatus(newStatus);
              }}
            >
              <option value="watchlist">İzlenecek</option>
              <option value="watching">İzliyorum</option>
              <option value="completed">Tamamlandı</option>
            </select>

            <div>
              <span id="ratingLabel" style={{ fontSize: '11px', color: '#cbd5e1' }}>
                {personalRating
                  ? RATING_DESCRIPTIONS[personalRating] || `Kişisel puan: ${personalRating}/10`
                  : 'Kişisel puan'}
              </span>
              <div id="starRating" className="stars" role="radiogroup" aria-labelledby="ratingLabel">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((star) => (
                  <button
                    key={star}
                    className={`star-button ${
                      personalRating && star <= personalRating ? 'is-selected' : ''
                    }`}
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
                <button
                  id="clearRating"
                  className="star-clear"
                  type="button"
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
                  Temizle
                </button>
              </div>
            </div>

            <button id="saveDetail" className="btn btn-primary" type="button" onClick={handleSave}>
              {savedItem ? 'Değişiklikleri kaydet' : 'Listeme kaydet'}
            </button>

            {savedItem && (
              <button id="removeDetail" className="btn btn-danger" type="button" onClick={handleRemove}>
                Listemden kaldır
              </button>
            )}

            {!currentItem.custom && (
              <button
                id="dislikeDetail"
                className="btn"
                type="button"
                onClick={() =>
                  onToggleDislike(makeMediaKey(currentItem))
                }
              >
                {isDisliked ? 'İlgilenmiyorum tercihini kaldır' : 'İlgilenmiyorum'}
              </button>
            )}
          </div>
        </div>
      </article>
    </div>
  );
};

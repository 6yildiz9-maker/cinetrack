import React, { useState, useEffect } from 'react';
import { displayTitle, getPoster, imageUrl, releaseYear, RATING_DESCRIPTIONS } from '../utils/helpers';
import {
  SavedItem,
  buildSeasonCounts,
  defaultCurrentSeason,
  sanitizeSeasonProgress,
} from '../core/cinetrack-core';
import { fetchTmdb } from '../services/api';

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

  useEffect(() => {
    if (!item || !isOpen) {
      setDetails(null);
      setProviders(null);
      return;
    }

    const currentSaved = savedItem;
    setStatus(currentSaved?.status || 'watchlist');
    setPersonalRating(
      currentSaved && currentSaved.personal_rating !== '' && Number(currentSaved.personal_rating) > 0
        ? Number(currentSaved.personal_rating)
        : ''
    );

    const initProgress = currentSaved?.season_progress || {};
    const initCounts = currentSaved?.season_episode_counts || {};
    setSeasonProgress(initProgress);
    setSeasonCounts(initCounts);
    setCurrentSeason(
      Number(currentSaved?.current_season) || defaultCurrentSeason(initProgress, initCounts)
    );

    if (item.custom) {
      setDetails(item);
      return;
    }

    // Fetch full details
    let active = true;
    fetchTmdb(`/${item.media_type}/${item.id}`, { append_to_response: 'credits,videos' })
      .then((data) => {
        if (!active) return;
        setDetails(data);
        if (item.media_type === 'tv' && data.seasons) {
          const counts = buildSeasonCounts(data);
          setSeasonCounts(counts);
        }
      })
      .catch((err) => console.warn('Details fetch error:', err));

    // Fetch providers
    setLoadingProviders(true);
    fetchTmdb(`/${item.media_type}/${item.id}/watch/providers`)
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
  }, [item, isOpen, savedItem]);

  if (!isOpen || !item) return null;

  const currentItem = details || item;
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
  const isTv = item.media_type === 'tv' && !item.custom;
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
          </div>

          <div id="detailGenres" className="detail-tags" aria-label="Türler">
            {genresList.map((genre) => (
              <span key={genre} className="detail-tag">
                {genre}
              </span>
            ))}
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
              onChange={(e) => setStatus(e.target.value as any)}
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
                    onClick={() => setPersonalRating(star)}
                  >
                    {star}
                  </button>
                ))}
                <button
                  id="clearRating"
                  className="star-clear"
                  type="button"
                  onClick={() => setPersonalRating('')}
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

            {!item.custom && (
              <button
                id="dislikeDetail"
                className="btn"
                type="button"
                onClick={() => onToggleDislike(`${item.media_type}:${item.id}`)}
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

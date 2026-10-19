import React from 'react';
import { displayTitle, formatMediaDates, getPoster, imageUrl } from '../utils/helpers';
import { SavedItem } from '../core/cinetrack-core';

interface HeroProps {
  heroItem: any | null;
  isWatching: boolean;
  onOpenDetails: (item: any) => void;
}

export const Hero: React.FC<HeroProps> = ({ heroItem, isWatching, onOpenDetails }) => {
  if (!heroItem) {
    return (
      <section className="hero" aria-labelledby="heroTitle">
        <div className="hero-copy">
          <span id="heroEyebrow" className="eyebrow">
            KALDIĞIN YERDEN DEVAM ET
          </span>
          <h1 id="heroTitle">İzleme listen, senin hikâyen.</h1>
          <p id="heroOverview">
            İzlemeye başladığın içerikler burada; henüz listen boşsa trendlerden bir içerik keşfet.
          </p>
          <div id="heroMeta" className="hero-meta"></div>
          <div className="hero-actions">
            <button id="heroContinue" className="btn btn-primary" type="button" disabled>
              <svg className="icon" aria-hidden="true">
                <use href="#icon-play"></use>
              </svg>{' '}
              Detayları gör
            </button>
          </div>
        </div>
      </section>
    );
  }

  const title = displayTitle(heroItem);
  const score = Number(heroItem.vote_average || 0);
  const poster = getPoster(heroItem) || imageUrl(heroItem.backdrop_path, 'w780');

  let overviewText =
    heroItem.overview ||
    (isWatching
      ? 'İzleme listen üzerinden kaldığın yerden devam et.'
      : 'TMDB\'den öne çıkan güncel içerik. Detaylarını keşfet veya listene ekle.');

  if (isWatching && heroItem.media_type === 'tv') {
    const season = Math.max(1, Number(heroItem.current_season) || 1);
    const watchedInSeason = heroItem.season_progress?.[season] ?? (Number(heroItem.episodes_watched) || 0);
    const totalWatched = Number(heroItem.episodes_watched) || 0;
    const next = watchedInSeason + 1;
    overviewText = `${overviewText} Sezon ${season} · ${watchedInSeason} bölüm tamamlandı (toplam ${totalWatched}) · sıradaki bölüm ${next}.`;
  }

  return (
    <section className="hero" aria-labelledby="heroTitle">
      {poster && (
        <img
          id="heroPoster"
          className="hero-poster"
          src={poster}
          alt=""
          onError={(e) => ((e.target as HTMLElement).style.display = 'none')}
        />
      )}
      <div className="hero-copy">
        <span id="heroEyebrow" className="eyebrow">
          {isWatching ? 'KALDIĞIN YERDEN DEVAM ET' : 'BUGÜNÜN TRENDİ'}
        </span>
        <h1 id="heroTitle">{title}</h1>
        <p id="heroOverview">{overviewText}</p>
        <div id="heroMeta" className="hero-meta">
          <span>
            {heroItem.media_type === 'tv' ? 'Dizi' : 'Film'} | {formatMediaDates(heroItem)}
          </span>
          {score > 0 && (
            <span>
              <svg className="icon" aria-hidden="true">
                <use href="#icon-star"></use>
              </svg>{' '}
              {score.toFixed(1)} TMDB
            </span>
          )}
          {isWatching && <span className="state">İzliyorum</span>}
        </div>
        <div className="hero-actions">
          <button
            id="heroContinue"
            className="btn btn-primary"
            type="button"
            onClick={() => onOpenDetails(heroItem)}
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-play"></use>
            </svg>{' '}
            Detayları gör
          </button>
        </div>
      </div>
    </section>
  );
};

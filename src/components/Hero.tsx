import React, { useState, useEffect, useRef, useCallback } from 'react';
import { displayTitle, formatMediaDates, getPoster, imageUrl } from '../utils/helpers';

interface HeroProps {
  heroItem: any | null;
  featuredItems?: any[];
  isWatching: boolean;
  onOpenDetails: (item: any) => void;
}

export const Hero: React.FC<HeroProps> = ({
  heroItem,
  featuredItems = [],
  isWatching,
  onOpenDetails,
}) => {
  // Combine heroItem and featuredItems into 2-3 unique items for carousel
  const carouselItems = React.useMemo(() => {
    const list: any[] = [];
    if (heroItem) list.push(heroItem);
    for (const it of featuredItems) {
      if (list.length >= 3) break;
      if (it && !list.some((existing) => `${existing.media_type || (existing.title ? 'movie' : 'tv')}:${existing.id}` === `${it.media_type || (it.title ? 'movie' : 'tv')}:${it.id}`)) {
        list.push(it);
      }
    }
    return list;
  }, [heroItem, featuredItems]);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [isHoveredOrFocused, setIsHoveredOrFocused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const total = carouselItems.length || 1;
  const activeItem = carouselItems[currentIndex] || heroItem;

  const handleNext = useCallback(() => {
    setCurrentIndex((prev) => (prev + 1) % total);
  }, [total]);

  const handlePrev = useCallback(() => {
    setCurrentIndex((prev) => (prev - 1 + total) % total);
  }, [total]);

  const togglePause = useCallback(() => {
    setIsPaused((prev) => !prev);
  }, []);

  // 20s auto-switch when not paused and not hovered/focused, disabled on prefers-reduced-motion
  useEffect(() => {
    if (total <= 1) return;

    // Check prefers-reduced-motion
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mediaQuery.matches) {
      return; // Do not auto-advance if reduced-motion preferred
    }

    if (isPaused || isHoveredOrFocused) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }

    timerRef.current = setInterval(() => {
      handleNext();
    }, 20000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [total, isPaused, isHoveredOrFocused, handleNext]);

  if (!activeItem) {
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

  const title = displayTitle(activeItem);
  const score = Number(activeItem.vote_average || 0);
  const poster = getPoster(activeItem) || imageUrl(activeItem.backdrop_path, 'w780');

  let overviewText =
    activeItem.overview ||
    (isWatching
      ? 'İzleme listen üzerinden kaldığın yerden devam et.'
      : 'Gündemdekilerden bugünün seçkisi. Detaylarını keşfet veya listene ekle.');

  if (isWatching && activeItem.media_type === 'tv') {
    const season = Math.max(1, Number(activeItem.current_season) || 1);
    const watchedInSeason = activeItem.season_progress?.[season] ?? (Number(activeItem.episodes_watched) || 0);
    const totalWatched = Number(activeItem.episodes_watched) || 0;
    const next = watchedInSeason + 1;
    overviewText = `${overviewText} Sezon ${season} · ${watchedInSeason} bölüm tamamlandı (toplam ${totalWatched}) · sıradaki bölüm ${next}.`;
  }

  return (
    <section
      className="hero"
      role="region"
      aria-roledescription="carousel"
      aria-label="Öne çıkan içerikler"
      onMouseEnter={() => setIsHoveredOrFocused(true)}
      onMouseLeave={() => setIsHoveredOrFocused(false)}
      onFocus={() => setIsHoveredOrFocused(true)}
      onBlur={() => setIsHoveredOrFocused(false)}
    >
      {poster && (
        <img
          id="heroPoster"
          className="hero-poster"
          src={poster}
          alt=""
          loading="eager"
          decoding="async"
          {...({ fetchPriority: 'high', fetchpriority: 'high' } as any)}
          onError={(e) => ((e.target as HTMLElement).style.display = 'none')}
        />
      )}

      <div className="hero-copy">
        <div className="hero-top-row">
          <span id="heroEyebrow" className="eyebrow">
            {isWatching && currentIndex === 0 ? 'KALDIĞIN YERDEN DEVAM ET' : 'GÜNDEMDEKİLERDEN BUGÜNÜN SEÇKİSİ'}
          </span>

          {total > 1 && (
            <div className="hero-carousel-controls" aria-label="Vitrin geçiş kontrolleri">
              <span className="sr-only" aria-live="polite">
                {`${currentIndex + 1} / ${total}`}
              </span>
              <button
                type="button"
                className="hero-nav-btn"
                onClick={handlePrev}
                aria-label="Önceki öne çıkan yapım"
                title="Önceki"
              >
                ‹
              </button>
              <button
                type="button"
                className="hero-nav-btn hero-pause-btn"
                onClick={togglePause}
                aria-pressed={isPaused}
                aria-label={isPaused ? 'Otomatik geçişi başlat' : 'Otomatik geçişi duraklat'}
                title={isPaused ? 'Oynat' : 'Duraklat'}
              >
                {isPaused ? '▶' : '⏸'}
              </button>
              <button
                type="button"
                className="hero-nav-btn"
                onClick={handleNext}
                aria-label="Sonraki öne çıkan yapım"
                title="Sonraki"
              >
                ›
              </button>
              <span className="hero-carousel-indicator tabular-nums" aria-hidden="true">
                {currentIndex + 1} / {total}
              </span>
            </div>
          )}
        </div>

        <h1 id="heroTitle">{title}</h1>
        <p id="heroOverview" className="clamp-2">{overviewText}</p>

        <div id="heroMeta" className="hero-meta">
          <span>
            {activeItem.media_type === 'tv' ? 'Dizi' : 'Film'} · {formatMediaDates(activeItem)}
          </span>
          {score > 0 && (
            <span className="hero-score tabular-nums">
              <svg className="icon" aria-hidden="true">
                <use href="#icon-star"></use>
              </svg>{' '}
              {score.toFixed(1)} TMDB
            </span>
          )}
          {isWatching && currentIndex === 0 && <span className="state">İzliyorum</span>}
        </div>

        <div className="hero-actions">
          <button
            id="heroContinue"
            className="btn btn-primary"
            type="button"
            onClick={() => onOpenDetails(activeItem)}
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

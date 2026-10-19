import React from 'react';
import { displayTitle, formatMediaDates, getPoster } from '../utils/helpers';
import { SavedItem, reminderDaysUntil, resolveAirDate } from '../core/cinetrack-core';

interface MediaCardProps {
  item: any;
  savedItem?: SavedItem;
  genres: Record<number, string>;
  recommendationReason?: string;
  isDisliked: boolean;
  tab: 'discover' | 'list';
  onOpenDetails: (item: any) => void;
  onQuickAdd: (item: any) => void;
  onSetStatus: (item: any, status: 'watching' | 'watchlist' | 'completed') => void;
  onQuickSave: (item: any) => void;
  onToggleDislike: (key: string) => void;
}

export const MediaCard: React.FC<MediaCardProps> = ({
  item,
  savedItem,
  genres,
  recommendationReason,
  isDisliked,
  tab,
  onOpenDetails,
  onQuickAdd,
  onSetStatus,
  onQuickSave,
  onToggleDislike,
}) => {
  const title = displayTitle(item);
  const kind = item.media_type === 'tv' ? 'Dizi' : 'Film';
  const poster = getPoster(item);
  const status = savedItem?.status || '';
  const statusText =
    status === 'watching' ? 'İzliyorum' : status === 'completed' ? 'Tamamlandı' : status === 'watchlist' ? 'Listemde' : '';
  const statusIcon = status === 'watching' ? 'icon-play' : status === 'completed' ? 'icon-check' : 'icon-plus';
  const genreNames = (item.genre_ids || [])
    .map((id: number) => genres[id])
    .filter(Boolean)
    .slice(0, 2)
    .join(', ');

  const tmdbRating = Number(item.vote_average || 0);
  const ratingClass = tmdbRating >= 8 ? 'rating-good' : tmdbRating >= 6 ? 'rating-mid' : 'rating-low';
  const personalRating =
    savedItem && savedItem.personal_rating !== '' && Number(savedItem.personal_rating) > 0
      ? Number(savedItem.personal_rating)
      : null;
  const personalRatingClass =
    personalRating && personalRating >= 8
      ? 'rating-good'
      : personalRating && personalRating >= 6
      ? 'rating-mid'
      : 'rating-low';

  const itemKey = `${item.media_type}:${item.id}`;
  const airDate = resolveAirDate(item);

  let countdownText = '';
  if (airDate) {
    const today = new Date();
    const days = reminderDaysUntil(airDate, today);
    if (days != null && days >= 0 && days <= 30) {
      countdownText = days === 0 ? 'Bugün yayında!' : days === 1 ? 'Yarın!' : `${days} gün sonra`;
    }
  }

  // Calculate TV season progress bar if saved
  let seasonProgressInfo: { watched: number; total: number; percent: number } | null = null;
  if (savedItem && savedItem.media_type === 'tv' && !savedItem.custom) {
    const progress = savedItem.season_progress || {};
    const counts = savedItem.season_episode_counts || {};
    const seasons = new Set([
      ...Object.keys(counts).map(Number),
      ...Object.keys(progress).map(Number),
    ]);
    let watched = 0;
    let total = 0;
    for (const season of seasons) {
      if (!Number.isSafeInteger(season) || season < 1) continue;
      const count = Number(counts[season]) || 0;
      const seen = count
        ? Math.min(count, Math.max(0, Number(progress[season]) || 0))
        : Math.max(0, Number(progress[season]) || 0);
      watched += seen;
      total += count;
    }
    if (total > 0 && watched > 0) {
      seasonProgressInfo = {
        watched,
        total,
        percent: Math.min(100, Math.round((watched / total) * 100)),
      };
    }
  }

  return (
    <article className="card">
      <div
        className="poster"
        role="button"
        tabIndex={0}
        aria-label={`${title} detaylarını gör`}
        onClick={() => onOpenDetails(item)}
        onKeyDown={(e) => {
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

        {countdownText && (
          <span className="release-countdown" title={`Yayın tarihi: ${airDate}`}>
            📅 {countdownText}
          </span>
        )}

        {/* Top-right stacked quick action buttons: Watchlist, Watching, Completed, Dislike */}
        <div className="poster-actions-stack" onClick={(e) => e.stopPropagation()}>
          {/* 1. İzlenecek listesine ekle */}
          <button
            type="button"
            className={`poster-action-btn action-watchlist ${status === 'watchlist' ? 'is-active' : ''}`}
            aria-label={status === 'watchlist' ? `${title} izlenecekler listesinde (Düzenle)` : `${title} izlenecekler listesine ekle`}
            title={status === 'watchlist' ? 'İzlenecekler listesinde (Düzenle)' : 'İzlenecek listesine ekle (+)'}
            onClick={(e) => {
              e.stopPropagation();
              if (status === 'watchlist') {
                onQuickSave(item);
              } else {
                onSetStatus(item, 'watchlist');
              }
            }}
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-plus"></use>
            </svg>
          </button>

          {/* 2. İzleniyor listesine ekle */}
          <button
            type="button"
            className={`poster-action-btn action-watching ${status === 'watching' ? 'is-active' : ''}`}
            aria-label={status === 'watching' ? `${title} şu an izleniyor (Düzenle)` : `${title} izleniyor listesine ekle`}
            title={status === 'watching' ? 'Şu an izleniyor (Düzenle)' : 'İzleniyor listesine ekle (▶)'}
            onClick={(e) => {
              e.stopPropagation();
              if (status === 'watching') {
                onQuickSave(item);
              } else {
                onSetStatus(item, 'watching');
              }
            }}
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-play"></use>
            </svg>
          </button>

          {/* 3. İzlendi listesine ekle */}
          <button
            type="button"
            className={`poster-action-btn action-completed ${status === 'completed' ? 'is-active' : ''}`}
            aria-label={status === 'completed' ? `${title} izlendi olarak kayıtlı (Düzenle)` : `${title} izlendi listesine ekle`}
            title={status === 'completed' ? 'İzlendi olarak kayıtlı (Düzenle)' : 'İzlendi listesine ekle (✓)'}
            onClick={(e) => {
              e.stopPropagation();
              if (status === 'completed') {
                onQuickSave(item);
              } else {
                onSetStatus(item, 'completed');
              }
            }}
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-check"></use>
            </svg>
          </button>

          {/* 4. İlgilenmiyorum */}
          <button
            type="button"
            className={`poster-action-btn action-dislike ${isDisliked ? 'is-active' : ''}`}
            aria-label={isDisliked ? `${title} ilgilenmiyorum listesinden kaldır` : `${title} ilgilenmiyorum olarak işaretle`}
            title={isDisliked ? 'İlgilenmiyorum listesinden kaldır' : 'İlgilenmiyorum (Önerilerden gizle)'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleDislike(itemKey);
            }}
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-thumbs-down"></use>
            </svg>
          </button>
        </div>

        {tmdbRating > 0 && (
          <span className={`rating ${ratingClass}`} aria-label={`TMDB puanı ${tmdbRating.toFixed(1)}`}>
            <svg className="icon" aria-hidden="true">
              <use href="#icon-star"></use>
            </svg>
            {tmdbRating.toFixed(1)}
          </span>
        )}

        {savedItem && (
          <span className={`saved-badge status-${status}`}>
            <svg className="icon" aria-hidden="true">
              <use href={`#${statusIcon}`}></use>
            </svg>
            {statusText}
          </span>
        )}

        {personalRating && (
          <span
            className={`personal-rating ${personalRatingClass}`}
            aria-label={`Kişisel puan ${personalRating} üzerinden 10`}
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-star"></use>
            </svg>{' '}
            {personalRating}/10
          </span>
        )}

        <div className="poster-overlay">
          <button
            className="overlay-btn"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDetails(item);
            }}
            aria-label={`${title} detaylarını gör`}
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-play"></use>
            </svg>
            Detayları Gör
          </button>
        </div>
      </div>

      <div className="card-info">
        <button
          className="card-title"
          type="button"
          onClick={() => onOpenDetails(item)}
          title={title}
        >
          {title}
        </button>
        <div className="card-meta">
          <span
            className="card-date"
            title={
              item.media_type === 'tv'
                ? 'İlk ve son yayınlanma yılları'
                : 'Yapım yılı'
            }
          >
            {formatMediaDates(item, savedItem)}
          </span>
          {genreNames && <span className="card-genres">• {genreNames}</span>}
        </div>

        {seasonProgressInfo && (
          <div
            className="season-progress"
            role="progressbar"
            aria-valuenow={seasonProgressInfo.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Toplam sezon ilerlemesi: %${seasonProgressInfo.percent}`}
          >
            <span className="season-progress-track">
              <span
                className="season-progress-fill"
                style={{ width: `${seasonProgressInfo.percent}%` }}
              ></span>
            </span>
            <span className="season-progress-label">
              %{seasonProgressInfo.percent} · {seasonProgressInfo.watched}/{seasonProgressInfo.total}
            </span>
          </div>
        )}

        {recommendationReason && (
          <div className="recommendation-reason">{recommendationReason}</div>
        )}
      </div>
    </article>
  );
};

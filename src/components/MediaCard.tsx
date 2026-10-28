import React, { useState, useEffect } from 'react';
import { displayTitle, formatMediaDates, getPoster } from '../utils/helpers';
import {
  SavedItem,
  TasteRing,
  reminderDaysUntil,
  resolveAirDate,
  makeMediaKey,
  getTasteRingLabel,
} from '../core/cinetrack-core';
import { TmdbItem } from '../types/tmdb';
import { formatMatchBadge } from '../i18n';

export interface MediaCardProps {
  item: TmdbItem | any;
  savedItem?: SavedItem;
  genres?: Record<number, string>;
  recommendationReason?: string;
  isDisliked?: boolean;
  tab?: 'discover' | 'list' | 'taste-map' | 'relationships';
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  context?: 'discover' | 'taste' | 'actor' | 'related' | 'hero';
  showMatch?: boolean;
  showRing?: boolean;
  related?: React.ReactNode;
  onOpenDetails: (item: any) => void;
  onQuickAdd?: (item: any) => void;
  onSetStatus?: (item: any, status: 'watching' | 'watchlist' | 'completed') => void;
  onQuickSave?: (item: any) => void;
  onToggleDislike?: (key: string) => void;
  matchScore?: number;
  selectionRing?: string;
  eager?: boolean;
}

export const MediaCard: React.FC<MediaCardProps> = ({
  item,
  savedItem,
  genres = {},
  recommendationReason,
  isDisliked = false,
  tab = 'discover',
  size = 'lg',
  context = 'discover',
  showMatch = true,
  showRing = false,
  related,
  onOpenDetails,
  onQuickAdd,
  onSetStatus,
  onQuickSave,
  onToggleDislike,
  matchScore,
  selectionRing,
  eager: _eager = false,
}) => {
  const title = displayTitle(item);
  const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
  const kind = mediaType === 'tv' ? 'Dizi' : 'Film';
  const poster = getPoster(item);
  const status = savedItem?.status || '';
  const [posterFailed, setPosterFailed] = useState(false);

  useEffect(() => {
    setPosterFailed(false);
  }, [poster]);

  const statusText =
    status === 'watching'
      ? 'İzliyorum'
      : status === 'completed'
      ? 'İzlendi'
      : status === 'watchlist'
      ? 'İzlenecek'
      : '';

  const statusIcon =
    status === 'watching' ? 'icon-play' : status === 'completed' ? 'icon-check' : 'icon-plus';

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

  const itemKey = makeMediaKey(item);
  const airDate = resolveAirDate(item);

  let countdownText = '';
  if (airDate && size !== 'xs') {
    const today = new Date();
    const days = reminderDaysUntil(airDate, today);
    if (days != null && days >= 0 && days <= 30) {
      countdownText = days === 0 ? 'Bugün yayında!' : days === 1 ? 'Yarın!' : `${days} gün sonra`;
    }
  }

  // Calculate TV season progress bar if saved
  let seasonProgressInfo: { watched: number; total: number; percent: number } | null = null;
  if (savedItem && savedItem.media_type === 'tv' && !savedItem.custom && size !== 'xs' && size !== 'sm') {
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

  // Calculate scores and ring info
  const effectiveScore = matchScore ?? Number(item.tasteScore ?? item.matchScore);
  const hasScore = Number.isFinite(effectiveScore) && effectiveScore > 0;
  const roundedScore = hasScore ? Math.round(effectiveScore) : null;

  const ringKey = (selectionRing || item.ring || item.lifecycleRing) as TasteRing | undefined;
  const ringLabel = ringKey ? getTasteRingLabel(ringKey) : '';
  const isRing0 = ringKey === 'ring0';
  const isRing1 = ringKey === 'ring1';
  const isRing2 = ringKey === 'ring2';

  const shouldRenderMatchBadge =
    showMatch &&
    (roundedScore !== null || (tab === 'discover' && Boolean(recommendationReason)));

  const shouldRenderRingChip =
    showRing || context === 'taste' || (Boolean(ringKey) && size !== 'xs');

  return (
    <article
      className={`card card--${size} card-context--${context}`}
      data-media-key={itemKey}
      data-size={size}
    >
      <div className="poster poster-frame">
        <button
          type="button"
          className="poster-trigger"
          aria-label={`${title} detaylarını gör`}
          onClick={() => onOpenDetails(item)}
        >
          <div className="poster-fallback" aria-hidden="true">
            <svg className="icon">
              <use href="#icon-film"></use>
            </svg>
            <span className="poster-fallback-title">{title}</span>
          </div>

          {poster && !posterFailed && (
            <img
              src={poster}
              alt=""
              loading={_eager ? 'eager' : 'lazy'}
              decoding="async"
              referrerPolicy="no-referrer"
              fetchPriority={_eager ? 'high' : undefined}
              onError={() => setPosterFailed(true)}
            />
          )}
        </button>

        {/* Top-left Badges row */}
        <div className="poster-badges-row">
          {size !== 'xs' && <span className="badge badge-kind">{kind}</span>}

          {shouldRenderMatchBadge && roundedScore !== null && (
            <span
              className="match-badge tabular-nums"
              title={`Zevk uyumu: ${roundedScore}/100${ringLabel ? ` (${ringLabel})` : ''}`}
              aria-label={formatMatchBadge(roundedScore)}
            >
              {formatMatchBadge(roundedScore)}
            </span>
          )}

          {shouldRenderMatchBadge && roundedScore === null && Boolean(recommendationReason) && (
            <span
              className="match-badge"
              title="Kişisel listene göre önerilen yapım"
              aria-label="Kişiselleştirilmiş öneri"
            >
              Öneri
            </span>
          )}

            {shouldRenderRingChip && ringKey && (
            <span
              className={`ring-chip ring-chip--${isRing0 ? '0' : isRing1 ? '1' : isRing2 ? '2' : 'orbit'}`}
              title={`Zevk Halkası: ${ringLabel}`}
              aria-label={ringLabel}
            >
              <span className="ring-chip-dot" aria-hidden="true" />
              {size !== 'xs' && size !== 'sm' && (
                <>
                  {' '}
                  <span className="ring-chip-text">{ringLabel}</span>
                </>
              )}
            </span>
          )}

          {countdownText && (
            <span className="release-countdown" title={`Yayın tarihi: ${airDate}`}>
              {countdownText}
            </span>
          )}

          {(item._source === 'stale-cache' || item.stale) && size !== 'xs' && (
            <span
              className="source-tag source-stale"
              title="Canlı TMDB'ye anlık erişilemediği için bu yapım önceki önbellekten sunuldu"
            >
              Önbellek
            </span>
          )}

          {item._source === 'demo' && size !== 'xs' && (
            <span
              className="source-tag source-demo"
              title="TMDB API anahtarı girilmediğinden örnek katalogdan listelendi"
            >
              Demo
            </span>
          )}
        </div>

        {/* Quick action buttons stack (top-right) */}
        {(onSetStatus || onToggleDislike || onQuickSave) && size !== 'xs' && (
          <div className="poster-actions-stack" onClick={(e) => e.stopPropagation()}>
            {onSetStatus && (
              <button
                type="button"
                className={`poster-action-btn action-watchlist ${status === 'watchlist' ? 'is-active' : ''}`}
                aria-label={
                  status === 'watchlist'
                    ? `${title} izlenecekler listesinde (Düzenle)`
                    : `${title} izlenecekler listesine ekle`
                }
                title={status === 'watchlist' ? 'İzlenecekler listesinde (Düzenle)' : 'İzlenecek listesine ekle (+)'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (status === 'watchlist' && onQuickSave) {
                    onQuickSave(item);
                  } else {
                    onSetStatus(item, 'watchlist');
                  }
                }}
              >
                <svg className="icon" aria-hidden="true">
                  <use href={status === 'watchlist' ? '#icon-check' : '#icon-plus'}></use>
                </svg>
              </button>
            )}

            {onSetStatus && (
              <button
                type="button"
                className={`poster-action-btn action-watching ${status === 'watching' ? 'is-active' : ''}`}
                aria-label={
                  status === 'watching'
                    ? `${title} şu an izleniyor (Düzenle)`
                    : `${title} izleniyor listesine ekle`
                }
                title={status === 'watching' ? 'Şu an izleniyor (Düzenle)' : 'İzleniyor listesine ekle (▶)'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (status === 'watching' && onQuickSave) {
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
            )}

            {onSetStatus && (
              <button
                type="button"
                className={`poster-action-btn action-completed ${status === 'completed' ? 'is-active' : ''}`}
                aria-label={
                  status === 'completed'
                    ? `${title} izlendi olarak kayıtlı (Düzenle)`
                    : `${title} izlendi listesine ekle`
                }
                title={status === 'completed' ? 'İzlendi olarak kayıtlı (Düzenle)' : 'İzlendi listesine ekle (✓)'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (status === 'completed' && onQuickSave) {
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
            )}

            {onToggleDislike && (
              <button
                type="button"
                className={`poster-action-btn action-dislike ${isDisliked ? 'is-active' : ''}`}
                aria-label={
                  isDisliked
                    ? `${title} ilgilenmiyorum listesinden kaldır`
                    : `${title} ilgilenmiyorum olarak işaretle`
                }
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
            )}
          </div>
        )}

        {/* Bottom poster badges row (saved status, TMDB rating, personal rating) */}
        {size !== 'xs' && (tmdbRating > 0 || savedItem || personalRating) && (
          <div className="poster-bottom-row">
            {savedItem && (
              <span className={`saved-badge status-${status}`}>
                <svg className="icon" aria-hidden="true">
                  <use href={`#${statusIcon}`}></use>
                </svg>{' '}
                <span>{statusText}</span>
              </span>
            )}

            {tmdbRating > 0 && (
              <span className={`rating ${ratingClass}`} aria-label={`TMDB puanı ${tmdbRating.toFixed(1)}`}>
                <svg className="icon" aria-hidden="true">
                  <use href="#icon-star"></use>
                </svg>{' '}
                <span className="tabular-nums">{tmdbRating.toFixed(1)}</span>
              </span>
            )}

            {personalRating && (
              <span
                className="personal-rating tabular-nums"
                aria-label={`Kişisel puan ${personalRating} üzerinden 10`}
              >
                ★ {personalRating}/10
              </span>
            )}
          </div>
        )}

        {/* Hover / Odak overlay */}
        <div className="poster-overlay">
          {savedItem ? (
            <div className={`overlay-saved-pill status-${status}`}>
              <svg className="icon" aria-hidden="true">
                <use href={`#${statusIcon}`}></use>
              </svg>{' '}
              <span>{statusText}</span>
            </div>
          ) : onQuickAdd ? (
            <button
              className="overlay-btn overlay-add-btn"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onQuickAdd(item);
              }}
              title="İzleme listeme ekle"
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-plus"></use>
              </svg>{' '}
              <span>Listeme Ekle</span>
            </button>
          ) : null}

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
            </svg>{' '}
            <span>Detaylar</span>
          </button>
        </div>
      </div>

      {/* Card Info footer */}
      <div className="card-info">
        <button
          className="card-title clamp-2"
          type="button"
          onClick={() => onOpenDetails(item)}
          title={title}
        >
          {title}
        </button>

        {size !== 'xs' && (
          <div className="card-meta">
            <span
              className="card-date tabular-nums clamp-1"
              title={item.media_type === 'tv' ? 'İlk ve son yayınlanma yılları' : 'Yapım yılı'}
            >
              {formatMediaDates(item, savedItem)}
            </span>
            {(size === 'lg' || size === 'xl' || size === 'md') && genreNames && (
              <>
                {' '}
                <span className="card-meta-sep" aria-hidden="true">
                  ·
                </span>{' '}
                <span className="card-genres clamp-1">{genreNames}</span>
              </>
            )}
          </div>
        )}

        {seasonProgressInfo && (
          <div className="season-progress">
            <progress
              className="season-progress-native"
              value={seasonProgressInfo.percent}
              max={100}
              aria-label={`Toplam sezon ilerlemesi: %${seasonProgressInfo.percent}`}
            />{' '}
            <span className="season-progress-label tabular-nums">
              %{seasonProgressInfo.percent} · {seasonProgressInfo.watched}/{seasonProgressInfo.total}
            </span>
          </div>
        )}

        {recommendationReason && size !== 'xs' && (
          <div className="recommendation-reason clamp-1" title={recommendationReason}>
            {recommendationReason}
          </div>
        )}

        {related && <div className="card-related-slot">{related}</div>}
      </div>
    </article>
  );
};

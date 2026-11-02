import React, { useMemo, useState, useEffect } from 'react';
import type { FavoriteActorInfo, Profile, SavedItem } from '../core/cinetrack-core.ts';
import {
  buildYearlyWrappedSummary,
  computeAvailableWrappedYears,
} from '../core/wrapped-summary.ts';
import { imageUrl, handleImageError } from '../utils/helpers.ts';

interface WrappedCardProps {
  items: SavedItem[];
  profileName?: string;
  favoriteActors?: FavoriteActorInfo[];
  genresMap?: Record<number, string>;
  onSelectItem?: (id: number | string, mediaType: 'movie' | 'tv') => void;
}

export const WrappedCard: React.FC<WrappedCardProps> = ({
  items,
  profileName = 'Profilim',
  favoriteActors = [],
  genresMap = {},
  onSelectItem,
}) => {
  const availableYears = useMemo(() => computeAvailableWrappedYears(items), [items]);
  const [selectedYear, setSelectedYear] = useState<number>(
    () => availableYears[0] || new Date().getFullYear()
  );
  const [isExpanded, setIsExpanded] = useState<boolean>(true);

  useEffect(() => {
    if (availableYears.length > 0 && !availableYears.includes(selectedYear)) {
      setSelectedYear(availableYears[0]);
    }
  }, [availableYears, selectedYear]);

  const summary = useMemo(() => {
    const profileSlice: Profile = {
      id: 'wrapped-profile',
      name: profileName,
      createdAt: '',
      preferences: {
        disliked: [],
        providers: [],
        mood: '',
        reminders: false,
        notified: [],
      },
      items,
      favoriteActors,
    };
    return buildYearlyWrappedSummary(profileSlice, selectedYear, genresMap);
  }, [items, profileName, favoriteActors, selectedYear, genresMap]);

  if (items.length === 0 || summary.totalItems === 0) {
    return null;
  }

  const mostLovedPoster = summary.mostLovedItem?.posterPath
    ? summary.mostLovedItem.posterPath.startsWith('http')
      ? summary.mostLovedItem.posterPath
      : imageUrl(summary.mostLovedItem.posterPath, 'w185')
    : '';

  return (
    <article className="wrapped-summary-card" aria-label={`${summary.year} Sinema Künyen`}>
      <header className="wrapped-card-header">
        <div className="wrapped-card-title-group">
          <div className="wrapped-card-eyebrow tabular-nums">
            {summary.usedAllTimeFallback ? 'TÜM ZAMANLAR KÜNYESİ' : `${summary.year} YIL KÜNYESİ`}
          </div>
          <h3 className="wrapped-card-title tabular-nums">
            {summary.year} Sinema Künyen
          </h3>
          <p className="wrapped-card-subtitle">
            {summary.dnaHeadline}
            {summary.peakMonthLabel ? ` · Zirve ay: ${summary.peakMonthLabel}` : ''}
          </p>
        </div>

        <div className="wrapped-card-controls">
          {availableYears.length > 1 && (
            <div className="wrapped-year-switcher" role="group" aria-label="Künye yılı seçimi">
              {availableYears.slice(0, 4).map((yr) => (
                <button
                  key={yr}
                  type="button"
                  className={`wrapped-year-btn tabular-nums whitespace-nowrap ${
                    yr === selectedYear ? 'is-active' : ''
                  }`}
                  onClick={() => setSelectedYear(yr)}
                  aria-pressed={yr === selectedYear}
                >
                  {yr}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="btn btn-sm whitespace-nowrap"
            onClick={() => setIsExpanded((prev) => !prev)}
            aria-expanded={isExpanded}
          >
            {isExpanded ? 'Daralt' : 'Künyeyi Aç'}
          </button>
        </div>
      </header>

      {isExpanded && (
        <div className="wrapped-card-body">
          {/* KPI Strip */}
          <div className="wrapped-kpi-strip tabular-nums">
            <div className="wrapped-kpi-item">
              <span className="wrapped-kpi-label">Kayıt & İzlenen</span>
              <strong className="wrapped-kpi-val">
                {summary.totalItems} yapım · {summary.completedCount} bitti
              </strong>
              <span className="wrapped-kpi-meta">
                {summary.movieCount} film · {summary.tvCount} dizi
              </span>
            </div>

            <div className="wrapped-kpi-item">
              <span className="wrapped-kpi-label">Ekran Süresi</span>
              <strong className="wrapped-kpi-val">{summary.estimatedHours} saat</strong>
              <span className="wrapped-kpi-meta">Tamamlanan & izlenen tahmini</span>
            </div>

            <div className="wrapped-kpi-item">
              <span className="wrapped-kpi-label">Kişisel Puan Ortalaması</span>
              <strong className="wrapped-kpi-val">
                {summary.averagePersonalRating !== null
                  ? `${summary.averagePersonalRating} / 10`
                  : 'Henüz puan yok'}
              </strong>
              <span className="wrapped-kpi-meta">{summary.ratedCount} puanlanan yapım</span>
            </div>
          </div>

          {/* Top 3 Genres / Eras / Actors */}
          <div className="wrapped-triad-grid">
            <div className="wrapped-triad-col">
              <span className="wrapped-section-label">En Çok İzlenen 3 Tür</span>
              {summary.topGenres.length > 0 ? (
                <ul className="wrapped-ranked-list tabular-nums">
                  {summary.topGenres.map((g, idx) => (
                    <li key={g.id} className="wrapped-ranked-row">
                      <span className="wrapped-rank-num">{idx + 1}.</span>
                      <span className="wrapped-rank-name">{g.name}</span>
                      <span className="wrapped-rank-stat">
                        %{g.sharePercent} · {g.count}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="wrapped-empty-note">Tür verisi bekleniyor</p>
              )}
            </div>

            <div className="wrapped-triad-col">
              <span className="wrapped-section-label">En Çok İzlenen 3 Dönem</span>
              {summary.topEras.length > 0 ? (
                <ul className="wrapped-ranked-list tabular-nums">
                  {summary.topEras.map((e, idx) => (
                    <li key={e.era} className="wrapped-ranked-row">
                      <span className="wrapped-rank-num">{idx + 1}.</span>
                      <span className="wrapped-rank-name">{e.era}</span>
                      <span className="wrapped-rank-stat">
                        %{e.sharePercent} · {e.count}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="wrapped-empty-note">Yayın yılı verisi bekleniyor</p>
              )}
            </div>

            <div className="wrapped-triad-col">
              <span className="wrapped-section-label">En Çok İzlenen 3 Oyuncu</span>
              {summary.topActors.length > 0 ? (
                <ul className="wrapped-ranked-list tabular-nums">
                  {summary.topActors.map((actor, idx) => (
                    <li key={actor.id} className="wrapped-ranked-row">
                      <span className="wrapped-rank-num">{idx + 1}.</span>
                      <span className="wrapped-rank-name clamp-1">{actor.name}</span>
                      <span className="wrapped-rank-stat">{actor.count} yapım</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="wrapped-empty-note">Kadro verisi zenginleştiriliyor</p>
              )}
            </div>
          </div>

          {/* Bottom Row: 12-Month Intensity + Most Loved Title */}
          <div className="wrapped-bottom-grid">
            <div className="wrapped-months-box">
              <div className="wrapped-months-header">
                <span className="wrapped-section-label">Aylık İzleme Yoğunluğu</span>
                <span className="wrapped-months-caption tabular-nums">12 ay dağılımı</span>
              </div>
              <div className="wrapped-months-bars" role="list" aria-label="Aylık izleme yoğunluğu">
                {summary.monthlyIntensity.map((m) => {
                  const barHeight = Math.max(4, Math.round(m.intensityRatio * 36));
                  const barY = 40 - barHeight;
                  return (
                    <div
                      key={m.monthIndex}
                      role="listitem"
                      className="wrapped-month-col tabular-nums"
                      title={`${m.fullLabel}: ${m.count} yapım`}
                    >
                      <svg
                        className="wrapped-month-svg"
                        viewBox="0 0 14 40"
                        aria-hidden="true"
                      >
                        <rect
                          className="wrapped-month-track"
                          x="2"
                          y="4"
                          width="10"
                          height="36"
                          rx="3"
                        />
                        <rect
                          className={
                            m.count > 0 ? 'wrapped-month-fill is-non-zero' : 'wrapped-month-fill'
                          }
                          x="2"
                          y={barY}
                          width="10"
                          height={barHeight}
                          rx="3"
                        />
                      </svg>
                      <span className="wrapped-month-label">{m.shortLabel}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {summary.mostLovedItem && (
              <div className="wrapped-favorite-box">
                <span className="wrapped-section-label">Yılın En Sevilen Yapımı</span>
                <button
                  type="button"
                  className="wrapped-favorite-card"
                  onClick={() =>
                    onSelectItem?.(
                      summary.mostLovedItem!.id,
                      summary.mostLovedItem!.media_type
                    )
                  }
                >
                  {mostLovedPoster ? (
                    <img
                      src={mostLovedPoster}
                      alt=""
                      className="wrapped-favorite-poster"
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={(e) => handleImageError(e, mostLovedPoster, 'w185')}
                    />
                  ) : (
                    <div className="wrapped-favorite-poster wrapped-favorite-poster--fallback">
                      <svg className="icon" aria-hidden="true">
                        <use href="#icon-film" />
                      </svg>
                    </div>
                  )}
                  <div className="wrapped-favorite-info tabular-nums">
                    <strong className="wrapped-favorite-title clamp-1">
                      {summary.mostLovedItem.title}
                    </strong>
                    <span className="wrapped-favorite-meta">
                      {summary.mostLovedItem.media_type === 'tv' ? 'Dizi' : 'Film'}
                      {summary.mostLovedItem.releaseYear
                        ? ` · ${summary.mostLovedItem.releaseYear}`
                        : ''}
                      {summary.mostLovedItem.personalRating !== null
                        ? ` · Kişisel: ${summary.mostLovedItem.personalRating}/10`
                        : ` · TMDB: ${summary.mostLovedItem.tmdbRating}`}
                    </span>
                    <span className="wrapped-favorite-match">
                      Zevk vektörü uyumu %{summary.mostLovedItem.tasteMatchPercent}
                    </span>
                  </div>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </article>
  );
};

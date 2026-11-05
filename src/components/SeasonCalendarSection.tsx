import React, { useMemo } from 'react';
import { type SavedItem } from '../core/cinetrack-core.ts';
import { extractUpcomingReleaseEvents, generateIcsCalendar } from '../core/exporters.ts';
import { deriveTvProgressSummary } from '../core/tv-progress.ts';
import { t } from '../i18n/index.ts';

interface SeasonCalendarSectionProps {
  savedItems: SavedItem[];
  onSelectMedia?: (id: number | string, type: 'movie' | 'tv') => void;
  onIncrementEpisode?: (item: SavedItem) => void;
}

export const SeasonCalendarSection: React.FC<SeasonCalendarSectionProps> = ({
  savedItems,
  onSelectMedia,
  onIncrementEpisode,
}) => {
  const dict = t();
  const events = useMemo(() => extractUpcomingReleaseEvents(savedItems), [savedItems]);

  const watchingSeries = useMemo(() => {
    return savedItems
      .filter((item) => item.media_type === 'tv' && item.status === 'watching')
      .map((item) => ({
        item,
        progress: deriveTvProgressSummary(item),
      }))
      .sort((a, b) =>
        String(b.item.updatedAt || b.item.addedAt || '').localeCompare(
          String(a.item.updatedAt || a.item.addedAt || '')
        )
      );
  }, [savedItems]);

  if (events.length === 0 && watchingSeries.length === 0) {
    return null;
  }

  const handleDownloadIcs = () => {
    const icsContent = generateIcsCalendar(events);
    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `cinethos-yayin-takvimi-${new Date().toISOString().slice(0, 10)}.ics`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <section className="season-calendar-section" aria-label={dict.seasonCalendarTitle}>
      {watchingSeries.length > 0 && (
        <div className="tv-continue-block">
          <div className="season-calendar-header">
            <div>
              <h3 className="season-calendar-title">Kaldığım Yerden Devam</h3>
              <p className="season-calendar-subtitle tabular-nums">
                Aktif izlediğiniz dizilerde sezon ve bölüm ilerlemesi ({watchingSeries.length} dizi)
              </p>
            </div>
          </div>

          <div className="tv-continue-grid">
            {watchingSeries.slice(0, 8).map(({ item, progress }) => {
              const seriesTitle = item.title || item.name || 'İsimsiz Dizi';
              return (
                <article key={`tv-prog-${item.id}`} className="tv-continue-card tabular-nums">
                  <div className="tv-continue-card-main">
                    <button
                      type="button"
                      className="tv-continue-title clamp-1"
                      onClick={() => onSelectMedia?.(item.id, 'tv')}
                      title={seriesTitle}
                    >
                      {seriesTitle}
                    </button>
                    <span className="tv-continue-position">{progress.detailLabel}</span>
                    {progress.totalEpisodesCount && progress.totalEpisodesCount > 0 ? (
                      <div className="tv-continue-bar-track" aria-hidden="true">
                        <progress
                          className="tv-continue-progress-native"
                          value={progress.progressPercent}
                          max={100}
                        />
                      </div>
                    ) : null}
                  </div>
                  {onIncrementEpisode && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm whitespace-nowrap tv-continue-step-btn"
                      onClick={() => onIncrementEpisode(item)}
                      aria-label={`${seriesTitle} için bir sonraki bölüme geç`}
                    >
                      +1 Bölüm
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div className="upcoming-calendar-block">
          <div className="season-calendar-header">
            <div>
              <h3 className="season-calendar-title">{dict.seasonCalendarTitle}</h3>
              <p className="season-calendar-subtitle tabular-nums">
                Takip listenizdeki dizi ve filmlerin yaklaşan yayın tarihleri ({events.length} etkinlik)
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm whitespace-nowrap"
              onClick={handleDownloadIcs}
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-calendar" />
              </svg>
              <span>{dict.downloadIcsButton}</span>
            </button>
          </div>

          <div className="season-calendar-list">
            {events.slice(0, 8).map((ev) => (
              <button
                key={ev.uid}
                type="button"
                className="season-calendar-card"
                onClick={() => onSelectMedia?.(ev.mediaId, ev.mediaType)}
              >
                <span className="season-calendar-date tabular-nums">{ev.date}</span>
                <span className="season-calendar-item-title">{ev.title}</span>
                <span className="season-calendar-item-meta">{ev.subtitle}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
};


import React, { useMemo } from 'react';
import { type SavedItem } from '../core/cinetrack-core';
import { extractUpcomingReleaseEvents, generateIcsCalendar } from '../core/exporters';
import { t } from '../i18n';

interface SeasonCalendarSectionProps {
  savedItems: SavedItem[];
  onSelectMedia?: (id: number | string, type: 'movie' | 'tv') => void;
}

export const SeasonCalendarSection: React.FC<SeasonCalendarSectionProps> = ({
  savedItems,
  onSelectMedia,
}) => {
  const dict = t();
  const events = useMemo(() => extractUpcomingReleaseEvents(savedItems), [savedItems]);

  if (events.length === 0) {
    return null;
  }

  const handleDownloadIcs = () => {
    const icsContent = generateIcsCalendar(events);
    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `cinetrack-yayin-takvimi-${new Date().toISOString().slice(0, 10)}.ics`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <section className="season-calendar-section" aria-label={dict.seasonCalendarTitle}>
      <div className="season-calendar-header">
        <div>
          <h3 className="season-calendar-title">{dict.seasonCalendarTitle}</h3>
          <p className="season-calendar-subtitle">
            Takip listenizdeki dizi ve filmlerin yaklaşan yayın tarihleri ({events.length} etkinlik)
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={handleDownloadIcs}>
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
            <span className="season-calendar-date">{ev.date}</span>
            <span className="season-calendar-item-title">{ev.title}</span>
            <span className="season-calendar-item-meta">{ev.subtitle}</span>
          </button>
        ))}
      </div>
    </section>
  );
};

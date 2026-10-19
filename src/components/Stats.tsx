import React from 'react';
import { SavedItem } from '../core/cinetrack-core';
import { calculateItemWatchMinutes } from '../utils/helpers';

interface StatsProps {
  items: SavedItem[];
}

export const Stats: React.FC<StatsProps> = ({ items }) => {
  const total = items.length;
  const watching = items.filter((item) => item.status === 'watching').length;
  const completed = items.filter((item) => item.status === 'completed').length;
  const rated = items.filter(
    (item) => Number.isFinite(Number(item.personal_rating)) && item.personal_rating !== ''
  );
  const average = rated.length
    ? `${(
        rated.reduce((sum, item) => sum + Number(item.personal_rating), 0) / rated.length
      ).toFixed(1)} / 10`
    : 'Yok';

  let totalMinutes = 0;
  for (const item of items) {
    totalMinutes += calculateItemWatchMinutes(item);
  }

  let watchTimeString = '0 sa';
  if (totalMinutes > 0) {
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    watchTimeString = days > 0 ? `${days}g ${hours}sa` : `${hours} sa`;
  }

  return (
    <section className="stats" aria-label="İzleme istatistikleri">
      <div className="stat">
        <div className="stat-icon">
          <svg className="icon" aria-hidden="true">
            <use href="#icon-library"></use>
          </svg>
        </div>
        <div>
          <div className="stat-label">Listemde</div>
          <div id="statTotal" className="stat-value">
            {total}
          </div>
        </div>
      </div>

      <div className="stat">
        <div className="stat-icon">
          <svg className="icon" aria-hidden="true">
            <use href="#icon-play"></use>
          </svg>
        </div>
        <div>
          <div className="stat-label">İzliyorum</div>
          <div id="statWatching" className="stat-value">
            {watching}
          </div>
        </div>
      </div>

      <div className="stat">
        <div className="stat-icon">
          <svg className="icon" aria-hidden="true">
            <use href="#icon-check"></use>
          </svg>
        </div>
        <div>
          <div className="stat-label">Tamamlandı</div>
          <div id="statDone" className="stat-value">
            {completed}
          </div>
        </div>
      </div>

      <div className="stat">
        <div className="stat-icon">
          <svg className="icon" aria-hidden="true">
            <use href="#icon-star"></use>
          </svg>
        </div>
        <div>
          <div className="stat-label">Kişisel ortalama</div>
          <div id="statAverage" className="stat-value">
            {average}
          </div>
        </div>
      </div>

      <div className="stat">
        <div className="stat-icon">
          <svg className="icon" aria-hidden="true">
            <use href="#icon-clock"></use>
          </svg>
        </div>
        <div>
          <div className="stat-label">İzleme süresi</div>
          <div id="statWatchTime" className="stat-value">
            {watchTimeString}
          </div>
        </div>
      </div>
    </section>
  );
};

import React, { useMemo } from 'react';
import { SavedItem } from '../core/cinetrack-core';
import { calculateItemWatchMinutes } from '../utils/helpers';

interface StatsProps {
  items: SavedItem[];
}

export const Stats: React.FC<StatsProps> = ({ items }) => {
  const statsData = useMemo(() => {
    const total = items.length;
    let totalMinutes = 0;
    const genreCounts: Record<string, number> = {};
    const actorCounts: Record<string, number> = {};
    const yearCounts: Record<string, number> = {};

    for (const item of items) {
      totalMinutes += calculateItemWatchMinutes(item);

      // Genre stats
      const genres = (item as any).genres || [];
      for (const g of genres) {
        const name = typeof g === 'string' ? g : g.name;
        if (name) genreCounts[name] = (genreCounts[name] || 0) + 1;
      }

      // Year stats
      const year = (item.release_date || item.first_air_date || (item as any).year || '').slice(0, 4);
      if (year && /^\d{4}$/.test(year)) {
        yearCounts[year] = (yearCounts[year] || 0) + 1;
      }
    }

    // Top Genre
    const sortedGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]);
    const topGenre = sortedGenres.length ? `${sortedGenres[0][0]} (${sortedGenres[0][1]})` : 'Henüz veri yok';

    // Top Actor (if present in item credits)
    const sortedActors = Object.entries(actorCounts).sort((a, b) => b[1] - a[1]);
    const topActor = sortedActors.length ? sortedActors[0][0] : 'Takip ediliyor';

    // Watch time formatted
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const watchTimeString = days > 0 ? `${days}g ${hours}sa` : `${hours} sa`;

    // Year summary (Wrapped insight)
    const currentYear = new Date().getFullYear().toString();
    const currentYearCount = items.filter(
      (item) => (item.addedAt || '').startsWith(currentYear)
    ).length;

    return {
      total,
      watchTimeString,
      totalMinutes,
      topGenre,
      topActor,
      currentYearCount,
      currentYear,
    };
  }, [items]);

  if (items.length === 0) {
    return null;
  }

  return (
    <section className="stats-dashboard" aria-label="Kişisel Sinema İstatistikleri">
      {/* 2x2 Metrik Kartları (Section 6.9) */}
      <div className="stats-2x2-grid">
        {/* 1. İzlenen Süre */}
        <div className="stat-card">
          <div className="stat-card-header">
            <svg className="icon stat-icon" aria-hidden="true">
              <use href="#icon-clock"></use>
            </svg>
            <span className="stat-label">İzlenen Süre</span>
          </div>
          <div className="stat-value tabular-nums">{statsData.watchTimeString}</div>
          <span className="stat-sub">Toplam kaydedilen süre</span>
        </div>

        {/* 2. İçerik Sayısı */}
        <div className="stat-card">
          <div className="stat-card-header">
            <svg className="icon stat-icon" aria-hidden="true">
              <use href="#icon-library"></use>
            </svg>
            <span className="stat-label">İçerik Sayısı</span>
          </div>
          <div className="stat-value tabular-nums">{statsData.total}</div>
          <span className="stat-sub">Film ve dizi arşivi</span>
        </div>

        {/* 3. En Çok İzlenen Tür */}
        <div className="stat-card">
          <div className="stat-card-header">
            <svg className="icon stat-icon" aria-hidden="true">
              <use href="#icon-dna"></use>
            </svg>
            <span className="stat-label">En Çok Tür</span>
          </div>
          <div className="stat-value stat-value--text clamp-1" title={statsData.topGenre}>
            {statsData.topGenre}
          </div>
          <span className="stat-sub">Zevk profili ağırlığı</span>
        </div>

        {/* 4. Yıl Özeti (Wrapped Hazırlığı) */}
        <div className="stat-card stat-card--wrapped">
          <div className="stat-card-header">
            <svg className="icon stat-icon" aria-hidden="true">
              <use href="#icon-calendar"></use>
            </svg>
            <span className="stat-label">{statsData.currentYear} Seçkisi</span>
          </div>
          <div className="stat-value tabular-nums">
            {statsData.currentYearCount > 0 ? `${statsData.currentYearCount} yapım` : 'Arşivleniyor'}
          </div>
          <span className="stat-sub">Bu yıl listene eklenenler</span>
        </div>
      </div>
    </section>
  );
};

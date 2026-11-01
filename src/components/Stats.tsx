import React, { useMemo } from 'react';
import { SavedItem } from '../core/cinetrack-core';
import { calculateItemWatchMinutes } from '../utils/helpers';
import { buildTasteDnaProfile } from '../core/exporters';

interface StatsProps {
  items: SavedItem[];
  profileName?: string;
  genresMap?: Record<number, string>;
}

export const Stats: React.FC<StatsProps> = ({ items, profileName, genresMap }) => {
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

    const tasteDna = buildTasteDnaProfile(
      {
        id: 'active',
        name: profileName || 'Profilim',
        items,
        preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
      } as any,
      genresMap || {}
    );

    return {
      total,
      watchTimeString,
      totalMinutes,
      topGenre,
      topActor,
      currentYearCount,
      currentYear,
      tasteDna,
    };
  }, [items, profileName, genresMap]);

  if (items.length === 0) {
    return null;
  }

  return (
    <section className="stats-dashboard" aria-label="Kişisel Sinema İstatistikleri">
      {/* 2x2 Metrik Kartları (Section 6.9) */}
      <div className="stats-2x2-grid">
        {/* 1. İzlenen Süre */}
        <div
          className="stat-card"
          title="Süre verisi eksik filmler için 110 dk, diziler için bölüm başı 45 dk varsayılan tahmin uygulanır."
        >
          <div className="stat-card-header">
            <svg className="icon stat-icon" aria-hidden="true">
              <use href="#icon-clock"></use>
            </svg>
            <span className="stat-label">İzlenen Süre (tahmini)</span>
          </div>
          <div className="stat-value tabular-nums">{statsData.watchTimeString}</div>
          <span className="stat-sub">Kaydedilen ve tahmini toplam süre</span>
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

      {/* IMP-03: Zevk İmzası (Taste DNA) Özet Kartı */}
      {statsData.tasteDna && statsData.total >= 3 && (
        <div
          className="taste-dna-summary-card"
          style={{
            marginTop: '12px',
            padding: '14px 18px',
            background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.7) 0%, rgba(15, 23, 42, 0.85) 100%)',
            border: '1px solid rgba(99, 102, 241, 0.25)',
            borderRadius: '14px',
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.2)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: '#818cf8', letterSpacing: '0.02em' }}>
                🧬 Sinematik Zevk İmzası
              </span>
              <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                · {statsData.tasteDna.profileName}
              </span>
            </div>
            <span style={{ fontSize: '11px', color: '#a5b4fc', background: 'rgba(99, 102, 241, 0.15)', padding: '2px 8px', borderRadius: '999px' }}>
              {statsData.tasteDna.dominantEra}
            </span>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
            {statsData.tasteDna.signatureTraits.map((trait) => (
              <div
                key={trait.label}
                style={{
                  background: 'rgba(15, 23, 42, 0.6)',
                  border: '1px solid rgba(51, 65, 85, 0.5)',
                  borderRadius: '8px',
                  padding: '6px 10px',
                  fontSize: '12px',
                  flex: '1 1 180px',
                }}
              >
                <div style={{ color: '#94a3b8', fontSize: '11px' }}>{trait.label}</div>
                <div style={{ fontWeight: 600, color: '#f1f5f9', marginTop: '2px' }}>{trait.value}</div>
                <div style={{ color: '#64748b', fontSize: '10px', marginTop: '1px' }}>{trait.detail}</div>
              </div>
            ))}
          </div>

          {statsData.tasteDna.topGenres.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '11px', color: '#94a3b8' }}>
              <span style={{ color: '#64748b' }}>Baskın Türler:</span>
              {statsData.tasteDna.topGenres.map((g) => (
                <span
                  key={g.id}
                  style={{
                    background: 'rgba(99, 102, 241, 0.12)',
                    color: '#c7d2fe',
                    padding: '2px 7px',
                    borderRadius: '6px',
                    border: '1px solid rgba(99, 102, 241, 0.2)',
                  }}
                >
                  {g.name} (%{g.sharePercent})
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

import React, { useEffect, useMemo, useState } from 'react';
import type { FavoriteActorInfo, Profile, SavedItem } from '../core/cinetrack-core';
import { calculateItemWatchMinutes } from '../utils/helpers';
import { buildTasteDnaProfile } from '../core/exporters';
import {
  formatLastBackupLabel,
  getAutoBackupMeta,
  subscribeAutoBackupMeta,
  type AutoBackupMeta,
} from '../services/auto-backup-service';
import { WrappedCard } from './WrappedCard';
import { DuplicateMergePanel } from './DuplicateMergePanel';

interface StatsProps {
  items: SavedItem[];
  profileName?: string;
  favoriteActors?: FavoriteActorInfo[];
  genresMap?: Record<number, string>;
  onSelectItem?: (id: number | string, mediaType: 'movie' | 'tv') => void;
  onMergeDuplicates?: (
    keepId: SavedItem['id'],
    dropId: SavedItem['id'],
    mediaType: 'movie' | 'tv'
  ) => void;
}

const FALLBACK_GENRE_NAMES: Record<number, string> = {
  28: 'Aksiyon',
  12: 'Macera',
  16: 'Animasyon',
  35: 'Komedi',
  80: 'Suç',
  99: 'Belgesel',
  18: 'Dram',
  10751: 'Aile',
  14: 'Fantastik',
  36: 'Tarih',
  27: 'Korku',
  10402: 'Müzik',
  9648: 'Gizem',
  10749: 'Romantik',
  878: 'Bilim Kurgu',
  53: 'Gerilim',
  10752: 'Savaş',
  37: 'Vahşi Batı',
  10759: 'Aksiyon & Macera',
  10765: 'Bilim Kurgu & Fantazi',
};

export const Stats: React.FC<StatsProps> = ({
  items,
  profileName,
  favoriteActors = [],
  genresMap,
  onSelectItem,
  onMergeDuplicates,
}) => {
  const [backupMeta, setBackupMeta] = useState<AutoBackupMeta>(() => getAutoBackupMeta());

  useEffect(() => {
    return subscribeAutoBackupMeta((next) => {
      setBackupMeta(next);
    });
  }, []);

  const statsData = useMemo(() => {
    const total = items.length;
    let totalMinutes = 0;
    const genreCounts: Record<string, number> = {};
    const effectiveGenres: Record<number, string> = {
      ...FALLBACK_GENRE_NAMES,
      ...(genresMap || {}),
    };

    for (const item of items) {
      totalMinutes += calculateItemWatchMinutes(item);

      for (const gid of item.genre_ids || []) {
        const name = effectiveGenres[Number(gid)];
        if (name) {
          genreCounts[name] = (genreCounts[name] || 0) + 1;
        }
      }
    }

    const sortedGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]);
    const topGenre = sortedGenres.length
      ? `${sortedGenres[0][0]} (${sortedGenres[0][1]})`
      : 'Henüz veri yok';

    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const watchTimeString = days > 0 ? `${days}g ${hours}sa` : `${hours} sa`;

    const currentYear = new Date().getFullYear().toString();
    const currentYearCount = items.filter((item) =>
      (item.addedAt || item.updatedAt || '').startsWith(currentYear)
    ).length;

    const syntheticProfile: Profile = {
      id: 'active',
      name: profileName || 'Profilim',
      createdAt: '',
      items,
      favoriteActors,
      preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
    };

    const tasteDna = buildTasteDnaProfile(syntheticProfile, effectiveGenres);

    return {
      total,
      watchTimeString,
      totalMinutes,
      topGenre,
      currentYearCount,
      currentYear,
      tasteDna,
    };
  }, [items, profileName, favoriteActors, genresMap]);

  if (items.length === 0) {
    return null;
  }

  return (
    <section className="stats-dashboard" aria-label="Kişisel Sinema İstatistikleri">
      <div className="stats-backup-statusbar tabular-nums">
        <span className="stats-backup-status-text">{formatLastBackupLabel(backupMeta)}</span>
        <span className="stats-backup-counter">
          Otomatik yedek sayacı: {backupMeta.changesSinceLastBackup}/25 değişiklik
        </span>
      </div>

      <div className="stats-2x2-grid">
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

      {statsData.tasteDna && statsData.total >= 3 && (
        <div className="taste-dna-summary-card">
          <div className="taste-dna-summary-head">
            <div className="taste-dna-summary-title-group">
              <span className="taste-dna-summary-title">Sinematik Zevk İmzası</span>
              <span className="taste-dna-summary-profile">· {statsData.tasteDna.profileName}</span>
            </div>
            <span className="taste-dna-era-label">{statsData.tasteDna.dominantEra}</span>
          </div>

          <div className="taste-dna-traits-grid">
            {statsData.tasteDna.signatureTraits.map((trait) => (
              <div key={trait.label} className="taste-dna-trait-item">
                <div className="taste-dna-trait-label">{trait.label}</div>
                <div className="taste-dna-trait-value">{trait.value}</div>
                <div className="taste-dna-trait-detail">{trait.detail}</div>
              </div>
            ))}
          </div>

          {statsData.tasteDna.topGenres.length > 0 && (
            <div className="taste-dna-genres-line tabular-nums">
              <span className="taste-dna-genres-caption">Baskın Türler:</span>
              <span className="taste-dna-genres-values">
                {statsData.tasteDna.topGenres
                  .map((g) => `${g.name} (%${g.sharePercent})`)
                  .join(' · ')}
              </span>
            </div>
          )}
        </div>
      )}

      <DuplicateMergePanel items={items} onMergePair={onMergeDuplicates} />

      <WrappedCard
        items={items}
        profileName={profileName}
        favoriteActors={favoriteActors}
        genresMap={genresMap}
        onSelectItem={onSelectItem}
      />
    </section>
  );
};


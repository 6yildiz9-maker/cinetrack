import React, { useState, useMemo } from 'react';
import {
  PersistentTasteMapData,
  TasteRing,
  TasteProfileSummary,
  getTasteRingLabel,
  inferLifecycleRing,
  normalizeTasteRing,
  makeMediaKey,
} from '../core/cinetrack-core';
import { MediaCard } from './MediaCard';

interface TasteMapViewProps {
  tasteMap: PersistentTasteMapData;
  summary: TasteProfileSummary | null;
  genresMap: Record<number, string>;
  onOpenDetails: (item: any) => void;
  onQuickSave: (item: any) => void;
  onSetStatus: (item: any, status: 'watching' | 'watchlist' | 'completed') => void;
  onToggleDislike: (key: string) => void;
  onRefreshTasteMap: () => void;
  isLoading?: boolean;
  isDemo?: boolean;
  tmdbSource?: string;
  tmdbStaleReason?: string;
}

export const TasteMapView: React.FC<TasteMapViewProps> = ({
  tasteMap,
  summary,
  genresMap,
  onOpenDetails,
  onQuickSave,
  onSetStatus,
  onToggleDislike,
  onRefreshTasteMap,
  isLoading = false,
  isDemo = false,
  tmdbSource = 'live',
  tmdbStaleReason,
}) => {
  const [activeViewTab, setActiveViewTab] = useState<'active' | 'archived'>('active');
  const [selectedRing, setSelectedRing] = useState<TasteRing>('ring0');
  const [mediaFilter, setMediaFilter] = useState<'all' | 'movie' | 'tv'>('all');
  const [sortOrder, setSortOrder] = useState<'score' | 'title' | 'recent'>('score');

  const entriesList = useMemo(() => {
    return Object.values(tasteMap?.entries || {});
  }, [tasteMap]);

  const archivedList = useMemo(() => {
    return Object.values(tasteMap?.archivedEntries || {});
  }, [tasteMap]);

  const lastKeys = useMemo(() => tasteMap?.lastRecommendedKeys || [], [tasteMap]);

  // Ring counts for active entries
  const ringCounts = useMemo(() => {
    const counts: Record<string, number> = { ring0: 0, ring1: 0, ring2: 0 };
    for (const e of entriesList) {
      const key = e.mediaKey || makeMediaKey(e);
      const norm = inferLifecycleRing(key, e, lastKeys);
      counts[norm] = (counts[norm] || 0) + 1;
    }
    return counts;
  }, [entriesList, lastKeys]);

  // Filtered & sorted entries
  const displayedEntries = useMemo(() => {
    const list = activeViewTab === 'active' ? entriesList : archivedList;
    const targetNorm = normalizeTasteRing(selectedRing);

    return list
      .filter((e) => {
        if (activeViewTab === 'active') {
          const key = e.mediaKey || makeMediaKey(e);
          const norm = inferLifecycleRing(key, e, lastKeys);
          if (norm !== targetNorm) return false;
        }
        if (mediaFilter === 'all') return true;
        return e.mediaType === mediaFilter;
      })
      .sort((a, b) => {
        if (sortOrder === 'score') {
          return (b.matchScore || 0) - (a.matchScore || 0);
        }
        if (sortOrder === 'title') {
          return (a.title || '').localeCompare(b.title || '', 'tr');
        }
        return (b.lastShownAt || '').localeCompare(a.lastShownAt || '');
      });
  }, [activeViewTab, entriesList, archivedList, selectedRing, mediaFilter, sortOrder, lastKeys]);

  const strongestGenre = useMemo(() => {
    if (summary?.topGenres && summary.topGenres.length > 0) {
      return summary.topGenres[0].name;
    }
    return 'Dram';
  }, [summary]);

  return (
    <div className="taste-map-container">
      {/* Sticky Özet Şerit (Section 6.3) */}
      <div className="taste-summary-strip" role="region" aria-label="Zevk Haritası Özeti">
        <div className="taste-summary-counts">
          <div className="taste-summary-pill ring-pill--0" title={getTasteRingLabel('ring0')}>
            <span className="ring-chip-dot" />
            <strong className="tabular-nums">{ringCounts.ring0 || 0}</strong>
            <span>yeni</span>
          </div>
          <div className="taste-summary-pill ring-pill--1" title={getTasteRingLabel('ring1')}>
            <span className="ring-chip-dot" />
            <strong className="tabular-nums">{ringCounts.ring1 || 0}</strong>
            <span>son öneri</span>
          </div>
          <div className="taste-summary-pill ring-pill--2" title={getTasteRingLabel('ring2')}>
            <span className="ring-chip-dot" />
            <strong className="tabular-nums">{ringCounts.ring2 || 0}</strong>
            <span>yedek</span>
          </div>
          <div className="taste-summary-pill taste-top-genre" title="En güçlü tür sinyali">
            <span>En güçlü tür:</span>
            <strong>{strongestGenre}</strong>
          </div>
          {isDemo && (
            <div className="taste-summary-pill" title="Demo Modu Aktif">
              <span className="ring-chip-dot" style={{ background: 'var(--accent)' }} />
              <span>Demo</span>
            </div>
          )}
        </div>

        <div className="taste-strip-actions">
          <button
            type="button"
            className="for-you-head-refresh-btn"
            onClick={onRefreshTasteMap}
            disabled={isLoading}
            title="Zevk haritasını taze verilerle yeniden hesapla"
            aria-label="Haritayı Yenile"
          >
            <span className={`refresh-icon ${isLoading ? 'spinning' : ''}`}>↻</span>
            <span>Yenile</span>
          </button>
        </div>
      </div>

      {/* TMDB Kaynak Durum Banner */}
      {tmdbSource === 'stale-cache' && (
        <div className="catalog-source-banner banner-stale" role="alert">
          <span className="catalog-source-banner-icon" aria-hidden="true">⚠️</span>
          <div>
            <strong>Çevrimdışı / Eski Önbellek Modu</strong>: Canlı TMDB yanıt vermediği için puanlar son kayıtlı önbellekten hesaplandı.
            {tmdbStaleReason ? ` (${tmdbStaleReason})` : ''}
          </div>
        </div>
      )}

      {tmdbSource === 'demo' && (
        <div className="catalog-source-banner banner-demo" role="alert">
          <span className="catalog-source-banner-icon" aria-hidden="true">🟡</span>
          <div>
            <strong>Örnek Katalog Modu</strong>: API anahtarı girilmediğinden dahili örnek katalog kullanılmaktadır.
          </div>
        </div>
      )}

      {/* Kontrol & Filtre Çubuğu */}
      <div className="taste-controls-row">
        {/* Halka Sekmeleri */}
        <div className="taste-ring-tabs" role="tablist" aria-label="Zevk halkaları">
          <button
            type="button"
            role="tab"
            aria-selected={activeViewTab === 'active' && selectedRing === 'ring0'}
            className={`taste-ring-tab ${activeViewTab === 'active' && selectedRing === 'ring0' ? 'active' : ''}`}
            onClick={() => {
              setActiveViewTab('active');
              setSelectedRing('ring0');
            }}
          >
            <span className="ring-tab-dot dot-ring0" />
            Yeni Eşleşme ({ringCounts.ring0 || 0})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeViewTab === 'active' && selectedRing === 'ring1'}
            className={`taste-ring-tab ${activeViewTab === 'active' && selectedRing === 'ring1' ? 'active' : ''}`}
            onClick={() => {
              setActiveViewTab('active');
              setSelectedRing('ring1');
            }}
          >
            <span className="ring-tab-dot dot-ring1" />
            Son Öneri ({ringCounts.ring1 || 0})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeViewTab === 'active' && selectedRing === 'ring2'}
            className={`taste-ring-tab ${activeViewTab === 'active' && selectedRing === 'ring2' ? 'active' : ''}`}
            onClick={() => {
              setActiveViewTab('active');
              setSelectedRing('ring2');
            }}
          >
            <span className="ring-tab-dot dot-ring2" />
            Yedek Halka ({ringCounts.ring2 || 0})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeViewTab === 'archived'}
            className={`taste-ring-tab ${activeViewTab === 'archived' ? 'active' : ''}`}
            onClick={() => setActiveViewTab('archived')}
          >
            Arşiv ({archivedList.length})
          </button>
        </div>

        {/* Tür ve Sıralama Seçicileri */}
        <div className="taste-filter-actions">
          <div className="segmented-control" role="group" aria-label="Medya türü filtresi">
            <button
              type="button"
              className={`segmented-btn ${mediaFilter === 'all' ? 'active' : ''}`}
              onClick={() => setMediaFilter('all')}
            >
              Tümü
            </button>
            <button
              type="button"
              className={`segmented-btn ${mediaFilter === 'movie' ? 'active' : ''}`}
              onClick={() => setMediaFilter('movie')}
            >
              Film
            </button>
            <button
              type="button"
              className={`segmented-btn ${mediaFilter === 'tv' ? 'active' : ''}`}
              onClick={() => setMediaFilter('tv')}
            >
              Dizi
            </button>
          </div>

          <select
            className="taste-sort-select"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as any)}
            aria-label="Sıralama ölçütü"
          >
            <option value="score">Uyum Puanı (Azalan)</option>
            <option value="title">Başlık (A-Z)</option>
            <option value="recent">Son Güncellenen</option>
          </select>
        </div>
      </div>

      {/* Akıcı Poster Duvarı: minmax(148px, 1fr) -> 8 kolon @ 1440px */}
      {displayedEntries.length === 0 ? (
        <div className="message" role="status">
          <strong>Bu halkada gösterilecek yapım bulunmuyor</strong>
          <p>
            {activeViewTab === 'active'
              ? 'Öneri listesini yeniledikçe veya yeni yapımlar izledikçe zevk haritası dinamik olarak dolacaktır.'
              : 'Henüz arşivlenmiş bir yapım bulunmuyor.'}
          </p>
        </div>
      ) : (
        <div className="taste-poster-wall" role="region" aria-label="Zevk Haritası Poster Duvarı">
          {displayedEntries.map((entry) => {
            const key = entry.mediaKey || makeMediaKey(entry);
            const rawItem = {
              id: entry.id,
              media_type: entry.mediaType,
              title: entry.title,
              name: entry.title,
              poster_path: entry.poster_path,
              genre_ids: entry.genre_ids || [],
              vote_average: entry.vote_average || 0,
              release_date: entry.release_date,
              first_air_date: entry.first_air_date,
              matchScore: entry.matchScore,
              ring: activeViewTab === 'active' ? inferLifecycleRing(key, entry, lastKeys) : undefined,
              status: entry.status,
            };

            return (
              <div key={key} className="taste-wall-card-wrap">
                <MediaCard
                  item={rawItem}
                  size="md"
                  context="taste"
                  showRing={true}
                  showMatch={true}
                  genres={genresMap}
                  onOpenDetails={onOpenDetails}
                  onQuickSave={onQuickSave}
                  onSetStatus={onSetStatus}
                  onToggleDislike={onToggleDislike}
                  matchScore={entry.matchScore}
                  selectionRing={activeViewTab === 'active' ? inferLifecycleRing(key, entry, lastKeys) : undefined}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default TasteMapView;

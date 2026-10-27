import React, { useState, useMemo } from 'react';
import {
  PersistentTasteMapData,
  TasteRing,
  TasteProfileSummary,
  SavedItem,
  getTasteRingLabel,
  inferLifecycleRing,
  normalizeTasteRing,
  makeMediaKey,
  matchesSelectedGenre,
} from '../core/cinetrack-core';
import { MediaCard } from './MediaCard';

interface TasteMapViewProps {
  tasteMap: PersistentTasteMapData;
  summary: TasteProfileSummary | null;
  genresMap: Record<number, string>;
  savedItems?: SavedItem[];
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
  savedItems = [],
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
  const [genreFilter, setGenreFilter] = useState<string>('');
  const [sortOrder, setSortOrder] = useState<'score' | 'title' | 'recent'>('score');

  const safeTasteMap = useMemo(() => tasteMap || { profileId: '', entries: {}, lastRecommendedKeys: [] }, [tasteMap]);

  const entriesList = useMemo(() => {
    return Object.values(safeTasteMap?.entries || {}).filter(Boolean);
  }, [safeTasteMap]);

  const archivedList = useMemo(() => {
    return Object.values(safeTasteMap?.archivedEntries || {}).filter(Boolean);
  }, [safeTasteMap]);

  const lastKeys = useMemo(() => safeTasteMap?.lastRecommendedKeys || [], [safeTasteMap]);

  // Ring counts for active entries
  const ringCounts = useMemo(() => {
    const counts: Record<string, number> = { ring0: 0, ring1: 0, ring2: 0 };
    for (const e of entriesList) {
      if (!e) continue;
      const key = e.mediaKey || makeMediaKey(e);
      const norm = inferLifecycleRing(key, e, lastKeys);
      const safeRing = norm === 'ring1' ? 'ring1' : norm === 'ring2' ? 'ring2' : 'ring0';
      counts[safeRing] = (counts[safeRing] || 0) + 1;
    }
    return counts;
  }, [entriesList, lastKeys]);

  // Fast map to match saved items for active status badges
  const savedItemMap = useMemo(() => {
    const map = new Map<string, SavedItem>();
    for (const item of (savedItems || [])) {
      if (!item) continue;
      const key = makeMediaKey(item);
      map.set(key, item);
      const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
      if (item.id != null) {
        map.set(`${mediaType}:${item.id}`, item);
        map.set(String(item.id), item);
      }
    }
    return map;
  }, [savedItems]);

  // Filtered & sorted entries
  const displayedEntries = useMemo(() => {
    const list = activeViewTab === 'active' ? entriesList : archivedList;
    const targetNorm = normalizeTasteRing(selectedRing);

    return list
      .filter((e) => {
        if (!e) return false;
        if (activeViewTab === 'active') {
          const key = e.mediaKey || makeMediaKey(e);
          const norm = inferLifecycleRing(key, e, lastKeys);
          if (norm !== targetNorm) return false;
        }
        if (mediaFilter !== 'all' && e.mediaType !== mediaFilter) return false;
        if (genreFilter && !matchesSelectedGenre(e, genreFilter)) return false;
        return true;
      })
      .sort((a, b) => {
        if (sortOrder === 'score') {
          return (Number(b.matchScore || b.tasteScore) || 0) - (Number(a.matchScore || a.tasteScore) || 0);
        }
        if (sortOrder === 'title') {
          return String(a.title || '').localeCompare(String(b.title || ''), 'tr');
        }
        return String(b.lastShownAt || '').localeCompare(String(a.lastShownAt || ''));
      });
  }, [activeViewTab, entriesList, archivedList, selectedRing, mediaFilter, genreFilter, sortOrder, lastKeys]);

  const strongestGenre = useMemo(() => {
    if (summary?.topGenres && summary.topGenres.length > 0 && summary.topGenres[0]?.name) {
      return summary.topGenres[0].name;
    }
    return '—';
  }, [summary]);

  return (
    <div className="taste-map-container">
      {/* Sayfa Başlığı ve Kısa Açıklama (Section 3.A) */}
      <div className="section-head taste-page-head">
        <div>
          <h2 id="tasteMapTitle" className="section-title">Zevk Haritası</h2>
          <p className="section-desc">Kişisel zevk halkalarına (Yeni Eşleşme, Son Öneri, Yedek) göre ayrıştırılmış film ve dizi arşivi</p>
        </div>
      </div>

      {/* Sticky Özet Şerit (Section 6.3) */}
      <div className="taste-summary-strip" role="region" aria-label="Zevk Haritası Özeti">
        <div className="taste-summary-counts">
          <div className="taste-summary-pill ring-pill--0" title={getTasteRingLabel('ring0')}>
            <span className="ring-chip-dot" aria-hidden="true" />
            <strong className="tabular-nums">{ringCounts.ring0 || 0}</strong>{' '}
            <span>yeni</span>
          </div>
          <div className="taste-summary-pill ring-pill--1" title={getTasteRingLabel('ring1')}>
            <span className="ring-chip-dot" aria-hidden="true" />
            <strong className="tabular-nums">{ringCounts.ring1 || 0}</strong>{' '}
            <span>son öneri</span>
          </div>
          <div className="taste-summary-pill ring-pill--2" title={getTasteRingLabel('ring2')}>
            <span className="ring-chip-dot" aria-hidden="true" />
            <strong className="tabular-nums">{ringCounts.ring2 || 0}</strong>{' '}
            <span>yedek</span>
          </div>
          <div className="taste-summary-pill taste-top-genre" title={strongestGenre === '—' ? 'Henüz yeterli izleme verisi toplanmadı' : 'En güçlü tür sinyali'}>
            <span>En güçlü tür:</span>{' '}
            <strong>{strongestGenre}</strong>
          </div>
          {isDemo && (
            <div className="taste-summary-pill" title="Demo Modu Aktif">
              <span className="ring-chip-dot dot-demo" aria-hidden="true" />
              <span>Demo</span>
            </div>
          )}
          <div className="taste-summary-pill taste-sync-pill" title="Kalıcı veri deposu ve profiller her 5 dakikada bir arka planda otomatik senkronize edilir">
            <span className="ring-chip-dot dot-sync" aria-hidden="true" />
            <span>Oto-Sync (5 dk)</span>
          </div>
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
            <span className={`refresh-icon ${isLoading ? 'spinning' : ''}`} aria-hidden="true">↻</span>{' '}
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
            <span className="ring-tab-dot dot-ring0" aria-hidden="true" />
            <span>Yeni Eşleşme</span>{' '}
            <span className="ring-tab-count tabular-nums">{ringCounts.ring0 || 0}</span>
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
            <span className="ring-tab-dot dot-ring1" aria-hidden="true" />
            <span>Son Öneri</span>{' '}
            <span className="ring-tab-count tabular-nums">{ringCounts.ring1 || 0}</span>
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
            <span className="ring-tab-dot dot-ring2" aria-hidden="true" />
            <span>Yedek Halka</span>{' '}
            <span className="ring-tab-count tabular-nums">{ringCounts.ring2 || 0}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeViewTab === 'archived'}
            className={`taste-ring-tab ${activeViewTab === 'archived' ? 'active' : ''}`}
            onClick={() => setActiveViewTab('archived')}
          >
            <span>Arşiv</span>{' '}
            <span className="ring-tab-count tabular-nums">{archivedList.length}</span>
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
            value={genreFilter}
            onChange={(e) => setGenreFilter(e.target.value)}
            aria-label="Zevk haritası tür filtresi"
          >
            <option value="">Tüm Türler</option>
            {Object.entries(genresMap || {}).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>

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

      {/* Halka Açıklama ve Bilgilendirme Kutusu */}
      <div className="taste-filter-hint-box" role="status">
        <span className="hint-icon" aria-hidden="true">💡</span>
        <div className="hint-text">
          <strong>
            {activeViewTab === 'archived'
              ? 'Arşiv Havuzu'
              : selectedRing === 'ring0'
              ? 'Yeni Eşleşme (Ring 0)'
              : selectedRing === 'ring1'
              ? 'Son Öneri (Ring 1 - Gösterim Hafızası)'
              : 'Yedek Halka (Ring 2)'}
            :
          </strong>{' '}
          {activeViewTab === 'archived'
            ? 'Daha önceki zevk haritası turlarında önerilen ancak yeni turlarla güncel halkalardan rotasyona uğrayarak arşive kaldırılmış geçmiş öneriler.'
            : selectedRing === 'ring0'
            ? 'Zevk profiline en yüksek uyum sağlayan ve henüz ana ekranda sana önerilmemiş taze keşifler.'
            : selectedRing === 'ring1'
            ? 'Bir önceki keşif turunda veya Sana Özel listesinde önerilmiş, gösterim hafızasında tutulan yapımlar.'
            : 'Yüksek uyumlu fakat öncelikli halkalarda yer kalmadığında devreye giren zengin alternatifler.'}
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
            if (!entry) return null;
            const key = entry.mediaKey || makeMediaKey(entry);
            const matchedSaved =
              savedItemMap.get(key) ||
              savedItemMap.get(`${entry.mediaType}:${entry.id}`) ||
              savedItemMap.get(String(entry.id));

            const matchScore = Number(entry.matchScore || entry.tasteScore) || 75;
            const rawItem = {
              id: entry.id,
              media_type: entry.mediaType || 'movie',
              title: entry.title || 'Başlıksız',
              name: entry.title || 'Başlıksız',
              poster_path: entry.poster_path,
              genre_ids: Array.isArray(entry.genre_ids) ? entry.genre_ids : [],
              vote_average: Number(entry.vote_average) || 0,
              release_date: entry.release_date,
              first_air_date: entry.first_air_date,
              matchScore,
              ring: activeViewTab === 'active' ? inferLifecycleRing(key, entry, lastKeys) : undefined,
              status: matchedSaved?.status || entry.status,
            };

            return (
              <div key={key} className="taste-wall-card-wrap">
                <MediaCard
                  item={rawItem}
                  savedItem={matchedSaved}
                  size="md"
                  context="taste"
                  showRing={true}
                  showMatch={true}
                  genres={genresMap || {}}
                  onOpenDetails={onOpenDetails}
                  onQuickSave={onQuickSave}
                  onQuickAdd={(item) => onSetStatus(item, 'watchlist')}
                  onSetStatus={onSetStatus}
                  onToggleDislike={onToggleDislike}
                  matchScore={matchScore}
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

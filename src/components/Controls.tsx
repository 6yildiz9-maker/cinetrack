import React from 'react';
import { DISCOVER_PROVIDER_CHIPS } from '../utils/helpers';

interface ControlsProps {
  tab: 'discover' | 'list' | 'taste-map' | 'relationships';
  onTabChange: (tab: 'discover' | 'list' | 'taste-map' | 'relationships') => void;
  myListCount: number;
  upcomingCount: number;
  dislikedCount?: number;
  favoriteActorsCount?: number;
  watchingCount?: number;
  watchlistCount?: number;
  completedCount?: number;
  // Filters
  genres: Record<number, string>;
  selectedGenre: string;
  onGenreChange: (g: string) => void;
  selectedType: string;
  onTypeChange: (t: string) => void;
  selectedCategory: string;
  onCategoryChange: (c: string) => void;
  isSearchActive: boolean;
  selectedSort: string;
  onSortChange: (s: string) => void;
  selectedProvider: string;
  onProviderChange: (p: string) => void;
  listStatus: string;
  onListStatusChange: (status: string) => void;
}

export const Controls: React.FC<ControlsProps> = ({
  tab,
  myListCount,
  upcomingCount = 0,
  dislikedCount = 0,
  favoriteActorsCount = 0,
  watchingCount = 0,
  watchlistCount = 0,
  completedCount = 0,
  genres,
  selectedGenre,
  onGenreChange,
  selectedType,
  onTypeChange,
  selectedCategory,
  onCategoryChange,
  isSearchActive,
  selectedSort,
  onSortChange,
  selectedProvider,
  onProviderChange,
  listStatus,
  onListStatusChange,
}) => {
  // If in taste-map or relationships tab, those views provide their own dedicated toolbars
  if (tab === 'taste-map' || tab === 'relationships') {
    return null;
  }

  const disableProviderFilters = isSearchActive || selectedCategory === 'for-you';
  const totalListCount = myListCount || watchingCount + watchlistCount + completedCount;

  return (
    <div className="section-controls-wrap">
      {/* 6.2 LISTEM — Üstte durum çipleri = hem istatistik hem filtre: dokun = süz */}
      {tab === 'list' && (
        <div className="list-status-chips-bar" role="group" aria-label="Liste durumu filtreleri">
          <button
            type="button"
            className={`list-status-chip ${listStatus === 'all' ? 'is-active' : ''}`}
            onClick={() => onListStatusChange('all')}
            aria-pressed={listStatus === 'all'}
          >
            <span className="chip-label">Tümü</span>{' '}
            <strong className="chip-count tabular-nums">{totalListCount}</strong>
          </button>

          <button
            type="button"
            className={`list-status-chip chip--completed ${listStatus === 'completed' ? 'is-active' : ''}`}
            onClick={() => onListStatusChange('completed')}
            aria-pressed={listStatus === 'completed'}
          >
            <span className="status-dot dot-completed" aria-hidden="true" />
            <span className="chip-label">İzlendi</span>{' '}
            <strong className="chip-count tabular-nums">{completedCount}</strong>
          </button>

          <button
            type="button"
            className={`list-status-chip chip--watching ${listStatus === 'watching' ? 'is-active' : ''}`}
            onClick={() => onListStatusChange('watching')}
            aria-pressed={listStatus === 'watching'}
          >
            <span className="status-dot dot-watching" aria-hidden="true" />
            <span className="chip-label">İzliyorum</span>{' '}
            <strong className="chip-count tabular-nums">{watchingCount}</strong>
          </button>

          <button
            type="button"
            className={`list-status-chip chip--watchlist ${listStatus === 'watchlist' ? 'is-active' : ''}`}
            onClick={() => onListStatusChange('watchlist')}
            aria-pressed={listStatus === 'watchlist'}
          >
            <span className="status-dot dot-watchlist" aria-hidden="true" />
            <span className="chip-label">İzlenecek</span>{' '}
            <strong className="chip-count tabular-nums">{watchlistCount}</strong>
          </button>

          {(favoriteActorsCount > 0 || listStatus === 'actors') && (
            <button
              type="button"
              className={`list-status-chip chip--actors ${listStatus === 'actors' ? 'is-active' : ''}`}
              onClick={() => onListStatusChange('actors')}
              aria-pressed={listStatus === 'actors'}
            >
              <span className="chip-label">Favori Oyuncular</span>{' '}
              <strong className="chip-count tabular-nums">{favoriteActorsCount}</strong>
            </button>
          )}

          {upcomingCount > 0 && (
            <button
              type="button"
              className={`list-status-chip chip--upcoming ${listStatus === 'upcoming' ? 'is-active' : ''}`}
              onClick={() => onListStatusChange('upcoming')}
              aria-pressed={listStatus === 'upcoming'}
            >
              <span className="chip-label">Yaklaşan</span>{' '}
              <strong className="chip-count tabular-nums">{upcomingCount}</strong>
            </button>
          )}

          {dislikedCount > 0 && (
            <button
              type="button"
              className={`list-status-chip chip--disliked ${listStatus === 'disliked' ? 'is-active' : ''}`}
              onClick={() => onListStatusChange('disliked')}
              aria-pressed={listStatus === 'disliked'}
            >
              <span className="chip-label">İlgilenmiyorum</span>{' '}
              <strong className="chip-count tabular-nums">{dislikedCount}</strong>
            </button>
          )}
        </div>
      )}

      {/* 6.1 KEŞFET — Platform çipleri (Tümü, Netflix, Prime, Disney+, BluTV) */}
      {tab === 'discover' && !disableProviderFilters && (
        <div className="provider-chips" role="group" aria-label="Platform filtresi">
          <span className="provider-chips-label">Platform:</span>
          {DISCOVER_PROVIDER_CHIPS.map((chip) => {
            const isSelected = selectedProvider === chip.id;
            return (
              <button
                key={chip.id}
                className={`provider-chip ${isSelected ? 'active' : ''}`}
                type="button"
                onClick={() => onProviderChange(isSelected ? '' : chip.id)}
                aria-pressed={isSelected}
              >
                <span>{chip.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* İkincil Araç Çubuğu: Kategori, Tür, Sıralama */}
      <div className="secondary-toolbar">
        {/* Keşfet Kategorileri */}
        {tab === 'discover' && !isSearchActive && (
          <div className="category-scroll-strip" role="group" aria-label="Keşfet kategorileri">
            <button
              type="button"
              className={`category-pill ${selectedCategory === 'trending' ? 'active' : ''}`}
              onClick={() => onCategoryChange('trending')}
            >
              Gündemdekiler
            </button>
            <button
              type="button"
              className={`category-pill ${selectedCategory === 'for-you' ? 'active' : ''}`}
              onClick={() => onCategoryChange('for-you')}
            >
              Sana Özel (Zevk Haritası)
            </button>
            <button
              type="button"
              className={`category-pill ${selectedCategory === 'top-rated' ? 'active' : ''}`}
              onClick={() => onCategoryChange('top-rated')}
            >
              Yüksek Puanlılar
            </button>
            <button
              type="button"
              className={`category-pill ${selectedCategory === 'upcoming' ? 'active' : ''}`}
              onClick={() => onCategoryChange('upcoming')}
            >
              Yakında Vizyonda
            </button>
            <button
              type="button"
              className={`category-pill ${selectedCategory === 'gems' ? 'active' : ''}`}
              onClick={() => onCategoryChange('gems')}
            >
              Gizli Cevherler
            </button>
          </div>
        )}

        {/* Medya Türü (Film / Dizi) */}
        <div className="segmented-control" role="group" aria-label="İçerik türü filtresi">
          <button
            type="button"
            className={`segmented-btn ${selectedType === 'all' ? 'active' : ''}`}
            onClick={() => onTypeChange('all')}
          >
            Tümü
          </button>
          <button
            type="button"
            className={`segmented-btn ${selectedType === 'movie' ? 'active' : ''}`}
            onClick={() => onTypeChange('movie')}
          >
            Film
          </button>
          <button
            type="button"
            className={`segmented-btn ${selectedType === 'tv' ? 'active' : ''}`}
            onClick={() => onTypeChange('tv')}
          >
            Dizi
          </button>
        </div>

        {/* Tür Seçici Dropdown */}
        <div className="filter-select-wrap">
          <select
            className="filter-select"
            value={selectedGenre}
            onChange={(e) => onGenreChange(e.target.value)}
            aria-label="Tür filtresi"
          >
            <option value="">Tüm Türler</option>
            {Object.entries(genres).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>

        {/* Sıralama Seçici */}
        <div className="filter-select-wrap">
          <select
            className="filter-select"
            value={selectedSort}
            onChange={(e) => onSortChange(e.target.value)}
            aria-label="Sıralama ölçütü"
          >
            <option value="popular">Popülerlik (Varsayılan)</option>
            <option value="rating">Puan (Yüksekten Düşüğe)</option>
            <option value="recent">
              {tab === 'list' ? 'Eklenme Tarihi (Yeni)' : 'Yayın Tarihi (Yeni)'}
            </option>
            <option value="title">Başlık (A-Z)</option>
          </select>
        </div>
      </div>
    </div>
  );
};

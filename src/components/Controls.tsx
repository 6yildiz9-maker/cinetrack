import React from 'react';

interface ControlsProps {
  tab: 'discover' | 'list';
  onTabChange: (tab: 'discover' | 'list') => void;
  myListCount: number;
  upcomingCount: number;
  dislikedCount?: number;
  favoriteActorsCount?: number;
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
  onTabChange,
  myListCount,
  upcomingCount,
  dislikedCount = 0,
  favoriteActorsCount = 0,
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
  return (
    <>
      <div className="controls">
        <div className="tabs" role="group" aria-label="Liste görünümü">
          <button
            className={`tab ${tab === 'discover' ? 'active' : ''}`}
            type="button"
            aria-pressed={tab === 'discover'}
            onClick={() => onTabChange('discover')}
          >
            Keşfet
          </button>
          <button
            className={`tab ${tab === 'list' ? 'active' : ''}`}
            type="button"
            aria-pressed={tab === 'list'}
            onClick={() => onTabChange('list')}
          >
            Listem <span id="myListBadge">{myListCount}</span>
          </button>
        </div>

        <div className="filters">
          {tab === 'discover' && (
            <select
              id="genreFilter"
              aria-label="Tür filtresi"
              value={selectedGenre}
              onChange={(e) => onGenreChange(e.target.value)}
            >
              <option value="">Tüm türler</option>
              {Object.entries(genres).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          )}

          <select
            id="typeFilter"
            aria-label="İçerik türü"
            value={selectedType}
            onChange={(e) => onTypeChange(e.target.value)}
          >
            <option value="all">Film + dizi</option>
            <option value="movie">Filmler</option>
            <option value="tv">Diziler</option>
          </select>

          {tab === 'discover' && (
            <>
              <select
                id="catalogFilter"
                aria-label={
                  isSearchActive
                    ? 'Keşfet kategorisi (arama sırasında devre dışı)'
                    : 'Keşfet kategorisi'
                }
                disabled={isSearchActive}
                value={isSearchActive ? 'search' : selectedCategory}
                onChange={(e) => onCategoryChange(e.target.value)}
              >
                <option value="trending">Gündemde</option>
                <option value="for-you">Sana özel</option>
                <option value="gems">Keşfedilmemiş mücevherler</option>
                <option value="popular-movies">Popüler filmler</option>
                <option value="popular-tv">Popüler diziler</option>
                <option value="top-rated">Yüksek puanlı filmler</option>
                <option value="upcoming">Yakında ve yayında</option>
                {isSearchActive && (
                  <option value="search" disabled>
                    Arama sonuçları
                  </option>
                )}
              </select>

              <button
                id="upcomingChip"
                className={`chip upcoming-chip ${selectedCategory === 'upcoming' ? 'active' : ''}`}
                type="button"
                aria-pressed={selectedCategory === 'upcoming'}
                onClick={() =>
                  onCategoryChange(selectedCategory === 'upcoming' ? 'trending' : 'upcoming')
                }
              >
                Yakında
              </button>
            </>
          )}

          <select
            id="sortFilter"
            aria-label="Sıralama"
            value={selectedSort}
            onChange={(e) => onSortChange(e.target.value)}
          >
            <option value="popular">Popülerlik</option>
            <option value="rating">TMDB puanı</option>
            <option value="title">İsim (A-Z)</option>
            <option value="recent">Son eklenen / çıkan</option>
          </select>
        </div>
      </div>

      {tab === 'discover' && (
        <div id="providerChips" className="provider-chips" role="group" aria-label="Yayın platformu filtresi">
          <span className="provider-chips-label">Platform:</span>
          <button
            className={`provider-chip ${selectedProvider === '' ? 'active' : ''}`}
            type="button"
            aria-pressed={selectedProvider === ''}
            onClick={() => onProviderChange('')}
          >
            Tümü
          </button>
          <button
            className={`provider-chip provider-netflix ${selectedProvider === '8' ? 'active' : ''}`}
            type="button"
            aria-pressed={selectedProvider === '8'}
            onClick={() => onProviderChange(selectedProvider === '8' ? '' : '8')}
          >
            Netflix
          </button>
          <button
            className={`provider-chip provider-prime ${selectedProvider === '119' ? 'active' : ''}`}
            type="button"
            aria-pressed={selectedProvider === '119'}
            onClick={() => onProviderChange(selectedProvider === '119' ? '' : '119')}
          >
            Prime Video
          </button>
          <button
            className={`provider-chip provider-disney ${selectedProvider === '337' ? 'active' : ''}`}
            type="button"
            aria-pressed={selectedProvider === '337'}
            onClick={() => onProviderChange(selectedProvider === '337' ? '' : '337')}
          >
            Disney+
          </button>
          <button
            className={`provider-chip provider-blutv ${selectedProvider === '410' ? 'active' : ''}`}
            type="button"
            aria-pressed={selectedProvider === '410'}
            onClick={() => onProviderChange(selectedProvider === '410' ? '' : '410')}
          >
            BluTV
          </button>
        </div>
      )}

      {tab === 'list' && (
        <div id="listChips" className="list-chips visible" role="group" aria-label="İzleme durumu filtresi">
          <button
            className={`chip ${listStatus === 'all' ? 'active' : ''}`}
            type="button"
            aria-pressed={listStatus === 'all'}
            onClick={() => onListStatusChange('all')}
          >
            Tümü
          </button>
          <button
            className={`chip ${listStatus === 'watching' ? 'active' : ''}`}
            type="button"
            aria-pressed={listStatus === 'watching'}
            onClick={() => onListStatusChange('watching')}
          >
            İzliyorum
          </button>
          <button
            className={`chip ${listStatus === 'watchlist' ? 'active' : ''}`}
            type="button"
            aria-pressed={listStatus === 'watchlist'}
            onClick={() => onListStatusChange('watchlist')}
          >
            İzlenecek
          </button>
          <button
            className={`chip ${listStatus === 'completed' ? 'active' : ''}`}
            type="button"
            aria-pressed={listStatus === 'completed'}
            onClick={() => onListStatusChange('completed')}
          >
            Tamamlandı
          </button>
          <button
            className={`chip ${listStatus === 'upcoming' ? 'active' : ''}`}
            type="button"
            aria-pressed={listStatus === 'upcoming'}
            onClick={() => onListStatusChange('upcoming')}
          >
            📅 Yaklaşanlar{' '}
            {upcomingCount > 0 && <span className="upcoming-badge">{upcomingCount}</span>}
          </button>
          <button
            className={`chip ${listStatus === 'actors' ? 'active' : ''}`}
            type="button"
            aria-pressed={listStatus === 'actors'}
            onClick={() => onListStatusChange('actors')}
          >
            ⭐ Favori Oyuncular{' '}
            {favoriteActorsCount > 0 && <span className="upcoming-badge">{favoriteActorsCount}</span>}
          </button>
          <button
            className={`chip ${listStatus === 'disliked' ? 'active' : ''}`}
            type="button"
            aria-pressed={listStatus === 'disliked'}
            onClick={() => onListStatusChange('disliked')}
          >
            🚫 İlgilenmediklerim{' '}
            {dislikedCount > 0 && <span className="upcoming-badge">{dislikedCount}</span>}
          </button>
        </div>
      )}
    </>
  );
};

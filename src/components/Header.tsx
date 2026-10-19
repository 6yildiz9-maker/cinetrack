import React, { useState, useEffect, useRef } from 'react';
import { displayTitle, getPoster, releaseYear } from '../utils/helpers';
import { SavedItem } from '../core/cinetrack-core';

interface HeaderProps {
  profileName: string;
  query: string;
  onSearchChange: (q: string) => void;
  onSearchSubmit: (q: string) => void;
  onSearchClear: () => void;
  onOpenProfile: () => void;
  onOpenAdd: () => void;
  onSelectItem: (item: any) => void;
  getSaved: (item: any) => SavedItem | undefined;
}

export const Header: React.FC<HeaderProps> = ({
  profileName,
  query,
  onSearchChange,
  onSearchSubmit,
  onSearchClear,
  onOpenProfile,
  onOpenAdd,
  onSelectItem,
  getSaved,
}) => {
  const [dropdownItems, setDropdownItems] = useState<any[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownLoading, setDropdownLoading] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<any>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    onSearchChange(val);

    clearTimeout(debounceRef.current);
    if (!val.trim() || val.trim().length < 2) {
      setDropdownOpen(false);
      setDropdownItems([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setDropdownLoading(true);
      try {
        const queryParams = new URLSearchParams({
          path: '/search/multi',
          language: 'tr-TR',
          query: val.trim(),
          page: '1',
        });
        const res = await fetch(`/api/tmdb?${queryParams.toString()}`);
        if (res.ok) {
          const data = await res.json();
          const items = (data.results || [])
            .filter((item: any) => item.media_type === 'movie' || item.media_type === 'tv')
            .slice(0, 6);
          setDropdownItems(items);
          setDropdownOpen(true);
        }
      } catch (err) {
        console.warn('Typeahead error:', err);
      } finally {
        setDropdownLoading(false);
      }
    }, 200);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setDropdownOpen(false);
      onSearchSubmit(query);
    } else if (e.key === 'Escape') {
      setDropdownOpen(false);
    }
  };

  return (
    <header>
      <div className="shell topbar">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">
            <svg className="icon">
              <use href="#icon-film"></use>
            </svg>
          </span>
          <span>CineTrack</span>
        </div>

        <div className="search" ref={searchRef}>
          <svg className="icon search-icon" aria-hidden="true">
            <use href="#icon-search"></use>
          </svg>
          <input
            id="searchInput"
            type="search"
            value={query}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="TMDB'de film veya dizi ara..."
            autoComplete="off"
            aria-label="Film veya dizi ara"
          />
          {query && (
            <button
              id="searchClear"
              className="search-clear"
              type="button"
              onClick={onSearchClear}
              aria-label="Aramayı temizle ve trendlere dön"
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-close"></use>
              </svg>
            </button>
          )}

          {dropdownOpen && (
            <div id="searchDropdown" className="search-dropdown">
              {dropdownItems.length === 0 ? (
                <div className="search-dropdown-footer">
                  "{query}" için anlık eşleşme bulunamadı
                </div>
              ) : (
                <>
                  {dropdownItems.map((item) => {
                    const title = displayTitle(item);
                    const saved = getSaved(item);
                    const kind = item.media_type === 'tv' ? 'Dizi' : 'Film';
                    const poster = getPoster(item);
                    const year = releaseYear(item);
                    const rating = Number(item.vote_average || 0);
                    const statusText =
                      saved?.status === 'watching'
                        ? 'İzliyorum'
                        : saved?.status === 'completed'
                        ? 'Tamamlandı'
                        : saved?.status === 'watchlist'
                        ? 'Listemde'
                        : '';

                    return (
                      <button
                        key={`${item.media_type}:${item.id}`}
                        className="search-dropdown-item"
                        type="button"
                        onClick={() => {
                          setDropdownOpen(false);
                          onSelectItem(item);
                        }}
                      >
                        {poster ? (
                          <img
                            className="search-dropdown-thumb"
                            src={poster}
                            alt=""
                            onError={(e) => ((e.target as HTMLElement).style.display = 'none')}
                          />
                        ) : (
                          <div
                            className="search-dropdown-thumb"
                            style={{ display: 'grid', placeItems: 'center', color: '#64748b' }}
                          >
                            <svg className="icon">
                              <use href="#icon-film"></use>
                            </svg>
                          </div>
                        )}
                        <div className="search-dropdown-info">
                          <span className="search-dropdown-title">{title}</span>
                          <div className="search-dropdown-meta">
                            <span className="search-dropdown-badge">{kind}</span>
                            <span>{year || ''}</span>
                            {rating > 0 && <span>⭐ {rating.toFixed(1)}</span>}
                            {saved && (
                              <span
                                className="search-dropdown-badge"
                                style={{ background: '#0284c7', color: '#fff' }}
                              >
                                {statusText}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                  <button
                    className="search-dropdown-footer"
                    type="button"
                    onClick={() => {
                      setDropdownOpen(false);
                      onSearchSubmit(query);
                    }}
                  >
                    "{query}" için tüm sonuçları gridde gör (Enter)
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="actions">
          <button
            id="profileButton"
            className="btn profile-btn"
            type="button"
            onClick={onOpenProfile}
            aria-haspopup="dialog"
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-user"></use>
            </svg>
            <span id="profileButtonLabel">{profileName || 'Profil'}</span>
          </button>
          <button id="addButton" className="btn btn-primary" type="button" onClick={onOpenAdd}>
            <svg className="icon" aria-hidden="true">
              <use href="#icon-plus"></use>
            </svg>{' '}
            Ekle
          </button>
        </div>
      </div>
    </header>
  );
};

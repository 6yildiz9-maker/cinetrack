import React, { useState, useEffect, useRef } from 'react';
import { displayTitle, getPoster, releaseYear } from '../utils/helpers';
import { SavedItem, makeMediaKey } from '../core/cinetrack-core';
import { fetchTmdb } from '../services/api';

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
  tmdbSource?: string;
  tmdbStaleReason?: string;
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
  tmdbSource = 'live',
  tmdbStaleReason,
}) => {
  const [dropdownItems, setDropdownItems] = useState<any[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownLoading, setDropdownLoading] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);

  const cancelTypeahead = () => {
    requestIdRef.current += 1;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    setDropdownLoading(false);
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      requestControllerRef.current?.abort();
    },
    []
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    onSearchChange(val);

    const requestId = ++requestIdRef.current;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    setDropdownItems([]);
    if (!val.trim() || val.trim().length < 2) {
      setDropdownOpen(false);
      setDropdownLoading(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      requestControllerRef.current = controller;
      setDropdownLoading(true);
      try {
        const data = await fetchTmdb(
          '/search/multi',
          { query: val.trim(), page: '1' },
          controller.signal
        );
        if (requestId !== requestIdRef.current) return;
        const items = (data.results || [])
          .filter((item: any) => item.media_type === 'movie' || item.media_type === 'tv')
          .slice(0, 6);
        setDropdownItems(items);
        setDropdownOpen(true);
      } catch (err) {
        if (!controller.signal.aborted) console.warn('Typeahead error:', err);
      } finally {
        if (requestId === requestIdRef.current) {
          setDropdownLoading(false);
          requestControllerRef.current = null;
        }
      }
    }, 200);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      cancelTypeahead();
      setDropdownOpen(false);
      onSearchSubmit(query);
    } else if (e.key === 'Escape') {
      cancelTypeahead();
      setDropdownOpen(false);
    }
  };

  const handleSearchClear = () => {
    cancelTypeahead();
    setDropdownOpen(false);
    setDropdownItems([]);
    onSearchClear();
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
              onClick={handleSearchClear}
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
                        key={makeMediaKey(item)}
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
          {tmdbSource && (
            <span
              className={`topbar-source-badge ${
                tmdbSource === 'live'
                  ? 'source-live'
                  : tmdbSource === 'stale-cache'
                  ? 'source-stale'
                  : tmdbSource === 'demo'
                  ? 'source-demo'
                  : 'source-error'
              }`}
              title={
                tmdbSource === 'live'
                  ? 'TMDB Canlı API servisine doğrudan ve güncel bağlanılıyor.'
                  : tmdbSource === 'stale-cache'
                  ? `TMDB canlı servisi anlık yanıt vermedi${
                      tmdbStaleReason ? ` (${tmdbStaleReason})` : ''
                    }; son kaydedilen önbellek verisi sunuluyor.`
                  : tmdbSource === 'demo'
                  ? 'TMDB_API_KEY tanımlanmadığından örnek çevrimdışı katalog kullanılıyor.'
                  : 'TMDB servisine bağlanılamadı.'
              }
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  display: 'inline-block',
                  background:
                    tmdbSource === 'live'
                      ? '#10b981'
                      : tmdbSource === 'stale-cache'
                      ? '#ef4444'
                      : tmdbSource === 'demo'
                      ? '#f59e0b'
                      : '#ef4444',
                }}
              ></span>
              <span>
                {tmdbSource === 'live'
                  ? 'Canlı TMDB'
                  : tmdbSource === 'stale-cache'
                  ? 'Eski Önbellek'
                  : tmdbSource === 'demo'
                  ? 'Demo Katalog'
                  : 'Bağlantı Yok'}
              </span>
            </span>
          )}

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

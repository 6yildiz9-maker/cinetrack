import React, { useState, useEffect, useRef } from 'react';
import { displayTitle, getPoster, releaseYear } from '../utils/helpers';
import { SavedItem, makeMediaKey } from '../core/cinetrack-core';
import { fetchTmdb } from '../services/api';
import { TmdbItem } from '../types/tmdb';

interface HeaderProps {
  profileName: string;
  query: string;
  onSearchChange: (q: string) => void;
  onSearchSubmit: (q: string) => void;
  onSearchClear: () => void;
  onOpenProfile: () => void;
  onOpenAdd: () => void;
  onSelectItem: (item: TmdbItem) => void;
  getSaved: (item: TmdbItem) => SavedItem | undefined;
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
  const [dropdownItems, setDropdownItems] = useState<TmdbItem[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);

  const cancelTypeahead = () => {
    requestIdRef.current += 1;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
        setActiveIndex(-1);
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

  useEffect(() => {
    if (activeIndex >= 0 && optionRefs.current[activeIndex]) {
      optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    onSearchChange(val);

    const requestId = ++requestIdRef.current;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    setDropdownItems([]);
    setActiveIndex(-1);
    if (!val.trim() || val.trim().length < 2) {
      setDropdownOpen(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      requestControllerRef.current = controller;
      try {
        const data = await fetchTmdb(
          '/search/multi',
          { query: val.trim(), page: '1' },
          controller.signal
        );
        if (requestId !== requestIdRef.current) return;
        const items: TmdbItem[] = (data.results || [])
          .filter((item: TmdbItem) => item.media_type === 'movie' || item.media_type === 'tv')
          .slice(0, 6);
        setDropdownItems(items);
        setActiveIndex(-1);
        setDropdownOpen(true);
      } catch (err) {
        if (!controller.signal.aborted) console.warn('Typeahead error:', err);
      } finally {
        if (requestId === requestIdRef.current) {
          requestControllerRef.current = null;
        }
      }
    }, 200);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      if (dropdownOpen && dropdownItems.length > 0) {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % dropdownItems.length);
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      if (dropdownOpen && dropdownItems.length > 0) {
        e.preventDefault();
        setActiveIndex((prev) => (prev <= 0 ? dropdownItems.length - 1 : prev - 1));
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (dropdownOpen && activeIndex >= 0 && dropdownItems[activeIndex]) {
        const chosen = dropdownItems[activeIndex];
        cancelTypeahead();
        setDropdownOpen(false);
        setActiveIndex(-1);
        onSelectItem(chosen);
        return;
      }
      cancelTypeahead();
      setDropdownOpen(false);
      setActiveIndex(-1);
      onSearchSubmit(query);
    } else if (e.key === 'Escape') {
      cancelTypeahead();
      setDropdownOpen(false);
      setActiveIndex(-1);
    }
  };

  const handleSearchClear = () => {
    cancelTypeahead();
    setDropdownOpen(false);
    setDropdownItems([]);
    setActiveIndex(-1);
    onSearchClear();
  };

  const activeOptionId =
    dropdownOpen && activeIndex >= 0 && dropdownItems[activeIndex]
      ? `search-opt-${activeIndex}`
      : undefined;

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
            role="combobox"
            aria-expanded={dropdownOpen}
            aria-controls="searchDropdown"
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
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
            <div
              id="searchDropdown"
              className="search-dropdown"
              role="listbox"
              aria-label="Anlık arama önerileri"
            >
              {dropdownItems.length === 0 ? (
                <div className="search-dropdown-footer" role="status">
                  &ldquo;{query}&rdquo; için anlık eşleşme bulunamadı
                </div>
              ) : (
                <>
                  {dropdownItems.map((item, idx) => {
                    const title = displayTitle(item);
                    const saved = getSaved(item);
                    const kind = item.media_type === 'tv' ? 'Dizi' : 'Film';
                    const poster = getPoster(item);
                    const year = releaseYear(item);
                    const rating = Number(item.vote_average || 0);
                    const isActive = idx === activeIndex;
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
                        id={`search-opt-${idx}`}
                        ref={(el) => {
                          optionRefs.current[idx] = el;
                        }}
                        role="option"
                        aria-selected={isActive}
                        className={`search-dropdown-item ${isActive ? 'is-active' : ''}`}
                        type="button"
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => {
                          setDropdownOpen(false);
                          setActiveIndex(-1);
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
                          <div className="search-dropdown-thumb search-dropdown-thumb-fallback">
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
                            {rating > 0 && <span>★ {rating.toFixed(1)}</span>}
                            {saved && (
                              <span className="search-dropdown-badge search-dropdown-badge-saved">
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
                      setActiveIndex(-1);
                      onSearchSubmit(query);
                    }}
                  >
                    &ldquo;{query}&rdquo; için tüm sonuçları gridde gör (Enter)
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
              <span className="topbar-source-dot" aria-hidden="true"></span>
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

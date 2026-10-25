import React, { useState, useEffect, useRef } from 'react';
import { displayTitle, getPoster, releaseYear } from '../utils/helpers';
import { SavedItem, makeMediaKey } from '../core/cinetrack-core';
import { fetchTmdb } from '../services/api';
import { TmdbItem } from '../types/tmdb';
import { PWAInstallButton } from './PWAInstallButton';

interface HeaderProps {
  profileName: string;
  tab: 'discover' | 'list' | 'taste-map' | 'relationships';
  onTabChange: (tab: 'discover' | 'list' | 'taste-map' | 'relationships') => void;
  myListCount: number;
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
  tab,
  onTabChange,
  myListCount,
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
  const [isSearchFocused, setIsSearchFocused] = useState(false);

  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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
        setIsSearchFocused(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  // Global keyboard shortcuts: 'k' or '/' opens search (ignoring when user is typing in inputs or holding modifier keys)
  useEffect(() => {
    const handleGlobalShortcuts = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        return;
      }
      if (event.key === 'k' || event.key === '/') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleGlobalShortcuts);
    return () => window.removeEventListener('keydown', handleGlobalShortcuts);
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

    if (!val.trim()) {
      setDropdownOpen(false);
      setDropdownItems([]);
      setActiveIndex(-1);
      return;
    }

    // 350ms debounce with AbortController (Section 4 & Section 14)
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      requestControllerRef.current = controller;

      try {
        const res = await fetchTmdb(
          '/search/multi',
          { query: val.trim(), page: '1' },
          controller.signal
        );

        if (requestId !== requestIdRef.current) return;

        const results = (res?.results || [])
          .filter((item: any) => item && (item.media_type === 'movie' || item.media_type === 'tv'))
          .slice(0, 7);

        setDropdownItems(results);
        setDropdownOpen(true);
        setActiveIndex(-1);
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        if (requestId === requestIdRef.current) {
          setDropdownItems([]);
          setDropdownOpen(true);
        }
      }
    }, 350);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!dropdownOpen && dropdownItems.length > 0) {
        setDropdownOpen(true);
        setActiveIndex(0);
        return;
      }
      setActiveIndex((prev) => (prev < dropdownItems.length - 1 ? prev + 1 : 0));
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!dropdownOpen) return;
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : dropdownItems.length - 1));
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
      inputRef.current?.blur();
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

  const avatarInitial = (profileName || 'P').trim().charAt(0).toUpperCase();

  return (
    <header className="app-header">
      <div className="shell topbar">
        {/* Brand Zone */}
        <div className="brand" onClick={() => onTabChange('discover')} role="button" tabIndex={0}>
          <span className="brand-icon" aria-hidden="true">
            <svg className="icon">
              <use href="#icon-film"></use>
            </svg>
          </span>
          <span className="brand-title">CineTrack</span>
        </div>

        {/* Primary Desktop Nav Tabs (Section 4) */}
        <nav className="header-nav-tabs" role="tablist" aria-label="Ana Gezinme">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'discover'}
            className={`nav-tab-btn ${tab === 'discover' ? 'is-active' : ''}`}
            onClick={() => onTabChange('discover')}
          >
            <span>Keşfet</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'list'}
            className={`nav-tab-btn ${tab === 'list' ? 'is-active' : ''}`}
            onClick={() => onTabChange('list')}
          >
            <span>Listem</span>
            {myListCount > 0 && (
              <>
                {' '}
                <span className="nav-tab-badge tabular-nums">{myListCount}</span>
              </>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'taste-map'}
            className={`nav-tab-btn ${tab === 'taste-map' ? 'is-active' : ''}`}
            onClick={() => onTabChange('taste-map')}
          >
            <span>Zevkim</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'relationships'}
            className={`nav-tab-btn ${tab === 'relationships' ? 'is-active' : ''}`}
            onClick={() => onTabChange('relationships')}
          >
            <span>İlişkiler</span>
          </button>
        </nav>

        {/* Expandable Search Area (k / /) */}
        <div className={`search ${isSearchFocused ? 'is-focused' : ''}`} ref={searchRef}>
          <svg className="icon search-icon" aria-hidden="true">
            <use href="#icon-search"></use>
          </svg>
          <input
            ref={inputRef}
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
            onFocus={() => setIsSearchFocused(true)}
            onBlur={() => !dropdownOpen && setIsSearchFocused(false)}
            placeholder="Film veya dizi ara… (Kısayol: k veya /)"
            autoComplete="off"
            aria-label="Film veya dizi ara"
          />
          {query && (
            <button
              id="searchClear"
              className="search-clear"
              type="button"
              onClick={handleSearchClear}
              aria-label="Aramayı temizle"
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

                    const statusLabel =
                      saved?.status === 'watching'
                        ? 'İzleniyor'
                        : saved?.status === 'completed'
                        ? 'İzlendi'
                        : saved?.status === 'watchlist'
                        ? 'Listede'
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
                            <span className="tabular-nums">{year || ''}</span>
                            {rating > 0 && <span className="tabular-nums">★ {rating.toFixed(1)}</span>}
                            {saved && (
                              <span className={`search-dropdown-badge search-dropdown-badge-saved status-${saved.status}`}>
                                {statusLabel}
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
                    &ldquo;{query}&rdquo; için tüm sonuçları gör (Enter)
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Right Actions Zone: Source tag, PWA, Profile, Add */}
        <div className="topbar-actions">
          {tmdbSource && tmdbSource !== 'live' && (
            <span
              className={`topbar-source-badge ${
                tmdbSource === 'stale-cache' ? 'source-stale' : 'source-demo'
              }`}
              title={
                tmdbSource === 'stale-cache'
                  ? `TMDB canlı servisi kapalı; önbellek sunuluyor${tmdbStaleReason ? ` (${tmdbStaleReason})` : ''}`
                  : 'Örnek katalog aktif'
              }
            >
              <span>{tmdbSource === 'stale-cache' ? 'Önbellek' : 'Demo'}</span>
            </span>
          )}

          <PWAInstallButton />

          {/* Profile Switcher Button with Avatar Initial */}
          <button
            id="profileButton"
            className="btn profile-btn"
            type="button"
            onClick={onOpenProfile}
            aria-haspopup="dialog"
            aria-label={`Profil: ${profileName || 'Profilim'}`}
            title="Profil yönetimi ve ayarlar"
          >
            <span className="profile-avatar-circle" aria-hidden="true">
              {avatarInitial}
            </span>
            <span id="profileButtonLabel" className="profile-name-text">
              {profileName || 'Profilim'}
            </span>
          </button>

          <button
            id="addButton"
            className="btn btn-primary add-custom-btn"
            type="button"
            onClick={onOpenAdd}
            title="Özel film veya dizi ekle"
            aria-label="Özel yapım ekle"
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-plus"></use>
            </svg>
            <span className="add-btn-text">Ekle</span>
          </button>
        </div>
      </div>
    </header>
  );
};

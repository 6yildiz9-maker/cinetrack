import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Command } from 'cmdk';
import type { SavedItem } from '../core/cinetrack-core.ts';
import { fetchTmdb } from '../services/api.ts';
import { displayTitle, getPoster, releaseYear } from '../utils/helpers.ts';
import { useDialogAccessibility } from '../utils/useDialogAccessibility.ts';

export type PaletteTab = 'discover' | 'list' | 'taste-map' | 'relationships';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  savedItems: SavedItem[];
  onSelectTab: (tab: PaletteTab) => void;
  onOpenProfile: () => void;
  onOpenAddCustom: () => void;
  onQuickSave: () => void;
  onFocusSearch: () => void;
  onOpenItem: (item: SavedItem) => void;
}

interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  keywords: string[];
  icon: string;
  shortcut?: string;
  run: () => void;
}

const LIST_RESULT_LIMIT = 8;
const TMDB_RESULT_LIMIT = 8;
const TMDB_DEBOUNCE_MS = 350;
const TMDB_MIN_QUERY_LENGTH = 2;

function normalizeTr(value: string): string {
  return value
    .toLocaleLowerCase('tr')
    .replaceAll('ı', 'i')
    .replaceAll('İ', 'i')
    .replaceAll('ş', 's')
    .replaceAll('ğ', 'g')
    .replaceAll('ü', 'u')
    .replaceAll('ö', 'o')
    .replaceAll('ç', 'c');
}

function matches(haystack: string[], needle: string): boolean {
  if (!needle) return true;
  return haystack.some((value) => normalizeTr(value).includes(needle));
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  savedItems,
  onSelectTab,
  onOpenProfile,
  onOpenAddCustom,
  onQuickSave,
  onFocusSearch,
  onOpenItem,
}) => {
  const dialogRef = useDialogAccessibility(isOpen, onClose);
  const [query, setQuery] = useState('');
  const [tmdbResults, setTmdbResults] = useState<SavedItem[]>([]);
  const [isSearchingTmdb, setIsSearchingTmdb] = useState(false);
  const [tmdbError, setTmdbError] = useState('');
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (isOpen) return;
    setQuery('');
    setTmdbResults([]);
    setTmdbError('');
    setIsSearchingTmdb(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const term = query.trim();
    const requestId = ++requestIdRef.current;

    if (term.length < TMDB_MIN_QUERY_LENGTH) {
      setTmdbResults([]);
      setTmdbError('');
      setIsSearchingTmdb(false);
      return;
    }

    const controller = new AbortController();
    setIsSearchingTmdb(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const data = await fetchTmdb('/search/multi', { query: term }, controller.signal);
          if (requestId !== requestIdRef.current) return;
          const results = (data?.results || [])
            .filter((item: SavedItem) => item.media_type === 'movie' || item.media_type === 'tv')
            .slice(0, TMDB_RESULT_LIMIT);
          setTmdbResults(results);
          setTmdbError('');
        } catch (error: any) {
          if (controller.signal.aborted || requestId !== requestIdRef.current) return;
          setTmdbResults([]);
          setTmdbError(error?.message || 'TMDB araması başarısız oldu.');
        } finally {
          if (!controller.signal.aborted && requestId === requestIdRef.current) {
            setIsSearchingTmdb(false);
          }
        }
      })();
    }, TMDB_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, isOpen]);

  const commands = useMemo<PaletteCommand[]>(
    () => [
      {
        id: 'tab-discover',
        label: 'Keşfet',
        group: 'Sayfalar',
        keywords: ['katalog', 'trend', 'öneri', 'discover'],
        icon: '#icon-fire',
        shortcut: '1',
        run: () => onSelectTab('discover'),
      },
      {
        id: 'tab-list',
        label: 'Listem',
        group: 'Sayfalar',
        keywords: ['kütüphane', 'izlediklerim', 'list'],
        icon: '#icon-library',
        shortcut: '2',
        run: () => onSelectTab('list'),
      },
      {
        id: 'tab-taste-map',
        label: 'Zevkim',
        group: 'Sayfalar',
        keywords: ['zevkim', 'kimliğim', 'istatistik', 'tat', 'dna'],
        icon: '#icon-dna',
        shortcut: '3',
        run: () => onSelectTab('taste-map'),
      },
      {
        id: 'tab-relationships',
        label: 'İlişkiler ve Evrenler',
        group: 'Sayfalar',
        keywords: ['ilişkiler', 'ağ', 'evrenler', 'relationships'],
        icon: '#icon-network',
        shortcut: '4',
        run: () => onSelectTab('relationships'),
      },
      {
        id: 'open-profile',
        label: 'Profil ve Ayarlar',
        group: 'Sayfalar',
        keywords: ['tercihler', 'yedekleme', 'senkron', 'ayarlar'],
        icon: '#icon-user',
        shortcut: '5',
        run: onOpenProfile,
      },
      {
        id: 'action-save',
        label: 'Kaydet ve eşitle',
        group: 'Eylemler',
        keywords: ['senkron', 'yedek', 'sunucu'],
        icon: '#icon-check',
        shortcut: 'S',
        run: onQuickSave,
      },
      {
        id: 'action-add-custom',
        label: 'Özel içerik ekle',
        group: 'Eylemler',
        keywords: ['yeni', 'elle ekle', 'custom'],
        icon: '#icon-plus',
        shortcut: 'N',
        run: onOpenAddCustom,
      },
      {
        id: 'action-focus-search',
        label: 'Arama çubuğuna git',
        group: 'Eylemler',
        keywords: ['ara', 'query', 'search'],
        icon: '#icon-search',
        shortcut: '/',
        run: onFocusSearch,
      },
    ],
    [onFocusSearch, onOpenAddCustom, onOpenProfile, onQuickSave, onSelectTab]
  );

  const needle = normalizeTr(query.trim());

  const visibleCommands = useMemo(
    () =>
      needle
        ? commands.filter((command) =>
            matches([command.label, ...command.keywords, command.group], needle)
          )
        : commands,
    [commands, needle]
  );

  const listResults = useMemo(() => {
    if (!needle) return [];
    return savedItems
      .filter((item) => matches([displayTitle(item) || '', String(item.id)], needle))
      .slice(0, LIST_RESULT_LIMIT);
  }, [needle, savedItems]);

  if (!isOpen) return null;

  const openMedia = (item: SavedItem) => {
    onOpenItem(item);
    onClose();
  };

  const runCommand = (command: PaletteCommand) => {
    command.run();
    onClose();
  };

  const mediaMeta = (item: SavedItem) => {
    const year = releaseYear(item);
    const kind = item.media_type === 'tv' ? 'Dizi' : 'Film';
    return year ? `${kind} · ${year}` : kind;
  };

  return (
    <div
      className="modal-wrap command-palette-wrap open"
      aria-hidden="false"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <article
        ref={dialogRef}
        className="modal command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="commandPaletteTitle"
        tabIndex={-1}
      >
        <h2 id="commandPaletteTitle" className="sr-only">
          Komut paleti
        </h2>
        <Command
          label="Komut paleti"
          shouldFilter={false}
          className="command-root"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
        >
          <div className="command-input-row">
            <svg className="icon" aria-hidden="true">
              <use href="#icon-search"></use>
            </svg>
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Sayfa, eylem veya içerik ara…"
              aria-label="Komut paleti araması"
              autoFocus
            />
            <kbd className="command-kbd">Esc</kbd>
          </div>

          <Command.List className="command-list">
            {visibleCommands.length > 0 && (
              <Command.Group heading="Komutlar">
                {visibleCommands.map((command) => (
                  <Command.Item
                    key={command.id}
                    value={command.id}
                    onSelect={() => runCommand(command)}
                    className="command-item"
                  >
                    <svg className="icon" aria-hidden="true">
                      <use href={command.icon}></use>
                    </svg>
                    <span className="command-item-label">{command.label}</span>
                    {command.shortcut && <kbd className="command-kbd">{command.shortcut}</kbd>}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {listResults.length > 0 && (
              <Command.Group heading="Listem">
                {listResults.map((item) => (
                  <Command.Item
                    key={`saved-${item.media_type}:${item.id}`}
                    value={`saved-${item.media_type}:${item.id}`}
                    onSelect={() => openMedia(item)}
                    className="command-item command-item-media"
                  >
                    <MediaThumb item={item} />
                    <span className="command-item-label">{displayTitle(item)}</span>
                    <span className="command-item-meta">{mediaMeta(item)}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            <Command.Group heading="TMDB">
              {isSearchingTmdb && <div className="command-status">TMDB’de aranıyor…</div>}
              {!isSearchingTmdb && tmdbError && <div className="command-status">{tmdbError}</div>}
              {!isSearchingTmdb &&
                !tmdbError &&
                tmdbResults.map((item) => (
                  <Command.Item
                    key={`tmdb-${item.media_type}:${item.id}`}
                    value={`tmdb-${item.media_type}:${item.id}`}
                    onSelect={() => openMedia(item)}
                    className="command-item command-item-media"
                  >
                    <MediaThumb item={item} />
                    <span className="command-item-label">{displayTitle(item)}</span>
                    <span className="command-item-meta">{mediaMeta(item)}</span>
                  </Command.Item>
                ))}
              {!isSearchingTmdb &&
                !tmdbError &&
                query.trim().length < TMDB_MIN_QUERY_LENGTH && (
                  <div className="command-status">
                    Katalogda aramak için en az {TMDB_MIN_QUERY_LENGTH} harf yazın.
                  </div>
                )}
            </Command.Group>
          </Command.List>
        </Command>
      </article>
    </div>
  );
};

const MediaThumb: React.FC<{ item: SavedItem }> = ({ item }) => {
  const poster = getPoster(item, 'w154');
  if (!poster) {
    return <span className="command-thumb command-thumb-empty" aria-hidden="true" />;
  }
  return <img className="command-thumb" src={poster} alt="" loading="lazy" decoding="async" />;
};

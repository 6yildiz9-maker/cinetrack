import { fetchTmdb } from './api.ts';
import {
  loadStockIdb,
  saveStockIdb,
  recordSurfacedKeys,
  loadSurfacedKeys,
  loadUserListsIdb,
  loadIsolatedProfileIdb,
  type StockDepot,
} from './storage-idb.ts';
import { indexItemsForSeriesBatch } from './series-service.ts';
import type { SavedItem } from '../core/cinetrack-core.ts';
import type { TmdbItem } from '../types/tmdb.ts';

export const STOCK_TARGET_COUNT = 500;
export const STOCK_REPLENISH_THRESHOLD = 250;

export type StockTmdbFetcher = (path: string, params?: Record<string, string>) => Promise<any>;

let activeStockFetcher: StockTmdbFetcher = (path, params) => fetchTmdb(path, params);

export function setStockTmdbFetcher(fetcher?: StockTmdbFetcher | null): void {
  activeStockFetcher = fetcher || ((path, params) => fetchTmdb(path, params));
}

export interface StockState {
  movies: TmdbItem[];
  tv: TmdbItem[];
  moviesCount: number;
  tvCount: number;
  isLoading: boolean;
  isReplenishing: boolean;
  lastUpdated: string;
}

let activeStock: StockDepot = { movies: [], tv: [], updatedAt: '', cursors: {} };
let isInitialized = false;
let isReplenishingActive = false;
let replenishmentTimeout: ReturnType<typeof setTimeout> | null = null;
const stockListeners = new Set<(state: StockState) => void>();

function buildStockStateSnapshot(): StockState {
  return {
    movies: activeStock.movies,
    tv: activeStock.tv,
    moviesCount: activeStock.movies.length,
    tvCount: activeStock.tv.length,
    isLoading: !isInitialized,
    isReplenishing: isReplenishingActive,
    lastUpdated: activeStock.updatedAt,
  };
}

function notifyStockListeners(): void {
  const state = buildStockStateSnapshot();
  for (const listener of stockListeners) {
    try {
      listener(state);
    } catch (e) {
      console.warn('[StockEngine] Listener error:', e);
    }
  }
}

export function subscribeStockState(listener: (state: StockState) => void): () => void {
  stockListeners.add(listener);
  listener(buildStockStateSnapshot());
  return () => {
    stockListeners.delete(listener);
  };
}

export function getCurrentStock(): StockDepot {
  return activeStock;
}

export function getStockCounts(): { moviesCount: number; tvCount: number; total: number } {
  return {
    moviesCount: activeStock.movies.length,
    tvCount: activeStock.tv.length,
    total: activeStock.movies.length + activeStock.tv.length,
  };
}

export function resetStockEngineForTests(): void {
  if (replenishmentTimeout) {
    clearTimeout(replenishmentTimeout);
    replenishmentTimeout = null;
  }
  activeStock = { movies: [], tv: [], updatedAt: '', cursors: {} };
  isInitialized = false;
  isReplenishingActive = false;
  setStockTmdbFetcher(null);
  notifyStockListeners();
}

/**
 * Initializes ct:stock depot from IndexedDB and triggers initial fill to 500 movies + 500 TV shows
 * when below threshold (< 250).
 */
export async function initStockEngine(
  profileId: string,
  options: { immediate?: boolean } = {}
): Promise<StockDepot> {
  if (
    isInitialized &&
    activeStock.movies.length >= STOCK_REPLENISH_THRESHOLD &&
    activeStock.tv.length >= STOCK_REPLENISH_THRESHOLD
  ) {
    return activeStock;
  }

  const loaded = await loadStockIdb();
  activeStock = {
    movies: Array.isArray(loaded.movies) ? loaded.movies : [],
    tv: Array.isArray(loaded.tv) ? loaded.tv : [],
    updatedAt: loaded.updatedAt || '',
    cursors: loaded.cursors || {},
  };
  isInitialized = true;
  notifyStockListeners();

  if (
    activeStock.movies.length < STOCK_REPLENISH_THRESHOLD ||
    activeStock.tv.length < STOCK_REPLENISH_THRESHOLD
  ) {
    if (options.immediate) {
      await executeStockReplenishment(profileId);
    } else {
      scheduleStockReplenishment(profileId, 250);
    }
  }

  return activeStock;
}

/**
 * Consumes an item from ct:stock when the user adds it to their list (Aşama 4: Adım 12)
 * and schedules autonomous replenishment if movie or TV count drops below 250 (Adım 13).
 */
export async function consumeStockItem(
  item: TmdbItem | SavedItem | any,
  profileId: string
): Promise<{ removed: boolean; triggeredReplenish: boolean }> {
  if (!item || item.id == null) return { removed: false, triggeredReplenish: false };
  if (!isInitialized) {
    activeStock = await loadStockIdb();
    isInitialized = true;
  }

  const isTv = item.media_type === 'tv' || (!item.media_type && Boolean(item.name) && !item.title);
  const targetId = String(item.id);

  let removed = false;
  if (isTv) {
    const prevLen = activeStock.tv.length;
    activeStock.tv = activeStock.tv.filter((it) => String(it.id) !== targetId);
    if (activeStock.tv.length !== prevLen) removed = true;
  } else {
    const prevLen = activeStock.movies.length;
    activeStock.movies = activeStock.movies.filter((it) => String(it.id) !== targetId);
    if (activeStock.movies.length !== prevLen) removed = true;
  }

  let triggeredReplenish = false;
  if (removed) {
    activeStock.updatedAt = new Date().toISOString();
    await saveStockIdb(activeStock);
    notifyStockListeners();

    if (
      activeStock.movies.length < STOCK_REPLENISH_THRESHOLD ||
      activeStock.tv.length < STOCK_REPLENISH_THRESHOLD
    ) {
      triggeredReplenish = true;
      scheduleStockReplenishment(profileId, 200);
    }
  }

  return { removed, triggeredReplenish };
}

/**
 * Marks items shown on the Discover tab (that are NOT in the user's list) into ct:surfaced FIFO store (Aşama 2: Adım 6)
 */
export async function markItemsAsSurfaced(
  items: (TmdbItem | any)[],
  savedKeys?: Set<string>
): Promise<void> {
  const keys: string[] = [];
  for (const it of items) {
    if (!it || it.id == null) continue;
    const mType = it.media_type === 'tv' || (!it.media_type && it.name && !it.title) ? 'tv' : 'movie';
    const mediaKey = `${mType}:${it.id}`;
    if (savedKeys && savedKeys.has(mediaKey)) continue;
    keys.push(mediaKey);
  }
  if (keys.length > 0) {
    await recordSurfacedKeys(keys);
  }
}

export function scheduleStockReplenishment(profileId: string, delayMs = 600): void {
  if (isReplenishingActive) return;
  if (replenishmentTimeout) clearTimeout(replenishmentTimeout);

  replenishmentTimeout = setTimeout(() => {
    replenishmentTimeout = null;
    void executeStockReplenishment(profileId);
  }, delayMs);
}

/**
 * Autonomous stock engine: fills movie and TV depot back to 500 items each whenever
 * either depot is below 250 (or during initial cold fill), strictly filtering out
 * user-lists, disliked/hidden preferences, ct:surfaced, and current ct:stock IDs (Aşama 4: Adım 13–14).
 */
export async function executeStockReplenishment(profileId: string): Promise<StockDepot> {
  if (isReplenishingActive) return activeStock;
  if (replenishmentTimeout) {
    clearTimeout(replenishmentTimeout);
    replenishmentTimeout = null;
  }

  isReplenishingActive = true;
  notifyStockListeners();

  try {
    if (!isInitialized) {
      const loaded = await loadStockIdb();
      activeStock = {
        movies: Array.isArray(loaded.movies) ? loaded.movies : [],
        tv: Array.isArray(loaded.tv) ? loaded.tv : [],
        updatedAt: loaded.updatedAt || '',
        cursors: loaded.cursors || {},
      };
      isInitialized = true;
    }

    const [userListItems, surfacedList, isolatedProfile] = await Promise.all([
      loadUserListsIdb(profileId),
      loadSurfacedKeys(),
      loadIsolatedProfileIdb(profileId),
    ]);

    const userAndSurfacedExclusions = new Set<string>();
    for (const it of userListItems) {
      const mType = it.media_type === 'tv' ? 'tv' : 'movie';
      userAndSurfacedExclusions.add(`${mType}:${it.id}`);
    }
    for (const dislikedKey of isolatedProfile?.preferences?.disliked || []) {
      userAndSurfacedExclusions.add(dislikedKey);
    }
    for (const hiddenKey of isolatedProfile?.preferences?.hidden || []) {
      userAndSurfacedExclusions.add(hiddenKey);
    }
    for (const key of surfacedList) {
      userAndSurfacedExclusions.add(key);
    }

    // Purge any stock items that have since entered user-lists or disliked
    activeStock.movies = activeStock.movies.filter(
      (m) => !userAndSurfacedExclusions.has(`movie:${m.id}`)
    );
    activeStock.tv = activeStock.tv.filter(
      (t) => !userAndSurfacedExclusions.has(`tv:${t.id}`)
    );

    const excludedKeys = new Set<string>(userAndSurfacedExclusions);
    for (const m of activeStock.movies) {
      excludedKeys.add(`movie:${m.id}`);
    }
    for (const t of activeStock.tv) {
      excludedKeys.add(`tv:${t.id}`);
    }

    const cursors: Record<string, number> = { ...(activeStock.cursors || {}) };
    const newlyIndexedCandidates: TmdbItem[] = [];

    const needsMoviesFill = activeStock.movies.length < STOCK_REPLENISH_THRESHOLD;
    const needsTvFill = activeStock.tv.length < STOCK_REPLENISH_THRESHOLD;

    if (needsMoviesFill) {
      const movieShortage = Math.max(0, STOCK_TARGET_COUNT - activeStock.movies.length);
      if (movieShortage > 0) {
        const newMovies = await fetchCandidateBatch('movie', movieShortage, excludedKeys, cursors);
        activeStock.movies.push(...newMovies);
        newlyIndexedCandidates.push(...newMovies.slice(0, 60));
      }
    }

    if (needsTvFill) {
      const tvShortage = Math.max(0, STOCK_TARGET_COUNT - activeStock.tv.length);
      if (tvShortage > 0) {
        const newTv = await fetchCandidateBatch('tv', tvShortage, excludedKeys, cursors);
        activeStock.tv.push(...newTv);
        newlyIndexedCandidates.push(...newTv.slice(0, 60));
      }
    }

    activeStock.cursors = cursors;
    activeStock.updatedAt = new Date().toISOString();
    await saveStockIdb(activeStock);

    // Index series/franchises for stock items in background without blocking UI
    if (newlyIndexedCandidates.length > 0) {
      void indexItemsForSeriesBatch(newlyIndexedCandidates);
    }
  } catch (err) {
    console.warn('[StockEngine] Replenishment error:', err);
  } finally {
    isReplenishingActive = false;
    notifyStockListeners();
  }

  return activeStock;
}

/**
 * Fetches batches across popular, top_rated, discover, and trending endpoints with persistent cursors
 * until `targetNeeded` unique eligible items are collected (up to 500 movies / 500 TV shows).
 */
async function fetchCandidateBatch(
  mediaType: 'movie' | 'tv',
  targetNeeded: number,
  excludedKeys: Set<string>,
  cursors: Record<string, number>
): Promise<TmdbItem[]> {
  const result: TmdbItem[] = [];
  const endpoints: Array<{
    cursorKey: string;
    path: string;
    params?: Record<string, string>;
    maxPages: number;
  }> = [
    { cursorKey: `${mediaType}:popular`, path: `/${mediaType}/popular`, maxPages: 20 },
    { cursorKey: `${mediaType}:top_rated`, path: `/${mediaType}/top_rated`, maxPages: 20 },
    {
      cursorKey: `${mediaType}:discover_pop`,
      path: `/discover/${mediaType}`,
      params: { sort_by: 'popularity.desc', 'vote_count.gte': '80' },
      maxPages: 25,
    },
    {
      cursorKey: `${mediaType}:discover_vote`,
      path: `/discover/${mediaType}`,
      params: { sort_by: 'vote_average.desc', 'vote_count.gte': '250' },
      maxPages: 20,
    },
    { cursorKey: `${mediaType}:trending`, path: `/trending/${mediaType}/week`, maxPages: 10 },
  ];

  for (const ep of endpoints) {
    if (result.length >= targetNeeded) break;

    const startPage = Math.max(1, Number(cursors[ep.cursorKey]) || 1);
    for (let offset = 0; offset < ep.maxPages; offset += 1) {
      if (result.length >= targetNeeded) break;

      const page = ((startPage - 1 + offset) % 50) + 1;
      try {
        const queryParams: Record<string, string> = {
          page: String(page),
          ...(ep.params || {}),
        };
        const res = await activeStockFetcher(ep.path, queryParams);
        const items = Array.isArray(res?.results) ? res.results : [];
        if (items.length === 0) break;

        let addedFromPage = 0;
        for (const it of items) {
          if (!it || it.id == null) continue;
          const key = `${mediaType}:${it.id}`;
          if (excludedKeys.has(key)) continue;

          const normalized: TmdbItem = {
            ...it,
            media_type: mediaType,
          };
          result.push(normalized);
          excludedKeys.add(key);
          addedFromPage += 1;

          if (result.length >= targetNeeded) break;
        }

        cursors[ep.cursorKey] = (page % 50) + 1;
        const totalPages = Number(res?.total_pages) || 1;
        if (page >= totalPages && addedFromPage === 0) {
          break;
        }
      } catch {
        break;
      }
    }
  }

  return result;
}

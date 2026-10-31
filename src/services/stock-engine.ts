import { fetchTmdb } from './api.ts';
import {
  loadStockIdb,
  saveStockIdb,
  recordSurfacedKeys,
  loadSurfacedKeys,
  loadUserListsIdb,
  StockDepot,
} from './storage-idb.ts';
import { indexItemForSeries } from './series-service.ts';
import type { SavedItem } from '../core/cinetrack-core.ts';
import type { TmdbItem } from '../types/tmdb.ts';

export const STOCK_TARGET_COUNT = 500;
export const STOCK_REPLENISH_THRESHOLD = 250;

export interface StockState {
  movies: TmdbItem[];
  tv: TmdbItem[];
  moviesCount: number;
  tvCount: number;
  isLoading: boolean;
  isReplenishing: boolean;
  lastUpdated: string;
}

let activeStock: StockDepot = { movies: [], tv: [], updatedAt: '' };
let isInitialized = false;
let isReplenishingActive = false;
const stockListeners = new Set<(state: StockState) => void>();

function notifyStockListeners(): void {
  const state: StockState = {
    movies: activeStock.movies,
    tv: activeStock.tv,
    moviesCount: activeStock.movies.length,
    tvCount: activeStock.tv.length,
    isLoading: !isInitialized,
    isReplenishing: isReplenishingActive,
    lastUpdated: activeStock.updatedAt,
  };
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
  // Send initial state immediately
  listener({
    movies: activeStock.movies,
    tv: activeStock.tv,
    moviesCount: activeStock.movies.length,
    tvCount: activeStock.tv.length,
    isLoading: !isInitialized,
    isReplenishing: isReplenishingActive,
    lastUpdated: activeStock.updatedAt,
  });
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

/**
 * Initializes stock depot from IndexedDB or replenishes if below threshold
 */
export async function initStockEngine(profileId: string): Promise<StockDepot> {
  if (isInitialized && activeStock.movies.length >= STOCK_REPLENISH_THRESHOLD && activeStock.tv.length >= STOCK_REPLENISH_THRESHOLD) {
    return activeStock;
  }

  const loaded = await loadStockIdb();
  activeStock = loaded;
  isInitialized = true;
  notifyStockListeners();

  // If initial stock is below 250 for movies or TV, trigger initial fill to 500
  if (activeStock.movies.length < STOCK_REPLENISH_THRESHOLD || activeStock.tv.length < STOCK_REPLENISH_THRESHOLD) {
    scheduleStockReplenishment(profileId);
  }

  return activeStock;
}

/**
 * Consumes an item from stock when the user adds it to their list (Aşama 4: Adım 12)
 */
export async function consumeStockItem(
  item: TmdbItem | SavedItem | any,
  profileId: string
): Promise<void> {
  if (!item || !item.id) return;
  const isTv = item.media_type === 'tv' || (!item.media_type && item.name);
  const targetId = Number(item.id);

  let removed = false;
  if (isTv) {
    const prevLen = activeStock.tv.length;
    activeStock.tv = activeStock.tv.filter((it) => Number(it.id) !== targetId);
    if (activeStock.tv.length !== prevLen) removed = true;
  } else {
    const prevLen = activeStock.movies.length;
    activeStock.movies = activeStock.movies.filter((it) => Number(it.id) !== targetId);
    if (activeStock.movies.length !== prevLen) removed = true;
  }

  if (removed) {
    activeStock.updatedAt = new Date().toISOString();
    await saveStockIdb(activeStock);
    notifyStockListeners();

    // Check threshold (Aşama 4: Adım 13)
    if (activeStock.movies.length < STOCK_REPLENISH_THRESHOLD || activeStock.tv.length < STOCK_REPLENISH_THRESHOLD) {
      scheduleStockReplenishment(profileId);
    }
  }
}

/**
 * Marks items as surfaced on discover tab (Aşama 2: Adım 6)
 */
export async function markItemsAsSurfaced(items: (TmdbItem | any)[]): Promise<void> {
  const keys: string[] = [];
  for (const it of items) {
    if (!it || !it.id) continue;
    const mType = it.media_type === 'tv' ? 'tv' : 'movie';
    keys.push(`${mType}:${it.id}`);
  }
  if (keys.length > 0) {
    await recordSurfacedKeys(keys);
  }
}

let replenishmentTimeout: ReturnType<typeof setTimeout> | null = null;

export function scheduleStockReplenishment(profileId: string, delayMs = 1500): void {
  if (isReplenishingActive) return;
  if (replenishmentTimeout) clearTimeout(replenishmentTimeout);

  replenishmentTimeout = setTimeout(async () => {
    replenishmentTimeout = null;
    await executeStockReplenishment(profileId);
  }, delayMs);
}

/**
 * Autonomous stock engine: fills movie and TV depot to 500 items each,
 * filtering out user-lists, ct:surfaced and already-in-stock IDs (Aşama 4: Adım 14).
 */
export async function executeStockReplenishment(profileId: string): Promise<void> {
  if (isReplenishingActive) return;
  isReplenishingActive = true;
  notifyStockListeners();

  try {
    const userListItems = await loadUserListsIdb(profileId);
    const surfacedList = await loadSurfacedKeys();

    // Build exclusion set
    const excludedKeys = new Set<string>();
    for (const it of userListItems) {
      const mType = it.media_type === 'tv' ? 'tv' : 'movie';
      excludedKeys.add(`${mType}:${it.id}`);
    }
    for (const key of surfacedList) {
      excludedKeys.add(key);
    }
    for (const m of activeStock.movies) {
      excludedKeys.add(`movie:${m.id}`);
    }
    for (const t of activeStock.tv) {
      excludedKeys.add(`tv:${t.id}`);
    }

    const movieShortage = Math.max(0, STOCK_TARGET_COUNT - activeStock.movies.length);
    const tvShortage = Math.max(0, STOCK_TARGET_COUNT - activeStock.tv.length);

    if (movieShortage > 0) {
      const newMovies = await fetchCandidateBatch('movie', movieShortage, excludedKeys);
      activeStock.movies.push(...newMovies);
      for (const m of newMovies) {
        excludedKeys.add(`movie:${m.id}`);
        // Index franchise/collection in background
        indexItemForSeries(m).catch(() => {});
      }
    }

    if (tvShortage > 0) {
      const newTv = await fetchCandidateBatch('tv', tvShortage, excludedKeys);
      activeStock.tv.push(...newTv);
      for (const t of newTv) {
        excludedKeys.add(`tv:${t.id}`);
        // Index franchise/collection in background
        indexItemForSeries(t).catch(() => {});
      }
    }

    activeStock.updatedAt = new Date().toISOString();
    await saveStockIdb(activeStock);
  } catch (err) {
    console.warn('[StockEngine] Replenishment error:', err);
  } finally {
    isReplenishingActive = false;
    notifyStockListeners();
  }
}

/**
 * Fetches batches across popular, top_rated and discover endpoints
 */
async function fetchCandidateBatch(
  mediaType: 'movie' | 'tv',
  targetNeeded: number,
  excludedKeys: Set<string>
): Promise<TmdbItem[]> {
  const result: TmdbItem[] = [];
  const endpoints = [
    { path: `/${mediaType}/popular`, pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    { path: `/${mediaType}/top_rated`, pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    {
      path: `/discover/${mediaType}`,
      params: { sort_by: 'popularity.desc', 'vote_count.gte': '100' },
      pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    },
    {
      path: `/discover/${mediaType}`,
      params: { sort_by: 'vote_average.desc', 'vote_count.gte': '300' },
      pages: [1, 2, 3, 4, 5],
    },
    { path: `/trending/${mediaType}/week`, pages: [1, 2, 3] },
  ];

  for (const ep of endpoints) {
    if (result.length >= targetNeeded) break;

    for (const page of ep.pages) {
      if (result.length >= targetNeeded) break;

      try {
        const queryParams: Record<string, string> = {
          page: String(page),
          ...(ep.params || {}),
        };
        const res = await fetchTmdb(ep.path, queryParams);
        const items = Array.isArray(res?.results) ? res.results : [];

        for (const it of items) {
          if (!it || !it.id) continue;
          const key = `${mediaType}:${it.id}`;
          if (excludedKeys.has(key)) continue;

          // Normalize item
          const normalized: TmdbItem = {
            ...it,
            media_type: mediaType,
          };
          result.push(normalized);
          excludedKeys.add(key);

          if (result.length >= targetNeeded) break;
        }
      } catch (err) {
        // Continue to next page or endpoint
      }
    }
  }

  return result;
}

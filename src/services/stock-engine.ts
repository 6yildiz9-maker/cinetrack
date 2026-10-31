import { fetchTmdb } from './api.ts';
import {
  loadStockIdb,
  saveStockIdb,
  recordSurfacedKeys,
  loadUserListsIdb,
  loadIsolatedProfileIdb,
  getActiveSkippedKeys,
  getSurfacedPartitionForReplenishment,
  markSurfacedKeysRecycled,
  SURFACED_RECYCLE_COOLDOWN_MS,
  type StockDepot,
} from './storage-idb.ts';
import { indexItemsForSeriesBatch } from './series-service.ts';
import {
  hydratePoolFromCatalog,
  loadPersistentPoolData,
  savePersistentPoolData,
  type Preferences,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import type { TmdbCastMember, TmdbItem } from '../types/tmdb.ts';
import { isWithinReleaseWindow } from '../utils/release-window.ts';

export const STOCK_TARGET_COUNT = 500;
export const STOCK_REPLENISH_THRESHOLD = 250;

export interface TmdbPagePayload {
  page?: number;
  total_pages?: number;
  results?: TmdbItem[];
  id?: number | string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  genre_ids?: number[];
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  credits?: { cast?: TmdbCastMember[] };
  cast?: TmdbCastMember[];
  topCastIds?: number[];
}

export type StockTmdbFetcher = (
  path: string,
  params?: Record<string, string>
) => Promise<TmdbPagePayload>;

let activeStockFetcher: StockTmdbFetcher = (path, params) =>
  fetchTmdb(path, params) as Promise<TmdbPagePayload>;

export function setStockTmdbFetcher(fetcher?: StockTmdbFetcher | null): void {
  activeStockFetcher =
    fetcher || ((path, params) => fetchTmdb(path, params) as Promise<TmdbPagePayload>);
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

function extractTopThreeCastIds(item: TmdbItem): number[] | undefined {
  if (Array.isArray(item.topCastIds) && item.topCastIds.length > 0) {
    const clean = item.topCastIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
      .slice(0, 3);
    if (clean.length > 0) return clean;
  }
  const rawCast = Array.isArray(item.credits?.cast)
    ? item.credits.cast
    : Array.isArray(item.cast)
      ? item.cast
      : [];
  if (rawCast.length === 0) return undefined;
  const sorted = [...rawCast]
    .filter((c) => c && Number.isInteger(Number(c.id)) && Number(c.id) > 0)
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  const ids = sorted.slice(0, 3).map((c) => Number(c.id));
  return ids.length > 0 ? ids : undefined;
}

function resolveItemMediaType(item: { media_type?: string; name?: string; title?: string }): 'movie' | 'tv' {
  return item.media_type === 'tv' || (!item.media_type && Boolean(item.name) && !item.title)
    ? 'tv'
    : 'movie';
}

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
 * Enriches ct:stock items with their top-3 billing cast IDs (`topCastIds`) so open accordions in
 * Favori Oyuncular > Öneriler can surface matching items directly from ct:stock with 0 network calls (BUG-14 #5).
 */
export async function enrichStockItemsTopCast(
  castByMediaKey: Record<string, number[]>
): Promise<number> {
  const entries = Object.entries(castByMediaKey);
  if (entries.length === 0) return 0;

  if (!isInitialized) {
    activeStock = await loadStockIdb();
    isInitialized = true;
  }

  let updatedCount = 0;
  const applyToList = (list: TmdbItem[], mType: 'movie' | 'tv') => {
    for (const item of list) {
      const key = `${mType}:${item.id}`;
      const rawIds = castByMediaKey[key];
      if (!Array.isArray(rawIds) || rawIds.length === 0) continue;
      const topThree = rawIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
        .slice(0, 3);
      if (topThree.length === 0) continue;
      const prevKey = (item.topCastIds || []).join(',');
      if (prevKey !== topThree.join(',')) {
        item.topCastIds = topThree;
        updatedCount += 1;
      }
    }
  };

  applyToList(activeStock.movies, 'movie');
  applyToList(activeStock.tv, 'tv');

  if (updatedCount > 0) {
    activeStock.updatedAt = new Date().toISOString();
    await saveStockIdb(activeStock);
    notifyStockListeners();
  }
  return updatedCount;
}

/**
 * Synchronously retrieves stock items matching a favorite actor via `topCastIds` (0 network calls).
 */
export function getStockRecommendationsForActor(
  actorId: number,
  excludedKeys?: Set<string>
): TmdbItem[] {
  if (!Number.isInteger(actorId) || actorId <= 0) return [];
  const matches: TmdbItem[] = [];

  const collectFrom = (list: TmdbItem[], mType: 'movie' | 'tv') => {
    for (const item of list) {
      const key = `${mType}:${item.id}`;
      if (excludedKeys && excludedKeys.has(key)) continue;
      const topIds = item.topCastIds || extractTopThreeCastIds(item);
      if (topIds && topIds.includes(actorId)) {
        matches.push({ ...item, media_type: mType, topCastIds: topIds });
      }
    }
  };

  collectFrom(activeStock.movies, 'movie');
  collectFrom(activeStock.tv, 'tv');
  return matches;
}

/**
 * Hydrates cinetrack-core's candidate pool directly from ct:stock as the primary Discover source
 * before hitting TMDB network (FEAT-02 Section 4.1).
 */
export async function seedCandidatePoolFromStock(
  profileId: string,
  mediaType: 'movie' | 'tv',
  savedItems: SavedItem[],
  preferences: Preferences,
  options: { nowMs?: number } = {}
): Promise<number> {
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

  const stockList = mediaType === 'movie' ? activeStock.movies : activeStock.tv;
  if (stockList.length === 0) return 0;

  const skippedSet = await getActiveSkippedKeys(profileId, undefined, options.nowMs);
  const catalogLikeRecord: Record<string, TmdbItem> = {};
  for (const item of stockList) {
    if (!item || item.id == null) continue;
    const key = `${mediaType}:${item.id}`;
    if (skippedSet.has(key)) continue;
    catalogLikeRecord[key] = { ...item, media_type: mediaType };
  }

  if (Object.keys(catalogLikeRecord).length === 0) return 0;

  const currentPool = loadPersistentPoolData(profileId, mediaType);
  const hydrated = hydratePoolFromCatalog(currentPool, catalogLikeRecord, savedItems, preferences);
  if (hydrated.addedCount > 0) {
    savePersistentPoolData(profileId, hydrated.poolData);
  }
  return hydrated.addedCount;
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
  item: TmdbItem | SavedItem | { id?: number | string; media_type?: string; name?: string; title?: string },
  profileId: string
): Promise<{ removed: boolean; triggeredReplenish: boolean }> {
  if (!item || item.id == null) return { removed: false, triggeredReplenish: false };
  if (!isInitialized) {
    activeStock = await loadStockIdb();
    isInitialized = true;
  }

  const isTv = resolveItemMediaType(item) === 'tv';
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
  items: ReadonlyArray<{ id?: number | string; media_type?: string; name?: string; title?: string }>,
  savedKeys?: Set<string>,
  nowMs: number = Date.now()
): Promise<void> {
  const keys: string[] = [];
  for (const it of items) {
    if (!it || it.id == null) continue;
    const mType = resolveItemMediaType(it);
    const mediaKey = `${mType}:${it.id}`;
    if (savedKeys && savedKeys.has(mediaKey)) continue;
    keys.push(mediaKey);
  }
  if (keys.length > 0) {
    await recordSurfacedKeys(keys, undefined, nowMs);
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

export interface ReplenishmentOptions {
  recycleCooldownMs?: number;
  nowMs?: number;
}

/**
 * Autonomous stock engine: fills movie and TV depot back to 500 items each whenever
 * either depot is below 250 (or during initial cold fill).
 * - Excludes user-lists, disliked/hidden, active ct:skip-log, active-cooldown ct:surfaced, and current stock IDs.
 * - Halka-dönüşü (Recycle, FEAT-02 Section 4.2): prefers never-surfaced fresh TMDB items first;
 *   if fresh sources run short, recycles the oldest ct:surfaced entries whose cooldown (7 days) has expired.
 */
export async function executeStockReplenishment(
  profileId: string,
  options: ReplenishmentOptions = {}
): Promise<StockDepot> {
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

    const nowMs = options.nowMs ?? Date.now();
    const cooldownMs = options.recycleCooldownMs ?? SURFACED_RECYCLE_COOLDOWN_MS;

    const [userListItems, surfacedPartition, isolatedProfile, activeSkipKeys] = await Promise.all([
      loadUserListsIdb(profileId),
      getSurfacedPartitionForReplenishment(cooldownMs, nowMs),
      loadIsolatedProfileIdb(profileId),
      getActiveSkippedKeys(profileId, undefined, nowMs),
    ]);

    // Hard exclusions: NEVER enter stock or recycle
    const hardExclusions = new Set<string>();
    for (const it of userListItems) {
      const mType = it.media_type === 'tv' ? 'tv' : 'movie';
      hardExclusions.add(`${mType}:${it.id}`);
    }
    for (const dislikedKey of isolatedProfile?.preferences?.disliked || []) {
      hardExclusions.add(dislikedKey);
    }
    for (const hiddenKey of isolatedProfile?.preferences?.hidden || []) {
      hardExclusions.add(hiddenKey);
    }
    for (const skipKey of activeSkipKeys) {
      hardExclusions.add(skipKey);
    }
    for (const activeSurfacedKey of surfacedPartition.activeCooldownKeys) {
      hardExclusions.add(activeSurfacedKey);
    }

    const allSurfacedExclusions = new Set<string>([
      ...hardExclusions,
      ...surfacedPartition.recyclableExpiredKeys,
    ]);

    // Purge any stock items that have entered user-lists, disliked/hidden, skip-log, or active surfaced
    activeStock.movies = activeStock.movies.filter((m) => !hardExclusions.has(`movie:${m.id}`));
    activeStock.tv = activeStock.tv.filter((t) => !hardExclusions.has(`tv:${t.id}`));

    for (const m of activeStock.movies) {
      hardExclusions.add(`movie:${m.id}`);
      allSurfacedExclusions.add(`movie:${m.id}`);
    }
    for (const t of activeStock.tv) {
      hardExclusions.add(`tv:${t.id}`);
      allSurfacedExclusions.add(`tv:${t.id}`);
    }

    const cursors: Record<string, number> = { ...(activeStock.cursors || {}) };
    const newlyIndexedCandidates: TmdbItem[] = [];
    const recycledKeysUsed: string[] = [];

    const refillMediaType = async (mediaType: 'movie' | 'tv', currentList: TmdbItem[]) => {
      if (currentList.length >= STOCK_REPLENISH_THRESHOLD) return;
      const shortage = Math.max(0, STOCK_TARGET_COUNT - currentList.length);
      if (shortage <= 0) return;

      const recyclableQueue = surfacedPartition.recyclableExpiredKeys.filter(
        (k) => k.startsWith(`${mediaType}:`) && !hardExclusions.has(k)
      );
      const seenRecyclableMap = new Map<string, TmdbItem>();

      // Pass 1: Strictly fresh items (never surfaced)
      const freshItems = await fetchCandidateBatch(
        mediaType,
        shortage,
        allSurfacedExclusions,
        cursors,
        recyclableQueue.length > 0 ? new Set(recyclableQueue) : undefined,
        seenRecyclableMap
      );
      currentList.push(...freshItems);
      for (const item of freshItems) {
        hardExclusions.add(`${mediaType}:${item.id}`);
      }
      newlyIndexedCandidates.push(...freshItems.slice(0, 60));

      // Pass 2 (Halka-dönüşü / Recycle): Only if fresh sources ran out before reaching target!
      const remainingShortage = Math.max(0, STOCK_TARGET_COUNT - currentList.length);
      if (remainingShortage > 0 && recyclableQueue.length > 0) {
        const toRecycleKeys = recyclableQueue
          .filter((k) => !hardExclusions.has(k))
          .slice(0, remainingShortage);

        for (const recycleKey of toRecycleKeys) {
          if (currentList.length >= STOCK_TARGET_COUNT) break;
          let candidate = seenRecyclableMap.get(recycleKey);
          if (!candidate) {
            const rawId = recycleKey.slice(mediaType.length + 1);
            try {
              const detail = await activeStockFetcher(`/${mediaType}/${rawId}`);
              if (detail && detail.id != null) {
                candidate = normalizeStockCandidate(detail as TmdbItem, mediaType);
              }
            } catch {
              candidate = undefined;
            }
          }
          if (candidate) {
            currentList.push(candidate);
            hardExclusions.add(recycleKey);
            recycledKeysUsed.push(recycleKey);
          }
        }
      }
    };

    await refillMediaType('movie', activeStock.movies);
    await refillMediaType('tv', activeStock.tv);

    if (recycledKeysUsed.length > 0) {
      await markSurfacedKeysRecycled(recycledKeysUsed);
    }

    activeStock.cursors = cursors;
    activeStock.updatedAt = new Date().toISOString();
    await saveStockIdb(activeStock);

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

function normalizeStockCandidate(raw: TmdbItem, mediaType: 'movie' | 'tv'): TmdbItem {
  const topCastIds = extractTopThreeCastIds(raw);
  return {
    ...raw,
    media_type: mediaType,
    ...(topCastIds ? { topCastIds } : {}),
  };
}

function isStockCandidateDateAcceptable(item: TmdbItem): boolean {
  const rawDate = item.release_date || item.first_air_date;
  if (typeof rawDate === 'string' && rawDate.trim()) {
    return isWithinReleaseWindow(rawDate);
  }
  if (item.status === 'Planned' || item.status === 'Rumored') {
    return false;
  }
  return true;
}

async function fetchCandidateBatch(
  mediaType: 'movie' | 'tv',
  targetNeeded: number,
  excludedKeys: Set<string>,
  cursors: Record<string, number>,
  recyclableKeySet?: Set<string>,
  seenRecyclableOut?: Map<string, TmdbItem>
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
          if (!isStockCandidateDateAcceptable(it)) continue;

          const key = `${mediaType}:${it.id}`;
          if (recyclableKeySet?.has(key) && seenRecyclableOut && !seenRecyclableOut.has(key)) {
            seenRecyclableOut.set(key, normalizeStockCandidate(it, mediaType));
          }
          if (excludedKeys.has(key)) continue;

          const normalized = normalizeStockCandidate(it, mediaType);
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

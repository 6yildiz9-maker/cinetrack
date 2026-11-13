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
  type Preferences,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import {
  loadPersistentPoolData,
  savePersistentPoolData,
} from './discovery-storage.ts';
import type { TmdbCastMember, TmdbItem } from '../types/tmdb.ts';
import {
  buildStockExclusionSets,
  dedupeAndPurgeStockList,
  extractTopThreeCastIds,
  isCandidateEligibleForStock,
  normalizeRawStockId,
  resolveItemMediaType,
  type StockCandidateExclusionSets,
} from './stock-filter.ts';
import {
  fetchStockCandidateBatch,
  normalizeStockCandidate,
  type CandidateBatchSkipStats,
  type StockTmdbFetcher,
  type TmdbPagePayload,
} from './stock-batch-fetcher.ts';

export {
  buildStockExclusionSets,
  dedupeAndPurgeStockList,
  isCandidateEligibleForStock,
  type StockCandidateExclusionSets,
  type StockTmdbFetcher,
  type TmdbPagePayload,
};

export const STOCK_TARGET_COUNT = 500;
export const STOCK_REPLENISH_THRESHOLD = 250;
export const MANUAL_STOCK_PULL_BATCH = 40;

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
  lastError?: string | null;
}

let activeStock: StockDepot = { movies: [], tv: [], updatedAt: '', cursors: {} };
let isInitialized = false;
let isReplenishingActive = false;
let lastReplenishmentError: string | null = null;
let replenishmentTimeout: ReturnType<typeof setTimeout> | null = null;
const stockListeners = new Set<(state: StockState) => void>();

let activeReplenishmentPromise: Promise<StockDepot> | null = null;
let manualPullInFlightPromise: Promise<ManualStockPullResult> | null = null;

export function getStockMovies(
  userItems: ReadonlyArray<{ id?: number | string; media_type?: string; name?: string; title?: string }> = [],
  preferences?: { disliked?: ReadonlyArray<string>; hidden?: ReadonlyArray<string> } | null
): TmdbItem[] {
  const sets = buildStockExclusionSets(userItems, preferences);
  return dedupeAndPurgeStockList(activeStock.movies, 'movie', userItems, preferences, sets);
}

export function getStockSeries(
  userItems: ReadonlyArray<{ id?: number | string; media_type?: string; name?: string; title?: string }> = [],
  preferences?: { disliked?: ReadonlyArray<string>; hidden?: ReadonlyArray<string> } | null
): TmdbItem[] {
  const sets = buildStockExclusionSets(userItems, preferences);
  return dedupeAndPurgeStockList(activeStock.tv, 'tv', userItems, preferences, sets);
}

export const stockEngine = {
  getMovies: getStockMovies,
  getSeries: getStockSeries,
};

function buildStockStateSnapshot(): StockState {
  return {
    movies: activeStock.movies,
    tv: activeStock.tv,
    moviesCount: activeStock.movies.length,
    tvCount: activeStock.tv.length,
    isLoading: !isInitialized,
    isReplenishing: isReplenishingActive,
    lastUpdated: activeStock.updatedAt,
    lastError: lastReplenishmentError,
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
  activeReplenishmentPromise = null;
  manualPullInFlightPromise = null;
  lastReplenishmentError = null;
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

export interface EnrichedStockItemPatch {
  cast?: TmdbCastMember[];
  crew?: Array<{ id: number; name: string; job: string; department?: string }>;
  keywords?: Array<{ id: number; name: string }>;
  /** Poster hidrasyonu: TMDB göreli yolu. `null` poster alanını temizler. */
  poster_path?: string | null;
  /** `null` poster adresini kaldırır; göreli yola geçilir. */
  poster_url?: string | null;
  backdrop_path?: string | null;
}

/**
 * Persists lazily enriched metadata (cast, crew, keywords, topCastIds) back into ct:stock
 * so encodings, person insights, and stock health metrics stay enriched across reloads (IMP-11).
 */
export async function updateStockItemsMetadata(
  patchesByMediaKey: Record<string, EnrichedStockItemPatch>
): Promise<number> {
  const keys = Object.keys(patchesByMediaKey);
  if (keys.length === 0) return 0;

  if (!isInitialized) {
    activeStock = await loadStockIdb();
    isInitialized = true;
  }

  let updatedCount = 0;
  const applyPatches = (list: TmdbItem[], mType: 'movie' | 'tv') => {
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      const key = `${mType}:${item.id}`;
      const patch = patchesByMediaKey[key];
      if (!patch) continue;

      let changed = false;
      const nextItem: TmdbItem & { keywords?: Array<{ id: number; name: string }> } = { ...item };

      if (Array.isArray(patch.cast) && patch.cast.length > 0) {
        nextItem.cast = patch.cast;
        const topThree = patch.cast
          .map((c) => Number(c.id))
          .filter((id) => Number.isInteger(id) && id > 0)
          .slice(0, 3);
        if (topThree.length > 0) {
          nextItem.topCastIds = topThree;
        }
        changed = true;
      }
      if (Array.isArray(patch.crew) && patch.crew.length > 0) {
        nextItem.crew = patch.crew;
        changed = true;
      }
      if (Array.isArray(patch.keywords) && patch.keywords.length > 0) {
        nextItem.keywords = patch.keywords;
        changed = true;
      }
      if (patch.poster_path !== undefined) {
        const nextPosterPath =
          typeof patch.poster_path === 'string' && patch.poster_path.length > 0
            ? patch.poster_path
            : null;
        if ((nextItem.poster_path || null) !== nextPosterPath) {
          nextItem.poster_path = nextPosterPath;
          changed = true;
        }
      }
      if (patch.poster_url !== undefined) {
        const nextPosterUrl =
          typeof patch.poster_url === 'string' && patch.poster_url.length > 0
            ? patch.poster_url
            : null;
        if (nextPosterUrl === null) {
          if (nextItem.poster_url !== undefined) {
            delete nextItem.poster_url;
            changed = true;
          }
        } else if (nextItem.poster_url !== nextPosterUrl) {
          nextItem.poster_url = nextPosterUrl;
          changed = true;
        }
      }
      if (patch.backdrop_path !== undefined) {
        const nextBackdrop =
          typeof patch.backdrop_path === 'string' && patch.backdrop_path.length > 0
            ? patch.backdrop_path
            : null;
        if ((nextItem.backdrop_path || null) !== nextBackdrop) {
          nextItem.backdrop_path = nextBackdrop;
          changed = true;
        }
      }

      if (changed) {
        list[i] = nextItem;
        updatedCount += 1;
      }
    }
  };

  applyPatches(activeStock.movies, 'movie');
  applyPatches(activeStock.tv, 'tv');

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

  const rawId = String(item.id).replace(/^(movie|tv)[:-]/, '');
  const mType = resolveItemMediaType(item);
  const targetKey = `${mType}:${rawId}`;

  const isMatch = (it: TmdbItem, expectedType: 'movie' | 'tv') => {
    if (!it || it.id == null) return false;
    const itRaw = String(it.id).replace(/^(movie|tv)[:-]/, '');
    return itRaw === rawId && (mType === expectedType || !item.media_type || `${expectedType}:${itRaw}` === targetKey);
  };

  const prevMovieLen = activeStock.movies.length;
  activeStock.movies = activeStock.movies.filter((it) => !isMatch(it, 'movie'));
  const movieRemoved = activeStock.movies.length !== prevMovieLen;

  const prevTvLen = activeStock.tv.length;
  activeStock.tv = activeStock.tv.filter((it) => !isMatch(it, 'tv'));
  const tvRemoved = activeStock.tv.length !== prevTvLen;

  const removed = movieRemoved || tvRemoved;

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
 * Mevcut ct:stock deposunu kullanıcının aktif listeleri (watching/watchlist/completed),
 * preferences.disliked ve preferences.hidden kayıtlarına göre anında temizler (Sorun 1).
 */
export async function syncStockWithUserExclusions(
  profileId: string,
  userItems: ReadonlyArray<{ id?: number | string; media_type?: string; name?: string; title?: string }>,
  preferences?: { disliked?: ReadonlyArray<string>; hidden?: ReadonlyArray<string> } | null
): Promise<{ purgedMovies: number; purgedTv: number; moviesCount: number; tvCount: number }> {
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

  const sets = buildStockExclusionSets(userItems, preferences);
  const prevMoviesLen = activeStock.movies.length;
  const prevTvLen = activeStock.tv.length;

  activeStock.movies = dedupeAndPurgeStockList(activeStock.movies, 'movie', userItems, preferences, sets);
  activeStock.tv = dedupeAndPurgeStockList(activeStock.tv, 'tv', userItems, preferences, sets);

  const purgedMovies = prevMoviesLen - activeStock.movies.length;
  const purgedTv = prevTvLen - activeStock.tv.length;

  if (purgedMovies > 0 || purgedTv > 0) {
    activeStock.updatedAt = new Date().toISOString();
    await saveStockIdb(activeStock);
    notifyStockListeners();
  }

  if (
    activeStock.movies.length < STOCK_REPLENISH_THRESHOLD ||
    activeStock.tv.length < STOCK_REPLENISH_THRESHOLD
  ) {
    scheduleStockReplenishment(profileId, 300);
  }

  return {
    purgedMovies,
    purgedTv,
    moviesCount: activeStock.movies.length,
    tvCount: activeStock.tv.length,
  };
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
  userListItems?: ReadonlyArray<{ id?: number | string; media_type?: string; name?: string; title?: string }>;
  preferences?: { disliked?: ReadonlyArray<string>; hidden?: ReadonlyArray<string> } | null;
}

export interface ManualStockPullOptions extends ReplenishmentOptions {
  batchSizePerType?: number;
  targetMediaType?: 'all' | 'movie' | 'tv';
}

export interface ManualStockPullResult {
  ok: boolean;
  addedMovies: number;
  addedTv: number;
  skippedListedCount: number;
  skippedDuplicateStockCount: number;
  moviesCount: number;
  tvCount: number;
  error?: string | null;
}

async function prepareStockExecutionContext(profileId: string, options: ReplenishmentOptions) {
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

  const [loadedUserListItems, surfacedPartition, loadedIsolatedProfile, activeSkipKeys] =
    await Promise.all([
      options.userListItems !== undefined
        ? Promise.resolve(options.userListItems)
        : loadUserListsIdb(profileId),
      getSurfacedPartitionForReplenishment(cooldownMs, nowMs),
      options.preferences !== undefined
        ? Promise.resolve({ preferences: options.preferences })
        : loadIsolatedProfileIdb(profileId),
      getActiveSkippedKeys(profileId, undefined, nowMs),
    ]);

  const userListItems =
    options.userListItems !== undefined ? options.userListItems : loadedUserListItems;
  const userPrefs =
    options.preferences !== undefined ? options.preferences : loadedIsolatedProfile?.preferences;
  const eligibilitySets = buildStockExclusionSets(userListItems, userPrefs);

  activeStock.movies = dedupeAndPurgeStockList(
    activeStock.movies,
    'movie',
    userListItems,
    userPrefs,
    eligibilitySets,
    activeSkipKeys
  );
  activeStock.tv = dedupeAndPurgeStockList(
    activeStock.tv,
    'tv',
    userListItems,
    userPrefs,
    eligibilitySets,
    activeSkipKeys
  );

  const userExclusionKeys = new Set<string>([
    ...eligibilitySets.listedKeys,
    ...eligibilitySets.dislikedKeys,
    ...eligibilitySets.hiddenKeys,
    ...activeSkipKeys,
  ]);
  const existingStockKeys = new Set<string>();
  for (const m of activeStock.movies) existingStockKeys.add(`movie:${normalizeRawStockId(m.id)}`);
  for (const t of activeStock.tv) existingStockKeys.add(`tv:${normalizeRawStockId(t.id)}`);

  const stockPurgeExclusions = new Set<string>([...userExclusionKeys, ...existingStockKeys]);
  const hardExclusions = new Set<string>([
    ...stockPurgeExclusions,
    ...surfacedPartition.activeCooldownKeys,
  ]);
  const allSurfacedExclusions = new Set<string>([
    ...hardExclusions,
    ...surfacedPartition.recyclableExpiredKeys,
  ]);

  return {
    userListItems,
    userPrefs,
    eligibilitySets,
    activeSkipKeys,
    surfacedPartition,
    userExclusionKeys,
    existingStockKeys,
    stockPurgeExclusions,
    hardExclusions,
    allSurfacedExclusions,
  };
}

async function finalizeStockMutation(
  cursors: Record<string, number>,
  userListItems: ReadonlyArray<{ id?: number | string; media_type?: string; name?: string; title?: string }>,
  userPrefs: { disliked?: ReadonlyArray<string>; hidden?: ReadonlyArray<string> } | null | undefined,
  eligibilitySets: StockCandidateExclusionSets,
  activeSkipKeys: ReadonlySet<string>,
  newlyIndexedCandidates: TmdbItem[]
): Promise<void> {
  activeStock.movies = dedupeAndPurgeStockList(
    activeStock.movies,
    'movie',
    userListItems,
    userPrefs,
    eligibilitySets,
    activeSkipKeys
  );
  activeStock.tv = dedupeAndPurgeStockList(
    activeStock.tv,
    'tv',
    userListItems,
    userPrefs,
    eligibilitySets,
    activeSkipKeys
  );
  activeStock.cursors = cursors;
  activeStock.updatedAt = new Date().toISOString();

  const saveRes = await saveStockIdb(activeStock);
  if (!saveRes.persisted && saveRes.error) {
    lastReplenishmentError = `Stok IndexedDB kaydı tamamlanamadı: ${saveRes.error}`;
    console.error('[StockEngine] saveStockIdb hatası:', saveRes.error);
  }
  if (newlyIndexedCandidates.length > 0) {
    void indexItemsForSeriesBatch(newlyIndexedCandidates);
  }
}

/**
 * Autonomous stock engine: fills movie and TV depot back to 500 items each whenever
 * either depot is below 250 (or during initial cold fill).
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

  const runPromise = (async (): Promise<StockDepot> => {
    isReplenishingActive = true;
    lastReplenishmentError = null;
    notifyStockListeners();

    try {
      const ctx = await prepareStockExecutionContext(profileId, options);
      const cursors: Record<string, number> = { ...(activeStock.cursors || {}) };
      const newlyIndexedCandidates: TmdbItem[] = [];
      const recycledKeysUsed: string[] = [];

      const refillMediaType = async (mediaType: 'movie' | 'tv', currentList: TmdbItem[]) => {
        if (currentList.length >= STOCK_REPLENISH_THRESHOLD) return;
        const shortage = Math.max(0, STOCK_TARGET_COUNT - currentList.length);
        if (shortage <= 0) return;

        const recyclableQueue = ctx.surfacedPartition.recyclableExpiredKeys.filter(
          (k) => k.startsWith(`${mediaType}:`) && !ctx.hardExclusions.has(k)
        );
        const seenRecyclableMap = new Map<string, TmdbItem>();

        const freshItems = await fetchStockCandidateBatch(
          activeStockFetcher,
          mediaType,
          shortage,
          ctx.allSurfacedExclusions,
          cursors,
          recyclableQueue.length > 0 ? new Set(recyclableQueue) : undefined,
          seenRecyclableMap
        );
        currentList.push(...freshItems);
        for (const item of freshItems) {
          const key = `${mediaType}:${normalizeRawStockId(item.id)}`;
          ctx.existingStockKeys.add(key);
          ctx.stockPurgeExclusions.add(key);
          ctx.hardExclusions.add(key);
        }
        newlyIndexedCandidates.push(...freshItems.slice(0, 60));

        const remainingShortage = Math.max(0, STOCK_TARGET_COUNT - currentList.length);
        if (remainingShortage > 0 && recyclableQueue.length > 0) {
          const toRecycleKeys = recyclableQueue
            .filter((k) => !ctx.hardExclusions.has(k))
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
              ctx.existingStockKeys.add(recycleKey);
              ctx.stockPurgeExclusions.add(recycleKey);
              ctx.hardExclusions.add(recycleKey);
              recycledKeysUsed.push(recycleKey);
            }
          }
        }

        if (currentList.length === 0) {
          const fallbackCursors: Record<string, number> = {};
          const fallbackItems = await fetchStockCandidateBatch(
            activeStockFetcher,
            mediaType,
            shortage,
            ctx.stockPurgeExclusions,
            fallbackCursors
          );
          if (fallbackItems.length > 0) {
            currentList.push(...fallbackItems);
            for (const item of fallbackItems) {
              const key = `${mediaType}:${normalizeRawStockId(item.id)}`;
              ctx.existingStockKeys.add(key);
              ctx.stockPurgeExclusions.add(key);
            }
            newlyIndexedCandidates.push(...fallbackItems.slice(0, 60));
          }
        }
      };

      await refillMediaType('movie', activeStock.movies);
      await refillMediaType('tv', activeStock.tv);

      if (recycledKeysUsed.length > 0) {
        await markSurfacedKeysRecycled(recycledKeysUsed);
      }

      await finalizeStockMutation(
        cursors,
        ctx.userListItems,
        ctx.userPrefs,
        ctx.eligibilitySets,
        ctx.activeSkipKeys,
        newlyIndexedCandidates
      );
    } catch (err) {
      lastReplenishmentError =
        err instanceof Error ? err.message : 'Stok doldurma sırasında beklenmeyen bir hata oluştu.';
      console.error('[StockEngine] Stok doldurma hatası:', err);
    } finally {
      isReplenishingActive = false;
      activeReplenishmentPromise = null;
      notifyStockListeners();
    }

    return activeStock;
  })();

  activeReplenishmentPromise = runPromise;
  return runPromise;
}

/**
 * Manuel Stok Çekme (Kullanıcı tetiklemeli):
 * Mevcut stok sayısı >= 250 veya >= 500 olsa bile TMDB'den sıradaki sayfalardan yeni adaylar çeker.
 * Çekilen içerikler kullanıcının listelerinde (watching, watchlist, completed), disliked/hidden
 * kayıtlarında VEYA halihazırda ct:stock havuzunda varsa kesinlikle tekrar stok listesine kaydetmez.
 */
export async function manualPullStock(
  profileId: string,
  options: ManualStockPullOptions = {}
): Promise<ManualStockPullResult> {
  if (manualPullInFlightPromise) {
    return manualPullInFlightPromise;
  }

  const runManual = (async (): Promise<ManualStockPullResult> => {
    if (activeReplenishmentPromise) {
      try {
        await activeReplenishmentPromise;
      } catch {
        // Ignore autonomous error and proceed with manual pull
      }
    }
    if (replenishmentTimeout) {
      clearTimeout(replenishmentTimeout);
      replenishmentTimeout = null;
    }

    isReplenishingActive = true;
    lastReplenishmentError = null;
    notifyStockListeners();

    let addedMovies = 0;
    let addedTv = 0;
    let skippedListedCount = 0;
    let skippedDuplicateStockCount = 0;

    try {
      const ctx = await prepareStockExecutionContext(profileId, options);
      const beforeMoviesCount = activeStock.movies.length;
      const beforeTvCount = activeStock.tv.length;

      const skipStats: CandidateBatchSkipStats = {
        userExclusionKeys: ctx.userExclusionKeys,
        existingStockKeys: ctx.existingStockKeys,
        skippedListedCount: 0,
        skippedDuplicateStockCount: 0,
      };

      const cursors: Record<string, number> = { ...(activeStock.cursors || {}) };
      const newlyIndexedCandidates: TmdbItem[] = [];
      const batchSize = Math.max(1, options.batchSizePerType ?? MANUAL_STOCK_PULL_BATCH);
      const targetMediaType = options.targetMediaType || 'all';

      const pullForMediaType = async (mediaType: 'movie' | 'tv', currentList: TmdbItem[]) => {
        const targetNeeded =
          currentList.length === 0
            ? STOCK_TARGET_COUNT
            : currentList.length < STOCK_TARGET_COUNT
              ? Math.max(batchSize, STOCK_TARGET_COUNT - currentList.length)
              : batchSize;

        const passOne = await fetchStockCandidateBatch(
          activeStockFetcher,
          mediaType,
          targetNeeded,
          ctx.allSurfacedExclusions,
          cursors,
          undefined,
          undefined,
          skipStats
        );
        const collected: TmdbItem[] = [...passOne];
        for (const item of passOne) {
          const key = `${mediaType}:${normalizeRawStockId(item.id)}`;
          ctx.existingStockKeys.add(key);
          ctx.stockPurgeExclusions.add(key);
          ctx.allSurfacedExclusions.add(key);
        }

        if (collected.length < targetNeeded) {
          const passTwo = await fetchStockCandidateBatch(
            activeStockFetcher,
            mediaType,
            targetNeeded - collected.length,
            ctx.stockPurgeExclusions,
            cursors,
            undefined,
            undefined,
            skipStats
          );
          for (const item of passTwo) {
            const key = `${mediaType}:${normalizeRawStockId(item.id)}`;
            ctx.existingStockKeys.add(key);
            ctx.stockPurgeExclusions.add(key);
            collected.push(item);
          }
        }

        if (collected.length > 0) {
          currentList.push(...collected);
          newlyIndexedCandidates.push(...collected.slice(0, 60));
        }
      };

      if (targetMediaType === 'all' || targetMediaType === 'movie') {
        await pullForMediaType('movie', activeStock.movies);
      }
      if (targetMediaType === 'all' || targetMediaType === 'tv') {
        await pullForMediaType('tv', activeStock.tv);
      }

      await finalizeStockMutation(
        cursors,
        ctx.userListItems,
        ctx.userPrefs,
        ctx.eligibilitySets,
        ctx.activeSkipKeys,
        newlyIndexedCandidates
      );

      addedMovies = Math.max(0, activeStock.movies.length - beforeMoviesCount);
      addedTv = Math.max(0, activeStock.tv.length - beforeTvCount);
      skippedListedCount = skipStats.skippedListedCount;
      skippedDuplicateStockCount = skipStats.skippedDuplicateStockCount;
    } catch (err) {
      lastReplenishmentError =
        err instanceof Error ? err.message : 'Manuel stok çekme sırasında beklenmeyen bir hata oluştu.';
      console.error('[StockEngine] Manuel stok çekme hatası:', err);
    } finally {
      isReplenishingActive = false;
      manualPullInFlightPromise = null;
      notifyStockListeners();
    }

    return {
      ok: !lastReplenishmentError,
      addedMovies,
      addedTv,
      skippedListedCount,
      skippedDuplicateStockCount,
      moviesCount: activeStock.movies.length,
      tvCount: activeStock.tv.length,
      error: lastReplenishmentError,
    };
  })();

  manualPullInFlightPromise = runManual;
  return runManual;
}

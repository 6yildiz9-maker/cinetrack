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
import { getItemEncodingSync } from './encoding-service.ts';
import { cosineSimilarity } from '../core/encoding.ts';

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
  lastError?: string | null;
}

let activeStock: StockDepot = { movies: [], tv: [], updatedAt: '', cursors: {} };
let isInitialized = false;
let isReplenishingActive = false;
let lastReplenishmentError: string | null = null;
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

export interface StockCandidateExclusionSets {
  listedKeys: ReadonlySet<string>;
  dislikedKeys: ReadonlySet<string>;
  hiddenKeys: ReadonlySet<string>;
  existingStockKeys?: ReadonlySet<string>;
}

export function buildStockExclusionSets(
  userItems: ReadonlyArray<{ id?: number | string; media_type?: string; name?: string; title?: string }> = [],
  preferences?: { disliked?: ReadonlyArray<string>; hidden?: ReadonlyArray<string> } | null,
  existingStockKeys?: ReadonlySet<string>
): StockCandidateExclusionSets {
  const listedKeys = new Set<string>();
  for (const it of userItems) {
    if (!it || it.id == null) continue;
    const mType = resolveItemMediaType(it);
    const rawId = String(it.id).replace(/^(movie|tv)[:-]/, '');
    listedKeys.add(`${mType}:${rawId}`);
    listedKeys.add(`${mType}-${rawId}`);
    listedKeys.add(rawId);
    listedKeys.add(String(it.id));
  }
  const dislikedKeys = new Set<string>();
  for (const d of preferences?.disliked || []) {
    if (!d) continue;
    dislikedKeys.add(d);
    const raw = String(d).replace(/^(movie|tv)[:-]/, '');
    dislikedKeys.add(raw);
    dislikedKeys.add(`movie:${raw}`);
    dislikedKeys.add(`tv:${raw}`);
  }
  const hiddenKeys = new Set<string>();
  for (const h of preferences?.hidden || []) {
    if (!h) continue;
    hiddenKeys.add(h);
    const raw = String(h).replace(/^(movie|tv)[:-]/, '');
    hiddenKeys.add(raw);
    hiddenKeys.add(`movie:${raw}`);
    hiddenKeys.add(`tv:${raw}`);
  }
  return {
    listedKeys,
    dislikedKeys,
    hiddenKeys,
    existingStockKeys,
  };
}

/**
 * Bir aday içeriğin ct:stock havuzuna girip giremeyeceğini kontrol eder (Sorun 1 & TP-018):
 * 1. Kullanıcının listelerinde (watching, watchlist, completed) varsa -> false
 * 2. İlgilenmiyorum (preferences.disliked — negatif sinyal, TP-018) listesindeyse -> false
 * 3. Gizlenenler (preferences.hidden — nötr dışlama, TP-018) listesindeyse -> false
 * 4. Zaten stoktaysa (çift kayıt önleme) -> false
 */
export function isCandidateEligibleForStock(
  candidate: { id?: number | string; media_type?: string; name?: string; title?: string } | null | undefined,
  userItems: ReadonlyArray<{ id?: number | string; media_type?: string; name?: string; title?: string }> = [],
  preferences?: { disliked?: ReadonlyArray<string>; hidden?: ReadonlyArray<string> } | null,
  existingStockKeys?: ReadonlySet<string>,
  precomputedSets?: StockCandidateExclusionSets
): boolean {
  if (!candidate || candidate.id == null) return false;
  const mediaType = resolveItemMediaType(candidate);
  const rawId = String(candidate.id).replace(/^(movie|tv)[:-]/, '');
  const contentId = `${mediaType}:${rawId}`;

  if (precomputedSets) {
    if (precomputedSets.listedKeys.has(contentId) || precomputedSets.listedKeys.has(rawId)) return false;
    if (precomputedSets.dislikedKeys.has(contentId) || precomputedSets.dislikedKeys.has(rawId)) return false;
    if (precomputedSets.hiddenKeys.has(contentId) || precomputedSets.hiddenKeys.has(rawId)) return false;
    if (precomputedSets.existingStockKeys?.has(contentId) || precomputedSets.existingStockKeys?.has(rawId)) return false;
    if (existingStockKeys?.has(contentId) || existingStockKeys?.has(rawId)) return false;
    return true;
  }

  // 1. Kullanıcının listelerinde (watching, watchlist, completed) var mı?
  const isListed = userItems.some((it) => {
    if (!it || it.id == null) return false;
    const itRaw = String(it.id).replace(/^(movie|tv)[:-]/, '');
    return itRaw === rawId || `${resolveItemMediaType(it)}:${itRaw}` === contentId;
  });
  if (isListed) return false;

  // 2. İlgilenmiyorum (disliked — negatif sinyal, TP-018) listesinde mi?
  if (preferences?.disliked?.some((d) => d === contentId || String(d).replace(/^(movie|tv)[:-]/, '') === rawId)) return false;

  // 3. Gizlenenler (hidden — nötr dışlama, TP-018) listesinde mi?
  if (preferences?.hidden?.some((h) => h === contentId || String(h).replace(/^(movie|tv)[:-]/, '') === rawId)) return false;

  // 4. Zaten stokta mı? (Çift kayıt önleme)
  if (existingStockKeys?.has(contentId) || existingStockKeys?.has(rawId)) return false;

  return true;
}

export function getStockMovies(
  userItems: ReadonlyArray<{ id?: number | string; media_type?: string; name?: string; title?: string }> = [],
  preferences?: { disliked?: ReadonlyArray<string>; hidden?: ReadonlyArray<string> } | null
): TmdbItem[] {
  const sets = buildStockExclusionSets(userItems, preferences);
  return activeStock.movies.filter((m) =>
    isCandidateEligibleForStock({ ...m, media_type: 'movie' }, userItems, preferences, undefined, sets)
  );
}

export function getStockSeries(
  userItems: ReadonlyArray<{ id?: number | string; media_type?: string; name?: string; title?: string }> = [],
  preferences?: { disliked?: ReadonlyArray<string>; hidden?: ReadonlyArray<string> } | null
): TmdbItem[] {
  const sets = buildStockExclusionSets(userItems, preferences);
  return activeStock.tv.filter((t) =>
    isCandidateEligibleForStock({ ...t, media_type: 'tv' }, userItems, preferences, undefined, sets)
  );
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

  activeStock.movies = activeStock.movies.filter((m) =>
    isCandidateEligibleForStock({ ...m, media_type: 'movie' }, userItems, preferences, undefined, sets)
  );
  activeStock.tv = activeStock.tv.filter((t) =>
    isCandidateEligibleForStock({ ...t, media_type: 'tv' }, userItems, preferences, undefined, sets)
  );

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

/**
 * Autonomous stock engine: fills movie and TV depot back to 500 items each whenever
 * either depot is below 250 (or during initial cold fill).
 * Excludes user-lists, disliked/hidden, active ct:skip-log, active-cooldown ct:surfaced, and current stock IDs.
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
  lastReplenishmentError = null;
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

    const [loadedUserListItems, surfacedPartition, loadedIsolatedProfile, activeSkipKeys] = await Promise.all([
      options.userListItems && options.userListItems.length > 0
        ? Promise.resolve(options.userListItems)
        : loadUserListsIdb(profileId),
      getSurfacedPartitionForReplenishment(cooldownMs, nowMs),
      options.preferences
        ? Promise.resolve({ preferences: options.preferences })
        : loadIsolatedProfileIdb(profileId),
      getActiveSkippedKeys(profileId, undefined, nowMs),
    ]);

    const userListItems = options.userListItems && options.userListItems.length > 0 ? options.userListItems : loadedUserListItems;
    const userPrefs = options.preferences || loadedIsolatedProfile?.preferences;
    const eligibilitySets = buildStockExclusionSets(userListItems, userPrefs);
    const stockPurgeExclusions = new Set<string>([
      ...eligibilitySets.listedKeys,
      ...eligibilitySets.dislikedKeys,
      ...eligibilitySets.hiddenKeys,
      ...activeSkipKeys,
    ]);

    // Purge stock items if saved/disliked/hidden/skipped
    activeStock.movies = activeStock.movies.filter(
      (m) =>
        isCandidateEligibleForStock({ ...m, media_type: 'movie' }, userListItems, userPrefs, undefined, eligibilitySets) &&
        !activeSkipKeys.has(`movie:${m.id}`)
    );
    activeStock.tv = activeStock.tv.filter(
      (t) =>
        isCandidateEligibleForStock({ ...t, media_type: 'tv' }, userListItems, userPrefs, undefined, eligibilitySets) &&
        !activeSkipKeys.has(`tv:${t.id}`)
    );

    // Hard exclusions for Pass 1 & Pass 2 incoming candidates (includes active 7d surfaced cooldown)
    const hardExclusions = new Set<string>([
      ...stockPurgeExclusions,
      ...surfacedPartition.activeCooldownKeys,
    ]);

    const allSurfacedExclusions = new Set<string>([
      ...hardExclusions,
      ...surfacedPartition.recyclableExpiredKeys,
    ]);

    for (const m of activeStock.movies) {
      stockPurgeExclusions.add(`movie:${m.id}`);
      hardExclusions.add(`movie:${m.id}`);
      allSurfacedExclusions.add(`movie:${m.id}`);
    }
    for (const t of activeStock.tv) {
      stockPurgeExclusions.add(`tv:${t.id}`);
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
        const key = `${mediaType}:${item.id}`;
        stockPurgeExclusions.add(key);
        hardExclusions.add(key);
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
            stockPurgeExclusions.add(recycleKey);
            hardExclusions.add(recycleKey);
            recycledKeysUsed.push(recycleKey);
          }
        }
      }

      // Pass 3 (REG-01 Constrained / Demo Catalog Fallback):
      // If the depot is still completely empty (0 items) because all items in a small/demo catalog
      // were recently surfaced on Trending, populate non-listed, non-disliked items so Stok is never 0/0.
      if (currentList.length === 0) {
        const fallbackCursors: Record<string, number> = {};
        const fallbackItems = await fetchCandidateBatch(
          mediaType,
          shortage,
          stockPurgeExclusions,
          fallbackCursors
        );
        if (fallbackItems.length > 0) {
          currentList.push(...fallbackItems);
          for (const item of fallbackItems) {
            stockPurgeExclusions.add(`${mediaType}:${item.id}`);
          }
          newlyIndexedCandidates.push(...fallbackItems.slice(0, 60));
        }
      }
    };

    await refillMediaType('movie', activeStock.movies);
    await refillMediaType('tv', activeStock.tv);

    // Kayıt aşamasında kesin arındırma: listelerdeki yapımlar asla stoğu işgal edemez
    activeStock.movies = activeStock.movies.filter((m) =>
      isCandidateEligibleForStock({ ...m, media_type: 'movie' }, userListItems, userPrefs, undefined, eligibilitySets)
    );
    activeStock.tv = activeStock.tv.filter((t) =>
      isCandidateEligibleForStock({ ...t, media_type: 'tv' }, userListItems, userPrefs, undefined, eligibilitySets)
    );

    if (recycledKeysUsed.length > 0) {
      await markSurfacedKeysRecycled(recycledKeysUsed);
    }

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
  } catch (err) {
    lastReplenishmentError =
      err instanceof Error ? err.message : 'Stok doldurma sırasında beklenmeyen bir hata oluştu.';
    console.error('[StockEngine] Stok doldurma hatası:', err);
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
  if (typeof rawDate === 'string' && rawDate.trim()) return isWithinReleaseWindow(rawDate);
  return item.status !== 'Planned' && item.status !== 'Rumored';
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
  const overflowClusterBuffer: TmdbItem[] = [];
  const recentVectors: number[][] = [];
  const MAX_RECENT_VECTORS = 25;
  const CLUSTER_SIMILARITY_THRESHOLD = 0.88;

  const endpoints: Array<{ cursorKey: string; path: string; params?: Record<string, string>; maxPages: number }> = [
    { cursorKey: `${mediaType}:popular`, path: `/${mediaType}/popular`, maxPages: 20 },
    { cursorKey: `${mediaType}:top_rated`, path: `/${mediaType}/top_rated`, maxPages: 20 },
    { cursorKey: `${mediaType}:discover_pop`, path: `/discover/${mediaType}`, params: { sort_by: 'popularity.desc', 'vote_count.gte': '80' }, maxPages: 25 },
    { cursorKey: `${mediaType}:discover_vote`, path: `/discover/${mediaType}`, params: { sort_by: 'vote_average.desc', 'vote_count.gte': '250' }, maxPages: 20 },
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
          if (!it || it.id == null || !isStockCandidateDateAcceptable(it)) continue;
          const key = `${mediaType}:${it.id}`;
          const rawId = String(it.id).replace(/^(movie|tv)[:-]/, '');
          if (recyclableKeySet?.has(key) && seenRecyclableOut && !seenRecyclableOut.has(key)) {
            seenRecyclableOut.set(key, normalizeStockCandidate(it, mediaType));
          }
          if (
            excludedKeys.has(key) ||
            excludedKeys.has(rawId) ||
            excludedKeys.has(`${mediaType}:${rawId}`)
          ) {
            continue;
          }

          const normalized = normalizeStockCandidate(it, mediaType);
          excludedKeys.add(key);
          excludedKeys.add(rawId);

          // IMP-01: MMR diversity filtering
          const candEnc = getItemEncodingSync(normalized);
          let isTooSimilar = false;
          if (recentVectors.length > 0 && candEnc?.denseVector?.length) {
            for (const v of recentVectors) {
              const sim = cosineSimilarity(v, candEnc.denseVector);
              if (sim > CLUSTER_SIMILARITY_THRESHOLD) {
                isTooSimilar = true;
                break;
              }
            }
          }

          if (isTooSimilar) {
            overflowClusterBuffer.push(normalized);
          } else {
            result.push(normalized);
            if (candEnc?.denseVector?.length) {
              recentVectors.push(candEnc.denseVector);
              if (recentVectors.length > MAX_RECENT_VECTORS) {
                recentVectors.shift();
              }
            }
            addedFromPage += 1;
          }

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

  // Quota discipline: if diversity filter was strict and result < targetNeeded, backfill from overflow
  if (result.length < targetNeeded && overflowClusterBuffer.length > 0) {
    for (const overflowItem of overflowClusterBuffer) {
      if (result.length >= targetNeeded) break;
      result.push(overflowItem);
    }
  }

  return result;
}

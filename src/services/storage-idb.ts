import { get, set, del, createStore, type UseStore } from 'idb-keyval';
import type { TmdbItem } from '../types/tmdb.ts';
import type { SavedItem, Preferences, FavoriteActorInfo } from '../core/cinetrack-core.ts';
import {
  type IdbWriteResult,
  recordDepotWriteOutcome,
  isDepotKeyUnpersisted,
  isForceIdbWriteFailureActive,
  resetClientDepotsForTests,
} from './client-depots.ts';

export * from './client-depots.ts';

// Check IndexedDB availability (browser vs Node.js test environment)
export const isIndexedDBAvailable = (): boolean => {
  return typeof indexedDB !== 'undefined';
};

// Custom IndexedDB store references (1 dedicated DB per store to prevent upgrade collisions)
let stockStore: UseStore | undefined;
let surfacedStore: UseStore | undefined;
let seriesIndexStore: UseStore | undefined;
let userListsStore: UseStore | undefined;
let profileStore: UseStore | undefined;
let offlineQueueStore: UseStore | undefined;

function getStore(name: string): UseStore | undefined {
  if (!isIndexedDBAvailable()) return undefined;
  switch (name) {
    case 'ct_stock':
      if (!stockStore) stockStore = createStore('cinetrack-stock-db', 'ct_stock');
      return stockStore;
    case 'ct_surfaced':
      if (!surfacedStore) surfacedStore = createStore('cinetrack-surfaced-db', 'ct_surfaced');
      return surfacedStore;
    case 'ct_series_index':
      if (!seriesIndexStore) seriesIndexStore = createStore('cinetrack-series-index-db', 'ct_series_index');
      return seriesIndexStore;
    case 'ct_user_lists':
      if (!userListsStore) userListsStore = createStore('cinetrack-user-lists-db', 'ct_user_lists');
      return userListsStore;
    case 'ct_profile':
      if (!profileStore) profileStore = createStore('cinetrack-profile-db', 'ct_profile');
      return profileStore;
    case 'ct_offline_queue':
      if (!offlineQueueStore) offlineQueueStore = createStore('cinetrack-offline-queue-db', 'ct_offline_queue');
      return offlineQueueStore;
    default:
      return undefined;
  }
}

// In-memory fallbacks for Node / test runners / disabled IDB
const memoryFallback = new Map<string, unknown>();

async function safeIdbGet<T>(storeName: string, key: string): Promise<T | null> {
  const composite = `${storeName}:${key}`;
  if (isDepotKeyUnpersisted(composite) && memoryFallback.has(composite)) {
    return memoryFallback.get(composite) as T;
  }
  const store = getStore(storeName);
  if (store) {
    try {
      const val = await get<T>(key, store);
      if (val !== undefined) {
        memoryFallback.set(composite, val);
        return val;
      }
      return null;
    } catch (e) {
      console.warn(`[IDB] Read failed for ${storeName}/${key}:`, e);
    }
  }
  const mem = memoryFallback.get(composite);
  return mem !== undefined ? (mem as T) : null;
}

async function safeIdbSet<T>(storeName: string, key: string, value: T): Promise<IdbWriteResult> {
  const composite = `${storeName}:${key}`;
  memoryFallback.set(composite, value);

  if (isForceIdbWriteFailureActive()) {
    return recordDepotWriteOutcome(composite, false, 'Simulated QuotaExceededError');
  }

  const store = getStore(storeName);
  if (store) {
    try {
      await set(key, value, store);
      return recordDepotWriteOutcome(composite, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[IDB] Write failed for ${storeName}/${key}:`, e);
      return recordDepotWriteOutcome(composite, false, msg);
    }
  }

  if (typeof window !== 'undefined') {
    return recordDepotWriteOutcome(composite, false, 'IndexedDB kullanılamıyor');
  }
  return { persisted: true };
}

export async function safeIdbDel(storeName: string, key: string): Promise<IdbWriteResult> {
  const composite = `${storeName}:${key}`;
  memoryFallback.delete(composite);

  if (isForceIdbWriteFailureActive()) {
    return recordDepotWriteOutcome(composite, false, 'Simulated QuotaExceededError');
  }

  const store = getStore(storeName);
  if (store) {
    try {
      await del(key, store);
      return recordDepotWriteOutcome(composite, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[IDB] Del failed for ${storeName}/${key}:`, e);
      return recordDepotWriteOutcome(composite, false, msg);
    }
  }
  return { persisted: true };
}

// ==========================================
// 1. ct:profile (Tema, DNA, Tercihler)
// ==========================================
export interface IsolatedProfileRecord {
  profileId: string;
  name: string;
  theme?: string;
  dna?: unknown;
  preferences: Preferences;
  favoriteActors?: FavoriteActorInfo[];
  updatedAt: string;
}

export async function loadIsolatedProfileIdb(profileId: string): Promise<IsolatedProfileRecord | null> {
  return safeIdbGet<IsolatedProfileRecord>('ct_profile', `profile:${profileId}`);
}

export async function saveIsolatedProfileIdb(profile: IsolatedProfileRecord): Promise<IdbWriteResult> {
  return safeIdbSet('ct_profile', `profile:${profile.profileId}`, profile);
}

// ==========================================
// 2. ct:user-lists (Sadece ID'ler ve durumlar)
// ==========================================
export interface UserListItemCompact {
  id: number | string;
  media_type: 'movie' | 'tv';
  status: 'watching' | 'watchlist' | 'completed';
  personal_rating: number | '';
  addedAt?: string;
  updatedAt?: string;
  custom?: boolean;
  current_season?: number;
  episodes_watched?: number;
  season_progress?: Record<number, number>;
}

interface RawUserListCandidate {
  id: number | string;
  media_type?: string;
  status?: string;
  personal_rating?: number | '';
  addedAt?: string;
  updatedAt?: string;
  custom?: boolean;
  current_season?: number;
  episodes_watched?: number;
  season_progress?: Record<number, number>;
}

export function toCompactUserListItem(
  item: SavedItem | UserListItemCompact | RawUserListCandidate
): UserListItemCompact {
  const mediaType: 'movie' | 'tv' = item.media_type === 'tv' ? 'tv' : 'movie';
  const status: 'watching' | 'watchlist' | 'completed' =
    item.status === 'watching' || item.status === 'completed' ? item.status : 'watchlist';
  const compact: UserListItemCompact = {
    id: item.id,
    media_type: mediaType,
    status,
    personal_rating:
      typeof item.personal_rating === 'number' && Number.isFinite(item.personal_rating)
        ? item.personal_rating
        : '',
  };
  if (item.addedAt) compact.addedAt = String(item.addedAt);
  if (item.updatedAt) compact.updatedAt = String(item.updatedAt);
  if (item.custom) compact.custom = true;
  if (typeof item.current_season === 'number') compact.current_season = item.current_season;
  if (typeof item.episodes_watched === 'number') compact.episodes_watched = item.episodes_watched;
  if (item.season_progress && typeof item.season_progress === 'object') {
    compact.season_progress = item.season_progress;
  }
  return compact;
}

export async function loadUserListsIdb(profileId: string): Promise<UserListItemCompact[]> {
  const data = await safeIdbGet<UserListItemCompact[]>('ct_user_lists', `lists:${profileId}`);
  return Array.isArray(data) ? data.map(toCompactUserListItem) : [];
}

export async function saveUserListsWithStatusIdb(
  profileId: string,
  items: Array<SavedItem | UserListItemCompact | RawUserListCandidate>
): Promise<IdbWriteResult & { items: UserListItemCompact[] }> {
  const compactList = (Array.isArray(items) ? items : [])
    .filter((it) => it && it.id != null)
    .map(toCompactUserListItem);
  const res = await safeIdbSet('ct_user_lists', `lists:${profileId}`, compactList);
  return { ...res, items: compactList };
}

export async function saveUserListsIdb(
  profileId: string,
  items: Array<SavedItem | UserListItemCompact | RawUserListCandidate>
): Promise<UserListItemCompact[]> {
  const out = await saveUserListsWithStatusIdb(profileId, items);
  return out.items;
}

// ==========================================
// 3. ct:stock (500 Film & 500 Dizi Deposu)
// ==========================================
export interface StockDepot {
  movies: TmdbItem[];
  tv: TmdbItem[];
  updatedAt: string;
  cursors?: Record<string, number>;
}

export async function loadStockIdb(): Promise<StockDepot> {
  const data = await safeIdbGet<StockDepot>('ct_stock', 'stock_main');
  if (data && Array.isArray(data.movies) && Array.isArray(data.tv)) {
    return data;
  }
  return { movies: [], tv: [], updatedAt: '', cursors: {} };
}

export async function saveStockIdb(stock: StockDepot): Promise<IdbWriteResult> {
  return safeIdbSet('ct_stock', 'stock_main', stock);
}

// ==========================================
// 4. ct:surfaced (Gösterim Geçmişi - FIFO + Halka-Dönüşü Cooldown)
// ==========================================
export const SURFACED_FIFO_MAX_SIZE = 1000;
export const SURFACED_RECYCLE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 gün cooldown

export interface SurfacedEntry {
  key: string;
  surfacedAt: number;
}

let inMemorySurfacedMap = new Map<string, number>(); // key -> surfacedAt (insertion-ordered FIFO)
let isSurfacedLoaded = false;

export async function loadSurfacedEntries(): Promise<SurfacedEntry[]> {
  const [entriesData, legacyKeys] = await Promise.all([
    safeIdbGet<SurfacedEntry[]>('ct_surfaced', 'surfaced_entries'),
    safeIdbGet<string[]>('ct_surfaced', 'surfaced_keys'),
  ]);

  const nextMap = new Map<string, number>();
  const fallbackTs = Date.now();

  if (Array.isArray(entriesData) && entriesData.length > 0) {
    for (const entry of entriesData) {
      if (entry && typeof entry.key === 'string' && entry.key) {
        nextMap.set(entry.key, typeof entry.surfacedAt === 'number' ? entry.surfacedAt : fallbackTs);
      }
    }
  } else if (Array.isArray(legacyKeys)) {
    for (const k of legacyKeys) {
      if (typeof k === 'string' && k) {
        nextMap.set(k, fallbackTs);
      }
    }
  }

  inMemorySurfacedMap = nextMap;
  isSurfacedLoaded = true;
  return Array.from(inMemorySurfacedMap.entries()).map(([key, surfacedAt]) => ({
    key,
    surfacedAt,
  }));
}

export async function loadSurfacedKeys(): Promise<string[]> {
  const entries = await loadSurfacedEntries();
  return entries.map((e) => e.key);
}

async function persistSurfacedMap(): Promise<IdbWriteResult> {
  const entries: SurfacedEntry[] = Array.from(inMemorySurfacedMap.entries()).map(
    ([key, surfacedAt]) => ({ key, surfacedAt })
  );
  const keys = entries.map((e) => e.key);
  const [r1, r2] = await Promise.all([
    safeIdbSet('ct_surfaced', 'surfaced_entries', entries),
    safeIdbSet('ct_surfaced', 'surfaced_keys', keys),
  ]);
  return !r1.persisted ? r1 : r2;
}

export async function recordSurfacedKeysWithStatus(
  keys: string[],
  maxSize: number = SURFACED_FIFO_MAX_SIZE,
  nowMs: number = Date.now()
): Promise<IdbWriteResult & { keys: string[] }> {
  if (!isSurfacedLoaded) {
    await loadSurfacedEntries();
  }

  const effectiveCap = Math.max(1, Math.floor(maxSize));
  let changed = false;

  for (const k of keys) {
    if (!k || inMemorySurfacedMap.has(k)) continue;
    inMemorySurfacedMap.set(k, nowMs);
    changed = true;
  }

  if (inMemorySurfacedMap.size > effectiveCap) {
    const overflow = inMemorySurfacedMap.size - effectiveCap;
    const iter = inMemorySurfacedMap.keys();
    for (let i = 0; i < overflow; i += 1) {
      const oldest = iter.next();
      if (!oldest.done) {
        inMemorySurfacedMap.delete(oldest.value);
      }
    }
    changed = true;
  }

  let writeRes: IdbWriteResult = { persisted: true };
  if (changed) {
    writeRes = await persistSurfacedMap();
  }
  return { ...writeRes, keys: Array.from(inMemorySurfacedMap.keys()) };
}

export async function recordSurfacedKeys(
  keys: string[],
  maxSize: number = SURFACED_FIFO_MAX_SIZE,
  nowMs: number = Date.now()
): Promise<string[]> {
  const res = await recordSurfacedKeysWithStatus(keys, maxSize, nowMs);
  return res.keys;
}

export async function removeSurfacedKey(mediaKey: string): Promise<IdbWriteResult> {
  if (!mediaKey) return { persisted: true };
  if (!isSurfacedLoaded) {
    await loadSurfacedEntries();
  }
  if (!inMemorySurfacedMap.has(mediaKey)) return { persisted: true };
  inMemorySurfacedMap.delete(mediaKey);
  return persistSurfacedMap();
}

/**
 * Partitions ct:surfaced into active-cooldown keys (strictly excluded) vs expired-cooldown keys
 * (FIFO oldest-first, eligible for Halka-dönüşü recycle ONLY when fresh TMDB candidates run short).
 */
export async function getSurfacedPartitionForReplenishment(
  cooldownMs: number = SURFACED_RECYCLE_COOLDOWN_MS,
  nowMs: number = Date.now()
): Promise<{ activeCooldownKeys: string[]; recyclableExpiredKeys: string[] }> {
  const entries = await loadSurfacedEntries();
  const activeCooldownKeys: string[] = [];
  const expiredWithTs: SurfacedEntry[] = [];

  for (const entry of entries) {
    if (nowMs - entry.surfacedAt >= cooldownMs) {
      expiredWithTs.push(entry);
    } else {
      activeCooldownKeys.push(entry.key);
    }
  }

  // Oldest surfaced first (FIFO recycle order)
  expiredWithTs.sort((a, b) => a.surfacedAt - b.surfacedAt);
  return {
    activeCooldownKeys,
    recyclableExpiredKeys: expiredWithTs.map((e) => e.key),
  };
}

/**
 * Removes recycled keys from ct:surfaced when they are admitted back into ct:stock
 * so they can be surfaced fresh in a future Discover cycle.
 */
export async function markSurfacedKeysRecycled(recycledKeys: string[]): Promise<IdbWriteResult> {
  if (!recycledKeys.length) return { persisted: true };
  if (!isSurfacedLoaded) {
    await loadSurfacedEntries();
  }
  let changed = false;
  for (const key of recycledKeys) {
    if (inMemorySurfacedMap.delete(key)) {
      changed = true;
    }
  }
  return changed ? persistSurfacedMap() : { persisted: true };
}

export function isItemSurfacedSync(mediaKey: string): boolean {
  return inMemorySurfacedMap.has(mediaKey);
}

export async function isItemSurfaced(mediaKey: string): Promise<boolean> {
  if (!isSurfacedLoaded) {
    await loadSurfacedEntries();
  }
  return inMemorySurfacedMap.has(mediaKey);
}

// ==========================================
// 5. ct:series-index (Seri / Franchise İndeksi)
// ==========================================
export interface SeriesCollectionPart {
  id: number | string;
  media_type: 'movie' | 'tv';
  title: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
  genre_ids?: number[];
  overview?: string;
  order?: number;
}

export interface SeriesCollection {
  id: number | string;
  name: string;
  media_type: 'movie' | 'tv';
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  parts: SeriesCollectionPart[];
  partKeys: string[];
  sourceItemKey?: string;
  isStub?: boolean;
}

export interface SeriesIndexData {
  collections: Record<string, SeriesCollection>;
  mediaKeyToSeries: Record<string, string>;
  checkedMediaKeys?: Record<string, number>;
  updatedAt: string;
}

let inMemorySeriesIndex: SeriesIndexData = {
  collections: {},
  mediaKeyToSeries: {},
  checkedMediaKeys: {},
  updatedAt: '',
};
let isSeriesIndexLoaded = false;
const seriesIndexListeners = new Set<(data: SeriesIndexData) => void>();

function notifySeriesIndexListeners(): void {
  for (const listener of seriesIndexListeners) {
    try {
      listener(inMemorySeriesIndex);
    } catch (err) {
      console.warn('[IDB] SeriesIndex listener error:', err);
    }
  }
}

export function subscribeSeriesIndex(listener: (data: SeriesIndexData) => void): () => void {
  seriesIndexListeners.add(listener);
  return () => {
    seriesIndexListeners.delete(listener);
  };
}

export async function loadSeriesIndexIdb(): Promise<SeriesIndexData> {
  const data = await safeIdbGet<SeriesIndexData>('ct_series_index', 'series_index_main');
  if (data && typeof data.collections === 'object' && typeof data.mediaKeyToSeries === 'object') {
    inMemorySeriesIndex = {
      collections: data.collections || {},
      mediaKeyToSeries: data.mediaKeyToSeries || {},
      checkedMediaKeys: data.checkedMediaKeys || {},
      updatedAt: data.updatedAt || '',
    };
    isSeriesIndexLoaded = true;
    notifySeriesIndexListeners();
    return inMemorySeriesIndex;
  }
  isSeriesIndexLoaded = true;
  return inMemorySeriesIndex;
}

export async function saveSeriesIndexIdb(indexData: SeriesIndexData): Promise<IdbWriteResult> {
  inMemorySeriesIndex = {
    collections: indexData.collections || {},
    mediaKeyToSeries: indexData.mediaKeyToSeries || {},
    checkedMediaKeys: indexData.checkedMediaKeys || {},
    updatedAt: indexData.updatedAt || new Date().toISOString(),
  };
  isSeriesIndexLoaded = true;
  const res = await safeIdbSet('ct_series_index', 'series_index_main', inMemorySeriesIndex);
  notifySeriesIndexListeners();
  return res;
}

export function isMediaInSeriesSync(mediaKey: string): boolean {
  return Boolean(inMemorySeriesIndex.mediaKeyToSeries[mediaKey]);
}

export function isSeriesMediaCheckedSync(mediaKey: string): boolean {
  return Boolean(
    inMemorySeriesIndex.mediaKeyToSeries[mediaKey] ||
      inMemorySeriesIndex.checkedMediaKeys?.[mediaKey]
  );
}

export async function markSeriesMediaChecked(mediaKeys: string[]): Promise<IdbWriteResult> {
  if (!mediaKeys.length) return { persisted: true };
  if (!isSeriesIndexLoaded) {
    await loadSeriesIndexIdb();
  }
  const checked = { ...(inMemorySeriesIndex.checkedMediaKeys || {}) };
  let changed = false;
  const now = Date.now();
  for (const key of mediaKeys) {
    if (!key || checked[key]) continue;
    checked[key] = now;
    changed = true;
  }
  if (!changed) return { persisted: true };

  const entries = Object.entries(checked);
  let trimmed = checked;
  if (entries.length > 4000) {
    entries.sort((a, b) => a[1] - b[1]);
    trimmed = Object.fromEntries(entries.slice(entries.length - 3500));
  }

  inMemorySeriesIndex = {
    ...inMemorySeriesIndex,
    checkedMediaKeys: trimmed,
    updatedAt: new Date().toISOString(),
  };
  return safeIdbSet('ct_series_index', 'series_index_main', inMemorySeriesIndex);
}

export function getSeriesForMediaSync(mediaKey: string): SeriesCollection | null {
  const collectionKey = inMemorySeriesIndex.mediaKeyToSeries[mediaKey];
  if (!collectionKey) return null;
  return inMemorySeriesIndex.collections[collectionKey] || null;
}

export function getSeriesCollectionByKeySync(collectionKey: string): SeriesCollection | null {
  return inMemorySeriesIndex.collections[collectionKey] || null;
}

export function getAllSeriesCollectionsSync(): SeriesCollection[] {
  return Object.values(inMemorySeriesIndex.collections);
}

export async function registerSeriesCollections(
  collections: SeriesCollection[]
): Promise<IdbWriteResult> {
  if (!isSeriesIndexLoaded) {
    await loadSeriesIndexIdb();
  }

  let updated = false;
  const nextCollections = { ...inMemorySeriesIndex.collections };
  const nextMediaToSeries = { ...inMemorySeriesIndex.mediaKeyToSeries };
  const nextChecked = { ...(inMemorySeriesIndex.checkedMediaKeys || {}) };
  const now = Date.now();

  for (const col of collections) {
    const colKey = `collection:${col.media_type}:${col.id}`;
    const existing = nextCollections[colKey];
    // Never overwrite a full collection with a stub
    if (col.isStub && existing && !existing.isStub && existing.parts.length >= 2) {
      for (const key of col.partKeys) {
        nextMediaToSeries[key] = colKey;
        nextChecked[key] = now;
      }
      updated = true;
      continue;
    }
    nextCollections[colKey] = col;
    for (const key of col.partKeys) {
      nextMediaToSeries[key] = colKey;
      nextChecked[key] = now;
    }
    updated = true;
  }

  if (updated) {
    return saveSeriesIndexIdb({
      collections: nextCollections,
      mediaKeyToSeries: nextMediaToSeries,
      checkedMediaKeys: nextChecked,
      updatedAt: new Date().toISOString(),
    });
  }
  return { persisted: true };
}

export function resetIdbMemoryStateForTests(): void {
  stockStore = undefined;
  surfacedStore = undefined;
  seriesIndexStore = undefined;
  userListsStore = undefined;
  profileStore = undefined;
  offlineQueueStore = undefined;
  memoryFallback.clear();
  inMemorySurfacedMap = new Map();
  isSurfacedLoaded = false;
  inMemorySeriesIndex = {
    collections: {},
    mediaKeyToSeries: {},
    checkedMediaKeys: {},
    updatedAt: '',
  };
  isSeriesIndexLoaded = false;
  resetClientDepotsForTests();
  notifySeriesIndexListeners();
}

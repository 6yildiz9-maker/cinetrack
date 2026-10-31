import { get, set, del, createStore, type UseStore } from 'idb-keyval';
import type { TmdbItem } from '../types/tmdb.ts';
import type { SavedItem, Preferences, FavoriteActorInfo } from '../core/cinetrack-core.ts';

// Check IndexedDB availability (browser vs Node.js test environment)
export const isIndexedDBAvailable = (): boolean => {
  return typeof indexedDB !== 'undefined';
};

// Custom IndexedDB store references
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
const memoryFallback = new Map<string, any>();

async function safeIdbGet<T>(storeName: string, key: string): Promise<T | null> {
  const store = getStore(storeName);
  if (store) {
    try {
      const val = await get<T>(key, store);
      if (val !== undefined) {
        memoryFallback.set(`${storeName}:${key}`, val);
        return val;
      }
      return null;
    } catch (e) {
      console.warn(`[IDB] Read failed for ${storeName}/${key}:`, e);
    }
  }
  const mem = memoryFallback.get(`${storeName}:${key}`);
  return mem !== undefined ? mem : null;
}

async function safeIdbSet<T>(storeName: string, key: string, value: T): Promise<void> {
  memoryFallback.set(`${storeName}:${key}`, value);
  const store = getStore(storeName);
  if (store) {
    try {
      await set(key, value, store);
    } catch (e) {
      console.warn(`[IDB] Write failed for ${storeName}/${key}:`, e);
    }
  }
}

export async function safeIdbDel(storeName: string, key: string): Promise<void> {
  memoryFallback.delete(`${storeName}:${key}`);
  const store = getStore(storeName);
  if (store) {
    try {
      await del(key, store);
    } catch (e) {
      console.warn(`[IDB] Del failed for ${storeName}/${key}:`, e);
    }
  }
}

// ==========================================
// 1. ct:profile (Tema, DNA, Tercihler)
// ==========================================
export interface IsolatedProfileRecord {
  profileId: string;
  name: string;
  theme?: string;
  dna?: any;
  preferences: Preferences;
  favoriteActors?: FavoriteActorInfo[];
  updatedAt: string;
}

export async function loadIsolatedProfileIdb(profileId: string): Promise<IsolatedProfileRecord | null> {
  return safeIdbGet<IsolatedProfileRecord>('ct_profile', `profile:${profileId}`);
}

export async function saveIsolatedProfileIdb(profile: IsolatedProfileRecord): Promise<void> {
  await safeIdbSet('ct_profile', `profile:${profile.profileId}`, profile);
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

export function toCompactUserListItem(item: SavedItem | UserListItemCompact | any): UserListItemCompact {
  const mediaType: 'movie' | 'tv' = item?.media_type === 'tv' ? 'tv' : 'movie';
  const status: 'watching' | 'watchlist' | 'completed' =
    item?.status === 'watching' || item?.status === 'completed' ? item.status : 'watchlist';
  const compact: UserListItemCompact = {
    id: item.id,
    media_type: mediaType,
    status,
    personal_rating:
      typeof item?.personal_rating === 'number' && Number.isFinite(item.personal_rating)
        ? item.personal_rating
        : '',
  };
  if (item?.addedAt) compact.addedAt = String(item.addedAt);
  if (item?.updatedAt) compact.updatedAt = String(item.updatedAt);
  if (item?.custom) compact.custom = true;
  if (typeof item?.current_season === 'number') compact.current_season = item.current_season;
  if (typeof item?.episodes_watched === 'number') compact.episodes_watched = item.episodes_watched;
  if (item?.season_progress && typeof item.season_progress === 'object') {
    compact.season_progress = item.season_progress;
  }
  return compact;
}

export async function loadUserListsIdb(profileId: string): Promise<UserListItemCompact[]> {
  const data = await safeIdbGet<UserListItemCompact[]>('ct_user_lists', `lists:${profileId}`);
  return Array.isArray(data) ? data.map(toCompactUserListItem) : [];
}

export async function saveUserListsIdb(
  profileId: string,
  items: Array<SavedItem | UserListItemCompact>
): Promise<UserListItemCompact[]> {
  const compactList = (Array.isArray(items) ? items : [])
    .filter((it) => it && it.id != null)
    .map(toCompactUserListItem);
  await safeIdbSet('ct_user_lists', `lists:${profileId}`, compactList);
  return compactList;
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

export async function saveStockIdb(stock: StockDepot): Promise<void> {
  await safeIdbSet('ct_stock', 'stock_main', stock);
}

// ==========================================
// 4. ct:surfaced (Gösterim Geçmişi - FIFO)
// ==========================================
export const SURFACED_FIFO_MAX_SIZE = 1000;
let inMemorySurfacedSet = new Set<string>();
let inMemorySurfacedList: string[] = [];
let isSurfacedLoaded = false;

export async function loadSurfacedKeys(): Promise<string[]> {
  const data = await safeIdbGet<string[]>('ct_surfaced', 'surfaced_keys');
  const list = Array.isArray(data) ? [...data] : [];
  inMemorySurfacedList = list;
  inMemorySurfacedSet = new Set(list);
  isSurfacedLoaded = true;
  return [...inMemorySurfacedList];
}

export async function recordSurfacedKeys(
  keys: string[],
  maxSize: number = SURFACED_FIFO_MAX_SIZE
): Promise<string[]> {
  if (!isSurfacedLoaded) {
    await loadSurfacedKeys();
  }

  const effectiveCap = Math.max(1, Math.floor(maxSize));
  let changed = false;

  for (const k of keys) {
    if (!k || inMemorySurfacedSet.has(k)) continue;
    inMemorySurfacedSet.add(k);
    inMemorySurfacedList.push(k);
    changed = true;
  }

  // FIFO (First-In, First-Out) eviction if exceeding max size
  if (inMemorySurfacedList.length > effectiveCap) {
    const overflow = inMemorySurfacedList.length - effectiveCap;
    const evicted = inMemorySurfacedList.splice(0, overflow);
    for (const ev of evicted) {
      inMemorySurfacedSet.delete(ev);
    }
    changed = true;
  }

  if (changed) {
    await safeIdbSet('ct_surfaced', 'surfaced_keys', [...inMemorySurfacedList]);
  }
  return [...inMemorySurfacedList];
}

export async function removeSurfacedKey(mediaKey: string): Promise<void> {
  if (!mediaKey) return;
  if (!isSurfacedLoaded) {
    await loadSurfacedKeys();
  }
  if (!inMemorySurfacedSet.has(mediaKey)) return;
  inMemorySurfacedSet.delete(mediaKey);
  inMemorySurfacedList = inMemorySurfacedList.filter((k) => k !== mediaKey);
  await safeIdbSet('ct_surfaced', 'surfaced_keys', [...inMemorySurfacedList]);
}

export function isItemSurfacedSync(mediaKey: string): boolean {
  return inMemorySurfacedSet.has(mediaKey);
}

export async function isItemSurfaced(mediaKey: string): Promise<boolean> {
  if (!isSurfacedLoaded) {
    await loadSurfacedKeys();
  }
  return inMemorySurfacedSet.has(mediaKey);
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
  partKeys: string[]; // e.g. ["movie:671", "movie:672"]
  sourceItemKey?: string;
}

export interface SeriesIndexData {
  collections: Record<string, SeriesCollection>; // collectionKey -> SeriesCollection
  mediaKeyToSeries: Record<string, string>; // mediaKey ("movie:671") -> collectionKey
  checkedMediaKeys?: Record<string, number>; // mediaKey -> checked epoch ms
  updatedAt: string;
}

// In-memory cache + pub/sub for synchronous MediaCard badge checks & Seriler tab reactivity
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

export async function saveSeriesIndexIdb(indexData: SeriesIndexData): Promise<void> {
  inMemorySeriesIndex = {
    collections: indexData.collections || {},
    mediaKeyToSeries: indexData.mediaKeyToSeries || {},
    checkedMediaKeys: indexData.checkedMediaKeys || {},
    updatedAt: indexData.updatedAt || new Date().toISOString(),
  };
  isSeriesIndexLoaded = true;
  await safeIdbSet('ct_series_index', 'series_index_main', inMemorySeriesIndex);
  notifySeriesIndexListeners();
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

export async function markSeriesMediaChecked(mediaKeys: string[]): Promise<void> {
  if (!mediaKeys.length) return;
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
  if (!changed) return;

  // Cap checkedMediaKeys at 4000 entries to bound metadata size
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
  await safeIdbSet('ct_series_index', 'series_index_main', inMemorySeriesIndex);
}

export function getSeriesForMediaSync(mediaKey: string): SeriesCollection | null {
  const collectionKey = inMemorySeriesIndex.mediaKeyToSeries[mediaKey];
  if (!collectionKey) return null;
  return inMemorySeriesIndex.collections[collectionKey] || null;
}

export function getAllSeriesCollectionsSync(): SeriesCollection[] {
  return Object.values(inMemorySeriesIndex.collections);
}

/**
 * Registers an array of collection objects into ct:series-index
 */
export async function registerSeriesCollections(collections: SeriesCollection[]): Promise<void> {
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
    nextCollections[colKey] = col;
    for (const key of col.partKeys) {
      nextMediaToSeries[key] = colKey;
      nextChecked[key] = now;
    }
    updated = true;
  }

  if (updated) {
    await saveSeriesIndexIdb({
      collections: nextCollections,
      mediaKeyToSeries: nextMediaToSeries,
      checkedMediaKeys: nextChecked,
      updatedAt: new Date().toISOString(),
    });
  }
}

export function resetIdbMemoryStateForTests(): void {
  stockStore = undefined;
  surfacedStore = undefined;
  seriesIndexStore = undefined;
  userListsStore = undefined;
  profileStore = undefined;
  offlineQueueStore = undefined;
  memoryFallback.clear();
  inMemorySurfacedSet = new Set();
  inMemorySurfacedList = [];
  isSurfacedLoaded = false;
  inMemorySeriesIndex = {
    collections: {},
    mediaKeyToSeries: {},
    checkedMediaKeys: {},
    updatedAt: '',
  };
  isSeriesIndexLoaded = false;
  notifySeriesIndexListeners();
}

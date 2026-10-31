import { get, set, del, createStore, UseStore } from 'idb-keyval';
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
      if (!stockStore) stockStore = createStore('cinetrack-db', 'ct_stock');
      return stockStore;
    case 'ct_surfaced':
      if (!surfacedStore) surfacedStore = createStore('cinetrack-db', 'ct_surfaced');
      return surfacedStore;
    case 'ct_series_index':
      if (!seriesIndexStore) seriesIndexStore = createStore('cinetrack-db', 'ct_series_index');
      return seriesIndexStore;
    case 'ct_user_lists':
      if (!userListsStore) userListsStore = createStore('cinetrack-db', 'ct_user_lists');
      return userListsStore;
    case 'ct_profile':
      if (!profileStore) profileStore = createStore('cinetrack-db', 'ct_profile');
      return profileStore;
    case 'ct_offline_queue':
      if (!offlineQueueStore) offlineQueueStore = createStore('cinetrack-db', 'ct_offline_queue');
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
      return val !== undefined ? val : null;
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

async function safeIdbDel(storeName: string, key: string): Promise<void> {
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

export async function loadUserListsIdb(profileId: string): Promise<SavedItem[]> {
  const data = await safeIdbGet<SavedItem[]>('ct_user_lists', `lists:${profileId}`);
  return Array.isArray(data) ? data : [];
}

export async function saveUserListsIdb(profileId: string, items: SavedItem[]): Promise<void> {
  await safeIdbSet('ct_user_lists', `lists:${profileId}`, items);
}

// ==========================================
// 3. ct:stock (500 Film & 500 Dizi Deposu)
// ==========================================
export interface StockDepot {
  movies: TmdbItem[];
  tv: TmdbItem[];
  updatedAt: string;
}

export async function loadStockIdb(): Promise<StockDepot> {
  const data = await safeIdbGet<StockDepot>('ct_stock', 'stock_main');
  if (data && Array.isArray(data.movies) && Array.isArray(data.tv)) {
    return data;
  }
  return { movies: [], tv: [], updatedAt: '' };
}

export async function saveStockIdb(stock: StockDepot): Promise<void> {
  await safeIdbSet('ct_stock', 'stock_main', stock);
}

// ==========================================
// 4. ct:surfaced (Gösterim Geçmişi - FIFO)
// ==========================================
const SURFACED_FIFO_MAX_SIZE = 1000;
let inMemorySurfacedSet = new Set<string>();
let inMemorySurfacedList: string[] = [];
let isSurfacedLoaded = false;

export async function loadSurfacedKeys(): Promise<string[]> {
  const data = await safeIdbGet<string[]>('ct_surfaced', 'surfaced_keys');
  const list = Array.isArray(data) ? data : [];
  inMemorySurfacedList = list;
  inMemorySurfacedSet = new Set(list);
  isSurfacedLoaded = true;
  return list;
}

export async function recordSurfacedKeys(keys: string[]): Promise<void> {
  if (!isSurfacedLoaded) {
    await loadSurfacedKeys();
  }

  let changed = false;
  for (const k of keys) {
    if (!k || inMemorySurfacedSet.has(k)) continue;
    inMemorySurfacedSet.add(k);
    inMemorySurfacedList.push(k);
    changed = true;
  }

  // FIFO eviction if exceeding max size
  if (inMemorySurfacedList.length > SURFACED_FIFO_MAX_SIZE) {
    const overflow = inMemorySurfacedList.length - SURFACED_FIFO_MAX_SIZE;
    const evicted = inMemorySurfacedList.splice(0, overflow);
    for (const ev of evicted) {
      inMemorySurfacedSet.delete(ev);
    }
    changed = true;
  }

  if (changed) {
    await safeIdbSet('ct_surfaced', 'surfaced_keys', inMemorySurfacedList);
  }
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
  updatedAt: string;
}

// In-memory cache for synchronous MediaCard badge checks
let inMemorySeriesIndex: SeriesIndexData = {
  collections: {},
  mediaKeyToSeries: {},
  updatedAt: '',
};
let isSeriesIndexLoaded = false;

export async function loadSeriesIndexIdb(): Promise<SeriesIndexData> {
  const data = await safeIdbGet<SeriesIndexData>('ct_series_index', 'series_index_main');
  if (data && typeof data.collections === 'object' && typeof data.mediaKeyToSeries === 'object') {
    inMemorySeriesIndex = data;
    isSeriesIndexLoaded = true;
    return data;
  }
  return inMemorySeriesIndex;
}

export async function saveSeriesIndexIdb(indexData: SeriesIndexData): Promise<void> {
  inMemorySeriesIndex = indexData;
  isSeriesIndexLoaded = true;
  await safeIdbSet('ct_series_index', 'series_index_main', indexData);
}

export function isMediaInSeriesSync(mediaKey: string): boolean {
  return Boolean(inMemorySeriesIndex.mediaKeyToSeries[mediaKey]);
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
  const current = { ...inMemorySeriesIndex };
  current.collections = { ...current.collections };
  current.mediaKeyToSeries = { ...current.mediaKeyToSeries };

  for (const col of collections) {
    const colKey = `collection:${col.media_type}:${col.id}`;
    current.collections[colKey] = col;
    for (const key of col.partKeys) {
      current.mediaKeyToSeries[key] = colKey;
    }
    updated = true;
  }

  if (updated) {
    current.updatedAt = new Date().toISOString();
    await saveSeriesIndexIdb(current);
  }
}

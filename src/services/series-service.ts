import { fetchTmdb } from './api.ts';
import {
  type SeriesCollection,
  type SeriesCollectionPart,
  registerSeriesCollections,
  loadSeriesIndexIdb,
  isMediaInSeriesSync,
  isSeriesMediaCheckedSync,
  markSeriesMediaChecked,
  getSeriesForMediaSync,
  getSeriesCollectionByKeySync,
  getAllSeriesCollectionsSync,
} from './storage-idb.ts';
import {
  RECOMMENDATION_WEIGHTS_V3,
  determineItemEra,
  determineItemPopularityTier,
  scoreCandidatesV3,
  type PoolCandidateItem,
  type SavedItem,
  type TasteProfileV3,
} from '../core/cinetrack-core.ts';
import type { TmdbCollectionInfo, TmdbGenre, TmdbItem } from '../types/tmdb.ts';
import { compareMediaDatesAscending, isWithinReleaseWindow } from '../utils/release-window.ts';

export interface TmdbSeriesRawResponse {
  id?: number | string;
  name?: string;
  title?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  genre_ids?: number[];
  genres?: TmdbGenre[];
  belongs_to_collection?: TmdbCollectionInfo | null;
  parts?: TmdbItem[];
  results?: Array<{ id: number; name?: string; title?: string; first_air_date?: string; poster_path?: string | null; backdrop_path?: string | null; vote_average?: number; vote_count?: number; genre_ids?: number[]; overview?: string }>;
  keywords?: Array<{ id: number; name: string }>;
}

export type TmdbFetcherFn = (
  path: string,
  params?: Record<string, string>
) => Promise<TmdbSeriesRawResponse>;

let activeFetcher: TmdbFetcherFn = (path, params) =>
  fetchTmdb(path, params) as Promise<TmdbSeriesRawResponse>;

export function setSeriesTmdbFetcher(fetcher?: TmdbFetcherFn | null): void {
  activeFetcher =
    fetcher || ((path, params) => fetchTmdb(path, params) as Promise<TmdbSeriesRawResponse>);
}

import {
  KNOWN_TV_FRANCHISES,
  FRANCHISE_KEYWORD_PATTERN,
  GENERIC_NON_FRANCHISE_KEYWORDS,
  type KnownTvFranchiseSeedPart,
} from './series-tv-seeds.ts';

const processedCollectionIds = new Set<string>();
const inFlightCollectionFetches = new Set<string>();

const MAX_SERIES_CONCURRENCY = 3;
let activeSeriesTasks = 0;
const seriesTaskQueue: Array<() => void> = [];

async function runBoundedSeriesTask<T>(fn: () => Promise<T>): Promise<T> {
  if (activeSeriesTasks >= MAX_SERIES_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      seriesTaskQueue.push(resolve);
    });
  }
  activeSeriesTasks += 1;
  try {
    return await fn();
  } finally {
    activeSeriesTasks -= 1;
    const next = seriesTaskQueue.shift();
    if (next) next();
  }
}

/**
 * Formats TMDB collection names into clean Turkish series labels (e.g. "X-Men Collection" -> "X-Men Serisi").
 */
export function formatSeriesCollectionName(rawName?: string | null): string {
  const trimmed = typeof rawName === 'string' ? rawName.trim() : '';
  if (!trimmed) return 'Seri';
  if (/(serisi|koleksiyonu|evreni|üçlemesi)$/i.test(trimmed)) {
    return trimmed;
  }
  const withoutCollection = trimmed
    .replace(/\s*[-–:]?\s*(film\s+)?collection$/i, '')
    .replace(/\s*koleksiyon$/i, '')
    .trim();
  return withoutCollection ? `${withoutCollection} Serisi` : trimmed;
}

export interface SeriesAffiliationInfo {
  inSeries: boolean;
  collectionId: number | string | null;
  collectionKey: string | null;
  collectionName: string | null;
  collection: SeriesCollection | null;
}

interface MediaCandidateLike {
  id?: number | string;
  media_type?: string;
  title?: string;
  name?: string;
  custom?: boolean;
  collectionName?: string;
  belongs_to_collection?: TmdbCollectionInfo | number | null;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
  genre_ids?: number[];
  overview?: string;
}

function inferMediaType(item: MediaCandidateLike): 'movie' | 'tv' {
  return item.media_type === 'tv' || (!item.media_type && Boolean(item.name) && !item.title)
    ? 'tv'
    : 'movie';
}

/**
 * Synchronous series affiliation lookup for MediaCard (SERİ badge tooltip + visible collection_name label)
 * and DetailModal (franchise membership list).
 */
export function getItemSeriesInfo(item: MediaCandidateLike | null | undefined): SeriesAffiliationInfo {
  if (!item || item.id == null) {
    return {
      inSeries: false,
      collectionId: null,
      collectionKey: null,
      collectionName: null,
      collection: null,
    };
  }

  const mType = inferMediaType(item);
  const key = `${mType}:${item.id}`;
  const indexedCol = getSeriesForMediaSync(key);
  if (indexedCol) {
    return {
      inSeries: true,
      collectionId: indexedCol.id,
      collectionKey: `collection:${indexedCol.media_type}:${indexedCol.id}`,
      collectionName: formatSeriesCollectionName(indexedCol.name),
      collection: indexedCol,
    };
  }

  if (item.belongs_to_collection) {
    if (typeof item.belongs_to_collection === 'object') {
      const colId = item.belongs_to_collection.id;
      const colKey = `collection:movie:${colId}`;
      const existingByCol = getSeriesCollectionByKeySync(colKey);
      const rawName = existingByCol?.name || item.belongs_to_collection.name || item.collectionName;
      return {
        inSeries: true,
        collectionId: colId,
        collectionKey: colKey,
        collectionName: formatSeriesCollectionName(rawName),
        collection: existingByCol,
      };
    }
    if (typeof item.belongs_to_collection === 'number') {
      const colKey = `collection:movie:${item.belongs_to_collection}`;
      const existingByCol = getSeriesCollectionByKeySync(colKey);
      return {
        inSeries: true,
        collectionId: item.belongs_to_collection,
        collectionKey: colKey,
        collectionName: existingByCol
          ? formatSeriesCollectionName(existingByCol.name)
          : item.collectionName
            ? formatSeriesCollectionName(item.collectionName)
            : null,
        collection: existingByCol,
      };
    }
  }

  if (typeof item.collectionName === 'string' && item.collectionName.trim()) {
    return {
      inSeries: true,
      collectionId: null,
      collectionKey: null,
      collectionName: formatSeriesCollectionName(item.collectionName),
      collection: null,
    };
  }

  return {
    inSeries: false,
    collectionId: null,
    collectionKey: null,
    collectionName: null,
    collection: null,
  };
}

export async function initSeriesService(): Promise<void> {
  await loadSeriesIndexIdb();
}

export function resetSeriesServiceForTests(): void {
  processedCollectionIds.clear();
  inFlightCollectionFetches.clear();
  setSeriesTmdbFetcher(null);
}

/**
 * Fetches TMDB /collection/{id} and indexes all eligible parts (filtered by isWithinReleaseWindow) into ct:series-index.
 */
export async function indexMovieCollection(collectionId: number): Promise<SeriesCollection | null> {
  const colToken = `movie:${collectionId}`;
  const colKey = `collection:movie:${collectionId}`;
  const existing = getSeriesCollectionByKeySync(colKey);
  if (!collectionId || (processedCollectionIds.has(colToken) && existing && !existing.isStub)) {
    return existing;
  }
  if (inFlightCollectionFetches.has(colToken)) return existing || null;

  inFlightCollectionFetches.add(colToken);
  try {
    const raw = await runBoundedSeriesTask(() => activeFetcher(`/collection/${collectionId}`));
    if (!raw || !Array.isArray(raw.parts) || raw.parts.length === 0) {
      return null;
    }

    const parts: SeriesCollectionPart[] = raw.parts
      .filter((p) => {
        if (!p || p.id == null) return false;
        const releaseDate = p.release_date || p.first_air_date || '';
        return isWithinReleaseWindow(releaseDate);
      })
      .map((p) => ({
        id: p.id,
        media_type: 'movie',
        title: p.title || p.name || 'Başlıksız',
        name: p.name || p.title,
        release_date: p.release_date || '',
        first_air_date: p.release_date || '',
        poster_path: p.poster_path || null,
        backdrop_path: p.backdrop_path || null,
        vote_average: Number(p.vote_average || 0),
        vote_count: Number(p.vote_count || 0),
        genre_ids: Array.isArray(p.genre_ids) ? p.genre_ids : [],
        overview: p.overview || '',
      }));

    if (parts.length < 2) {
      return null;
    }

    parts.sort((a, b) => compareMediaDatesAscending(a.release_date, b.release_date));

    const seriesCol: SeriesCollection = {
      id: collectionId,
      name: formatSeriesCollectionName(raw.name || 'Koleksiyon'),
      media_type: 'movie',
      poster_path: raw.poster_path || null,
      backdrop_path: raw.backdrop_path || null,
      overview: raw.overview || '',
      parts,
      partKeys: parts.map((p) => `movie:${p.id}`),
      isStub: false,
    };

    processedCollectionIds.add(colToken);
    await registerSeriesCollections([seriesCol]);
    return seriesCol;
  } catch (err) {
    console.warn(`[SeriesService] Koleksiyon çekilemedi (${collectionId}):`, err);
    return null;
  } finally {
    inFlightCollectionFetches.delete(colToken);
  }
}

async function fetchTvKeywordCollectionParts(
  kwId: number,
  kwName: string,
  sourceItem?: MediaCandidateLike
): Promise<SeriesCollection | null> {
  const colToken = `tv:kw-${kwId}`;
  const colKey = `collection:tv:kw-${kwId}`;
  const existing = getSeriesCollectionByKeySync(colKey);
  if (processedCollectionIds.has(colToken) && existing && !existing.isStub) {
    return existing;
  }
  if (inFlightCollectionFetches.has(colToken)) return existing || null;

  inFlightCollectionFetches.add(colToken);
  try {
    const disc = await runBoundedSeriesTask(() =>
      activeFetcher('/discover/tv', {
        with_keywords: String(kwId),
        sort_by: 'popularity.desc',
        page: '1',
      })
    );
    const results = Array.isArray(disc?.results) ? disc.results : [];
    const mergedMap = new Map<number, SeriesCollectionPart>();

    if (sourceItem && sourceItem.id != null) {
      const srcDate = sourceItem.first_air_date || sourceItem.release_date || '';
      if (!srcDate || isWithinReleaseWindow(srcDate)) {
        mergedMap.set(Number(sourceItem.id), {
          id: Number(sourceItem.id),
          media_type: 'tv',
          title: sourceItem.name || sourceItem.title || 'Dizi',
          name: sourceItem.name || sourceItem.title || 'Dizi',
          first_air_date: srcDate,
          release_date: srcDate,
          poster_path: sourceItem.poster_path || null,
          backdrop_path: sourceItem.backdrop_path || null,
          vote_average: Number(sourceItem.vote_average || 0),
          vote_count: Number(sourceItem.vote_count || 0),
          genre_ids: Array.isArray(sourceItem.genre_ids) ? sourceItem.genre_ids : [],
          overview: sourceItem.overview || '',
        });
      }
    }

    for (const r of results.slice(0, 18)) {
      if (!r || r.id == null) continue;
      const rDate = r.first_air_date || '';
      if (!isWithinReleaseWindow(rDate)) continue;
      const rId = Number(r.id);
      mergedMap.set(rId, {
        id: rId,
        media_type: 'tv',
        title: r.name || r.title || 'Dizi',
        name: r.name || r.title || 'Dizi',
        first_air_date: rDate,
        release_date: rDate,
        poster_path: r.poster_path || null,
        backdrop_path: r.backdrop_path || null,
        vote_average: Number(r.vote_average || 0),
        vote_count: Number(r.vote_count || 0),
        genre_ids: Array.isArray(r.genre_ids) ? r.genre_ids : [],
        overview: r.overview || '',
      });
    }

    if (mergedMap.size >= 2) {
      const parts = Array.from(mergedMap.values()).sort((a, b) =>
        compareMediaDatesAscending(a.first_air_date, b.first_air_date)
      );
      const seriesCol: SeriesCollection = {
        id: `kw-${kwId}`,
        name: /(evreni|serisi)$/i.test(kwName) ? kwName : `${kwName} Evreni`,
        media_type: 'tv',
        poster_path: parts[0]?.poster_path || null,
        parts,
        partKeys: parts.map((p) => `tv:${p.id}`),
        isStub: false,
      };
      processedCollectionIds.add(colToken);
      await registerSeriesCollections([seriesCol]);
      return seriesCol;
    }
  } catch {
    // Ignore transient keyword discover error
  } finally {
    inFlightCollectionFetches.delete(colToken);
  }
  return null;
}

async function indexTvKeywordFranchise(
  tvId: number,
  sourceItem: MediaCandidateLike,
  stubOnly = false
): Promise<SeriesCollection | null> {
  const kwRes = await runBoundedSeriesTask(() => activeFetcher(`/tv/${tvId}/keywords`));
  const rawKeywords: Array<{ id: number; name: string }> = Array.isArray(kwRes?.results)
    ? (kwRes.results as Array<{ id: number; name: string }>)
    : Array.isArray(kwRes?.keywords)
      ? kwRes.keywords
      : [];

  if (rawKeywords.length === 0) return null;

  const candidateKeywords = rawKeywords.filter((kw) => {
    if (!kw || !kw.id || typeof kw.name !== 'string') return false;
    const lower = kw.name.trim().toLowerCase();
    if (!lower || GENERIC_NON_FRANCHISE_KEYWORDS.has(lower)) return false;
    return FRANCHISE_KEYWORD_PATTERN.test(lower);
  });

  if (stubOnly && candidateKeywords.length > 0) {
    const firstKw = candidateKeywords[0];
    const stubPart: SeriesCollectionPart = {
      id: tvId,
      media_type: 'tv',
      title: sourceItem.name || sourceItem.title || 'Dizi',
      name: sourceItem.name || sourceItem.title || 'Dizi',
      first_air_date: sourceItem.first_air_date || sourceItem.release_date || '',
      release_date: sourceItem.first_air_date || sourceItem.release_date || '',
      poster_path: sourceItem.poster_path || null,
      backdrop_path: sourceItem.backdrop_path || null,
      vote_average: Number(sourceItem.vote_average || 0),
      genre_ids: Array.isArray(sourceItem.genre_ids) ? sourceItem.genre_ids : [],
      overview: sourceItem.overview || '',
    };
    const stubCol: SeriesCollection = {
      id: `kw-${firstKw.id}`,
      name: `${firstKw.name} Evreni`,
      media_type: 'tv',
      poster_path: stubPart.poster_path || null,
      parts: [stubPart],
      partKeys: [`tv:${tvId}`],
      isStub: true,
    };
    await registerSeriesCollections([stubCol]);
    return stubCol;
  }

  for (const kw of candidateKeywords.slice(0, 2)) {
    const col = await fetchTvKeywordCollectionParts(kw.id, kw.name, sourceItem);
    if (col) return col;
  }

  return null;
}

function buildKnownTvFranchiseCollection(
  franchise: { id: number; name: string; parts: KnownTvFranchiseSeedPart[] },
  tvId: number,
  item: MediaCandidateLike,
  existing: SeriesCollection | null
): SeriesCollection {
  const parts: SeriesCollectionPart[] = franchise.parts
    .filter((seedPart) => isWithinReleaseWindow(seedPart.first_air_date))
    .map((seedPart) => {
      const prevPart = existing?.parts.find((ep) => Number(ep.id) === seedPart.id);
      const isCurrent = seedPart.id === tvId;
      return {
        id: seedPart.id,
        media_type: 'tv',
        title: isCurrent ? item.name || item.title || seedPart.title : prevPart?.title || seedPart.title,
        name: isCurrent ? item.name || item.title || seedPart.title : prevPart?.name || seedPart.title,
        first_air_date:
          (isCurrent ? item.first_air_date || item.release_date : prevPart?.first_air_date) ||
          seedPart.first_air_date,
        release_date:
          (isCurrent ? item.first_air_date || item.release_date : prevPart?.release_date) ||
          seedPart.first_air_date,
        poster_path: (isCurrent ? item.poster_path : prevPart?.poster_path) || null,
        backdrop_path: (isCurrent ? item.backdrop_path : prevPart?.backdrop_path) || null,
        vote_average: Number(
          (isCurrent ? item.vote_average : prevPart?.vote_average) || seedPart.vote_average || 0
        ),
        genre_ids:
          (isCurrent && Array.isArray(item.genre_ids) && item.genre_ids.length > 0
            ? item.genre_ids
            : prevPart?.genre_ids) ||
          seedPart.genre_ids,
        overview: (isCurrent ? item.overview : prevPart?.overview) || '',
      };
    });

  return {
    id: franchise.id,
    name: franchise.name,
    media_type: 'tv',
    poster_path: parts.find((p) => p.poster_path)?.poster_path || null,
    parts,
    partKeys: parts.map((p) => `tv:${p.id}`),
    isStub: false,
  };
}

/**
 * Registers local `belongs_to_collection` and known TV franchise hints from savedItems with 0 network calls!
 */
export async function registerLocalSavedSeriesHints(savedItems: SavedItem[]): Promise<void> {
  if (!Array.isArray(savedItems) || savedItems.length === 0) return;
  await loadSeriesIndexIdb();

  const stubMap = new Map<string, SeriesCollection>();

  for (const item of savedItems) {
    if (!item || item.id == null || item.custom) continue;
    const mType = item.media_type === 'tv' ? 'tv' : 'movie';
    const mediaKey = `${mType}:${item.id}`;
    const existing = getSeriesForMediaSync(mediaKey);
    if (existing && !existing.isStub) continue;

    if (mType === 'movie' && item.belongs_to_collection && typeof item.belongs_to_collection === 'object') {
      const colId = item.belongs_to_collection.id;
      if (!colId) continue;
      const colKey = `collection:movie:${colId}`;
      const fullExisting = getSeriesCollectionByKeySync(colKey);
      if (fullExisting && !fullExisting.isStub) continue;

      const stub: SeriesCollection = stubMap.get(colKey) ||
        fullExisting || {
          id: colId,
          name: formatSeriesCollectionName(item.belongs_to_collection.name),
          media_type: 'movie',
          poster_path: item.belongs_to_collection.poster_path || item.poster_path || null,
          backdrop_path: item.belongs_to_collection.backdrop_path || item.backdrop_path || null,
          parts: [],
          partKeys: [],
          isStub: true,
        };
      if (!stub.partKeys.includes(mediaKey)) {
        stub.partKeys.push(mediaKey);
        stub.parts.push({
          id: item.id,
          media_type: 'movie',
          title: item.title || item.name || 'Film',
          name: item.name || item.title,
          release_date: item.release_date || '',
          first_air_date: item.release_date || '',
          poster_path: item.poster_path || null,
          backdrop_path: item.backdrop_path || null,
          vote_average: Number(item.vote_average || 0),
          genre_ids: Array.isArray(item.genre_ids) ? item.genre_ids : [],
          overview: item.overview || '',
        });
      }
      stubMap.set(colKey, stub);
    } else if (mType === 'tv') {
      const tvId = Number(item.id);
      for (const franchise of Object.values(KNOWN_TV_FRANCHISES)) {
        if (franchise.parts.some((p) => p.id === tvId)) {
          const colKey = `collection:tv:${franchise.id}`;
          stubMap.set(colKey, buildKnownTvFranchiseCollection(franchise, tvId, item, existing));
          break;
        }
      }
    }
  }

  if (stubMap.size > 0) {
    await registerSeriesCollections(Array.from(stubMap.values()));
  }
}

/**
 * Lazy backfill when the "Seriler" tab opens (FEAT-01 #6):
 * - Skips network completely in demo mode (`skippedDemo: true`, 0 requests).
 * - Queries ONLY unchecked saved items (`!isSeriesMediaCheckedSync`), max 1 request per unchecked item!
 * - Creates stub franchise headers without fetching `/collection/{id}` for closed groups!
 */
export async function backfillSavedSeriesLazy(
  savedItems: SavedItem[],
  options: { isDemo?: boolean } = {}
): Promise<{ skippedDemo: boolean; checkedCount: number; networkRequests: number }> {
  await registerLocalSavedSeriesHints(savedItems);

  if (options.isDemo) {
    return { skippedDemo: true, checkedCount: 0, networkRequests: 0 };
  }

  let networkRequests = 0;
  let checkedCount = 0;
  const newlyCheckedNonSeries: string[] = [];
  const stubsToRegister: SeriesCollection[] = [];

  const uncheckedItems = (savedItems || []).filter((item) => {
    if (!item || item.id == null || item.custom) return false;
    const rawId = String(item.id);
    if (!/^\d+$/.test(rawId)) return false;
    const mType = item.media_type === 'tv' ? 'tv' : 'movie';
    const key = `${mType}:${rawId}`;
    return !isSeriesMediaCheckedSync(key);
  });

  await Promise.allSettled(
    uncheckedItems.map(async (item) => {
      const rawId = String(item.id);
      const mType = item.media_type === 'tv' ? 'tv' : 'movie';
      const mediaKey = `${mType}:${rawId}`;
      checkedCount += 1;

      if (mType === 'movie') {
        try {
          networkRequests += 1;
          const details = await runBoundedSeriesTask(() => activeFetcher(`/movie/${rawId}`));
          const colInfo = details?.belongs_to_collection;
          if (colInfo && colInfo.id) {
            stubsToRegister.push({
              id: colInfo.id,
              name: formatSeriesCollectionName(colInfo.name),
              media_type: 'movie',
              poster_path: colInfo.poster_path || item.poster_path || null,
              backdrop_path: colInfo.backdrop_path || item.backdrop_path || null,
              parts: [
                {
                  id: item.id,
                  media_type: 'movie',
                  title: item.title || details?.title || 'Film',
                  name: item.name || item.title,
                  release_date: item.release_date || details?.release_date || '',
                  first_air_date: item.release_date || details?.release_date || '',
                  poster_path: item.poster_path || details?.poster_path || null,
                  backdrop_path: item.backdrop_path || details?.backdrop_path || null,
                  vote_average: Number(item.vote_average || details?.vote_average || 0),
                  genre_ids: Array.isArray(item.genre_ids) ? item.genre_ids : [],
                  overview: item.overview || details?.overview || '',
                },
              ],
              partKeys: [mediaKey],
              isStub: true,
            });
          } else {
            newlyCheckedNonSeries.push(mediaKey);
          }
        } catch {
          // Leave unchecked on transient network error so retry is possible later
        }
      } else {
        try {
          networkRequests += 1;
          const indexedStub = await indexTvKeywordFranchise(Number(rawId), item, true);
          if (!indexedStub) {
            newlyCheckedNonSeries.push(mediaKey);
          }
        } catch {
          // Transient error
        }
      }
    })
  );

  if (stubsToRegister.length > 0) {
    await registerSeriesCollections(stubsToRegister);
  }
  if (newlyCheckedNonSeries.length > 0) {
    await markSeriesMediaChecked(newlyCheckedNonSeries);
  }

  return { skippedDemo: false, checkedCount, networkRequests };
}

/**
 * Group-lazy loader: fetches full collection parts ONLY when a franchise accordion group is opened!
 * Subsequent opens use the persistent `ct:series-index` cache with 0 network calls.
 */
export async function ensureSeriesCollectionLoaded(
  collectionKey: string,
  options: { isDemo?: boolean } = {}
): Promise<SeriesCollection | null> {
  await loadSeriesIndexIdb();
  const existing = getSeriesCollectionByKeySync(collectionKey);
  if (existing && !existing.isStub && existing.parts.length >= 2) {
    return existing;
  }
  if (options.isDemo) {
    return existing;
  }

  if (collectionKey.startsWith('collection:movie:')) {
    const colId = Number(collectionKey.slice('collection:movie:'.length));
    if (Number.isInteger(colId) && colId > 0) {
      return indexMovieCollection(colId);
    }
  }

  if (collectionKey.startsWith('collection:tv:kw-')) {
    const kwId = Number(collectionKey.slice('collection:tv:kw-'.length));
    if (Number.isInteger(kwId) && kwId > 0) {
      const seedPart = existing?.parts[0];
      return fetchTvKeywordCollectionParts(kwId, existing?.name || 'Dizi', seedPart);
    }
  }

  return existing;
}

/**
 * Checks an item (movie or TV) and indexes its full collection/franchise into ct:series-index.
 */
export async function indexItemForSeries(item: MediaCandidateLike): Promise<void> {
  if (!item || item.id == null || item.custom) return;
  const rawId = String(item.id);
  if (!/^\d+$/.test(rawId)) return;

  const isMovie = inferMediaType(item) === 'movie';
  const mediaKey = `${isMovie ? 'movie' : 'tv'}:${rawId}`;

  const currentCol = getSeriesForMediaSync(mediaKey);
  if (currentCol && !currentCol.isStub) {
    return;
  }

  if (isMovie) {
    let collectionId: number | null =
      typeof item.belongs_to_collection === 'object' && item.belongs_to_collection
        ? item.belongs_to_collection.id
        : typeof item.belongs_to_collection === 'number'
          ? item.belongs_to_collection
          : currentCol && typeof currentCol.id === 'number'
            ? currentCol.id
            : null;

    if (!collectionId && item.belongs_to_collection === undefined && !isSeriesMediaCheckedSync(mediaKey)) {
      try {
        const details = await runBoundedSeriesTask(() => activeFetcher(`/movie/${rawId}`));
        collectionId = details?.belongs_to_collection?.id || null;
      } catch {
        collectionId = null;
      }
    }

    if (collectionId) {
      await indexMovieCollection(Number(collectionId));
    } else {
      await markSeriesMediaChecked([mediaKey]);
    }
    return;
  }

  const tvId = Number(rawId);
  for (const franchise of Object.values(KNOWN_TV_FRANCHISES)) {
    if (franchise.parts.some((p) => p.id === tvId)) {
      const existing = getSeriesForMediaSync(mediaKey);
      const seriesCol = buildKnownTvFranchiseCollection(franchise, tvId, item, existing);

      await Promise.allSettled(
        seriesCol.parts
          .filter((p) => !p.poster_path && Number(p.id) !== tvId)
          .map(async (part) => {
            try {
              const det = await runBoundedSeriesTask(() => activeFetcher(`/tv/${part.id}`));
              if (det) {
                part.poster_path = det.poster_path || part.poster_path || null;
                part.backdrop_path = det.backdrop_path || part.backdrop_path || null;
                part.overview = det.overview || part.overview || '';
                if (Number(det.vote_average) > 0) part.vote_average = Number(det.vote_average);
                if (Array.isArray(det.genres) && (!part.genre_ids || part.genre_ids.length === 0)) {
                  part.genre_ids = det.genres.map((g) => Number(g.id)).filter(Boolean);
                }
              }
            } catch {
              // Ignore sibling hydration failure
            }
          })
      );

      await registerSeriesCollections([seriesCol]);
      return;
    }
  }

  if (!isSeriesMediaCheckedSync(mediaKey) || currentCol?.isStub) {
    const indexed = await indexTvKeywordFranchise(tvId, item, false);
    if (!indexed) {
      await markSeriesMediaChecked([mediaKey]);
    }
  }
}

export async function indexItemsForSeriesBatch(items: MediaCandidateLike[]): Promise<void> {
  if (!Array.isArray(items) || items.length === 0) return;
  await Promise.allSettled(items.map((it) => indexItemForSeries(it)));
}

export function isItemInSeries(item: MediaCandidateLike | null | undefined): boolean {
  if (!item || item.id == null) return false;
  const mType = inferMediaType(item);
  const key = `${mType}:${item.id}`;
  if (isMediaInSeriesSync(key)) return true;
  if (item.belongs_to_collection) return true;
  if (typeof item.collectionName === 'string' && item.collectionName.trim()) return true;
  return false;
}

export interface UserSeriesUniverse {
  collectionKey: string;
  displayName: string;
  collection: SeriesCollection;
  userOwnedParts: SeriesCollectionPart[];
  userMissingParts: SeriesCollectionPart[];
  isStub: boolean;
}

/**
 * Computes franchise groups where the user has >= 1 owned item in savedItems.
 * Deduplicates strictly by `collectionKey` so owning X-Men 1 + X-Men 2 produces a SINGLE
 * "X-Men Serisi" group, and filters parts dynamically via `isWithinReleaseWindow`.
 */
export function computeUserSeriesUniverses(
  savedItems: SavedItem[],
  options: { includeStubs?: boolean; dislikedKeys?: string[]; hiddenKeys?: string[] } = {}
): UserSeriesUniverse[] {
  const savedByKey = new Map<string, SavedItem>();
  for (const it of savedItems || []) {
    if (!it || it.id == null) continue;
    const mType = it.media_type === 'tv' ? 'tv' : 'movie';
    savedByKey.set(`${mType}:${it.id}`, it);
  }

  const excludedSet = new Set<string>([
    ...(options.dislikedKeys || []),
    ...(options.hiddenKeys || []),
  ]);

  const allCollections = getAllSeriesCollectionsSync();
  const seenCollectionKeys = new Set<string>();
  const universes: UserSeriesUniverse[] = [];

  for (const col of allCollections) {
    const collectionKey = `collection:${col.media_type}:${col.id}`;
    if (seenCollectionKeys.has(collectionKey)) continue;
    seenCollectionKeys.add(collectionKey);

    const ownedParts: SeriesCollectionPart[] = [];
    const missingParts: SeriesCollectionPart[] = [];
    const seenPartKeys = new Set<string>();

    for (const part of col.parts) {
      const partKey = `${part.media_type}:${part.id}`;
      if (seenPartKeys.has(partKey)) continue;
      seenPartKeys.add(partKey);

      if (savedByKey.has(partKey)) {
        ownedParts.push(part);
      } else {
        const partDate = part.release_date || part.first_air_date || '';
        if (!isWithinReleaseWindow(partDate)) continue;
        if (excludedSet.has(partKey)) continue;
        missingParts.push(part);
      }
    }

    // Also detect owned items mapped via mediaKeyToSeries when collection is still a stub
    if (ownedParts.length === 0) {
      for (const pKey of col.partKeys || []) {
        const saved = savedByKey.get(pKey);
        if (saved) {
          ownedParts.push({
            id: saved.id,
            media_type: saved.media_type,
            title: saved.title || saved.name || 'Yapım',
            name: saved.name || saved.title,
            release_date: saved.release_date || '',
            first_air_date: saved.first_air_date || '',
            poster_path: saved.poster_path || null,
            vote_average: saved.vote_average,
            genre_ids: saved.genre_ids,
          });
        }
      }
    }

    if (ownedParts.length === 0) continue;

    if (missingParts.length > 0 || (options.includeStubs && col.isStub)) {
      universes.push({
        collectionKey,
        displayName: formatSeriesCollectionName(col.name),
        collection: col,
        userOwnedParts: ownedParts,
        userMissingParts: missingParts,
        isStub: Boolean(col.isStub),
      });
    }
  }

  return universes;
}

export type SeriesBatchScorerFn = (
  candidates: PoolCandidateItem[],
  tasteProfile: TasteProfileV3
) => Array<{ candidate: PoolCandidateItem; score: number }>;

/**
 * Scores a franchise group's missing parts ONCE per group (never once per owned item — FEAT-01 #1 & #7).
 */
export function scoreSeriesUniverseGroup(
  universe: UserSeriesUniverse,
  tasteProfile: TasteProfileV3,
  options: {
    genreNames?: Record<number, string>;
    mood?: string;
    scorerFn?: SeriesBatchScorerFn;
  } = {}
): TmdbItem[] {
  if (universe.userMissingParts.length === 0) return [];

  const poolCandidates: PoolCandidateItem[] = universe.userMissingParts.map((part) => {
    const dateStr = part.release_date || part.first_air_date || '';
    const voteAvg = Number(part.vote_average || 0);
    return {
      id: Number(part.id),
      media_type: part.media_type,
      title: part.title,
      name: part.name || part.title,
      overview: part.overview || '',
      poster_path: part.poster_path || null,
      backdrop_path: part.backdrop_path || null,
      release_date: part.release_date || '',
      first_air_date: part.first_air_date || '',
      vote_average: voteAvg,
      vote_count: Number(part.vote_count || 200),
      popularity: 60,
      genre_ids: Array.isArray(part.genre_ids) ? part.genre_ids : [],
      poolSource: 'collection',
      poolSources: 1,
      era: determineItemEra(dateStr),
      popularityTier: determineItemPopularityTier(60, voteAvg),
    };
  });

  const defaultScorer: SeriesBatchScorerFn = (cands, prof) =>
    scoreCandidatesV3(cands, prof, {
      weights: RECOMMENDATION_WEIGHTS_V3,
      genreNames: options.genreNames || {},
      mood: options.mood || '',
    });

  const activeScorer = options.scorerFn || defaultScorer;
  const scored = activeScorer(poolCandidates, tasteProfile);
  const scoreByKey = new Map<string, number>();
  for (const entry of scored) {
    const key = `${entry.candidate.media_type}:${entry.candidate.id}`;
    scoreByKey.set(key, entry.score);
  }

  return universe.userMissingParts.map((part) => {
    const key = `${part.media_type}:${part.id}`;
    const rawScore = scoreByKey.get(key) ?? 0;
    return {
      id: part.id,
      media_type: part.media_type,
      title: part.title,
      name: part.name || part.title,
      overview: part.overview || '',
      poster_path: part.poster_path || null,
      backdrop_path: part.backdrop_path || null,
      release_date: part.release_date || '',
      first_air_date: part.first_air_date || '',
      vote_average: part.vote_average || 0,
      vote_count: part.vote_count || 0,
      genre_ids: part.genre_ids || [],
      collectionName: universe.displayName,
      belongs_to_collection:
        part.media_type === 'movie' && typeof universe.collection.id === 'number'
          ? { id: universe.collection.id, name: universe.displayName }
          : undefined,
      tasteScore: rawScore > 0 ? Math.round(rawScore) : undefined,
      matchScore: rawScore > 0 ? Math.round(rawScore) : undefined,
    };
  });
}

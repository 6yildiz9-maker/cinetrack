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
  getAllSeriesCollectionsSync,
} from './storage-idb.ts';
import type { SavedItem } from '../core/cinetrack-core.ts';
import type { TmdbItem } from '../types/tmdb.ts';

export type TmdbFetcherFn = (path: string, params?: Record<string, string>) => Promise<any>;

let activeFetcher: TmdbFetcherFn = (path, params) => fetchTmdb(path, params);

export function setSeriesTmdbFetcher(fetcher?: TmdbFetcherFn | null): void {
  activeFetcher = fetcher || ((path, params) => fetchTmdb(path, params));
}

interface KnownTvFranchiseSeedPart {
  id: number;
  title: string;
  first_air_date?: string;
  genre_ids?: number[];
  vote_average?: number;
}

// Known TV Show franchise groupings with accurate canonical IDs & titles (fallback + instant enrichment)
const KNOWN_TV_FRANCHISES: Record<
  string,
  { id: number; name: string; parts: KnownTvFranchiseSeedPart[] }
> = {
  breaking_bad: {
    id: 90001,
    name: 'Breaking Bad Evreni',
    parts: [
      { id: 1396, title: 'Breaking Bad', first_air_date: '2008-01-20', genre_ids: [18, 80], vote_average: 8.9 },
      { id: 60059, title: 'Better Call Saul', first_air_date: '2015-02-08', genre_ids: [80, 18], vote_average: 8.7 },
    ],
  },
  game_of_thrones: {
    id: 90002,
    name: 'Westeros & Game of Thrones Evreni',
    parts: [
      { id: 1399, title: 'Game of Thrones', first_air_date: '2011-04-17', genre_ids: [10765, 18, 10759], vote_average: 8.4 },
      { id: 94997, title: 'House of the Dragon', first_air_date: '2022-08-21', genre_ids: [10765, 18, 10759], vote_average: 8.4 },
      { id: 224372, title: 'A Knight of the Seven Kingdoms', first_air_date: '2026-01-18', genre_ids: [10765, 18, 10759], vote_average: 8.0 },
    ],
  },
  walking_dead: {
    id: 90003,
    name: 'The Walking Dead Evreni',
    parts: [
      { id: 1402, title: 'The Walking Dead', first_air_date: '2010-10-31', genre_ids: [10759, 18, 10765], vote_average: 8.1 },
      { id: 62286, title: 'Fear the Walking Dead', first_air_date: '2015-08-23', genre_ids: [10759, 18], vote_average: 7.7 },
      { id: 94305, title: 'The Walking Dead: World Beyond', first_air_date: '2020-10-04', genre_ids: [18, 10765], vote_average: 7.3 },
      { id: 194583, title: 'The Walking Dead: Dead City', first_air_date: '2023-06-18', genre_ids: [10759, 18, 10765], vote_average: 8.1 },
      { id: 206586, title: 'The Walking Dead: The Ones Who Live', first_air_date: '2024-02-25', genre_ids: [10765, 18], vote_average: 8.2 },
    ],
  },
  star_wars_tv: {
    id: 90004,
    name: 'Star Wars Dizi Evreni',
    parts: [
      { id: 4194, title: 'Star Wars: The Clone Wars', first_air_date: '2008-10-03', genre_ids: [10759, 16, 10765], vote_average: 8.5 },
      { id: 82856, title: 'The Mandalorian', first_air_date: '2019-11-12', genre_ids: [10765, 10759, 18], vote_average: 8.4 },
      { id: 105971, title: 'Star Wars: The Bad Batch', first_air_date: '2021-05-04', genre_ids: [16, 10759, 10765], vote_average: 8.2 },
      { id: 92830, title: 'Obi-Wan Kenobi', first_air_date: '2022-05-26', genre_ids: [10765, 10759, 18], vote_average: 7.3 },
      { id: 83867, title: 'Andor', first_air_date: '2022-09-21', genre_ids: [10765, 10759, 18], vote_average: 8.2 },
      { id: 114461, title: 'Ahsoka', first_air_date: '2023-08-22', genre_ids: [10765, 10759, 18], vote_average: 7.7 },
    ],
  },
  marvel_tv: {
    id: 90005,
    name: 'Marvel Televizyon Evreni',
    parts: [
      { id: 61889, title: 'Daredevil', first_air_date: '2015-04-10', genre_ids: [80, 18, 10759], vote_average: 8.2 },
      { id: 85271, title: 'WandaVision', first_air_date: '2021-01-15', genre_ids: [10765, 9648, 18], vote_average: 8.2 },
      { id: 84958, title: 'Loki', first_air_date: '2021-06-09', genre_ids: [18, 10765], vote_average: 8.2 },
      { id: 88396, title: 'The Falcon and the Winter Soldier', first_air_date: '2021-03-19', genre_ids: [10759, 18], vote_average: 7.7 },
      { id: 92749, title: 'Moon Knight', first_air_date: '2022-03-30', genre_ids: [10759, 10765, 9648], vote_average: 7.8 },
    ],
  },
  star_trek_tv: {
    id: 90006,
    name: 'Star Trek Dizi Evreni',
    parts: [
      { id: 253, title: 'Star Trek', first_air_date: '1966-09-08', genre_ids: [10765, 10759], vote_average: 8.1 },
      { id: 655, title: 'Star Trek: The Next Generation', first_air_date: '1987-09-28', genre_ids: [10765, 18], vote_average: 8.4 },
      { id: 580, title: 'Star Trek: Deep Space Nine', first_air_date: '1993-01-03', genre_ids: [10765, 18], vote_average: 8.2 },
      { id: 1855, title: 'Star Trek: Voyager', first_air_date: '1995-01-16', genre_ids: [10765, 10759, 18], vote_average: 8.1 },
      { id: 67198, title: 'Star Trek: Discovery', first_air_date: '2017-09-24', genre_ids: [10765, 10759, 18], vote_average: 7.1 },
      { id: 85949, title: 'Star Trek: Picard', first_air_date: '2020-01-23', genre_ids: [10765, 10759, 18], vote_average: 7.4 },
      { id: 103516, title: 'Star Trek: Strange New Worlds', first_air_date: '2022-05-05', genre_ids: [10765, 10759, 18], vote_average: 8.3 },
    ],
  },
  the_boys: {
    id: 90007,
    name: 'The Boys Evreni',
    parts: [
      { id: 76479, title: 'The Boys', first_air_date: '2019-07-25', genre_ids: [10765, 10759], vote_average: 8.5 },
      { id: 205715, title: 'Gen V', first_air_date: '2023-09-28', genre_ids: [10765, 10759, 18], vote_average: 7.9 },
    ],
  },
};

const FRANCHISE_KEYWORD_PATTERN =
  /\b(shared universe|cinematic universe|expanded universe|universe|franchise|spin[\s-]*off|sequel|prequel|star wars|star trek|marvel|dc extended|dc universe|middle-earth|wizarding world|walking dead|westeros|game of thrones|breaking bad|the boys|witcher|avatar|dragon ball|naruto|one piece|alien|predator|jurassic|dune|lord of the rings)\b/i;

const GENERIC_NON_FRANCHISE_KEYWORDS = new Set([
  'based on novel or book',
  'based on comic',
  'based on video game',
  'based on manga',
  'based on true story',
  'superhero',
  'anime',
  'miniseries',
  'anthology',
  'sitcom',
  'remake',
]);

const processedCollectionIds = new Set<string>();
const inFlightCollectionFetches = new Set<string>();

// Bounded concurrency queue (max 3 concurrent TMDB detail/keyword checks)
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
 * Ensures series-index is loaded from IndexedDB
 */
export async function initSeriesService(): Promise<void> {
  await loadSeriesIndexIdb();
}

export function resetSeriesServiceForTests(): void {
  processedCollectionIds.clear();
  inFlightCollectionFetches.clear();
  setSeriesTmdbFetcher(null);
}

/**
 * Fetches TMDB /collection/{id} and indexes all parts into ct:series-index
 */
export async function indexMovieCollection(collectionId: number): Promise<SeriesCollection | null> {
  const colToken = `movie:${collectionId}`;
  if (!collectionId || processedCollectionIds.has(colToken)) {
    return getSeriesForMediaSync(`movie:${collectionId}`);
  }
  if (inFlightCollectionFetches.has(colToken)) return null;

  inFlightCollectionFetches.add(colToken);
  try {
    const raw = await runBoundedSeriesTask(() => activeFetcher(`/collection/${collectionId}`));
    if (!raw || !Array.isArray(raw.parts) || raw.parts.length === 0) {
      return null;
    }

    const parts: SeriesCollectionPart[] = raw.parts
      .filter((p: any) => p && p.id != null)
      .map((p: any) => ({
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

    // Sort parts chronologically by release date ascending
    parts.sort((a, b) => {
      const da = a.release_date || '9999';
      const db = b.release_date || '9999';
      return da.localeCompare(db);
    });

    const seriesCol: SeriesCollection = {
      id: collectionId,
      name: raw.name || 'Koleksiyon',
      media_type: 'movie',
      poster_path: raw.poster_path || null,
      backdrop_path: raw.backdrop_path || null,
      overview: raw.overview || '',
      parts,
      partKeys: parts.map((p) => `movie:${p.id}`),
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

async function indexTvKeywordFranchise(
  tvId: number,
  sourceItem: any
): Promise<SeriesCollection | null> {
  const kwRes = await runBoundedSeriesTask(() => activeFetcher(`/tv/${tvId}/keywords`));
  const rawKeywords: Array<{ id: number; name: string }> = Array.isArray(kwRes?.results)
    ? kwRes.results
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

  for (const kw of candidateKeywords.slice(0, 2)) {
    const colToken = `tv:kw-${kw.id}`;
    if (processedCollectionIds.has(colToken) || inFlightCollectionFetches.has(colToken)) {
      continue;
    }
    inFlightCollectionFetches.add(colToken);
    try {
      const disc = await runBoundedSeriesTask(() =>
        activeFetcher('/discover/tv', {
          with_keywords: String(kw.id),
          sort_by: 'popularity.desc',
          page: '1',
        })
      );
      const results = Array.isArray(disc?.results) ? disc.results : [];
      const mergedMap = new Map<number, SeriesCollectionPart>();

      if (sourceItem && sourceItem.id != null) {
        mergedMap.set(Number(sourceItem.id), {
          id: Number(sourceItem.id),
          media_type: 'tv',
          title: sourceItem.name || sourceItem.title || 'Dizi',
          name: sourceItem.name || sourceItem.title || 'Dizi',
          first_air_date: sourceItem.first_air_date || sourceItem.release_date || '',
          release_date: sourceItem.first_air_date || sourceItem.release_date || '',
          poster_path: sourceItem.poster_path || null,
          backdrop_path: sourceItem.backdrop_path || null,
          vote_average: Number(sourceItem.vote_average || 0),
          vote_count: Number(sourceItem.vote_count || 0),
          genre_ids: Array.isArray(sourceItem.genre_ids) ? sourceItem.genre_ids : [],
          overview: sourceItem.overview || '',
        });
      }

      for (const r of results.slice(0, 18)) {
        if (!r || r.id == null) continue;
        const rId = Number(r.id);
        mergedMap.set(rId, {
          id: rId,
          media_type: 'tv',
          title: r.name || r.title || 'Dizi',
          name: r.name || r.title || 'Dizi',
          first_air_date: r.first_air_date || '',
          release_date: r.first_air_date || '',
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
          (a.first_air_date || '9999').localeCompare(b.first_air_date || '9999')
        );
        const seriesCol: SeriesCollection = {
          id: `kw-${kw.id}`,
          name: `${kw.name} Evreni`,
          media_type: 'tv',
          poster_path: parts[0]?.poster_path || null,
          parts,
          partKeys: parts.map((p) => `tv:${p.id}`),
        };
        processedCollectionIds.add(colToken);
        await registerSeriesCollections([seriesCol]);
        return seriesCol;
      }
    } catch {
      // Try next franchise keyword if available
    } finally {
      inFlightCollectionFetches.delete(colToken);
    }
  }

  return null;
}

/**
 * Checks an item (movie or TV) and indexes its collection/franchise into ct:series-index.
 * Automatically queries TMDB /movie/{id} (belongs_to_collection) or /tv/{id}/keywords when needed.
 */
export async function indexItemForSeries(item: TmdbItem | SavedItem | any): Promise<void> {
  if (!item || item.id == null || item.custom) return;
  const rawId = String(item.id);
  if (!/^\d+$/.test(rawId)) return;

  const isMovie = item.media_type === 'movie' || (!item.media_type && Boolean(item.title));
  const mediaKey = `${isMovie ? 'movie' : 'tv'}:${rawId}`;

  if (isMediaInSeriesSync(mediaKey)) {
    return;
  }

  if (isMovie) {
    let collectionId: number | null =
      item.belongs_to_collection?.id ||
      (typeof item.belongs_to_collection === 'number' ? item.belongs_to_collection : null);

    // List endpoints (/movie/popular, /discover/movie) omit belongs_to_collection; fetch /movie/{id} once
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

  // TV Franchise check: 1) Known canonical TV universes, 2) TMDB /tv/{id}/keywords franchise lookup
  const tvId = Number(rawId);
  for (const franchise of Object.values(KNOWN_TV_FRANCHISES)) {
    if (franchise.parts.some((p) => p.id === tvId)) {
      const existing = getSeriesForMediaSync(mediaKey);
      const parts: SeriesCollectionPart[] = franchise.parts.map((seedPart) => {
        const prevPart = existing?.parts.find((ep) => Number(ep.id) === seedPart.id);
        const isCurrent = seedPart.id === tvId;
        return {
          id: seedPart.id,
          media_type: 'tv',
          title: isCurrent ? item.name || item.title || seedPart.title : prevPart?.title || seedPart.title,
          name: isCurrent ? item.name || item.title || seedPart.title : prevPart?.name || seedPart.title,
          first_air_date:
            (isCurrent ? item.first_air_date || item.release_date : prevPart?.first_air_date) ||
            seedPart.first_air_date ||
            '',
          release_date:
            (isCurrent ? item.first_air_date || item.release_date : prevPart?.release_date) ||
            seedPart.first_air_date ||
            '',
          poster_path: (isCurrent ? item.poster_path : prevPart?.poster_path) || null,
          backdrop_path: (isCurrent ? item.backdrop_path : prevPart?.backdrop_path) || null,
          vote_average: Number(
            (isCurrent ? item.vote_average : prevPart?.vote_average) || seedPart.vote_average || 0
          ),
          genre_ids:
            (isCurrent && Array.isArray(item.genre_ids) && item.genre_ids.length > 0
              ? item.genre_ids
              : prevPart?.genre_ids) ||
            seedPart.genre_ids ||
            [],
          overview: (isCurrent ? item.overview : prevPart?.overview) || '',
        };
      });

      // Best-effort poster hydration for sibling TV parts missing poster_path
      await Promise.allSettled(
        parts
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
                  part.genre_ids = det.genres.map((g: any) => Number(g.id)).filter(Boolean);
                }
              }
            } catch {}
          })
      );

      const seriesCol: SeriesCollection = {
        id: franchise.id,
        name: franchise.name,
        media_type: 'tv',
        poster_path: parts.find((p) => p.poster_path)?.poster_path || null,
        parts,
        partKeys: franchise.parts.map((p) => `tv:${p.id}`),
      };
      await registerSeriesCollections([seriesCol]);
      return;
    }
  }

  if (!isSeriesMediaCheckedSync(mediaKey)) {
    const indexed = await indexTvKeywordFranchise(tvId, item);
    if (!indexed) {
      await markSeriesMediaChecked([mediaKey]);
    }
  }
}

/**
 * Batch indexing for a list of items (e.g. user-lists or newly fetched stock)
 */
export async function indexItemsForSeriesBatch(items: any[]): Promise<void> {
  if (!Array.isArray(items) || items.length === 0) return;
  await Promise.allSettled(items.map((it) => indexItemForSeries(it)));
}

/**
 * Returns whether a given item is part of a series (sync check for MediaCard "SERİ" badge)
 */
export function isItemInSeries(item: any): boolean {
  if (!item || item.id == null) return false;
  const mType = item.media_type === 'tv' || (!item.media_type && item.name && !item.title) ? 'tv' : 'movie';
  const key = `${mType}:${item.id}`;
  if (isMediaInSeriesSync(key)) return true;
  if (item.belongs_to_collection) return true;
  return false;
}

/**
 * Finds all parts of franchises that the user has in their list, strictly for the "Seriler" sub-tab.
 * Franchises that only exist in ct:stock (0 owned parts in user-lists) are NEVER included.
 */
export interface UserSeriesUniverse {
  collection: SeriesCollection;
  userOwnedParts: SeriesCollectionPart[];
  userMissingParts: SeriesCollectionPart[];
}

export function computeUserSeriesUniverses(savedItems: SavedItem[]): UserSeriesUniverse[] {
  const savedKeys = new Set(
    (savedItems || []).map((it) => `${it.media_type === 'tv' ? 'tv' : 'movie'}:${it.id}`)
  );

  const allCollections = getAllSeriesCollectionsSync();
  const universes: UserSeriesUniverse[] = [];

  for (const col of allCollections) {
    const ownedParts: SeriesCollectionPart[] = [];
    const missingParts: SeriesCollectionPart[] = [];

    for (const part of col.parts) {
      const partKey = `${part.media_type}:${part.id}`;
      if (savedKeys.has(partKey)) {
        ownedParts.push(part);
      } else {
        missingParts.push(part);
      }
    }

    // Strict FEAT-01 #10 rule: Only include franchises where user has >= 1 item in their saved list
    if (ownedParts.length > 0 && missingParts.length > 0) {
      universes.push({
        collection: col,
        userOwnedParts: ownedParts,
        userMissingParts: missingParts,
      });
    }
  }

  return universes;
}

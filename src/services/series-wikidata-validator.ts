import { fetchTmdb } from './api.ts';
import {
  type SeriesValidationStatus,
  getSeriesValidationStatusSync,
  setSeriesItemValidation,
} from './storage-idb.ts';

export type WikidataFetcherFn = (url: string) => Promise<any>;

let activeWikidataFetcher: WikidataFetcherFn = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  return res.json();
};

let activeTmdbFetcher: (path: string) => Promise<any> = fetchTmdb;

export function setValidatorTmdbFetcher(fetcher?: ((path: string) => Promise<any>) | null): void {
  activeTmdbFetcher = fetcher || fetchTmdb;
}

export function setWikidataFetcherForTests(fetcher?: WikidataFetcherFn | null): void {
  activeWikidataFetcher =
    fetcher ||
    (async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
      return res.json();
    });
}

const inFlightValidationFetches = new Map<string, Promise<SeriesValidationStatus>>();
const MAX_VALIDATION_CONCURRENCY = 2;
let activeValidationTasks = 0;
const validationQueue: Array<() => void> = [];

async function runBoundedValidationTask<T>(fn: () => Promise<T>): Promise<T> {
  if (activeValidationTasks >= MAX_VALIDATION_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      validationQueue.push(resolve);
    });
  }
  activeValidationTasks += 1;
  try {
    return await fn();
  } finally {
    activeValidationTasks -= 1;
    const next = validationQueue.shift();
    if (next) next();
  }
}

/**
 * Three-signal series validation with Wikidata P179 ("part of the series") check (Spec Section 3.1).
 * Verifies whether a movie/series is truly part of a narrative franchise vs. a thematic/actor collection.
 */
export async function validateSeriesItemWithWikidata(
  mediaType: 'movie' | 'tv',
  id: number,
  tmdbFetcher?: (path: string) => Promise<any>
): Promise<SeriesValidationStatus> {
  const mediaKey = `${mediaType}:${id}`;
  const existingStatus = getSeriesValidationStatusSync(mediaKey);
  if (existingStatus) return existingStatus;

  if (inFlightValidationFetches.has(mediaKey)) {
    return inFlightValidationFetches.get(mediaKey)!;
  }

  const promise = (async (): Promise<SeriesValidationStatus> => {
    try {
      // 1. Get wikidata_id from TMDB external_ids endpoint
      const fetchFn = tmdbFetcher || activeTmdbFetcher;
      const extIds = await runBoundedValidationTask(() => fetchFn(`/${mediaType}/${id}/external_ids`));
      const wikidataId =
        typeof extIds?.wikidata_id === 'string' ? extIds.wikidata_id.trim() : '';

      if (!wikidataId || !/^Q\d+$/i.test(wikidataId)) {
        await setSeriesItemValidation(mediaKey, 'probable');
        return 'probable';
      }

      // 2. Query Wikidata entity claims for P179 ("part of the series")
      const wikidataUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(
        wikidataId
      )}&props=claims&format=json&origin=*`;
      const wikiData = await runBoundedValidationTask(() => activeWikidataFetcher(wikidataUrl));
      const entity = wikiData?.entities?.[wikidataId];

      if (!entity) {
        await setSeriesItemValidation(mediaKey, 'probable', wikidataId);
        return 'probable';
      }

      const claims = entity.claims || {};
      const p179Claims = claims.P179; // P179: "part of the series" property

      if (Array.isArray(p179Claims) && p179Claims.length > 0) {
        // TMDB collection + Wikidata P179 match -> verified
        await setSeriesItemValidation(mediaKey, 'verified', wikidataId);
        return 'verified';
      }

      // Lacks P179 (e.g. actor retrospective collection like "Kemal Sunal Koleksiyonu") -> probable (unverified)
      await setSeriesItemValidation(mediaKey, 'probable', wikidataId);
      return 'probable';
    } catch {
      // Safe fallback to probable on offline or network error
      await setSeriesItemValidation(mediaKey, 'probable');
      return 'probable';
    } finally {
      inFlightValidationFetches.delete(mediaKey);
    }
  })();

  inFlightValidationFetches.set(mediaKey, promise);
  return promise;
}

/**
 * Background idle worker for series parts validation.
 * Defers execution to prevent blocking foreground catalog rendering.
 */
export function scheduleSeriesPartsValidation(
  parts: Array<{ id: number | string; media_type?: string }>,
  tmdbFetcher?: (path: string) => Promise<any>
): void {
  if (typeof setTimeout === 'undefined') return;
  setTimeout(() => {
    void Promise.all(
      parts.slice(0, 4).map((p) =>
        validateSeriesItemWithWikidata(
          (p.media_type as 'movie' | 'tv') || 'movie',
          Number(p.id),
          tmdbFetcher
        )
      )
    ).catch(() => {});
  }, 250);
}

export function resetWikidataValidatorForTests(): void {
  inFlightValidationFetches.clear();
  setWikidataFetcherForTests(null);
  activeTmdbFetcher = fetchTmdb;
}

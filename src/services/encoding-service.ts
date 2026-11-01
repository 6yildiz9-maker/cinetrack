import {
  encodeItemContent,
  computeItemContentSignature,
  type ItemFeatureEncoding,
} from '../core/encoding.ts';
import {
  getStoredEncodingIdb,
  saveStoredEncodingIdb,
} from './client-depots.ts';
import { fetchTmdb } from './api.ts';

const memoryEncodingCache = new Map<string, ItemFeatureEncoding>();
const inFlightEncodingFetches = new Map<string, Promise<ItemFeatureEncoding>>();

export type EncodingFetcherFn = (path: string, params?: Record<string, string>) => Promise<any>;
let activeTmdbFetcher: EncodingFetcherFn = fetchTmdb;

export function setEncodingTmdbFetcherForTests(fetcher?: EncodingFetcherFn | null): void {
  activeTmdbFetcher = fetcher || fetchTmdb;
}

function makeEncodingStorageKey(item: any, signature: string): string {
  const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
  const id = String(item.id ?? '');
  return `${mediaType}:${id}:${signature}`;
}

export function getItemEncodingSync(item: any): ItemFeatureEncoding {
  if (!item) return encodeItemContent({});
  const signature = computeItemContentSignature(item);
  const key = makeEncodingStorageKey(item, signature);

  const cached = memoryEncodingCache.get(key);
  if (cached && cached.signature === signature) {
    return cached;
  }

  const encoded = encodeItemContent(item);
  memoryEncodingCache.set(key, encoded);
  // Async background sync to IDB
  void saveStoredEncodingIdb(key, encoded).catch(() => {});
  return encoded;
}

export async function getItemEncoding(item: any): Promise<ItemFeatureEncoding> {
  if (!item) return encodeItemContent({});
  const signature = computeItemContentSignature(item);
  const key = makeEncodingStorageKey(item, signature);

  // 1. Fast in-memory hit
  const mem = memoryEncodingCache.get(key);
  if (mem && mem.signature === signature) {
    return mem;
  }

  // 2. Dedup in-flight computation
  if (inFlightEncodingFetches.has(key)) {
    return inFlightEncodingFetches.get(key)!;
  }

  const promise = (async (): Promise<ItemFeatureEncoding> => {
    try {
      // 3. Try IndexedDB Depo 13 (ct:encodings)
      const stored = await getStoredEncodingIdb<ItemFeatureEncoding>(key);
      if (stored && stored.signature === signature) {
        memoryEncodingCache.set(key, stored);
        return stored;
      }

      // 4. Compute deterministically
      const encoded = encodeItemContent(item);
      memoryEncodingCache.set(key, encoded);
      await saveStoredEncodingIdb(key, encoded);
      return encoded;
    } finally {
      inFlightEncodingFetches.delete(key);
    }
  })();

  inFlightEncodingFetches.set(key, promise);
  return promise;
}

export async function batchGetEncodings(items: any[]): Promise<ItemFeatureEncoding[]> {
  if (!Array.isArray(items) || items.length === 0) return [];
  return Promise.all(items.map((it) => getItemEncoding(it)));
}

// Bounded enrichment worker for items lacking cast/keywords (FEAT-03 Section 3B)
const MAX_ENRICHMENT_CONCURRENCY = 2;
let activeEnrichmentTasks = 0;
const enrichmentQueue: Array<() => void> = [];
const enrichedItemKeys = new Set<string>();

async function runBoundedEnrichmentTask<T>(fn: () => Promise<T>): Promise<T> {
  if (activeEnrichmentTasks >= MAX_ENRICHMENT_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      enrichmentQueue.push(resolve);
    });
  }
  activeEnrichmentTasks += 1;
  try {
    return await fn();
  } finally {
    activeEnrichmentTasks -= 1;
    const next = enrichmentQueue.shift();
    if (next) next();
  }
}

export interface EnrichedMetadataResult {
  cast?: Array<{ id: number; name: string; character?: string }>;
  crew?: Array<{ id: number; name: string; job?: string }>;
  keywords?: Array<{ id: number; name: string }>;
}

/**
 * Enriches a single item's metadata (cast + keywords) lazily if missing.
 * Strict quota: only called for visible graph nodes or active shelf items, never bulk 1000 items!
 */
export async function enrichItemMetadataLazy(
  mediaType: 'movie' | 'tv',
  id: number
): Promise<EnrichedMetadataResult | null> {
  const itemKey = `${mediaType}:${id}`;
  if (enrichedItemKeys.has(itemKey)) return null;
  enrichedItemKeys.add(itemKey);

  try {
    const [creditsRes, keywordsRes] = await Promise.allSettled([
      runBoundedEnrichmentTask(() => activeTmdbFetcher(`/${mediaType}/${id}/credits`)),
      runBoundedEnrichmentTask(() => activeTmdbFetcher(`/${mediaType}/${id}/keywords`)),
    ]);

    const credits = creditsRes.status === 'fulfilled' ? creditsRes.value : null;
    const kw = keywordsRes.status === 'fulfilled' ? keywordsRes.value : null;

    const cast = Array.isArray(credits?.cast)
      ? credits.cast.slice(0, 10).map((c: any) => ({
          id: Number(c.id),
          name: String(c.name || ''),
          character: c.character ? String(c.character) : undefined,
        }))
      : [];

    const crew = Array.isArray(credits?.crew)
      ? credits.crew.slice(0, 5).map((c: any) => ({
          id: Number(c.id),
          name: String(c.name || ''),
          job: c.job ? String(c.job) : undefined,
        }))
      : [];

    const keywords = Array.isArray(kw?.keywords)
      ? kw.keywords.slice(0, 15).map((k: any) => ({ id: Number(k.id), name: String(k.name || '') }))
      : Array.isArray(kw?.results)
        ? kw.results.slice(0, 15).map((k: any) => ({ id: Number(k.id), name: String(k.name || '') }))
        : [];

    return { cast, crew, keywords };
  } catch (err) {
    console.warn(`[EncodingService] Enrichment failed for ${itemKey}:`, err);
    return null;
  }
}

export function resetEncodingServiceForTests(): void {
  memoryEncodingCache.clear();
  inFlightEncodingFetches.clear();
  enrichedItemKeys.clear();
  activeTmdbFetcher = fetchTmdb;
}

export function getEncodingServiceMetricsForTests() {
  return {
    cacheSize: memoryEncodingCache.size,
    inFlightCount: inFlightEncodingFetches.size,
  };
}

export { makeEncodingStorageKey };

import {
  encodeItemContent,
  computeItemContentSignature,
  ENCODING_LAYOUT_VERSION,
  DENSE_VECTOR_DIM,
  type ItemFeatureEncoding,
} from '../core/encoding.ts';
import {
  getStoredEncodingIdb,
  saveStoredEncodingIdb,
  getAllStoredEncodingsIdb,
  clearManyStoredEncodingsIdb,
  clearAllStoredEncodingsIdb,
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
  const mediaType = item?.media_type || (item?.title ? 'movie' : 'tv');
  const id = String(item?.id ?? '');
  return `v${ENCODING_LAYOUT_VERSION}:${mediaType}:${id}:${signature}`;
}

function isValidStoredEncoding(
  candidate: ItemFeatureEncoding | null | undefined,
  expectedSignature: string
): candidate is ItemFeatureEncoding {
  return Boolean(
    candidate &&
      candidate.signature === expectedSignature &&
      candidate.layoutVersion === ENCODING_LAYOUT_VERSION &&
      Array.isArray(candidate.denseVector) &&
      candidate.denseVector.length === DENSE_VECTOR_DIM &&
      candidate.denseVector.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

export function getItemEncodingSync(item: any): ItemFeatureEncoding {
  if (!item) return encodeItemContent({});
  const signature = computeItemContentSignature(item);
  const key = makeEncodingStorageKey(item, signature);

  const cached = memoryEncodingCache.get(key);
  if (isValidStoredEncoding(cached, signature)) {
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
  if (isValidStoredEncoding(mem, signature)) {
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
      if (isValidStoredEncoding(stored, signature)) {
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

let encodingWorker: Worker | null = null;
let nextWorkerTaskId = 1;
const pendingWorkerRequests = new Map<number, (results: ItemFeatureEncoding[]) => void>();

function getOrCreateEncodingWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (!encodingWorker) {
    try {
      encodingWorker = new Worker(new URL('../workers/encoding.worker.ts', import.meta.url), {
        type: 'module',
      });
      encodingWorker.onmessage = (event: MessageEvent<{ taskId: number; results: ItemFeatureEncoding[] }>) => {
        const { taskId, results } = event.data || {};
        const resolver = pendingWorkerRequests.get(taskId);
        if (resolver) {
          pendingWorkerRequests.delete(taskId);
          resolver(results);
        }
      };
      encodingWorker.onerror = () => {
        encodingWorker?.terminate();
        encodingWorker = null;
      };
    } catch {
      encodingWorker = null;
    }
  }
  return encodingWorker;
}

export async function batchGetEncodings(items: any[]): Promise<ItemFeatureEncoding[]> {
  if (!Array.isArray(items) || items.length === 0) return [];
  
  if (items.length < 20) {
    return Promise.all(items.map((it) => getItemEncoding(it)));
  }

  const results: ItemFeatureEncoding[] = [];
  const uncachedItems: any[] = [];
  const uncachedIndices: number[] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const sig = computeItemContentSignature(it);
    const key = makeEncodingStorageKey(it, sig);
    const cached = memoryEncodingCache.get(key);
    if (isValidStoredEncoding(cached, sig)) {
      results[i] = cached;
    } else {
      uncachedItems.push(it);
      uncachedIndices.push(i);
    }
  }

  if (uncachedItems.length === 0) {
    return results;
  }

  const worker = uncachedItems.length >= 10 ? getOrCreateEncodingWorker() : null;
  if (worker) {
    const taskId = nextWorkerTaskId++;
    const workerPromise = new Promise<ItemFeatureEncoding[]>((resolve) => {
      pendingWorkerRequests.set(taskId, resolve);
      worker.postMessage({ taskId, items: uncachedItems });
    });

    const computed = await workerPromise;
    for (let j = 0; j < computed.length; j++) {
      const enc = computed[j];
      const origItem = uncachedItems[j];
      const origIndex = uncachedIndices[j];
      results[origIndex] = enc;

      const key = makeEncodingStorageKey(origItem, enc.signature);
      memoryEncodingCache.set(key, enc);
      void saveStoredEncodingIdb(key, enc).catch(() => {});
    }
    return results;
  }

  const computedFallback = await Promise.all(uncachedItems.map((it) => getItemEncoding(it)));
  for (let j = 0; j < computedFallback.length; j++) {
    results[uncachedIndices[j]] = computedFallback[j];
  }
  return results;
}

export const ENCODINGS_DEPOT_MAX_ENTRIES = 3000;

export async function maintainEncodingsDepot(maxEntries: number = ENCODINGS_DEPOT_MAX_ENTRIES): Promise<{
  scanned: number;
  prunedStaleSignatures: number;
  prunedLru: number;
  remaining: number;
}> {
  try {
    const all = await getAllStoredEncodingsIdb<ItemFeatureEncoding>();
    const scanned = all.length;
    if (scanned === 0) {
      return { scanned: 0, prunedStaleSignatures: 0, prunedLru: 0, remaining: 0 };
    }

    const itemLatestSignatures = new Map<string, { key: string; encodedAt: number; signature: string }>();
    const keysToDelete: string[] = [];

    for (const [key, enc] of all) {
      if (!enc || typeof enc !== 'object') {
        keysToDelete.push(key);
        continue;
      }
      // Prune legacy 47-dim vectors or mismatched layoutVersion records (REG-02/03)
      const hasLegacyVector =
        Array.isArray(enc.denseVector) &&
        (enc.denseVector.length !== DENSE_VECTOR_DIM ||
          enc.layoutVersion !== ENCODING_LAYOUT_VERSION ||
          !enc.denseVector.every((v) => typeof v === 'number' && Number.isFinite(v)));
      const hasMismatchedVersion =
        enc.layoutVersion !== undefined && enc.layoutVersion !== ENCODING_LAYOUT_VERSION;
      if (hasLegacyVector || hasMismatchedVersion) {
        keysToDelete.push(key);
        continue;
      }
      const mediaKey = `${enc.media_type || 'movie'}:${enc.id}`;
      const encodedAtMs = enc.encodedAt ? new Date(enc.encodedAt).getTime() : 0;
      const existing = itemLatestSignatures.get(mediaKey);
      if (!existing) {
        itemLatestSignatures.set(mediaKey, { key, encodedAt: encodedAtMs, signature: enc.signature });
      } else {
        if (encodedAtMs > existing.encodedAt) {
          keysToDelete.push(existing.key);
          itemLatestSignatures.set(mediaKey, { key, encodedAt: encodedAtMs, signature: enc.signature });
        } else {
          keysToDelete.push(key);
        }
      }
    }

    const prunedStaleSignatures = keysToDelete.length;
    const survivingEntries = all.filter(([k]) => !keysToDelete.includes(k));

    // Depot'ta duran geçerli vektörler bellek önbelleğine alınır. Aksi hâlde açılışta
    // getItemEncodingSync hiçbir kaydı bulamaz ve Listem'in tamamını yeniden kodlar
    // (bindlerce encode + IDB yazması = donma).
    for (const [key, enc] of survivingEntries) {
      if (!memoryEncodingCache.has(key)) {
        memoryEncodingCache.set(key, enc);
      }
    }

    let prunedLru = 0;
    if (survivingEntries.length > maxEntries) {
      survivingEntries.sort((a, b) => {
        const timeA = a[1]?.encodedAt ? new Date(a[1].encodedAt).getTime() : 0;
        const timeB = b[1]?.encodedAt ? new Date(b[1].encodedAt).getTime() : 0;
        return timeA - timeB;
      });
      const overflowCount = survivingEntries.length - maxEntries;
      const lruKeys = survivingEntries.slice(0, overflowCount).map(([k]) => k);
      keysToDelete.push(...lruKeys);
      prunedLru = lruKeys.length;
    }

    if (keysToDelete.length > 0) {
      for (const k of keysToDelete) {
        memoryEncodingCache.delete(k);
      }
      await clearManyStoredEncodingsIdb(keysToDelete);
    }

    if (memoryEncodingCache.size > maxEntries) {
      const keysToDrop = Array.from(memoryEncodingCache.keys()).slice(0, memoryEncodingCache.size - maxEntries);
      for (const k of keysToDrop) {
        memoryEncodingCache.delete(k);
      }
    }

    return {
      scanned,
      prunedStaleSignatures,
      prunedLru,
      remaining: scanned - keysToDelete.length,
    };
  } catch (err) {
    console.warn('[EncodingService] Depot maintenance error:', err);
    return { scanned: 0, prunedStaleSignatures: 0, prunedLru: 0, remaining: 0 };
  }
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
  if (encodingWorker) {
    try {
      encodingWorker.terminate();
    } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
    encodingWorker = null;
  }
  pendingWorkerRequests.clear();
}

export function getEncodingServiceMetricsForTests() {
  return {
    cacheSize: memoryEncodingCache.size,
    inFlightCount: inFlightEncodingFetches.size,
  };
}

export async function clearAllEncodingsCache(): Promise<{ cleared: boolean; error?: string }> {
  memoryEncodingCache.clear();
  inFlightEncodingFetches.clear();
  enrichedItemKeys.clear();
  const res = await clearAllStoredEncodingsIdb();
  return { cleared: res.persisted, error: res.error };
}

export { makeEncodingStorageKey };

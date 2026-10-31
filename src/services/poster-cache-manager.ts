import { get, set, del, createStore, type UseStore } from 'idb-keyval';

/**
 * Client-side poster cache quota manager (EXT-03)
 * Enforces maximum 200 MiB budget for poster images in the Cache API (`cinetrack-tmdb-posters`)
 * with strict Least-Recently-Used (LRU) eviction and Service Worker coordination.
 */
export const POSTER_CACHE_NAME = 'cinetrack-tmdb-posters';
export const MAX_POSTER_CACHE_BYTES = 200 * 1024 * 1024; // 200 MiB
export const TARGET_POSTER_CACHE_BYTES = 160 * 1024 * 1024; // 160 MiB post-purge target
const DEFAULT_POSTER_ESTIMATE_BYTES = 40 * 1024; // ~40 KB fallback for opaque responses

export interface PosterLruMeta {
  lastAccessed: number;
  size: number;
}

export interface PosterCacheStats {
  entryCount: number;
  totalSizeBytes: number;
  totalSizeMb: string;
  isOverBudget: boolean;
}

let posterMetaStore: UseStore | undefined;
const memoryPosterMeta = new Map<string, PosterLruMeta>();

function getPosterMetaStore(): UseStore | undefined {
  if (typeof indexedDB === 'undefined') return undefined;
  if (!posterMetaStore) {
    posterMetaStore = createStore('cinetrack-poster-lru-db', 'ct_poster_lru');
  }
  return posterMetaStore;
}

export async function recordPosterAccess(
  url: string,
  sizeBytes?: number,
  accessedAt: number = Date.now()
): Promise<void> {
  if (!url) return;
  const existing = await readPosterMeta(url);
  const next: PosterLruMeta = {
    lastAccessed: accessedAt,
    size:
      typeof sizeBytes === 'number' && sizeBytes > 0
        ? sizeBytes
        : existing?.size || 0,
  };
  memoryPosterMeta.set(url, next);
  const store = getPosterMetaStore();
  if (store) {
    try {
      await set(url, next, store);
    } catch {}
  }
}

async function readPosterMeta(url: string): Promise<PosterLruMeta | null> {
  const store = getPosterMetaStore();
  if (store) {
    try {
      const val = await get<PosterLruMeta>(url, store);
      if (val) {
        memoryPosterMeta.set(url, val);
        return val;
      }
    } catch {}
  }
  return memoryPosterMeta.get(url) || null;
}

async function deletePosterMeta(url: string): Promise<void> {
  memoryPosterMeta.delete(url);
  const store = getPosterMetaStore();
  if (store) {
    try {
      await del(url, store);
    } catch {}
  }
}

async function measureCachedResponseBytes(res: Response, meta: PosterLruMeta | null): Promise<number> {
  const cl = res.headers?.get?.('content-length');
  if (cl && Number(cl) > 0) {
    return Number(cl);
  }
  if (meta && meta.size > 0) {
    return meta.size;
  }
  if (res.type !== 'opaque' && typeof res.clone === 'function') {
    try {
      const buf = await res.clone().arrayBuffer();
      if (buf && buf.byteLength > 0) {
        return buf.byteLength;
      }
    } catch {}
  }
  return DEFAULT_POSTER_ESTIMATE_BYTES;
}

export async function inspectPosterCache(): Promise<PosterCacheStats> {
  if (typeof caches === 'undefined') {
    return { entryCount: 0, totalSizeBytes: 0, totalSizeMb: '0.00', isOverBudget: false };
  }

  try {
    const cache = await caches.open(POSTER_CACHE_NAME);
    const requests = await cache.keys();
    let totalBytes = 0;

    for (const req of requests) {
      const res = await cache.match(req);
      if (res) {
        const url = typeof req === 'string' ? req : req.url;
        const meta = await readPosterMeta(url);
        totalBytes += await measureCachedResponseBytes(res, meta);
      }
    }

    return {
      entryCount: requests.length,
      totalSizeBytes: totalBytes,
      totalSizeMb: (totalBytes / (1024 * 1024)).toFixed(2),
      isOverBudget: totalBytes > MAX_POSTER_CACHE_BYTES,
    };
  } catch (err) {
    console.warn('[PosterCache] Cache inspection error:', err);
    return { entryCount: 0, totalSizeBytes: 0, totalSizeMb: '0.00', isOverBudget: false };
  }
}

/**
 * Enforces the 200 MiB limit on the poster cache by evicting least-recently-used entries (LRU purge)
 */
export async function enforcePosterCacheQuota(
  maxBytes: number = MAX_POSTER_CACHE_BYTES,
  targetBytes: number = TARGET_POSTER_CACHE_BYTES
): Promise<{ purgedCount: number; freedBytes: number; remainingBytes: number }> {
  if (typeof caches === 'undefined') {
    return { purgedCount: 0, freedBytes: 0, remainingBytes: 0 };
  }

  try {
    const cache = await caches.open(POSTER_CACHE_NAME);
    const requests = await cache.keys();
    if (requests.length === 0) return { purgedCount: 0, freedBytes: 0, remainingBytes: 0 };

    const entries: Array<{ req: Request; url: string; size: number; lastAccessed: number; order: number }> = [];
    let totalBytes = 0;

    for (let i = 0; i < requests.length; i += 1) {
      const req = requests[i];
      const res = await cache.match(req);
      if (!res) continue;

      const url = typeof req === 'string' ? req : req.url;
      const meta = await readPosterMeta(url);
      const size = await measureCachedResponseBytes(res, meta);
      totalBytes += size;

      const dateHeader = res.headers?.get?.('date');
      const parsedDate = dateHeader ? Date.parse(dateHeader) : NaN;
      const lastAccessed =
        meta?.lastAccessed ??
        (Number.isFinite(parsedDate) ? parsedDate : 0);

      entries.push({ req, url, size, lastAccessed, order: i });
    }

    if (totalBytes <= maxBytes) {
      return { purgedCount: 0, freedBytes: 0, remainingBytes: totalBytes };
    }

    // Sort strictly by lastAccessed ascending (oldest accessed first — LRU), preserving insertion order on ties
    entries.sort((a, b) => a.lastAccessed - b.lastAccessed || a.order - b.order);

    let purgedCount = 0;
    let freedBytes = 0;

    for (const entry of entries) {
      if (totalBytes - freedBytes <= targetBytes) {
        break;
      }
      await cache.delete(entry.req);
      await deletePosterMeta(entry.url);
      freedBytes += entry.size;
      purgedCount += 1;
    }

    return {
      purgedCount,
      freedBytes,
      remainingBytes: Math.max(0, totalBytes - freedBytes),
    };
  } catch (err) {
    console.warn('[PosterCache] Kota temizleme hatası:', err);
    return { purgedCount: 0, freedBytes: 0, remainingBytes: 0 };
  }
}

export function requestServiceWorkerPosterPurge(): void {
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'ENFORCE_POSTER_QUOTA' });
    }
  } catch {}
}

export function resetPosterMetaForTests(): void {
  memoryPosterMeta.clear();
}

/**
 * Client-side poster cache quota manager (EXT-03)
 * Enforces maximum 200 MiB budget for poster images in the Cache API with LRU eviction.
 */
export const MAX_POSTER_CACHE_BYTES = 200 * 1024 * 1024; // 200 MiB
export const TARGET_POSTER_CACHE_BYTES = 160 * 1024 * 1024; // 160 MiB post-purge target

export interface PosterCacheStats {
  entryCount: number;
  totalSizeBytes: number;
  totalSizeMb: string;
  isOverBudget: boolean;
}

export async function inspectPosterCache(): Promise<PosterCacheStats> {
  if (typeof caches === 'undefined') {
    return { entryCount: 0, totalSizeBytes: 0, totalSizeMb: '0.00', isOverBudget: false };
  }

  try {
    const cache = await caches.open('cinetrack-tmdb-posters');
    const requests = await cache.keys();
    let totalBytes = 0;

    for (const req of requests) {
      const res = await cache.match(req);
      if (res) {
        const cl = res.headers.get('content-length');
        if (cl && Number(cl) > 0) {
          totalBytes += Number(cl);
        } else {
          // Approximate size if content-length header is not exposed
          totalBytes += 40 * 1024; // ~40 KB average for w185/w342 webp/jpeg
        }
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
 * Enforces the 200 MiB limit on the poster cache by evicting oldest entries (LRU purge)
 */
export async function enforcePosterCacheQuota(): Promise<{ purgedCount: number; freedBytes: number }> {
  if (typeof caches === 'undefined') {
    return { purgedCount: 0, freedBytes: 0 };
  }

  try {
    const cache = await caches.open('cinetrack-tmdb-posters');
    const requests = await cache.keys();
    if (requests.length === 0) return { purgedCount: 0, freedBytes: 0 };

    const entries: { req: Request; size: number; timestamp: number }[] = [];
    let totalBytes = 0;

    for (const req of requests) {
      const res = await cache.match(req);
      if (!res) continue;

      const cl = res.headers.get('content-length');
      const size = cl && Number(cl) > 0 ? Number(cl) : 40 * 1024;
      totalBytes += size;

      const dateHeader = res.headers.get('date');
      const timestamp = dateHeader ? new Date(dateHeader).getTime() : Date.now();
      entries.push({ req, size, timestamp });
    }

    if (totalBytes <= MAX_POSTER_CACHE_BYTES) {
      return { purgedCount: 0, freedBytes: 0 };
    }

    // Sort by timestamp ascending (oldest first - LRU)
    entries.sort((a, b) => a.timestamp - b.timestamp);

    let purgedCount = 0;
    let freedBytes = 0;

    for (const entry of entries) {
      if (totalBytes - freedBytes <= TARGET_POSTER_CACHE_BYTES) {
        break;
      }
      await cache.delete(entry.req);
      freedBytes += entry.size;
      purgedCount += 1;
    }

    console.info(
      `[PosterCache] LRU kota temizliği tamamlandı: ${purgedCount} poster silindi, ${(freedBytes / (1024 * 1024)).toFixed(2)} MiB alan kazanıldı.`
    );

    return { purgedCount, freedBytes };
  } catch (err) {
    console.warn('[PosterCache] Kota temizleme hatası:', err);
    return { purgedCount: 0, freedBytes: 0 };
  }
}

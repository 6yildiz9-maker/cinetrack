import { cosineSimilarity, type ItemFeatureEncoding } from '../core/encoding.ts';
import {
  ENCODINGS_DEPOT_MAX_ENTRIES,
  getItemEncodingSync,
} from './encoding-service.ts';
import { getAllStoredEncodingsIdb } from './client-depots.ts';
import {
  inspectPosterCache,
  MAX_POSTER_CACHE_BYTES,
} from './poster-cache-manager.ts';
import { getCurrentStock, STOCK_TARGET_COUNT } from './stock-engine.ts';
import { loadStockIdb } from './storage-idb.ts';
import { getIdleEnrichmentQuotaState } from './idle-enrichment-service.ts';
import type { TmdbItem } from '../types/tmdb.ts';

export interface StockHealthMetrics {
  moviesCount: number;
  tvCount: number;
  totalStockCount: number;
  targetTotalCount: number;
  avgPairwiseSimilarity: number;
  diversityScorePercent: number;
  clusterThresholdCompliant: boolean;
  encodedFillCount: number;
  encodedFillPercent: number;
  enrichedCreditsCount: number;
  enrichedCreditsPercent: number;
  encodingsDepotCount: number;
  encodingsDepotMax: number;
  encodingsUsagePercent: number;
  posterCacheCount: number;
  posterCacheSizeMb: string;
  posterCacheMaxMb: number;
  posterCacheUsagePercent: number;
  idleQuotaUsed: number;
  idleQuotaLimit: number;
}

function sampleDeterministically(items: TmdbItem[], maxSample: number): TmdbItem[] {
  if (items.length <= maxSample) return items;
  const out: TmdbItem[] = [];
  const step = items.length / maxSample;
  for (let i = 0; i < maxSample; i += 1) {
    const idx = Math.min(items.length - 1, Math.floor(i * step));
    out.push(items[idx]);
  }
  return out;
}

/**
 * Computes comprehensive Stock Quality & Depot Health metrics for Controls > Stok Kalitesi panel (IMP-13):
 * - Post-MMR average pairwise similarity & diversity percentage
 * - Feature encoding & rich credits/keywords fill rate across ct:stock
 * - ct:encodings depot usage and poster Cache API (200 MiB) usage
 */
export async function computeStockHealthMetrics(options?: {
  moviesOverride?: TmdbItem[];
  tvOverride?: TmdbItem[];
}): Promise<StockHealthMetrics> {
  let movies = options?.moviesOverride;
  let tv = options?.tvOverride;

  if (!movies || !tv) {
    let stock = getCurrentStock();
    if (stock.movies.length === 0 && stock.tv.length === 0) {
      stock = await loadStockIdb();
    }
    movies = stock.movies;
    tv = stock.tv;
  }

  const normalizedMovies = movies.map((m) => ({ ...m, media_type: 'movie' as const }));
  const normalizedTv = tv.map((t) => ({ ...t, media_type: 'tv' as const }));
  const combined: TmdbItem[] = [...normalizedMovies, ...normalizedTv];
  const totalStockCount = combined.length;
  const targetTotalCount = STOCK_TARGET_COUNT * 2;

  // Check stored encodings in ct:encodings
  const storedEncodings = await getAllStoredEncodingsIdb<ItemFeatureEncoding>();
  const storedMediaKeys = new Set<string>();
  for (const [, enc] of storedEncodings) {
    if (enc && enc.id != null) {
      storedMediaKeys.add(`${enc.media_type || 'movie'}:${enc.id}`);
    }
  }

  let encodedFillCount = 0;
  let enrichedCreditsCount = 0;
  for (const item of combined) {
    const mType = item.media_type === 'tv' ? 'tv' : 'movie';
    const key = `${mType}:${item.id}`;
    const hasBasicVectorFields =
      Array.isArray(item.genre_ids) && item.genre_ids.length > 0 && Boolean(item.title || item.name);
    if (storedMediaKeys.has(key) || hasBasicVectorFields) {
      encodedFillCount += 1;
    }

    const itemWithKw = item as TmdbItem & { keywords?: Array<{ id: number; name: string }> };
    const hasRichMeta =
      (Array.isArray(item.cast) && item.cast.length > 0) ||
      (Array.isArray(item.topCastIds) && item.topCastIds.length > 0) ||
      (Array.isArray(item.crew) && item.crew.length > 0) ||
      (Array.isArray(itemWithKw.keywords) && itemWithKw.keywords.length > 0);
    if (hasRichMeta) {
      enrichedCreditsCount += 1;
    }
  }

  // Deterministic sample of up to 60 items for fast pairwise similarity calculation
  const sampled = sampleDeterministically(combined, 60);
  const vectors = sampled.map((it) => getItemEncodingSync(it).denseVector);
  let simSum = 0;
  let pairCount = 0;
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      simSum += cosineSimilarity(vectors[i], vectors[j]);
      pairCount += 1;
    }
  }

  const avgPairwiseSimilarity =
    pairCount > 0 ? Math.round((simSum / pairCount) * 1000) / 1000 : 0;
  const diversityScorePercent =
    pairCount > 0 ? Math.max(0, Math.min(100, Math.round((1 - avgPairwiseSimilarity) * 100))) : 100;

  const posterStats = await inspectPosterCache();
  const posterMaxMb = Math.round(MAX_POSTER_CACHE_BYTES / (1024 * 1024));
  const posterUsagePercent = Math.min(
    100,
    Math.round((posterStats.totalSizeBytes / MAX_POSTER_CACHE_BYTES) * 100)
  );

  const encodingsDepotCount = storedEncodings.length;
  const encodingsUsagePercent = Math.min(
    100,
    Math.round((encodingsDepotCount / ENCODINGS_DEPOT_MAX_ENTRIES) * 100)
  );

  const idleQuota = getIdleEnrichmentQuotaState();

  return {
    moviesCount: normalizedMovies.length,
    tvCount: normalizedTv.length,
    totalStockCount,
    targetTotalCount,
    avgPairwiseSimilarity,
    diversityScorePercent,
    clusterThresholdCompliant: avgPairwiseSimilarity < 0.88,
    encodedFillCount,
    encodedFillPercent:
      totalStockCount > 0 ? Math.round((encodedFillCount / totalStockCount) * 100) : 0,
    enrichedCreditsCount,
    enrichedCreditsPercent:
      totalStockCount > 0 ? Math.round((enrichedCreditsCount / totalStockCount) * 100) : 0,
    encodingsDepotCount,
    encodingsDepotMax: ENCODINGS_DEPOT_MAX_ENTRIES,
    encodingsUsagePercent,
    posterCacheCount: posterStats.entryCount,
    posterCacheSizeMb: posterStats.totalSizeMb,
    posterCacheMaxMb: posterMaxMb,
    posterCacheUsagePercent: posterUsagePercent,
    idleQuotaUsed: idleQuota.usedCount,
    idleQuotaLimit: idleQuota.dailyLimit,
  };
}

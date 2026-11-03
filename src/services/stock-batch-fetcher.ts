import type { TmdbCastMember, TmdbItem } from '../types/tmdb.ts';
import { isWithinReleaseWindow } from '../utils/release-window.ts';
import { getItemEncodingSync } from './encoding-service.ts';
import { cosineSimilarity } from '../core/encoding.ts';
import { extractTopThreeCastIds, normalizeRawStockId } from './stock-filter.ts';

export interface TmdbPagePayload {
  page?: number;
  total_pages?: number;
  results?: TmdbItem[];
  id?: number | string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  genre_ids?: number[];
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  credits?: { cast?: TmdbCastMember[] };
  cast?: TmdbCastMember[];
  topCastIds?: number[];
}

export type StockTmdbFetcher = (
  path: string,
  params?: Record<string, string>
) => Promise<TmdbPagePayload>;

export interface CandidateBatchSkipStats {
  userExclusionKeys: ReadonlySet<string>;
  existingStockKeys: Set<string>;
  skippedListedCount: number;
  skippedDuplicateStockCount: number;
}

export function normalizeStockCandidate(raw: TmdbItem, mediaType: 'movie' | 'tv'): TmdbItem {
  const topCastIds = extractTopThreeCastIds(raw);
  return {
    ...raw,
    media_type: mediaType,
    ...(topCastIds ? { topCastIds } : {}),
  };
}

export function isStockCandidateDateAcceptable(item: TmdbItem): boolean {
  const rawDate = item.release_date || item.first_air_date;
  if (typeof rawDate === 'string' && rawDate.trim()) return isWithinReleaseWindow(rawDate);
  return item.status !== 'Planned' && item.status !== 'Rumored';
}

export async function fetchStockCandidateBatch(
  fetcher: StockTmdbFetcher,
  mediaType: 'movie' | 'tv',
  targetNeeded: number,
  excludedKeys: Set<string>,
  cursors: Record<string, number>,
  recyclableKeySet?: Set<string>,
  seenRecyclableOut?: Map<string, TmdbItem>,
  skipStats?: CandidateBatchSkipStats
): Promise<TmdbItem[]> {
  const result: TmdbItem[] = [];
  const overflowClusterBuffer: TmdbItem[] = [];
  const recentVectors: number[][] = [];
  const MAX_RECENT_VECTORS = 25;
  const CLUSTER_SIMILARITY_THRESHOLD = 0.88;

  const endpoints: Array<{
    cursorKey: string;
    path: string;
    params?: Record<string, string>;
    maxPages: number;
  }> = [
    { cursorKey: `${mediaType}:popular`, path: `/${mediaType}/popular`, maxPages: 20 },
    { cursorKey: `${mediaType}:top_rated`, path: `/${mediaType}/top_rated`, maxPages: 20 },
    {
      cursorKey: `${mediaType}:discover_pop`,
      path: `/discover/${mediaType}`,
      params: { sort_by: 'popularity.desc', 'vote_count.gte': '80' },
      maxPages: 25,
    },
    {
      cursorKey: `${mediaType}:discover_vote`,
      path: `/discover/${mediaType}`,
      params: { sort_by: 'vote_average.desc', 'vote_count.gte': '250' },
      maxPages: 20,
    },
    { cursorKey: `${mediaType}:trending`, path: `/trending/${mediaType}/week`, maxPages: 10 },
  ];

  for (const ep of endpoints) {
    if (result.length >= targetNeeded) break;

    const startPage = Math.max(1, Number(cursors[ep.cursorKey]) || 1);
    let knownMaxPage = 50;
    for (let offset = 0; offset < ep.maxPages; offset += 1) {
      if (result.length >= targetNeeded) break;

      const page = ((startPage - 1 + offset) % knownMaxPage) + 1;
      try {
        const queryParams: Record<string, string> = {
          page: String(page),
          ...(ep.params || {}),
        };
        const res = await fetcher(ep.path, queryParams);
        const items = Array.isArray(res?.results) ? res.results : [];
        if (items.length === 0) break;

        knownMaxPage = Math.min(50, Math.max(1, Number(res?.total_pages) || 50));
        let addedFromPage = 0;
        let examinedCount = 0;

        for (const it of items) {
          examinedCount += 1;
          if (!it || it.id == null || !isStockCandidateDateAcceptable(it)) continue;
          const rawId = normalizeRawStockId(it.id);
          if (!rawId) continue;
          const typedKey = `${mediaType}:${rawId}`;
          const legacyKey = `${mediaType}-${rawId}`;

          if (
            recyclableKeySet?.has(typedKey) &&
            seenRecyclableOut &&
            !seenRecyclableOut.has(typedKey)
          ) {
            seenRecyclableOut.set(typedKey, normalizeStockCandidate(it, mediaType));
          }

          if (skipStats?.existingStockKeys.has(typedKey)) {
            skipStats.skippedDuplicateStockCount += 1;
            continue;
          }
          if (
            skipStats?.userExclusionKeys.has(typedKey) ||
            skipStats?.userExclusionKeys.has(legacyKey) ||
            skipStats?.userExclusionKeys.has(rawId)
          ) {
            skipStats.skippedListedCount += 1;
            continue;
          }
          if (
            excludedKeys.has(typedKey) ||
            excludedKeys.has(legacyKey) ||
            excludedKeys.has(rawId)
          ) {
            continue;
          }

          const normalized = normalizeStockCandidate(it, mediaType);
          excludedKeys.add(typedKey);
          skipStats?.existingStockKeys.add(typedKey);

          const candEnc = getItemEncodingSync(normalized);
          let isTooSimilar = false;
          if (recentVectors.length > 0 && candEnc?.denseVector?.length) {
            for (const v of recentVectors) {
              const sim = cosineSimilarity(v, candEnc.denseVector);
              if (sim > CLUSTER_SIMILARITY_THRESHOLD) {
                isTooSimilar = true;
                break;
              }
            }
          }

          if (isTooSimilar) {
            overflowClusterBuffer.push(normalized);
          } else {
            result.push(normalized);
            if (candEnc?.denseVector?.length) {
              recentVectors.push(candEnc.denseVector);
              if (recentVectors.length > MAX_RECENT_VECTORS) {
                recentVectors.shift();
              }
            }
            addedFromPage += 1;
          }

          if (result.length >= targetNeeded) break;
        }

        const finishedFullPage = examinedCount >= items.length;
        cursors[ep.cursorKey] = finishedFullPage ? (page % knownMaxPage) + 1 : page;
        if (offset + 1 >= knownMaxPage || (page >= knownMaxPage && addedFromPage === 0)) {
          break;
        }
      } catch {
        break;
      }
    }
  }

  if (result.length < targetNeeded && overflowClusterBuffer.length > 0) {
    for (const overflowItem of overflowClusterBuffer) {
      if (result.length >= targetNeeded) break;
      result.push(overflowItem);
    }
  }

  return result;
}

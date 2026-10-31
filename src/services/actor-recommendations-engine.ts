import {
  type ActorFetchStatus,
  type ActorRecommendationItem,
  type FavoriteActorInfo,
  type SavedItem,
  scoreActorRecommendations,
} from '../core/cinetrack-core.ts';
import { fetchTmdb, fetchTmdbCached } from './api.ts';
import {
  loadActorCreditsIdb,
  saveActorCreditsIdb,
} from './storage-idb.ts';
import { getStockRecommendationsForActor } from './stock-engine.ts';
import type { TmdbPersonCombinedCredits, TmdbPersonCreditItem } from '../types/tmdb.ts';

export type ActorCreditsTmdbFetcher = (
  path: string,
  params?: Record<string, string>,
  signal?: AbortSignal,
  options?: { force?: boolean }
) => Promise<TmdbPersonCombinedCredits>;

export interface LazyActorCreditsLoadOptions {
  actors: FavoriteActorInfo[];
  openAccordionIds: ReadonlySet<number> | number[];
  force?: boolean;
  signal?: AbortSignal;
  fetchTmdbFn?: ActorCreditsTmdbFetcher;
  sleepFn?: (ms: number) => Promise<void>;
  baseBackoffMs?: number;
  maxRetriesOnRateLimit?: number;
  nowMs?: number;
  onActorStatusChange?: (status: ActorFetchStatus) => void;
}

export interface LazyActorCreditsLoadResult {
  creditsMap: Record<number, TmdbPersonCreditItem[]>;
  statuses: Record<number, ActorFetchStatus>;
  networkFetchedIds: number[];
  cacheHitIds: number[];
  rateLimited: boolean;
  rateLimitWarning: string | null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rec = err as { status?: number; code?: string | number; message?: string };
  if (rec.status === 429 || rec.code === 429 || rec.code === 'rate_limited') return true;
  const msg = typeof rec.message === 'string' ? rec.message : '';
  return /\b429\b|rate[\s_-]*limit|çok fazla istek|istek sınırı/i.test(msg);
}

function normalizeCombinedCredits(raw: TmdbPersonCombinedCredits | null | undefined): TmdbPersonCreditItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const cast = Array.isArray(raw.cast) ? raw.cast : [];
  const seen = new Set<string>();
  const normalized: TmdbPersonCreditItem[] = [];
  for (const item of cast) {
    if (!item || item.id == null) continue;
    const mType = item.media_type === 'tv' || (!item.media_type && item.name && !item.title) ? 'tv' : 'movie';
    const key = `${mType}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      ...item,
      media_type: mType,
    });
  }
  return normalized;
}

/**
 * Loads actor filmographies ONLY for open accordions, backed by persistent Depo 12 (`ct:actor-credits:{actorId}`, 7-day TTL).
 * - Warm cache in a new session makes 0 network requests.
 * - Closed accordions make 0 network requests.
 * - Force-refresh applies exponential backoff on HTTP 429 / rate-limit and preserves cached credits with a clear warning.
 */
export async function loadOpenActorCreditsLazy(
  options: LazyActorCreditsLoadOptions
): Promise<LazyActorCreditsLoadResult> {
  const openSet =
    options.openAccordionIds instanceof Set
      ? options.openAccordionIds
      : new Set(options.openAccordionIds);

  const openActors = options.actors.filter((a) => openSet.has(a.id));
  const creditsMap: Record<number, TmdbPersonCreditItem[]> = {};
  const statuses: Record<number, ActorFetchStatus> = {};
  const networkFetchedIds: number[] = [];
  const cacheHitIds: number[] = [];
  let rateLimited = false;

  if (openActors.length === 0) {
    return {
      creditsMap,
      statuses,
      networkFetchedIds,
      cacheHitIds,
      rateLimited: false,
      rateLimitWarning: null,
    };
  }

  const nowMs = options.nowMs ?? Date.now();
  const fetcher: ActorCreditsTmdbFetcher =
    options.fetchTmdbFn ||
    ((path, params, signal, opts) =>
      (opts?.force
        ? fetchTmdb(path, params, signal)
        : fetchTmdbCached(path, params, signal)) as Promise<TmdbPersonCombinedCredits>);
  const sleep = options.sleepFn || defaultSleep;
  const baseBackoffMs = options.baseBackoffMs ?? 350;
  const maxRetries = options.maxRetriesOnRateLimit ?? 3;

  const actorsNeedingNetwork: FavoriteActorInfo[] = [];

  for (const actor of openActors) {
    if (!options.force) {
      const cached = await loadActorCreditsIdb(actor.id, { nowMs });
      if (cached && cached.status?.status !== 'error') {
        creditsMap[actor.id] = cached.credits;
        statuses[actor.id] = cached.status;
        cacheHitIds.push(actor.id);
        continue;
      }
    }
    actorsNeedingNetwork.push(actor);
  }

  // Bounded concurrency (max 2 concurrent fetches for open accordions)
  const concurrency = Math.min(2, Math.max(1, actorsNeedingNetwork.length));
  let cursor = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < actorsNeedingNetwork.length) {
      const idx = cursor;
      cursor += 1;
      const actor = actorsNeedingNetwork[idx];
      if (options.signal?.aborted) return;

      const loadingStatus: ActorFetchStatus = {
        actorId: actor.id,
        actorName: actor.name,
        status: 'loading',
        creditsCount: 0,
        updatedAt: nowMs,
      };
      statuses[actor.id] = loadingStatus;
      options.onActorStatusChange?.(loadingStatus);

      let attempt = 0;
      let loadedCredits: TmdbPersonCreditItem[] | null = null;
      let hitRateLimitForActor = false;

      while (attempt <= maxRetries) {
        if (options.signal?.aborted) return;
        try {
          networkFetchedIds.push(actor.id);
          const raw = await fetcher(
            `/person/${actor.id}/combined_credits`,
            undefined,
            options.signal,
            { force: Boolean(options.force) }
          );
          loadedCredits = normalizeCombinedCredits(raw);
          break;
        } catch (err) {
          if (isRateLimitError(err)) {
            rateLimited = true;
            hitRateLimitForActor = true;
            if (attempt < maxRetries) {
              const delayMs = baseBackoffMs * Math.pow(2, attempt);
              attempt += 1;
              await sleep(delayMs);
              continue;
            }
          }
          break;
        }
      }

      if (loadedCredits !== null) {
        const okStatus: ActorFetchStatus = {
          actorId: actor.id,
          actorName: actor.name,
          status: loadedCredits.length > 0 ? 'success' : 'empty',
          creditsCount: loadedCredits.length,
          updatedAt: nowMs,
        };
        creditsMap[actor.id] = loadedCredits;
        statuses[actor.id] = okStatus;
        options.onActorStatusChange?.(okStatus);
        await saveActorCreditsIdb(actor.id, loadedCredits, okStatus, nowMs);
      } else {
        // Preserve stale cached credits if available (especially on 429 rate-limit during force refresh!)
        const fallbackCached = await loadActorCreditsIdb(actor.id, { allowStale: true, nowMs });
        if (fallbackCached) {
          creditsMap[actor.id] = fallbackCached.credits;
          statuses[actor.id] = fallbackCached.status;
          options.onActorStatusChange?.(fallbackCached.status);
        } else {
          const errStatus: ActorFetchStatus = {
            actorId: actor.id,
            actorName: actor.name,
            status: 'error',
            creditsCount: 0,
            error: hitRateLimitForActor ? 'TMDB istek sınırına takıldı (429)' : 'Yüklenemedi',
            updatedAt: nowMs,
          };
          statuses[actor.id] = errStatus;
          options.onActorStatusChange?.(errStatus);
        }
      }
    }
  });

  if (actorsNeedingNetwork.length > 0) {
    await Promise.all(workers);
  }

  return {
    creditsMap,
    statuses,
    networkFetchedIds,
    cacheHitIds,
    rateLimited,
    rateLimitWarning: rateLimited
      ? 'TMDB istek sınırına ulaşıldı; kademeli geri çekilme (exponential backoff) uygulandı ve önbellekteki veriler korundu.'
      : null,
  };
}

/**
 * Merges `ct:stock` top-3-actor-ID (`topCastIds`) matches with cached/loaded credits for an open actor
 * so open accordions can immediately display stock matches without network requests (BUG-14 #5).
 */
export function buildMergedActorCreditsWithStock(
  actor: FavoriteActorInfo,
  loadedCredits: TmdbPersonCreditItem[] | undefined,
  excludedKeys?: Set<string>
): TmdbPersonCreditItem[] {
  const stockMatches = getStockRecommendationsForActor(actor.id, excludedKeys);
  const baseCredits = Array.isArray(loadedCredits) ? loadedCredits : [];
  if (stockMatches.length === 0) return baseCredits;

  const seenKeys = new Set<string>();
  const merged: TmdbPersonCreditItem[] = [];

  for (const c of baseCredits) {
    const mType = c.media_type === 'tv' ? 'tv' : 'movie';
    const key = `${mType}:${c.id}`;
    seenKeys.add(key);
    merged.push(c);
  }

  for (const st of stockMatches) {
    const mType = st.media_type === 'tv' ? 'tv' : 'movie';
    const key = `${mType}:${st.id}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const orderIdx = Array.isArray(st.topCastIds) ? Math.max(0, st.topCastIds.indexOf(actor.id)) : 0;
    merged.push({
      ...st,
      media_type: mType,
      order: orderIdx,
    });
  }

  return merged;
}

export interface PerActorSignedMemoEntry {
  signature: string;
  items: ActorRecommendationItem[];
}

export function computeActorScoringSignature(params: {
  actorId: number;
  creditsCount: number;
  savedItems: SavedItem[];
  dislikedKeys: string[];
  selectedType: string;
  selectedGenre: string;
  selectedSort: string;
  enableDiversity: boolean;
}): string {
  const savedFastSig = `${params.savedItems.length}:${params.savedItems
    .slice(0, 12)
    .map((s) => `${s.media_type}:${s.id}:${s.status}:${s.personal_rating}`)
    .join(',')}`;
  const dislikedFastSig = `${params.dislikedKeys.length}:${params.dislikedKeys.slice(-8).join(',')}`;
  return [
    params.actorId,
    params.creditsCount,
    savedFastSig,
    dislikedFastSig,
    params.selectedType,
    params.selectedGenre,
    params.selectedSort,
    params.enableDiversity ? '1' : '0',
  ].join('|');
}

/**
 * Scores a single actor's recommendations with per-actor signature memoization.
 */
export function scoreSingleActorMemoized(
  actor: FavoriteActorInfo,
  credits: TmdbPersonCreditItem[],
  memoMap: Map<number, PerActorSignedMemoEntry>,
  options: {
    savedItems: SavedItem[];
    dislikedKeys: string[];
    genresMap: Record<number, string>;
    preferredProviders: string[];
    providerIndex: Record<string, Array<{ id: number | string; name?: string }>>;
    selectedType: string;
    selectedGenre: string;
    selectedSort: string;
    enableDiversity: boolean;
  }
): ActorRecommendationItem[] {
  const sig = computeActorScoringSignature({
    actorId: actor.id,
    creditsCount: credits.length,
    savedItems: options.savedItems,
    dislikedKeys: options.dislikedKeys,
    selectedType: options.selectedType,
    selectedGenre: options.selectedGenre,
    selectedSort: options.selectedSort,
    enableDiversity: options.enableDiversity,
  });

  const cached = memoMap.get(actor.id);
  if (cached && cached.signature === sig) {
    return cached.items;
  }

  if (credits.length === 0) {
    memoMap.set(actor.id, { signature: sig, items: [] });
    return [];
  }

  const effectiveType: 'all' | 'movie' | 'tv' =
    options.selectedType === 'movie' || options.selectedType === 'tv' ? options.selectedType : 'all';
  const mappedSortMode: 'best_match' | 'newest' | 'hidden_gems' =
    options.selectedSort === 'recent'
      ? 'newest'
      : options.selectedSort === 'gems'
        ? 'hidden_gems'
        : 'best_match';

  const scored = scoreActorRecommendations({
    favoriteActors: [actor],
    actorCreditsMap: { [actor.id]: credits },
    savedItems: options.savedItems,
    dislikedKeys: options.dislikedKeys,
    genresMap: options.genresMap,
    providerIndex: options.providerIndex,
    preferredProviders: options.preferredProviders,
    sortMode: mappedSortMode,
    sortBy: options.selectedSort || 'popular',
    mediaTypeFilter: effectiveType,
    genreFilter: options.selectedGenre || '',
    enableDiversity: options.enableDiversity,
    maxPerGenre: 4,
  });

  memoMap.set(actor.id, { signature: sig, items: scored });
  return scored;
}

/**
 * Listemdeki postersiz kayıtları TMDB'den doldurur.
 * CSV yedeğinden gelen kayıtlar poster_path olmadan geliyor; MediaCard o yüzden
 * yalnızca yedek ikon basıyor. Arka planda, eşzamanlılığı ve günlük kotası
 * sınırlı detay istekleriyle poster yolları liste kaydına yazılır.
 */

import { fetchTmdbCached } from './api.ts';
import { makeMediaKey } from '../core/keys.ts';
import type { SavedItem } from '../core/cinetrack-core.ts';

export type PosterHydrationFetcher = (
  path: string,
  params?: Record<string, string>
) => Promise<any>;

export const POSTER_HYDRATION_CONCURRENCY = 4;
export const POSTER_HYDRATION_ITEMS_PER_PASS = 24;
export const DAILY_POSTER_HYDRATION_ITEM_LIMIT = 1200;
export const POSTER_HYDRATION_STORAGE_KEY = 'ct:poster-hydration';

/** TMDB'de de poster'i olmayan kayıtlar; her geçişte tekrar sorulmaz. */
const MAX_MISSING_POSTER_KEYS = 4000;

export interface PosterPatch {
  poster_path: string;
  backdrop_path?: string;
}

export type PosterPatchMap = Record<string, PosterPatch>;

export interface PosterHydrationQuotaState {
  dayKey: string;
  usedCount: number;
  dailyLimit: number;
  remainingCount: number;
  lastHydratedAt: string | null;
  missingPosterCount: number;
}

export interface PosterHydrationPassResult {
  attemptedCount: number;
  hydratedCount: number;
  failedCount: number;
  patches: PosterPatchMap;
  remainingCount: number;
  quotaState: PosterHydrationQuotaState;
}

interface StoredPosterHydrationState {
  dayKey: string;
  usedCount: number;
  lastHydratedAt: string | null;
  missingPosterKeys: string[];
}

let memoryState: StoredPosterHydrationState | null = null;
let isPassRunning = false;

function getSafeStorage(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Kısıtlı frame'lerde localStorage erişilemeyebilir
  }
  return null;
}

function formatUtcDayKey(nowMs: number): string {
  const dt = new Date(nowMs);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function readState(nowMs: number): StoredPosterHydrationState {
  const today = formatUtcDayKey(nowMs);
  const storage = getSafeStorage();
  if (storage) {
    try {
      const raw = storage.getItem(POSTER_HYDRATION_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoredPosterHydrationState>;
        const sameDay = parsed?.dayKey === today;
        memoryState = {
          dayKey: today,
          usedCount: sameDay && typeof parsed?.usedCount === 'number'
            ? Math.max(0, Math.floor(parsed.usedCount))
            : 0,
          lastHydratedAt:
            typeof parsed?.lastHydratedAt === 'string' ? parsed.lastHydratedAt : null,
          missingPosterKeys: Array.isArray(parsed?.missingPosterKeys)
            ? parsed!.missingPosterKeys!.filter((k) => typeof k === 'string' && k.length > 0)
            : [],
        };
        return memoryState;
      }
    } catch {
      // Bozuk kayıt yok sayılır; bellekteki kopyadan devam edilir
    }
  }

  if (!memoryState || memoryState.dayKey !== today) {
    memoryState = { dayKey: today, usedCount: 0, lastHydratedAt: null, missingPosterKeys: [] };
  }
  return memoryState;
}

function writeState(state: StoredPosterHydrationState): void {
  memoryState = { ...state, missingPosterKeys: [...state.missingPosterKeys] };
  const storage = getSafeStorage();
  if (storage) {
    try {
      storage.setItem(POSTER_HYDRATION_STORAGE_KEY, JSON.stringify(memoryState));
    } catch {
      // Kota aşımında bellekteki kopya yeterli
    }
  }
}

export function getPosterHydrationQuotaState(
  dailyLimit: number = DAILY_POSTER_HYDRATION_ITEM_LIMIT,
  nowMs: number = Date.now()
): PosterHydrationQuotaState {
  const limit = Math.max(1, Math.floor(dailyLimit));
  const state = readState(nowMs);
  return {
    dayKey: state.dayKey,
    usedCount: state.usedCount,
    dailyLimit: limit,
    remainingCount: Math.max(0, limit - state.usedCount),
    lastHydratedAt: state.lastHydratedAt,
    missingPosterCount: state.missingPosterKeys.length,
  };
}

/** Kayıtta basılabilecek bir poster var mı? (getPoster/MediaCard ile aynı koşul) */
export function hasPosterData(item: SavedItem): boolean {
  return Boolean(item.poster_path || item.poster_url);
}

export interface PosterHydrationCandidate {
  key: string;
  mediaType: 'movie' | 'tv';
  numericId: number;
}

export function collectPosterHydrationCandidates(
  items: SavedItem[],
  skipKeys?: Set<string>
): PosterHydrationCandidate[] {
  const candidates: PosterHydrationCandidate[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || item.custom || hasPosterData(item)) continue;
    const numericId = Number(item.id);
    if (!Number.isInteger(numericId) || numericId <= 0) continue;
    const mediaType: 'movie' | 'tv' = item.media_type === 'tv' ? 'tv' : 'movie';
    const key = makeMediaKey(mediaType, numericId);
    if (seen.has(key)) continue;
    if (skipKeys?.has(key)) continue;
    seen.add(key);
    candidates.push({ key, mediaType, numericId });
  }
  // TV havuzu küçük; önce o doldurulur ki iki tür de sıraya girmesin
  candidates.sort((a, b) => {
    if (a.mediaType !== b.mediaType) return a.mediaType === 'tv' ? -1 : 1;
    return a.numericId - b.numericId;
  });
  return candidates;
}

function readPosterPatch(detail: any): PosterPatch | null {
  const posterPath = typeof detail?.poster_path === 'string' ? detail.poster_path : '';
  if (!posterPath.startsWith('/')) return null;
  const backdropPath = typeof detail?.backdrop_path === 'string' ? detail.backdrop_path : '';
  return {
    poster_path: posterPath,
    ...(backdropPath.startsWith('/') ? { backdrop_path: backdropPath } : {}),
  };
}

async function mapWithConcurrency<T, R>(
  list: T[],
  concurrency: number,
  fn: (entry: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(list[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runPosterHydrationPass(options?: {
  items?: SavedItem[];
  fetcher?: PosterHydrationFetcher;
  itemsPerPass?: number;
  concurrency?: number;
  dailyLimit?: number;
  nowMs?: number;
  /** Bu geçişte sorulmasını istemediğimiz anahtarlar (ör. yazımı bekleyen yamalar). */
  extraSkipKeys?: Set<string>;
}): Promise<PosterHydrationPassResult> {
  const nowMs = options?.nowMs ?? Date.now();
  const dailyLimit = Math.max(1, Math.floor(options?.dailyLimit ?? DAILY_POSTER_HYDRATION_ITEM_LIMIT));
  const fetcher = options?.fetcher ?? fetchTmdbCached;
  const items = Array.isArray(options?.items) ? options!.items! : [];

  if (isPassRunning) {
    const state = getPosterHydrationQuotaState(dailyLimit, nowMs);
    return {
      attemptedCount: 0,
      hydratedCount: 0,
      failedCount: 0,
      patches: {},
      remainingCount: 0,
      quotaState: state,
    };
  }
  isPassRunning = true;
  try {
    const state = readState(nowMs);
    const skip = new Set(state.missingPosterKeys);
    if (options?.extraSkipKeys) {
      for (const key of options.extraSkipKeys) skip.add(key);
    }
    const candidates = collectPosterHydrationCandidates(items, skip);
    const budget = Math.min(
      Math.max(1, Math.floor(options?.itemsPerPass ?? POSTER_HYDRATION_ITEMS_PER_PASS)),
      Math.max(0, dailyLimit - state.usedCount)
    );
    const batch = candidates.slice(0, budget);

    const patches: PosterPatchMap = {};
    const missingKeys: string[] = [];
    let failedCount = 0;

    if (batch.length > 0) {
      const outcomes = await mapWithConcurrency(
        batch,
        Math.max(1, Math.floor(options?.concurrency ?? POSTER_HYDRATION_CONCURRENCY)),
        async (candidate) => {
          try {
            return await fetcher(`/${candidate.mediaType}/${candidate.numericId}`);
          } catch {
            // Çevrimdışı ya da TMDB hatası: kayıt denenmiş sayılmaz, sonraki geçişte tekrar sorulur
            failedCount += 1;
            return null;
          }
        }
      );

      for (let i = 0; i < batch.length; i += 1) {
        const candidate = batch[i];
        const detail = outcomes[i];
        if (!detail) continue;
        // Vekil önbelleği yanlış içeriği döndürürse poster başka yapıma yazılmasın
        if (Number(detail.id) !== candidate.numericId) continue;
        const patch = readPosterPatch(detail);
        if (patch) patches[candidate.key] = patch;
        else missingKeys.push(candidate.key);
      }
    }

    const hydratedCount = Object.keys(patches).length;
    const attemptedCount = batch.length - failedCount;
    if (attemptedCount > 0 || hydratedCount > 0) {
      const next = readState(nowMs);
      const merged = [...new Set([...next.missingPosterKeys, ...missingKeys])];
      writeState({
        dayKey: next.dayKey,
        usedCount: Math.min(dailyLimit, next.usedCount + attemptedCount),
        lastHydratedAt: hydratedCount > 0 ? new Date(nowMs).toISOString() : next.lastHydratedAt,
        missingPosterKeys:
          merged.length > MAX_MISSING_POSTER_KEYS
            ? merged.slice(merged.length - MAX_MISSING_POSTER_KEYS)
            : merged,
      });
    }

    const afterState = getPosterHydrationQuotaState(dailyLimit, nowMs);
    return {
      attemptedCount,
      hydratedCount,
      failedCount,
      patches,
      // Yamaçlar listeye uygulanınca bu kadar kayıt kalmış olur; poster'i gerçekten
      // olmayanlar olumsuz önbelleğe alındığı için artık aday değil.
      remainingCount: Math.max(0, candidates.length - hydratedCount - missingKeys.length),
      quotaState: afterState,
    };
  } finally {
    isPassRunning = false;
  }
}

/** Yamaçları liste kayıtlarına yazar; değişen yoksa aynı diziyi döndürür. */
export function applyPosterPatchesToSavedItems(
  items: SavedItem[],
  patches: PosterPatchMap
): { items: SavedItem[]; changedCount: number } {
  const keys = Object.keys(patches || {});
  if (keys.length === 0) return { items, changedCount: 0 };

  let changedCount = 0;
  const next = items.map((item) => {
    if (!item || item.custom || hasPosterData(item)) return item;
    const patch = patches[makeMediaKey(item)];
    if (!patch) return item;
    changedCount += 1;
    return {
      ...item,
      poster_path: patch.poster_path,
      ...(item.backdrop_path ? {} : patch.backdrop_path ? { backdrop_path: patch.backdrop_path } : {}),
    };
  });

  return changedCount > 0 ? { items: next, changedCount } : { items, changedCount: 0 };
}

/**
 * Poster bekleyen kayıtlar bitene ya da günlük kota dolana kadar aralıklı
 * geçişler çalıştırır. Liste kaydı her değiştiğinde zevk/tavsiye/çift kayıt
 * zincirleri baştan hesaplandığı için yamalar biriktirilir ve seyrek yazılır.
 * Temizleme fonksiyonu döner.
 */
export function startSavedPosterHydration(params: {
  getItems: () => SavedItem[];
  onPatches: (patches: PosterPatchMap) => void;
  itemsPerPass?: number;
  flushEveryMs?: number;
  flushMinItems?: number;
  pauseMs?: number;
  firstDelayMs?: number;
  fetcher?: PosterHydrationFetcher;
}): () => void {
  const pauseMs = params.pauseMs ?? 3000;
  const idlePauseMs = 20000;
  const flushEveryMs = params.flushEveryMs ?? 25000;
  const flushMinItems = params.flushMinItems ?? 100;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: PosterPatchMap = {};
  let pendingCount = 0;
  let lastFlushAt = Date.now();

  const isHidden = (): boolean =>
    typeof document !== 'undefined' && document.visibilityState === 'hidden';

  const flush = () => {
    if (pendingCount === 0) return;
    const ready = pending;
    pending = {};
    pendingCount = 0;
    lastFlushAt = Date.now();
    params.onPatches(ready);
  };

  const queueNext = (delayMs: number) => {
    if (disposed) return;
    timer = setTimeout(() => {
      if (disposed) return;
      timer = null;
      void runPosterHydrationPass({
        items: params.getItems(),
        itemsPerPass: params.itemsPerPass ?? POSTER_HYDRATION_ITEMS_PER_PASS,
        extraSkipKeys: new Set(Object.keys(pending)),
        fetcher: params.fetcher,
      })
        .then((res) => {
          if (disposed) return;
          for (const [key, patch] of Object.entries(res.patches)) {
            if (!pending[key]) pendingCount += 1;
            pending[key] = patch;
          }
          if (
            pendingCount >= flushMinItems ||
            (pendingCount > 0 && Date.now() - lastFlushAt >= flushEveryMs)
          ) {
            flush();
          }
          const outstanding = res.remainingCount + pendingCount;
          const keepRunning =
            outstanding > 0 && res.quotaState.remainingCount > 0 && res.failedCount === 0;
          if (keepRunning) queueNext(isHidden() ? idlePauseMs : pauseMs);
        })
        .catch(() => {
          if (!disposed) queueNext(idlePauseMs);
        });
    }, delayMs);
  };

  queueNext(params.firstDelayMs ?? 6000);

  return () => {
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    flush();
  };
}

export function resetPosterHydrationForTests(): void {
  memoryState = null;
  isPassRunning = false;
  const storage = getSafeStorage();
  if (storage) {
    try {
      storage.removeItem(POSTER_HYDRATION_STORAGE_KEY);
    } catch {
      // Yok sayılır
    }
  }
}

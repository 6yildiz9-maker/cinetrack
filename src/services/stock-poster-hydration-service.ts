import { fetchTmdbCached } from './api.ts';
import { updateStockItemsMetadata } from './stock-engine.ts';
import type { StockDepot } from './storage-idb.ts';
import type { TmdbItem } from '../types/tmdb.ts';
import {
  buildStockPosterCandidates,
  pickStockSearchMatch,
  readStockPosterPatch,
  type StockPosterCandidate,
  type StockPosterPatch,
  type StockPosterPatchMap,
} from './stock-poster-utils.ts';

export type StockPosterFetcher = (
  path: string,
  params?: Record<string, string>
) => Promise<any>;

export const STOCK_POSTER_HYDRATION_CONCURRENCY = 4;
export const STOCK_POSTER_HYDRATION_ITEMS_PER_PASS = 24;
export const DAILY_STOCK_POSTER_HYDRATION_LIMIT = 400;
export const STOCK_POSTER_HYDRATION_STORAGE_KEY = 'ct:stock-poster-hydration';

/** TMDB'de de posteri olmayan kayıtlar; her geçişte tekrar sorulmaz. */
const MAX_MISSING_STOCK_POSTER_KEYS = 4000;

export interface StockPosterHydrationQuotaState {
  dayKey: string;
  usedCount: number;
  dailyLimit: number;
  remainingCount: number;
  lastHydratedAt: string | null;
  missingPosterCount: number;
}

export interface StockPosterHydrationPassResult {
  attemptedCount: number;
  hydratedCount: number;
  failedCount: number;
  patches: StockPosterPatchMap;
  remainingCount: number;
  quotaState: StockPosterHydrationQuotaState;
}

interface StoredStockPosterHydrationState {
  dayKey: string;
  usedCount: number;
  lastHydratedAt: string | null;
  missingPosterKeys: string[];
}

let memoryState: StoredStockPosterHydrationState | null = null;
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

function readState(nowMs: number): StoredStockPosterHydrationState {
  const today = formatUtcDayKey(nowMs);
  const storage = getSafeStorage();
  if (storage) {
    try {
      const raw = storage.getItem(STOCK_POSTER_HYDRATION_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoredStockPosterHydrationState>;
        const sameDay = parsed?.dayKey === today;
        memoryState = {
          dayKey: today,
          usedCount:
            sameDay && typeof parsed?.usedCount === 'number'
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

function writeState(state: StoredStockPosterHydrationState): void {
  memoryState = { ...state, missingPosterKeys: [...state.missingPosterKeys] };
  const storage = getSafeStorage();
  if (storage) {
    try {
      storage.setItem(STOCK_POSTER_HYDRATION_STORAGE_KEY, JSON.stringify(memoryState));
    } catch {
      // Kota aşımında bellekteki kopya yeterli
    }
  }
}

export function getStockPosterHydrationQuotaState(
  dailyLimit: number = DAILY_STOCK_POSTER_HYDRATION_LIMIT,
  nowMs: number = Date.now()
): StockPosterHydrationQuotaState {
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

interface ResolvedCandidate {
  candidate: StockPosterCandidate;
  patch: StockPosterPatch | null;
  /** TMDB'de poster gerçekten yok: olumsuz önbelleğe alınır. */
  missing: boolean;
  failed: boolean;
}

async function resolveCandidate(
  candidate: StockPosterCandidate,
  fetcher: StockPosterFetcher
): Promise<ResolvedCandidate> {
  try {
    if (candidate.numericId !== null) {
      const detail = await fetcher(`/${candidate.mediaType}/${candidate.numericId}`);
      if (!detail || Number(detail.id) !== candidate.numericId) {
        // Vekil önbelleği yanlış içerik döndürürse poster başka yapıma yazılmasın
        return { candidate, patch: null, missing: false, failed: false };
      }
      const patch = readStockPosterPatch(detail);
      return { candidate, patch, missing: !patch, failed: false };
    }

    // TVDB türevi kayıtlar: sayısal kimlik TMDB'ye ait değil, başlıkla ara.
    // Arama İngilizce başlıklarla yapılır: demo adları İngilizce, tr-TR sonuçları
    // yerelleşmiş ad döndürüyor ve eşleşme kaçıyor. Yıl filtresi gönderilmez
    // (uydurma yıllar doğru sonucu eler); yıl yalnızca puanlamada kullanılır.
    const response = await fetcher(`/search/${candidate.mediaType}`, {
      query: candidate.query,
      language: 'en-US',
    });
    const match = pickStockSearchMatch(response?.results, candidate);
    if (!match) return { candidate, patch: null, missing: true, failed: false };
    const patch = readStockPosterPatch(match);
    return { candidate, patch, missing: !patch, failed: false };
  } catch {
    // Çevrimdışı ya da TMDB hatası: kayıt denenmiş sayılmaz, sonraki geçişte tekrar sorulur
    return { candidate, patch: null, missing: false, failed: true };
  }
}

export async function runStockPosterHydrationPass(options?: {
  stock?: Pick<StockDepot, 'movies' | 'tv'>;
  fetcher?: StockPosterFetcher;
  itemsPerPass?: number;
  concurrency?: number;
  dailyLimit?: number;
  nowMs?: number;
  extraSkipKeys?: ReadonlySet<string>;
}): Promise<StockPosterHydrationPassResult> {
  const nowMs = options?.nowMs ?? Date.now();
  const dailyLimit = Math.max(
    1,
    Math.floor(options?.dailyLimit ?? DAILY_STOCK_POSTER_HYDRATION_LIMIT)
  );
  const fetcher = options?.fetcher ?? fetchTmdbCached;
  const movies = Array.isArray(options?.stock?.movies) ? options!.stock!.movies : [];
  const tv = Array.isArray(options?.stock?.tv) ? options!.stock!.tv : [];

  if (isPassRunning) {
    const state = getStockPosterHydrationQuotaState(dailyLimit, nowMs);
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
    const candidates = buildStockPosterCandidates(movies, tv, skip);
    const budget = Math.min(
      Math.max(1, Math.floor(options?.itemsPerPass ?? STOCK_POSTER_HYDRATION_ITEMS_PER_PASS)),
      Math.max(0, dailyLimit - state.usedCount)
    );
    const batch = candidates.slice(0, budget);

    const patches: StockPosterPatchMap = {};
    const missingKeys: string[] = [];
    let failedCount = 0;

    if (batch.length > 0) {
      const outcomes = await mapWithConcurrency(
        batch,
        Math.max(1, Math.floor(options?.concurrency ?? STOCK_POSTER_HYDRATION_CONCURRENCY)),
        (candidate) => resolveCandidate(candidate, fetcher)
      );

      for (const outcome of outcomes) {
        if (outcome.failed) {
          failedCount += 1;
          continue;
        }
        if (outcome.patch) patches[outcome.candidate.key] = outcome.patch;
        else if (outcome.missing) missingKeys.push(outcome.candidate.key);
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
          merged.length > MAX_MISSING_STOCK_POSTER_KEYS
            ? merged.slice(merged.length - MAX_MISSING_STOCK_POSTER_KEYS)
            : merged,
      });
    }

    return {
      attemptedCount,
      hydratedCount,
      failedCount,
      patches,
      // Yamalar depoya yazılınca bu kadar kayıt poster bekliyor olur; posteri
      // gerçekten olmayanlar olumsuz önbelleğe alındığı için artık aday değil.
      remainingCount: Math.max(0, candidates.length - hydratedCount - missingKeys.length),
      quotaState: getStockPosterHydrationQuotaState(dailyLimit, nowMs),
    };
  } finally {
    isPassRunning = false;
  }
}

/** Yamaları depoya (ve dolayısıyla stok yedeğine) yazar. */
export async function applyStockPosterPatchesToDepot(patches: StockPosterPatchMap): Promise<number> {
  return updateStockItemsMetadata(patches);
}

/**
 * Poster bekleyen stok kayıtları bitene ya da günlük kota dolana kadar aralıklı
 * geçişler çalıştırır. Yamalar biriktirilip toplu yazılır: her yazım ct:stock'un
 * tamamını serileştirdiği için tek tek yazmak stok sekmesini kilitler.
 * Temizleme fonksiyonu döner.
 */
export function startStockPosterHydration(params: {
  getStock: () => Pick<StockDepot, 'movies' | 'tv'>;
  onPatches: (patches: StockPosterPatchMap) => void;
  itemsPerPass?: number;
  flushEveryMs?: number;
  flushMinItems?: number;
  pauseMs?: number;
  firstDelayMs?: number;
  fetcher?: StockPosterFetcher;
}): () => void {
  const pauseMs = params.pauseMs ?? 2500;
  const idlePauseMs = 20000;
  const emptyRetryMs = 15000;
  const flushEveryMs = params.flushEveryMs ?? 20000;
  const flushMinItems = params.flushMinItems ?? 8;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: StockPosterPatchMap = {};
  let pendingCount = 0;
  let lastFlushAt = Date.now();
  let emptyRetries = 0;

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
      const stock = params.getStock();
      const total = (stock?.movies?.length || 0) + (stock?.tv?.length || 0);
      if (total === 0 && emptyRetries < 8) {
        emptyRetries += 1;
        queueNext(emptyRetryMs);
        return;
      }
      void runStockPosterHydrationPass({
        stock,
        itemsPerPass: params.itemsPerPass ?? STOCK_POSTER_HYDRATION_ITEMS_PER_PASS,
        extraSkipKeys: new Set(Object.keys(pending)),
        fetcher: params.fetcher,
      })
        .then((res) => {
          if (disposed) return;
          for (const [key, patch] of Object.entries(res.patches)) {
            if (!pending[key]) pendingCount += 1;
            pending[key] = patch;
          }
          // pendingCount yalnızca toplu yazım eşiği içindir; aday sayılmaz.
          const keepRunning =
            res.remainingCount > 0 && res.quotaState.remainingCount > 0 && res.failedCount === 0;
          if (
            !keepRunning ||
            pendingCount >= flushMinItems ||
            (pendingCount > 0 && Date.now() - lastFlushAt >= flushEveryMs)
          ) {
            flush();
          }
          if (keepRunning) queueNext(isHidden() ? idlePauseMs : pauseMs);
        })
        .catch(() => {
          if (!disposed) queueNext(idlePauseMs);
        });
    }, delayMs);
  };

  queueNext(params.firstDelayMs ?? 4000);

  return () => {
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    flush();
  };
}

export function resetStockPosterHydrationForTests(): void {
  memoryState = null;
  isPassRunning = false;
  const storage = getSafeStorage();
  if (storage) {
    try {
      storage.removeItem(STOCK_POSTER_HYDRATION_STORAGE_KEY);
    } catch {
      // Yok sayılır
    }
  }
}

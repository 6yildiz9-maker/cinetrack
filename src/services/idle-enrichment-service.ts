import {
  enrichItemMetadataLazy,
  getItemEncoding,
} from './encoding-service.ts';
import {
  getCurrentStock,
  updateStockItemsMetadata,
  type EnrichedStockItemPatch,
} from './stock-engine.ts';
import { loadStockIdb } from './storage-idb.ts';
import type { TmdbItem } from '../types/tmdb.ts';

export const DAILY_IDLE_ENRICHMENT_QUOTA = 40;
export const IDLE_ENRICHMENT_STORAGE_KEY = 'ct:idle-enrichment-quota';

export interface IdleEnrichmentQuotaState {
  dayKey: string;
  usedCount: number;
  dailyLimit: number;
  remainingCount: number;
  lastEnrichedAt: string | null;
}

export interface IdleEnrichmentBatchResult {
  attemptedCount: number;
  enrichedCount: number;
  quotaState: IdleEnrichmentQuotaState;
}

interface StoredQuotaRecord {
  dayKey: string;
  usedCount: number;
  lastEnrichedAt: string | null;
}

let memoryQuotaRecord: StoredQuotaRecord | null = null;
let isBatchRunning = false;

function formatUtcDayKey(nowMs: number): string {
  const dt = new Date(nowMs);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getSafeStorage(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Ignore restricted frames
  }
  return null;
}

function readQuotaRecord(nowMs: number = Date.now()): StoredQuotaRecord {
  const today = formatUtcDayKey(nowMs);
  const storage = getSafeStorage();
  if (storage) {
    try {
      const raw = storage.getItem(IDLE_ENRICHMENT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoredQuotaRecord>;
        if (parsed && parsed.dayKey === today && typeof parsed.usedCount === 'number') {
          memoryQuotaRecord = {
            dayKey: today,
            usedCount: Math.max(0, Math.floor(parsed.usedCount)),
            lastEnrichedAt: typeof parsed.lastEnrichedAt === 'string' ? parsed.lastEnrichedAt : null,
          };
          return memoryQuotaRecord;
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  if (memoryQuotaRecord && memoryQuotaRecord.dayKey === today) {
    return memoryQuotaRecord;
  }

  memoryQuotaRecord = {
    dayKey: today,
    usedCount: 0,
    lastEnrichedAt: null,
  };
  return memoryQuotaRecord;
}

function writeQuotaRecord(record: StoredQuotaRecord): void {
  memoryQuotaRecord = { ...record };
  const storage = getSafeStorage();
  if (storage) {
    try {
      storage.setItem(IDLE_ENRICHMENT_STORAGE_KEY, JSON.stringify(memoryQuotaRecord));
    } catch {
      // Ignore storage quota errors
    }
  }
}

export function getIdleEnrichmentQuotaState(
  dailyLimit: number = DAILY_IDLE_ENRICHMENT_QUOTA,
  nowMs: number = Date.now()
): IdleEnrichmentQuotaState {
  const limit = Math.max(1, Math.floor(dailyLimit));
  const record = readQuotaRecord(nowMs);
  return {
    dayKey: record.dayKey,
    usedCount: record.usedCount,
    dailyLimit: limit,
    remainingCount: Math.max(0, limit - record.usedCount),
    lastEnrichedAt: record.lastEnrichedAt,
  };
}

function isStockItemUnenriched(item: TmdbItem): boolean {
  const hasCast = Array.isArray(item.cast) && item.cast.length > 0;
  const hasCrew = Array.isArray(item.crew) && item.crew.length > 0;
  const itemWithKeywords = item as TmdbItem & { keywords?: Array<{ id: number; name: string }> };
  const hasKeywords = Array.isArray(itemWithKeywords.keywords) && itemWithKeywords.keywords.length > 0;
  return !(hasCast && (hasCrew || hasKeywords));
}

/**
 * Enriches a small batch of unenriched ct:stock items in the background, respecting a strict daily quota,
 * updating ct:stock metadata and re-encoding enriched items into ct:encodings (IMP-11).
 */
export async function runIdleEnrichmentBatch(options?: {
  batchSize?: number;
  dailyLimit?: number;
  nowMs?: number;
}): Promise<IdleEnrichmentBatchResult> {
  const dailyLimit = Math.max(1, Math.floor(options?.dailyLimit ?? DAILY_IDLE_ENRICHMENT_QUOTA));
  const nowMs = options?.nowMs ?? Date.now();
  const initialQuota = getIdleEnrichmentQuotaState(dailyLimit, nowMs);

  if (initialQuota.remainingCount <= 0 || isBatchRunning) {
    return {
      attemptedCount: 0,
      enrichedCount: 0,
      quotaState: initialQuota,
    };
  }

  isBatchRunning = true;
  try {
    let stock = getCurrentStock();
    if (stock.movies.length === 0 && stock.tv.length === 0) {
      stock = await loadStockIdb();
    }

    const candidates: Array<{ item: TmdbItem; mediaType: 'movie' | 'tv'; numericId: number }> = [];
    const maxPick = Math.min(
      Math.max(1, Math.floor(options?.batchSize ?? 4)),
      initialQuota.remainingCount
    );

    // Interleave movie and tv items so both pools gain rich cast/keyword vectors evenly
    const maxLen = Math.max(stock.movies.length, stock.tv.length);
    for (let i = 0; i < maxLen && candidates.length < maxPick; i += 1) {
      if (i < stock.movies.length) {
        const m = stock.movies[i];
        const numId = Number(m?.id);
        if (m && Number.isInteger(numId) && numId > 0 && isStockItemUnenriched(m)) {
          candidates.push({ item: m, mediaType: 'movie', numericId: numId });
        }
      }
      if (candidates.length >= maxPick) break;
      if (i < stock.tv.length) {
        const t = stock.tv[i];
        const numId = Number(t?.id);
        if (t && Number.isInteger(numId) && numId > 0 && isStockItemUnenriched(t)) {
          candidates.push({ item: t, mediaType: 'tv', numericId: numId });
        }
      }
    }

    if (candidates.length === 0) {
      return {
        attemptedCount: 0,
        enrichedCount: 0,
        quotaState: initialQuota,
      };
    }

    const patches: Record<string, EnrichedStockItemPatch> = {};
    const enrichedItemsToEncode: Array<TmdbItem & { keywords?: Array<{ id: number; name: string }> }> = [];

    for (const candidate of candidates) {
      const enriched = await enrichItemMetadataLazy(candidate.mediaType, candidate.numericId);
      if (!enriched) continue;

      const hasData =
        (enriched.cast && enriched.cast.length > 0) ||
        (enriched.crew && enriched.crew.length > 0) ||
        (enriched.keywords && enriched.keywords.length > 0);
      if (!hasData) continue;

      const normalizedCrew = (enriched.crew || []).map((c) => ({
        id: c.id,
        name: c.name,
        job: c.job || 'Crew',
      }));

      const mediaKey = `${candidate.mediaType}:${candidate.numericId}`;
      patches[mediaKey] = {
        cast: enriched.cast,
        crew: normalizedCrew,
        keywords: enriched.keywords,
      };

      enrichedItemsToEncode.push({
        ...candidate.item,
        media_type: candidate.mediaType,
        ...(enriched.cast?.length ? { cast: enriched.cast } : {}),
        ...(normalizedCrew.length ? { crew: normalizedCrew } : {}),
        ...(enriched.keywords?.length ? { keywords: enriched.keywords } : {}),
      });
    }

    const enrichedCount = Object.keys(patches).length;
    if (enrichedCount > 0) {
      await updateStockItemsMetadata(patches);
      await Promise.all(enrichedItemsToEncode.map((it) => getItemEncoding(it)));
    }

    const prevRecord = readQuotaRecord(nowMs);
    const updatedRecord: StoredQuotaRecord = {
      dayKey: prevRecord.dayKey,
      usedCount: Math.min(dailyLimit, prevRecord.usedCount + candidates.length),
      lastEnrichedAt:
        enrichedCount > 0 ? new Date(nowMs).toISOString() : prevRecord.lastEnrichedAt,
    };
    writeQuotaRecord(updatedRecord);

    return {
      attemptedCount: candidates.length,
      enrichedCount,
      quotaState: getIdleEnrichmentQuotaState(dailyLimit, nowMs),
    };
  } finally {
    isBatchRunning = false;
  }
}

type IdleHandle = number | ReturnType<typeof setTimeout>;

function scheduleIdleTask(cb: () => void, timeoutMs = 3000): { id: IdleHandle; usesRic: boolean } {
  const win = globalThis as typeof globalThis & {
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout: number }
    ) => number;
  };
  if (typeof win.requestIdleCallback === 'function') {
    return {
      id: win.requestIdleCallback(cb, { timeout: timeoutMs }),
      usesRic: true,
    };
  }
  return {
    id: setTimeout(cb, 1500),
    usesRic: false,
  };
}

function cancelScheduledIdleTask(scheduled: { id: IdleHandle; usesRic: boolean } | null): void {
  if (!scheduled) return;
  const win = globalThis as typeof globalThis & {
    cancelIdleCallback?: (handle: number) => void;
  };
  if (scheduled.usesRic && typeof win.cancelIdleCallback === 'function') {
    win.cancelIdleCallback(scheduled.id as number);
  } else {
    clearTimeout(scheduled.id as ReturnType<typeof setTimeout>);
  }
}

/**
 * Starts progressive idle-time enrichment of ct:stock items while browser main thread is idle
 * and daily quota permits. Returns a cleanup function (IMP-11).
 */
export function startIdleStockEnrichment(options?: {
  batchSize?: number;
  dailyLimit?: number;
  cyclePauseMs?: number;
}): () => void {
  let disposed = false;
  let idleHandle: { id: IdleHandle; usesRic: boolean } | null = null;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;

  const batchSize = options?.batchSize ?? 4;
  const dailyLimit = options?.dailyLimit ?? DAILY_IDLE_ENRICHMENT_QUOTA;
  const cyclePauseMs = options?.cyclePauseMs ?? 8000;

  const queueNextCycle = (delayMs: number) => {
    if (disposed) return;
    pauseTimer = setTimeout(() => {
      if (disposed) return;
      idleHandle = scheduleIdleTask(() => {
        if (disposed) return;
        void runIdleEnrichmentBatch({ batchSize, dailyLimit }).then((res) => {
          if (disposed) return;
          if (res.quotaState.remainingCount > 0 && res.attemptedCount > 0) {
            queueNextCycle(cyclePauseMs);
          }
        });
      });
    }, delayMs);
  };

  queueNextCycle(2500);

  return () => {
    disposed = true;
    if (pauseTimer !== null) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
    cancelScheduledIdleTask(idleHandle);
    idleHandle = null;
  };
}

export function resetIdleEnrichmentForTests(): void {
  memoryQuotaRecord = null;
  isBatchRunning = false;
  const storage = getSafeStorage();
  if (storage) {
    try {
      storage.removeItem(IDLE_ENRICHMENT_STORAGE_KEY);
    } catch {
      // Ignore
    }
  }
}

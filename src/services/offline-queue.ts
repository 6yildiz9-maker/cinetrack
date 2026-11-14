import { type DataDocument } from '../core/cinetrack-core.ts';
import { get, set, del, createStore } from 'idb-keyval';

const OFFLINE_QUEUE_STORAGE_KEY = 'cinetrack_offline_sync_queue_v1';
const IDB_STORE_NAME = 'cinetrack_offline_queue_store';
let idbStoreRef: ReturnType<typeof createStore> | undefined;
let pendingIdbWrite: Promise<void> | null = null;

function getIdbStore() {
  if (typeof indexedDB === 'undefined') return undefined;
  if (!idbStoreRef) {
    idbStoreRef = createStore('cinetrack-offline-queue-db', IDB_STORE_NAME);
  }
  return idbStoreRef;
}

export interface QueuedSyncSnapshot {
  queuedAt: string;
  baseRevision: number | null;
  payload: DataDocument;
  /** Kaç kez gönderilmeye çalışıldı (SEC-04: üstel geri çekilme için). */
  attempts?: number;
  lastAttemptAt?: string | null;
}

export type OfflineQueueStorage = 'indexeddb' | 'localstorage' | 'memory';

export interface EnqueueOfflineResult extends QueuedSyncSnapshot {
  persisted: boolean;
  storage: OfflineQueueStorage;
}

export const OFFLINE_QUEUE_MAX_ATTEMPTS = 5;
export const OFFLINE_QUEUE_FAILED_EVENT = 'cinetrack:queue-failed';
const OFFLINE_BACKOFF_BASE_MS = 2_000;
const OFFLINE_BACKOFF_MAX_MS = 5 * 60_000;

/** Deneme sayısına göre bekleme: 2 sn → 4 → 8 → 16 → 32 … en fazla 5 dk. */
export function offlineQueueBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(OFFLINE_BACKOFF_MAX_MS, OFFLINE_BACKOFF_BASE_MS * 2 ** (attempts - 1));
}

let memoryFallbackSnapshot: QueuedSyncSnapshot | null = null;
let lastPersistFailed = false;

export function hasUnpersistedOfflineFallback(): boolean {
  return lastPersistFailed && memoryFallbackSnapshot !== null;
}

export async function flushOfflineQueuePersistence(): Promise<void> {
  if (pendingIdbWrite) {
    await pendingIdbWrite;
  }
}

export function loadOfflineSyncSnapshot(): QueuedSyncSnapshot | null {
  const store = getIdbStore();
  if (store && memoryFallbackSnapshot) {
    return memoryFallbackSnapshot;
  }

  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.payload) {
          const snapshot: QueuedSyncSnapshot = {
            queuedAt: String(parsed.queuedAt || new Date().toISOString()),
            baseRevision: typeof parsed.baseRevision === 'number' ? parsed.baseRevision : null,
            payload: parsed.payload as DataDocument,
            // SEC-04: deneme sayacı yeniden yüklemede kaybolmamalı.
            attempts: Number.isFinite(Number(parsed.attempts)) ? Number(parsed.attempts) : 0,
            lastAttemptAt:
              typeof parsed.lastAttemptAt === 'string' ? parsed.lastAttemptAt : null,
          };
          if (store) {
            memoryFallbackSnapshot = snapshot;
            void migrateSnapshotToIndexedDB(snapshot);
          }
          return snapshot;
        }
      }
    }
  } catch {
    // Fall back to in-memory snapshot if localStorage is inaccessible or corrupt
  }
  return memoryFallbackSnapshot;
}

export async function loadOfflineSyncSnapshotAsync(): Promise<QueuedSyncSnapshot | null> {
  const store = getIdbStore();
  if (store) {
    try {
      await flushOfflineQueuePersistence();
      const idbData = await get<QueuedSyncSnapshot>('latest_offline_snapshot', store);
      if (idbData && idbData.payload) {
        memoryFallbackSnapshot = idbData;
        lastPersistFailed = false;
        return idbData;
      }
    } catch (e) {
      console.warn('[OfflineQueue] IDB read failed:', e);
    }
  }

  const syncSnap = loadOfflineSyncSnapshot();
  if (syncSnap) return syncSnap;

  return memoryFallbackSnapshot;
}

async function migrateSnapshotToIndexedDB(snapshot: QueuedSyncSnapshot): Promise<void> {
  const store = getIdbStore();
  if (store) {
    try {
      await set('latest_offline_snapshot', snapshot, store);
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(OFFLINE_QUEUE_STORAGE_KEY);
      }
    } catch (e) {
      console.warn('[OfflineQueue] Taşıma başarısız, localStorage yedeği korunuyor:', e);
    }
  }
}

/**
 * DATA-01: kuyruk kaydını gerçekten kalıcı hâle getirir ve yazmayı doğrular.
 * Sıra: IndexedDB → localStorage (okuma ile doğrulanır) → bellek (persisted: false).
 */
async function persistSnapshotDurably(entry: QueuedSyncSnapshot): Promise<OfflineQueueStorage> {
  const store = getIdbStore();
  if (store) {
    try {
      await set('latest_offline_snapshot', entry, store);
      memoryFallbackSnapshot = entry;
      lastPersistFailed = false;
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(OFFLINE_QUEUE_STORAGE_KEY);
        }
      } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
      return 'indexeddb';
    } catch (e) {
      console.warn('[OfflineQueue] IndexedDB yazımı başarısız, localStorage yedeğine geçiliyor:', e);
    }
  }

  try {
    if (typeof localStorage !== 'undefined') {
      const raw = JSON.stringify(entry);
      localStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, raw);
      // Kota/yarıda kesilme sessizce yutulmasın: geri okuyup doğrula.
      if (localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY) === raw) {
        memoryFallbackSnapshot = null;
        lastPersistFailed = false;
        return 'localstorage';
      }
    }
  } catch (e) {
    console.warn('[OfflineQueue] localStorage yedeği de yazılamadı:', e);
  }

  memoryFallbackSnapshot = entry;
  lastPersistFailed = true;
  return 'memory';
}

/**
 * DATA-01: kalıcılığı doğrulayan kuyruk yazımı. `enqueueOfflineSyncSnapshot`'ın
 * senkron sürümü testler ve Node ortamı için korunur; istemci bu sürümü kullanır.
 */
export async function enqueueOfflineSyncSnapshotDurable(
  payload: DataDocument,
  baseRevision: number | null
): Promise<EnqueueOfflineResult> {
  const existing = loadOfflineSyncSnapshot();
  const entry: QueuedSyncSnapshot = {
    queuedAt: new Date().toISOString(),
    baseRevision: baseRevision !== null ? baseRevision : existing ? existing.baseRevision : null,
    payload,
    attempts: existing?.attempts ?? 0,
    lastAttemptAt: existing?.lastAttemptAt ?? null,
  };
  const storage = await persistSnapshotDurably(entry);
  return { ...entry, persisted: storage !== 'memory', storage };
}

/** Başarısız gönderimde deneme sayacını artırır ve bir sonraki bekleme süresini döner. */
export async function recordOfflineQueueAttempt(): Promise<{
  attempts: number;
  nextDelayMs: number;
  exhausted: boolean;
  persisted: boolean;
}> {
  const existing = (await loadOfflineSyncSnapshotAsync()) || loadOfflineSyncSnapshot();
  if (!existing) {
    return { attempts: 0, nextDelayMs: 0, exhausted: false, persisted: false };
  }
  const attempts = (existing.attempts ?? 0) + 1;
  const entry: QueuedSyncSnapshot = {
    ...existing,
    attempts,
    lastAttemptAt: new Date().toISOString(),
  };
  const storage = await persistSnapshotDurably(entry);
  const exhausted = attempts >= OFFLINE_QUEUE_MAX_ATTEMPTS;
  const nextDelayMs = exhausted ? 0 : offlineQueueBackoffMs(attempts);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(OFFLINE_QUEUE_FAILED_EVENT, {
        detail: { attempts, nextDelayMs, exhausted, persisted: storage !== 'memory' },
      })
    );
  }
  return { attempts, nextDelayMs, exhausted, persisted: storage !== 'memory' };
}

export function enqueueOfflineSyncSnapshot(
  payload: DataDocument,
  baseRevision: number | null
): EnqueueOfflineResult {
  const existing = loadOfflineSyncSnapshot();
  const effectiveBaseRevision =
    baseRevision !== null ? baseRevision : existing ? existing.baseRevision : null;

  const entry: QueuedSyncSnapshot = {
    queuedAt: new Date().toISOString(),
    baseRevision: effectiveBaseRevision,
    payload,
  };

  // Primary persistent storage in browser: IndexedDB via idb-keyval (BUG-02 — zero localStorage bloat)
  const store = getIdbStore();
  if (store) {
    memoryFallbackSnapshot = entry;
    lastPersistFailed = false;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(OFFLINE_QUEUE_STORAGE_KEY);
      }
    } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
    pendingIdbWrite = set('latest_offline_snapshot', entry, store)
      .catch((e) => {
        console.warn('[OfflineQueue] IndexedDB persist failed:', e);
        lastPersistFailed = true;
      })
      .finally(() => {
        pendingIdbWrite = null;
      });
    return { ...entry, persisted: true, storage: 'indexeddb' };
  }

  // Fallback for Node.js test environments where indexedDB is undefined
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(entry));
      memoryFallbackSnapshot = null;
      lastPersistFailed = false;
      return { ...entry, persisted: true, storage: 'localstorage' };
    }
  } catch (err) {
    console.warn('Cinethos: çevrimdışı kuyruk localStorage kotasına takıldı; bellek yedeği kullanılıyor.', err);
  }

  memoryFallbackSnapshot = entry;
  lastPersistFailed = true;
  return { ...entry, persisted: false, storage: 'memory' };
}

export async function clearOfflineSyncSnapshot(): Promise<void> {
  memoryFallbackSnapshot = null;
  lastPersistFailed = false;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(OFFLINE_QUEUE_STORAGE_KEY);
    }
  } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }

  const store = getIdbStore();
  if (store) {
    const task = del('latest_offline_snapshot', store).catch((e) => {
      console.warn('[OfflineQueue] Kuyruk silinemedi:', e);
    });
    pendingIdbWrite = task.finally(() => {
      pendingIdbWrite = null;
    });
    await pendingIdbWrite;
  }
}

export function hasPendingOfflineSync(): boolean {
  return loadOfflineSyncSnapshot() !== null;
}

export function resetOfflineQueueForTests(): void {
  idbStoreRef = undefined;
  pendingIdbWrite = null;
  memoryFallbackSnapshot = null;
  lastPersistFailed = false;
}

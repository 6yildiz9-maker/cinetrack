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
}

export interface EnqueueOfflineResult extends QueuedSyncSnapshot {
  persisted: boolean;
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
    } catch {}
  }
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
    } catch {}
    pendingIdbWrite = set('latest_offline_snapshot', entry, store)
      .catch((e) => {
        console.warn('[OfflineQueue] IndexedDB persist failed:', e);
        lastPersistFailed = true;
      })
      .finally(() => {
        pendingIdbWrite = null;
      });
    return { ...entry, persisted: true };
  }

  // Fallback for Node.js test environments where indexedDB is undefined
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(entry));
      memoryFallbackSnapshot = null;
      lastPersistFailed = false;
      return { ...entry, persisted: true };
    }
  } catch (err) {
    console.warn('CineTrack: çevrimdışı kuyruk localStorage kotasına takıldı; bellek yedeği kullanılıyor.', err);
  }

  memoryFallbackSnapshot = entry;
  lastPersistFailed = true;
  return { ...entry, persisted: false };
}

export function clearOfflineSyncSnapshot(): void {
  memoryFallbackSnapshot = null;
  lastPersistFailed = false;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(OFFLINE_QUEUE_STORAGE_KEY);
    }
  } catch {}

  const store = getIdbStore();
  if (store) {
    pendingIdbWrite = del('latest_offline_snapshot', store)
      .catch(() => {})
      .finally(() => {
        pendingIdbWrite = null;
      });
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

import { type DataDocument } from '../core/cinetrack-core.ts';
import { get, set, del, createStore } from 'idb-keyval';

const OFFLINE_QUEUE_STORAGE_KEY = 'cinetrack_offline_sync_queue_v1';
const IDB_STORE_NAME = 'cinetrack_offline_queue_store';
let idbStoreRef: ReturnType<typeof createStore> | undefined;

function getIdbStore() {
  if (typeof indexedDB === 'undefined') return undefined;
  if (!idbStoreRef) {
    idbStoreRef = createStore('cinetrack-db', IDB_STORE_NAME);
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

export function loadOfflineSyncSnapshot(): QueuedSyncSnapshot | null {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.payload) {
          const snapshot = {
            queuedAt: String(parsed.queuedAt || new Date().toISOString()),
            baseRevision: typeof parsed.baseRevision === 'number' ? parsed.baseRevision : null,
            payload: parsed.payload as DataDocument,
          };
          // Asynchronously migrate to IndexedDB in background
          migrateSnapshotToIndexedDB(snapshot);
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
  const syncSnap = loadOfflineSyncSnapshot();
  if (syncSnap) return syncSnap;

  const store = getIdbStore();
  if (store) {
    try {
      const idbData = await get<QueuedSyncSnapshot>('latest_offline_snapshot', store);
      if (idbData && idbData.payload) {
        memoryFallbackSnapshot = idbData;
        return idbData;
      }
    } catch (e) {
      console.warn('[OfflineQueue] IDB read failed:', e);
    }
  }
  return memoryFallbackSnapshot;
}

async function migrateSnapshotToIndexedDB(snapshot: QueuedSyncSnapshot): Promise<void> {
  const store = getIdbStore();
  if (store) {
    try {
      await set('latest_offline_snapshot', snapshot, store);
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

  // Asynchronously save to IndexedDB as primary persistent storage (BUG-02)
  const store = getIdbStore();
  if (store) {
    set('latest_offline_snapshot', entry, store).catch((e) => {
      console.warn('[OfflineQueue] IndexedDB persist failed:', e);
    });
  }

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

  // If localStorage quota exceeded, keep in memory and IDB
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
    del('latest_offline_snapshot', store).catch(() => {});
  }
}

export function hasPendingOfflineSync(): boolean {
  return loadOfflineSyncSnapshot() !== null;
}

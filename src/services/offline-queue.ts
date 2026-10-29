import { type DataDocument } from '../core/cinetrack-core';

const OFFLINE_QUEUE_STORAGE_KEY = 'cinetrack_offline_sync_queue_v1';

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
          return {
            queuedAt: String(parsed.queuedAt || new Date().toISOString()),
            baseRevision: typeof parsed.baseRevision === 'number' ? parsed.baseRevision : null,
            payload: parsed.payload as DataDocument,
          };
        }
      }
    }
  } catch {
    // Fall back to in-memory snapshot if localStorage is inaccessible or corrupt
  }
  return memoryFallbackSnapshot;
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
}

export function hasPendingOfflineSync(): boolean {
  return loadOfflineSyncSnapshot() !== null;
}

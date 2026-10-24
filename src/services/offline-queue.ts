import { type DataDocument } from '../core/cinetrack-core';

const OFFLINE_QUEUE_STORAGE_KEY = 'cinetrack_offline_sync_queue_v1';

export interface QueuedSyncSnapshot {
  queuedAt: string;
  baseRevision: number | null;
  payload: DataDocument;
}

export function loadOfflineSyncSnapshot(): QueuedSyncSnapshot | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.payload) return null;
    return {
      queuedAt: String(parsed.queuedAt || new Date().toISOString()),
      baseRevision: typeof parsed.baseRevision === 'number' ? parsed.baseRevision : null,
      payload: parsed.payload as DataDocument,
    };
  } catch {
    return null;
  }
}

export function enqueueOfflineSyncSnapshot(payload: DataDocument, baseRevision: number | null): QueuedSyncSnapshot {
  const entry: QueuedSyncSnapshot = {
    queuedAt: new Date().toISOString(),
    baseRevision,
    payload,
  };
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(entry));
    }
  } catch {}
  return entry;
}

export function clearOfflineSyncSnapshot(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(OFFLINE_QUEUE_STORAGE_KEY);
    }
  } catch {}
}

export function hasPendingOfflineSync(): boolean {
  return loadOfflineSyncSnapshot() !== null;
}

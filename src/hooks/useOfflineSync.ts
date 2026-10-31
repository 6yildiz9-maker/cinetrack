import { useCallback, useEffect, useRef, useState } from 'react';
import { type DataDocument } from '../core/cinetrack-core';
import {
  getLastKnownServerRevision,
  pushServerDataDetailed,
  type ServerConflictDetail,
} from '../services/api';
import {
  clearOfflineSyncSnapshot,
  enqueueOfflineSyncSnapshot,
  hasPendingOfflineSync,
  hasUnpersistedOfflineFallback,
  loadOfflineSyncSnapshot,
  loadOfflineSyncSnapshotAsync,
} from '../services/offline-queue';
import {
  hasUnpersistedIdbFallback,
  subscribeIdbQuotaWarning,
} from '../services/storage-idb';
import { useOnlineStatus } from './useOnlineStatus';

export function useOfflineSync(onConflict?: (conflict: ServerConflictDetail, localDoc: DataDocument) => void) {
  const isOnline = useOnlineStatus();
  const [pendingSync, setPendingSync] = useState<boolean>(() => hasPendingOfflineSync());
  const [unpersistedWarning, setUnpersistedWarning] = useState<boolean>(
    () => hasUnpersistedOfflineFallback() || hasUnpersistedIdbFallback()
  );
  const conflictPausedRef = useRef<boolean>(false);

  useEffect(() => {
    return subscribeIdbQuotaWarning(() => {
      if (hasUnpersistedIdbFallback()) {
        setUnpersistedWarning(true);
      }
    });
  }, []);

  useEffect(() => {
    let active = true;
    void loadOfflineSyncSnapshotAsync().then((snap) => {
      if (active && snap) {
        setPendingSync(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const resolveQueuedConflict = useCallback(() => {
    conflictPausedRef.current = false;
    clearOfflineSyncSnapshot();
    setPendingSync(false);
    setUnpersistedWarning(hasUnpersistedIdbFallback());
  }, []);

  const flushQueue = useCallback(async () => {
    if (conflictPausedRef.current) {
      return;
    }
    const queued = (await loadOfflineSyncSnapshotAsync()) || loadOfflineSyncSnapshot();
    if (!queued) {
      setPendingSync(false);
      setUnpersistedWarning(hasUnpersistedIdbFallback());
      return;
    }

    const res = await pushServerDataDetailed(queued.payload, {
      baseRevision: queued.baseRevision,
    });

    if (res.ok) {
      conflictPausedRef.current = false;
      clearOfflineSyncSnapshot();
      setPendingSync(false);
      setUnpersistedWarning(hasUnpersistedIdbFallback());
      return;
    }

    if ((res.status === 409 || res.status === 412 || res.status === 428) && res.conflict) {
      // BUG-07: Çakışma çözülene kadar çevrimdışı kuyruk kaydını silme!
      // Sayfa yenilense bile bekleyen yerel değişiklikler korunur.
      conflictPausedRef.current = true;
      setPendingSync(true);
      onConflict?.({ ...res.conflict, localPayload: queued.payload }, queued.payload);
      return;
    }
    // Network error (status 0) or transient 5xx: keep queued
    setPendingSync(true);
  }, [onConflict]);

  useEffect(() => {
    if (isOnline && pendingSync && !conflictPausedRef.current) {
      void flushQueue();
    }
  }, [isOnline, pendingSync, flushQueue]);

  const syncDocument = useCallback(
    async (payload: DataDocument, options: { confirmBulkDelete?: boolean; forceOverwrite?: boolean } = {}) => {
      if (options.forceOverwrite) {
        conflictPausedRef.current = false;
      }

      if (!navigator.onLine) {
        const enq = enqueueOfflineSyncSnapshot(payload, getLastKnownServerRevision());
        setPendingSync(true);
        setUnpersistedWarning(!enq.persisted || hasUnpersistedIdbFallback());
        return { ok: false, queued: true, persisted: enq.persisted };
      }

      const res = await pushServerDataDetailed(payload, {
        baseRevision: options.forceOverwrite ? null : getLastKnownServerRevision(),
        confirmBulkDelete: options.confirmBulkDelete,
        forceOverwrite: options.forceOverwrite,
      });

      if (res.ok) {
        conflictPausedRef.current = false;
        clearOfflineSyncSnapshot();
        setPendingSync(false);
        setUnpersistedWarning(hasUnpersistedIdbFallback());
        return { ok: true, queued: false };
      }

      if (res.status === 0) {
        const enq = enqueueOfflineSyncSnapshot(payload, getLastKnownServerRevision());
        setPendingSync(true);
        setUnpersistedWarning(!enq.persisted || hasUnpersistedIdbFallback());
        return { ok: false, queued: true, persisted: enq.persisted };
      }

      if ((res.status === 409 || res.status === 412 || res.status === 428) && res.conflict) {
        onConflict?.({ ...res.conflict, localPayload: payload }, payload);
      }

      return { ok: false, queued: false, conflict: res.conflict };
    },
    [onConflict]
  );

  return {
    isOnline,
    pendingSync,
    unpersistedWarning,
    syncDocument,
    flushQueue,
    resolveQueuedConflict,
  };
}

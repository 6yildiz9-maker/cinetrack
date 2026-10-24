import { useCallback, useEffect, useState } from 'react';
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
  loadOfflineSyncSnapshot,
} from '../services/offline-queue';
import { useOnlineStatus } from './useOnlineStatus';

export function useOfflineSync(onConflict?: (conflict: ServerConflictDetail, localDoc: DataDocument) => void) {
  const isOnline = useOnlineStatus();
  const [pendingSync, setPendingSync] = useState<boolean>(() => hasPendingOfflineSync());

  const flushQueue = useCallback(async () => {
    const queued = loadOfflineSyncSnapshot();
    if (!queued) {
      setPendingSync(false);
      return;
    }

    const res = await pushServerDataDetailed(queued.payload, {
      baseRevision: queued.baseRevision,
    });

    if (res.ok) {
      clearOfflineSyncSnapshot();
      setPendingSync(false);
      return;
    }

    if (res.status === 409 && res.conflict) {
      clearOfflineSyncSnapshot();
      setPendingSync(false);
      onConflict?.(res.conflict, queued.payload);
      return;
    }
    // Network error (status 0) or transient 5xx: keep queued
    setPendingSync(true);
  }, [onConflict]);

  useEffect(() => {
    if (isOnline && pendingSync) {
      void flushQueue();
    }
  }, [isOnline, pendingSync, flushQueue]);

  const syncDocument = useCallback(
    async (payload: DataDocument, options: { confirmBulkDelete?: boolean; forceOverwrite?: boolean } = {}) => {
      if (!navigator.onLine) {
        enqueueOfflineSyncSnapshot(payload, getLastKnownServerRevision());
        setPendingSync(true);
        return { ok: false, queued: true };
      }

      const res = await pushServerDataDetailed(payload, {
        baseRevision: options.forceOverwrite ? null : getLastKnownServerRevision(),
        confirmBulkDelete: options.confirmBulkDelete,
      });

      if (res.ok) {
        clearOfflineSyncSnapshot();
        setPendingSync(false);
        return { ok: true, queued: false };
      }

      if (res.status === 0) {
        enqueueOfflineSyncSnapshot(payload, getLastKnownServerRevision());
        setPendingSync(true);
        return { ok: false, queued: true };
      }

      if (res.status === 409 && res.conflict) {
        onConflict?.(res.conflict, payload);
      }

      return { ok: false, queued: false, conflict: res.conflict };
    },
    [onConflict]
  );

  return {
    isOnline,
    pendingSync,
    syncDocument,
    flushQueue,
  };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { type DataDocument } from '../core/cinetrack-core.ts';
import {
  getLastKnownServerRevision,
  pushServerDataDetailed,
  type ServerConflictDetail,
} from '../services/api.ts';
import {
  OFFLINE_QUEUE_MAX_ATTEMPTS,
  clearOfflineSyncSnapshot,
  enqueueOfflineSyncSnapshotDurable,
  hasPendingOfflineSync,
  hasUnpersistedOfflineFallback,
  loadOfflineSyncSnapshot,
  loadOfflineSyncSnapshotAsync,
  recordOfflineQueueAttempt,
} from '../services/offline-queue.ts';
import {
  hasUnpersistedIdbFallback,
  subscribeIdbQuotaWarning,
} from '../services/storage-idb.ts';
import { useOnlineStatus } from './useOnlineStatus.ts';

export interface OfflineQueueFailure {
  attempts: number;
  exhausted: boolean;
}

export function useOfflineSync(
  onConflict?: (conflict: ServerConflictDetail, localDoc: DataDocument) => void,
  onMergedServerDocument?: (serverDoc: DataDocument, sentPayload: DataDocument) => void
) {
  const isOnline = useOnlineStatus();
  const [pendingSync, setPendingSync] = useState<boolean>(() => hasPendingOfflineSync());
  const [unpersistedWarning, setUnpersistedWarning] = useState<boolean>(
    () => hasUnpersistedOfflineFallback() || hasUnpersistedIdbFallback()
  );
  const [queueFailure, setQueueFailure] = useState<OfflineQueueFailure | null>(null);
  const conflictPausedRef = useRef<boolean>(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearRetryTimer, [clearRetryTimer]);

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
    clearRetryTimer();
    setQueueFailure(null);
    void clearOfflineSyncSnapshot();
    setPendingSync(false);
    setUnpersistedWarning(hasUnpersistedIdbFallback());
  }, [clearRetryTimer]);

  const flushQueue = useCallback(async () => {
    if (conflictPausedRef.current) {
      return;
    }
    clearRetryTimer();
    const queued = (await loadOfflineSyncSnapshotAsync()) || loadOfflineSyncSnapshot();
    if (!queued) {
      setPendingSync(false);
      setUnpersistedWarning(hasUnpersistedIdbFallback());
      return;
    }

    const res = await pushServerDataDetailed(queued.payload, {
      baseRevision: queued.baseRevision,
      mergeStrategy: 'lossless',
    });

    if (res.ok) {
      conflictPausedRef.current = false;
      await clearOfflineSyncSnapshot();
      setPendingSync(false);
      setQueueFailure(null);
      setUnpersistedWarning(hasUnpersistedIdbFallback());
      if (res.document && res.merged) {
        onMergedServerDocument?.(res.document, queued.payload);
      }
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

    // SEC-04: ağ/5xx hatasında üstel geri çekilmeyle yeniden dene; sayaç kalıcıdır.
    setPendingSync(true);
    const info = await recordOfflineQueueAttempt();
    setQueueFailure({ attempts: info.attempts, exhausted: info.exhausted });
    if (info.nextDelayMs > 0) {
      clearRetryTimer();
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        void flushQueue();
      }, info.nextDelayMs);
    }
  }, [clearRetryTimer, onConflict, onMergedServerDocument]);

  useEffect(() => {
    if (isOnline && pendingSync && !conflictPausedRef.current) {
      void flushQueue();
    }
  }, [isOnline, pendingSync, flushQueue]);

  const syncDocument = useCallback(
    async (
      payload: DataDocument,
      options: {
        confirmBulkDelete?: boolean;
        forceOverwrite?: boolean;
        foldUnhydratedDefaultProfile?: boolean;
      } = {}
    ) => {
      if (options.forceOverwrite) {
        conflictPausedRef.current = false;
        clearRetryTimer();
        setQueueFailure(null);
      }

      if (!navigator.onLine) {
        // DATA-01: yazma tamamlanmadan "kaydedildi" denmez.
        const enq = await enqueueOfflineSyncSnapshotDurable(
          payload,
          getLastKnownServerRevision()
        );
        setPendingSync(true);
        setUnpersistedWarning(!enq.persisted || hasUnpersistedIdbFallback());
        return { ok: false, queued: true, persisted: enq.persisted, storage: enq.storage };
      }

      const useLossless = !options.forceOverwrite && !options.confirmBulkDelete;
      const res = await pushServerDataDetailed(payload, {
        baseRevision: options.forceOverwrite ? null : getLastKnownServerRevision(),
        confirmBulkDelete: options.confirmBulkDelete,
        forceOverwrite: options.forceOverwrite,
        mergeStrategy: useLossless ? 'lossless' : undefined,
        foldUnhydratedDefaultProfile: options.foldUnhydratedDefaultProfile,
      });

      if (res.ok) {
        conflictPausedRef.current = false;
        await clearOfflineSyncSnapshot();
        setPendingSync(false);
        setQueueFailure(null);
        setUnpersistedWarning(hasUnpersistedIdbFallback());
        if (res.document && res.merged) {
          onMergedServerDocument?.(res.document, payload);
        }
        return { ok: true, queued: false, merged: res.merged, document: res.document };
      }

      if (res.status === 0) {
        const enq = await enqueueOfflineSyncSnapshotDurable(
          payload,
          getLastKnownServerRevision()
        );
        setPendingSync(true);
        setUnpersistedWarning(!enq.persisted || hasUnpersistedIdbFallback());
        return { ok: false, queued: true, persisted: enq.persisted, storage: enq.storage };
      }

      if ((res.status === 409 || res.status === 412 || res.status === 428) && res.conflict) {
        onConflict?.({ ...res.conflict, localPayload: payload }, payload);
      }

      return { ok: false, queued: false, conflict: res.conflict };
    },
    [clearRetryTimer, onConflict, onMergedServerDocument]
  );

  return {
    isOnline,
    pendingSync,
    unpersistedWarning,
    queueFailure,
    maxQueueAttempts: OFFLINE_QUEUE_MAX_ATTEMPTS,
    syncDocument,
    flushQueue,
    resolveQueuedConflict,
  };
}

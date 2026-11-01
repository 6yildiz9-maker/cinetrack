import { triggerImmediateServerBackup } from './api.ts';

export const AUTO_BACKUP_CHANGE_THRESHOLD = 25;
export const AUTO_BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 gün
export const AUTO_BACKUP_STORAGE_KEY = 'ct:auto-backup-meta';

export type AutoBackupTriggerReason = 'manual' | 'changes' | 'weekly';

export interface AutoBackupMeta {
  lastBackupAt: string | null;
  firstTrackedAt: string | null;
  changesSinceLastBackup: number;
  lastTriggerReason: AutoBackupTriggerReason | null;
  totalAutoBackupsCount: number;
}

export interface AutoBackupCheckResult {
  triggered: boolean;
  ok: boolean;
  reason: AutoBackupTriggerReason | null;
  meta: AutoBackupMeta;
}

export type BackupExecutorFn = () => Promise<{ ok: boolean; message?: string }>;

const DEFAULT_META: AutoBackupMeta = {
  lastBackupAt: null,
  firstTrackedAt: null,
  changesSinceLastBackup: 0,
  lastTriggerReason: null,
  totalAutoBackupsCount: 0,
};

let memoryMeta: AutoBackupMeta = { ...DEFAULT_META };
let inFlightBackupPromise: Promise<AutoBackupCheckResult> | null = null;
const listeners = new Set<(meta: AutoBackupMeta) => void>();

function getSafeLocalStorage(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Ignore storage access errors in restricted frames
  }
  return null;
}

function sanitizeMeta(raw: unknown): AutoBackupMeta {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_META };
  }
  const obj = raw as Record<string, unknown>;
  const lastBackupAt =
    typeof obj.lastBackupAt === 'string' && !Number.isNaN(Date.parse(obj.lastBackupAt))
      ? obj.lastBackupAt
      : null;
  const firstTrackedAt =
    typeof obj.firstTrackedAt === 'string' && !Number.isNaN(Date.parse(obj.firstTrackedAt))
      ? obj.firstTrackedAt
      : null;
  const changesRaw = Number(obj.changesSinceLastBackup);
  const changesSinceLastBackup =
    Number.isFinite(changesRaw) && changesRaw >= 0 ? Math.floor(changesRaw) : 0;
  const reasonRaw = obj.lastTriggerReason;
  const lastTriggerReason: AutoBackupTriggerReason | null =
    reasonRaw === 'manual' || reasonRaw === 'changes' || reasonRaw === 'weekly'
      ? reasonRaw
      : null;
  const totalRaw = Number(obj.totalAutoBackupsCount);
  const totalAutoBackupsCount =
    Number.isFinite(totalRaw) && totalRaw >= 0 ? Math.floor(totalRaw) : 0;

  return {
    lastBackupAt,
    firstTrackedAt,
    changesSinceLastBackup,
    lastTriggerReason,
    totalAutoBackupsCount,
  };
}

export function getAutoBackupMeta(): AutoBackupMeta {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return { ...memoryMeta };
  }
  try {
    const raw = storage.getItem(AUTO_BACKUP_STORAGE_KEY);
    if (!raw) {
      return { ...memoryMeta };
    }
    const parsed: unknown = JSON.parse(raw);
    memoryMeta = sanitizeMeta(parsed);
    return { ...memoryMeta };
  } catch {
    return { ...memoryMeta };
  }
}

function persistMeta(next: AutoBackupMeta): AutoBackupMeta {
  memoryMeta = { ...next };
  const storage = getSafeLocalStorage();
  if (storage) {
    try {
      storage.setItem(AUTO_BACKUP_STORAGE_KEY, JSON.stringify(memoryMeta));
    } catch {
      // Ignore quota errors
    }
  }
  for (const listener of listeners) {
    try {
      listener({ ...memoryMeta });
    } catch {
      // Ignore listener errors
    }
  }
  return { ...memoryMeta };
}

export function subscribeAutoBackupMeta(listener: (meta: AutoBackupMeta) => void): () => void {
  listeners.add(listener);
  listener(getAutoBackupMeta());
  return () => {
    listeners.delete(listener);
  };
}

export function recordManualBackupSuccess(nowMs: number = Date.now()): AutoBackupMeta {
  const current = getAutoBackupMeta();
  const iso = new Date(nowMs).toISOString();
  return persistMeta({
    ...current,
    lastBackupAt: iso,
    firstTrackedAt: current.firstTrackedAt || iso,
    changesSinceLastBackup: 0,
    lastTriggerReason: 'manual',
  });
}

function isWeeklyBackupDue(meta: AutoBackupMeta, nowMs: number): boolean {
  const anchorIso = meta.lastBackupAt || meta.firstTrackedAt;
  if (!anchorIso) return false;
  const anchorMs = Date.parse(anchorIso);
  if (Number.isNaN(anchorMs)) return false;
  return nowMs - anchorMs >= AUTO_BACKUP_INTERVAL_MS;
}

async function runScheduledBackup(
  reason: 'changes' | 'weekly',
  nowMs: number,
  executor: BackupExecutorFn
): Promise<AutoBackupCheckResult> {
  if (inFlightBackupPromise) {
    return inFlightBackupPromise;
  }

  inFlightBackupPromise = (async (): Promise<AutoBackupCheckResult> => {
    try {
      const outcome = await executor();
      const latest = getAutoBackupMeta();
      if (outcome.ok) {
        const iso = new Date(nowMs).toISOString();
        const saved = persistMeta({
          ...latest,
          lastBackupAt: iso,
          firstTrackedAt: latest.firstTrackedAt || iso,
          changesSinceLastBackup: 0,
          lastTriggerReason: reason,
          totalAutoBackupsCount: latest.totalAutoBackupsCount + 1,
        });
        return { triggered: true, ok: true, reason, meta: saved };
      }
      return { triggered: true, ok: false, reason, meta: latest };
    } catch {
      return { triggered: true, ok: false, reason, meta: getAutoBackupMeta() };
    } finally {
      inFlightBackupPromise = null;
    }
  })();

  return inFlightBackupPromise;
}

/**
 * Increments the profile change counter and triggers an automatic server backup
 * if 25 profile changes have accumulated OR 7 days have passed since the last backup (IMP-16).
 */
export async function recordProfileChangeAndMaybeBackup(options?: {
  delta?: number;
  nowMs?: number;
  executor?: BackupExecutorFn;
}): Promise<AutoBackupCheckResult> {
  const nowMs = options?.nowMs ?? Date.now();
  const delta = Math.max(1, Math.floor(options?.delta ?? 1));
  const executor = options?.executor ?? triggerImmediateServerBackup;

  const current = getAutoBackupMeta();
  const nowIso = new Date(nowMs).toISOString();
  const updated = persistMeta({
    ...current,
    firstTrackedAt: current.firstTrackedAt || nowIso,
    changesSinceLastBackup: current.changesSinceLastBackup + delta,
  });

  if (updated.changesSinceLastBackup >= AUTO_BACKUP_CHANGE_THRESHOLD) {
    return runScheduledBackup('changes', nowMs, executor);
  }

  if (isWeeklyBackupDue(updated, nowMs)) {
    return runScheduledBackup('weekly', nowMs, executor);
  }

  return {
    triggered: false,
    ok: true,
    reason: null,
    meta: updated,
  };
}

/**
 * Checks on startup / periodic tick whether 7 days have elapsed since the last backup (IMP-16).
 */
export async function checkWeeklyAutoBackup(options?: {
  nowMs?: number;
  executor?: BackupExecutorFn;
}): Promise<AutoBackupCheckResult> {
  const nowMs = options?.nowMs ?? Date.now();
  const executor = options?.executor ?? triggerImmediateServerBackup;
  const current = getAutoBackupMeta();

  const ensured = current.firstTrackedAt
    ? current
    : persistMeta({
        ...current,
        firstTrackedAt: new Date(nowMs).toISOString(),
      });

  if (isWeeklyBackupDue(ensured, nowMs)) {
    return runScheduledBackup('weekly', nowMs, executor);
  }

  return {
    triggered: false,
    ok: true,
    reason: null,
    meta: ensured,
  };
}

export function formatLastBackupLabel(
  meta: AutoBackupMeta = getAutoBackupMeta(),
  nowMs: number = Date.now()
): string {
  if (!meta.lastBackupAt) {
    if (meta.changesSinceLastBackup > 0) {
      return `Son yedek: Henüz alınmadı · ${meta.changesSinceLastBackup}/${AUTO_BACKUP_CHANGE_THRESHOLD} değişiklik`;
    }
    return 'Son yedek: Henüz alınmadı';
  }

  const ts = Date.parse(meta.lastBackupAt);
  if (Number.isNaN(ts)) {
    return 'Son yedek: Bilinmiyor';
  }

  const diffMs = Math.max(0, nowMs - ts);
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  let relative = 'Az önce';
  if (diffDays >= 1) {
    relative = `${diffDays} gün önce`;
  } else if (diffHours >= 1) {
    relative = `${diffHours} saat önce`;
  } else if (diffMin >= 1) {
    relative = `${diffMin} dk önce`;
  }

  const reasonBadge =
    meta.lastTriggerReason === 'changes'
      ? 'otomatik · 25 değişiklik'
      : meta.lastTriggerReason === 'weekly'
        ? 'otomatik · haftalık'
        : 'manuel';

  return `Son yedek: ${relative} (${reasonBadge})`;
}

export function resetAutoBackupForTests(): void {
  memoryMeta = { ...DEFAULT_META };
  inFlightBackupPromise = null;
  const storage = getSafeLocalStorage();
  if (storage) {
    try {
      storage.removeItem(AUTO_BACKUP_STORAGE_KEY);
    } catch {
      // Ignore
    }
  }
}

import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeDataDocument,
  buildTasteProfileV3,
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  type DataDocument,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import {
  areUserDataDocumentsSemanticallyEqual,
  reconcileUserDataDocumentsLossless,
} from '../core/user-data-merge.ts';
import {
  DEFAULT_MAX_DATA_BYTES,
  DEFAULT_MAX_ITEMS_PER_PROFILE,
  DEFAULT_MAX_PROFILES,
  DEFAULT_MAX_SNAPSHOTS,
  formatMaxDataLimitMb,
  measureUtf8Bytes,
} from '../core/limits.ts';
import {
  cleanupStaleTempFiles,
  readJsonFileWithRecovery,
  readJsonFileWithRecoveryAsync,
  tryParseValidJson,
  tryParseValidJsonAsync,
  writeJsonFileAtomic,
  writeJsonFileAtomicAsync,
} from './atomic-json.ts';
export interface StorageOptions {
  dataDir?: string;
  maxDataBytes?: number;
  maxProfiles?: number;
  maxItemsPerProfile?: number;
  maxSnapshots?: number;
}

export interface BackupMetadata {
  id: string;
  createdAt: string;
  revision: number;
  profilesCount: number;
  itemsCount: number;
}

export interface SaveDataOptions {
  expectedRevision?: number | null;
  confirmBulkDelete?: boolean;
  requirePrecondition?: boolean;
  forceOverwrite?: boolean;
  hasInvalidIfMatch?: boolean;
  mergeStrategy?: 'lossless';
  foldUnhydratedDefaultProfile?: boolean;
}

export type SaveDataResult =
  | {
      ok: true;
      document: DataDocument;
      totalItems: number;
      merged?: boolean;
    }
  | {
      ok: false;
      status: 400 | 409 | 412 | 413 | 428 | 500;
      code:
        | 'invalid_document'
        | 'revision_conflict'
        | 'precondition_required'
        | 'sudden_item_drop'
        | 'payload_too_large'
        | 'corrupt_storage';
      message: string;
      currentRevision?: number;
      expectedRevision?: number;
      existingItems?: number;
      incomingItems?: number;
      serverDocument?: DataDocument;
    };

export function countTotalItems(doc: DataDocument | null | undefined): number {
  if (!doc || !Array.isArray(doc.profiles)) return 0;
  return doc.profiles.reduce(
    (sum, profile) => sum + (Array.isArray(profile.items) ? profile.items.length : 0),
    0
  );
}

function isWorthKeeping(doc: DataDocument): boolean {
  const profiles = Array.isArray(doc.profiles) ? doc.profiles : [];
  return (
    profiles.length > 0 &&
    (profiles.some((profile) => Array.isArray(profile?.items) && profile.items.length > 0) ||
      profiles.length > 1 ||
      (doc.revision ?? 0) > 0)
  );
}

const SNAPSHOT_FILE_PATTERN = /^cinetrack-[a-zA-Z0-9._-]+\.json$/;

function formatSnapshotFileName(revision: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(16).slice(2, 6);
  return `cinetrack-${stamp}-rev${revision}-${suffix}.json`;
}

export function createDataStorage(options: StorageOptions) {
  const resolvedDataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'data'));
  const dataFile = path.join(resolvedDataDir, 'cinetrack-data.json');
  const backupFile = `${dataFile}.bak`;
  const isolatedProfileFile = path.join(resolvedDataDir, 'profile.json');
  const isolatedUserListsFile = path.join(resolvedDataDir, 'user-lists.json');
  const backupsDir = path.join(resolvedDataDir, 'backups');

  const maxDataBytes = options.maxDataBytes ?? DEFAULT_MAX_DATA_BYTES;
  const maxProfiles = options.maxProfiles ?? DEFAULT_MAX_PROFILES;
  const maxItemsPerProfile = options.maxItemsPerProfile ?? DEFAULT_MAX_ITEMS_PER_PROFILE;
  const maxSnapshots = Math.max(1, options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS);

  mkdirSync(resolvedDataDir, { recursive: true });
  mkdirSync(backupsDir, { recursive: true });
  cleanupStaleTempFiles(resolvedDataDir);
  cleanupStaleTempFiles(backupsDir);

  let unrecoverableCorruptionError: string | null = null;
  let writeQueue: Promise<unknown> = Promise.resolve();

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = writeQueue.then(task);
    writeQueue = run.catch(() => undefined);
    return run;
  }

  function emptyDocument(): DataDocument {
    return {
      version: 3,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      activeProfileId: '',
      profiles: [],
      revision: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }

  function validateRawDocument(raw: unknown): DataDocument | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const normalized = normalizeDataDocument(raw, {
      maxProfiles,
      maxItems: maxItemsPerProfile,
    });
    if (!normalized) return null;
    const rawRev = Number(obj.revision);
    normalized.revision = Number.isSafeInteger(rawRev) && rawRev >= 0 ? rawRev : 0;
    normalized.updatedAt =
      typeof obj.updatedAt === 'string' && obj.updatedAt ? obj.updatedAt : undefined;
    return normalized;
  }

  function listDiskSnapshotFilesNewestFirstSync(): string[] {
    if (!existsSync(backupsDir)) return [];
    try {
      return readdirSync(backupsDir)
        .filter((f) => f.startsWith('cinetrack-') && f.endsWith('.json'))
        .sort((a, b) => b.localeCompare(a));
    } catch {
      return [];
    }
  }

  async function listDiskSnapshotFilesNewestFirstAsync(): Promise<string[]> {
    try {
      const entries = await fsPromises.readdir(backupsDir);
      return entries
        .filter((f) => f.startsWith('cinetrack-') && f.endsWith('.json'))
        .sort((a, b) => b.localeCompare(a));
    } catch {
      return [];
    }
  }

  function getDiskRecoveryBackupPathsSync(): string[] {
    const snaps = listDiskSnapshotFilesNewestFirstSync().map((f) => path.join(backupsDir, f));
    return [backupFile, ...snaps];
  }

  async function getDiskRecoveryBackupPathsAsync(): Promise<string[]> {
    const snaps = (await listDiskSnapshotFilesNewestFirstAsync()).map((f) =>
      path.join(backupsDir, f)
    );
    return [backupFile, ...snaps];
  }

  function readData(): DataDocument {
    const recovery = readJsonFileWithRecovery<DataDocument>(dataFile, {
      backupPaths: getDiskRecoveryBackupPathsSync(),
      validate: validateRawDocument,
      label: 'cinetrack-data.json',
    });
    if (recovery.status === 'missing') {
      unrecoverableCorruptionError = null;
      return emptyDocument();
    }
    if (recovery.status === 'corrupt_unrecoverable') {
      unrecoverableCorruptionError = recovery.error;
      return emptyDocument();
    }
    unrecoverableCorruptionError = null;
    return recovery.data;
  }

  async function readDataAsync(): Promise<DataDocument> {
    const recovery = await readJsonFileWithRecoveryAsync<DataDocument>(dataFile, {
      backupPaths: await getDiskRecoveryBackupPathsAsync(),
      validate: validateRawDocument,
      label: 'cinetrack-data.json',
    });
    if (recovery.status === 'missing') {
      unrecoverableCorruptionError = null;
      return emptyDocument();
    }
    if (recovery.status === 'corrupt_unrecoverable') {
      unrecoverableCorruptionError = recovery.error;
      return emptyDocument();
    }
    unrecoverableCorruptionError = null;
    return recovery.data;
  }

  function buildIsolatedProfilePayload(doc: DataDocument) {
    const nowIso = doc.updatedAt || new Date().toISOString();
    return {
      schemaVersion: doc.schemaVersion ?? CURRENT_SCHEMA_VERSION,
      activeProfileId: doc.activeProfileId,
      updatedAt: nowIso,
      profiles: (doc.profiles || []).map((p) => {
        const taste = buildTasteProfileV3(p.items || [], {
          dislikedKeys: p.preferences?.disliked || [],
        });
        return {
          profileId: p.id,
          name: p.name,
          theme: 'dark-navy',
          dna: {
            positiveGenres: taste.positiveGenres.slice(0, 6),
            mediaPreference: taste.mediaPreference,
          },
          preferences: p.preferences,
          favoriteActors: p.favoriteActors || [],
          isDemo: Boolean(p.isDemo),
        };
      }),
    };
  }

  function toCompactListItem(it: SavedItem) {
    return {
      id: it.id,
      media_type: it.media_type,
      status: it.status,
      personal_rating: it.personal_rating,
      ...(it.addedAt ? { addedAt: it.addedAt } : {}),
      ...(it.updatedAt ? { updatedAt: it.updatedAt } : {}),
      ...(it.custom ? { custom: true } : {}),
      ...(it.current_season !== undefined ? { current_season: it.current_season } : {}),
      ...(it.episodes_watched !== undefined ? { episodes_watched: it.episodes_watched } : {}),
      ...(it.season_progress ? { season_progress: it.season_progress } : {}),
    };
  }

  function buildIsolatedUserListsPayload(doc: DataDocument) {
    const nowIso = doc.updatedAt || new Date().toISOString();
    const lists: Record<string, ReturnType<typeof toCompactListItem>[]> = {};
    for (const p of doc.profiles || []) {
      lists[p.id] = Array.isArray(p.items) ? p.items.map(toCompactListItem) : [];
    }
    return {
      schemaVersion: doc.schemaVersion ?? CURRENT_SCHEMA_VERSION,
      activeProfileId: doc.activeProfileId,
      updatedAt: nowIso,
      lists,
    };
  }

  async function readIsolatedProfileAsync() {
    return buildIsolatedProfilePayload(await readDataAsync());
  }

  async function readIsolatedUserListsAsync() {
    return buildIsolatedUserListsPayload(await readDataAsync());
  }

  function validateAndPrepareSave(
    current: DataDocument,
    rawPayload: unknown,
    saveOptions: SaveDataOptions
  ):
    | { ok: true; documentToPersist: DataDocument; incomingItems: number; merged: boolean }
    | Extract<SaveDataResult, { ok: false }> {
    if (unrecoverableCorruptionError) {
      return {
        ok: false,
        status: 500,
        code: 'corrupt_storage',
        message: `Mevcut veri bozuk olduğu ve geçerli bir yedek bulunamadığı için üzerine yazma engellendi (${unrecoverableCorruptionError}).`,
      };
    }

    let rawBytes = 0;
    try {
      rawBytes = measureUtf8Bytes(JSON.stringify(rawPayload ?? null));
    } catch {
      return {
        ok: false,
        status: 400,
        code: 'invalid_document',
        message: 'Veri biçimi geçersiz.',
      };
    }

    if (rawBytes > maxDataBytes) {
      return {
        ok: false,
        status: 413,
        code: 'payload_too_large',
        message: `Gönderilen veri boyutu izin verilen sınırı (${formatMaxDataLimitMb(maxDataBytes)}) aşıyor.`,
      };
    }

    const normalized = normalizeDataDocument(rawPayload, {
      maxProfiles,
      maxItems: maxItemsPerProfile,
    });
    if (!normalized) {
      return {
        ok: false,
        status: 400,
        code: 'invalid_document',
        message: 'Veri biçimi geçersiz.',
      };
    }

    const currentRevision = current.revision ?? 0;
    const expectedRevision = saveOptions.expectedRevision;

    if (saveOptions.hasInvalidIfMatch) {
      return {
        ok: false,
        status: 412,
        code: 'revision_conflict',
        message: `Geçersiz If-Match başlığı gönderildi (mevcut rev-${currentRevision}).`,
        currentRevision,
        serverDocument: current,
      };
    }

    const useLosslessMerge =
      saveOptions.mergeStrategy === 'lossless' &&
      !saveOptions.forceOverwrite &&
      !saveOptions.confirmBulkDelete;

    if (useLosslessMerge) {
      let effectiveDoc: DataDocument = normalized;
      let mergedFlag = false;

      if (Array.isArray(current.profiles) && current.profiles.length > 0) {
        const isMatchingRevision =
          expectedRevision !== undefined &&
          expectedRevision !== null &&
          Number.isSafeInteger(expectedRevision) &&
          expectedRevision === currentRevision &&
          !saveOptions.foldUnhydratedDefaultProfile;

        const mergeOutcome = reconcileUserDataDocumentsLossless(normalized, current, {
          foldUnhydratedDefaultProfile: saveOptions.foldUnhydratedDefaultProfile,
          authoritativeScalarSide: isMatchingRevision ? 'local' : 'union',
        });
        effectiveDoc = mergeOutcome.mergedDoc;
        mergedFlag = !areUserDataDocumentsSemanticallyEqual(normalized, effectiveDoc);
      }

      const nextRevision = currentRevision + 1;
      const nowIso = new Date().toISOString();
      const documentToPersist: DataDocument = {
        ...effectiveDoc,
        revision: nextRevision,
        updatedAt: nowIso,
      };

      const persistedBytes = measureUtf8Bytes(JSON.stringify(documentToPersist, null, 2));
      if (persistedBytes > maxDataBytes) {
        return {
          ok: false,
          status: 413,
          code: 'payload_too_large',
          message: `Gönderilen veri boyutu izin verilen sınırı (${formatMaxDataLimitMb(maxDataBytes)}) aşıyor.`,
        };
      }

      return {
        ok: true,
        documentToPersist,
        incomingItems: countTotalItems(documentToPersist),
        merged: mergedFlag,
      };
    }

    if (
      expectedRevision !== undefined &&
      expectedRevision !== null &&
      Number.isSafeInteger(expectedRevision)
    ) {
      if (expectedRevision !== currentRevision) {
        return {
          ok: false,
          status: currentRevision === 0 ? 412 : 409,
          code: 'revision_conflict',
          message: `Sunucuda daha güncel veya farklı bir veri sürümü var (beklenen rev-${expectedRevision}, mevcut rev-${currentRevision}).`,
          currentRevision,
          expectedRevision,
          serverDocument: current,
        };
      }
    } else if (
      saveOptions.requirePrecondition &&
      !saveOptions.forceOverwrite &&
      currentRevision > 0
    ) {
      return {
        ok: false,
        status: 428,
        code: 'precondition_required',
        message: `Mevcut sunucu verisinin (rev-${currentRevision}) üzerine koşulsuz yazma engellendi. If-Match başlığı gönderin veya açık üzerine yazma onayı verin.`,
        currentRevision,
        serverDocument: current,
      };
    }

    const existingItems = countTotalItems(current);
    const incomingItems = countTotalItems(normalized);
    if (
      !saveOptions.confirmBulkDelete &&
      existingItems >= 5 &&
      existingItems - incomingItems >= 3 &&
      incomingItems < existingItems * 0.5
    ) {
      return {
        ok: false,
        status: 409,
        code: 'sudden_item_drop',
        message: `Ani veri kaybı koruması devreye girdi (${existingItems} kayıttan ${incomingItems} kayda düşüş). Toplu silmeyi onaylayın veya sunucu verisini yükleyin.`,
        existingItems,
        incomingItems,
        currentRevision,
        serverDocument: current,
      };
    }

    const nextRevision = currentRevision + 1;
    const nowIso = new Date().toISOString();
    const documentToPersist: DataDocument = {
      ...normalized,
      revision: nextRevision,
      updatedAt: nowIso,
    };

    const persistedBytes = measureUtf8Bytes(JSON.stringify(documentToPersist, null, 2));
    if (persistedBytes > maxDataBytes) {
      return {
        ok: false,
        status: 413,
        code: 'payload_too_large',
        message: `Gönderilen veri boyutu izin verilen sınırı (${formatMaxDataLimitMb(maxDataBytes)}) aşıyor.`,
      };
    }

    return { ok: true, documentToPersist, incomingItems, merged: false };
  }

  function writeDiskSnapshotSync(doc: DataDocument): void {
    mkdirSync(backupsDir, { recursive: true });
    const snapName = formatSnapshotFileName(doc.revision ?? 0);
    const snapPath = path.join(backupsDir, snapName);
    writeJsonFileAtomic(snapPath, JSON.stringify(doc, null, 2), {
      validateParsed: (p) => validateRawDocument(p) !== null,
    });
    const allSnaps = listDiskSnapshotFilesNewestFirstSync();
    for (const staleName of allSnaps.slice(maxSnapshots)) {
      try {
        unlinkSync(path.join(backupsDir, staleName));
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async function writeDiskSnapshotAsync(doc: DataDocument): Promise<void> {
    await fsPromises.mkdir(backupsDir, { recursive: true });
    const snapName = formatSnapshotFileName(doc.revision ?? 0);
    const snapPath = path.join(backupsDir, snapName);
    await writeJsonFileAtomicAsync(snapPath, JSON.stringify(doc, null, 2), {
      validateParsed: (p) => validateRawDocument(p) !== null,
    });
    const allSnaps = await listDiskSnapshotFilesNewestFirstAsync();
    for (const staleName of allSnaps.slice(maxSnapshots)) {
      try {
        await fsPromises.unlink(path.join(backupsDir, staleName));
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  function persistDocumentDiskSync(current: DataDocument, next: DataDocument): void {
    if (isWorthKeeping(current)) {
      writeDiskSnapshotSync(current);
    }
    writeJsonFileAtomic(dataFile, JSON.stringify(next, null, 2), {
      backupPath: backupFile,
      validateParsed: (p) => validateRawDocument(p) !== null,
    });
    try {
      writeJsonFileAtomic(
        isolatedProfileFile,
        JSON.stringify(buildIsolatedProfilePayload(next), null, 2)
      );
      writeJsonFileAtomic(
        isolatedUserListsFile,
        JSON.stringify(buildIsolatedUserListsPayload(next), null, 2)
      );
    } catch {
      // Isolated mirror files are best-effort
    }
  }

  async function persistDocument(current: DataDocument, next: DataDocument): Promise<void> {
    if (isWorthKeeping(current)) {
      await writeDiskSnapshotAsync(current);
    }
    await writeJsonFileAtomicAsync(dataFile, JSON.stringify(next, null, 2), {
      backupPath: backupFile,
      validateParsed: (p) => validateRawDocument(p) !== null,
    });
    try {
      await writeJsonFileAtomicAsync(
        isolatedProfileFile,
        JSON.stringify(buildIsolatedProfilePayload(next), null, 2)
      );
      await writeJsonFileAtomicAsync(
        isolatedUserListsFile,
        JSON.stringify(buildIsolatedUserListsPayload(next), null, 2)
      );
    } catch {
      // Isolated mirror files are best-effort
    }
  }

  function saveData(rawPayload: unknown, saveOptions: SaveDataOptions = {}): SaveDataResult {
    const current = readData();
    const prepared = validateAndPrepareSave(current, rawPayload, saveOptions);
    if (!prepared.ok) {
      return prepared;
    }
    persistDocumentDiskSync(current, prepared.documentToPersist);
    unrecoverableCorruptionError = null;
    return {
      ok: true,
      document: prepared.documentToPersist,
      totalItems: prepared.incomingItems,
      merged: prepared.merged,
    };
  }

  async function saveDataAsync(
    rawPayload: unknown,
    saveOptions: SaveDataOptions = {}
  ): Promise<SaveDataResult> {
    const current = await readDataAsync();
    const prepared = validateAndPrepareSave(current, rawPayload, saveOptions);
    if (!prepared.ok) {
      return prepared;
    }
    await persistDocument(current, prepared.documentToPersist);
    unrecoverableCorruptionError = null;
    return {
      ok: true,
      document: prepared.documentToPersist,
      totalItems: prepared.incomingItems,
      merged: prepared.merged,
    };
  }

  function saveDataSerialized(
    rawPayload: unknown,
    saveOptions: SaveDataOptions = {}
  ): Promise<SaveDataResult> {
    return serialize(() => saveDataAsync(rawPayload, saveOptions));
  }

  async function listBackupsAsync(): Promise<BackupMetadata[]> {
    const files = await listDiskSnapshotFilesNewestFirstAsync();
    const backups: BackupMetadata[] = [];
    for (const fileName of files) {
      const fullPath = path.join(backupsDir, fileName);
      const parsed = await tryParseValidJsonAsync<DataDocument>(fullPath, validateRawDocument);
      if (!parsed.ok) continue;
      let createdAt = parsed.data.updatedAt || '';
      if (!createdAt) {
        try {
          const stat = await fsPromises.stat(fullPath);
          createdAt = stat.mtime.toISOString();
        } catch {
          createdAt = new Date().toISOString();
        }
      }
      backups.push({
        id: fileName,
        createdAt,
        revision: parsed.data.revision ?? 0,
        profilesCount: parsed.data.profiles.length,
        itemsCount: countTotalItems(parsed.data),
      });
    }
    return backups;
  }

  function restoreBackup(backupId: string): DataDocument | null {
    const id = String(backupId || '').trim();
    if (!id || !SNAPSHOT_FILE_PATTERN.test(id)) return null;
    const fullPath = path.resolve(backupsDir, id);
    if (!fullPath.startsWith(backupsDir + path.sep) || !existsSync(fullPath)) return null;

    const parsed = tryParseValidJson<DataDocument>(fullPath, validateRawDocument);
    if (!parsed.ok) return null;

    const current = readData();
    const restoredDoc: DataDocument = {
      ...parsed.data,
      revision: (current.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    persistDocumentDiskSync(current, restoredDoc);
    unrecoverableCorruptionError = null;
    return restoredDoc;
  }

  async function restoreBackupAsync(backupId: string): Promise<DataDocument | null> {
    const id = String(backupId || '').trim();
    if (!id || !SNAPSHOT_FILE_PATTERN.test(id)) return null;
    const fullPath = path.resolve(backupsDir, id);
    if (!fullPath.startsWith(backupsDir + path.sep) || !existsSync(fullPath)) return null;
    const parsed = await tryParseValidJsonAsync<DataDocument>(fullPath, validateRawDocument);
    if (!parsed.ok) return null;

    const current = await readDataAsync();
    const restoredDoc: DataDocument = {
      ...parsed.data,
      revision: (current.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    await persistDocument(current, restoredDoc);
    unrecoverableCorruptionError = null;
    return restoredDoc;
  }

  function restoreBackupSerialized(backupId: string): Promise<DataDocument | null> {
    return serialize(() => restoreBackupAsync(backupId));
  }

  function backupExistingDataAsync(): Promise<void> {
    return serialize(async () => {
      const current = await readDataAsync();
      if (current.profiles.length === 0 && (current.revision ?? 0) === 0) return;
      await writeDiskSnapshotAsync(current);
    });
  }

  function createSafetySnapshotSerialized(): Promise<void> {
    return serialize(async () => {
      const current = await readDataAsync();
      if (!isWorthKeeping(current)) return;
      await writeDiskSnapshotAsync(current);
    });
  }

  function applySyncedDocumentSerialized(rawPayload: unknown): Promise<SaveDataResult> {
    return serialize(() =>
      saveDataAsync(rawPayload, {
        expectedRevision: null,
        confirmBulkDelete: true,
        forceOverwrite: true,
      })
    );
  }

  return {
    dataDir: resolvedDataDir,
    dataFile,
    backupsDir,
    maxDataBytes,
    hasUnrecoverableCorruption: () => Boolean(unrecoverableCorruptionError),
    readData,
    readDataAsync,
    readIsolatedProfileAsync,
    readIsolatedUserListsAsync,
    saveData,
    saveDataSerialized,
    backupExistingDataAsync,
    createSafetySnapshotSerialized,
    applySyncedDocumentSerialized,
    listBackupsAsync,
    restoreBackup,
    restoreBackupSerialized,
  };
}

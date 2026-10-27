import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import {
  normalizeDataDocument,
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  type DataDocument,
} from '../core/cinetrack-core.ts';
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
  FileWriteSerializer,
  readJsonFileWithRecovery,
  tryParseValidJson,
  writeJsonFileAtomic,
} from './atomic-json.ts';

export interface StorageOptions {
  dataDir: string;
  maxDataBytes?: number;
  maxProfiles?: number;
  maxItemsPerProfile?: number;
  maxSnapshots?: number;
}

export interface BackupMetadata {
  id: string;
  fileName: string;
  createdAt: string;
  sizeBytes: number;
  revision: number;
  profilesCount: number;
  itemsCount: number;
}

export interface SaveDataOptions {
  expectedRevision?: number | null;
  confirmBulkDelete?: boolean;
}

export type SaveDataResult =
  | {
      ok: true;
      document: DataDocument;
      totalItems: number;
    }
  | {
      ok: false;
      status: 400 | 409 | 413 | 500;
      code:
        | 'invalid_document'
        | 'revision_conflict'
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

export function createDataStorage(options: StorageOptions) {
  const dataDir = options.dataDir;
  const dataFile = path.join(dataDir, 'cinetrack-data.json');
  const dataBackupFile = path.join(dataDir, 'cinetrack-data.bak.json');
  const backupsDir = path.join(dataDir, 'backups');
  const maxDataBytes = options.maxDataBytes ?? DEFAULT_MAX_DATA_BYTES;
  const maxProfiles = options.maxProfiles ?? DEFAULT_MAX_PROFILES;
  const maxItemsPerProfile = options.maxItemsPerProfile ?? DEFAULT_MAX_ITEMS_PER_PROFILE;
  const maxSnapshots = Math.max(1, options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS);
  const writeSerializer = new FileWriteSerializer();

  mkdirSync(dataDir, { recursive: true });
  cleanupStaleTempFiles(dataDir);
  if (existsSync(backupsDir)) {
    cleanupStaleTempFiles(backupsDir);
  }

  let unrecoverableCorruptionError: string | null = null;

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

  function validateRawDocument(raw: any): DataDocument | null {
    const normalized = normalizeDataDocument(raw, {
      maxProfiles,
      maxItems: maxItemsPerProfile,
    });
    if (!normalized) return null;
    const rawRev = Number(raw?.revision);
    normalized.revision = Number.isSafeInteger(rawRev) && rawRev >= 0 ? rawRev : 0;
    normalized.updatedAt =
      typeof raw?.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : undefined;
    return normalized;
  }

  function listSortedSnapshotPaths(): string[] {
    if (!existsSync(backupsDir)) return [];
    try {
      return readdirSync(backupsDir)
        .filter((f) => f.startsWith('cinetrack-') && f.endsWith('.json'))
        .map((fileName) => {
          const fullPath = path.join(backupsDir, fileName);
          const stat = statSync(fullPath);
          return { fileName, fullPath, mtimeMs: stat.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.fileName < b.fileName ? 1 : -1))
        .map((entry) => entry.fullPath);
    } catch {
      return [];
    }
  }

  function readData(): DataDocument {
    const candidateBackups = [dataBackupFile, ...listSortedSnapshotPaths()];
    const recovery = readJsonFileWithRecovery<DataDocument>(dataFile, {
      backupPaths: candidateBackups,
      validate: validateRawDocument,
      label: 'cinetrack-data.json',
      restoreRecoveredToTarget: true,
    });

    if (recovery.status === 'ok' || recovery.status === 'recovered') {
      unrecoverableCorruptionError = null;
      return recovery.data;
    }

    if (recovery.status === 'corrupt_unrecoverable') {
      unrecoverableCorruptionError = recovery.error;
      return emptyDocument();
    }

    unrecoverableCorruptionError = null;
    return emptyDocument();
  }

  function pruneOldSnapshots(): void {
    if (!existsSync(backupsDir)) return;
    try {
      const validFiles = readdirSync(backupsDir)
        .filter((f) => f.startsWith('cinetrack-') && f.endsWith('.json'))
        .map((fileName) => {
          const fullPath = path.join(backupsDir, fileName);
          const stat = statSync(fullPath);
          const check = tryParseValidJson(fullPath, validateRawDocument);
          return { fileName, fullPath, mtimeMs: stat.mtimeMs, valid: check.ok };
        })
        .filter((entry) => entry.valid)
        .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.fileName < b.fileName ? 1 : -1));

      for (const stale of validFiles.slice(maxSnapshots)) {
        try {
          unlinkSync(stale.fullPath);
        } catch {}
      }
    } catch {}
  }

  function backupExistingData(): void {
    if (!existsSync(dataFile)) return;
    const validCheck = tryParseValidJson(dataFile, validateRawDocument);
    if (!validCheck.ok) {
      // Bozuk bir ana dosya asla sağlam .bak veya snapshot yedeğinin üzerine kopyalanmaz!
      return;
    }

    const parsedExisting = validCheck.data;
    const profiles = Array.isArray(parsedExisting?.profiles) ? parsedExisting.profiles : [];
    const worthKeeping =
      profiles.length > 0 &&
      (profiles.some((profile) => Array.isArray(profile?.items) && profile.items.length > 0) ||
        profiles.length > 1);

    if (!worthKeeping) return;

    copyFileSync(dataFile, dataBackupFile);

    try {
      mkdirSync(backupsDir, { recursive: true });
      const dateStamp = new Date().toISOString().slice(0, 10);
      const rev = Number.isSafeInteger(Number(parsedExisting.revision))
        ? Number(parsedExisting.revision)
        : 0;
      const snapshotName = `cinetrack-${dateStamp}-rev${rev}-${Date.now()}.json`;
      const snapshotPath = path.join(backupsDir, snapshotName);
      const serializedExisting = JSON.stringify(parsedExisting, null, 2);
      writeJsonFileAtomic(snapshotPath, serializedExisting, {
        validateParsed: (p) => validateRawDocument(p) !== null,
      });
      pruneOldSnapshots();
    } catch (error: any) {
      console.error('Yedek anlık görüntüsü oluşturulamadı:', error?.message || error);
    }
  }

  function writeDataAtomic(doc: DataDocument): DataDocument {
    mkdirSync(dataDir, { recursive: true });
    backupExistingData();
    const serialized = JSON.stringify(doc, null, 2);
    writeJsonFileAtomic(dataFile, serialized, {
      validateParsed: (p) => validateRawDocument(p) !== null,
    });
    unrecoverableCorruptionError = null;
    return doc;
  }

  function saveData(rawPayload: unknown, saveOptions: SaveDataOptions = {}): SaveDataResult {
    // 1. Önce bozuk ve kurtarılamamış bir ana dosya olup olmadığını denetle (sessiz veri kaybını engelle)
    const current = readData();
    if (unrecoverableCorruptionError) {
      return {
        ok: false,
        status: 500,
        code: 'corrupt_storage',
        message: `Mevcut veri dosyası bozuk olduğu ve geçerli bir yedek bulunamadığı için üzerine yazma engellendi (${unrecoverableCorruptionError}).`,
      };
    }

    // 2. Bayt cinsinden boyut kontrolü (karakter uzunluğu değil, UTF-8 bayt boyutu)
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

    if (
      expectedRevision !== undefined &&
      expectedRevision !== null &&
      Number.isSafeInteger(expectedRevision) &&
      currentRevision > 0 &&
      expectedRevision !== currentRevision
    ) {
      return {
        ok: false,
        status: 409,
        code: 'revision_conflict',
        message: `Sunucuda daha güncel bir veri sürümü var (beklenen rev-${expectedRevision}, mevcut rev-${currentRevision}).`,
        currentRevision,
        expectedRevision,
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

    writeDataAtomic(documentToPersist);
    return {
      ok: true,
      document: documentToPersist,
      totalItems: incomingItems,
    };
  }

  function saveDataSerialized(
    rawPayload: unknown,
    saveOptions: SaveDataOptions = {}
  ): Promise<SaveDataResult> {
    return writeSerializer.run(dataFile, () => saveData(rawPayload, saveOptions));
  }

  function listBackups(): BackupMetadata[] {
    const result: BackupMetadata[] = [];
    if (existsSync(backupsDir)) {
      try {
        const files = readdirSync(backupsDir).filter(
          (f) => f.startsWith('cinetrack-') && f.endsWith('.json')
        );
        for (const fileName of files) {
          const fullPath = path.join(backupsDir, fileName);
          try {
            const stat = statSync(fullPath);
            const check = tryParseValidJson(fullPath, validateRawDocument);
            if (!check.ok) continue;
            const doc = check.data;
            result.push({
              id: fileName,
              fileName,
              createdAt: doc.updatedAt || new Date(stat.mtimeMs).toISOString(),
              sizeBytes: stat.size,
              revision: doc.revision ?? 0,
              profilesCount: doc.profiles.length,
              itemsCount: countTotalItems(doc),
            });
          } catch {}
        }
      } catch {}
    }

    if (existsSync(dataBackupFile)) {
      try {
        const stat = statSync(dataBackupFile);
        const check = tryParseValidJson(dataBackupFile, validateRawDocument);
        if (check.ok) {
          const doc = check.data;
          result.push({
            id: 'cinetrack-data.bak.json',
            fileName: 'cinetrack-data.bak.json',
            createdAt: doc.updatedAt || new Date(stat.mtimeMs).toISOString(),
            sizeBytes: stat.size,
            revision: doc.revision ?? 0,
            profilesCount: doc.profiles.length,
            itemsCount: countTotalItems(doc),
          });
        }
      } catch {}
    }

    return result.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  function restoreBackup(backupId: string): DataDocument | null {
    const safeName = path.basename(String(backupId || '').trim());
    if (!safeName || !safeName.endsWith('.json')) return null;

    const targetPath =
      safeName === 'cinetrack-data.bak.json' ? dataBackupFile : path.join(backupsDir, safeName);
    if (!existsSync(targetPath)) return null;

    const backupCheck = tryParseValidJson(targetPath, validateRawDocument);
    if (!backupCheck.ok) {
      return null;
    }

    const backupDoc = backupCheck.data;
    const current = readData();
    const nextRevision = (current.revision ?? 0) + 1;
    const restoredDoc: DataDocument = {
      ...backupDoc,
      revision: nextRevision,
      updatedAt: new Date().toISOString(),
    };
    writeDataAtomic(restoredDoc);
    return restoredDoc;
  }

  function createSafetySnapshotSerialized(): Promise<void> {
    return writeSerializer.run(dataFile, () => {
      backupExistingData();
    });
  }

  function applySyncedDocumentSerialized(rawPayload: unknown): Promise<SaveDataResult> {
    return writeSerializer.run(dataFile, () =>
      saveData(rawPayload, { expectedRevision: null, confirmBulkDelete: true })
    );
  }

  return {
    dataFile,
    dataBackupFile,
    backupsDir,
    maxDataBytes,
    hasUnrecoverableCorruption: () => Boolean(unrecoverableCorruptionError),
    readData,
    saveData,
    saveDataSerialized,
    createSafetySnapshotSerialized,
    applySyncedDocumentSerialized,
    listBackups,
    restoreBackup,
  };
}

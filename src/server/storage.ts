import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  normalizeDataDocument,
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  type DataDocument,
} from '../core/cinetrack-core.ts';

export interface StorageOptions {
  dataDir: string;
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
      status: 400 | 409;
      code: 'invalid_document' | 'revision_conflict' | 'sudden_item_drop';
      message: string;
      currentRevision?: number;
      expectedRevision?: number;
      existingItems?: number;
      incomingItems?: number;
      serverDocument?: DataDocument;
    };

export function countTotalItems(doc: DataDocument | null | undefined): number {
  if (!doc || !Array.isArray(doc.profiles)) return 0;
  return doc.profiles.reduce((sum, profile) => sum + (Array.isArray(profile.items) ? profile.items.length : 0), 0);
}

export function createDataStorage(options: StorageOptions) {
  const dataDir = options.dataDir;
  const dataFile = path.join(dataDir, 'cinetrack-data.json');
  const dataBackupFile = path.join(dataDir, 'cinetrack-data.bak.json');
  const backupsDir = path.join(dataDir, 'backups');
  const maxProfiles = options.maxProfiles ?? 20;
  const maxItemsPerProfile = options.maxItemsPerProfile ?? 5000;
  const maxSnapshots = Math.max(1, options.maxSnapshots ?? 7);

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

  function parseNormalizedFile(filePath: string): DataDocument | null {
    if (!existsSync(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    const normalized = normalizeDataDocument(raw, {
      maxProfiles,
      maxItems: maxItemsPerProfile,
    });
    if (!normalized) return null;
    const rawRev = Number(raw?.revision);
    normalized.revision = Number.isSafeInteger(rawRev) && rawRev >= 0 ? rawRev : 0;
    normalized.updatedAt = typeof raw?.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : undefined;
    return normalized;
  }

  function readData(): DataDocument {
    for (const file of [dataFile, dataBackupFile]) {
      try {
        const doc = parseNormalizedFile(file);
        if (doc) return doc;
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          console.error(`Veri dosyası okunamadı (${path.basename(file)}):`, error?.message || error);
        }
      }
    }
    return emptyDocument();
  }

  function pruneOldSnapshots(): void {
    if (!existsSync(backupsDir)) return;
    try {
      const files = readdirSync(backupsDir)
        .filter((f) => f.startsWith('cinetrack-') && f.endsWith('.json'))
        .map((fileName) => {
          const fullPath = path.join(backupsDir, fileName);
          const stat = statSync(fullPath);
          return { fileName, fullPath, mtimeMs: stat.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.fileName < b.fileName ? 1 : -1));

      for (const stale of files.slice(maxSnapshots)) {
        try {
          unlinkSync(stale.fullPath);
        } catch {}
      }
    } catch {}
  }

  function backupExistingData(): void {
    if (!existsSync(dataFile)) return;
    let worthKeeping = true;
    let parsedExisting: any = null;
    try {
      parsedExisting = JSON.parse(readFileSync(dataFile, 'utf8'));
      const profiles = Array.isArray(parsedExisting?.profiles) ? parsedExisting.profiles : [];
      worthKeeping =
        profiles.length > 0
          ? profiles.some((profile: any) => Array.isArray(profile?.items) && profile.items.length > 0) ||
            profiles.length > 1
          : Boolean(parsedExisting?.profileName) ||
            (Array.isArray(parsedExisting?.items) && parsedExisting.items.length > 0);
    } catch {
      worthKeeping = true;
    }

    if (!worthKeeping) return;

    copyFileSync(dataFile, dataBackupFile);

    try {
      mkdirSync(backupsDir, { recursive: true });
      const dateStamp = new Date().toISOString().slice(0, 10);
      const rev = Number.isSafeInteger(Number(parsedExisting?.revision)) ? Number(parsedExisting.revision) : 0;
      const snapshotName = `cinetrack-${dateStamp}-rev${rev}-${Date.now()}.json`;
      const snapshotPath = path.join(backupsDir, snapshotName);
      copyFileSync(dataFile, snapshotPath);
      pruneOldSnapshots();
    } catch (error: any) {
      console.error('Yedek anlık görüntüsü oluşturulamadı:', error?.message || error);
    }
  }

  function writeDataAtomic(doc: DataDocument): DataDocument {
    mkdirSync(dataDir, { recursive: true });
    backupExistingData();
    const temporaryFile = `${dataFile}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryFile, JSON.stringify(doc, null, 2), 'utf8');
    renameSync(temporaryFile, dataFile);
    return doc;
  }

  function saveData(rawPayload: unknown, saveOptions: SaveDataOptions = {}): SaveDataResult {
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

    const current = readData();
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

    writeDataAtomic(documentToPersist);
    return {
      ok: true,
      document: documentToPersist,
      totalItems: incomingItems,
    };
  }

  function listBackups(): BackupMetadata[] {
    const result: BackupMetadata[] = [];
    if (existsSync(backupsDir)) {
      try {
        const files = readdirSync(backupsDir).filter((f) => f.startsWith('cinetrack-') && f.endsWith('.json'));
        for (const fileName of files) {
          const fullPath = path.join(backupsDir, fileName);
          try {
            const stat = statSync(fullPath);
            const doc = parseNormalizedFile(fullPath);
            if (!doc) continue;
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
        const doc = parseNormalizedFile(dataBackupFile);
        if (doc) {
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

    let backupDoc: DataDocument | null = null;
    try {
      backupDoc = parseNormalizedFile(targetPath);
    } catch {
      backupDoc = null;
    }
    if (!backupDoc) return null;

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

  return {
    dataFile,
    dataBackupFile,
    backupsDir,
    readData,
    saveData,
    listBackups,
    restoreBackup,
  };
}

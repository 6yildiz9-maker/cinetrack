import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
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
  readJsonFileWithRecoveryAsync,
  tryParseValidJson,
  tryParseValidJsonAsync,
  writeJsonFileAtomic,
  writeJsonFileAtomicAsync,
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
  requirePrecondition?: boolean;
  forceOverwrite?: boolean;
  hasInvalidIfMatch?: boolean;
}

export type SaveDataResult =
  | {
      ok: true;
      document: DataDocument;
      totalItems: number;
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

async function pathExistsAsync(targetPath: string): Promise<boolean> {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function createDataStorage(options: StorageOptions) {
  const dataDir = options.dataDir;
  const dataFile = path.join(dataDir, 'cinetrack-data.json');
  const dataBackupFile = path.join(dataDir, 'cinetrack-data.bak.json');
  const isolatedProfileFile = path.join(dataDir, 'profile.json');
  const isolatedUserListsFile = path.join(dataDir, 'user-lists.json');
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

  async function listSortedSnapshotPathsAsync(): Promise<string[]> {
    if (!(await pathExistsAsync(backupsDir))) return [];
    try {
      const files = (await fsPromises.readdir(backupsDir)).filter(
        (f) => f.startsWith('cinetrack-') && f.endsWith('.json')
      );
      const entries: Array<{ fileName: string; fullPath: string; mtimeMs: number }> = [];
      for (const fileName of files) {
        const fullPath = path.join(backupsDir, fileName);
        try {
          const stat = await fsPromises.stat(fullPath);
          entries.push({ fileName, fullPath, mtimeMs: stat.mtimeMs });
        } catch {}
      }
      return entries
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

  async function readDataAsync(): Promise<DataDocument> {
    const candidateBackups = [dataBackupFile, ...(await listSortedSnapshotPathsAsync())];
    const recovery = await readJsonFileWithRecoveryAsync<DataDocument>(dataFile, {
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

  async function pruneOldSnapshotsAsync(): Promise<void> {
    if (!(await pathExistsAsync(backupsDir))) return;
    try {
      const files = (await fsPromises.readdir(backupsDir)).filter(
        (f) => f.startsWith('cinetrack-') && f.endsWith('.json')
      );
      const validFiles: Array<{ fileName: string; fullPath: string; mtimeMs: number }> = [];
      for (const fileName of files) {
        const fullPath = path.join(backupsDir, fileName);
        try {
          const stat = await fsPromises.stat(fullPath);
          const check = await tryParseValidJsonAsync(fullPath, validateRawDocument);
          if (check.ok) {
            validFiles.push({ fileName, fullPath, mtimeMs: stat.mtimeMs });
          }
        } catch {}
      }
      validFiles.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.fileName < b.fileName ? 1 : -1));
      for (const stale of validFiles.slice(maxSnapshots)) {
        try {
          await fsPromises.unlink(stale.fullPath);
        } catch {}
      }
    } catch {}
  }

  function backupExistingData(): void {
    if (!existsSync(dataFile)) return;
    const validCheck = tryParseValidJson(dataFile, validateRawDocument);
    if (!validCheck.ok) {
      return;
    }

    const parsedExisting = validCheck.data;
    const profiles = Array.isArray(parsedExisting?.profiles) ? parsedExisting.profiles : [];
    const worthKeeping =
      profiles.length > 0 &&
      (profiles.some((profile) => Array.isArray(profile?.items) && profile.items.length > 0) ||
        profiles.length > 1);

    if (!worthKeeping) return;

    const serializedExisting = JSON.stringify(parsedExisting, null, 2);
    writeJsonFileAtomic(dataBackupFile, serializedExisting, {
      validateParsed: (p) => validateRawDocument(p) !== null,
    });

    try {
      mkdirSync(backupsDir, { recursive: true });
      const dateStamp = new Date().toISOString().slice(0, 10);
      const rev = Number.isSafeInteger(Number(parsedExisting.revision))
        ? Number(parsedExisting.revision)
        : 0;
      const snapshotName = `cinetrack-${dateStamp}-rev${rev}-${Date.now()}.json`;
      const snapshotPath = path.join(backupsDir, snapshotName);
      writeJsonFileAtomic(snapshotPath, serializedExisting, {
        validateParsed: (p) => validateRawDocument(p) !== null,
      });
      pruneOldSnapshots();
    } catch (error: any) {
      console.error('Yedek anlık görüntüsü oluşturulamadı:', error?.message || error);
    }
  }

  async function backupExistingDataAsync(): Promise<void> {
    if (!(await pathExistsAsync(dataFile))) return;
    const validCheck = await tryParseValidJsonAsync(dataFile, validateRawDocument);
    if (!validCheck.ok) {
      return;
    }

    const parsedExisting = validCheck.data;
    const profiles = Array.isArray(parsedExisting?.profiles) ? parsedExisting.profiles : [];
    const worthKeeping =
      profiles.length > 0 &&
      (profiles.some((profile) => Array.isArray(profile?.items) && profile.items.length > 0) ||
        profiles.length > 1);

    if (!worthKeeping) return;

    await fsPromises.copyFile(dataFile, dataBackupFile);

    try {
      await fsPromises.mkdir(backupsDir, { recursive: true });
      const dateStamp = new Date().toISOString().slice(0, 10);
      const rev = Number.isSafeInteger(Number(parsedExisting.revision))
        ? Number(parsedExisting.revision)
        : 0;
      const snapshotName = `cinetrack-${dateStamp}-rev${rev}-${Date.now()}.json`;
      const snapshotPath = path.join(backupsDir, snapshotName);
      const serializedExisting = JSON.stringify(parsedExisting, null, 2);
      await writeJsonFileAtomicAsync(snapshotPath, serializedExisting, {
        validateParsed: (p) => validateRawDocument(p) !== null,
      });
      await pruneOldSnapshotsAsync();
    } catch (error: any) {
      console.error('Yedek anlık görüntüsü oluşturulamadı:', error?.message || error);
    }
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

  function writeDataAtomic(doc: DataDocument): DataDocument {
    mkdirSync(dataDir, { recursive: true });
    backupExistingData();
    const serialized = JSON.stringify(doc, null, 2);
    writeJsonFileAtomic(dataFile, serialized, {
      validateParsed: (p) => validateRawDocument(p) !== null,
    });
    try {
      writeJsonFileAtomic(
        isolatedProfileFile,
        JSON.stringify(buildIsolatedProfilePayload(doc), null, 2),
        { validateParsed: (p) => Boolean(p && typeof p === 'object' && Array.isArray(p.profiles)) }
      );
      writeJsonFileAtomic(
        isolatedUserListsFile,
        JSON.stringify(buildIsolatedUserListsPayload(doc), null, 2),
        { validateParsed: (p) => Boolean(p && typeof p === 'object' && p.lists && typeof p.lists === 'object') }
      );
    } catch {}
    unrecoverableCorruptionError = null;
    return doc;
  }

  async function writeDataAtomicAsync(doc: DataDocument): Promise<DataDocument> {
    await fsPromises.mkdir(dataDir, { recursive: true });
    await backupExistingDataAsync();
    const serialized = JSON.stringify(doc, null, 2);
    await writeJsonFileAtomicAsync(dataFile, serialized, {
      validateParsed: (p) => validateRawDocument(p) !== null,
    });
    try {
      await Promise.all([
        writeJsonFileAtomicAsync(
          isolatedProfileFile,
          JSON.stringify(buildIsolatedProfilePayload(doc), null, 2),
          { validateParsed: (p) => Boolean(p && typeof p === 'object' && Array.isArray(p.profiles)) }
        ),
        writeJsonFileAtomicAsync(
          isolatedUserListsFile,
          JSON.stringify(buildIsolatedUserListsPayload(doc), null, 2),
          { validateParsed: (p) => Boolean(p && typeof p === 'object' && p.lists && typeof p.lists === 'object') }
        ),
      ]);
    } catch {}
    unrecoverableCorruptionError = null;
    return doc;
  }

  async function readIsolatedProfileAsync() {
    const recovery = await readJsonFileWithRecoveryAsync<ReturnType<typeof buildIsolatedProfilePayload>>(
      isolatedProfileFile,
      {
        validate: (raw) =>
          raw && typeof raw === 'object' && Array.isArray(raw.profiles) ? raw : null,
        label: 'profile.json',
      }
    );
    if (recovery.status === 'ok' || recovery.status === 'recovered') {
      return recovery.data;
    }
    const doc = await readDataAsync();
    return buildIsolatedProfilePayload(doc);
  }

  async function readIsolatedUserListsAsync() {
    const recovery = await readJsonFileWithRecoveryAsync<ReturnType<typeof buildIsolatedUserListsPayload>>(
      isolatedUserListsFile,
      {
        validate: (raw) =>
          raw && typeof raw === 'object' && raw.lists && typeof raw.lists === 'object' ? raw : null,
        label: 'user-lists.json',
      }
    );
    if (recovery.status === 'ok' || recovery.status === 'recovered') {
      return recovery.data;
    }
    const doc = await readDataAsync();
    return buildIsolatedUserListsPayload(doc);
  }

  function validateAndPrepareSave(
    current: DataDocument,
    rawPayload: unknown,
    saveOptions: SaveDataOptions
  ): { ok: true; documentToPersist: DataDocument; incomingItems: number } | Extract<SaveDataResult, { ok: false }> {
    if (unrecoverableCorruptionError) {
      return {
        ok: false,
        status: 500,
        code: 'corrupt_storage',
        message: `Mevcut veri dosyası bozuk olduğu ve geçerli bir yedek bulunamadığı için üzerine yazma engellendi (${unrecoverableCorruptionError}).`,
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
    } else if (saveOptions.requirePrecondition && !saveOptions.forceOverwrite && currentRevision > 0) {
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

    return { ok: true, documentToPersist, incomingItems };
  }

  function saveData(rawPayload: unknown, saveOptions: SaveDataOptions = {}): SaveDataResult {
    const current = readData();
    const prepared = validateAndPrepareSave(current, rawPayload, saveOptions);
    if (!prepared.ok) {
      return prepared;
    }
    writeDataAtomic(prepared.documentToPersist);
    return {
      ok: true,
      document: prepared.documentToPersist,
      totalItems: prepared.incomingItems,
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
    await writeDataAtomicAsync(prepared.documentToPersist);
    return {
      ok: true,
      document: prepared.documentToPersist,
      totalItems: prepared.incomingItems,
    };
  }

  function saveDataSerialized(
    rawPayload: unknown,
    saveOptions: SaveDataOptions = {}
  ): Promise<SaveDataResult> {
    return writeSerializer.run(dataFile, () => saveDataAsync(rawPayload, saveOptions));
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

  async function listBackupsAsync(): Promise<BackupMetadata[]> {
    const result: BackupMetadata[] = [];
    if (await pathExistsAsync(backupsDir)) {
      try {
        const files = (await fsPromises.readdir(backupsDir)).filter(
          (f) => f.startsWith('cinetrack-') && f.endsWith('.json')
        );
        for (const fileName of files) {
          const fullPath = path.join(backupsDir, fileName);
          try {
            const stat = await fsPromises.stat(fullPath);
            const check = await tryParseValidJsonAsync(fullPath, validateRawDocument);
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

    if (await pathExistsAsync(dataBackupFile)) {
      try {
        const stat = await fsPromises.stat(dataBackupFile);
        const check = await tryParseValidJsonAsync(dataBackupFile, validateRawDocument);
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

  async function restoreBackupAsync(backupId: string): Promise<DataDocument | null> {
    const safeName = path.basename(String(backupId || '').trim());
    if (!safeName || !safeName.endsWith('.json')) return null;

    const targetPath =
      safeName === 'cinetrack-data.bak.json' ? dataBackupFile : path.join(backupsDir, safeName);
    if (!(await pathExistsAsync(targetPath))) return null;

    const backupCheck = await tryParseValidJsonAsync(targetPath, validateRawDocument);
    if (!backupCheck.ok) {
      return null;
    }

    const backupDoc = backupCheck.data;
    const current = await readDataAsync();
    const nextRevision = (current.revision ?? 0) + 1;
    const restoredDoc: DataDocument = {
      ...backupDoc,
      revision: nextRevision,
      updatedAt: new Date().toISOString(),
    };
    await writeDataAtomicAsync(restoredDoc);
    return restoredDoc;
  }

  function restoreBackupSerialized(backupId: string): Promise<DataDocument | null> {
    return writeSerializer.run(dataFile, () => restoreBackupAsync(backupId));
  }

  function createSafetySnapshotSerialized(): Promise<void> {
    return writeSerializer.run(dataFile, () => backupExistingDataAsync());
  }

  function applySyncedDocumentSerialized(rawPayload: unknown): Promise<SaveDataResult> {
    return writeSerializer.run(dataFile, () =>
      saveDataAsync(rawPayload, {
        expectedRevision: null,
        confirmBulkDelete: true,
        forceOverwrite: true,
      })
    );
  }

  return {
    dataFile,
    dataBackupFile,
    isolatedProfileFile,
    isolatedUserListsFile,
    backupsDir,
    maxDataBytes,
    hasUnrecoverableCorruption: () => Boolean(unrecoverableCorruptionError),
    readData,
    readDataAsync,
    readIsolatedProfileAsync,
    readIsolatedUserListsAsync,
    saveData,
    saveDataAsync,
    saveDataSerialized,
    createSafetySnapshotSerialized,
    applySyncedDocumentSerialized,
    listBackups,
    listBackupsAsync,
    restoreBackup,
    restoreBackupSerialized,
  };
}

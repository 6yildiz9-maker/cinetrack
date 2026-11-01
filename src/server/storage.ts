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
import type { UserDataRepository } from './user-data-repository.ts';

export interface StorageOptions {
  repository: UserDataRepository;
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

function isWorthKeeping(doc: DataDocument): boolean {
  const profiles = Array.isArray(doc.profiles) ? doc.profiles : [];
  return (
    profiles.length > 0 &&
    (profiles.some((profile) => Array.isArray(profile?.items) && profile.items.length > 0) ||
      profiles.length > 1)
  );
}

export function createDataStorage(options: StorageOptions) {
  const repo = options.repository;
  const maxDataBytes = options.maxDataBytes ?? DEFAULT_MAX_DATA_BYTES;
  const maxProfiles = options.maxProfiles ?? DEFAULT_MAX_PROFILES;
  const maxItemsPerProfile = options.maxItemsPerProfile ?? DEFAULT_MAX_ITEMS_PER_PROFILE;
  const maxSnapshots = Math.max(1, options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS);

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

  async function readDataAsync(): Promise<DataDocument> {
    const raw: any = await repo.load();
    if (raw === null || raw === undefined) {
      unrecoverableCorruptionError = null;
      return emptyDocument();
    }
    if (Array.isArray(raw.profiles) && raw.profiles.length === 0 && Number(raw.revision) === 0) {
      unrecoverableCorruptionError = null;
      return emptyDocument();
    }
    const doc = validateRawDocument(raw);
    if (!doc) {
      unrecoverableCorruptionError = 'Veritabanındaki kullanıcı verisi doğrulanamadı';
      return emptyDocument();
    }
    unrecoverableCorruptionError = null;
    return doc;
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
  ): { ok: true; documentToPersist: DataDocument; incomingItems: number } | Extract<SaveDataResult, { ok: false }> {
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

  async function persistDocument(current: DataDocument, next: DataDocument): Promise<void> {
    await repo.save({
      document: next,
      snapshot: isWorthKeeping(current) ? current : null,
      keepSnapshots: maxSnapshots,
    });
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
    };
  }

  function saveDataSerialized(
    rawPayload: unknown,
    saveOptions: SaveDataOptions = {}
  ): Promise<SaveDataResult> {
    return serialize(() => saveDataAsync(rawPayload, saveOptions));
  }

  async function listBackupsAsync(): Promise<BackupMetadata[]> {
    const snapshots = await repo.listSnapshots();
    return snapshots.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      revision: s.revision,
      profilesCount: s.profilesCount,
      itemsCount: s.itemsCount,
    }));
  }

  async function restoreBackupAsync(backupId: string): Promise<DataDocument | null> {
    const id = String(backupId || '').trim();
    if (!id) return null;
    const raw = await repo.getSnapshot(id);
    if (!raw) return null;
    const backupDoc = validateRawDocument(raw);
    if (!backupDoc) return null;

    const current = await readDataAsync();
    const restoredDoc: DataDocument = {
      ...backupDoc,
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

  function createSafetySnapshotSerialized(): Promise<void> {
    return serialize(async () => {
      const current = await readDataAsync();
      if (!isWorthKeeping(current)) return;
      await repo.createSnapshot(current, maxSnapshots);
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
    maxDataBytes,
    hasUnrecoverableCorruption: () => Boolean(unrecoverableCorruptionError),
    readDataAsync,
    readIsolatedProfileAsync,
    readIsolatedUserListsAsync,
    saveDataSerialized,
    createSafetySnapshotSerialized,
    applySyncedDocumentSerialized,
    listBackupsAsync,
    restoreBackupSerialized,
  };
}

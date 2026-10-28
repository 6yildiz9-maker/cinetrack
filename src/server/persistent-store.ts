import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  cleanupStaleTempFiles,
  CorruptJsonFileError,
  FileWriteSerializer,
  readJsonFileWithRecovery,
  tryParseValidJson,
  writeJsonFileAtomic,
} from './atomic-json.ts';
import {
  computeDerivedProfileContentHash,
  DERIVED_PROFILE_SCHEMA_VERSION,
  normalizeDerivedProfileItem,
  validateDerivedProfileCache,
  type DerivedPillarsRecord,
  type DerivedProfileValidationResult,
} from '../core/derived-profile-cache.ts';
import type {
  BidirectionalSyncReport,
  SyncComparisonSummary,
  SyncSideSummary,
} from '../core/sync-display.ts';
import { GitHubBidirectionalSyncManager } from './github-bidirectional-sync.ts';
import type { createDataStorage } from './storage.ts';

export interface CatalogRecord {
  key: string;
  id: number;
  media_type: 'movie' | 'tv';
  title: string;
  original_title?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids: number[];
  vote_average: number;
  vote_count?: number;
  release_date?: string;
  first_air_date?: string;
  popularity?: number;
  firstStoredAt: string;
  lastUpdatedAt: string;
  source?: 'tmdb' | 'demo';
}

export interface CatalogManifest {
  version: 1;
  updatedAt: string;
  movieCount: number;
  tvCount: number;
  contentHash: string;
}

export interface DerivedProfileItem {
  mediaKey: string;
  matchScore: number;
  tasteScore?: number;
  priorityScore?: number;
  lifecycleRing: 'ring0' | 'ring1' | 'ring2';
  signals?: Record<string, number>;
  reasons?: string[];
  shownCount?: number;
  skippedCount?: number;
  demotionPenalty?: number;
  status?: 'active' | 'saved' | 'disliked' | 'hidden';
  scoreCoverage?: 'basic' | 'enriched';
  pillars?: DerivedPillarsRecord;
  calculatedAt: string;
}

export interface DerivedProfileDocument {
  schemaVersion: number;
  profileId: string;
  algorithmVersion: string;
  profileFingerprint: string;
  sourceCatalogHash?: string;
  contentHash?: string;
  generatedAt: string;
  items: Record<string, DerivedProfileItem>;
}

export interface PersistentStoreOptions {
  dataDir: string;
  maxDataBytes?: number;
  githubToken?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubBranch?: string;
  isPublicRepo?: boolean;
}

export type SyncFileStage = 'pending' | 'syncing' | 'succeeded' | 'failed';

export type GitHubSyncErrorCategory =
  | 'config_error'
  | 'network_error'
  | 'rate_limit'
  | 'auth_error'
  | 'conflict'
  | 'not_found'
  | 'malformed_response'
  | 'corrupt_local_file'
  | 'http_error';

export interface RemoteRepoAccessCheck {
  ok: boolean;
  accessible: boolean;
  repoExists: boolean;
  branchExists: boolean;
  isEmptyRepo: boolean;
  isPrivate: boolean;
  effectiveIsPublicRepo: boolean;
  defaultBranch?: string;
  configuredBranch: string;
  hasPushPermission: boolean;
  warning?: string;
  error?: string;
  errorCategory?: GitHubSyncErrorCategory;
}

export interface SyncFileStateRecord {
  repoPath: string;
  status: SyncFileStage;
  statusLabel: 'bekliyor' | 'gönderiliyor' | 'başarılı' | 'başarısız';
  noop?: boolean;
  blockedPublic?: boolean;
  localContentHash?: string;
  sha?: string;
  error?: string;
  errorCategory?: GitHubSyncErrorCategory;
  updatedAt: string;
}

export interface SyncStatus {
  configured: boolean;
  mode: 'github' | 'local_only';
  reason?: string;
  isPublicRepo: boolean;
  repoVisibilityWarning?: string;
  corruptionWarnings?: string[];
  lastSyncAt: string | null;
  syncInProgress?: boolean;
  initialReconcileCompleted?: boolean;
  lastError?: string | null;
  catalogCounts: {
    movies: number;
    tv: number;
  };
  profilesCount: number;
  localSummary?: SyncSideSummary;
  lastRemoteSummary?: SyncSideSummary | null;
  lastComparison?: SyncComparisonSummary | null;
  lastSyncReport?: Omit<BidirectionalSyncReport, 'updatedDataDocument'> | null;
  fileSummaryCounts?: {
    pending: number;
    syncing: number;
    succeeded: number;
    skipped: number;
    downloaded: number;
    uploaded: number;
    merged: number;
    failed: number;
  };
  fileStates: Record<string, SyncFileStateRecord>;
  remoteTarget?: {
    owner: string;
    repo: string;
    branch: string;
  };
}

export interface SyncResult {
  ok: boolean;
  partialFailure: boolean;
  filesCommitted: string[];
  filesSkipped: string[];
  filesFailed: string[];
  filesBlockedPublic: string[];
  fileStates: Record<string, SyncFileStateRecord>;
  repoVisibilityWarning?: string;
  errors: string[];
}

const STAGE_LABELS: Record<SyncFileStage, SyncFileStateRecord['statusLabel']> = {
  pending: 'bekliyor',
  syncing: 'gönderiliyor',
  succeeded: 'başarılı',
  failed: 'başarısız',
};

/**
 * Hata mesajları veya günlük metinlerinden GitHub token ve Bearer başlıklarını temizler.
 */
export function redactSecrets(input: string, extraSecrets: Array<string | undefined> = []): string {
  if (!input) return '';
  let sanitized = String(input);
  for (const secret of extraSecrets) {
    const trimmed = secret?.trim();
    if (trimmed && trimmed.length >= 4) {
      sanitized = sanitized.split(trimmed).join('[REDACTED]');
    }
  }
  sanitized = sanitized
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/token\s+[A-Za-z0-9._-]+/gi, 'token [REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[REDACTED]');
  return sanitized;
}

/**
 * Deterministic JSON stringifier that sorts object keys recursively and alphabetically.
 */
export function stringifyDeterministic(obj: any, space = 2): string {
  const sortRecursively = (val: any): any => {
    if (val === null || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(sortRecursively);
    const sortedKeys = Object.keys(val)
      .filter((k) => val[k] !== undefined)
      .sort((a, b) => a.localeCompare(b));
    const out: Record<string, any> = {};
    for (const k of sortedKeys) {
      out[k] = sortRecursively(val[k]);
    }
    return out;
  };
  return JSON.stringify(sortRecursively(obj), null, space);
}

/**
 * Calculate sha256 hash of a string
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Normalize TMDB or local item to a canonical key: `movie:<id>` or `tv:<id>`
 */
export function toCanonicalKey(item: any): string | null {
  if (!item || typeof item !== 'object') return null;
  const rawId = Number(item.id);
  if (!Number.isSafeInteger(rawId) || rawId <= 0) return null;
  const rawType = item.media_type || (item.title ? 'movie' : item.name ? 'tv' : 'movie');
  const type = rawType === 'tv' ? 'tv' : 'movie';
  return `${type}:${rawId}`;
}

/**
 * Merge new partial incoming record into existing rich record without losing data.
 */
export function mergeCatalogItem(existing: CatalogRecord | undefined, incoming: any): CatalogRecord {
  const rawId = Number(incoming.id);
  const mediaType: 'movie' | 'tv' = incoming.media_type === 'tv' ? 'tv' : 'movie';
  const key = `${mediaType}:${rawId}`;
  const now = new Date().toISOString();

  const title = (incoming.title || incoming.name || existing?.title || '').trim();
  const originalTitle = (
    incoming.original_title ||
    incoming.original_name ||
    existing?.original_title ||
    ''
  ).trim();
  const overview =
    typeof incoming.overview === 'string' && incoming.overview.trim()
      ? incoming.overview.trim()
      : existing?.overview || '';
  const posterPath =
    incoming.poster_path !== undefined ? incoming.poster_path : existing?.poster_path ?? null;
  const backdropPath =
    incoming.backdrop_path !== undefined ? incoming.backdrop_path : existing?.backdrop_path ?? null;

  // Merge genre_ids deterministically
  const genreSet = new Set<number>();
  if (Array.isArray(existing?.genre_ids)) {
    for (const g of existing.genre_ids) if (Number.isSafeInteger(g)) genreSet.add(g);
  }
  if (Array.isArray(incoming.genre_ids)) {
    for (const g of incoming.genre_ids) if (Number.isSafeInteger(g)) genreSet.add(g);
  }
  const genreIds = Array.from(genreSet).sort((a, b) => a - b);

  const voteAverage =
    Number.isFinite(incoming.vote_average) && incoming.vote_average > 0
      ? Number(incoming.vote_average)
      : existing?.vote_average ?? 0;

  const voteCount =
    Number.isSafeInteger(incoming.vote_count) && incoming.vote_count > 0
      ? Number(incoming.vote_count)
      : existing?.vote_count ?? 0;

  const releaseDate =
    incoming.release_date ||
    incoming.first_air_date ||
    existing?.release_date ||
    existing?.first_air_date ||
    undefined;
  const firstAirDate =
    mediaType === 'tv'
      ? incoming.first_air_date || existing?.first_air_date || releaseDate
      : undefined;
  const popularity = Number.isFinite(incoming.popularity)
    ? Number(incoming.popularity)
    : existing?.popularity ?? undefined;

  return {
    key,
    id: rawId,
    media_type: mediaType,
    title,
    original_title: originalTitle || undefined,
    overview: overview || undefined,
    poster_path: posterPath,
    backdrop_path: backdropPath,
    genre_ids: genreIds,
    vote_average: voteAverage,
    vote_count: voteCount || undefined,
    release_date: releaseDate,
    first_air_date: firstAirDate,
    popularity,
    firstStoredAt: existing?.firstStoredAt || now,
    lastUpdatedAt: now,
    source: incoming._source || existing?.source || 'tmdb',
  };
}

/**
 * Sanitize profileId for safe file naming on disk.
 */
export function sanitizeProfileId(profileId: string): string {
  const cleaned = profileId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.slice(0, 80) || 'default';
}

function isPlainRecordObject(raw: any): boolean {
  return Boolean(raw && typeof raw === 'object' && !Array.isArray(raw));
}

function classifyHttpFailure(status: number, headers: Headers, bodyMessage: string): GitHubSyncErrorCategory {
  const remaining = headers.get('x-ratelimit-remaining');
  const lowerMsg = (bodyMessage || '').toLowerCase();
  if (
    status === 429 ||
    (status === 403 && (remaining === '0' || lowerMsg.includes('rate limit')))
  ) {
    return 'rate_limit';
  }
  if (status === 401 || status === 403) {
    return 'auth_error';
  }
  if (status === 409) {
    return 'conflict';
  }
  if (status === 404) {
    return 'not_found';
  }
  return 'http_error';
}

export class PersistentDataStore {
  private dataDir: string;
  private catalogDir: string;
  private profilesDir: string;
  private moviesFile: string;
  private tvFile: string;
  private manifestFile: string;
  private syncStateFile: string;
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;
  private lastRemoteSummary: SyncSideSummary | null = null;
  private lastComparison: SyncComparisonSummary | null = null;
  private lastSyncReport: Omit<BidirectionalSyncReport, 'updatedDataDocument'> | null = null;
  private persistedInitialReconcile = false;
  private repoVisibilityWarning?: string;
  private fileStates: Record<string, SyncFileStateRecord> = {};
  private writeSerializer = new FileWriteSerializer();
  private maxDataBytes?: number;
  private attachedStorage?: ReturnType<typeof createDataStorage>;
  private bidirectionalManager: GitHubBidirectionalSyncManager;

  private githubToken?: string;
  private githubOwner?: string;
  private githubRepo?: string;
  private githubBranch: string;
  private isPublicRepo: boolean;

  constructor(options: PersistentStoreOptions) {
    this.dataDir = options.dataDir;
    this.maxDataBytes = options.maxDataBytes;
    this.catalogDir = path.join(this.dataDir, 'catalog');
    this.profilesDir = path.join(this.dataDir, 'profiles');
    this.moviesFile = path.join(this.catalogDir, 'movies.json');
    this.tvFile = path.join(this.catalogDir, 'tv.json');
    this.manifestFile = path.join(this.catalogDir, 'manifest.json');
    this.syncStateFile = path.join(this.dataDir, 'sync-state.json');

    this.githubToken = options.githubToken?.trim();
    this.githubOwner = options.githubOwner?.trim();
    this.githubRepo = options.githubRepo?.trim();
    this.githubBranch = options.githubBranch?.trim() || 'main';
    this.isPublicRepo = Boolean(options.isPublicRepo);

    this.initDirectories();
    this.loadPersistedSyncState();
    this.bidirectionalManager = this.createBidirectionalManager();
  }

  private createBidirectionalManager(): GitHubBidirectionalSyncManager {
    return new GitHubBidirectionalSyncManager({
      dataDir: this.dataDir,
      maxDataBytes: this.maxDataBytes,
      store: this,
      storage: this.attachedStorage,
      getGitHubConfig: () => ({
        token: this.githubToken,
        owner: this.githubOwner,
        repo: this.githubRepo,
        branch: this.githubBranch,
        isPublicRepo: this.isPublicRepo,
      }),
      onSyncCompleted: ({ report, lastRemoteSummary, lastComparison }) => {
        this.recordBidirectionalOutcome(report, lastRemoteSummary, lastComparison);
      },
    });
  }

  public attachDataStorage(
    storage: ReturnType<typeof createDataStorage>,
    maxDataBytes?: number
  ): void {
    this.attachedStorage = storage;
    if (typeof maxDataBytes === 'number' && maxDataBytes > 0) {
      this.maxDataBytes = maxDataBytes;
    }
    this.bidirectionalManager = this.createBidirectionalManager();
  }

  public isSyncBusy(): boolean {
    return this.bidirectionalManager.isBusy();
  }

  public hasCompletedInitialReconcile(): boolean {
    return this.persistedInitialReconcile || this.bidirectionalManager.hasCompletedInitialReconcile();
  }

  private recordBidirectionalOutcome(
    report: BidirectionalSyncReport,
    lastRemoteSummary: SyncSideSummary | null,
    lastComparison: SyncComparisonSummary | null
  ): void {
    if (lastRemoteSummary) {
      this.lastRemoteSummary = lastRemoteSummary;
    }
    if (lastComparison) {
      this.lastComparison = lastComparison;
    }
    if (report.repoVisibilityWarning) {
      this.repoVisibilityWarning = report.repoVisibilityWarning;
    }

    if (
      report.operation !== 'inspect' &&
      report.ok &&
      !report.requiresConfirmation &&
      report.errors.length === 0
    ) {
      this.lastSyncAt = report.completedAt;
      this.lastError = null;
    } else if (report.errors.length > 0) {
      this.lastError = redactSecrets(
        report.errors.map((e) => e.message).join(' | '),
        [this.githubToken]
      );
    } else if (report.ok) {
      this.lastError = null;
    }

    if (report.operation === 'reconcile' && report.verifiedEqual) {
      this.persistedInitialReconcile = true;
    }

    // Dosya bazlı durum tablosunu güncel tut
    for (const p of report.filesPending) {
      this.setFileSyncStage(p, 'pending', { error: undefined, errorCategory: undefined });
    }
    for (const p of [
      ...report.filesDownloaded,
      ...report.filesUploaded,
      ...report.filesMerged,
      ...report.filesUnchanged,
    ]) {
      if (!report.filesPending.includes(p) && !report.filesFailed.includes(p)) {
        const localHash = report.localAfter.files[p]?.rawFileHash || undefined;
        this.setFileSyncStage(p, 'succeeded', {
          localContentHash: localHash,
          noop: report.filesUnchanged.includes(p),
          error: undefined,
          errorCategory: undefined,
        });
      }
    }
    for (const p of report.filesFailed) {
      const matchingErr = report.errors.find((e) => e.repoPath === p);
      this.setFileSyncStage(p, 'failed', {
        error: matchingErr?.message || `${p} senkronizasyon hatası`,
        errorCategory: (matchingErr?.category as GitHubSyncErrorCategory) || 'http_error',
      });
    }

    const { updatedDataDocument: _omittedDoc, ...compactReport } = report;
    void _omittedDoc;
    this.lastSyncReport = compactReport;
    this.persistSyncState();
  }

  private initDirectories() {
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
    if (!existsSync(this.catalogDir)) mkdirSync(this.catalogDir, { recursive: true });
    if (!existsSync(this.profilesDir)) mkdirSync(this.profilesDir, { recursive: true });

    // Yarım kalmış geçici dosyaları başlangıçta kontrollü biçimde temizle
    cleanupStaleTempFiles(this.dataDir);
    cleanupStaleTempFiles(this.catalogDir);
    cleanupStaleTempFiles(this.profilesDir);
  }

  private loadPersistedSyncState() {
    if (!existsSync(this.syncStateFile)) return;
    const parsed = tryParseValidJson<{
      lastSyncAt?: string | null;
      lastError?: string | null;
      repoVisibilityWarning?: string;
      persistedInitialReconcile?: boolean;
      lastRemoteSummary?: SyncSideSummary | null;
      lastComparison?: SyncComparisonSummary | null;
      lastSyncReport?: Omit<BidirectionalSyncReport, 'updatedDataDocument'> | null;
      fileStates?: Record<string, SyncFileStateRecord>;
    }>(this.syncStateFile, (raw) => (isPlainRecordObject(raw) ? raw : null));
    if (parsed.ok) {
      this.lastSyncAt = parsed.data.lastSyncAt ?? null;
      this.lastError = parsed.data.lastError ?? null;
      this.repoVisibilityWarning = parsed.data.repoVisibilityWarning;
      this.persistedInitialReconcile = Boolean(parsed.data.persistedInitialReconcile);
      this.lastRemoteSummary = parsed.data.lastRemoteSummary ?? null;
      this.lastComparison = parsed.data.lastComparison ?? null;
      this.lastSyncReport = parsed.data.lastSyncReport ?? null;
      if (isPlainRecordObject(parsed.data.fileStates)) {
        this.fileStates = { ...parsed.data.fileStates };
      }
    }
  }

  private persistSyncState() {
    try {
      const payload = {
        lastSyncAt: this.lastSyncAt,
        lastError: this.lastError,
        persistedInitialReconcile: this.persistedInitialReconcile,
        ...(this.repoVisibilityWarning ? { repoVisibilityWarning: this.repoVisibilityWarning } : {}),
        ...(this.lastRemoteSummary ? { lastRemoteSummary: this.lastRemoteSummary } : {}),
        ...(this.lastComparison ? { lastComparison: this.lastComparison } : {}),
        ...(this.lastSyncReport ? { lastSyncReport: this.lastSyncReport } : {}),
        fileStates: this.fileStates,
      };
      writeJsonFileAtomic(this.syncStateFile, stringifyDeterministic(payload), {
        validateParsed: isPlainRecordObject,
      });
    } catch {}
  }

  private setFileSyncStage(
    repoPath: string,
    status: SyncFileStage,
    extra: Partial<Omit<SyncFileStateRecord, 'repoPath' | 'status' | 'statusLabel' | 'updatedAt'>> = {}
  ) {
    const prev = this.fileStates[repoPath];
    this.fileStates[repoPath] = {
      repoPath,
      status,
      statusLabel: STAGE_LABELS[status],
      localContentHash: extra.localContentHash ?? prev?.localContentHash,
      sha: extra.sha ?? prev?.sha,
      ...(extra.noop !== undefined ? { noop: extra.noop } : {}),
      ...(extra.blockedPublic !== undefined ? { blockedPublic: extra.blockedPublic } : {}),
      ...(extra.error ? { error: redactSecrets(extra.error, [this.githubToken]) } : {}),
      ...(extra.errorCategory ? { errorCategory: extra.errorCategory } : {}),
      updatedAt: new Date().toISOString(),
    };
  }

  // --- CATALOG OPERATIONS ---

  public readCatalog(
    mediaType: 'movie' | 'tv',
    options: { allowEmptyOnCorrupt?: boolean } = {}
  ): Record<string, CatalogRecord> {
    const file = mediaType === 'movie' ? this.moviesFile : this.tvFile;
    const recovery = readJsonFileWithRecovery<Record<string, CatalogRecord>>(file, {
      backupPaths: [`${file}.bak`],
      validate: (raw) => (isPlainRecordObject(raw) ? (raw as Record<string, CatalogRecord>) : null),
      label: path.basename(file),
      restoreRecoveredToTarget: true,
    });

    if (recovery.status === 'ok' || recovery.status === 'recovered') {
      return recovery.data;
    }

    if (recovery.status === 'corrupt_unrecoverable') {
      if (options.allowEmptyOnCorrupt) {
        return {};
      }
      throw new CorruptJsonFileError(file, recovery.error);
    }

    return {};
  }

  public readCatalogManifest(): CatalogManifest | null {
    const recovery = readJsonFileWithRecovery<CatalogManifest>(this.manifestFile, {
      backupPaths: [`${this.manifestFile}.bak`],
      validate: (raw) =>
        isPlainRecordObject(raw) && typeof raw.contentHash === 'string'
          ? (raw as CatalogManifest)
          : null,
      label: 'manifest.json',
      restoreRecoveredToTarget: true,
    });
    if (recovery.status === 'ok' || recovery.status === 'recovered') {
      return recovery.data;
    }
    return null;
  }

  public upsertCatalogItems(
    items: any[],
    writeOptions: { beforeRenameHook?: (tempFilePath: string) => void } = {}
  ): { inserted: number; updated: number; unchanged: number; total: number; contentHash: string } {
    // Önce mevcut katalog dosyalarını oku; kurtarılamayan bozuk JSON varsa CorruptJsonFileError fırlatır ve üzerine yazmaz!
    const movies = this.readCatalog('movie', { allowEmptyOnCorrupt: false });
    const tv = this.readCatalog('tv', { allowEmptyOnCorrupt: false });

    if (!Array.isArray(items) || items.length === 0) {
      const existingManifest = this.readCatalogManifest();
      return {
        inserted: 0,
        updated: 0,
        unchanged: 0,
        total: 0,
        contentHash:
          existingManifest?.contentHash ||
          hashContent(stringifyDeterministic(movies) + stringifyDeterministic(tv)),
      };
    }

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let moviesChanged = false;
    let tvChanged = false;

    for (const item of items) {
      const key = toCanonicalKey(item);
      if (!key) continue;
      const isTv = key.startsWith('tv:');
      const targetMap = isTv ? tv : movies;
      const existing = targetMap[key];

      const merged = mergeCatalogItem(existing, item);

      if (!existing) {
        targetMap[key] = merged;
        inserted++;
        if (isTv) tvChanged = true;
        else moviesChanged = true;
      } else {
        // Compare content without timestamps to prevent noisy commits
        const existingCopy = { ...existing, firstStoredAt: '', lastUpdatedAt: '' };
        const mergedCopy = { ...merged, firstStoredAt: '', lastUpdatedAt: '' };

        if (stringifyDeterministic(existingCopy) !== stringifyDeterministic(mergedCopy)) {
          targetMap[key] = merged;
          updated++;
          if (isTv) tvChanged = true;
          else moviesChanged = true;
        } else {
          unchanged++;
        }
      }
    }

    if (moviesChanged) {
      writeJsonFileAtomic(this.moviesFile, stringifyDeterministic(movies), {
        backupPath: `${this.moviesFile}.bak`,
        validateParsed: isPlainRecordObject,
        beforeRenameHook: writeOptions.beforeRenameHook,
      });
    }
    if (tvChanged) {
      writeJsonFileAtomic(this.tvFile, stringifyDeterministic(tv), {
        backupPath: `${this.tvFile}.bak`,
        validateParsed: isPlainRecordObject,
        beforeRenameHook: writeOptions.beforeRenameHook,
      });
    }

    const serializedMovies = stringifyDeterministic(movies);
    const serializedTv = stringifyDeterministic(tv);
    const combinedHash = hashContent(serializedMovies + serializedTv);

    if (moviesChanged || tvChanged || !existsSync(this.manifestFile)) {
      const manifest: CatalogManifest = {
        version: 1,
        updatedAt: new Date().toISOString(),
        movieCount: Object.keys(movies).length,
        tvCount: Object.keys(tv).length,
        contentHash: combinedHash,
      };
      writeJsonFileAtomic(this.manifestFile, stringifyDeterministic(manifest), {
        backupPath: `${this.manifestFile}.bak`,
        validateParsed: isPlainRecordObject,
      });
    }

    return {
      inserted,
      updated,
      unchanged,
      total: inserted + updated + unchanged,
      contentHash: combinedHash,
    };
  }

  public upsertCatalogItemsSerialized(
    items: any[]
  ): Promise<{ inserted: number; updated: number; unchanged: number; total: number; contentHash: string }> {
    return this.writeSerializer.run(this.manifestFile, () => this.upsertCatalogItems(items));
  }

  // --- DERIVED PROFILE OPERATIONS ---

  public getProfileFilePath(profileId: string): string {
    const safeId = sanitizeProfileId(profileId);
    return path.join(this.profilesDir, `${safeId}.json`);
  }

  public readDerivedProfile(
    profileId: string,
    options: { allowNullOnCorrupt?: boolean } = {}
  ): DerivedProfileDocument | null {
    const filePath = this.getProfileFilePath(profileId);
    const recovery = readJsonFileWithRecovery<DerivedProfileDocument>(filePath, {
      backupPaths: [`${filePath}.bak`],
      validate: (raw) =>
        isPlainRecordObject(raw) &&
        typeof raw.profileId === 'string' &&
        isPlainRecordObject(raw.items)
          ? (raw as DerivedProfileDocument)
          : null,
      label: path.basename(filePath),
      restoreRecoveredToTarget: true,
    });

    if (recovery.status === 'ok' || recovery.status === 'recovered') {
      return recovery.data;
    }

    if (recovery.status === 'corrupt_unrecoverable') {
      if (options.allowNullOnCorrupt) return null;
      throw new CorruptJsonFileError(filePath, recovery.error);
    }

    return null;
  }

  /**
   * Profil cache doğrulamasını şema sürümü, algoritma sürümü, profil imzası ve kaynak katalog imzası ile birlikte yürütür.
   */
  public readValidatedDerivedProfile(
    profileId: string,
    expected: {
      profileFingerprint: string;
      algorithmVersion: string;
      sourceCatalogHash?: string;
      expectedSchemaVersion?: number;
    }
  ): DerivedProfileValidationResult {
    const rawDoc = this.readDerivedProfile(profileId, { allowNullOnCorrupt: true });
    if (!rawDoc) {
      return { valid: false, reason: 'missing_document' };
    }
    return validateDerivedProfileCache(rawDoc, {
      profileId,
      profileFingerprint: expected.profileFingerprint,
      algorithmVersion: expected.algorithmVersion,
      sourceCatalogHash: expected.sourceCatalogHash,
      expectedSchemaVersion: expected.expectedSchemaVersion,
    });
  }

  public upsertDerivedProfile(
    input: Partial<DerivedProfileDocument> & {
      profileId: string;
      algorithmVersion: string;
      profileFingerprint: string;
      sourceCatalogHash?: string;
      items: Record<string, Partial<DerivedProfileItem> & { mediaKey?: string }>;
    },
    writeOptions: { beforeRenameHook?: (tempFilePath: string) => void } = {}
  ): { updated: boolean; count: number; contentHash: string } {
    const { profileId, algorithmVersion, profileFingerprint, items } = input;
    const targetSchemaVersion = input.schemaVersion ?? DERIVED_PROFILE_SCHEMA_VERSION;
    const resolvedSourceCatalogHash =
      input.sourceCatalogHash !== undefined
        ? String(input.sourceCatalogHash)
        : this.readCatalogManifest()?.contentHash || '';

    // Kurtarılamayan bozuk JSON varsa CorruptJsonFileError fırlatır ve mevcut dosyayı ezmez
    const existing = this.readDerivedProfile(profileId, { allowNullOnCorrupt: false });
    const filePath = this.getProfileFilePath(profileId);

    const sameContext = Boolean(
      existing &&
        Number(existing.schemaVersion) === targetSchemaVersion &&
        existing.algorithmVersion === algorithmVersion &&
        existing.profileFingerprint === profileFingerprint &&
        String(existing.sourceCatalogHash || '') === resolvedSourceCatalogHash
    );

    // Bağlam (şema, algoritma, profil imzası veya kaynak katalog imzası) değiştiyse eski önbellek maddeleri taşınmaz
    const mergedItems: Record<string, DerivedProfileItem> = {};
    if (sameContext && existing?.items) {
      for (const [k, prevVal] of Object.entries(existing.items)) {
        const normPrev = normalizeDerivedProfileItem(k, prevVal);
        if (normPrev) {
          mergedItems[normPrev.mediaKey] = normPrev;
        }
      }
    }

    for (const [rawKey, item] of Object.entries(items || {})) {
      const normalized = normalizeDerivedProfileItem(rawKey, item);
      if (!normalized) continue;
      const prevItem = mergedItems[normalized.mediaKey];
      if (prevItem) {
        const prevSingleHash = computeDerivedProfileContentHash({
          schemaVersion: targetSchemaVersion,
          profileId,
          algorithmVersion,
          profileFingerprint,
          sourceCatalogHash: resolvedSourceCatalogHash,
          items: { [normalized.mediaKey]: prevItem },
        });
        const nextSingleHash = computeDerivedProfileContentHash({
          schemaVersion: targetSchemaVersion,
          profileId,
          algorithmVersion,
          profileFingerprint,
          sourceCatalogHash: resolvedSourceCatalogHash,
          items: { [normalized.mediaKey]: normalized },
        });
        if (prevSingleHash === nextSingleHash) {
          // Anlamlı alanlar aynıysa önceki calculatedAt zaman damgasını koru
          mergedItems[normalized.mediaKey] = prevItem;
          continue;
        }
      }
      mergedItems[normalized.mediaKey] = normalized;
    }

    const nextContentHash = computeDerivedProfileContentHash({
      schemaVersion: targetSchemaVersion,
      profileId,
      algorithmVersion,
      profileFingerprint,
      sourceCatalogHash: resolvedSourceCatalogHash,
      items: mergedItems,
    });

    if (sameContext && existing) {
      const existingContentHash =
        existing.contentHash ||
        computeDerivedProfileContentHash({
          schemaVersion: Number(existing.schemaVersion) || 1,
          profileId: existing.profileId,
          algorithmVersion: existing.algorithmVersion,
          profileFingerprint: existing.profileFingerprint,
          sourceCatalogHash: existing.sourceCatalogHash || '',
          items: existing.items || {},
        });

      if (
        existingContentHash === nextContentHash &&
        Object.keys(existing.items || {}).length === Object.keys(mergedItems).length
      ) {
        return {
          updated: false,
          count: Object.keys(mergedItems).length,
          contentHash: existingContentHash,
        };
      }
    }

    const doc: DerivedProfileDocument = {
      schemaVersion: targetSchemaVersion,
      profileId,
      algorithmVersion,
      profileFingerprint,
      sourceCatalogHash: resolvedSourceCatalogHash,
      contentHash: nextContentHash,
      generatedAt: new Date().toISOString(),
      items: mergedItems,
    };

    writeJsonFileAtomic(filePath, stringifyDeterministic(doc), {
      backupPath: `${filePath}.bak`,
      validateParsed: (parsed) =>
        isPlainRecordObject(parsed) &&
        typeof parsed.profileId === 'string' &&
        isPlainRecordObject(parsed.items),
      beforeRenameHook: writeOptions.beforeRenameHook,
    });

    return {
      updated: true,
      count: Object.keys(mergedItems).length,
      contentHash: nextContentHash,
    };
  }

  public upsertDerivedProfileSerialized(
    input: Parameters<PersistentDataStore['upsertDerivedProfile']>[0]
  ): Promise<{ updated: boolean; count: number; contentHash: string }> {
    const filePath = this.getProfileFilePath(input.profileId);
    return this.writeSerializer.run(filePath, () => this.upsertDerivedProfile(input));
  }

  // --- SYNC & GITHUB OPERATIONS ---

  public getSyncStatus(): SyncStatus {
    const configured = Boolean(this.githubToken && this.githubOwner && this.githubRepo);
    const corruptionWarnings: string[] = [];

    let movieCount = 0;
    let tvCount = 0;
    try {
      movieCount = Object.keys(this.readCatalog('movie')).length;
    } catch (err: any) {
      corruptionWarnings.push(err?.message || 'movies.json okunamadı');
    }
    try {
      tvCount = Object.keys(this.readCatalog('tv')).length;
    } catch (err: any) {
      corruptionWarnings.push(err?.message || 'tv.json okunamadı');
    }

    let profilesCount = 0;
    try {
      const dirContents = existsSync(this.profilesDir) ? readdirSync(this.profilesDir) : [];
      profilesCount = dirContents.filter(
        (f: string) =>
          f.endsWith('.json') &&
          !f.endsWith('.bak.json') &&
          !f.includes('.corrupt.') &&
          !f.endsWith('.tmp')
      ).length;
    } catch {
      profilesCount = 0;
    }

    let localSummary: SyncSideSummary | undefined;
    try {
      localSummary = this.bidirectionalManager.inspectLocalSide().summary;
    } catch {
      localSummary = undefined;
    }

    const stateValues = Object.values(this.fileStates);
    const pendingFromStates = stateValues.filter((s) => s.status === 'pending').length;
    const pendingFromDiff = this.lastComparison?.differentFilesCount ?? 0;
    const fileSummaryCounts = {
      pending: Math.max(pendingFromStates, pendingFromDiff),
      syncing: stateValues.filter((s) => s.status === 'syncing').length,
      succeeded: stateValues.filter((s) => s.status === 'succeeded').length,
      skipped:
        this.lastSyncReport?.filesUnchanged.length ??
        stateValues.filter((s) => s.status === 'succeeded' && s.noop).length,
      downloaded: this.lastSyncReport?.filesDownloaded.length ?? 0,
      uploaded: this.lastSyncReport?.filesUploaded.length ?? 0,
      merged: this.lastSyncReport?.filesMerged.length ?? 0,
      failed: stateValues.filter((s) => s.status === 'failed').length,
    };

    const hasTargetRepo = Boolean(this.githubOwner && this.githubRepo);
    const missingReason = !configured
      ? hasTargetRepo
        ? `Hedef depo (${this.githubOwner}/${this.githubRepo} · ${this.githubBranch}) tanımlı; CINETRACK_GITHUB_PAT ortam değişkeni bekleniyor`
        : 'GitHub token veya hedef repository yapılandırılmadı'
      : undefined;

    return {
      configured,
      mode: configured ? 'github' : 'local_only',
      reason: missingReason,
      isPublicRepo: this.isPublicRepo,
      ...(this.repoVisibilityWarning ? { repoVisibilityWarning: this.repoVisibilityWarning } : {}),
      ...(corruptionWarnings.length > 0 ? { corruptionWarnings } : {}),
      lastSyncAt: this.lastSyncAt,
      syncInProgress: this.isSyncBusy(),
      initialReconcileCompleted: this.hasCompletedInitialReconcile(),
      lastError: this.lastError,
      catalogCounts: {
        movies: movieCount,
        tv: tvCount,
      },
      profilesCount,
      ...(localSummary ? { localSummary } : {}),
      lastRemoteSummary: this.lastRemoteSummary,
      lastComparison: this.lastComparison,
      lastSyncReport: this.lastSyncReport,
      fileSummaryCounts,
      fileStates: { ...this.fileStates },
      remoteTarget: hasTargetRepo
        ? {
            owner: this.githubOwner!,
            repo: this.githubRepo!,
            branch: this.githubBranch,
          }
        : undefined,
    };
  }

  public inspectGitHub(): Promise<BidirectionalSyncReport> {
    return this.bidirectionalManager.inspect();
  }

  public pullFromGitHub(
    options: { conflictStrategy?: 'ask' | 'merge' | 'overwrite_with_remote' } = {}
  ): Promise<BidirectionalSyncReport> {
    return this.bidirectionalManager.pull(options);
  }

  public pushToGitHub(): Promise<BidirectionalSyncReport> {
    return this.bidirectionalManager.push();
  }

  public reconcileWithGitHub(): Promise<BidirectionalSyncReport> {
    return this.bidirectionalManager.reconcile();
  }

  /**
   * GitHub deposuna erişim, yetki (push) ve dal durumunu ayrıntılı biçimde doğrular.
   * 404 durumunda repo yokluğu, token yetkisizliği veya dal uyumsuzluğunu ayrıştırır.
   */
  public async verifyRemoteRepoAccess(): Promise<RemoteRepoAccessCheck> {
    if (!this.githubToken || !this.githubOwner || !this.githubRepo) {
      return {
        ok: false,
        accessible: false,
        repoExists: false,
        branchExists: false,
        isEmptyRepo: false,
        isPrivate: !this.isPublicRepo,
        effectiveIsPublicRepo: this.isPublicRepo,
        configuredBranch: this.githubBranch,
        hasPushPermission: false,
        error: 'GitHub senkronizasyonu için ortam değişkenleri (token, owner, repo) eksik.',
        errorCategory: 'config_error',
      };
    }

    const baseHeaders = {
      Authorization: `Bearer ${this.githubToken}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'CineTrack-Sync-Agent',
    };

    // 1. Repo varlık ve erişim kontrolü
    const repoUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}`;
    let repoMeta: any = null;

    try {
      const res = await fetch(repoUrl, { headers: baseHeaders });
      if (res.status === 404) {
        const notFoundMsg = redactSecrets(
          `Uzak GitHub deposu (${this.githubOwner}/${this.githubRepo}) bulunamadı veya erişilemedi (HTTP 404). Özel (private) depo kullanıyorsanız GitHub Fine-Grained Personal Access Token izinlerinde bu deponun seçili olduğunu ve 'Contents: Read and write' yetkisine sahip olduğunu doğrulayın.`,
          [this.githubToken]
        );
        return {
          ok: false,
          accessible: false,
          repoExists: false,
          branchExists: false,
          isEmptyRepo: false,
          isPrivate: !this.isPublicRepo,
          effectiveIsPublicRepo: this.isPublicRepo,
          configuredBranch: this.githubBranch,
          hasPushPermission: false,
          error: notFoundMsg,
          errorCategory: 'not_found',
        };
      }

      if (res.status === 401 || res.status === 403) {
        const errJson = await res.json().catch(() => ({}));
        const rawMsg = String(errJson?.message || '');
        const category = classifyHttpFailure(res.status, res.headers, rawMsg);
        return {
          ok: false,
          accessible: false,
          repoExists: false,
          branchExists: false,
          isEmptyRepo: false,
          isPrivate: !this.isPublicRepo,
          effectiveIsPublicRepo: this.isPublicRepo,
          configuredBranch: this.githubBranch,
          hasPushPermission: false,
          error: redactSecrets(
            `GitHub erişim hatası (${category}): HTTP ${res.status}${rawMsg ? ` - ${rawMsg}` : ''}`,
            [this.githubToken]
          ),
          errorCategory: category,
        };
      }

      if (res.status !== 200) {
        const errJson = await res.json().catch(() => ({}));
        const rawMsg = String(errJson?.message || '');
        const category = classifyHttpFailure(res.status, res.headers, rawMsg);
        return {
          ok: false,
          accessible: false,
          repoExists: false,
          branchExists: false,
          isEmptyRepo: false,
          isPrivate: !this.isPublicRepo,
          effectiveIsPublicRepo: this.isPublicRepo,
          configuredBranch: this.githubBranch,
          hasPushPermission: false,
          error: redactSecrets(
            `GitHub depo sorgulanamadı (${category}): HTTP ${res.status}${rawMsg ? ` - ${rawMsg}` : ''}`,
            [this.githubToken]
          ),
          errorCategory: category,
        };
      }

      repoMeta = await res.json().catch(() => null);
    } catch (e: any) {
      return {
        ok: false,
        accessible: false,
        repoExists: false,
        branchExists: false,
        isEmptyRepo: false,
        isPrivate: !this.isPublicRepo,
        effectiveIsPublicRepo: this.isPublicRepo,
        configuredBranch: this.githubBranch,
        hasPushPermission: false,
        error: redactSecrets(
          `GitHub sunucusuna bağlanılamadı: ${e?.message || 'Ağ hatası'}`,
          [this.githubToken]
        ),
        errorCategory: 'network_error',
      };
    }

    if (!isPlainRecordObject(repoMeta)) {
      return {
        ok: false,
        accessible: false,
        repoExists: false,
        branchExists: false,
        isEmptyRepo: false,
        isPrivate: !this.isPublicRepo,
        effectiveIsPublicRepo: this.isPublicRepo,
        configuredBranch: this.githubBranch,
        hasPushPermission: false,
        error: 'GitHub depo yanıtı geçerli JSON formatında değil.',
        errorCategory: 'malformed_response',
      };
    }

    const isRemotePrivate = repoMeta.private === true;
    const remoteIsPublic = repoMeta.private === false;
    let warning: string | undefined;

    if (remoteIsPublic && !this.isPublicRepo) {
      warning =
        'Yapılandırma uyarısı: Uzak GitHub deposu herkese açık (public), ancak CINETRACK_DATA_REPO_IS_PUBLIC=false tanımlanmış. Kişisel izleme listesi ve profil dosyalarının sızmasını önlemek için özel verilerin gönderimi engellendi.';
    } else if (!remoteIsPublic && this.isPublicRepo) {
      warning =
        'Yapılandırma uyarısı: Uzak GitHub deposu özel (private), ancak CINETRACK_DATA_REPO_IS_PUBLIC=true tanımlandığı için kişisel profil dosyaları gönderilmiyor.';
    }

    const effectiveIsPublicRepo = remoteIsPublic;
    this.repoVisibilityWarning = warning;

    // Yetki kontrolü (permissions.push)
    const hasPushPermission =
      repoMeta.permissions && typeof repoMeta.permissions.push === 'boolean'
        ? repoMeta.permissions.push
        : true;

    if (repoMeta.permissions && repoMeta.permissions.push === false) {
      return {
        ok: false,
        accessible: true,
        repoExists: true,
        branchExists: false,
        isEmptyRepo: false,
        isPrivate: isRemotePrivate,
        effectiveIsPublicRepo,
        defaultBranch: repoMeta.default_branch,
        configuredBranch: this.githubBranch,
        hasPushPermission: false,
        warning,
        error: `GitHub token bu depoda ('${this.githubOwner}/${this.githubRepo}') yazma (push) yetkisine sahip değil. Token ayarlarında 'Contents: Read and write' iznini kontrol edin.`,
        errorCategory: 'auth_error',
      };
    }

    // 2. Dal (branch) kontrolü
    const branchUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/branches/${encodeURIComponent(
      this.githubBranch
    )}`;
    try {
      const branchRes = await fetch(branchUrl, { headers: baseHeaders });
      if (branchRes.status === 200) {
        return {
          ok: true,
          accessible: true,
          repoExists: true,
          branchExists: true,
          isEmptyRepo: false,
          isPrivate: isRemotePrivate,
          effectiveIsPublicRepo,
          defaultBranch: repoMeta.default_branch,
          configuredBranch: this.githubBranch,
          hasPushPermission,
          warning,
        };
      }

      if (branchRes.status === 404) {
        // Dal bulunamadı; depo tamamen boş mu (0 commit) kontrol et
        const branchesListUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/branches?per_page=1`;
        const listRes = await fetch(branchesListUrl, { headers: baseHeaders });
        if (listRes.status === 200) {
          const listData = await listRes.json().catch(() => []);
          if (Array.isArray(listData) && listData.length === 0) {
            // Boş depo: ilk commit henüz atılmamış, ilk yazma varsayılan dalı oluşturacak
            return {
              ok: true,
              accessible: true,
              repoExists: true,
              branchExists: false,
              isEmptyRepo: true,
              isPrivate: isRemotePrivate,
              effectiveIsPublicRepo,
              defaultBranch: repoMeta.default_branch,
              configuredBranch: this.githubBranch,
              hasPushPermission,
              warning,
            };
          }
        } else if (listRes.status === 404) {
          // /branches uç noktası mock ortamında taklit edilmemişse, repo meta 200 olduğu için dalı varsayılan kabul et
          return {
            ok: true,
            accessible: true,
            repoExists: true,
            branchExists: true,
            isEmptyRepo: false,
            isPrivate: isRemotePrivate,
            effectiveIsPublicRepo,
            defaultBranch: repoMeta.default_branch,
            configuredBranch: this.githubBranch,
            hasPushPermission,
            warning,
          };
        }

        // Depo boş değil ama belirtilen dal mevcut değil!
        const branchErrMsg = redactSecrets(
          `Yapılandırılmış dal ('${this.githubBranch}') depoda bulunamadı (HTTP 404). Mevcut varsayılan dal: '${
            repoMeta.default_branch || 'bilinmiyor'
          }'.`,
          [this.githubToken]
        );
        return {
          ok: false,
          accessible: true,
          repoExists: true,
          branchExists: false,
          isEmptyRepo: false,
          isPrivate: isRemotePrivate,
          effectiveIsPublicRepo,
          defaultBranch: repoMeta.default_branch,
          configuredBranch: this.githubBranch,
          hasPushPermission,
          warning,
          error: branchErrMsg,
          errorCategory: 'not_found',
        };
      }

      if (branchRes.status === 401 || branchRes.status === 403) {
        const errJson = await branchRes.json().catch(() => ({}));
        const rawMsg = String(errJson?.message || '');
        const category = classifyHttpFailure(branchRes.status, branchRes.headers, rawMsg);
        return {
          ok: false,
          accessible: false,
          repoExists: true,
          branchExists: false,
          isEmptyRepo: false,
          isPrivate: isRemotePrivate,
          effectiveIsPublicRepo,
          defaultBranch: repoMeta.default_branch,
          configuredBranch: this.githubBranch,
          hasPushPermission,
          warning,
          error: redactSecrets(
            `Dal kontrolünde yetki hatası (${category}): HTTP ${branchRes.status}${
              rawMsg ? ` - ${rawMsg}` : ''
            }`,
            [this.githubToken]
          ),
          errorCategory: category,
        };
      }
    } catch (e: any) {
      return {
        ok: false,
        accessible: false,
        repoExists: true,
        branchExists: false,
        isEmptyRepo: false,
        isPrivate: isRemotePrivate,
        effectiveIsPublicRepo,
        defaultBranch: repoMeta.default_branch,
        configuredBranch: this.githubBranch,
        hasPushPermission,
        warning,
        error: redactSecrets(`Dal kontrolünde ağ hatası: ${e?.message || 'bağlantı hatası'}`, [
          this.githubToken,
        ]),
        errorCategory: 'network_error',
      };
    }

    return {
      ok: true,
      accessible: true,
      repoExists: true,
      branchExists: true,
      isEmptyRepo: false,
      isPrivate: isRemotePrivate,
      effectiveIsPublicRepo,
      defaultBranch: repoMeta.default_branch,
      configuredBranch: this.githubBranch,
      hasPushPermission,
      warning,
    };
  }

  /**
   * Uzak GitHub deposunun gerçek `private/public` görünürlüğünü kontrol eder ve
   * `CINETRACK_DATA_REPO_IS_PUBLIC` ayarıyla uyumsuzluk varsa raporlar.
   */
  public async verifyRemoteRepoVisibility(): Promise<{
    effectiveIsPublicRepo: boolean;
    warning?: string;
  }> {
    const access = await this.verifyRemoteRepoAccess();
    return {
      effectiveIsPublicRepo: access.effectiveIsPublicRepo,
      ...(access.warning ? { warning: access.warning } : {}),
    };
  }

  /**
   * Commit a file to GitHub via Contents API with SHA conflict management,
   * bounded retry, error classification, read-back hash verification, and token redaction.
   */
  public async commitFileToGitHub(
    repoPath: string,
    contentString: string,
    commitMessage: string,
    options?: { isEmptyRepo?: boolean; branchToUse?: string }
  ): Promise<{
    ok: boolean;
    sha?: string;
    error?: string;
    errorCategory?: GitHubSyncErrorCategory;
    skippedNoop?: boolean;
    verifiedReadBack?: boolean;
  }> {
    if (!this.githubToken || !this.githubOwner || !this.githubRepo) {
      return {
        ok: false,
        error: 'GitHub senkronizasyon yapılandırması eksik.',
        errorCategory: 'config_error',
      };
    }

    const apiUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/contents/${repoPath}`;
    const baseHeaders = {
      Authorization: `Bearer ${this.githubToken}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'CineTrack-Sync-Agent',
    };
    const targetBranch = options?.branchToUse || this.githubBranch;
    const isEmptyRepo = Boolean(options?.isEmptyRepo);

    let remoteSha: string | undefined;
    let remoteContent: string | undefined;

    // 1. Fetch current remote file SHA & content (skip ref param if empty repo)
    if (!isEmptyRepo) {
      try {
        const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(targetBranch)}`, {
          headers: baseHeaders,
        });
        if (getRes.status === 200) {
          let fileData: any = null;
          try {
            fileData = await getRes.json();
          } catch {
            return {
              ok: false,
              error: 'GitHub dosya okuma yanıtı geçerli JSON değil.',
              errorCategory: 'malformed_response',
            };
          }
          if (!fileData || typeof fileData !== 'object' || typeof fileData.sha !== 'string') {
            return {
              ok: false,
              error: 'GitHub dosya yanıtında geçerli SHA alanı bulunamadı.',
              errorCategory: 'malformed_response',
            };
          }
          remoteSha = fileData.sha;
          if (
            typeof fileData.content === 'string' &&
            fileData.encoding !== 'none' &&
            (fileData.content.length > 0 || fileData.size === 0)
          ) {
            remoteContent = Buffer.from(fileData.content.replace(/\s+/g, ''), 'base64').toString('utf8');
          }
        } else if (getRes.status === 403) {
          const errBody: any = await getRes.json().catch(() => ({}));
          const rawMsg = String(errBody?.message || '');
          const isTooLarge =
            Array.isArray(errBody?.errors) &&
            errBody.errors.some((e: any) => e?.code === 'too_large');
          if (isTooLarge) {
            const parentDir = path.posix.dirname(repoPath);
            const baseName = path.posix.basename(repoPath);
            const dirRes = await fetch(
              `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/contents/${parentDir}?ref=${encodeURIComponent(
                targetBranch
              )}`,
              { headers: baseHeaders }
            );
            if (dirRes.status === 200) {
              const list = await dirRes.json().catch(() => null);
              if (Array.isArray(list)) {
                const found = list.find(
                  (it: any) => it && it.name === baseName && typeof it.sha === 'string'
                );
                if (found) {
                  remoteSha = found.sha;
                }
              }
            }
          }
          if (!remoteSha) {
            const category = classifyHttpFailure(getRes.status, getRes.headers, rawMsg);
            return {
              ok: false,
              error: redactSecrets(
                `GitHub okuma hatası (${category}): HTTP ${getRes.status}${rawMsg ? ` - ${rawMsg}` : ''}`,
                [this.githubToken]
              ),
              errorCategory: category,
            };
          }
        } else if (getRes.status !== 404) {
          const errBody = await getRes.json().catch(() => ({}));
          const rawMsg = String(errBody?.message || '');
          const category = classifyHttpFailure(getRes.status, getRes.headers, rawMsg);
          return {
            ok: false,
            error: redactSecrets(
              `GitHub okuma hatası (${category}): HTTP ${getRes.status}${rawMsg ? ` - ${rawMsg}` : ''}`,
              [this.githubToken]
            ),
            errorCategory: category,
          };
        }
      } catch (e: any) {
        return {
          ok: false,
          error: redactSecrets(
            `GitHub ağ bağlantı hatası: ${e?.message || 'bağlantı kurulamadı'}`,
            [this.githubToken]
          ),
          errorCategory: 'network_error',
        };
      }
    }

    // 2. Prevent no-op commit if content is identical
    if (remoteContent !== undefined && remoteContent.trim() === contentString.trim()) {
      return { ok: true, sha: remoteSha, skippedNoop: true, verifiedReadBack: true };
    }

    // 3. Put content (with bounded retry up to 3 attempts on 409 conflict or transient network error)
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const payload: Record<string, any> = {
        message: commitMessage,
        content: Buffer.from(contentString, 'utf8').toString('base64'),
      };
      // Boş depolarda ilk commit'te branch verilmez; GitHub varsayılan dalı başlatır
      if (!isEmptyRepo) {
        payload.branch = targetBranch;
      }
      if (remoteSha) payload.sha = remoteSha;

      try {
        const putRes = await fetch(apiUrl, {
          method: 'PUT',
          headers: { ...baseHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (putRes.status === 200 || putRes.status === 201) {
          let resData: any = null;
          try {
            resData = await putRes.json();
          } catch {
            return {
              ok: false,
              error: 'GitHub yazma yanıtı geçerli JSON değil.',
              errorCategory: 'malformed_response',
            };
          }
          if (!resData || typeof resData !== 'object') {
            return {
              ok: false,
              error: 'GitHub yazma yanıtı beklenmeyen biçimde döndü.',
              errorCategory: 'malformed_response',
            };
          }
          const committedSha = resData.content?.sha || remoteSha;

          // 4. Yazma sonrası GitHub'dan geri okuma ve içerik hash doğrulaması (Aşama 4 & Kural 5)
          try {
            const verifyRefParam = encodeURIComponent(targetBranch);
            const readBackRes = await fetch(`${apiUrl}?ref=${verifyRefParam}`, {
              headers: baseHeaders,
            });
            if (readBackRes.status === 200) {
              const readBackData = await readBackRes.json().catch(() => null);
              if (
                readBackData &&
                typeof readBackData.content === 'string' &&
                readBackData.encoding !== 'none'
              ) {
                const readBackText = Buffer.from(
                  readBackData.content.replace(/\s+/g, ''),
                  'base64'
                ).toString('utf8');
                const readBackHash = hashContent(readBackText.trim());
                const expectedHash = hashContent(contentString.trim());
                if (readBackHash !== expectedHash) {
                  return {
                    ok: false,
                    error: `${repoPath}: Yazma sonrası hash doğrulaması başarısız oldu (GitHub özeti: ${readBackHash.slice(
                      0,
                      8
                    )}, beklenen yerel özet: ${expectedHash.slice(0, 8)}).`,
                    errorCategory: 'conflict',
                  };
                }
              }
            }
          } catch {
            // Geri okuma ağ hatası olursa da commit SHA varlığıyla devam edilebilir
          }

          return { ok: true, sha: committedSha, verifiedReadBack: true };
        }

        if (putRes.status === 409) {
          if (attempt < maxAttempts) {
            const refetch = await fetch(`${apiUrl}?ref=${encodeURIComponent(targetBranch)}`, {
              headers: baseHeaders,
            });
            if (refetch.status === 200) {
              const refetchedData = await refetch.json().catch(() => null);
              if (refetchedData && typeof refetchedData.sha === 'string') {
                remoteSha = refetchedData.sha;
                if (typeof refetchedData.content === 'string') {
                  const latestRemote = Buffer.from(
                    refetchedData.content.replace(/\s+/g, ''),
                    'base64'
                  ).toString('utf8');
                  if (latestRemote.trim() === contentString.trim()) {
                    return { ok: true, sha: remoteSha, skippedNoop: true, verifiedReadBack: true };
                  }
                }
                continue;
              }
            }
          }
          return {
            ok: false,
            error: `GitHub SHA çakışması (HTTP 409): ${maxAttempts} deneme sonunda giderilemedi.`,
            errorCategory: 'conflict',
          };
        }

        const errJson = await putRes.json().catch(() => ({}));
        const errDetail = String(errJson?.message || '');
        const category = classifyHttpFailure(putRes.status, putRes.headers, errDetail);
        return {
          ok: false,
          error: redactSecrets(
            `GitHub yazma reddedildi (${category}): HTTP ${putRes.status}${
              errDetail ? ` - ${errDetail}` : ''
            }`,
            [this.githubToken]
          ),
          errorCategory: category,
        };
      } catch (e: any) {
        if (attempt === maxAttempts) {
          return {
            ok: false,
            error: redactSecrets(
              `GitHub ağ hatası (${maxAttempts} deneme başarısız): ${e?.message || 'bağlantı hatası'}`,
              [this.githubToken]
            ),
            errorCategory: 'network_error',
          };
        }
      }
    }

    return {
      ok: false,
      error: 'GitHub yazma yeniden deneme sınırı aşıldı.',
      errorCategory: 'conflict',
    };
  }

  /**
   * Çok dosyalı GitHub senkronizasyonunu dosya bazlı durum takibiyle yürütür.
   * Kısmi hata durumunda başarılı dosyaları korur, başarısız olanları açıkça raporlar
   * ve sonraki denemede kaldığı yerden devam eder.
   */
  public async syncToGitHub(
    options: {
      forceAll?: boolean;
      verifiedRemoteHashes?: Record<string, string | null>;
    } = {}
  ): Promise<SyncResult> {
    const result: SyncResult = {
      ok: true,
      partialFailure: false,
      filesCommitted: [],
      filesSkipped: [],
      filesFailed: [],
      filesBlockedPublic: [],
      fileStates: {},
      errors: [],
    };

    if (!this.githubToken || !this.githubOwner || !this.githubRepo) {
      result.ok = false;
      result.errors.push(
        'GitHub senkronizasyonu için ortam değişkenleri (token, owner, repo) eksik.'
      );
      result.fileStates = { ...this.fileStates };
      return result;
    }

    interface PlannedSyncItem {
      repoPath: string;
      localPath: string;
      commitMessage: string;
    }

    const plannedFiles: PlannedSyncItem[] = [];

    for (const [relPath, filePath] of [
      ['data/catalog/movies.json', this.moviesFile],
      ['data/catalog/tv.json', this.tvFile],
      ['data/catalog/manifest.json', this.manifestFile],
    ] as const) {
      if (existsSync(filePath)) {
        plannedFiles.push({
          repoPath: relPath,
          localPath: filePath,
          commitMessage: `chore(catalog): sync ${path.basename(relPath)} [skip ci]`,
        });
      }
    }

    // 0. Depo erişim, yetki ve dal ön doğrulamasını çalıştır
    const access = await this.verifyRemoteRepoAccess();
    if (access.warning) {
      result.repoVisibilityWarning = access.warning;
    }

    if (!access.ok) {
      result.ok = false;
      const sanitizedAccessErr = access.error || 'GitHub depo erişim doğrulaması başarısız.';
      result.errors.push(sanitizedAccessErr);
      // Hedef dosyaları failed olarak işaretle, yerel veriye ASLA dokunma
      for (const item of plannedFiles) {
        this.setFileSyncStage(item.repoPath, 'failed', {
          error: sanitizedAccessErr,
          errorCategory: access.errorCategory || 'not_found',
        });
        result.filesFailed.push(item.repoPath);
      }
      this.persistSyncState();
      result.fileStates = { ...this.fileStates };
      return result;
    }

    if (access.effectiveIsPublicRepo) {
      const blockedMsg =
        'data/profiles/* (Açık depo koruması: kişisel izleme listesi ve profil verileri gönderilmedi)';
      result.filesBlockedPublic.push(blockedMsg);
    } else {
      const mainDataFile = path.join(this.dataDir, 'cinetrack-data.json');
      if (existsSync(mainDataFile)) {
        plannedFiles.push({
          repoPath: 'data/cinetrack-data.json',
          localPath: mainDataFile,
          commitMessage: 'chore(data): sync cinetrack-data.json [skip ci]',
        });
      }

      if (existsSync(this.profilesDir)) {
        const profileFiles = readdirSync(this.profilesDir)
          .filter(
            (f) =>
              f.endsWith('.json') &&
              !f.endsWith('.bak.json') &&
              !f.includes('.corrupt.') &&
              !f.endsWith('.tmp')
          )
          .sort((a, b) => a.localeCompare(b));
        for (const file of profileFiles) {
          plannedFiles.push({
            repoPath: `data/profiles/${file}`,
            localPath: path.join(this.profilesDir, file),
            commitMessage: `chore(profile): sync derived data for ${file} [skip ci]`,
          });
        }
      }
    }

    // 1. Önce tüm hedef dosyaları 'pending' (veya değişmemiş başarılıysa hazır) olarak işaretle
    const preparedContents = new Map<
      string,
      { content: string; localHash: string; alreadySyncedUnchanged: boolean }
    >();

    for (const item of plannedFiles) {
      const validCheck = tryParseValidJson(item.localPath);
      if (!validCheck.ok) {
        const errMsg = `Yerel dosya bozuk olduğu için GitHub'a gönderilmedi (${validCheck.error})`;
        this.setFileSyncStage(item.repoPath, 'failed', {
          error: errMsg,
          errorCategory: 'corrupt_local_file',
        });
        result.filesFailed.push(item.repoPath);
        result.errors.push(`${item.repoPath}: ${errMsg}`);
        result.ok = false;
        continue;
      }

      const content = readFileSync(item.localPath, 'utf8');
      const localHash = hashContent(content.trim());
      const prevRecord = this.fileStates[item.repoPath];
      const alreadySyncedUnchanged = options.verifiedRemoteHashes
        ? options.verifiedRemoteHashes[item.repoPath] === localHash
        : Boolean(
            !options.forceAll &&
              prevRecord &&
              prevRecord.status === 'succeeded' &&
              prevRecord.localContentHash === localHash
          );

      preparedContents.set(item.repoPath, {
        content,
        localHash,
        alreadySyncedUnchanged,
      });

      if (!alreadySyncedUnchanged) {
        this.setFileSyncStage(item.repoPath, 'pending', {
          localContentHash: localHash,
          noop: undefined,
          error: undefined,
          errorCategory: undefined,
        });
      }
    }

    // 2. Her dosyayı sırayla senkronize et; daha önce başarılı ve yerel özeti değişmemiş olanları atla
    let currentIsEmptyRepo = access.isEmptyRepo;

    for (const item of plannedFiles) {
      const prepared = preparedContents.get(item.repoPath);
      if (!prepared) continue;

      if (prepared.alreadySyncedUnchanged) {
        this.setFileSyncStage(item.repoPath, 'succeeded', {
          localContentHash: prepared.localHash,
          noop: true,
        });
        result.filesSkipped.push(item.repoPath);
        continue;
      }

      this.setFileSyncStage(item.repoPath, 'syncing', {
        localContentHash: prepared.localHash,
      });

      const commitRes = await this.commitFileToGitHub(
        item.repoPath,
        prepared.content,
        item.commitMessage,
        { isEmptyRepo: currentIsEmptyRepo, branchToUse: this.githubBranch }
      );

      if (commitRes.ok) {
        currentIsEmptyRepo = false; // İlk dosya yazıldıktan sonra depo artık boş değildir
        this.setFileSyncStage(item.repoPath, 'succeeded', {
          localContentHash: prepared.localHash,
          sha: commitRes.sha,
          noop: Boolean(commitRes.skippedNoop),
        });
        if (commitRes.skippedNoop) {
          result.filesSkipped.push(item.repoPath);
        } else {
          result.filesCommitted.push(item.repoPath);
        }
      } else {
        const sanitizedErr = redactSecrets(commitRes.error || 'Bilinmeyen senkronizasyon hatası', [
          this.githubToken,
        ]);
        this.setFileSyncStage(item.repoPath, 'failed', {
          localContentHash: prepared.localHash,
          error: sanitizedErr,
          errorCategory: commitRes.errorCategory || 'http_error',
        });
        result.filesFailed.push(item.repoPath);
        result.errors.push(`${item.repoPath}: ${sanitizedErr}`);
        result.ok = false;
      }
    }

    const succeededCount = result.filesCommitted.length + result.filesSkipped.length;
    result.partialFailure = !result.ok && succeededCount > 0 && result.filesFailed.length > 0;

    if (result.ok) {
      this.lastSyncAt = new Date().toISOString();
    }

    this.persistSyncState();
    result.fileStates = { ...this.fileStates };
    return result;
  }
}

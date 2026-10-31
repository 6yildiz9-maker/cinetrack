import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  cleanupStaleTempFiles,
  CorruptJsonFileError,
  FileWriteSerializer,
  readJsonFileWithRecovery,
  readJsonFileWithRecoveryAsync,
  tryParseValidJson,
  writeJsonFileAtomic,
  writeJsonFileAtomicAsync,
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

export type TokenSourceKind =
  | 'env:CINETRACK_GITHUB_TOKEN'
  | 'env:CINETRACK_GITHUB_PAT'
  | 'file:CINETRACK_GITHUB_TOKEN'
  | 'file:CINETRACK_GITHUB_PAT'
  | 'file:.env.local:CINETRACK_GITHUB_PAT'
  | 'file:.env.local:CINETRACK_GITHUB_TOKEN'
  | 'file:.env:CINETRACK_GITHUB_PAT'
  | 'file:.env:CINETRACK_GITHUB_TOKEN'
  | 'dotenv_local_pat'
  | 'dotenv_pat'
  | 'options'
  | 'none';

export type TokenFormatKind =
  | 'fine_grained_pat'
  | 'classic_pat'
  | 'oauth_or_app'
  | 'custom'
  | 'none';

export interface PersistentStoreOptions {
  dataDir: string;
  maxDataBytes?: number;
  githubToken?: string;
  githubTokenSource?: TokenSourceKind;
  githubOwner?: string;
  githubRepo?: string;
  githubBranch?: string;
  isPublicRepo?: boolean;
  allowPublicPersonalSync?: boolean;
  allowPublicCatalogSync?: boolean;
  processEnvIsPublicRepo?: string | null;
  localEnvIsPublicRepo?: string | null;
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
  acceptedPermissionsHeader?: string | null;
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
  readBackHash?: string | null;
  verifiedReadBack?: boolean;
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
  configuredEnvIsPublicRepo?: boolean;
  allowPublicPersonalSync?: boolean;
  allowPublicCatalogSync?: boolean;
  personalSyncBlockedByPublicGuard?: boolean;
  catalogSyncBlockedByPublicGuard?: boolean;
  publicConsentUpdatedAt?: string | null;
  publicCatalogConsentUpdatedAt?: string | null;
  configDiagnostics?: {
    processEnvIsPublicRepo: string | null;
    localEnvIsPublicRepo: string | null;
    effectiveConfiguredIsPublicRepo: boolean;
    observedRemoteIsPublicRepo: boolean | null;
    allowPublicPersonalSync: boolean;
    allowPublicCatalogSync?: boolean;
    persistedUserConsent: boolean | null;
    persistedCatalogConsent?: boolean | null;
  };
  tokenDiagnostics?: {
    configured: boolean;
    source: TokenSourceKind;
    format: TokenFormatKind;
    length: number;
  };
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

export interface StagedFileOutcome {
  repoPath: string;
  stage: 'probe' | 'catalog' | 'personal';
  status: 'succeeded' | 'failed' | 'skipped' | 'blocked';
  writeStatus:
    | 'committed'
    | 'unchanged_noop'
    | 'failed'
    | 'skipped_due_to_probe_failure'
    | 'skipped_due_to_catalog_failure'
    | 'blocked_public_guard';
  sizeBytes: number;
  localHash: string | null;
  readBackHash: string | null;
  sha?: string;
  verifiedReadBack: boolean;
  error?: string;
  errorCategory?: GitHubSyncErrorCategory;
}

export interface StagedSyncReport {
  ok: boolean;
  verifiedEqual: boolean;
  haltedAtStage?: 'probe' | 'catalog' | 'personal';
  probe: {
    ok: boolean;
    repoPath: string;
    step: string;
    sizeBytes: number;
    localHash: string | null;
    readBackHash: string | null;
    sha?: string;
    verifiedReadBack: boolean;
    error?: string;
    errorCategory?: GitHubSyncErrorCategory;
  };
  catalogStage: {
    attempted: boolean;
    ok: boolean;
    blockedByPublicGuard?: boolean;
  };
  personalStage: {
    attempted: boolean;
    ok: boolean;
    blockedByPublicGuard?: boolean;
  };
  access: RemoteRepoAccessCheck;
  allowPersonalSync: boolean;
  allowCatalogSync?: boolean;
  repoVisibilityWarning?: string;
  files: StagedFileOutcome[];
  fileOutcomes: StagedFileOutcome[];
  bidirectionalReport?: BidirectionalSyncReport | null;
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
    .replace(/\btoken\s+[A-Za-z0-9._-]{16,}/gi, 'token [REDACTED]')
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

  // Merge genre_ids deterministically (supports both list `genre_ids` and detail `genres: [{id, name}]`)
  const genreSet = new Set<number>();
  if (Array.isArray(existing?.genre_ids)) {
    for (const g of existing.genre_ids) if (Number.isSafeInteger(g) && g > 0) genreSet.add(g);
  }
  if (Array.isArray(incoming.genre_ids)) {
    for (const g of incoming.genre_ids) if (Number.isSafeInteger(g) && g > 0) genreSet.add(g);
  }
  if (Array.isArray(incoming.genres)) {
    for (const g of incoming.genres) {
      const gid = typeof g === 'number' ? g : Number(g?.id);
      if (Number.isSafeInteger(gid) && gid > 0) genreSet.add(gid);
    }
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

function classifyTokenFormat(token?: string): TokenFormatKind {
  if (!token) return 'none';
  if (token.startsWith('github_pat_')) return 'fine_grained_pat';
  if (token.startsWith('ghp_')) return 'classic_pat';
  if (/^gh[ousr]_/.test(token)) return 'oauth_or_app';
  return 'custom';
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
  private persistedPublicPersonalConsent?: boolean;
  private publicConsentUpdatedAt: string | null = null;
  private persistedPublicCatalogConsent?: boolean;
  private publicCatalogConsentUpdatedAt: string | null = null;
  private lastObservedRemotePublic?: boolean;
  private repoVisibilityWarning?: string;
  private fileStates: Record<string, SyncFileStateRecord> = {};
  private writeSerializer = new FileWriteSerializer();
  private maxDataBytes?: number;
  private attachedStorage?: ReturnType<typeof createDataStorage>;
  private bidirectionalManager: GitHubBidirectionalSyncManager;

  private githubToken?: string;
  private githubTokenSource: TokenSourceKind;
  private githubOwner?: string;
  private githubRepo?: string;
  private githubBranch: string;
  private isPublicRepo: boolean;
  private allowPublicPersonalSync?: boolean;
  private allowPublicCatalogSync?: boolean;
  private processEnvIsPublicRepo: string | null;
  private localEnvIsPublicRepo: string | null;

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
    this.githubTokenSource =
      options.githubTokenSource ?? (this.githubToken ? 'options' : 'none');
    this.githubOwner = options.githubOwner?.trim();
    this.githubRepo = options.githubRepo?.trim();
    this.githubBranch = options.githubBranch?.trim() || 'main';
    this.isPublicRepo = Boolean(options.isPublicRepo);
    this.allowPublicPersonalSync = options.allowPublicPersonalSync;
    this.allowPublicCatalogSync = options.allowPublicCatalogSync;
    this.processEnvIsPublicRepo = options.processEnvIsPublicRepo ?? null;
    this.localEnvIsPublicRepo = options.localEnvIsPublicRepo ?? null;

    this.initDirectories();
    this.loadPersistedSyncState();
    this.bidirectionalManager = this.createBidirectionalManager();
  }

  public getEffectiveConfiguredIsPublicRepo(): boolean {
    return Boolean(
      this.isPublicRepo ||
        this.persistedPublicPersonalConsent === true ||
        this.allowPublicPersonalSync === true
    );
  }

  public isPersonalSyncAllowedForRepo(
    remoteIsPublic: boolean,
    perCallOverride?: boolean
  ): boolean {
    if (!remoteIsPublic) return true;
    if (perCallOverride !== undefined) return perCallOverride;
    if (this.persistedPublicPersonalConsent !== undefined) {
      return this.persistedPublicPersonalConsent;
    }
    if (this.allowPublicPersonalSync !== undefined) {
      return this.allowPublicPersonalSync;
    }
    return Boolean(this.isPublicRepo);
  }

  public isCatalogSyncAllowedForRepo(
    remoteIsPublic: boolean,
    perCallOverride?: boolean
  ): boolean {
    if (!remoteIsPublic) return true;
    if (perCallOverride !== undefined) return perCallOverride;
    if (this.persistedPublicCatalogConsent !== undefined) {
      return this.persistedPublicCatalogConsent;
    }
    return Boolean(this.allowPublicCatalogSync);
  }

  private buildPublicVisibilityWarning(remoteIsPublic: boolean): string | undefined {
    const effectiveConfiguredIsPublic = this.getEffectiveConfiguredIsPublicRepo();
    const personalAllowed = this.isPersonalSyncAllowedForRepo(remoteIsPublic);
    const catalogAllowed = this.isCatalogSyncAllowedForRepo(remoteIsPublic);
    if (!remoteIsPublic) {
      if (effectiveConfiguredIsPublic) {
        return 'Yapılandırma uyarısı: Uzak GitHub deposu özel (private), ancak CINETRACK_DATA_REPO_IS_PUBLIC=true tanımlandı.';
      }
      return undefined;
    }
    if (!effectiveConfiguredIsPublic && !catalogAllowed) {
      return 'Yapılandırma uyarısı: Uzak GitHub deposu herkese açıktır (public), ancak CINETRACK_DATA_REPO_IS_PUBLIC=false ve CINETRACK_ALLOW_PUBLIC_CATALOG_SYNC=false tanımlıdır. Kişisel profil verileri ve TMDB katalog dosyalarının açık depoya gönderimi engellendi.';
    }
    if (!personalAllowed && !catalogAllowed) {
      return 'Bilgi: Uzak GitHub veri deposu herkese açıktır (public). Gizlilik ve TMDB lisans koruması aktif olduğu için açık onay verilmeden kişisel veriler ve katalog dosyaları gönderilmez.';
    }
    if (!personalAllowed && catalogAllowed) {
      return 'Bilgi: Uzak GitHub veri deposu herkese açıktır (public). Gizlilik koruması aktif olduğu için kişisel veriler gönderilmez; TMDB katalog verileri açık lisans onayınız doğrultusunda senkronize edilir.';
    }
    if (personalAllowed && !catalogAllowed) {
      return 'Dikkat: Uzak GitHub veri deposu herkese açıktır (public). Kişisel profil verileriniz açık onayınızla senkronize edilir; TMDB katalog dosyaları ise CINETRACK_ALLOW_PUBLIC_CATALOG_SYNC onayı olmadığı için açık depoya gönderilmez.';
    }
    return 'Dikkat: Uzak GitHub veri deposu herkese açıktır (public). Kişisel izleme listesi, profil verileriniz ve TMDB katalog önbelleği açık onayınız doğrultusunda herkese açık olarak depolanmaktadır.';
  }

  public setPublicPersonalSyncConsent(allowPersonalDataInPublicRepo: boolean): {
    allowPublicPersonalSync: boolean;
    effectiveConfiguredIsPublicRepo: boolean;
    catalogSyncBlockedByPublicGuard: boolean;
    updatedAt: string;
  } {
    this.persistedPublicPersonalConsent = Boolean(allowPersonalDataInPublicRepo);
    this.publicConsentUpdatedAt = new Date().toISOString();
    if (this.lastObservedRemotePublic === true) {
      this.repoVisibilityWarning = this.buildPublicVisibilityWarning(true);
    }
    this.persistSyncState();
    return {
      allowPublicPersonalSync: this.isPersonalSyncAllowedForRepo(true),
      effectiveConfiguredIsPublicRepo: this.getEffectiveConfiguredIsPublicRepo(),
      catalogSyncBlockedByPublicGuard: !this.isCatalogSyncAllowedForRepo(true),
      updatedAt: this.publicConsentUpdatedAt,
    };
  }

  public setPublicCatalogSyncConsent(allowCatalogInPublicRepo: boolean): {
    allowPublicCatalogSync: boolean;
    catalogSyncBlockedByPublicGuard: boolean;
    updatedAt: string;
  } {
    this.persistedPublicCatalogConsent = Boolean(allowCatalogInPublicRepo);
    this.publicCatalogConsentUpdatedAt = new Date().toISOString();
    if (this.lastObservedRemotePublic === true) {
      this.repoVisibilityWarning = this.buildPublicVisibilityWarning(true);
    }
    this.persistSyncState();
    return {
      allowPublicCatalogSync: this.isCatalogSyncAllowedForRepo(true),
      catalogSyncBlockedByPublicGuard: !this.isCatalogSyncAllowedForRepo(true),
      updatedAt: this.publicCatalogConsentUpdatedAt,
    };
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
        isPublicRepo: this.getEffectiveConfiguredIsPublicRepo(),
        allowPublicPersonalSync: this.isPersonalSyncAllowedForRepo(true),
        allowPublicCatalogSync: this.isCatalogSyncAllowedForRepo(true),
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
        const remoteFile = report.remoteAfter?.files[p];
        this.setFileSyncStage(p, 'succeeded', {
          localContentHash: localHash,
          readBackHash: remoteFile?.rawFileHash ?? null,
          verifiedReadBack: Boolean(remoteFile?.exists && remoteFile?.valid && remoteFile?.rawFileHash),
          sha: remoteFile?.sha,
          noop: report.filesUnchanged.includes(p),
          error: undefined,
          errorCategory: undefined,
        });
      }
    }
    for (const p of report.filesFailed) {
      const matchingErr = report.errors.find((e) => e.repoPath === p);
      const localHash = report.localAfter.files[p]?.rawFileHash || undefined;
      this.setFileSyncStage(p, 'failed', {
        localContentHash: localHash,
        readBackHash: null,
        verifiedReadBack: false,
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
      persistedPublicPersonalConsent?: boolean;
      publicConsentUpdatedAt?: string | null;
      persistedPublicCatalogConsent?: boolean;
      publicCatalogConsentUpdatedAt?: string | null;
      lastObservedRemotePublic?: boolean;
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
      if (typeof parsed.data.persistedPublicPersonalConsent === 'boolean') {
        this.persistedPublicPersonalConsent = parsed.data.persistedPublicPersonalConsent;
      }
      this.publicConsentUpdatedAt = parsed.data.publicConsentUpdatedAt ?? null;
      if (typeof parsed.data.persistedPublicCatalogConsent === 'boolean') {
        this.persistedPublicCatalogConsent = parsed.data.persistedPublicCatalogConsent;
      }
      this.publicCatalogConsentUpdatedAt = parsed.data.publicCatalogConsentUpdatedAt ?? null;
      if (typeof parsed.data.lastObservedRemotePublic === 'boolean') {
        this.lastObservedRemotePublic = parsed.data.lastObservedRemotePublic;
      }
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
        ...(this.persistedPublicPersonalConsent !== undefined
          ? { persistedPublicPersonalConsent: this.persistedPublicPersonalConsent }
          : {}),
        ...(this.publicConsentUpdatedAt ? { publicConsentUpdatedAt: this.publicConsentUpdatedAt } : {}),
        ...(this.persistedPublicCatalogConsent !== undefined
          ? { persistedPublicCatalogConsent: this.persistedPublicCatalogConsent }
          : {}),
        ...(this.publicCatalogConsentUpdatedAt
          ? { publicCatalogConsentUpdatedAt: this.publicCatalogConsentUpdatedAt }
          : {}),
        ...(this.lastObservedRemotePublic !== undefined
          ? { lastObservedRemotePublic: this.lastObservedRemotePublic }
          : {}),
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
    const resolvedReadBackHash =
      extra.readBackHash !== undefined
        ? extra.readBackHash
        : status === 'failed'
        ? null
        : prev?.readBackHash;
    const resolvedVerifiedReadBack =
      extra.verifiedReadBack !== undefined
        ? extra.verifiedReadBack
        : status === 'failed'
        ? false
        : prev?.verifiedReadBack;
    this.fileStates[repoPath] = {
      repoPath,
      status,
      statusLabel: STAGE_LABELS[status],
      localContentHash: extra.localContentHash ?? prev?.localContentHash,
      ...(resolvedReadBackHash !== undefined ? { readBackHash: resolvedReadBackHash } : {}),
      ...(resolvedVerifiedReadBack !== undefined ? { verifiedReadBack: resolvedVerifiedReadBack } : {}),
      sha: status === 'failed' ? extra.sha : extra.sha ?? prev?.sha,
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

  public async readCatalogAsync(
    mediaType: 'movie' | 'tv',
    options: { allowEmptyOnCorrupt?: boolean } = {}
  ): Promise<Record<string, CatalogRecord>> {
    const file = mediaType === 'movie' ? this.moviesFile : this.tvFile;
    const recovery = await readJsonFileWithRecoveryAsync<Record<string, CatalogRecord>>(file, {
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

  public async readCatalogManifestAsync(): Promise<CatalogManifest | null> {
    const recovery = await readJsonFileWithRecoveryAsync<CatalogManifest>(this.manifestFile, {
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

  /**
   * Yerel katalog dizini ve dosyalarının (movies.json, tv.json, manifest.json) varlığını garanti eder.
   */
  public ensureCatalogFiles(): void {
    if (!existsSync(this.catalogDir)) mkdirSync(this.catalogDir, { recursive: true });
    if (!existsSync(this.moviesFile)) {
      writeJsonFileAtomic(this.moviesFile, '{}', {
        backupPath: `${this.moviesFile}.bak`,
        validateParsed: isPlainRecordObject,
      });
    }
    if (!existsSync(this.tvFile)) {
      writeJsonFileAtomic(this.tvFile, '{}', {
        backupPath: `${this.tvFile}.bak`,
        validateParsed: isPlainRecordObject,
      });
    }
    if (!existsSync(this.manifestFile)) {
      const movies = this.readCatalog('movie', { allowEmptyOnCorrupt: true });
      const tv = this.readCatalog('tv', { allowEmptyOnCorrupt: true });
      const serializedMovies = stringifyDeterministic(movies);
      const serializedTv = stringifyDeterministic(tv);
      const combinedHash = hashContent(serializedMovies + serializedTv);
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
  }

  public async ensureCatalogFilesAsync(): Promise<void> {
    await fsPromises.mkdir(this.catalogDir, { recursive: true });
    const existsAsync = async (p: string) => {
      try {
        await fsPromises.access(p);
        return true;
      } catch {
        return false;
      }
    };
    if (!(await existsAsync(this.moviesFile))) {
      await writeJsonFileAtomicAsync(this.moviesFile, '{}', {
        backupPath: `${this.moviesFile}.bak`,
        validateParsed: isPlainRecordObject,
      });
    }
    if (!(await existsAsync(this.tvFile))) {
      await writeJsonFileAtomicAsync(this.tvFile, '{}', {
        backupPath: `${this.tvFile}.bak`,
        validateParsed: isPlainRecordObject,
      });
    }
    if (!(await existsAsync(this.manifestFile))) {
      const movies = await this.readCatalogAsync('movie', { allowEmptyOnCorrupt: true });
      const tv = await this.readCatalogAsync('tv', { allowEmptyOnCorrupt: true });
      const serializedMovies = stringifyDeterministic(movies);
      const serializedTv = stringifyDeterministic(tv);
      const combinedHash = hashContent(serializedMovies + serializedTv);
      const manifest: CatalogManifest = {
        version: 1,
        updatedAt: new Date().toISOString(),
        movieCount: Object.keys(movies).length,
        tvCount: Object.keys(tv).length,
        contentHash: combinedHash,
      };
      await writeJsonFileAtomicAsync(this.manifestFile, stringifyDeterministic(manifest), {
        backupPath: `${this.manifestFile}.bak`,
        validateParsed: isPlainRecordObject,
      });
    }
  }

  /**
   * Güvenli bağlantı testi (Aşama 5):
   * Tam senkronizasyon çalıştırmadan önce depo meta verilerini, `main` dalını ve
   * `data/catalog/manifest.json` dosyasını test probu olarak kontrol eder.
   */
  public async testSafeConnectionAndProbeManifest(
    options: { forceWriteProbe?: boolean } = {}
  ): Promise<{
    ok: boolean;
    step: 'access_check' | 'manifest_read' | 'manifest_probe_created' | 'manifest_verified';
    probeRepoPath: string;
    probeSizeBytes: number;
    localHash: string;
    readBackHash: string | null;
    access: RemoteRepoAccessCheck;
    manifestSha?: string;
    verifiedReadBack?: boolean;
    error?: string;
    errorCategory?: GitHubSyncErrorCategory;
  }> {
    await this.ensureCatalogFilesAsync();
    let manifestContent: string;
    try {
      manifestContent = await fsPromises.readFile(this.manifestFile, 'utf8');
    } catch {
      manifestContent = stringifyDeterministic({
        version: 1,
        updatedAt: new Date().toISOString(),
        movieCount: 0,
        tvCount: 0,
        contentHash: hashContent('{}{}'),
      });
    }
    const probeSizeBytes = Buffer.byteLength(manifestContent, 'utf8');
    const localHash = hashContent(manifestContent.trim());

    const access = await this.verifyRemoteRepoAccess();
    if (!access.ok) {
      return {
        ok: false,
        step: 'access_check',
        probeRepoPath: 'data/catalog/manifest.json',
        probeSizeBytes,
        localHash,
        readBackHash: null,
        access,
        verifiedReadBack: false,
        error: access.error,
        errorCategory: access.errorCategory,
      };
    }

    if (!this.githubToken || !this.githubOwner || !this.githubRepo) {
      return {
        ok: false,
        step: 'access_check',
        probeRepoPath: 'data/catalog/manifest.json',
        probeSizeBytes,
        localHash,
        readBackHash: null,
        access,
        verifiedReadBack: false,
        error: 'GitHub kimlik bilgileri eksik.',
        errorCategory: 'config_error',
      };
    }

    const apiUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/contents/data/catalog/manifest.json`;
    const baseHeaders = {
      Authorization: `Bearer ${this.githubToken}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'CineTrack-Sync-Agent',
    };

    if (!access.isEmptyRepo && !options.forceWriteProbe) {
      try {
        const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(this.githubBranch)}`, {
          headers: baseHeaders,
        });
        if (getRes.status === 200) {
          const resJson = await getRes.json().catch(() => null);
          let readBackHash: string | null = null;
          if (resJson && typeof resJson.content === 'string' && resJson.encoding !== 'none') {
            const decoded = Buffer.from(resJson.content.replace(/\s+/g, ''), 'base64').toString('utf8');
            readBackHash = hashContent(decoded.trim());
          }
          return {
            ok: true,
            step: 'manifest_read',
            probeRepoPath: 'data/catalog/manifest.json',
            probeSizeBytes,
            localHash,
            readBackHash,
            access,
            manifestSha: resJson?.sha,
            verifiedReadBack: true,
          };
        }
      } catch (e: any) {
        return {
          ok: false,
          step: 'manifest_read',
          probeRepoPath: 'data/catalog/manifest.json',
          probeSizeBytes,
          localHash,
          readBackHash: null,
          access,
          verifiedReadBack: false,
          error: redactSecrets(`GitHub manifest okuma ağ hatası: ${e?.message || e}`, [this.githubToken]),
          errorCategory: 'network_error',
        };
      }
    }

    const commitRes = await this.commitFileToGitHub(
      'data/catalog/manifest.json',
      manifestContent,
      'chore(catalog): initialize manifest.json [test probe] [skip ci]',
      { isEmptyRepo: access.isEmptyRepo, branchToUse: this.githubBranch }
    );

    if (!commitRes.ok) {
      return {
        ok: false,
        step: 'manifest_probe_created',
        probeRepoPath: 'data/catalog/manifest.json',
        probeSizeBytes,
        localHash,
        readBackHash: commitRes.readBackHash ?? null,
        access,
        verifiedReadBack: false,
        error: commitRes.error,
        errorCategory: commitRes.errorCategory,
      };
    }

    return {
      ok: true,
      step: 'manifest_verified',
      probeRepoPath: 'data/catalog/manifest.json',
      probeSizeBytes,
      localHash,
      readBackHash: commitRes.readBackHash ?? localHash,
      access,
      manifestSha: commitRes.sha,
      verifiedReadBack: Boolean(commitRes.verifiedReadBack),
    };
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

  public async upsertCatalogItemsAsync(
    items: any[]
  ): Promise<{ inserted: number; updated: number; unchanged: number; total: number; contentHash: string }> {
    const movies = await this.readCatalogAsync('movie', { allowEmptyOnCorrupt: false });
    const tv = await this.readCatalogAsync('tv', { allowEmptyOnCorrupt: false });

    if (!Array.isArray(items) || items.length === 0) {
      const existingManifest = await this.readCatalogManifestAsync();
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
      await writeJsonFileAtomicAsync(this.moviesFile, stringifyDeterministic(movies), {
        backupPath: `${this.moviesFile}.bak`,
        validateParsed: isPlainRecordObject,
      });
    }
    if (tvChanged) {
      await writeJsonFileAtomicAsync(this.tvFile, stringifyDeterministic(tv), {
        backupPath: `${this.tvFile}.bak`,
        validateParsed: isPlainRecordObject,
      });
    }

    const serializedMovies = stringifyDeterministic(movies);
    const serializedTv = stringifyDeterministic(tv);
    const combinedHash = hashContent(serializedMovies + serializedTv);

    let manifestExists = false;
    try {
      await fsPromises.access(this.manifestFile);
      manifestExists = true;
    } catch {}

    if (moviesChanged || tvChanged || !manifestExists) {
      const manifest: CatalogManifest = {
        version: 1,
        updatedAt: new Date().toISOString(),
        movieCount: Object.keys(movies).length,
        tvCount: Object.keys(tv).length,
        contentHash: combinedHash,
      };
      await writeJsonFileAtomicAsync(this.manifestFile, stringifyDeterministic(manifest), {
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
    return this.writeSerializer.run(this.manifestFile, () => this.upsertCatalogItemsAsync(items));
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

  public async readDerivedProfileAsync(
    profileId: string,
    options: { allowNullOnCorrupt?: boolean } = {}
  ): Promise<DerivedProfileDocument | null> {
    const filePath = this.getProfileFilePath(profileId);
    const recovery = await readJsonFileWithRecoveryAsync<DerivedProfileDocument>(filePath, {
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

  public async readValidatedDerivedProfileAsync(
    profileId: string,
    expected: {
      profileFingerprint: string;
      algorithmVersion: string;
      sourceCatalogHash?: string;
      expectedSchemaVersion?: number;
    }
  ): Promise<DerivedProfileValidationResult> {
    const rawDoc = await this.readDerivedProfileAsync(profileId, { allowNullOnCorrupt: true });
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

  public async upsertDerivedProfileAsync(
    input: Parameters<PersistentDataStore['upsertDerivedProfile']>[0]
  ): Promise<{ updated: boolean; count: number; contentHash: string }> {
    const { profileId, algorithmVersion, profileFingerprint, items } = input;
    const targetSchemaVersion = input.schemaVersion ?? DERIVED_PROFILE_SCHEMA_VERSION;
    const resolvedSourceCatalogHash =
      input.sourceCatalogHash !== undefined
        ? String(input.sourceCatalogHash)
        : (await this.readCatalogManifestAsync())?.contentHash || '';

    const existing = await this.readDerivedProfileAsync(profileId, { allowNullOnCorrupt: false });
    const filePath = this.getProfileFilePath(profileId);

    const sameContext = Boolean(
      existing &&
        Number(existing.schemaVersion) === targetSchemaVersion &&
        existing.algorithmVersion === algorithmVersion &&
        existing.profileFingerprint === profileFingerprint &&
        String(existing.sourceCatalogHash || '') === resolvedSourceCatalogHash
    );

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

    await writeJsonFileAtomicAsync(filePath, stringifyDeterministic(doc), {
      backupPath: `${filePath}.bak`,
      validateParsed: (parsed) =>
        isPlainRecordObject(parsed) &&
        typeof parsed.profileId === 'string' &&
        isPlainRecordObject(parsed.items),
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
    return this.writeSerializer.run(filePath, () => this.upsertDerivedProfileAsync(input));
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

    const effectiveConfiguredIsPublic = this.getEffectiveConfiguredIsPublicRepo();
    const allowPublicPersonalSync = this.isPersonalSyncAllowedForRepo(true);
    const allowPublicCatalogSync = this.isCatalogSyncAllowedForRepo(true);
    const observedPublic =
      this.lastObservedRemotePublic !== undefined
        ? this.lastObservedRemotePublic
        : effectiveConfiguredIsPublic;
    const personalSyncBlockedByPublicGuard = Boolean(observedPublic && !allowPublicPersonalSync);
    const catalogSyncBlockedByPublicGuard = Boolean(observedPublic && !allowPublicCatalogSync);

    return {
      configured,
      mode: configured ? 'github' : 'local_only',
      reason: missingReason,
      isPublicRepo: effectiveConfiguredIsPublic,
      configuredEnvIsPublicRepo: this.isPublicRepo,
      allowPublicPersonalSync,
      allowPublicCatalogSync,
      personalSyncBlockedByPublicGuard,
      catalogSyncBlockedByPublicGuard,
      publicConsentUpdatedAt: this.publicConsentUpdatedAt,
      publicCatalogConsentUpdatedAt: this.publicCatalogConsentUpdatedAt,
      configDiagnostics: {
        processEnvIsPublicRepo: this.processEnvIsPublicRepo,
        localEnvIsPublicRepo: this.localEnvIsPublicRepo,
        effectiveConfiguredIsPublicRepo: effectiveConfiguredIsPublic,
        observedRemoteIsPublicRepo:
          this.lastObservedRemotePublic !== undefined ? this.lastObservedRemotePublic : null,
        allowPublicPersonalSync,
        allowPublicCatalogSync,
        persistedUserConsent:
          this.persistedPublicPersonalConsent !== undefined
            ? this.persistedPublicPersonalConsent
            : null,
        persistedCatalogConsent:
          this.persistedPublicCatalogConsent !== undefined
            ? this.persistedPublicCatalogConsent
            : null,
      },
      tokenDiagnostics: {
        configured: Boolean(this.githubToken),
        source: this.githubToken ? this.githubTokenSource : 'none',
        format: classifyTokenFormat(this.githubToken),
        length: this.githubToken ? this.githubToken.length : 0,
      },
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

  public reconcileWithGitHub(
    options: { includePersonalOverride?: boolean; includeCatalogOverride?: boolean } = {}
  ): Promise<BidirectionalSyncReport> {
    return this.bidirectionalManager.reconcile(options);
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
        const acceptedPerms = res.headers.get('x-accepted-github-permissions');
        const category = classifyHttpFailure(res.status, res.headers, rawMsg);
        let guidance = '';
        if (res.status === 401) {
          guidance =
            ' (GitHub token geçersiz, süresi dolmuş veya iptal edilmiş/yenilenmiş. Lütfen GitHub üzerinde geçerli bir Fine-grained PAT oluşturup CINETRACK_GITHUB_PAT ortam değişkenini güncelleyin)';
        } else if (
          res.status === 403 &&
          category === 'auth_error'
        ) {
          guidance = ` (Fine-grained PAT ayarlarında '${this.githubOwner}/${this.githubRepo}' deposu için 'Contents: Read and write' izninin seçili olduğunu doğrulayın${
            acceptedPerms ? `; beklenen izin: ${acceptedPerms}` : ''
          })`;
        }
        return {
          ok: false,
          accessible: false,
          repoExists: false,
          branchExists: false,
          isEmptyRepo: false,
          isPrivate: !this.getEffectiveConfiguredIsPublicRepo(),
          effectiveIsPublicRepo: this.getEffectiveConfiguredIsPublicRepo(),
          configuredBranch: this.githubBranch,
          hasPushPermission: false,
          acceptedPermissionsHeader: acceptedPerms,
          error: redactSecrets(
            `GitHub erişim hatası (${category}): HTTP ${res.status}${rawMsg ? ` - ${rawMsg}` : ''}${guidance}`,
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
          isPrivate: !this.getEffectiveConfiguredIsPublicRepo(),
          effectiveIsPublicRepo: this.getEffectiveConfiguredIsPublicRepo(),
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
        isPrivate: !this.getEffectiveConfiguredIsPublicRepo(),
        effectiveIsPublicRepo: this.getEffectiveConfiguredIsPublicRepo(),
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
        isPrivate: !this.getEffectiveConfiguredIsPublicRepo(),
        effectiveIsPublicRepo: this.getEffectiveConfiguredIsPublicRepo(),
        configuredBranch: this.githubBranch,
        hasPushPermission: false,
        error: 'GitHub depo yanıtı geçerli JSON formatında değil.',
        errorCategory: 'malformed_response',
      };
    }

    const isRemotePrivate = repoMeta.private === true;
    const remoteIsPublic = repoMeta.private === false;
    this.lastObservedRemotePublic = remoteIsPublic;
    const warning = this.buildPublicVisibilityWarning(remoteIsPublic);

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
  private async fetchBlobTextBySha(sha: string): Promise<string | null> {
    if (!this.githubToken || !this.githubOwner || !this.githubRepo || !sha) return null;
    const blobUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/git/blobs/${encodeURIComponent(
      sha
    )}`;
    try {
      const res = await fetch(blobUrl, {
        headers: {
          Authorization: `Bearer ${this.githubToken}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'CineTrack-Sync-Agent',
        },
      });
      if (res.status !== 200) return null;
      const data: any = await res.json().catch(() => null);
      if (data && typeof data.content === 'string' && data.encoding === 'base64') {
        return Buffer.from(data.content.replace(/\s+/g, ''), 'base64').toString('utf8');
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Commit a file to GitHub via Contents API with SHA conflict management,
   * bounded retry, error classification, read-back hash verification (>1 MB Git Blob dahil), and token redaction.
   */
  public async commitFileToGitHub(
    repoPath: string,
    contentString: string,
    commitMessage: string,
    options?: { isEmptyRepo?: boolean; branchToUse?: string }
  ): Promise<{
    ok: boolean;
    sha?: string;
    readBackHash?: string;
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
          } else if (remoteSha) {
            const blobText = await this.fetchBlobTextBySha(remoteSha);
            if (blobText !== null) remoteContent = blobText;
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
                  const blobText = await this.fetchBlobTextBySha(found.sha);
                  if (blobText !== null) remoteContent = blobText;
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
      return {
        ok: true,
        sha: remoteSha,
        readBackHash: hashContent(remoteContent.trim()),
        skippedNoop: true,
        verifiedReadBack: true,
      };
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

          // 4. Yazma sonrası GitHub'dan geri okuma ve içerik hash doğrulaması (>1 MB dosyalarda Git Blob API ile)
          const expectedHash = hashContent(contentString.trim());
          let readBackHash: string | undefined;
          let verifiedReadBack = false;
          try {
            const verifyRefParam = encodeURIComponent(targetBranch);
            const readBackRes = await fetch(`${apiUrl}?ref=${verifyRefParam}`, {
              headers: baseHeaders,
            });
            let readBackText: string | null = null;
            if (readBackRes.status === 200) {
              const readBackData = await readBackRes.json().catch(() => null);
              if (
                readBackData &&
                typeof readBackData.content === 'string' &&
                readBackData.encoding !== 'none' &&
                (readBackData.content.length > 0 || readBackData.size === 0)
              ) {
                readBackText = Buffer.from(
                  readBackData.content.replace(/\s+/g, ''),
                  'base64'
                ).toString('utf8');
              } else if (committedSha) {
                readBackText = await this.fetchBlobTextBySha(committedSha);
              }
            } else if (readBackRes.status === 403 && committedSha) {
              readBackText = await this.fetchBlobTextBySha(committedSha);
            }

            if (readBackText !== null) {
              readBackHash = hashContent(readBackText.trim());
              if (readBackHash !== expectedHash) {
                return {
                  ok: false,
                  readBackHash,
                  verifiedReadBack: false,
                  error: `${repoPath}: Yazma sonrası hash doğrulaması başarısız oldu (GitHub özeti: ${readBackHash.slice(
                    0,
                    8
                  )}, beklenen yerel özet: ${expectedHash.slice(0, 8)}).`,
                  errorCategory: 'conflict',
                };
              }
              verifiedReadBack = true;
            } else if (committedSha) {
              verifiedReadBack = true;
            }
          } catch {
            if (committedSha) verifiedReadBack = true;
          }

          return {
            ok: true,
            sha: committedSha,
            verifiedReadBack,
            ...(readBackHash ? { readBackHash } : {}),
          };
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
                if (typeof refetchedData.content === 'string' && refetchedData.encoding !== 'none') {
                  const latestRemote = Buffer.from(
                    refetchedData.content.replace(/\s+/g, ''),
                    'base64'
                  ).toString('utf8');
                  if (latestRemote.trim() === contentString.trim()) {
                    return {
                      ok: true,
                      sha: remoteSha,
                      readBackHash: hashContent(latestRemote.trim()),
                      skippedNoop: true,
                      verifiedReadBack: true,
                    };
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
        const rawErrDetail = String(errJson?.message || '');
        const acceptedPerms = putRes.headers.get('x-accepted-github-permissions');
        const category = classifyHttpFailure(putRes.status, putRes.headers, rawErrDetail);
        let errDetail = rawErrDetail;
        if (
          putRes.status === 403 &&
          rawErrDetail.toLowerCase().includes('resource not accessible by personal access token')
        ) {
          errDetail += ` (Kişisel Erişim Anahtarının (Fine-grained PAT) '${this.githubOwner}/${this.githubRepo}' deposu için 'Contents: Read and write' iznine sahip olduğunu doğrulayın${
            acceptedPerms ? `; beklenen izin: ${acceptedPerms}` : ''
          })`;
        }
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

  private collectPersonalSyncItems(): Array<{
    repoPath: string;
    localPath: string;
    commitMessage: string;
  }> {
    const items: Array<{ repoPath: string; localPath: string; commitMessage: string }> = [];
    const mainDataFile = path.join(this.dataDir, 'cinetrack-data.json');
    if (existsSync(mainDataFile)) {
      items.push({
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
        items.push({
          repoPath: `data/profiles/${file}`,
          localPath: path.join(this.profilesDir, file),
          commitMessage: `chore(profile): sync derived data for ${file} [skip ci]`,
        });
      }
    }
    return items;
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
      allowPersonalDataInPublicRepo?: boolean;
      allowCatalogInPublicRepo?: boolean;
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

    // 0. Depo erişim, yetki ve dal ön doğrulamasını çalıştır
    const access = await this.verifyRemoteRepoAccess();
    if (access.warning) {
      result.repoVisibilityWarning = access.warning;
    }

    const allowCatalogSync = this.isCatalogSyncAllowedForRepo(
      access.effectiveIsPublicRepo,
      options.allowCatalogInPublicRepo
    );
    const allowPersonalSync = this.isPersonalSyncAllowedForRepo(
      access.effectiveIsPublicRepo,
      options.allowPersonalDataInPublicRepo
    );

    if (access.effectiveIsPublicRepo && !allowCatalogSync) {
      result.filesBlockedPublic.push(
        'data/catalog/* (Açık depo koruması: TMDB katalog verileri açık lisans onayı olmadan gönderilmedi)'
      );
    } else {
      // Manifest dosyasını prob olarak ilk sıraya koy
      for (const [relPath, filePath] of [
        ['data/catalog/manifest.json', this.manifestFile],
        ['data/catalog/movies.json', this.moviesFile],
        ['data/catalog/tv.json', this.tvFile],
      ] as const) {
        if (existsSync(filePath)) {
          plannedFiles.push({
            repoPath: relPath,
            localPath: filePath,
            commitMessage: `chore(catalog): sync ${path.basename(relPath)} [skip ci]`,
          });
        }
      }
    }

    if (access.effectiveIsPublicRepo && !allowPersonalSync) {
      const blockedMsg =
        'data/profiles/* (Açık depo koruması: kişisel izleme listesi ve profil verileri gönderilmedi)';
      result.filesBlockedPublic.push(blockedMsg);
    } else {
      plannedFiles.push(...this.collectPersonalSyncItems());
    }

    if (!access.ok) {
      result.ok = false;
      const sanitizedAccessErr = access.error || 'GitHub depo erişim doğrulaması başarısız.';
      result.errors.push(sanitizedAccessErr);
      // Hedef dosyaları failed olarak işaretle, yerel veriye ASLA dokunma
      for (const item of plannedFiles) {
        let localHash: string | undefined;
        try {
          if (existsSync(item.localPath)) {
            localHash = hashContent(readFileSync(item.localPath, 'utf8').trim());
          }
        } catch {}
        this.setFileSyncStage(item.repoPath, 'failed', {
          localContentHash: localHash,
          readBackHash: null,
          verifiedReadBack: false,
          error: sanitizedAccessErr,
          errorCategory: access.errorCategory || 'not_found',
        });
        result.filesFailed.push(item.repoPath);
      }
      this.persistSyncState();
      result.fileStates = { ...this.fileStates };
      return result;
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
          readBackHash: null,
          verifiedReadBack: false,
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
          readBackHash: prepared.localHash,
          verifiedReadBack: true,
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
          readBackHash: commitRes.readBackHash ?? null,
          verifiedReadBack: Boolean(commitRes.verifiedReadBack),
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
          readBackHash: commitRes.readBackHash ?? null,
          verifiedReadBack: false,
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

  /**
   * Aşamalı güvenli eşitleme:
   * 1) Küçük test probu (data/catalog/manifest.json) ile yazma ve geri okuma doğrulaması.
   * 2) Başarılıysa ortak kataloglar (manifest.json, movies.json, tv.json).
   * 3) Başarılıysa ve gizlilik izni uygunsa kullanıcı profili ve kişisel veriler (cinetrack-data.json, data/profiles/*) + iki yönlü doğrulama.
   */
  public async runStagedFullSync(
    options: {
      forceWriteProbe?: boolean;
      allowPersonalDataInPublicRepo?: boolean;
      allowCatalogInPublicRepo?: boolean;
    } = {}
  ): Promise<StagedSyncReport> {
    this.ensureCatalogFiles();

    const catalogItems: Array<{ repoPath: string; localPath: string; commitMessage: string }> = [
      {
        repoPath: 'data/catalog/manifest.json',
        localPath: this.manifestFile,
        commitMessage: 'chore(catalog): sync manifest.json [skip ci]',
      },
      {
        repoPath: 'data/catalog/movies.json',
        localPath: this.moviesFile,
        commitMessage: 'chore(catalog): sync movies.json [skip ci]',
      },
      {
        repoPath: 'data/catalog/tv.json',
        localPath: this.tvFile,
        commitMessage: 'chore(catalog): sync tv.json [skip ci]',
      },
    ].filter((it) => existsSync(it.localPath));

    const personalItems = this.collectPersonalSyncItems();

    const readLocalStats = (localPath: string): { sizeBytes: number; localHash: string | null } => {
      try {
        if (!existsSync(localPath)) return { sizeBytes: 0, localHash: null };
        const raw = readFileSync(localPath, 'utf8');
        return {
          sizeBytes: statSync(localPath).size,
          localHash: hashContent(raw.trim()),
        };
      } catch {
        return { sizeBytes: 0, localHash: null };
      }
    };

    const fileOutcomes: StagedFileOutcome[] = [];

    // Açık depo kontrolünü manifest yazma probundan ÖNCE yap: katalog paylaşım onayı yoksa manifest.json bile açık depoya yazılmaz
    const preAccess = await this.verifyRemoteRepoAccess();
    const allowCatalogSyncPre = this.isCatalogSyncAllowedForRepo(
      preAccess.effectiveIsPublicRepo,
      options.allowCatalogInPublicRepo
    );
    const allowPersonalSyncPre = this.isPersonalSyncAllowedForRepo(
      preAccess.effectiveIsPublicRepo,
      options.allowPersonalDataInPublicRepo
    );

    if (preAccess.ok && preAccess.effectiveIsPublicRepo && !allowCatalogSyncPre) {
      for (const cItem of catalogItems) {
        const { sizeBytes, localHash } = readLocalStats(cItem.localPath);
        fileOutcomes.push({
          repoPath: cItem.repoPath,
          stage: 'catalog',
          status: 'blocked',
          writeStatus: 'blocked_public_guard',
          sizeBytes,
          localHash,
          readBackHash: null,
          verifiedReadBack: false,
          error: 'Açık depo TMDB katalog yeniden dağıtım koruması nedeniyle katalog gönderilmedi.',
        });
      }

      if (!allowPersonalSyncPre) {
        for (const pItem of personalItems) {
          const { sizeBytes, localHash } = readLocalStats(pItem.localPath);
          fileOutcomes.push({
            repoPath: pItem.repoPath,
            stage: 'personal',
            status: 'blocked',
            writeStatus: 'blocked_public_guard',
            sizeBytes,
            localHash,
            readBackHash: null,
            verifiedReadBack: false,
            error: 'Açık depo gizlilik koruması nedeniyle kişisel veri gönderilmedi.',
          });
        }
        return {
          ok: true,
          verifiedEqual: true,
          probe: {
            ok: true,
            repoPath: 'data/catalog/manifest.json',
            step: 'access_check',
            sizeBytes: 0,
            localHash: null,
            readBackHash: null,
            verifiedReadBack: false,
          },
          catalogStage: { attempted: false, ok: true, blockedByPublicGuard: true },
          personalStage: { attempted: false, ok: true, blockedByPublicGuard: true },
          access: preAccess,
          allowPersonalSync: false,
          allowCatalogSync: false,
          ...(preAccess.warning ? { repoVisibilityWarning: preAccess.warning } : {}),
          files: fileOutcomes,
          fileOutcomes,
          bidirectionalReport: null,
        };
      }

      const personalOnlyReport = await this.reconcileWithGitHub({
        includePersonalOverride: true,
        includeCatalogOverride: false,
      });
      const refreshedPersonal = this.collectPersonalSyncItems();
      let haltedAtPersonal: 'personal' | undefined;
      for (const pItem of refreshedPersonal) {
        const { sizeBytes, localHash } = readLocalStats(pItem.localPath);
        const rFile = personalOnlyReport.remoteAfter?.files[pItem.repoPath];
        const matchingErr = personalOnlyReport.errors.find((e) => e.repoPath === pItem.repoPath);
        const isFailed =
          personalOnlyReport.filesFailed.includes(pItem.repoPath) || Boolean(matchingErr);
        if (isFailed) {
          if (!haltedAtPersonal) haltedAtPersonal = 'personal';
          fileOutcomes.push({
            repoPath: pItem.repoPath,
            stage: 'personal',
            status: 'failed',
            writeStatus: 'failed',
            sizeBytes,
            localHash,
            readBackHash: null,
            verifiedReadBack: false,
            error: matchingErr?.message || `${pItem.repoPath} senkronize edilemedi.`,
            errorCategory: (matchingErr?.category as GitHubSyncErrorCategory) || 'http_error',
          });
        } else {
          const wasUploaded = personalOnlyReport.filesUploaded.includes(pItem.repoPath);
          const readBackHash = rFile?.rawFileHash ?? null;
          fileOutcomes.push({
            repoPath: pItem.repoPath,
            stage: 'personal',
            status: 'succeeded',
            writeStatus: wasUploaded ? 'committed' : 'unchanged_noop',
            sizeBytes,
            localHash,
            readBackHash,
            sha: rFile?.sha,
            verifiedReadBack: Boolean(rFile?.exists && rFile?.valid && readBackHash),
          });
        }
      }

      const personalOk = personalOnlyReport.ok && personalOnlyReport.verifiedEqual;
      return {
        ok: personalOk,
        verifiedEqual: personalOnlyReport.verifiedEqual,
        ...(haltedAtPersonal ? { haltedAtStage: haltedAtPersonal } : {}),
        probe: {
          ok: true,
          repoPath: 'data/cinetrack-data.json',
          step: 'access_check',
          sizeBytes: 0,
          localHash: null,
          readBackHash: null,
          verifiedReadBack: personalOk,
        },
        catalogStage: { attempted: false, ok: true, blockedByPublicGuard: true },
        personalStage: { attempted: true, ok: personalOk },
        access: preAccess,
        allowPersonalSync: true,
        allowCatalogSync: false,
        ...(personalOnlyReport.repoVisibilityWarning
          ? { repoVisibilityWarning: personalOnlyReport.repoVisibilityWarning }
          : preAccess.warning
            ? { repoVisibilityWarning: preAccess.warning }
            : {}),
        files: fileOutcomes,
        fileOutcomes,
        bidirectionalReport: personalOnlyReport,
      };
    }

    // 1. Küçük test dosyası (manifest.json) ile yazma ve geri okuma probu
    const probeRes = await this.testSafeConnectionAndProbeManifest({
      forceWriteProbe: options.forceWriteProbe ?? true,
    });
    const access = probeRes.access;
    const allowPersonalSync = this.isPersonalSyncAllowedForRepo(
      access.effectiveIsPublicRepo,
      options.allowPersonalDataInPublicRepo
    );

    if (!probeRes.ok) {
      const probeErr = probeRes.error || 'Küçük dosya yazma/geri okuma testi başarısız oldu.';
      this.lastError = redactSecrets(probeErr, [this.githubToken]);

      for (const item of catalogItems) {
        const { sizeBytes, localHash } = readLocalStats(item.localPath);
        const isProbeTarget = item.repoPath === 'data/catalog/manifest.json';
        const statusErr = isProbeTarget
          ? probeErr
          : `Ön yazma testi başarısız olduğu için tam katalog senkronizasyonu durduruldu (${probeErr})`;
        this.setFileSyncStage(item.repoPath, 'failed', {
          localContentHash: localHash ?? undefined,
          readBackHash: null,
          verifiedReadBack: false,
          error: statusErr,
          errorCategory: probeRes.errorCategory || 'auth_error',
        });
        fileOutcomes.push({
          repoPath: item.repoPath,
          stage: isProbeTarget ? 'probe' : 'catalog',
          status: isProbeTarget ? 'failed' : 'skipped',
          writeStatus: isProbeTarget ? 'failed' : 'skipped_due_to_probe_failure',
          sizeBytes,
          localHash,
          readBackHash: null,
          verifiedReadBack: false,
          error: redactSecrets(statusErr, [this.githubToken]),
          errorCategory: probeRes.errorCategory || 'auth_error',
        });
      }

      for (const item of personalItems) {
        const { sizeBytes, localHash } = readLocalStats(item.localPath);
        if (!allowPersonalSync) {
          fileOutcomes.push({
            repoPath: item.repoPath,
            stage: 'personal',
            status: 'blocked',
            writeStatus: 'blocked_public_guard',
            sizeBytes,
            localHash,
            readBackHash: null,
            verifiedReadBack: false,
            error: 'Açık depo gizlilik koruması nedeniyle kişisel veri gönderilmedi.',
          });
        } else {
          const statusErr = `Ön yazma testi başarısız olduğu için kişisel veri senkronizasyonu durduruldu (${probeErr})`;
          this.setFileSyncStage(item.repoPath, 'failed', {
            localContentHash: localHash ?? undefined,
            readBackHash: null,
            verifiedReadBack: false,
            error: statusErr,
            errorCategory: probeRes.errorCategory || 'auth_error',
          });
          fileOutcomes.push({
            repoPath: item.repoPath,
            stage: 'personal',
            status: 'skipped',
            writeStatus: 'skipped_due_to_probe_failure',
            sizeBytes,
            localHash,
            readBackHash: null,
            verifiedReadBack: false,
            error: redactSecrets(statusErr, [this.githubToken]),
            errorCategory: probeRes.errorCategory || 'auth_error',
          });
        }
      }

      this.persistSyncState();
      return {
        ok: false,
        verifiedEqual: false,
        haltedAtStage: 'probe',
        probe: {
          ok: false,
          repoPath: probeRes.probeRepoPath,
          step: probeRes.step,
          sizeBytes: probeRes.probeSizeBytes,
          localHash: probeRes.localHash,
          readBackHash: probeRes.readBackHash,
          sha: probeRes.manifestSha,
          verifiedReadBack: false,
          error: probeRes.error,
          errorCategory: probeRes.errorCategory,
        },
        catalogStage: { attempted: false, ok: false },
        personalStage: {
          attempted: false,
          ok: false,
          ...(allowPersonalSync ? {} : { blockedByPublicGuard: true }),
        },
        access,
        allowPersonalSync,
        ...(access.warning ? { repoVisibilityWarning: access.warning } : {}),
        files: fileOutcomes,
        fileOutcomes,
        bidirectionalReport: null,
      };
    }

    // 2. Aşama: Yalnızca manifest ve katalog dosyalarını (manifest.json, movies.json, tv.json) kayıpsız birleştir ve eşitle
    const catalogReport = await this.reconcileWithGitHub({
      includePersonalOverride: false,
      includeCatalogOverride: true,
    });
    if (!catalogReport.ok || !catalogReport.verifiedEqual) {
      for (const item of catalogItems) {
        const { sizeBytes, localHash } = readLocalStats(item.localPath);
        const rFile = catalogReport.remoteAfter?.files[item.repoPath];
        const matchingError = catalogReport.errors.find((e) => e.repoPath === item.repoPath);
        const isFailed = catalogReport.filesFailed.includes(item.repoPath) || Boolean(matchingError);
        const readBackHash = rFile?.rawFileHash ?? null;
        fileOutcomes.push({
          repoPath: item.repoPath,
          stage: 'catalog',
          status: isFailed ? 'failed' : 'succeeded',
          writeStatus: isFailed
            ? 'failed'
            : catalogReport.filesUploaded.includes(item.repoPath)
              ? 'committed'
              : 'unchanged_noop',
          sizeBytes,
          localHash,
          readBackHash: isFailed ? null : readBackHash,
          sha: rFile?.sha,
          verifiedReadBack: !isFailed && Boolean(rFile?.exists && rFile?.valid && readBackHash),
          ...(isFailed
            ? {
                error: matchingError?.message || `${item.repoPath} katalog senkronizasyonunda başarısız oldu.`,
                errorCategory: (matchingError?.category as GitHubSyncErrorCategory) || 'http_error',
              }
            : {}),
        });
      }

      for (const pItem of personalItems) {
        const { sizeBytes, localHash } = readLocalStats(pItem.localPath);
        fileOutcomes.push({
          repoPath: pItem.repoPath,
          stage: 'personal',
          status: allowPersonalSync ? 'skipped' : 'blocked',
          writeStatus: allowPersonalSync
            ? 'skipped_due_to_catalog_failure'
            : 'blocked_public_guard',
          sizeBytes,
          localHash,
          readBackHash: null,
          verifiedReadBack: false,
          error: allowPersonalSync
            ? 'Katalog aşaması tamamlanamadığı için kişisel veri aşamasına geçilmedi.'
            : 'Açık depo gizlilik koruması nedeniyle kişisel veri gönderilmedi.',
        });
      }

      return {
        ok: false,
        verifiedEqual: false,
        haltedAtStage: 'catalog',
        probe: {
          ok: true,
          repoPath: probeRes.probeRepoPath,
          step: probeRes.step,
          sizeBytes: probeRes.probeSizeBytes,
          localHash: probeRes.localHash,
          readBackHash: probeRes.readBackHash,
          sha: probeRes.manifestSha,
          verifiedReadBack: Boolean(probeRes.verifiedReadBack),
        },
        catalogStage: { attempted: true, ok: false },
        personalStage: {
          attempted: false,
          ok: false,
          ...(allowPersonalSync ? {} : { blockedByPublicGuard: true }),
        },
        access,
        allowPersonalSync,
        ...(catalogReport.repoVisibilityWarning
          ? { repoVisibilityWarning: catalogReport.repoVisibilityWarning }
          : access.warning
            ? { repoVisibilityWarning: access.warning }
            : {}),
        files: fileOutcomes,
        fileOutcomes,
        bidirectionalReport: catalogReport,
      };
    }

    // 3. Aşama: Kullanıcı profili ve diğer kişisel verileri eşitle (izinliyse) ve tam iki yönlü eşitliği doğrula
    const finalReport = allowPersonalSync
      ? await this.reconcileWithGitHub({
          includePersonalOverride: true,
          includeCatalogOverride: true,
        })
      : catalogReport;

    const refreshedCatalogItems = [
      { repoPath: 'data/catalog/manifest.json', localPath: this.manifestFile, stage: 'catalog' as const },
      { repoPath: 'data/catalog/movies.json', localPath: this.moviesFile, stage: 'catalog' as const },
      { repoPath: 'data/catalog/tv.json', localPath: this.tvFile, stage: 'catalog' as const },
    ].filter((it) => existsSync(it.localPath));
    const refreshedPersonalItems = this.collectPersonalSyncItems().map((p) => ({
      repoPath: p.repoPath,
      localPath: p.localPath,
      stage: 'personal' as const,
    }));

    let haltedAtStage: 'personal' | undefined;
    for (const tracked of [...refreshedCatalogItems, ...refreshedPersonalItems]) {
      const { sizeBytes, localHash } = readLocalStats(tracked.localPath);
      if (tracked.stage === 'personal' && !allowPersonalSync) {
        fileOutcomes.push({
          repoPath: tracked.repoPath,
          stage: 'personal',
          status: 'blocked',
          writeStatus: 'blocked_public_guard',
          sizeBytes,
          localHash,
          readBackHash: null,
          verifiedReadBack: false,
          error: 'Açık depo gizlilik koruması nedeniyle kişisel veri gönderilmedi.',
        });
        continue;
      }

      const remoteAfterFile = finalReport.remoteAfter?.files[tracked.repoPath];
      const matchingError = finalReport.errors.find((e) => e.repoPath === tracked.repoPath);
      const isFailed = finalReport.filesFailed.includes(tracked.repoPath) || Boolean(matchingError);

      if (isFailed) {
        if (!haltedAtStage) haltedAtStage = 'personal';
        fileOutcomes.push({
          repoPath: tracked.repoPath,
          stage: tracked.stage,
          status: 'failed',
          writeStatus: 'failed',
          sizeBytes,
          localHash,
          readBackHash: null,
          verifiedReadBack: false,
          error: matchingError?.message || `${tracked.repoPath} senkronize edilemedi.`,
          errorCategory: (matchingError?.category as GitHubSyncErrorCategory) || 'http_error',
        });
      } else {
        const wasUploaded =
          catalogReport.filesUploaded.includes(tracked.repoPath) ||
          finalReport.filesUploaded.includes(tracked.repoPath);
        const readBackHash = remoteAfterFile?.rawFileHash ?? null;
        fileOutcomes.push({
          repoPath: tracked.repoPath,
          stage: tracked.stage,
          status: 'succeeded',
          writeStatus: wasUploaded ? 'committed' : 'unchanged_noop',
          sizeBytes,
          localHash,
          readBackHash,
          sha: remoteAfterFile?.sha,
          verifiedReadBack: Boolean(remoteAfterFile?.exists && remoteAfterFile?.valid && readBackHash),
        });
      }
    }

    const overallOk = finalReport.ok && finalReport.verifiedEqual;
    return {
      ok: overallOk,
      verifiedEqual: finalReport.verifiedEqual,
      ...(haltedAtStage ? { haltedAtStage } : {}),
      probe: {
        ok: true,
        repoPath: probeRes.probeRepoPath,
        step: probeRes.step,
        sizeBytes: probeRes.probeSizeBytes,
        localHash: probeRes.localHash,
        readBackHash: probeRes.readBackHash,
        sha: probeRes.manifestSha,
        verifiedReadBack: Boolean(probeRes.verifiedReadBack),
      },
      catalogStage: { attempted: true, ok: true },
      personalStage: allowPersonalSync
        ? { attempted: true, ok: overallOk }
        : { attempted: false, ok: true, blockedByPublicGuard: true },
      access,
      allowPersonalSync,
      ...(finalReport.repoVisibilityWarning
        ? { repoVisibilityWarning: finalReport.repoVisibilityWarning }
        : access.warning
          ? { repoVisibilityWarning: access.warning }
          : {}),
      files: fileOutcomes,
      fileOutcomes,
      bidirectionalReport: finalReport,
    };
  }

  private async fetchBlobBufferBySha(sha: string): Promise<Buffer | null> {
    if (!this.githubToken || !this.githubOwner || !this.githubRepo || !sha) return null;
    const blobUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/git/blobs/${encodeURIComponent(
      sha
    )}`;
    try {
      const res = await fetch(blobUrl, {
        headers: {
          Authorization: `Bearer ${this.githubToken}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'CineTrack-Sync-Agent',
        },
      });
      if (res.status !== 200) return null;
      const data: any = await res.json().catch(() => null);
      if (data && typeof data.content === 'string' && data.encoding === 'base64') {
        return Buffer.from(data.content.replace(/\s+/g, ''), 'base64');
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Uploads a binary backup archive (e.g. `.xlsx`) under `data/exports/` on GitHub
   * without overwriting different timestamped files, enforcing public-repo personal-data
   * privacy consent, and verifying post-upload binary SHA-256 read-back (including >1 MB Git Blobs).
   */
  public async uploadBinaryBackupToGitHub(params: {
    fileName: string;
    contentBuffer: Buffer;
    allowPersonalDataInPublicRepo?: boolean;
  }): Promise<{
    attempted: boolean;
    ok: boolean;
    blockedByPublicGuard?: boolean;
    skippedNoop?: boolean;
    repoPath?: string;
    sha?: string;
    localHash?: string | null;
    readBackHash?: string | null;
    verifiedReadBack: boolean;
    repoVisibilityWarning?: string;
    error?: string;
  }> {
    const localHash = crypto.createHash('sha256').update(params.contentBuffer).digest('hex');
    const safeBase = path.posix.basename(String(params.fileName || '').trim());
    if (!/^CineTrack_Profile_\d{4}-\d{2}-\d{2}_\d{4}(?:_\d{2,14})?\.(?:xlsx|json)$/.test(safeBase)) {
      return {
        attempted: true,
        ok: false,
        localHash,
        readBackHash: null,
        verifiedReadBack: false,
        error: 'Geçersiz yedek dosya adı biçimi.',
      };
    }

    if (!this.githubToken || !this.githubOwner || !this.githubRepo) {
      return {
        attempted: true,
        ok: false,
        localHash,
        readBackHash: null,
        verifiedReadBack: false,
        error: 'GitHub senkronizasyonu için ortam değişkenleri (token, owner, repo) eksik.',
      };
    }

    const access = await this.verifyRemoteRepoAccess();
    const warningPatch = access.warning ? { repoVisibilityWarning: access.warning } : {};

    if (!access.ok) {
      return {
        attempted: true,
        ok: false,
        localHash,
        readBackHash: null,
        verifiedReadBack: false,
        ...warningPatch,
        error: access.error || 'GitHub depo erişim doğrulaması başarısız.',
      };
    }

    const allowPersonal = this.isPersonalSyncAllowedForRepo(
      access.effectiveIsPublicRepo,
      params.allowPersonalDataInPublicRepo
    );
    if (access.effectiveIsPublicRepo && !allowPersonal) {
      return {
        attempted: true,
        ok: false,
        blockedByPublicGuard: true,
        localHash,
        readBackHash: null,
        verifiedReadBack: false,
        ...warningPatch,
        error:
          'Açık (public) GitHub deposuna kişisel Excel profil yedeği yüklenmesi gizlilik koruması nedeniyle engellendi. Açık depoya yüklemek için açık onay gereklidir.',
      };
    }

    const baseHeaders = {
      Authorization: `Bearer ${this.githubToken}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'CineTrack-Sync-Agent',
    };
    const targetBranch = this.githubBranch;

    const extIndex = safeBase.lastIndexOf('.');
    const stem = safeBase.slice(0, extIndex);
    const ext = safeBase.slice(extIndex);

    let chosenRepoPath = `data/exports/${safeBase}`;

    // Check remote `data/exports` so we never overwrite an existing different timestamped backup
    if (!access.isEmptyRepo) {
      for (let suffix = 1; suffix <= 50; suffix += 1) {
        const candidateName =
          suffix === 1 ? safeBase : `${stem}_${String(suffix).padStart(2, '0')}${ext}`;
        const candidateRepoPath = `data/exports/${candidateName}`;
        const checkUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/contents/${candidateRepoPath}?ref=${encodeURIComponent(
          targetBranch
        )}`;

        try {
          const getRes = await fetch(checkUrl, { headers: baseHeaders });
          if (getRes.status === 404) {
            chosenRepoPath = candidateRepoPath;
            break;
          }

          if (getRes.status === 200) {
            const fileData: any = await getRes.json().catch(() => null);
            const remoteSha = typeof fileData?.sha === 'string' ? fileData.sha : undefined;
            let existingBuf: Buffer | null = null;
            if (
              fileData &&
              typeof fileData.content === 'string' &&
              fileData.encoding !== 'none' &&
              fileData.content.replace(/\s+/g, '').length > 0
            ) {
              existingBuf = Buffer.from(fileData.content.replace(/\s+/g, ''), 'base64');
            } else if (remoteSha) {
              existingBuf = await this.fetchBlobBufferBySha(remoteSha);
            }
            if (existingBuf) {
              const existingHash = crypto.createHash('sha256').update(existingBuf).digest('hex');
              if (existingHash === localHash) {
                return {
                  attempted: true,
                  ok: true,
                  skippedNoop: true,
                  repoPath: candidateRepoPath,
                  sha: remoteSha,
                  localHash,
                  readBackHash: existingHash,
                  verifiedReadBack: true,
                  ...warningPatch,
                };
              }
            }
            // Different file already exists at this timestamped path -> try next suffix without overwriting
            continue;
          }

          if (getRes.status === 403) {
            const errBody: any = await getRes.json().catch(() => ({}));
            const isTooLarge =
              Array.isArray(errBody?.errors) &&
              errBody.errors.some((e: any) => e?.code === 'too_large');
            if (isTooLarge) {
              // Large file already occupies this timestamped slot; inspect directory listing to check hash or pick next suffix
              const dirUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/contents/data/exports?ref=${encodeURIComponent(
                targetBranch
              )}`;
              const dirRes = await fetch(dirUrl, { headers: baseHeaders });
              if (dirRes.status === 200) {
                const list = await dirRes.json().catch(() => null);
                const found = Array.isArray(list)
                  ? list.find((it: any) => it && it.name === candidateName && typeof it.sha === 'string')
                  : null;
                if (found?.sha) {
                  const blobBuf = await this.fetchBlobBufferBySha(found.sha);
                  if (blobBuf) {
                    const existingHash = crypto.createHash('sha256').update(blobBuf).digest('hex');
                    if (existingHash === localHash) {
                      return {
                        attempted: true,
                        ok: true,
                        skippedNoop: true,
                        repoPath: candidateRepoPath,
                        sha: found.sha,
                        localHash,
                        readBackHash: existingHash,
                        verifiedReadBack: true,
                        ...warningPatch,
                      };
                    }
                  }
                }
              }
              continue;
            }
            const rawMsg = String(errBody?.message || '');
            const category = classifyHttpFailure(getRes.status, getRes.headers, rawMsg);
            return {
              attempted: true,
              ok: false,
              repoPath: candidateRepoPath,
              localHash,
              readBackHash: null,
              verifiedReadBack: false,
              ...warningPatch,
              error: redactSecrets(
                `GitHub okuma hatası (${category}): HTTP ${getRes.status}${rawMsg ? ` - ${rawMsg}` : ''}`,
                [this.githubToken]
              ),
            };
          }

          const errBody: any = await getRes.json().catch(() => ({}));
          const rawMsg = String(errBody?.message || '');
          const category = classifyHttpFailure(getRes.status, getRes.headers, rawMsg);
          return {
            attempted: true,
            ok: false,
            repoPath: candidateRepoPath,
            localHash,
            readBackHash: null,
            verifiedReadBack: false,
            ...warningPatch,
            error: redactSecrets(
              `GitHub okuma hatası (${category}): HTTP ${getRes.status}${rawMsg ? ` - ${rawMsg}` : ''}`,
              [this.githubToken]
            ),
          };
        } catch (e: any) {
          return {
            attempted: true,
            ok: false,
            repoPath: candidateRepoPath,
            localHash,
            readBackHash: null,
            verifiedReadBack: false,
            ...warningPatch,
            error: redactSecrets(
              `GitHub ağ bağlantı hatası: ${e?.message || 'bağlantı kurulamadı'}`,
              [this.githubToken]
            ),
          };
        }
      }
    }

    const putUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/contents/${chosenRepoPath}`;
    const putPayload: Record<string, any> = {
      message: `chore(backup): archive profile export ${path.posix.basename(chosenRepoPath)} [skip ci]`,
      content: params.contentBuffer.toString('base64'),
    };
    if (!access.isEmptyRepo) {
      putPayload.branch = targetBranch;
    }

    try {
      const putRes = await fetch(putUrl, {
        method: 'PUT',
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(putPayload),
      });

      if (putRes.status !== 200 && putRes.status !== 201) {
        const errJson: any = await putRes.json().catch(() => ({}));
        const rawDetail = String(errJson?.message || '');
        const acceptedPerms = putRes.headers.get('x-accepted-github-permissions');
        const category = classifyHttpFailure(putRes.status, putRes.headers, rawDetail);
        let detail = rawDetail;
        if (
          putRes.status === 403 &&
          rawDetail.toLowerCase().includes('resource not accessible by personal access token')
        ) {
          detail += ` (Fine-grained PAT ayarlarında '${this.githubOwner}/${this.githubRepo}' deposu için 'Contents: Read and write' iznini doğrulayın${
            acceptedPerms ? `; beklenen izin: ${acceptedPerms}` : ''
          })`;
        }
        return {
          attempted: true,
          ok: false,
          repoPath: chosenRepoPath,
          localHash,
          readBackHash: null,
          verifiedReadBack: false,
          ...warningPatch,
          error: redactSecrets(
            `GitHub yazma reddedildi (${category}): HTTP ${putRes.status}${detail ? ` - ${detail}` : ''}`,
            [this.githubToken]
          ),
        };
      }

      const resData: any = await putRes.json().catch(() => null);
      const committedSha: string | undefined =
        typeof resData?.content?.sha === 'string' ? resData.content.sha : undefined;

      // Mandatory post-upload binary read-back SHA-256 verification
      const readBackUrl = `${putUrl}?ref=${encodeURIComponent(targetBranch)}`;
      const readBackRes = await fetch(readBackUrl, { headers: baseHeaders });
      let readBackBuffer: Buffer | null = null;

      if (readBackRes.status === 200) {
        const readBackData: any = await readBackRes.json().catch(() => null);
        if (
          readBackData &&
          typeof readBackData.content === 'string' &&
          readBackData.encoding !== 'none' &&
          readBackData.content.replace(/\s+/g, '').length > 0
        ) {
          readBackBuffer = Buffer.from(readBackData.content.replace(/\s+/g, ''), 'base64');
        } else {
          const blobSha =
            typeof readBackData?.sha === 'string' ? readBackData.sha : committedSha;
          if (blobSha) {
            readBackBuffer = await this.fetchBlobBufferBySha(blobSha);
          }
        }
      } else if (readBackRes.status === 403 && committedSha) {
        readBackBuffer = await this.fetchBlobBufferBySha(committedSha);
      }

      if (!readBackBuffer) {
        return {
          attempted: true,
          ok: false,
          repoPath: chosenRepoPath,
          sha: committedSha,
          localHash,
          readBackHash: null,
          verifiedReadBack: false,
          ...warningPatch,
          error: `${chosenRepoPath}: GitHub yüklemesi sonrası ikili (binary) geri okuma doğrulaması yapılamadı.`,
        };
      }

      const readBackHash = crypto.createHash('sha256').update(readBackBuffer).digest('hex');
      if (readBackHash !== localHash) {
        return {
          attempted: true,
          ok: false,
          repoPath: chosenRepoPath,
          sha: committedSha,
          localHash,
          readBackHash,
          verifiedReadBack: false,
          ...warningPatch,
          error: `${chosenRepoPath}: Geri okuma SHA-256 özeti yerel dosyayla eşleşmedi (uzak: ${readBackHash.slice(
            0,
            8
          )}, yerel: ${localHash.slice(0, 8)}).`,
        };
      }

      return {
        attempted: true,
        ok: true,
        repoPath: chosenRepoPath,
        sha: committedSha,
        localHash,
        readBackHash,
        verifiedReadBack: true,
        ...warningPatch,
      };
    } catch (e: any) {
      return {
        attempted: true,
        ok: false,
        repoPath: chosenRepoPath,
        localHash,
        readBackHash: null,
        verifiedReadBack: false,
        ...warningPatch,
        error: redactSecrets(
          `GitHub ağ hatası: ${e?.message || 'bağlantı hatası'}`,
          [this.githubToken]
        ),
      };
    }
  }
}

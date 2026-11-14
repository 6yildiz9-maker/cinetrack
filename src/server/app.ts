import crypto from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
  dedupeItems,
  normalizeDeletedKeys,
  normalizeFavoriteActors,
  normalizePreferences,
  normalizeSavedItem,
  type DataDocument,
  type Profile,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import { createDataStorage, countTotalItems, type StorageOptions } from './storage.ts';
import { brandProfileFileName } from '../shared/brand.ts';
import {
  createContentSecurityPolicy,
  createOriginMiddleware,
  createTmdbRateLimitMiddleware,
  createTokenAuthMiddleware,
  isLoopbackHostname,
  type SecurityOptions,
} from './security.ts';
import { createTmdbProxyService, type TmdbProxyServiceOptions } from './tmdb-proxy.ts';
import {
  PersistentDataStore,
  redactSecrets,
  type GitHubTokenCandidateInfo,
  type TokenSourceKind,
} from './persistent-store.ts';
import { CorruptJsonFileError } from './atomic-json.ts';
import { DEFAULT_MAX_DATA_BYTES, formatMaxDataLimitMb } from '../core/limits.ts';

/** SQLite arşivi yüklemesi: gövde diske akıtılır, bellekte tamponlanmaz (SEC-01). */
export const MAX_SQLITE_ARCHIVE_UPLOAD_BYTES = 256 * 1024 * 1024;

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function streamRequestBodyToFile(
  req: Request,
  filePath: string,
  maxBytes: number
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let total = 0;
    let settled = false;
    const out = createWriteStream(filePath, { mode: 0o600 });

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      out.destroy();
      reject(error);
    };

    out.on('error', fail);
    req.on('error', fail);

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        req.unpipe?.();
        req.destroy();
        fail(Object.assign(new Error('archive_too_large'), { code: 'archive_too_large' }));
        return;
      }
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });

    req.on('end', () => {
      if (settled) return;
      out.end(() => {
        settled = true;
        resolve(total);
      });
    });
  });
}
import {
  executeProfileBackupExport,
  buildProfileBackupDataset,
  EXPORT_FILE_NAME_PATTERN,
  getPosterCacheStatsAsync,
} from './excel-profile-backup.ts';
import { createTasteRouter } from './taste-routes.ts';
import { runHybridMerge } from './hybrid-merge.ts';
import {
  isSqliteArchiveAvailable,
  readSqliteArchive,
  restoreArchivePostersToCache,
  writeSqliteArchive,
  SqliteArchiveValidationError,
  SqliteUnavailableError,
  MAX_ARCHIVE_POSTERS,
  SQLITE_ARCHIVE_SCHEMA_VERSION,
  type ArchiveSnapshot,
} from './sqlite-archive.ts';

export interface CineTrackAppOptions extends StorageOptions, SecurityOptions, TmdbProxyServiceOptions {
  dataDir?: string;
  persistentStore?: PersistentDataStore;
  security?: SecurityOptions;
  devMode?: boolean;
  maxDataBytes?: number;
  githubToken?: string;
  githubTokenSource?: TokenSourceKind;
  githubTokenCandidates?: GitHubTokenCandidateInfo[];
  getLiveGitHubTokenCandidates?: () => GitHubTokenCandidateInfo[];
  onAuthFailureRefreshToken?: (
    failedToken: string
  ) => Promise<{ token: string; source?: TokenSourceKind } | string | null>;
  onLocalDataMutated?: (reason: string) => void;
  githubOwner?: string;
  githubRepo?: string;
  githubBranch?: string;
  isPublicRepo?: boolean;
  allowPublicPersonalSync?: boolean;
  allowPublicCatalogSync?: boolean;
  processEnvIsPublicRepo?: string | null;
  localEnvIsPublicRepo?: string | null;
  registerCustomRoutes?: (app: Express) => void;
}

const STATIC_ASSET_EXT_PATTERN =
  /\.(?:js|mjs|cjs|css|map|png|jpg|jpeg|gif|svg|ico|webp|avif|woff|woff2|ttf|otf|eot|json|webmanifest|txt|xml|xlsx|wasm)$/i;

export function isStaticAssetRequestPath(reqPath: string): boolean {
  const cleanPath = String(reqPath || '').split('?')[0];
  if (cleanPath.startsWith('/assets/') || cleanPath.startsWith('/workbox-')) {
    return true;
  }
  return STATIC_ASSET_EXT_PATTERN.test(cleanPath);
}

export function createSpaFallbackMiddleware(indexHtmlPath: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api/')) {
      next();
      return;
    }
    if (isStaticAssetRequestPath(req.path)) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).type('text/plain; charset=utf-8').send('Static asset not found');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtmlPath);
  };
}

interface ParsedWritePrecondition {
  expectedRevision: number | null;
  hasInvalidIfMatch: boolean;
  forceOverwrite: boolean;
}

function parseWritePrecondition(req: Request): ParsedWritePrecondition {
  const forceHeader = req.headers['x-cinetrack-force-write'];
  let forceOverwrite =
    forceHeader === '1' ||
    forceHeader === 'true' ||
    Boolean(req.body && typeof req.body === 'object' && req.body.forceOverwrite === true);

  const ifMatch = req.headers['if-match'];
  if (typeof ifMatch === 'string' && ifMatch.trim()) {
    const rawTrimmed = ifMatch.trim();
    if (rawTrimmed === '*') {
      forceOverwrite = true;
      return { expectedRevision: null, hasInvalidIfMatch: false, forceOverwrite };
    }
    const cleaned = rawTrimmed.replace(/^W\//i, '').replace(/^"|"$/g, '');
    const revMatch = cleaned.match(/^(?:rev-)?(\d+)$/);
    if (revMatch) {
      return { expectedRevision: Number(revMatch[1]), hasInvalidIfMatch: false, forceOverwrite };
    }
    return { expectedRevision: null, hasInvalidIfMatch: true, forceOverwrite };
  }

  const headerRev = req.headers['x-cinetrack-base-revision'];
  if (typeof headerRev === 'string' && headerRev.trim()) {
    if (/^\d+$/.test(headerRev.trim())) {
      return { expectedRevision: Number(headerRev.trim()), hasInvalidIfMatch: false, forceOverwrite };
    }
    return { expectedRevision: null, hasInvalidIfMatch: true, forceOverwrite };
  }

  if (req.body && typeof req.body === 'object' && typeof req.body.baseRevision === 'number') {
    if (Number.isSafeInteger(req.body.baseRevision) && req.body.baseRevision >= 0) {
      return { expectedRevision: req.body.baseRevision, hasInvalidIfMatch: false, forceOverwrite };
    }
  }

  return { expectedRevision: null, hasInvalidIfMatch: false, forceOverwrite };
}

function isBulkDeleteConfirmed(req: Request): boolean {
  const headerVal = req.headers['x-cinetrack-confirm-drop'];
  if (headerVal === '1' || headerVal === 'true') return true;
  if (req.body && typeof req.body === 'object' && req.body.confirmBulkDelete === true) return true;
  return false;
}

function parseMergeWriteOptions(req: Request): {
  mergeStrategy?: 'lossless';
  foldUnhydratedDefaultProfile: boolean;
} {
  const mergeHeader = String(req.headers['x-cinetrack-merge'] || '').trim().toLowerCase();
  const isLossless =
    mergeHeader === '1' ||
    mergeHeader === 'true' ||
    mergeHeader === 'lossless' ||
    Boolean(req.body && typeof req.body === 'object' && req.body.mergeStrategy === 'lossless');

  const foldHeader = String(req.headers['x-cinetrack-unhydrated-default'] || '')
    .trim()
    .toLowerCase();
  const foldUnhydratedDefaultProfile =
    foldHeader === '1' ||
    foldHeader === 'true' ||
    Boolean(
      req.body &&
        typeof req.body === 'object' &&
        req.body.foldUnhydratedDefaultProfile === true
    );

  return {
    ...(isLossless ? { mergeStrategy: 'lossless' } : {}),
    foldUnhydratedDefaultProfile,
  };
}

async function computeFileSha256Async(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function streamFileDownload(
  res: Response,
  filePath: string,
  headers: Record<string, string>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    for (const [k, v] of Object.entries(headers)) {
      res.setHeader(k, v);
    }
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    res.on('finish', resolve);
    res.on('close', resolve);
    stream.pipe(res);
  });
}

/**
 * Merges an incoming client `profileSnapshot` with persistent server storage non-destructively.
 * Uses a strict `Profile` field whitelist (BUG-08) and supports explicit `disliked: []` clearing (EXT-12).
 */
export function resolveExportDocument(storedDoc: DataDocument, reqBody: any): DataDocument {
  if (!reqBody?.profileSnapshot || typeof reqBody.profileSnapshot !== 'object') {
    return storedDoc;
  }

  const snap = reqBody.profileSnapshot;
  const snapId =
    typeof snap.id === 'string' && snap.id.trim()
      ? snap.id.trim()
      : storedDoc.activeProfileId;

  const snapItemsRaw = Array.isArray(snap.items) ? snap.items : [];
  const snapItems = dedupeItems(
    snapItemsRaw.map((it: any) => normalizeSavedItem(it)).filter(Boolean) as SavedItem[]
  );
  const snapPrefs = normalizePreferences(snap.preferences || {});
  const snapFavActors = normalizeFavoriteActors(snap.favoriteActors || []);
  const snapDeletedKeys = normalizeDeletedKeys(snap.deleted_keys);

  const existing = storedDoc.profiles.find((p) => p.id === snapId);
  if (!existing) {
    const serverHasData = storedDoc.profiles.some(
      (p) => (p.items?.length || 0) > 0 || (p.preferences?.disliked?.length || 0) > 0
    );
    if (snapItems.length === 0 && snapPrefs.disliked.length === 0 && serverHasData) {
      return storedDoc;
    }
    const createdProfile: Profile = {
      id: snapId,
      name: typeof snap.name === 'string' && snap.name.trim() ? snap.name.trim() : 'Profilim',
      createdAt: typeof snap.createdAt === 'string' ? snap.createdAt : '',
      preferences: snapPrefs,
      items: snapItems,
      favoriteActors: snapFavActors,
      isDemo: Boolean(snap.isDemo),
      ...(Object.keys(snapDeletedKeys).length > 0 ? { deleted_keys: snapDeletedKeys } : {}),
    };
    return {
      ...storedDoc,
      activeProfileId: snapId,
      profiles: [...storedDoc.profiles, createdProfile],
    };
  }

  const existingItems = Array.isArray(existing.items) ? existing.items : [];
  const mergedItems =
    snapItems.length >= existingItems.length
      ? snapItems
      : snapItems.length === 0
        ? existingItems
        : dedupeItems([...existingItems, ...snapItems]);

  const existingFavs = normalizeFavoriteActors(existing.favoriteActors || []);
  const mergedFavActors =
    snap.favoriteActorsCleared === true
      ? snapFavActors
      : snapFavActors.length > 0
        ? snapFavActors.length >= existingFavs.length
          ? snapFavActors
          : normalizeFavoriteActors([...existingFavs, ...snapFavActors])
        : existingFavs;

  const existingPrefs = normalizePreferences(existing.preferences || {});
  const snapHasExplicitDisliked = Boolean(
    snap.preferences &&
      typeof snap.preferences === 'object' &&
      Object.prototype.hasOwnProperty.call(snap.preferences, 'disliked') &&
      Array.isArray(snap.preferences.disliked)
  );
  const mergedPreferences = {
    ...existingPrefs,
    ...snapPrefs,
    disliked: snapHasExplicitDisliked ? snapPrefs.disliked : existingPrefs.disliked,
  };

  const mergedDeletedKeys = normalizeDeletedKeys({
    ...(existing.deleted_keys || {}),
    ...snapDeletedKeys,
  });

  const mergedProfile: Profile = {
    id: snapId,
    name: typeof snap.name === 'string' && snap.name.trim() ? snap.name.trim() : existing.name,
    createdAt: existing.createdAt || (typeof snap.createdAt === 'string' ? snap.createdAt : ''),
    isDemo: typeof snap.isDemo === 'boolean' ? snap.isDemo : Boolean(existing.isDemo),
    items: mergedItems,
    favoriteActors: mergedFavActors,
    preferences: mergedPreferences,
    ...(Object.keys(mergedDeletedKeys).length > 0 ? { deleted_keys: mergedDeletedKeys } : {}),
  };

  return {
    ...storedDoc,
    activeProfileId: snapId,
    profiles: storedDoc.profiles.map((p) => (p.id === snapId ? mergedProfile : p)),
  };
}

export function createCineTrackApp(options: CineTrackAppOptions): {
  app: Express;
  storage: ReturnType<typeof createDataStorage>;
  tmdbProxy: ReturnType<typeof createTmdbProxyService>;
  persistentStore: PersistentDataStore;
} {
  const resolvedDataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'data'));
  const maxDataBytes = options.maxDataBytes ?? DEFAULT_MAX_DATA_BYTES;
  const storage = createDataStorage({ ...options, dataDir: resolvedDataDir, maxDataBytes });
  const tmdbProxy = createTmdbProxyService(options);
  const persistentStore =
    options.persistentStore ??
    new PersistentDataStore({
      dataDir: resolvedDataDir,
      maxDataBytes,
      githubToken: options.githubToken,
      githubTokenSource: options.githubTokenSource,
      githubTokenCandidates: options.githubTokenCandidates,
      getLiveGitHubTokenCandidates: options.getLiveGitHubTokenCandidates,
      onAuthFailureRefreshToken: options.onAuthFailureRefreshToken,
      githubOwner: options.githubOwner,
      githubRepo: options.githubRepo,
      githubBranch: options.githubBranch,
      isPublicRepo: options.isPublicRepo,
      allowPublicPersonalSync: options.allowPublicPersonalSync,
      allowPublicCatalogSync: options.allowPublicCatalogSync,
      processEnvIsPublicRepo: options.processEnvIsPublicRepo,
      localEnvIsPublicRepo: options.localEnvIsPublicRepo,
    });
  persistentStore.attachDataStorage(storage, maxDataBytes);

  const notifyLocalMutation = (reason: string) => {
    try {
      options.onLocalDataMutated?.(reason);
    } catch {
      // arka plan bildirim hatası HTTP yanıtını etkilememeli
    }
  };

  const sec: SecurityOptions = { ...options, ...(options.security || {}) };
  const originGuard = createOriginMiddleware(sec);
  const tokenGuard = createTokenAuthMiddleware(sec);
  const syncStatusGuard = createTokenAuthMiddleware({ ...sec, requireTokenForReads: true });
  // Yerel masaüstü kullanımında okumalar açık kalır; sunucu loopback dışına
  // bağlandığında kişisel veri GET'leri de token ister.
  const personalReadGuard = createTokenAuthMiddleware({
    ...sec,
    requireTokenForReads: !isLoopbackHostname((sec.bindHost ?? '127.0.0.1').trim() || '127.0.0.1'),
  });
  const tmdbRateLimiter = createTmdbRateLimitMiddleware(sec);

  const app = express();
  app.disable('x-powered-by');
  if (sec.trustProxy) {
    app.set('trust proxy', true);
  }

  // Temel güvenlik başlıkları (BUG-12.1)
  const contentSecurityPolicy = createContentSecurityPolicy({
    allowInlineScripts: Boolean(options.devMode),
  });
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', contentSecurityPolicy);
    if (!process.env.APP_URL) {
      res.setHeader('X-Frame-Options', 'DENY');
    }
    next();
  });

  // SEC-01: /api mutasyonları gövde ayrıştırılmadan önce kaynak + token doğrulamasından
  // geçer. Böylece yetkisiz bir istek büyük gövdeyle belleği şişiremez.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase())) {
      next();
      return;
    }
    originGuard(req, res, () => tokenGuard(req, res, next));
  });

  app.use(
    express.json({
      limit: maxDataBytes,
      verify: (_req, _res, buf) => {
        if (buf.byteLength > maxDataBytes) {
          const err: any = new Error('Payload too large');
          err.status = 413;
          err.type = 'entity.too.large';
          throw err;
        }
      },
    })
  );

  // Standardized body-parser error handling (413 Payload Too Large & 400 Invalid JSON)
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (!err) {
      next();
      return;
    }
    if (err.type === 'entity.too.large' || err.status === 413) {
      res.status(413).json({
        status_message: `Gönderilen veri boyutu izin verilen sınırı (${formatMaxDataLimitMb(maxDataBytes)}) aşıyor.`,
        code: 'payload_too_large',
      });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({
        status_message: 'Gönderilen JSON gövdesi ayrıştırılamadı.',
        code: 'invalid_json',
      });
      return;
    }
    next(err);
  });

  app.get('/api/health', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const posterCache = await getPosterCacheStatsAsync(path.join(resolvedDataDir, 'cache', 'posters'));
    res.json({ ok: true, posterCache });
  });

  // === SQLite arşivi: profil + stok + stok görsellerinin tek dosyalık tam yedeği ===
  app.get('/api/archive/sqlite/status', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      available: await isSqliteArchiveAvailable(),
      schemaVersion: SQLITE_ARCHIVE_SCHEMA_VERSION,
      maxPosters: MAX_ARCHIVE_POSTERS,
    });
  });

  app.post('/api/archive/sqlite', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const snapshot = req.body as ArchiveSnapshot;
      const archiveDir = path.join(resolvedDataDir, 'archives');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `cinetrack-archive-${stamp}.sqlite`;
      const filePath = path.join(archiveDir, fileName);
      const result = await writeSqliteArchive(snapshot, filePath);
      res.setHeader('Content-Type', 'application/vnd.sqlite3');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader(
        'X-Archive-Stats',
        JSON.stringify({
          profiles: result.profiles,
          items: result.items,
          tasteMaps: result.tasteMaps,
          stockMovies: result.stockMovies,
          stockTv: result.stockTv,
          postersStored: result.postersStored,
          postersFailed: result.postersFailed,
          posterBytes: result.posterBytes,
          byteLength: result.byteLength,
        })
      );
      res.sendFile(filePath);
    } catch (error: any) {
      if (error instanceof SqliteUnavailableError) {
        res.status(501).json({ status_message: error.message, code: 'sqlite_unavailable' });
        return;
      }
      if (error instanceof SqliteArchiveValidationError) {
        res.status(400).json({ status_message: error.message, code: 'invalid_archive_snapshot' });
        return;
      }
      res.status(500).json({
        status_message: `SQLite arşivi oluşturulamadı: ${redactSecrets(error?.message || String(error), persistentStore.getKnownSecretsForRedaction())}`,
        code: 'archive_write_failed',
      });
    }
  });

  let archiveRestoreInFlight = false;
  app.post(
    '/api/archive/sqlite/restore',
    originGuard,
    tokenGuard,
    async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const contentType = String(req.headers['content-type'] || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      const acceptedTypes = new Set([
        'application/octet-stream',
        'application/vnd.sqlite3',
        'application/x-sqlite3',
      ]);
      if (!acceptedTypes.has(contentType)) {
        res.status(415).json({
          status_message: 'SQLite arşivi application/octet-stream olarak gönderilmeli.',
          code: 'unsupported_media_type',
        });
        return;
      }

      const declaredBytes = Number(req.headers['content-length'] || 0);
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_SQLITE_ARCHIVE_UPLOAD_BYTES) {
        res.status(413).json({
          status_message: `Arşiv dosyası en fazla ${formatMegabytes(MAX_SQLITE_ARCHIVE_UPLOAD_BYTES)} olabilir.`,
          code: 'archive_too_large',
        });
        return;
      }

      if (archiveRestoreInFlight) {
        res.status(409).json({
          status_message: 'Başka bir arşiv geri yüklemesi sürüyor; bitmesini bekleyin.',
          code: 'archive_restore_busy',
        });
        return;
      }

      const archiveDir = path.join(resolvedDataDir, 'archives');
      const tempPath = path.join(archiveDir, `restore-${process.pid}-${Date.now()}.sqlite`);
      archiveRestoreInFlight = true;
      try {
        await fsPromises.mkdir(archiveDir, { recursive: true });
        // Gövde RAM'e alınmaz; doğrudan diske akıtılır ve boyut sınırı akış sırasında uygulanır.
        await streamRequestBodyToFile(req, tempPath, MAX_SQLITE_ARCHIVE_UPLOAD_BYTES);

        const headerHandle = await fsPromises.open(tempPath, 'r');
        const signature = Buffer.alloc(16);
        try {
          await headerHandle.read(signature, 0, 16, 0);
        } finally {
          await headerHandle.close();
        }
        if (signature.toString('utf8') !== 'SQLite format 3\u0000') {
          res.status(400).json({
            status_message: 'Gönderilen dosya geçerli bir SQLite arşivi değil.',
            code: 'invalid_archive_file',
          });
          return;
        }

        const archive = await readSqliteArchive(tempPath);

        const saved = await storage.saveDataSerialized(archive.dataDocument, {
          forceOverwrite: true,
          confirmBulkDelete: true,
          requirePrecondition: false,
        });
        if (!saved.ok) {
          res.status(saved.status).json({ status_message: saved.message, code: saved.code });
          return;
        }

        // DATA-02: yazılan belge gerçekten arşivdeki profilleri/kayıtları taşıyor mu?
        const writtenProfiles = Array.isArray(saved.document?.profiles) ? saved.document.profiles : [];
        const writtenItems = countTotalItems(saved.document);
        if (
          writtenProfiles.length !== archive.counts.profiles ||
          writtenItems !== archive.counts.items
        ) {
          res.status(500).json({
            status_message:
              'Arşiv yazıldı ancak doğrulama başarısız: profil/kayıt sayıları arşivle eşleşmiyor.',
            code: 'archive_restore_verification_failed',
          });
          return;
        }

        const posters = await restoreArchivePostersToCache(
          archive.posters,
          path.join(resolvedDataDir, 'cache', 'posters')
        );

        notifyLocalMutation('sqlite-archive-restore');
        res.json({
          ok: true,
          counts: archive.counts,
          postersWritten: posters.written,
          postersSkipped: posters.skipped,
          dataDocument: saved.document,
          tasteMaps: archive.tasteMaps,
          stock: archive.stock,
          createdAt: archive.createdAt,
        });
      } catch (error: any) {
        if (error?.code === 'archive_too_large') {
          res.status(413).json({
            status_message: `Arşiv dosyası en fazla ${formatMegabytes(MAX_SQLITE_ARCHIVE_UPLOAD_BYTES)} olabilir.`,
            code: 'archive_too_large',
          });
          return;
        }
        if (error instanceof SqliteUnavailableError) {
          res.status(501).json({ status_message: error.message, code: 'sqlite_unavailable' });
          return;
        }
        if (error instanceof SqliteArchiveValidationError) {
          res.status(400).json({ status_message: error.message, code: 'invalid_archive_file' });
          return;
        }
        res.status(500).json({
          status_message: `SQLite arşivi geri yüklenemedi: ${redactSecrets(error?.message || String(error), persistentStore.getKnownSecretsForRedaction())}`,
          code: 'archive_restore_failed',
        });
      } finally {
        archiveRestoreInFlight = false;
        try {
          await fsPromises.rm(tempPath, { force: true });
        } catch {
          // yoksay
        }
      }
    }
  );

  app.get('/api/tmdb-status', tmdbProxy.handleStatus);
  app.get('/api/tmdb', tmdbRateLimiter, tmdbProxy.handleTmdb);
  app.get('/api/tmdb-image', tmdbRateLimiter, tmdbProxy.handleTmdbImage);

  app.get('/api/data', personalReadGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const doc = await storage.readDataAsync();
    if (storage.hasUnrecoverableCorruption()) {
      res.status(500).json({
        status_message:
          'Mevcut veri dosyası bozuk ve kurtarılabilecek geçerli bir yedek bulunamadı. Veri kaybını önlemek için lütfen sunucu dosyalarını kontrol edin.',
        code: 'corrupt_storage',
      });
      return;
    }
    const rev = doc.revision ?? 0;
    res.setHeader('ETag', `"rev-${rev}"`);
    res.json(doc);
  });

  app.put('/api/data', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { expectedRevision, hasInvalidIfMatch, forceOverwrite } = parseWritePrecondition(req);
      const confirmBulkDelete = isBulkDeleteConfirmed(req);
      const { mergeStrategy, foldUnhydratedDefaultProfile } = parseMergeWriteOptions(req);
      const result = await storage.saveDataSerialized(req.body, {
        expectedRevision,
        hasInvalidIfMatch,
        requirePrecondition: true,
        forceOverwrite,
        confirmBulkDelete,
        mergeStrategy,
        foldUnhydratedDefaultProfile,
      });

      if (!result.ok) {
        if (result.currentRevision !== undefined) {
          res.setHeader('ETag', `"rev-${result.currentRevision}"`);
        }
        res.status(result.status).json({
          status_message: result.message,
          code: result.code,
          currentRevision: result.currentRevision,
          expectedRevision: result.expectedRevision,
          existingItems: result.existingItems,
          incomingItems: result.incomingItems,
          serverDocument: result.serverDocument,
        });
        return;
      }

      const rev = result.document.revision ?? 1;
      res.setHeader('ETag', `"rev-${rev}"`);
      res.json({
        ok: true,
        revision: rev,
        updatedAt: result.document.updatedAt,
        profiles: result.document.profiles.length,
        items: result.totalItems,
        ...(mergeStrategy === 'lossless'
          ? {
              merged: Boolean(result.merged),
              document: result.document,
            }
          : {}),
      });
      notifyLocalMutation('user-data-save');
    } catch (error: any) {
      if (error instanceof CorruptJsonFileError) {
        res.status(500).json({ status_message: error.message, code: error.code });
        return;
      }
      console.error('Veri kaydedilemedi:', error?.message || error);
      res.status(500).json({ status_message: 'Veri dosyasına yazılamadı.', code: 'storage_write_failed' });
    }
  });

  app.get('/api/isolated/profile', personalReadGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await storage.readIsolatedProfileAsync());
  });

  app.get('/api/isolated/user-lists', personalReadGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await storage.readIsolatedUserListsAsync());
  });

  app.get('/api/data/backups', personalReadGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ backups: await storage.listBackupsAsync() });
  });

  app.post('/api/data/backup-now', originGuard, tokenGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await storage.createSafetySnapshotSerialized();
      const backups = await storage.listBackupsAsync();
      res.json({ ok: true, message: 'Yedek anlık görüntüsü başarıyla alındı.', backups });
    } catch (err: any) {
      res.status(500).json({ ok: false, status_message: err?.message || 'Yedek alınamadı.' });
    }
  });

  app.post('/api/data/restore', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const backupId = typeof req.body?.backupId === 'string' ? req.body.backupId.trim() : '';
    if (!backupId) {
      res.status(400).json({ status_message: 'Geri yüklenecek yedek kimliği (backupId) gerekli.', code: 'missing_backup_id' });
      return;
    }

    const restored = await storage.restoreBackupSerialized(backupId);
    if (!restored) {
      res.status(404).json({ status_message: 'Belirtilen yedek dosyası bulunamadı veya bozuk.', code: 'backup_not_found' });
      return;
    }

    const rev = restored.revision ?? 1;
    res.setHeader('ETag', `"rev-${rev}"`);
    res.json({
      ok: true,
      revision: rev,
      updatedAt: restored.updatedAt,
      profiles: restored.profiles.length,
      items: countTotalItems(restored),
      document: restored,
    });
    notifyLocalMutation('backup-restore');
  });

  // --- Kalıcı Veri Deposu & Çift Yönlü GitHub Senkronizasyonu ---

  app.get('/api/stock', tokenGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const snapshot = persistentStore.readStockSnapshot();
    if (!snapshot) {
      res.json({ ok: true, exists: false, movies: [], tv: [], total: 0, updatedAt: '' });
      return;
    }
    res.json({
      ok: true,
      exists: true,
      schemaVersion: snapshot.schemaVersion,
      updatedAt: snapshot.updatedAt,
      movies: snapshot.movies,
      tv: snapshot.tv,
      total: snapshot.movies.length + snapshot.tv.length,
    });
  });

  app.post('/api/stock/upload', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const movies = req.body?.movies;
    const tv = req.body?.tv;
    if (movies !== undefined && !Array.isArray(movies)) {
      res.status(400).json({ ok: false, status_message: "'movies' alanı dizi olmalı.", code: 'invalid_stock_payload' });
      return;
    }
    if (tv !== undefined && !Array.isArray(tv)) {
      res.status(400).json({ ok: false, status_message: "'tv' alanı dizi olmalı.", code: 'invalid_stock_payload' });
      return;
    }
    if (movies === undefined && tv === undefined) {
      res.status(400).json({ ok: false, status_message: 'movies veya tv alanlarından en az biri gönderilmeli.', code: 'invalid_stock_payload' });
      return;
    }
    try {
      const result = await persistentStore.saveStockSnapshotUpload({ movies, tv });
      res.json(result);
      notifyLocalMutation('stock-upload');
    } catch (err: any) {
      res.status(500).json({ ok: false, status_message: err?.message || 'Stok anlık görüntüsü kaydedilemedi.' });
    }
  });

  app.get('/api/cinema-kunye', personalReadGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const doc = await persistentStore.readCinemaKunyeAsync();
      if (!doc) {
        res.json({
          ok: true,
          exists: false,
          schemaVersion: 1,
          updatedAt: '',
          entries: {},
          entriesCount: 0,
        });
        return;
      }
      res.json({
        ok: true,
        exists: true,
        schemaVersion: doc.schemaVersion,
        updatedAt: doc.updatedAt,
        entries: doc.entries,
        entriesCount: Object.keys(doc.entries).length,
        cinemaKunye: doc,
      });
    } catch (err: any) {
      res.status(500).json({
        ok: false,
        status_message: err?.message || 'Sinema künyesi okunamadı.',
      });
    }
  });

  app.post('/api/cinema-kunye', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({
        ok: false,
        status_message: 'Geçerli bir Sinema Künyesi nesnesi gönderilmelidir.',
        code: 'invalid_cinema_kunye_payload',
      });
      return;
    }
    const mode: 'merge' | 'overwrite' = req.body?.mode === 'overwrite' ? 'overwrite' : 'merge';
    const rawDoc =
      req.body?.cinemaKunye && typeof req.body.cinemaKunye === 'object'
        ? req.body.cinemaKunye
        : req.body?.document && typeof req.body.document === 'object'
          ? req.body.document
          : req.body;
    try {
      const saved = await persistentStore.saveCinemaKunyeSerialized(rawDoc, { mode });
      res.json({
        ok: true,
        mode,
        merged: saved.merged,
        entriesCount: saved.entriesCount,
        document: saved.document,
      });
      notifyLocalMutation('cinema-kunye-save');
    } catch (err: any) {
      res.status(500).json({
        ok: false,
        status_message: err?.message || 'Sinema künyesi kaydedilemedi.',
      });
    }
  });

  app.get('/api/sync/status', syncStatusGuard, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(persistentStore.getSyncStatus());
  });

  app.post('/api/sync/inspect', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.body?.rejectIfBusy === true && persistentStore.isSyncBusy()) {
      res.status(409).json({
        ok: false,
        operation: 'inspect',
        code: 'sync_in_progress',
        verifiedEqual: false,
        errors: [
          {
            category: 'sync_in_progress',
            message: 'Başka bir GitHub senkronizasyon işlemi devam ediyor.',
          },
        ],
      });
      return;
    }
    try {
      const report = await persistentStore.inspectGitHub();
      res.json(report);
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        operation: 'inspect',
        verifiedEqual: false,
        errors: [
          {
            category: 'http_error',
            message: redactSecrets(e?.message || 'GitHub durum denetimi başarısız oldu.', [
              options.githubToken,
            ]),
          },
        ],
      });
    }
  });

  app.post('/api/sync/pull', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.body?.rejectIfBusy === true && persistentStore.isSyncBusy()) {
      res.status(409).json({
        ok: false,
        operation: 'pull',
        code: 'sync_in_progress',
        verifiedEqual: false,
        errors: [
          {
            category: 'sync_in_progress',
            message: 'Başka bir GitHub senkronizasyon işlemi devam ediyor.',
          },
        ],
      });
      return;
    }
    try {
      const rawStrategy = req.body?.conflictStrategy;
      const conflictStrategy: 'ask' | 'merge' | 'overwrite_with_remote' =
        rawStrategy === 'merge' || rawStrategy === 'overwrite_with_remote' ? rawStrategy : 'ask';
      const report = await persistentStore.pullFromGitHub({ conflictStrategy });
      if (typeof report.serverRevision === 'number') {
        res.setHeader('ETag', `"rev-${report.serverRevision}"`);
      }
      res.json(report);
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        operation: 'pull',
        verifiedEqual: false,
        errors: [
          {
            category: 'http_error',
            message: redactSecrets(e?.message || 'GitHub indirme işlemi başarısız oldu.', [
              options.githubToken,
            ]),
          },
        ],
      });
    }
  });

  app.post('/api/sync/push', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.body?.rejectIfBusy === true && persistentStore.isSyncBusy()) {
      res.status(409).json({
        ok: false,
        operation: 'push',
        code: 'sync_in_progress',
        verifiedEqual: false,
        errors: [
          {
            category: 'sync_in_progress',
            message: 'Başka bir GitHub senkronizasyon işlemi devam ediyor.',
          },
        ],
      });
      return;
    }
    try {
      const report = await persistentStore.pushToGitHub();
      res.json(report);
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        operation: 'push',
        verifiedEqual: false,
        errors: [
          {
            category: 'http_error',
            message: redactSecrets(e?.message || 'GitHub yükleme işlemi başarısız oldu.', [
              options.githubToken,
            ]),
          },
        ],
      });
    }
  });

  app.post('/api/sync/reconcile', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.body?.rejectIfBusy === true && persistentStore.isSyncBusy()) {
      res.status(409).json({
        ok: false,
        operation: 'reconcile',
        code: 'sync_in_progress',
        verifiedEqual: false,
        errors: [
          {
            category: 'sync_in_progress',
            message: 'Başka bir GitHub senkronizasyon işlemi devam ediyor.',
          },
        ],
      });
      return;
    }
    try {
      const report = await persistentStore.reconcileWithGitHub();
      if (typeof report.serverRevision === 'number') {
        res.setHeader('ETag', `"rev-${report.serverRevision}"`);
      }
      res.json(report);
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        operation: 'reconcile',
        verifiedEqual: false,
        errors: [
          {
            category: 'http_error',
            message: redactSecrets(e?.message || 'İki yönlü eşitleme işlemi başarısız oldu.', [
              options.githubToken,
            ]),
          },
        ],
      });
    }
  });

  app.post('/api/sync/trigger', originGuard, tokenGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const syncResult = await persistentStore.syncToGitHub();
      res.json(syncResult);
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        error: redactSecrets(e?.message || 'Sync failed', [options.githubToken]),
      });
    }
  });

  app.post('/api/sync/test-connection', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const forceWriteProbe = Boolean(req.body?.forceWriteProbe);
      const probeResult = await persistentStore.testSafeConnectionAndProbeManifest({
        forceWriteProbe,
      });
      res.json(probeResult);
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        error: redactSecrets(e?.message || 'Bağlantı testi başarısız oldu.', [options.githubToken]),
      });
    }
  });

  app.post('/api/sync/public-consent', originGuard, tokenGuard, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const allow =
      typeof req.body?.allowPersonalDataInPublicRepo === 'boolean'
        ? req.body.allowPersonalDataInPublicRepo
        : typeof req.body?.allow === 'boolean'
          ? req.body.allow
          : undefined;
    if (typeof allow !== 'boolean') {
      res.status(400).json({
        ok: false,
        status_message: 'allowPersonalDataInPublicRepo alanı boolean (true/false) olmalıdır.',
      });
      return;
    }
    if (allow && req.body?.confirmPublicVisibility !== true) {
      res.status(400).json({
        ok: false,
        status_message:
          'Açık depoya kişisel veri senkronizasyonu için confirmPublicVisibility=true onayı zorunludur.',
      });
      return;
    }
    const updated = persistentStore.setPublicPersonalSyncConsent(allow);
    res.json({
      ok: true,
      ...updated,
      status: persistentStore.getSyncStatus(),
    });
  });

  app.post('/api/sync/public-catalog-consent', originGuard, tokenGuard, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const allow =
      typeof req.body?.allowCatalogInPublicRepo === 'boolean'
        ? req.body.allowCatalogInPublicRepo
        : typeof req.body?.allow === 'boolean'
          ? req.body.allow
          : undefined;
    if (typeof allow !== 'boolean') {
      res.status(400).json({
        ok: false,
        status_message: 'allowCatalogInPublicRepo alanı boolean (true/false) olmalıdır.',
      });
      return;
    }
    if (allow && req.body?.confirmTmdbAttribution !== true) {
      res.status(400).json({
        ok: false,
        status_message:
          'Açık depoya TMDB katalog verisi yüklemek için confirmTmdbAttribution=true onayı zorunludur.',
      });
      return;
    }
    const updated = persistentStore.setPublicCatalogSyncConsent(allow);
    res.json({
      ok: true,
      ...updated,
      status: persistentStore.getSyncStatus(),
    });
  });

  app.post('/api/sync/staged', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.body?.rejectIfBusy === true && persistentStore.isSyncBusy()) {
      res.status(409).json({
        ok: false,
        code: 'sync_in_progress',
        error: 'Başka bir GitHub senkronizasyon işlemi devam ediyor.',
      });
      return;
    }
    try {
      const forceWriteProbe =
        typeof req.body?.forceWriteProbe === 'boolean' ? req.body.forceWriteProbe : true;
      const allowOverride =
        typeof req.body?.allowPersonalDataInPublicRepo === 'boolean'
          ? req.body.allowPersonalDataInPublicRepo
          : undefined;
      const allowCatalogOverride =
        typeof req.body?.allowCatalogInPublicRepo === 'boolean'
          ? req.body.allowCatalogInPublicRepo
          : undefined;
      const stagedReport = await persistentStore.runStagedFullSync({
        forceWriteProbe,
        ...(allowOverride !== undefined ? { allowPersonalDataInPublicRepo: allowOverride } : {}),
        ...(allowCatalogOverride !== undefined ? { allowCatalogInPublicRepo: allowCatalogOverride } : {}),
      });
      if (typeof stagedReport.bidirectionalReport?.serverRevision === 'number') {
        res.setHeader('ETag', `"rev-${stagedReport.bidirectionalReport.serverRevision}"`);
      }
      res.json(stagedReport);
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        error: redactSecrets(e?.message || 'Aşamalı senkronizasyon başarısız oldu.', [
          options.githubToken,
        ]),
      });
    }
  });

  app.get('/api/catalog', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const type = _req.query.type === 'tv' ? 'tv' : _req.query.type === 'movie' ? 'movie' : 'all';
      if (type === 'all') {
        const movies = await persistentStore.readCatalogAsync('movie');
        const tv = await persistentStore.readCatalogAsync('tv');
        const manifest = await persistentStore.readCatalogManifestAsync();
        res.json({ movies, tv, ...(manifest ? { manifest } : {}) });
      } else {
        res.json(await persistentStore.readCatalogAsync(type));
      }
    } catch (err: any) {
      if (err instanceof CorruptJsonFileError) {
        res.status(500).json({ ok: false, code: err.code, status_message: err.message });
        return;
      }
      res.status(500).json({ ok: false, status_message: 'Katalog okunamadı.' });
    }
  });

  app.post('/api/catalog/upsert', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const raw = req.body;
      const items = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : raw ? [raw] : [];
      const result = await persistentStore.upsertCatalogItemsSerialized(items);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      if (err instanceof CorruptJsonFileError) {
        res.status(500).json({ ok: false, code: err.code, status_message: err.message });
        return;
      }
      res.status(500).json({ ok: false, status_message: 'Katalog güncellenemedi.' });
    }
  });

  app.get('/api/profiles/derived/:profileId', personalReadGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const profileId = String(req.params.profileId || '');
      const expectedFp =
        typeof req.query.profileFingerprint === 'string' ? req.query.profileFingerprint : undefined;
      const expectedAlg =
        typeof req.query.algorithmVersion === 'string' ? req.query.algorithmVersion : undefined;
      const expectedCatHash =
        typeof req.query.sourceCatalogHash === 'string' ? req.query.sourceCatalogHash : undefined;

      if (expectedFp && expectedAlg) {
        const validation = await persistentStore.readValidatedDerivedProfileAsync(profileId, {
          profileFingerprint: expectedFp,
          algorithmVersion: expectedAlg,
          sourceCatalogHash: expectedCatHash,
        });
        if (!validation.valid) {
          const status = validation.reason === 'missing_document' ? 404 : 409;
          res.status(status).json({
            ok: false,
            cacheValid: false,
            reason: validation.reason,
          });
          return;
        }
        res.json(validation.document);
        return;
      }

      const doc = await persistentStore.readDerivedProfileAsync(profileId);
      if (!doc) {
        res.status(404).json({ ok: false, message: 'Belirtilen profile ait işlenmiş veri bulunamadı.' });
        return;
      }
      res.json(doc);
    } catch (err: any) {
      if (err instanceof CorruptJsonFileError) {
        res.status(500).json({ ok: false, code: err.code, status_message: err.message });
        return;
      }
      res.status(500).json({ ok: false, status_message: 'İşlenmiş profil verisi okunamadı.' });
    }
  });

  app.post('/api/profiles/derived/upsert', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { profileId, algorithmVersion, profileFingerprint, sourceCatalogHash, schemaVersion, items } =
        req.body || {};
      if (!profileId || typeof profileId !== 'string') {
        res.status(400).json({ ok: false, message: 'profileId zorunludur.' });
        return;
      }
      const result = await persistentStore.upsertDerivedProfileSerialized({
        profileId,
        algorithmVersion: algorithmVersion || '3.0.0',
        profileFingerprint: profileFingerprint || 'default',
        ...(sourceCatalogHash !== undefined ? { sourceCatalogHash: String(sourceCatalogHash) } : {}),
        ...(typeof schemaVersion === 'number' ? { schemaVersion } : {}),
        items: items || {},
      });
      res.json({ ok: true, ...result });
    } catch (err: any) {
      if (err instanceof CorruptJsonFileError) {
        res.status(500).json({ ok: false, code: err.code, status_message: err.message });
        return;
      }
      res.status(500).json({ ok: false, status_message: 'İşlenmiş profil verisi kaydedilemedi.' });
    }
  });

  // --- Hibrit Yedek Birleştirme: CSV + GitHub ile senkron mevcut veri ---
  app.post('/api/backup/hybrid-merge', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const csvText = typeof req.body?.csvText === 'string' ? req.body.csvText : '';
      if (!csvText) {
        res.status(400).json({
          ok: false,
          status_message: 'Birleştirilecek CSV içeriği (csvText) gerekli.',
          code: 'missing_csv_text',
        });
        return;
      }
      if (csvText.length > 4_000_000) {
        res.status(413).json({
          ok: false,
          status_message: 'CSV içeriği 4 MB sınırını aşıyor.',
          code: 'csv_too_large',
        });
        return;
      }

      const dryRun = Boolean(req.body?.dryRun);
      const current = await storage.readDataAsync();
      const { document: mergedDocument, cinemaKunye, report } = runHybridMerge(csvText, current);

      if (dryRun) {
        res.json({ ok: true, dryRun: true, report });
        return;
      }

      const result = await storage.saveDataSerialized(mergedDocument, {
        expectedRevision: current.revision ?? 0,
        requirePrecondition: true,
        forceOverwrite: false,
      });

      if (!result.ok) {
        if (result.currentRevision !== undefined) {
          res.setHeader('ETag', `"rev-${result.currentRevision}"`);
        }
        res.status(result.status).json({
          ok: false,
          status_message: result.message,
          code: result.code,
          currentRevision: result.currentRevision,
        });
        return;
      }

      let savedKunye = cinemaKunye;
      if (Object.keys(cinemaKunye.entries).length > 0) {
        const kunyeSaveRes = await persistentStore.saveCinemaKunyeSerialized(cinemaKunye, {
          mode: 'merge',
        });
        savedKunye = kunyeSaveRes.document;
      }

      const rev = result.document.revision ?? 1;
      res.setHeader('ETag', `"rev-${rev}"`);
      res.json({
        ok: true,
        dryRun: false,
        report,
        revision: rev,
        updatedAt: result.document.updatedAt,
        items: result.totalItems,
        document: result.document,
        cinemaKunye: savedKunye,
      });
      notifyLocalMutation('hybrid-merge');
    } catch (error: any) {
      console.error('Hibrit birleştirme hatası:', error?.message || error);
      res.status(500).json({
        ok: false,
        status_message: redactSecrets(
          error?.message || 'Hibrit birleştirme tamamlanamadı.',
          [options.githubToken, options.tmdbApiKey]
        ),
      });
    }
  });

  // --- Posterli, Sekmeli Excel (.xlsx) & JSON Profil Yedeği Dışa Aktarma ---
  app.post('/api/backup/profile-export', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const storedDoc = await storage.readDataAsync();
      const exportDoc = resolveExportDocument(storedDoc, req.body);

      const profileId =
        typeof req.body?.profileId === 'string' && req.body.profileId.trim()
          ? req.body.profileId.trim()
          : exportDoc.activeProfileId;
      const includeJson = typeof req.body?.includeJson === 'boolean' ? req.body.includeJson : true;
      const includeXlsx = typeof req.body?.includeXlsx === 'boolean' ? req.body.includeXlsx : true;
      const uploadToGithub = Boolean(req.body?.uploadToGithub);
      const allowPersonalDataInPublicRepo =
        typeof req.body?.allowPersonalDataInPublicRepo === 'boolean'
          ? req.body.allowPersonalDataInPublicRepo
          : undefined;
      const dislikedItemsHint = Array.isArray(req.body?.dislikedItemsHint)
        ? req.body.dislikedItemsHint
        : undefined;
      const genresMap =
        req.body?.genresMap && typeof req.body.genresMap === 'object'
          ? req.body.genresMap
          : undefined;

      const includeTasteDnaSheet = Boolean(
        req.body?.includeTasteDnaSheet || req.body?.exportMode === 'xlsx_only'
      );

      const report = await executeProfileBackupExport({
        dataDir: resolvedDataDir,
        document: exportDoc,
        profileId,
        includeJson,
        includeXlsx,
        includeTasteDnaSheet,
        uploadToGithub,
        allowPersonalDataInPublicRepo,
        dislikedItemsHint,
        genresMap,
        persistentStore,
        tmdbApiKey: options.tmdbApiKey,
        githubTokenForRedaction: options.githubToken,
      });

      res.json(report);
    } catch (err: any) {
      res.status(500).json({
        ok: false,
        status_message: redactSecrets(
          err?.message || 'Profil yedeği dışa aktarılamadı.',
          [options.githubToken, options.tmdbApiKey]
        ),
      });
    }
  });

  app.post('/api/backup/profile-export/stream', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const storedDoc = await storage.readDataAsync();
      const exportDoc = resolveExportDocument(storedDoc, req.body);
      const profileId =
        typeof req.body?.profileId === 'string' && req.body.profileId.trim()
          ? req.body.profileId.trim()
          : exportDoc.activeProfileId;
      const dislikedItemsHint = Array.isArray(req.body?.dislikedItemsHint)
        ? req.body.dislikedItemsHint
        : undefined;
      const genresMap =
        req.body?.genresMap && typeof req.body.genresMap === 'object'
          ? req.body.genresMap
          : undefined;

      const includeTasteDnaSheet = Boolean(
        req.body?.includeTasteDnaSheet || req.body?.exportMode === 'xlsx_only'
      );

      const report = await executeProfileBackupExport({
        dataDir: resolvedDataDir,
        document: exportDoc,
        profileId,
        includeJson: false,
        includeXlsx: true,
        includeTasteDnaSheet,
        uploadToGithub: false,
        dislikedItemsHint,
        genresMap,
        persistentStore,
        tmdbApiKey: options.tmdbApiKey,
        githubTokenForRedaction: options.githubToken,
      });

      if (
        !report.excelBackup.ok ||
        !report.excelBackup.absolutePath ||
        !existsSync(report.excelBackup.absolutePath)
      ) {
        res.status(500).json({
          ok: false,
          status_message:
            report.excelBackup.error || 'Excel (.xlsx) ikili akışı oluşturulamadı.',
        });
        return;
      }

      const absPath = report.excelBackup.absolutePath;
      const stat = await fsPromises.stat(absPath);
      const fileName = report.excelBackup.fileName || brandProfileFileName('xlsx');
      const sha256 = report.excelBackup.sha256 || (await computeFileSha256Async(absPath));

      await streamFileDownload(res, absPath, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(stat.size),
        'X-CineTrack-SHA256': sha256,
        'X-CineTrack-Filename': fileName,
        'X-Content-Type-Options': 'nosniff',
      });
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          status_message: redactSecrets(
            err?.message || 'Excel (.xlsx) ikili akışı dışa aktarılamadı.',
            [options.githubToken, options.tmdbApiKey]
          ),
        });
      }
    }
  });

  app.post('/api/backup/excel/preview', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const storedDoc = await storage.readDataAsync();
      const exportDoc = resolveExportDocument(storedDoc, req.body);
      const profileId =
        typeof req.body?.profileId === 'string' && req.body.profileId.trim()
          ? req.body.profileId.trim()
          : exportDoc.activeProfileId;
      const profile = exportDoc.profiles.find((p) => p.id === profileId) || exportDoc.profiles[0];
      if (!profile) {
        res.status(404).json({ ok: false, status_message: 'Profil bulunamadı.' });
        return;
      }
      const dislikedItemsHint = Array.isArray(req.body?.dislikedItemsHint)
        ? req.body.dislikedItemsHint
        : undefined;
      const genresMap =
        req.body?.genresMap && typeof req.body.genresMap === 'object'
          ? req.body.genresMap
          : undefined;

      const moviesCatalog = (await persistentStore.readCatalogAsync('movie')) || {};
      const tvCatalog = (await persistentStore.readCatalogAsync('tv')) || {};

      const dataset = await buildProfileBackupDataset({
        profile,
        schemaVersion: exportDoc.schemaVersion,
        engineVersion: exportDoc.engineVersion,
        moviesCatalog,
        tvCatalog,
        genresMap,
        dislikedItemsHint,
      });

      res.json({
        ok: true,
        profileId: dataset.profileId,
        profileName: dataset.profileName,
        completeness: {
          rawProfileItemsCount: dataset.rawProfileItemsCount,
          normalizedSavedItemsCount: dataset.normalizedSavedItemsCount,
          rawDislikedCount: dataset.rawDislikedCount,
          uniqueDislikedCount: dataset.uniqueDislikedCount,
          favoriteActorsCount: dataset.favoriteActorsCount,
          customItemsCount: dataset.customItemsCount,
          totalItemsCount: dataset.totalItemsCount,
        },
        sheetCounts: dataset.sheetCounts,
        dataset,
      });
    } catch (err: any) {
      res.status(500).json({
        ok: false,
        status_message: redactSecrets(
          err?.message || 'Önizleme verisi oluşturulamadı.',
          [options.githubToken, options.tmdbApiKey]
        ),
      });
    }
  });

  app.get('/api/backup/exports/:fileName', personalReadGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const rawName = String(req.params.fileName || '').trim();
    if (!EXPORT_FILE_NAME_PATTERN.test(rawName)) {
      res.status(400).json({ ok: false, status_message: 'Geçersiz yedek dosya adı.' });
      return;
    }
    const exportsDir = path.resolve(resolvedDataDir, 'exports');
    const fullPath = path.resolve(exportsDir, rawName);
    if (!fullPath.startsWith(exportsDir + path.sep) || !existsSync(fullPath)) {
      res.status(404).json({ ok: false, status_message: 'Yedek dosyası bulunamadı.' });
      return;
    }

    const stat = await fsPromises.stat(fullPath);
    const sha256 = await computeFileSha256Async(fullPath);
    const contentType = rawName.endsWith('.xlsx')
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/json; charset=utf-8';

    await streamFileDownload(res, fullPath, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${rawName}"`,
      'Content-Length': String(stat.size),
      'X-CineTrack-SHA256': sha256,
      'X-CineTrack-Filename': rawName,
      'X-Content-Type-Options': 'nosniff',
    });
  });

  // Faz 6: Taste Engine HTTP uçları
  app.use(
    '/api/taste',
    personalReadGuard,
    createTasteRouter(resolvedDataDir, { tmdbApiKey: options.tmdbApiKey })
  );

  if (typeof options.registerCustomRoutes === 'function') {
    options.registerCustomRoutes(app);
  }

  // Unmatched /api/* routes must always return JSON 404 and never fall through to SPA index.html
  app.use('/api', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({
      ok: false,
      code: 'api_not_found',
      status_message: 'API uç noktası bulunamadı.',
    });
  });

  // Global error handler (EXT-06): catches uncaught sync/async route errors, redacts secrets, hides stack traces
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId = crypto.randomUUID();
    const rawMsg = err instanceof Error ? err.message : String(err ?? 'Unknown error');
    const safeMsg = redactSecrets(rawMsg, [
      options.githubToken,
      options.tmdbApiKey,
      options.authToken,
    ]);
    console.error(`[API Error ${requestId}]`, safeMsg);
    if (res.headersSent) {
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({
      ok: false,
      error: 'Beklenmeyen bir sunucu hatası oluştu.',
      code: 'internal_error',
      requestId,
      status_message: 'Beklenmeyen bir sunucu hatası oluştu.',
    });
  });

  return { app, storage, tmdbProxy, persistentStore };
}

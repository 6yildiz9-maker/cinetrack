import crypto from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
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
import {
  createOriginMiddleware,
  createTmdbRateLimitMiddleware,
  createTokenAuthMiddleware,
  type SecurityOptions,
} from './security.ts';
import { createTmdbProxyService, type TmdbProxyServiceOptions } from './tmdb-proxy.ts';
import { PersistentDataStore, redactSecrets, type TokenSourceKind } from './persistent-store.ts';
import { CorruptJsonFileError } from './atomic-json.ts';
import { DEFAULT_MAX_DATA_BYTES, formatMaxDataLimitMb } from '../core/limits.ts';
import {
  executeProfileBackupExport,
  buildProfileBackupDataset,
  EXPORT_FILE_NAME_PATTERN,
  getPosterCacheStats,
} from './excel-profile-backup.ts';

export interface CineTrackAppOptions extends StorageOptions, SecurityOptions, TmdbProxyServiceOptions {
  security?: SecurityOptions;
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
  const maxDataBytes = options.maxDataBytes ?? DEFAULT_MAX_DATA_BYTES;
  const storage = createDataStorage({ ...options, maxDataBytes });
  const tmdbProxy = createTmdbProxyService(options);
  const persistentStore = new PersistentDataStore({
    dataDir: options.dataDir,
    maxDataBytes,
    githubToken: options.githubToken,
    githubTokenSource: options.githubTokenSource,
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

  const sec: SecurityOptions = { ...options, ...(options.security || {}) };
  const originGuard = createOriginMiddleware(sec);
  const tokenGuard = createTokenAuthMiddleware(sec);
  const syncStatusGuard = createTokenAuthMiddleware({ ...sec, requireTokenForReads: true });
  const tmdbRateLimiter = createTmdbRateLimitMiddleware(sec);

  const app = express();
  app.disable('x-powered-by');
  if (sec.trustProxy) {
    app.set('trust proxy', true);
  }

  // Temel güvenlik başlıkları (BUG-12.1)
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https://image.tmdb.org https://img.tmdb.org https://*.tmdb.org https://*.themoviedb.org; connect-src 'self' https://api.themoviedb.org; base-uri 'self'; form-action 'self'"
    );
    if (!process.env.APP_URL) {
      res.setHeader('X-Frame-Options', 'DENY');
    }
    next();
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

  app.get('/api/health', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const posterCache = getPosterCacheStats(path.join(options.dataDir, 'cache', 'posters'));
    res.json({ ok: true, posterCache });
  });

  app.get('/api/tmdb-status', tmdbProxy.handleStatus);
  app.get('/api/tmdb', tmdbRateLimiter, tmdbProxy.handleTmdb);
  app.get('/api/tmdb-image', tmdbProxy.handleTmdbImage);

  app.get('/api/data', tokenGuard, async (_req: Request, res: Response) => {
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
      const result = await storage.saveDataSerialized(req.body, {
        expectedRevision,
        hasInvalidIfMatch,
        requirePrecondition: true,
        forceOverwrite,
        confirmBulkDelete,
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
      });
    } catch (error: any) {
      if (error instanceof CorruptJsonFileError) {
        res.status(500).json({ status_message: error.message, code: error.code });
        return;
      }
      console.error('Veri kaydedilemedi:', error?.message || error);
      res.status(500).json({ status_message: 'Veri dosyasına yazılamadı.', code: 'storage_write_failed' });
    }
  });

  app.get('/api/data/backups', tokenGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ backups: await storage.listBackupsAsync() });
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
  });

  // --- Kalıcı Veri Deposu & Çift Yönlü GitHub Senkronizasyonu ---
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

  app.get('/api/catalog', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const type = _req.query.type === 'tv' ? 'tv' : _req.query.type === 'movie' ? 'movie' : 'all';
      if (type === 'all') {
        const movies = persistentStore.readCatalog('movie');
        const tv = persistentStore.readCatalog('tv');
        const manifest = persistentStore.readCatalogManifest();
        res.json({ movies, tv, ...(manifest ? { manifest } : {}) });
      } else {
        res.json(persistentStore.readCatalog(type));
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

  app.get('/api/profiles/derived/:profileId', tokenGuard, (req: Request, res: Response) => {
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
        const validation = persistentStore.readValidatedDerivedProfile(profileId, {
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

      const doc = persistentStore.readDerivedProfile(profileId);
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

      const report = await executeProfileBackupExport({
        dataDir: options.dataDir,
        document: exportDoc,
        profileId,
        includeJson,
        includeXlsx,
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

      const report = await executeProfileBackupExport({
        dataDir: options.dataDir,
        document: exportDoc,
        profileId,
        includeJson: false,
        includeXlsx: true,
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
      const fileName = report.excelBackup.fileName || 'CineTrack_Profile.xlsx';
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

      const moviesCatalog = persistentStore.readCatalog('movie') || {};
      const tvCatalog = persistentStore.readCatalog('tv') || {};

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

  app.get('/api/backup/exports/:fileName', tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const rawName = String(req.params.fileName || '').trim();
    if (!EXPORT_FILE_NAME_PATTERN.test(rawName)) {
      res.status(400).json({ ok: false, status_message: 'Geçersiz yedek dosya adı.' });
      return;
    }
    const exportsDir = path.resolve(options.dataDir, 'exports');
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
      error: 'Sunucu hatası oluştu.',
      code: 'internal_error',
      requestId,
      status_message: 'Sunucu hatası oluştu.',
    });
  });

  return { app, storage, tmdbProxy, persistentStore };
}

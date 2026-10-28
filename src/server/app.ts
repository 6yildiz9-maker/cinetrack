import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
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
  EXPORT_FILE_NAME_PATTERN,
} from './excel-profile-backup.ts';

export interface CineTrackAppOptions extends StorageOptions, SecurityOptions, TmdbProxyServiceOptions {
  maxDataBytes?: number;
  githubToken?: string;
  githubTokenSource?: TokenSourceKind;
  githubOwner?: string;
  githubRepo?: string;
  githubBranch?: string;
  isPublicRepo?: boolean;
  allowPublicPersonalSync?: boolean;
  processEnvIsPublicRepo?: string | null;
  localEnvIsPublicRepo?: string | null;
}

function parseIfMatchRevision(req: Request): number | null {
  const ifMatch = req.headers['if-match'];
  if (typeof ifMatch === 'string' && ifMatch.trim()) {
    const cleaned = ifMatch.trim().replace(/^W\//i, '').replace(/^"|"$/g, '');
    const revMatch = cleaned.match(/^(?:rev-)?(\d+)$/);
    if (revMatch) {
      return Number(revMatch[1]);
    }
  }
  const headerRev = req.headers['x-cinetrack-base-revision'];
  if (typeof headerRev === 'string' && /^\d+$/.test(headerRev.trim())) {
    return Number(headerRev.trim());
  }
  if (req.body && typeof req.body === 'object' && typeof req.body.baseRevision === 'number') {
    if (Number.isSafeInteger(req.body.baseRevision) && req.body.baseRevision >= 0) {
      return req.body.baseRevision;
    }
  }
  return null;
}

function isBulkDeleteConfirmed(req: Request): boolean {
  const headerVal = req.headers['x-cinetrack-confirm-drop'];
  if (headerVal === '1' || headerVal === 'true') return true;
  if (req.body && typeof req.body === 'object' && req.body.confirmBulkDelete === true) return true;
  return false;
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
    processEnvIsPublicRepo: options.processEnvIsPublicRepo,
    localEnvIsPublicRepo: options.localEnvIsPublicRepo,
  });
  persistentStore.attachDataStorage(storage, maxDataBytes);

  const originGuard = createOriginMiddleware(options);
  const tokenGuard = createTokenAuthMiddleware(options);
  const tmdbRateLimiter = createTmdbRateLimitMiddleware(options);

  const app = express();
  app.disable('x-powered-by');
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

  app.get('/api/tmdb-status', tmdbProxy.handleStatus);
  app.get('/api/tmdb', tmdbRateLimiter, tmdbProxy.handleTmdb);

  app.get('/api/data', tokenGuard, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const doc = storage.readData();
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
      const expectedRevision = parseIfMatchRevision(req);
      const confirmBulkDelete = isBulkDeleteConfirmed(req);
      const result = await storage.saveDataSerialized(req.body, {
        expectedRevision,
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

  app.get('/api/data/backups', tokenGuard, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ backups: storage.listBackups() });
  });

  app.post('/api/data/restore', originGuard, tokenGuard, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const backupId = typeof req.body?.backupId === 'string' ? req.body.backupId.trim() : '';
    if (!backupId) {
      res.status(400).json({ status_message: 'Geri yüklenecek yedek kimliği (backupId) gerekli.', code: 'missing_backup_id' });
      return;
    }

    const restored = storage.restoreBackup(backupId);
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
  app.get('/api/sync/status', (_req: Request, res: Response) => {
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
    const allow = req.body?.allowPersonalDataInPublicRepo;
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
      const stagedReport = await persistentStore.runStagedFullSync({
        forceWriteProbe,
        ...(allowOverride !== undefined ? { allowPersonalDataInPublicRepo: allowOverride } : {}),
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
      const storedDoc = storage.readData();
      let exportDoc = storedDoc;

      if (req.body?.profileSnapshot && typeof req.body.profileSnapshot === 'object') {
        const snap = req.body.profileSnapshot;
        const snapId =
          typeof snap.id === 'string' && snap.id.trim()
            ? snap.id.trim()
            : storedDoc.activeProfileId;
        const existing = storedDoc.profiles.find((p) => p.id === snapId);
        if (
          !existing ||
          (Array.isArray(snap.items) && snap.items.length >= (existing.items?.length || 0))
        ) {
          exportDoc = {
            ...storedDoc,
            activeProfileId: snapId,
            profiles: existing
              ? storedDoc.profiles.map((p) => (p.id === snapId ? { ...existing, ...snap } : p))
              : [...storedDoc.profiles, snap],
          };
        }
      }

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

  app.get('/api/backup/exports/:fileName', tokenGuard, (req: Request, res: Response) => {
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

    const buf = readFileSync(fullPath);
    if (rawName.endsWith('.xlsx')) {
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
    } else {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.setHeader('Content-Disposition', `attachment; filename="${rawName}"`);
    res.setHeader('Content-Length', String(buf.length));
    res.send(buf);
  });

  return { app, storage, tmdbProxy, persistentStore };
}

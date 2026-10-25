import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createDataStorage, countTotalItems, type StorageOptions } from './storage.ts';
import {
  createOriginMiddleware,
  createTmdbRateLimitMiddleware,
  createTokenAuthMiddleware,
  type SecurityOptions,
} from './security.ts';
import { createTmdbProxyService, type TmdbProxyServiceOptions } from './tmdb-proxy.ts';
import { PersistentDataStore } from './persistent-store.ts';

export interface CineTrackAppOptions extends StorageOptions, SecurityOptions, TmdbProxyServiceOptions {
  maxDataBytes?: number;
  githubToken?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubBranch?: string;
  isPublicRepo?: boolean;
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
  const maxDataBytes = options.maxDataBytes ?? 2_000_000;
  const storage = createDataStorage(options);
  const tmdbProxy = createTmdbProxyService(options);
  const persistentStore = new PersistentDataStore({
    dataDir: options.dataDir,
    githubToken: options.githubToken,
    githubOwner: options.githubOwner,
    githubRepo: options.githubRepo,
    githubBranch: options.githubBranch,
    isPublicRepo: options.isPublicRepo,
  });

  const originGuard = createOriginMiddleware(options);
  const tokenGuard = createTokenAuthMiddleware(options);
  const tmdbRateLimiter = createTmdbRateLimitMiddleware(options);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: maxDataBytes }));

  // Standardized body-parser error handling (413 Payload Too Large & 400 Invalid JSON)
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (!err) {
      next();
      return;
    }
    if (err.type === 'entity.too.large' || err.status === 413) {
      res.status(413).json({
        status_message: `Gönderilen veri boyutu izin verilen sınırı (${Math.round(maxDataBytes / 1_000_000)} MB) aşıyor.`,
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
    const rev = doc.revision ?? 0;
    res.setHeader('ETag', `"rev-${rev}"`);
    res.json(doc);
  });

  app.put('/api/data', originGuard, tokenGuard, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const expectedRevision = parseIfMatchRevision(req);
      const confirmBulkDelete = isBulkDeleteConfirmed(req);
      const result = storage.saveData(req.body, {
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

  // --- Kalıcı Veri Deposu (Bölüm 8: Katalog ve Profil İşlenmiş Veri Deposu) ---
  app.get('/api/sync/status', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(persistentStore.getSyncStatus());
  });

  app.post('/api/sync/trigger', originGuard, tokenGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const syncResult = await persistentStore.syncToGitHub();
      res.json(syncResult);
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || 'Sync failed' });
    }
  });

  app.get('/api/catalog', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const type = _req.query.type === 'tv' ? 'tv' : _req.query.type === 'movie' ? 'movie' : 'all';
    if (type === 'all') {
      const movies = persistentStore.readCatalog('movie');
      const tv = persistentStore.readCatalog('tv');
      res.json({ movies, tv });
    } else {
      res.json(persistentStore.readCatalog(type));
    }
  });

  app.post('/api/catalog/upsert', originGuard, tokenGuard, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const raw = req.body;
    const items = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : raw ? [raw] : [];
    const result = persistentStore.upsertCatalogItems(items);
    res.json({ ok: true, ...result });
  });

  app.get('/api/profiles/derived/:profileId', tokenGuard, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const profileId = String(req.params.profileId || '');
    const doc = persistentStore.readDerivedProfile(profileId);
    if (!doc) {
      res.status(404).json({ ok: false, message: 'Belirtilen profile ait işlenmiş veri bulunamadı.' });
      return;
    }
    res.json(doc);
  });

  app.post('/api/profiles/derived/upsert', originGuard, tokenGuard, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const { profileId, algorithmVersion, profileFingerprint, items } = req.body || {};
    if (!profileId || typeof profileId !== 'string') {
      res.status(400).json({ ok: false, message: 'profileId zorunludur.' });
      return;
    }
    const result = persistentStore.upsertDerivedProfile({
      profileId,
      algorithmVersion: algorithmVersion || '3.0.0',
      profileFingerprint: profileFingerprint || 'default',
      items: items || {},
    });
    res.json({ ok: true, ...result });
  });

  return { app, storage, tmdbProxy, persistentStore };
}

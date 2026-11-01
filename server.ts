import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_DATA_BYTES,
  DEFAULT_MAX_ITEMS_PER_PROFILE,
  DEFAULT_MAX_PROFILES,
} from './src/core/limits.ts';
import type { SavedItem } from './src/core/cinetrack-core.ts';
import { createCineTrackApp, createSpaFallbackMiddleware } from './src/server/app.ts';
import { isAiStudioContainerEnv, resolveConfig } from './src/server/config.ts';
import { redactSecrets } from './src/server/persistent-store.ts';
import {
  createServiceClient,
  createSupabaseUserDataRepository,
} from './src/server/user-data-repository.ts';

const root = path.dirname(fileURLToPath(import.meta.url));
const CINETRACK_HOST = '127.0.0.1';
const resolved = resolveConfig({ rootDir: root });
const port = resolved.port;
const bindHost = resolved.explicitHost || CINETRACK_HOST;
const listenHost = resolved.listenHost;

const dataDir = path.join(root, 'data');
const maxDataBytes = DEFAULT_MAX_DATA_BYTES;
const maxProfiles = DEFAULT_MAX_PROFILES;
const maxItemsPerProfile = DEFAULT_MAX_ITEMS_PER_PROFILE;

for (const warnMsg of resolved.warnings) {
  console.warn(warnMsg);
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY ortam değişkenleri tanımlı olmalıdır.');
  process.exit(1);
}

const { app, storage, persistentStore } = createCineTrackApp({
  repository: createSupabaseUserDataRepository(
    createServiceClient(supabaseUrl, supabaseServiceRoleKey)
  ),
  dataDir,
  maxDataBytes,
  maxProfiles,
  maxItemsPerProfile,
  bindHost,
  trustProxy: resolved.trustProxy,
  ...(resolved.tmdbRateLimit !== undefined ? { rateLimitMaxRequests: resolved.tmdbRateLimit } : {}),
  ...(resolved.tmdbRateWindowMs !== undefined ? { rateLimitWindowMs: resolved.tmdbRateWindowMs } : {}),
  tmdbApiKey: resolved.tmdbApiKey,
  githubToken: resolved.githubToken,
  githubTokenSource: resolved.githubTokenSource,
  githubOwner: resolved.githubOwner,
  githubRepo: resolved.githubRepo,
  githubBranch: resolved.githubBranch,
  isPublicRepo: resolved.isPublicRepo,
  ...(resolved.allowPublicPersonalSync !== undefined
    ? { allowPublicPersonalSync: resolved.allowPublicPersonalSync }
    : {}),
  ...(resolved.allowPublicCatalogSync !== undefined
    ? { allowPublicCatalogSync: resolved.allowPublicCatalogSync }
    : {}),
  processEnvIsPublicRepo: resolved.processEnvIsPublicRepo,
  localEnvIsPublicRepo: resolved.localEnvIsPublicRepo,
  ...(resolved.authToken ? { authToken: resolved.authToken } : {}),
});

// Setup Vite middleware (explicit --dev only) or static dist serving (production default)
const legacyDataFile = path.join(dataDir, 'cinetrack-data.json');

async function importLegacyDataIfNeeded() {
  if (!existsSync(legacyDataFile)) return;
  const current = await storage.readDataAsync();
  if (current.profiles.length > 0) return;
  const legacy = JSON.parse(readFileSync(legacyDataFile, 'utf8'));
  const result = await storage.applySyncedDocumentSerialized(legacy);
  if (!result.ok) {
    throw new Error(result.message);
  }
  console.log(`[Migration] Yerel veri dosyası veritabanına aktarıldı (rev-${result.document.revision}).`);
}

async function startServer() {
  try {
    await importLegacyDataIfNeeded();
  } catch (e: any) {
    console.error('[Migration] Yerel veri veritabanına aktarılamadı:', e?.message || e);
    process.exit(1);
  }

  // Başlangıçta mevcut izleme listesi ve profillerdeki yapımları asenkron olarak kalıcı kataloğa aktar (BUG-04)
  try {
    const initialData = await storage.readDataAsync();
    const allItems: SavedItem[] = [];
    for (const p of initialData.profiles || []) {
      if (Array.isArray(p.items)) allItems.push(...p.items);
    }
    if (allItems.length > 0) {
      await persistentStore.upsertCatalogItemsSerialized(allItems);
    }
  } catch (e: any) {
    console.warn('[Catalog] Başlangıç indeksleme uyarısı:', e?.message || e);
  }

  const isDevMode = process.env.NODE_ENV !== 'production' && process.argv.includes('--dev');
  const httpServer = createHttpServer(app);

  if (!isDevMode) {
    const distPath = path.join(root, 'dist');
    const indexHtmlPath = path.join(distPath, 'index.html');
    if (!existsSync(indexHtmlPath)) {
      console.error(
        'Üretim derlemesi (dist/index.html) bulunamadı. Önce "npm run build" çalıştırın veya geliştirme modu için "npm run dev" kullanın.'
      );
      process.exit(1);
    }
    app.use(express.static(distPath));
    app.use(createSpaFallbackMiddleware(indexHtmlPath));
  } else {
    const hmrDisabled = process.env.DISABLE_HMR === 'true' || isAiStudioContainerEnv(process.env);
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: listenHost,
        port,
        hmr: hmrDisabled ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(port, listenHost, () => {
    console.log(
      `CineTrack is running at http://${listenHost}:${port} (bind policy: ${bindHost}, ${isDevMode ? 'development' : 'production'})`
    );
    console.log('Profil ve izleme listesi: Supabase veritabanı');
    const syncStatus = persistentStore.getSyncStatus();
    console.log(
      `Kalıcı Veri Deposu: ${syncStatus.mode === 'github' ? `GitHub Uzak Eşitleme (${syncStatus.remoteTarget?.repo})` : 'Yerel Depolama (data/catalog & data/profiles)'}`
    );
    if (!resolved.tmdbApiKey) {
      console.log('TMDB_API_KEY is not configured; running in fallback demo mode.');
    }

    // 5 dakikada bir otomatik arka plan eşitlemesi — ilk çalıştırmada hiçbir tarafı körlemesine ezmemek için
    // yalnızca kullanıcı ilk kayıpsız çift yönlü eşitlemeyi tamamladıktan sonra devreye girer.
    const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
    const autoSyncTimer = setInterval(async () => {
      try {
        const currentStatus = persistentStore.getSyncStatus();
        if (
          currentStatus.configured &&
          persistentStore.hasCompletedInitialReconcile() &&
          !persistentStore.isSyncBusy()
        ) {
          const report = await persistentStore.reconcileWithGitHub();
          if (report.ok) {
            console.log(
              `[Auto-Sync] Periyodik kayıpsız iki yönlü eşitleme tamamlandı (indirilen: ${report.filesDownloaded.length}, yüklenen: ${report.filesUploaded.length}, değişmeyen: ${report.filesUnchanged.length}, doğrulandı: ${report.verifiedEqual}).`
            );
          } else if (report.errors.length > 0) {
            console.warn(
              '[Auto-Sync] Eşitleme uyarısı:',
              redactSecrets(
                report.errors.map((e) => e.message).join('; '),
                [resolved.githubToken]
              )
            );
          }
        }
      } catch (err: any) {
        console.error(
          '[Auto-Sync] Otomatik senkronizasyon hatası:',
          redactSecrets(err?.message || String(err), [resolved.githubToken])
        );
      }
    }, AUTO_SYNC_INTERVAL_MS);

    if (typeof autoSyncTimer.unref === 'function') {
      autoSyncTimer.unref();
    }
  });
}

startServer();

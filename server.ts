import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDataDocument, CURRENT_SCHEMA_VERSION } from './src/core/cinetrack-core.ts';
import {
  DEFAULT_MAX_DATA_BYTES,
  DEFAULT_MAX_ITEMS_PER_PROFILE,
  DEFAULT_MAX_PROFILES,
} from './src/core/limits.ts';
import { createCineTrackApp } from './src/server/app.ts';
import { redactSecrets, type TokenSourceKind } from './src/server/persistent-store.ts';

void normalizeDataDocument;
void CURRENT_SCHEMA_VERSION;

const root = path.dirname(fileURLToPath(import.meta.url));
const CINETRACK_HOST = '127.0.0.1';
void CINETRACK_HOST;
const port = Number(process.env.PORT) || Number(process.env.CINETRACK_PORT) || 3000;
const host = process.env.CINETRACK_HOST || process.env.HOST || '0.0.0.0';

const dataDir = path.join(root, 'data');
const maxDataBytes = DEFAULT_MAX_DATA_BYTES;
const maxProfiles = DEFAULT_MAX_PROFILES;
const maxItemsPerProfile = DEFAULT_MAX_ITEMS_PER_PROFILE;

// Read local .env or .env.local if present
const localEnv: Record<string, string> = {};
for (const envFileName of ['.env.local', '.env']) {
  try {
    const envFile = readFileSync(path.join(root, envFileName), 'utf8');
    for (const line of envFile.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      if (key && !(key in localEnv)) localEnv[key] = value;
    }
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const tmdbApiKey = process.env.TMDB_API_KEY || localEnv.TMDB_API_KEY || '';
const optionalAuthToken = process.env.CINETRACK_TOKEN || localEnv.CINETRACK_TOKEN || '';

let githubToken = '';
let githubTokenSource: TokenSourceKind = 'none';
if (process.env.CINETRACK_GITHUB_TOKEN) {
  githubToken = process.env.CINETRACK_GITHUB_TOKEN;
  githubTokenSource = 'env:CINETRACK_GITHUB_TOKEN';
} else if (process.env.CINETRACK_GITHUB_PAT) {
  githubToken = process.env.CINETRACK_GITHUB_PAT;
  githubTokenSource = 'env:CINETRACK_GITHUB_PAT';
} else if (localEnv.CINETRACK_GITHUB_TOKEN) {
  githubToken = localEnv.CINETRACK_GITHUB_TOKEN;
  githubTokenSource = 'file:CINETRACK_GITHUB_TOKEN';
} else if (localEnv.CINETRACK_GITHUB_PAT) {
  githubToken = localEnv.CINETRACK_GITHUB_PAT;
  githubTokenSource = 'file:CINETRACK_GITHUB_PAT';
}

const githubOwner = process.env.CINETRACK_DATA_OWNER || localEnv.CINETRACK_DATA_OWNER || '6yildiz9-maker';
const githubRepo = process.env.CINETRACK_DATA_REPO || localEnv.CINETRACK_DATA_REPO || 'cinetrack-private-data';
const githubBranch = process.env.CINETRACK_DATA_BRANCH || localEnv.CINETRACK_DATA_BRANCH || 'main';

const processEnvIsPublicRepo =
  process.env.CINETRACK_DATA_REPO_IS_PUBLIC !== undefined
    ? process.env.CINETRACK_DATA_REPO_IS_PUBLIC
    : null;
const localEnvIsPublicRepo =
  localEnv.CINETRACK_DATA_REPO_IS_PUBLIC !== undefined
    ? localEnv.CINETRACK_DATA_REPO_IS_PUBLIC
    : null;

const rawIsPublicRepo =
  localEnvIsPublicRepo !== null
    ? localEnvIsPublicRepo
    : processEnvIsPublicRepo !== null
      ? processEnvIsPublicRepo
      : 'false';
const isPublicRepo = rawIsPublicRepo.trim().toLowerCase() === 'true';

const rawAllowPublicPersonal =
  localEnv.CINETRACK_ALLOW_PUBLIC_PERSONAL_SYNC !== undefined
    ? localEnv.CINETRACK_ALLOW_PUBLIC_PERSONAL_SYNC
    : process.env.CINETRACK_ALLOW_PUBLIC_PERSONAL_SYNC;
const normalizedAllowPublic = rawAllowPublicPersonal?.trim().toLowerCase();
const allowPublicPersonalSync =
  normalizedAllowPublic === 'true'
    ? true
    : normalizedAllowPublic === 'false'
      ? false
      : undefined;

const { app, storage, persistentStore } = createCineTrackApp({
  dataDir,
  maxDataBytes,
  maxProfiles,
  maxItemsPerProfile,
  tmdbApiKey,
  githubToken,
  githubTokenSource,
  githubOwner,
  githubRepo,
  githubBranch,
  isPublicRepo,
  ...(allowPublicPersonalSync !== undefined ? { allowPublicPersonalSync } : {}),
  processEnvIsPublicRepo,
  localEnvIsPublicRepo,
  ...(optionalAuthToken ? { authToken: optionalAuthToken } : {}),
});

// Başlangıçta mevcut izleme listesi ve profillerdeki yapımları kalıcı kataloğa aktar
try {
  const initialData = storage.readData();
  const allItems: any[] = [];
  for (const p of initialData.profiles || []) {
    if (Array.isArray(p.items)) allItems.push(...p.items);
  }
  if (allItems.length > 0) {
    persistentStore.upsertCatalogItems(allItems);
  }
} catch (e: any) {
  console.warn('[Catalog] Başlangıç indeksleme uyarısı:', e?.message || e);
}

// Setup Vite middleware (explicit --dev only) or static dist serving (production default)
async function startServer() {
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
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(indexHtmlPath);
    });
  } else {
    const hmrDisabled = process.env.DISABLE_HMR === 'true' || Boolean(process.env.APP_URL);
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host,
        port,
        hmr: hmrDisabled ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(port, host, () => {
    console.log(`CineTrack is running at http://${host}:${port} (${isDevMode ? 'development' : 'production'})`);
    console.log(`Profil ve izleme listesi: ${storage.dataFile}`);
    const syncStatus = persistentStore.getSyncStatus();
    console.log(
      `Kalıcı Veri Deposu: ${syncStatus.mode === 'github' ? `GitHub Uzak Eşitleme (${syncStatus.remoteTarget?.repo})` : 'Yerel Depolama (data/catalog & data/profiles)'}`
    );
    if (!tmdbApiKey) {
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
                [githubToken]
              )
            );
          }
        }
      } catch (err: any) {
        console.error(
          '[Auto-Sync] Otomatik senkronizasyon hatası:',
          redactSecrets(err?.message || String(err), [githubToken])
        );
      }
    }, AUTO_SYNC_INTERVAL_MS);

    if (typeof autoSyncTimer.unref === 'function') {
      autoSyncTimer.unref();
    }
  });
}

startServer();

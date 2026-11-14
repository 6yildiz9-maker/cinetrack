import express from 'express';
import { existsSync } from 'node:fs';
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
import { refreshEnvGitHubPat } from './src/server/github-token-refresh.ts';
import { redactSecrets } from './src/server/persistent-store.ts';
import { createRespanTracing } from './src/server/respan-telemetry.ts';

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

// Respan izleme tek bir kez, model istemcileri oluşturulmadan önce başlatılır.
// RESPAN_API_KEY yoksa sessizce devre dışı kalır ve uygulama izleme olmadan çalışır.
await createRespanTracing({
  apiKey: resolved.respanApiKey,
  ...(resolved.respanBaseUrl ? { baseUrl: resolved.respanBaseUrl } : {}),
}).start();

const envFilePath = path.join(root, '.env');
let githubTokenLive = resolved.githubToken;
let schedulePostMutationSync: ((reason: string) => void) | null = null;
const isDevMode = process.env.NODE_ENV !== 'production' && process.argv.includes('--dev');

const { app, storage, persistentStore } = createCineTrackApp({
  dataDir,
  maxDataBytes,
  maxProfiles,
  maxItemsPerProfile,
  bindHost,
  devMode: isDevMode,
  trustProxy: resolved.trustProxy,
  ...(resolved.tmdbRateLimit !== undefined ? { rateLimitMaxRequests: resolved.tmdbRateLimit } : {}),
  ...(resolved.tmdbRateWindowMs !== undefined ? { rateLimitWindowMs: resolved.tmdbRateWindowMs } : {}),
  tmdbApiKey: resolved.tmdbApiKey,
  githubToken: resolved.githubToken,
  githubTokenSource: resolved.githubTokenSource,
  githubTokenCandidates: resolved.githubTokenCandidates,
  getLiveGitHubTokenCandidates: () => resolveConfig({ rootDir: root }).githubTokenCandidates,
  onAuthFailureRefreshToken: async (failedToken: string) => {
    if (isAiStudioContainerEnv(process.env)) return null;
    const fresh = await refreshEnvGitHubPat({
      envFilePath,
      currentToken: failedToken,
      username: resolved.githubOwner || '',
      timeoutMs: 12_000,
      forceReplaceInvalidToken: true,
    });
    if (fresh) {
      githubTokenLive = fresh;
      return { token: fresh, source: 'file:.env:CINETRACK_GITHUB_PAT' as const };
    }
    return null;
  },
  onLocalDataMutated: (reason: string) => {
    schedulePostMutationSync?.(reason);
  },
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

async function startServer() {
  // GitHub OAuth token'ları (~8 saat) süresi dolduğunda Windows Kimlik Yöneticisi'nden
  // (Git Credential Manager) taze token alınır; .env ve canlı senkron yapılandırması güncellenir.
  const applyFreshGitHubToken = async (reason: string, timeoutMs = 45_000): Promise<void> => {
    if (isAiStudioContainerEnv(process.env)) return;
    try {
      const fresh = await refreshEnvGitHubPat({
        envFilePath,
        currentToken: githubTokenLive,
        username: resolved.githubOwner || '',
        timeoutMs,
      });
      if (fresh) {
        githubTokenLive = fresh;
        persistentStore.updateGitHubToken(fresh, 'file:.env:CINETRACK_GITHUB_PAT');
        console.log(`[GitHub-Token] ${reason}: Kimlik Yöneticisi'nden taze token alındı (.env güncellendi).`);
      }
    } catch (e: any) {
      console.warn('[GitHub-Token] Yenileme atlandı:', e?.message || e);
    }
  };
  await applyFreshGitHubToken('başlangıç', 8_000);

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
      `Cinethos is running at http://${listenHost}:${port} (bind policy: ${bindHost}, ${isDevMode ? 'development' : 'production'})`
    );
    console.log('Profil ve izleme listesi: Yerel dosya sistemi (data/cinetrack-data.json)');
    const syncStatus = persistentStore.getSyncStatus();
    console.log(
      `Kalıcı Veri Deposu: ${syncStatus.mode === 'github' ? `GitHub Uzak Eşitleme (${syncStatus.remoteTarget?.repo})` : 'Yerel Depolama (data/catalog & data/profiles)'}`
    );
    if (!resolved.tmdbApiKey) {
      console.log('TMDB_API_KEY is not configured; running in fallback demo mode.');
    }

    let mutationDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingMutationWhileBusy = false;
    const MUTATION_AUTO_SYNC_DEBOUNCE_MS = 3500;

    // Arka planda kayıpsız iki yönlü GitHub eşitlemesi çalıştırır (reconcileWithGitHub hiçbir kaydı silmez, birleştirir).
    const runSafeAutoReconcile = async (label: string) => {
      try {
        const currentStatus = persistentStore.getSyncStatus();
        if (!currentStatus.configured) return;
        if (persistentStore.isSyncBusy()) {
          pendingMutationWhileBusy = true;
          return;
        }
        const report = await persistentStore.reconcileWithGitHub();
        if (report.ok) {
          console.log(
            `[Auto-Sync:${label}] Kayıpsız iki yönlü eşitleme tamamlandı (indirilen: ${report.filesDownloaded.length}, yüklenen: ${report.filesUploaded.length}, birleştirilen: ${report.filesMerged.length}, doğrulandı: ${report.verifiedEqual}).`
          );
        } else if (report.errors.length > 0) {
          console.warn(
            `[Auto-Sync:${label}] Eşitleme uyarısı:`,
            redactSecrets(
              report.errors.map((e) => e.message).join('; '),
              persistentStore.getKnownSecretsForRedaction()
            )
          );
        }
      } catch (err: any) {
        console.error(
          `[Auto-Sync:${label}] Otomatik senkronizasyon hatası:`,
          redactSecrets(err?.message || String(err), persistentStore.getKnownSecretsForRedaction())
        );
      } finally {
        if (pendingMutationWhileBusy) {
          pendingMutationWhileBusy = false;
          schedulePostMutationSync?.('bekleyen-kayit');
        }
      }
    };

    schedulePostMutationSync = (_reason: string) => {
      if (mutationDebounceTimer) {
        clearTimeout(mutationDebounceTimer);
      }
      mutationDebounceTimer = setTimeout(() => {
        mutationDebounceTimer = null;
        void runSafeAutoReconcile('otomatik-kayit');
      }, MUTATION_AUTO_SYNC_DEBOUNCE_MS);
      if (typeof mutationDebounceTimer.unref === 'function') {
        mutationDebounceTimer.unref();
      }
    };

    const startupSyncTimer = setTimeout(() => {
      void runSafeAutoReconcile('başlangıç');
    }, 1500);
    if (typeof startupSyncTimer.unref === 'function') {
      startupSyncTimer.unref();
    }

    // 5 dakikada bir otomatik arka plan eşitlemesi (kayıpsız iki yönlü birleştirme)
    const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
    const autoSyncTimer = setInterval(() => {
      void runSafeAutoReconcile('periyodik');
    }, AUTO_SYNC_INTERVAL_MS);

    if (typeof autoSyncTimer.unref === 'function') {
      autoSyncTimer.unref();
    }

    // GitHub OAuth token süresi (~8 saat) dolmadan 6 saatte bir tazele
    const TOKEN_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
    const tokenRefreshTimer = setInterval(() => {
      applyFreshGitHubToken('periyodik').catch(() => undefined);
    }, TOKEN_REFRESH_INTERVAL_MS);

    if (typeof tokenRefreshTimer.unref === 'function') {
      tokenRefreshTimer.unref();
    }

    // OPS-01: SIGTERM/SIGINT'te yeni istek almayı bırak, zamanlayıcıları temizle,
    // sürmekte olan eşitleme/yazmayı bitir, sonra çık.
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[Shutdown] ${signal} alındı; yeni istekler kapatılıyor…`);
      clearInterval(autoSyncTimer);
      clearInterval(tokenRefreshTimer);
      clearTimeout(startupSyncTimer);
      if (mutationDebounceTimer) clearTimeout(mutationDebounceTimer);

      const forceExitTimer = setTimeout(() => {
        console.warn('[Shutdown] Kapanış 10 sn içinde tamamlanmadı; süreç zorla kapatılıyor.');
        process.exit(1);
      }, 10_000);
      forceExitTimer.unref?.();

      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });

      const deadline = Date.now() + 5_000;
      while (persistentStore.isSyncBusy() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      clearTimeout(forceExitTimer);
      console.log('[Shutdown] Güvenli kapanış tamamlandı.');
      process.exit(0);
    };
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));
  });
}

startServer();

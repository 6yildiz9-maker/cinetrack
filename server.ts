import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDataDocument, CURRENT_SCHEMA_VERSION } from './src/core/cinetrack-core.ts';
import { createCineTrackApp } from './src/server/app.ts';

void normalizeDataDocument;
void CURRENT_SCHEMA_VERSION;

const root = path.dirname(fileURLToPath(import.meta.url));
const CINETRACK_HOST = '127.0.0.1';
const port = Number(process.env.PORT) || Number(process.env.CINETRACK_PORT) || 3000;
const host = process.env.CINETRACK_HOST || CINETRACK_HOST;

const dataDir = path.join(root, 'data');
const maxDataBytes = 2_000_000;
const maxProfiles = 20;
const maxItemsPerProfile = 5000;

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

const { app, storage } = createCineTrackApp({
  dataDir,
  maxDataBytes,
  maxProfiles,
  maxItemsPerProfile,
  tmdbApiKey,
  ...(optionalAuthToken ? { authToken: optionalAuthToken } : {}),
});

// Setup Vite middleware (explicit --dev only) or static dist serving (production default)
async function startServer() {
  const isDevMode = process.env.NODE_ENV !== 'production' && process.argv.includes('--dev');

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
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, host, port },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(port, host, () => {
    console.log(`CineTrack is running at http://${host}:${port} (${isDevMode ? 'development' : 'production'})`);
    console.log(`Profil ve izleme listesi: ${storage.dataFile}`);
    if (!tmdbApiKey) {
      console.log('TMDB_API_KEY is not configured; running in fallback demo mode.');
    }
  });
}

startServer();

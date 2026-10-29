import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

import { parseDotenvContent, resolveConfig } from '../src/server/config.ts';
import {
  createCineTrackApp,
  createSpaFallbackMiddleware,
  isStaticAssetRequestPath,
} from '../src/server/app.ts';
import { PersistentDataStore } from '../src/server/persistent-store.ts';
import { reconcileUserDataDocumentsLossless } from '../src/server/github-bidirectional-sync.ts';
import {
  isAllowedPosterUrl,
  PosterCacheManager,
  getPosterCacheStats,
} from '../src/server/excel-profile-backup.ts';
import { resolveMediaType, makeMediaKey } from '../src/core/keys.ts';
import { enforceStrictMediaTypePool } from '../src/core/recommendation-orchestrator.ts';
import { normalizeProfile } from '../src/core/cinetrack-core.ts';
import {
  enqueueOfflineSyncSnapshot,
  loadOfflineSyncSnapshot,
  clearOfflineSyncSnapshot,
  hasUnpersistedOfflineFallback,
} from '../src/services/offline-queue.ts';
import {
  pushServerDataDetailed,
  setLastKnownServerRevision,
} from '../src/services/api.ts';
import {
  ESTIMATED_MOVIE_MINUTES,
  ESTIMATED_TV_EPISODE_MINUTES,
  ESTIMATED_TV_FALLBACK_EPISODES,
  formatWatchTime,
} from '../src/utils/helpers.ts';
import { t } from '../src/i18n/index.ts';

async function withServer(options, fn) {
  const { app } = createCineTrackApp(options);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeMinimalDoc(profiles = [{ id: 'p1', name: 'Test', items: [] }]) {
  return {
    version: 3,
    schemaVersion: 3,
    engineVersion: 'v3.2.0',
    activeProfileId: profiles[0]?.id || 'p1',
    profiles,
  };
}

test('BUG-01 & BUG-05: Loopback dışı arayüzde token yokken yazma/hassas uç noktalar 503 döner, trustProxy sahteciliği engeller ve TMDB hız sınırı varsayılan 60 olur', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bug01-'));
  try {
    // 1) bindHost=0.0.0.0 ve authToken yok -> mutasyonlar ve /api/sync/status 503 auth_required dönmeli
    await withServer(
      {
        dataDir: tmpDir,
        security: { bindHost: '0.0.0.0', trustProxy: false },
      },
      async (baseUrl) => {
        const putRes = await fetch(`${baseUrl}/api/data`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(makeMinimalDoc()),
        });
        assert.equal(putRes.status, 503);
        const putBody = await putRes.json();
        assert.equal(putBody.code, 'auth_required');

        const syncStatusRes = await fetch(`${baseUrl}/api/sync/status`);
        assert.equal(syncStatusRes.status, 503);
        const syncStatusBody = await syncStatusRes.json();
        assert.equal(syncStatusBody.code, 'auth_required');

        // Varsayılan 60 req/dk hız sınırı devrede olmalı (X-RateLimit-Limit: 60)
        const tmdbRes = await fetch(
          `${baseUrl}/api/tmdb?path=${encodeURIComponent('/genre/movie/list')}`
        );
        assert.equal(tmdbRes.status, 200);
        assert.equal(tmdbRes.headers.get('x-ratelimit-limit'), '60');
      }
    );

    // 2) trustProxy=false iken sahte X-Forwarded-Host origin kontrolünü atlatamamalı ve X-Forwarded-For hız sınırını sıfırlayamamalı
    await withServer(
      {
        dataDir: tmpDir,
        security: {
          bindHost: '0.0.0.0',
          authToken: 'gizli-test-parolasi-123',
          trustProxy: false,
          tmdbRateLimitMax: 2,
          tmdbRateLimitWindowMs: 60_000,
        },
      },
      async (baseUrl) => {
        // Kötü niyetli Origin + sahte X-Forwarded-Host -> 403 origin_denied
        const spoofedOriginRes = await fetch(`${baseUrl}/api/data`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer gizli-test-parolasi-123',
            Origin: 'https://evil.example',
            'X-Forwarded-Host': 'evil.example',
          },
          body: JSON.stringify(makeMinimalDoc()),
        });
        assert.equal(spoofedOriginRes.status, 403);
        const spoofedBody = await spoofedOriginRes.json();
        assert.equal(spoofedBody.code, 'origin_denied');

        // Farklı X-Forwarded-For değerleri gönderilse bile aynı soket IP'si üzerinden 3. istek 429 almalı
        const r1 = await fetch(
          `${baseUrl}/api/tmdb?path=${encodeURIComponent('/genre/movie/list')}`,
          { headers: { 'X-Forwarded-For': '203.0.113.1' } }
        );
        const r2 = await fetch(
          `${baseUrl}/api/tmdb?path=${encodeURIComponent('/genre/movie/list')}`,
          { headers: { 'X-Forwarded-For': '203.0.113.2' } }
        );
        const r3 = await fetch(
          `${baseUrl}/api/tmdb?path=${encodeURIComponent('/genre/movie/list')}`,
          { headers: { 'X-Forwarded-For': '203.0.113.3' } }
        );
        assert.equal(r1.status, 200);
        assert.equal(r2.status, 200);
        assert.equal(r3.status, 429);
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('BUG-02 & BUG-07: localStorage kotası dolduğunda çevrimdışı kuyruk bellek yedeğine düşer, baseRevision=0 korunur ve çakışmada yerel yük korunur', async () => {
  const prevStorage = globalThis.localStorage;
  const origFetch = globalThis.fetch;
  try {
    // 1) localStorage kota hatası simülasyonu
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };

    clearOfflineSyncSnapshot();
    const doc = makeMinimalDoc([{ id: 'p1', name: 'Offline', items: [] }]);
    const enq = enqueueOfflineSyncSnapshot(doc, 0);
    assert.equal(enq.persisted, false);
    assert.equal(enq.baseRevision, 0);
    assert.equal(hasUnpersistedOfflineFallback(), true);
    assert.ok(t('offlineQuotaWarning').includes('Sayfayı kapatmadan'));

    const loaded = loadOfflineSyncSnapshot();
    assert.ok(loaded);
    assert.equal(loaded.baseRevision, 0);

    // 2) baseRevision=0 için If-Match: "rev-0" başlığı gönderilmeli ve 409 yanıtında localPayload korunmalı
    let capturedHeaders = {};
    globalThis.fetch = async (_url, init) => {
      capturedHeaders = init?.headers || {};
      return new Response(
        JSON.stringify({
          code: 'revision_conflict',
          error: 'Revizyon uyuşmazlığı',
          currentRevision: 4,
          expectedRevision: 0,
          serverDocument: makeMinimalDoc([{ id: 'p1', name: 'Sunucu', items: [] }]),
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    };

    setLastKnownServerRevision(0);
    const pushRes = await pushServerDataDetailed(doc, { baseRevision: 0 });
    assert.equal(capturedHeaders['If-Match'], '"rev-0"');
    assert.equal(pushRes.ok, false);
    assert.equal(pushRes.status, 409);
    assert.ok(pushRes.conflict);
    assert.deepEqual(pushRes.conflict.localPayload, doc);
  } finally {
    clearOfflineSyncSnapshot();
    globalThis.localStorage = prevStorage;
    globalThis.fetch = origFetch;
  }
});

test('BUG-12 & EXT-05: Güvenlik başlıkları, /api/sync/status token koruması ve PUT /api/data zorunlu If-Match (428 / 412 / 409 / Force-Write)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bug12-'));
  try {
    await withServer(
      {
        dataDir: tmpDir,
        security: { authToken: 'guclu-token-999' },
      },
      async (baseUrl) => {
        // 1) Güvenlik başlıkları
        const healthRes = await fetch(`${baseUrl}/api/health`);
        assert.equal(healthRes.status, 200);
        assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(healthRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
        assert.ok(healthRes.headers.get('content-security-policy')?.includes("default-src 'self'"));
        const healthJson = await healthRes.json();
        assert.ok(healthJson.posterCache);
        assert.equal(typeof healthJson.posterCache.maxBytes, 'number');

        // 2) /api/sync/status token yokken 401, token varken 200
        const unauthSync = await fetch(`${baseUrl}/api/sync/status`);
        assert.equal(unauthSync.status, 401);
        const authSync = await fetch(`${baseUrl}/api/sync/status`, {
          headers: { Authorization: 'Bearer guclu-token-999' },
        });
        assert.equal(authSync.status, 200);

        const authHeaders = {
          'Content-Type': 'application/json',
          Authorization: 'Bearer guclu-token-999',
        };

        // 3) Revizyon 0 iken ilk kayıt başarılı -> revizyon 1 olur
        const firstPut = await fetch(`${baseUrl}/api/data`, {
          method: 'PUT',
          headers: authHeaders,
          body: JSON.stringify(makeMinimalDoc()),
        });
        assert.equal(firstPut.status, 200);
        const firstJson = await firstPut.json();
        assert.equal(firstJson.revision, 1);

        // 4) Revizyon > 0 iken If-Match göndermeden yazma 428 precondition_required dönmeli
        const missingIfMatch = await fetch(`${baseUrl}/api/data`, {
          method: 'PUT',
          headers: authHeaders,
          body: JSON.stringify(makeMinimalDoc()),
        });
        assert.equal(missingIfMatch.status, 428);
        const missingJson = await missingIfMatch.json();
        assert.equal(missingJson.code, 'precondition_required');

        // 5) Bozuk If-Match biçimi 412 dönmeli
        const badIfMatch = await fetch(`${baseUrl}/api/data`, {
          method: 'PUT',
          headers: { ...authHeaders, 'If-Match': 'gecersiz-etag' },
          body: JSON.stringify(makeMinimalDoc()),
        });
        assert.equal(badIfMatch.status, 412);

        // 6) Eski revizyon ("rev-0") gönderildiğinde 409 dönmeli
        const staleIfMatch = await fetch(`${baseUrl}/api/data`, {
          method: 'PUT',
          headers: { ...authHeaders, 'If-Match': '"rev-0"' },
          body: JSON.stringify(makeMinimalDoc()),
        });
        assert.equal(staleIfMatch.status, 409);

        // 7) Doğru If-Match ("rev-1") ile 200 -> revizyon 2
        const validIfMatch = await fetch(`${baseUrl}/api/data`, {
          method: 'PUT',
          headers: { ...authHeaders, 'If-Match': '"rev-1"' },
          body: JSON.stringify(makeMinimalDoc()),
        });
        assert.equal(validIfMatch.status, 200);

        // 8) X-CineTrack-Force-Write: 1 ile açık zorlamalı yazma 200 dönmeli
        const forcedPut = await fetch(`${baseUrl}/api/data`, {
          method: 'PUT',
          headers: { ...authHeaders, 'X-CineTrack-Force-Write': '1' },
          body: JSON.stringify(makeMinimalDoc()),
        });
        assert.equal(forcedPut.status, 200);
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('BUG-08 & EXT-12: Excel dışa aktarma profileSnapshot beyaz liste doğrulaması ve boş disliked: [] temizlemesinin korunması', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bug08-'));
  try {
    await withServer({ dataDir: tmpDir }, async (baseUrl) => {
      // Sunucuya başlangıçta 1 adet disliked öğesi olan profil kaydet
      const seedDoc = makeMinimalDoc([
        {
          id: 'p1',
          name: 'Ana Profil',
          items: [
            {
              id: 550,
              media_type: 'movie',
              title: 'Fight Club',
              status: 'completed',
              personal_rating: 9,
              addedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          preferences: {
            disliked: ['movie:999'],
            providers: [],
            mood: '',
            reminders: false,
            notified: [],
          },
        },
      ]);

      const seedRes = await fetch(`${baseUrl}/api/data`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(seedDoc),
      });
      assert.equal(seedRes.status, 200);

      // İstemci anlık görüntüsünde disliked: [] açıkça boşaltılmış ve yabancı enjekte alanlar eklenmiş
      const previewRes = await fetch(`${baseUrl}/api/backup/excel/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: 'p1',
          embedPosters: false,
          profileSnapshot: {
            id: 'p1',
            name: 'Ana Profil',
            __injectedSecret: 'evil-payload',
            items: [
              {
                id: 550,
                media_type: 'movie',
                title: 'Fight Club',
                status: 'completed',
                personal_rating: 9,
                __evilField: 'drop-me',
              },
            ],
            preferences: {
              disliked: [],
            },
          },
        }),
      });
      assert.equal(previewRes.status, 200);
      const previewJson = await previewRes.json();
      assert.equal(previewJson.ok, true);
      // EXT-12: Açıkça gönderilen disliked: [] sunucudaki eski ['movie:999'] ile ezilmemeli!
      assert.equal(previewJson.completeness.uniqueDislikedCount, 0);
      assert.equal(previewJson.sheetCounts['İlgilenmiyorum'].total, 0);
      assert.equal(previewJson.sheetCounts['İzlenen'].total, 1);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('EXT-01, EXT-03 & EXT-04: Poster SSRF engeli, önbellek TTL/boyut tahliyesi ve bilinmeyen media_type ayrımı', () => {
  // EXT-01: Yalnızca HTTPS + izinli TMDB poster alan adları kabul edilmeli
  assert.equal(isAllowedPosterUrl('https://image.tmdb.org/t/p/w185/abc.jpg'), true);
  assert.equal(isAllowedPosterUrl('http://image.tmdb.org/t/p/w185/abc.jpg'), false);
  assert.equal(isAllowedPosterUrl('https://127.0.0.1/secret.jpg'), false);
  assert.equal(isAllowedPosterUrl('https://169.254.169.254/latest/meta-data/'), false);
  assert.equal(isAllowedPosterUrl('https://evil.example.com/t/p/w185/abc.jpg'), false);
  assert.equal(isAllowedPosterUrl('https://user:pass@image.tmdb.org/t/p/w185/abc.jpg'), false);

  // EXT-03: PosterCacheManager TTL ve maxBytes tahliyesi
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-postercache-'));
  try {
    const baseNow = Date.now();
    const fOld = path.join(cacheDir, 'old.jpg');
    const fMid = path.join(cacheDir, 'mid.jpg');
    const fNew = path.join(cacheDir, 'new.jpg');
    fs.writeFileSync(fOld, Buffer.alloc(600, 0xaa));
    fs.writeFileSync(fMid, Buffer.alloc(600, 0xbb));
    fs.writeFileSync(fNew, Buffer.alloc(600, 0xcc));

    // fOld süresi dolmuş (10 gün önce), fMid 2 saat önce, fNew 1 saat önce
    const tenDaysAgoSec = (baseNow - 10 * 24 * 60 * 60 * 1000) / 1000;
    const twoHoursAgoSec = (baseNow - 2 * 60 * 60 * 1000) / 1000;
    const oneHourAgoSec = (baseNow - 1 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(fOld, tenDaysAgoSec, tenDaysAgoSec);
    fs.utimesSync(fMid, twoHoursAgoSec, twoHoursAgoSec);
    fs.utimesSync(fNew, oneHourAgoSec, oneHourAgoSec);

    // TTL = 5 gün, maxBytes = 800 bayt -> fOld TTL'den, fMid boyuttan silinmeli; yalnızca fNew kalmalı
    const mgr = new PosterCacheManager(cacheDir, {
      ttlMs: 5 * 24 * 60 * 60 * 1000,
      maxBytes: 800,
      nowMs: () => baseNow,
    });
    assert.ok(mgr);
    assert.equal(fs.existsSync(fOld), false);
    assert.equal(fs.existsSync(fMid), false);
    assert.equal(fs.existsSync(fNew), true);

    const stats = getPosterCacheStats(cacheDir, 800, 5 * 24 * 60 * 60 * 1000);
    assert.equal(stats.filesCount, 1);
    assert.equal(stats.totalBytes, 600);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  // EXT-04: Tür ipucu olmayan kayıtlar sessizce 'movie' sayılmamalı
  assert.equal(resolveMediaType({ id: 42 }), 'unknown');
  assert.equal(makeMediaKey({ id: 42 }), 'unknown:42');
  assert.equal(resolveMediaType({ id: 42, first_air_date: '2024-05-01' }), 'tv');
  assert.equal(resolveMediaType({ id: 42, release_date: '2024-05-01' }), 'movie');

  const filteredMovies = enforceStrictMediaTypePool(
    [
      { id: 1, media_type: 'movie', title: 'Gerçek Film' },
      { id: 2, name: 'Belirsiz Kayıt' }, // first_air_date yok, media_type yok -> unknown -> elenmeli
    ],
    'movie'
  );
  assert.equal(filteredMovies.length, 1);
  assert.equal(filteredMovies[0].id, 1);
});

test('EXT-06, EXT-07 & EXT-08: Global hata maskeleme, SPA fallback eksik varlık 404 koruması ve TMDB language doğrulaması', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-ext06-'));
  try {
    const fakeSecretPat = 'ghp_SuperSecretTokenValue1234567890ABCD';
    const store = new PersistentDataStore({
      dataDir: tmpDir,
      githubToken: fakeSecretPat,
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
    });

    await withServer(
      {
        dataDir: tmpDir,
        persistentStore: store,
        registerCustomRoutes: (app) => {
          app.get('/api/test-boom', () => {
            throw new Error(`Beklenmeyen patlama: token=${fakeSecretPat}`);
          });
        },
      },
      async (baseUrl) => {
        // EXT-06: Hata yanıtı 500 JSON dönmeli, stack veya token sızdırmamalı ve requestId içermeli
        const boomRes = await fetch(`${baseUrl}/api/test-boom`);
        assert.equal(boomRes.status, 500);
        const rawText = await boomRes.text();
        assert.equal(rawText.includes(fakeSecretPat), false);
        const boomJson = JSON.parse(rawText);
        assert.equal(boomJson.error, 'Sunucu hatası oluştu.');
        assert.equal(typeof boomJson.requestId, 'string');
        assert.equal('stack' in boomJson, false);

        // EXT-08: Bozuk language parametresi 400 dönmeli
        const badLangRes = await fetch(
          `${baseUrl}/api/tmdb?path=${encodeURIComponent('/genre/movie/list')}&language=${encodeURIComponent('tr-TR;DROP')}`
        );
        assert.equal(badLangRes.status, 400);

        const okLangRes = await fetch(
          `${baseUrl}/api/tmdb?path=${encodeURIComponent('/genre/movie/list')}&language=en-US`
        );
        assert.equal(okLangRes.status, 200);
      }
    );

    // EXT-07: Eksik statik varlıklar 404 dönmeli, gerçek SPA derin bağlantıları index.html dönmeli
    assert.equal(isStaticAssetRequestPath('/assets/chunk-123.js'), true);
    assert.equal(isStaticAssetRequestPath('/favicon.ico'), true);
    assert.equal(isStaticAssetRequestPath('/discover/sci-fi'), false);

    const indexPath = path.join(tmpDir, 'index.html');
    fs.writeFileSync(indexPath, '<!doctype html><html><body><div id="root"></div></body></html>');
    const spaApp = express();
    spaApp.use(createSpaFallbackMiddleware(indexPath));
    const spaServer = http.createServer(spaApp);
    await new Promise((resolve) => spaServer.listen(0, '127.0.0.1', resolve));
    const spaUrl = `http://127.0.0.1:${spaServer.address().port}`;
    try {
      const missingAsset = await fetch(`${spaUrl}/assets/missing-bundle.js`);
      assert.equal(missingAsset.status, 404);

      const deepLink = await fetch(`${spaUrl}/discover/movies`);
      assert.equal(deepLink.status, 200);
      const html = await deepLink.text();
      assert.ok(html.includes('<div id="root"></div>'));
    } finally {
      await new Promise((resolve) => spaServer.close(resolve));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('EXT-09, EXT-10, EXT-11, EXT-13 & BUG-13.2: Dotenv ayrıştırıcı, yapılandırma önceliği, açık katalog onayı, 30 günlük silme mezar taşı ve tahmini süre sabitleri', async () => {
  // EXT-13: Tırnaklı, export önekli, çok satırlı, satır içi yorumlu ve bozuk satırlı .env ayrıştırma
  const dotenvSample = [
    '# Yorum satırı',
    'export TMDB_API_KEY="canli-anahtar-123" # satır içi yorum',
    "CINETRACK_TOKEN='tek-tirnak#icinde-hash'",
    'MULTILINE_NOTE="satir1',
    'satir2"',
    'BOZUK SATIR ESITTIR YOK',
    'CINETRACK_PORT=4100 # port yorumu',
  ].join('\n');

  const parsed = parseDotenvContent(dotenvSample, '.env.test');
  assert.equal(parsed.values.TMDB_API_KEY, 'canli-anahtar-123');
  assert.equal(parsed.values.CINETRACK_TOKEN, 'tek-tirnak#icinde-hash');
  assert.equal(parsed.values.MULTILINE_NOTE, 'satir1\nsatir2');
  assert.equal(parsed.values.CINETRACK_PORT, '4100');
  assert.equal(parsed.warnings.length, 1);

  // EXT-09: process.env > .env.local > .env önceliği ve CINETRACK_GITHUB_PAT > CINETRACK_GITHUB_TOKEN
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-cfg-'));
  try {
    fs.writeFileSync(
      path.join(cfgDir, '.env'),
      [
        'PORT=3100',
        'CINETRACK_GITHUB_TOKEN=legacy-env-token',
        'CINETRACK_GITHUB_PAT=pat-from-dotenv',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(cfgDir, '.env.local'),
      ['PORT=3200', 'CINETRACK_GITHUB_PAT=pat-from-dotenv-local'].join('\n')
    );

    const cfg = resolveConfig({
      rootDir: cfgDir,
      processEnv: {
        PORT: '3300',
      },
    });
    assert.equal(cfg.port, 3300);
    assert.equal(cfg.githubToken, 'pat-from-dotenv-local');
    assert.equal(cfg.githubTokenSource, 'dotenv_local_pat');
    assert.ok(cfg.warnings.every((w) => !w.includes('pat-from-dotenv')));

    // EXT-10: /api/sync/public-catalog-consent TMDB atıf onayı zorunluluğu
    const store = new PersistentDataStore({
      dataDir: cfgDir,
      githubToken: 'ghp_testtoken123456',
      owner: 'owner',
      repo: 'public-repo',
      branch: 'main',
      isPublicRepo: false,
      allowPublicCatalogSync: false,
    });
    await withServer({ dataDir: cfgDir, persistentStore: store }, async (baseUrl) => {
      const missingAttribution = await fetch(`${baseUrl}/api/sync/public-catalog-consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow: true, confirmTmdbAttribution: false }),
      });
      assert.equal(missingAttribution.status, 400);

      const granted = await fetch(`${baseUrl}/api/sync/public-catalog-consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow: true, confirmTmdbAttribution: true }),
      });
      assert.equal(granted.status, 200);
      const grantedJson = await granted.json();
      assert.equal(grantedJson.allowPublicCatalogSync, true);
    });
  } finally {
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }

  // EXT-11: 30 günlük deleted_keys mezar taşı silinen öğenin uzaktan geri dirilmesini engeller; 30 günü aşanlar temizlenir
  const nowMs = Date.now();
  const recentDeleteIso = new Date(nowMs - 2 * 24 * 60 * 60 * 1000).toISOString();
  const oldAddedIso = new Date(nowMs - 10 * 24 * 60 * 60 * 1000).toISOString();
  const expiredDeleteIso = new Date(nowMs - 45 * 24 * 60 * 60 * 1000).toISOString();

  const normalizedProf = normalizeProfile({
    id: 'p1',
    name: 'Profil',
    items: [],
    deleted_keys: {
      'movie:100': recentDeleteIso,
      'movie:200': expiredDeleteIso,
    },
  });
  assert.equal(Boolean(normalizedProf.deleted_keys?.['movie:100']), true);
  assert.equal(Boolean(normalizedProf.deleted_keys?.['movie:200']), false);

  const localDoc = makeMinimalDoc([
    {
      id: 'p1',
      name: 'Profil',
      items: [],
      deleted_keys: { 'movie:100': recentDeleteIso },
    },
  ]);
  const remoteDoc = makeMinimalDoc([
    {
      id: 'p1',
      name: 'Profil',
      items: [
        {
          id: 100,
          media_type: 'movie',
          title: 'Silinmiş Film',
          status: 'watchlist',
          addedAt: oldAddedIso,
          updatedAt: oldAddedIso,
        },
      ],
    },
  ]);

  const reconciled = reconcileUserDataDocumentsLossless(localDoc, remoteDoc);
  const mergedProfile = reconciled.mergedDoc.profiles[0];
  assert.equal(mergedProfile.items.length, 0, 'Yerelde daha yeni mezar taşı olan öğe uzaktan geri dönmemeli');
  assert.equal(mergedProfile.deleted_keys?.['movie:100'], recentDeleteIso);

  // BUG-13.2: Sabitler dışa aktarılmış ve formatWatchTime ile tutarlı olmalı
  assert.equal(ESTIMATED_MOVIE_MINUTES, 110);
  assert.equal(ESTIMATED_TV_EPISODE_MINUTES, 45);
  assert.equal(ESTIMATED_TV_FALLBACK_EPISODES, 10);
  assert.equal(formatWatchTime(ESTIMATED_MOVIE_MINUTES), '1 sa 50 dk');
});

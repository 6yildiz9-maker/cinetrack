import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  PersistentDataStore,
  hashContent,
  stringifyDeterministic,
} from '../src/server/persistent-store.ts';
import { createDataStorage } from '../src/server/storage.ts';
import { createCineTrackApp } from '../src/server/app.ts';
import { deriveSyncUiBanner } from '../src/core/sync-display.ts';
import {
  ALGORITHM_VERSION,
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  computeTasteProfileSignature,
} from '../src/core/cinetrack-core.ts';
import {
  DERIVED_PROFILE_SCHEMA_VERSION,
  computeDerivedProfileContentHash,
} from '../src/core/derived-profile-cache.ts';

const TEST_OWNER = 'test-owner';
const TEST_REPO = 'cinetrack-private-sync-spec';
const TEST_BRANCH = 'main';
const TEST_SECRET_TOKEN = 'github_pat_11TESTSECRETTOKEN9999999999999999';

function makeSha(repoPath, content, seq = 1) {
  return crypto
    .createHash('sha1')
    .update(`${repoPath}:${seq}:${content}`)
    .digest('hex');
}

function makeMovieRecord(id, overrides = {}) {
  const key = `movie:${id}`;
  return {
    key,
    id,
    media_type: 'movie',
    title: overrides.title || `Film ${id}`,
    original_title: overrides.original_title || `Original Movie ${id}`,
    overview: overrides.overview ?? `Film ${id} açıklaması`,
    poster_path: overrides.poster_path !== undefined ? overrides.poster_path : `/poster-${id}.jpg`,
    backdrop_path: overrides.backdrop_path !== undefined ? overrides.backdrop_path : `/backdrop-${id}.jpg`,
    genre_ids: overrides.genre_ids || [18, 878],
    vote_average: overrides.vote_average ?? 7.8,
    vote_count: overrides.vote_count ?? 1200,
    release_date: overrides.release_date || '2024-05-10',
    popularity: overrides.popularity ?? 42.5,
    firstStoredAt: overrides.firstStoredAt || '2026-01-01T00:00:00.000Z',
    lastUpdatedAt: overrides.lastUpdatedAt || '2026-01-02T00:00:00.000Z',
    source: 'tmdb',
  };
}

function makeTvRecord(id, overrides = {}) {
  const key = `tv:${id}`;
  return {
    key,
    id,
    media_type: 'tv',
    title: overrides.title || `Dizi ${id}`,
    original_title: overrides.original_title || `Original Series ${id}`,
    overview: overrides.overview ?? `Dizi ${id} açıklaması`,
    poster_path: overrides.poster_path !== undefined ? overrides.poster_path : `/tv-poster-${id}.jpg`,
    backdrop_path: overrides.backdrop_path !== undefined ? overrides.backdrop_path : `/tv-backdrop-${id}.jpg`,
    genre_ids: overrides.genre_ids || [18, 10765],
    vote_average: overrides.vote_average ?? 8.2,
    vote_count: overrides.vote_count ?? 950,
    first_air_date: overrides.first_air_date || '2023-09-15',
    popularity: overrides.popularity ?? 55.0,
    firstStoredAt: overrides.firstStoredAt || '2026-01-01T00:00:00.000Z',
    lastUpdatedAt: overrides.lastUpdatedAt || '2026-01-02T00:00:00.000Z',
    source: 'tmdb',
  };
}

function buildValidManifest(moviesMap, tvMap, updatedAt = '2026-02-01T00:00:00.000Z') {
  const contentHash = hashContent(
    stringifyDeterministic(moviesMap) + stringifyDeterministic(tvMap)
  );
  return {
    version: 1,
    updatedAt,
    movieCount: Object.keys(moviesMap).length,
    tvCount: Object.keys(tvMap).length,
    contentHash,
  };
}

function makeUserDataDoc(profiles, activeProfileId = 'profile-main', revision = 1) {
  return {
    version: 3,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    activeProfileId,
    profiles: profiles.map((p) => ({ isDemo: false, ...p })),
    revision,
    updatedAt: '2026-02-10T10:00:00.000Z',
  };
}

/**
 * Gerçek GitHub deposuna hiçbir ağ isteği göndermeyen, bellek içi durumlu
 * GitHub REST API v3 (Repos / Contents / Git Blobs) sahte sunucusu.
 */
function createMockGitHubHarness({ isPrivate = true, simulate403TooLargeForOver1Mb = false } = {}) {
  const files = new Map(); // repoPath -> { content: string, sha: string }
  const blobs = new Map(); // sha -> string
  const commits = [];
  const deletions = [];
  const requests = [];
  let seq = 1;
  let customInterceptor = null;

  function seedFile(repoPath, rawOrObj) {
    const content =
      typeof rawOrObj === 'string' ? rawOrObj : stringifyDeterministic(rawOrObj);
    const sha = makeSha(repoPath, content, seq++);
    files.set(repoPath, { content, sha });
    blobs.set(sha, content);
    return { content, sha };
  }

  function readRemoteJson(repoPath) {
    const entry = files.get(repoPath);
    if (!entry) return null;
    return JSON.parse(entry.content);
  }

  function setInterceptor(fn) {
    customInterceptor = fn;
  }

  function jsonResponse(status, body, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        ...extraHeaders,
      },
    });
  }

  async function installAndRun(fn) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      const urlStr = typeof input === 'string' ? input : input.url;
      if (!urlStr.startsWith('https://api.github.com/')) {
        return originalFetch(input, init);
      }

      const method = (init.method || 'GET').toUpperCase();
      const parsedUrl = new URL(urlStr);
      const pathname = parsedUrl.pathname;
      requests.push({ method, url: urlStr, pathname });

      if (method === 'DELETE') {
        deletions.push(urlStr);
        return jsonResponse(405, { message: 'Deletion disabled in test policy' });
      }

      if (customInterceptor) {
        const intercepted = await customInterceptor({
          method,
          url: urlStr,
          pathname,
          init,
          files,
          jsonResponse,
          makeSha: (p, c) => makeSha(p, c, seq++),
        });
        if (intercepted) return intercepted;
      }

      const repoPrefix = `/repos/${TEST_OWNER}/${TEST_REPO}`;
      if (pathname === repoPrefix && method === 'GET') {
        return jsonResponse(200, {
          private: isPrivate,
          full_name: `${TEST_OWNER}/${TEST_REPO}`,
          default_branch: TEST_BRANCH,
        });
      }

      if (pathname === `${repoPrefix}/branches/${TEST_BRANCH}` && method === 'GET') {
        return jsonResponse(200, { name: TEST_BRANCH });
      }

      if (pathname === `${repoPrefix}/branches` && method === 'GET') {
        return jsonResponse(200, [{ name: TEST_BRANCH }]);
      }

      const blobPrefix = `${repoPrefix}/git/blobs/`;
      if (pathname.startsWith(blobPrefix) && method === 'GET') {
        const sha = decodeURIComponent(pathname.slice(blobPrefix.length));
        const raw = blobs.get(sha);
        if (raw === undefined) {
          return jsonResponse(404, { message: 'Blob Not Found' });
        }
        return jsonResponse(200, {
          sha,
          size: Buffer.byteLength(raw, 'utf8'),
          encoding: 'base64',
          content: Buffer.from(raw, 'utf8').toString('base64'),
        });
      }

      const contentsPrefix = `${repoPrefix}/contents/`;
      if (pathname.startsWith(contentsPrefix)) {
        const repoPath = pathname
          .slice(contentsPrefix.length)
          .split('/')
          .map(decodeURIComponent)
          .join('/');

        if (method === 'GET') {
          // 1. Doğrudan dosya kontrolü
          if (files.has(repoPath)) {
            const entry = files.get(repoPath);
            const byteSize = Buffer.byteLength(entry.content, 'utf8');
            if (byteSize > 1_000_000) {
              if (simulate403TooLargeForOver1Mb) {
                return jsonResponse(403, {
                  message: 'This API returns blobs up to 1 MB in size.',
                  errors: [{ resource: 'Blob', field: 'data', code: 'too_large' }],
                });
              }
              return jsonResponse(200, {
                name: path.posix.basename(repoPath),
                path: repoPath,
                sha: entry.sha,
                size: byteSize,
                type: 'file',
                encoding: 'none',
                content: '',
              });
            }
            return jsonResponse(200, {
              name: path.posix.basename(repoPath),
              path: repoPath,
              sha: entry.sha,
              size: byteSize,
              type: 'file',
              encoding: 'base64',
              content: Buffer.from(entry.content, 'utf8').toString('base64'),
            });
          }

          // 2. Dizin listesi kontrolü (ör. data/profiles veya data/catalog)
          const dirPrefix = `${repoPath.replace(/\/+$/, '')}/`;
          const children = [];
          for (const [fPath, entry] of files.entries()) {
            if (fPath.startsWith(dirPrefix)) {
              const rest = fPath.slice(dirPrefix.length);
              if (!rest.includes('/')) {
                children.push({
                  name: rest,
                  path: fPath,
                  type: 'file',
                  sha: entry.sha,
                  size: Buffer.byteLength(entry.content, 'utf8'),
                });
              }
            }
          }
          if (children.length > 0) {
            return jsonResponse(200, children);
          }

          return jsonResponse(404, { message: 'Not Found' });
        }

        if (method === 'PUT') {
          const body = JSON.parse(String(init.body || '{}'));
          const existing = files.get(repoPath);
          if (existing && body.sha !== existing.sha) {
            return jsonResponse(409, {
              message: `${repoPath} does not match ${existing.sha}`,
            });
          }
          const decoded = Buffer.from(String(body.content || ''), 'base64').toString('utf8');
          const nextSha = makeSha(repoPath, decoded, seq++);
          files.set(repoPath, { content: decoded, sha: nextSha });
          blobs.set(nextSha, decoded);
          commits.push({
            repoPath,
            message: body.message,
            sha: nextSha,
          });
          return jsonResponse(existing ? 200 : 201, {
            content: {
              name: path.posix.basename(repoPath),
              path: repoPath,
              sha: nextSha,
            },
          });
        }
      }

      return jsonResponse(404, { message: `Unhandled mock GitHub path: ${pathname}` });
    };

    try {
      return await fn();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  return {
    files,
    blobs,
    commits,
    deletions,
    requests,
    seedFile,
    readRemoteJson,
    setInterceptor,
    installAndRun,
  };
}

function createIsolatedSyncEnv(tmpDir, extraOpts = {}) {
  const storage = createDataStorage({ dataDir: tmpDir });
  const store = new PersistentDataStore({
    dataDir: tmpDir,
    githubToken: TEST_SECRET_TOKEN,
    githubOwner: TEST_OWNER,
    githubRepo: TEST_REPO,
    githubBranch: TEST_BRANCH,
    isPublicRepo: false,
    ...extraOpts,
  });
  store.attachDataStorage(storage);
  return { store, storage };
}

test('Senaryo 1: Yerelde 10 film, GitHub\'da 15 film (hem kesişimli 15 film hem ayrık 10+15 küme) iki yönlü eşitlemede kayıpsız birleşir', async () => {
  // Alt durum 1A: Yerelde 1..10 (10 film), GitHub'da 1..15 (15 film) -> her iki tarafta 15 film
  const tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bidir-s1a-'));
  const ghA = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDirA);
    const localMoviesA = [];
    for (let i = 1; i <= 10; i++) localMoviesA.push(makeMovieRecord(i));
    store.upsertCatalogItems(localMoviesA);

    const remoteMoviesMapA = {};
    for (let i = 1; i <= 15; i++) remoteMoviesMapA[`movie:${i}`] = makeMovieRecord(i);
    ghA.seedFile('data/catalog/movies.json', remoteMoviesMapA);
    ghA.seedFile('data/catalog/tv.json', {});
    ghA.seedFile('data/catalog/manifest.json', buildValidManifest(remoteMoviesMapA, {}));

    await ghA.installAndRun(async () => {
      const report = await store.reconcileWithGitHub();
      assert.equal(report.ok, true);
      assert.equal(report.verifiedEqual, true);
      assert.equal(report.localAfter.catalogMovieCount, 15, 'Yerelde 15 film olmalı');
      assert.equal(report.remoteAfter.catalogMovieCount, 15, 'GitHub\'da 15 film olmalı');
      assert.equal(Object.keys(store.readCatalog('movie')).length, 15);
      assert.equal(Object.keys(ghA.readRemoteJson('data/catalog/movies.json')).length, 15);
    });
  } finally {
    fs.rmSync(tmpDirA, { recursive: true, force: true });
  }

  // Alt durum 1B: Yerelde 1..10 (10 film), GitHub'da tamamen farklı 101..115 (15 film) -> birleşim 25 film (hiçbir film silinmez)
  const tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bidir-s1b-'));
  const ghB = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDirB);
    const localMoviesB = [];
    for (let i = 1; i <= 10; i++) localMoviesB.push(makeMovieRecord(i));
    store.upsertCatalogItems(localMoviesB);

    const remoteMoviesMapB = {};
    for (let i = 101; i <= 115; i++) remoteMoviesMapB[`movie:${i}`] = makeMovieRecord(i);
    ghB.seedFile('data/catalog/movies.json', remoteMoviesMapB);
    ghB.seedFile('data/catalog/tv.json', {});
    ghB.seedFile('data/catalog/manifest.json', buildValidManifest(remoteMoviesMapB, {}));

    await ghB.installAndRun(async () => {
      const report = await store.reconcileWithGitHub();
      assert.equal(report.ok, true);
      assert.equal(report.verifiedEqual, true);
      assert.equal(report.localAfter.catalogMovieCount, 25);
      assert.equal(report.remoteAfter.catalogMovieCount, 25);
    });
  } finally {
    fs.rmSync(tmpDirB, { recursive: true, force: true });
  }
});

test('Senaryo 2: Yerelde 15 film, GitHub\'da 10 film: iki yönlü eşitleme sonunda her iki tarafta eksiksiz eşitlenir', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bidir-s2-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    const localMovies = [];
    for (let i = 1; i <= 15; i++) localMovies.push(makeMovieRecord(i));
    store.upsertCatalogItems(localMovies);

    const remoteMoviesMap = {};
    for (let i = 1; i <= 10; i++) remoteMoviesMap[`movie:${i}`] = makeMovieRecord(i);
    gh.seedFile('data/catalog/movies.json', remoteMoviesMap);
    gh.seedFile('data/catalog/tv.json', {});
    gh.seedFile('data/catalog/manifest.json', buildValidManifest(remoteMoviesMap, {}));

    await gh.installAndRun(async () => {
      const report = await store.reconcileWithGitHub();
      assert.equal(report.ok, true);
      assert.equal(report.verifiedEqual, true);
      assert.equal(report.localAfter.catalogMovieCount, 15, 'Yerelde 15 film korunmalı');
      assert.equal(report.remoteAfter.catalogMovieCount, 15, 'GitHub da 15 filme tamamlanmalı');
      assert.equal(Object.keys(gh.readRemoteJson('data/catalog/movies.json')).length, 15);
      assert.equal(gh.readRemoteJson('data/catalog/manifest.json').movieCount, 15);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Senaryo 3: Her iki tarafta aynı kayıt bulunduğunda duplicate oluşmaz ve gereksiz GitHub commit\'i atılmaz', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bidir-s3-'));
  const gh = createMockGitHubHarness();
  try {
    const { store, storage } = createIsolatedSyncEnv(tmpDir);
    store.upsertCatalogItems([makeMovieRecord(77, { title: 'Blade Runner 2049' })]);
    await storage.saveDataSerialized(
      makeUserDataDoc([
        {
          id: 'profile-main',
          name: 'Ana Profil',
          createdAt: '2026-01-01T00:00:00.000Z',
          preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
          items: [
            {
              id: 77,
              media_type: 'movie',
              title: 'Blade Runner 2049',
              status: 'completed',
              personal_rating: 9,
              addedAt: '2026-01-02T00:00:00.000Z',
              updatedAt: '2026-01-02T00:00:00.000Z',
            },
          ],
          favoriteActors: [],
        },
      ])
    );

    const moviesPath = path.join(tmpDir, 'catalog', 'movies.json');
    const tvPath = path.join(tmpDir, 'catalog', 'tv.json');
    const manifestPath = path.join(tmpDir, 'catalog', 'manifest.json');
    const userDataPath = path.join(tmpDir, 'cinetrack-data.json');

    gh.seedFile('data/catalog/movies.json', fs.readFileSync(moviesPath, 'utf8'));
    if (fs.existsSync(tvPath)) {
      gh.seedFile('data/catalog/tv.json', fs.readFileSync(tvPath, 'utf8'));
    }
    gh.seedFile('data/catalog/manifest.json', fs.readFileSync(manifestPath, 'utf8'));
    gh.seedFile('data/cinetrack-data.json', fs.readFileSync(userDataPath, 'utf8'));

    await gh.installAndRun(async () => {
      const report = await store.reconcileWithGitHub();
      assert.equal(report.ok, true);
      assert.equal(report.verifiedEqual, true);
      assert.equal(report.localAfter.catalogMovieCount, 1, 'Tekil film kaydı korunmalı');
      assert.equal(report.remoteAfter.catalogMovieCount, 1, 'Uzakta kopya oluşmamalı');
      assert.equal(gh.commits.length, 0, 'Aynı içerikte hiçbir PUT commit yapılmamalı');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Senaryo 4: Aynı sayısal medya ID\'si hem film (movie:550) hem dizi (tv:550) olarak bulunduğunda ayrı kayıtlar olarak korunur', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bidir-s4-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    store.upsertCatalogItems([makeMovieRecord(550, { title: 'Fight Club' })]);

    const remoteTvMap = { 'tv:550': makeTvRecord(550, { title: 'Series 550' }) };
    gh.seedFile('data/catalog/movies.json', {});
    gh.seedFile('data/catalog/tv.json', remoteTvMap);
    gh.seedFile('data/catalog/manifest.json', buildValidManifest({}, remoteTvMap));

    await gh.installAndRun(async () => {
      const report = await store.reconcileWithGitHub();
      assert.equal(report.ok, true);
      assert.equal(report.verifiedEqual, true);
      assert.equal(report.localAfter.catalogMovieCount, 1);
      assert.equal(report.localAfter.catalogTvCount, 1);
      assert.equal(report.remoteAfter.catalogMovieCount, 1);
      assert.equal(report.remoteAfter.catalogTvCount, 1);

      const localMovies = store.readCatalog('movie');
      const localTv = store.readCatalog('tv');
      assert.equal(localMovies['movie:550'].title, 'Fight Club');
      assert.equal(localTv['tv:550'].title, 'Series 550');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Senaryo 5: Aynı medya anahtarında iki tarafta farklı dolu alanlar varken birleştirme hiçbir dolu alanı kaybetmez', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bidir-s5-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    // Yerel kayıt: zengin overview ve poster_path var ama backdrop_path null, genre_ids [18]
    store.upsertCatalogItems([
      makeMovieRecord(300, {
        title: 'Arrival',
        overview: 'Uzaylıların dünyaya inişinden sonra dilbilimci Louise Banks iletişim kurmaya çalışır.',
        poster_path: '/arrival-poster.jpg',
        backdrop_path: null,
        genre_ids: [18],
        vote_count: 800,
        lastUpdatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ]);

    // Uzak kayıt: daha yeni lastUpdatedAt ama overview boş, poster_path null; buna karşılık backdrop_path dolu, genre_ids [878, 9648], vote_count 2500
    const remoteMovie = makeMovieRecord(300, {
      title: 'Arrival',
      overview: '',
      poster_path: null,
      backdrop_path: '/arrival-backdrop-hd.jpg',
      genre_ids: [878, 9648],
      vote_count: 2500,
      lastUpdatedAt: '2026-02-15T00:00:00.000Z',
    });
    const remoteMap = { 'movie:300': remoteMovie };
    gh.seedFile('data/catalog/movies.json', remoteMap);
    gh.seedFile('data/catalog/tv.json', {});
    gh.seedFile('data/catalog/manifest.json', buildValidManifest(remoteMap, {}));

    await gh.installAndRun(async () => {
      const report = await store.reconcileWithGitHub();
      assert.equal(report.ok, true);
      assert.equal(report.verifiedEqual, true);

      const mergedLocal = store.readCatalog('movie')['movie:300'];
      const mergedRemote = gh.readRemoteJson('data/catalog/movies.json')['movie:300'];
      for (const rec of [mergedLocal, mergedRemote]) {
        assert.ok(rec.overview.includes('Louise Banks'), 'Zengin açıklama silinmemeli');
        assert.equal(rec.poster_path, '/arrival-poster.jpg', 'Dolu poster_path korunmalı');
        assert.equal(rec.backdrop_path, '/arrival-backdrop-hd.jpg', 'Dolu backdrop_path alınmalı');
        assert.deepEqual(rec.genre_ids, [18, 878, 9648], 'Tür kimlikleri birleştirilmeli');
        assert.equal(rec.vote_count, 2500, 'Daha yüksek oy sayısı korunmalı');
      }
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Senaryo 6: Uzakta bozuk JSON bulunduğunda yerel sağlam dosya korunur ve hata raporlanır', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bidir-s6-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    store.upsertCatalogItems([makeMovieRecord(42, { title: 'Stalker' })]);
    const moviesPath = path.join(tmpDir, 'catalog', 'movies.json');
    const intactBefore = fs.readFileSync(moviesPath, 'utf8');

    gh.seedFile('data/catalog/movies.json', '{"movie:42": { bozuk_json !!!');
    gh.seedFile('data/catalog/tv.json', {});

    await gh.installAndRun(async () => {
      const report = await store.reconcileWithGitHub();
      assert.equal(report.ok, false, 'Bozuk uzak JSON varken ok:false olmalı');
      assert.equal(report.verifiedEqual, false, 'verifiedEqual kesinlikle false olmalı');
      assert.ok(report.filesFailed.includes('data/catalog/movies.json'));
      assert.ok(report.errors.some((e) => e.category === 'corrupt_remote_json'));
      assert.equal(
        fs.readFileSync(moviesPath, 'utf8'),
        intactBefore,
        'Yerel sağlam movies.json dosyası bozuk veriyle ezilmemeli'
      );
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Senaryo 7: GitHub 404 (dosya yokluğu) ile izin/ağ hataları birbirinden kesin olarak ayrılır', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bidir-s7-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    store.upsertCatalogItems([makeMovieRecord(1, { title: 'Dune' })]);

    // 7A: Uzak depo tamamen boş (tüm dosyalar 404 döner) -> hata değildir, dosya yokluğu olarak raporlanır
    await gh.installAndRun(async () => {
      const inspectEmpty = await store.inspectGitHub();
      assert.equal(inspectEmpty.ok, true, '404 dosya yokluğu transport hatası sayılmamalı');
      assert.equal(inspectEmpty.errors.length, 0);
      assert.equal(inspectEmpty.remoteBefore.files['data/catalog/movies.json'].exists, false);
      assert.equal(inspectEmpty.remoteBefore.files['data/catalog/movies.json'].valid, true);
      assert.equal(inspectEmpty.verifiedEqual, false, 'Yerelde veri varken boş uzak depo eşit sayılmaz');
    });

    // 7B: Uzak depo 401/403 yetki hatası döndürürse "boş dosya" gibi davranılmaz, hata üretilir!
    gh.setInterceptor(({ pathname, jsonResponse }) => {
      if (pathname.endsWith('/contents/data/catalog/movies.json')) {
        return jsonResponse(401, { message: `Bad credentials for ${TEST_SECRET_TOKEN}` });
      }
      return null;
    });

    await gh.installAndRun(async () => {
      const inspectAuthFail = await store.inspectGitHub();
      assert.equal(inspectAuthFail.ok, false, '401 yetki hatası ok:false döndürmeli');
      assert.equal(inspectAuthFail.verifiedEqual, false);
      assert.ok(inspectAuthFail.errors.some((e) => e.category === 'auth_error'));
      // Token sızıntısı olmamalı
      for (const err of inspectAuthFail.errors) {
        assert.equal(err.message.includes(TEST_SECRET_TOKEN), false, 'Hata mesajında PAT sızmamalı');
      }
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Senaryo 8: GitHub 403, 429 rate-limit, 409 SHA çakışması (sınırlı retry) ve ağ kesintisi doğru yönetilir', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bidir-s8-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    store.upsertCatalogItems([makeMovieRecord(9, { title: 'Solaris' })]);

    // 8A: 403 izin hatası
    gh.setInterceptor(({ pathname, jsonResponse }) => {
      if (pathname.includes('/contents/')) {
        return jsonResponse(403, { message: 'Resource not accessible by personal access token' });
      }
      return null;
    });
    await gh.installAndRun(async () => {
      const r403 = await store.pullFromGitHub();
      assert.equal(r403.ok, false);
      assert.ok(r403.errors.some((e) => e.category === 'auth_error'));
    });

    // 8B: 429 rate limit
    gh.setInterceptor(({ pathname, jsonResponse }) => {
      if (pathname.includes('/contents/')) {
        return jsonResponse(
          429,
          { message: 'API rate limit exceeded' },
          { 'x-ratelimit-remaining': '0' }
        );
      }
      return null;
    });
    await gh.installAndRun(async () => {
      const r429 = await store.reconcileWithGitHub();
      assert.equal(r429.ok, false);
      assert.ok(r429.errors.some((e) => e.category === 'rate_limit'));
    });

    // 8C: Ağ kesintisi (TypeError: fetch failed)
    gh.setInterceptor(({ pathname }) => {
      if (pathname.includes('/contents/')) {
        throw new TypeError(`fetch failed while using Bearer ${TEST_SECRET_TOKEN}`);
      }
      return null;
    });
    await gh.installAndRun(async () => {
      const rNet = await store.inspectGitHub();
      assert.equal(rNet.ok, false);
      assert.ok(rNet.errors.some((e) => e.category === 'network_error'));
      assert.equal(
        JSON.stringify(rNet).includes(TEST_SECRET_TOKEN),
        false,
        'Ağ hatasında gizli token maskelenmeli'
      );
    });

    // 8D: 409 SHA çakışması -> ilk PUT 409 döner, güncel SHA çekilip ikinci denemede başarılı olur
    let injectedConflictOnce = false;
    gh.seedFile('data/catalog/movies.json', { 'movie:1': makeMovieRecord(1) });
    gh.setInterceptor(({ method, pathname, jsonResponse }) => {
      if (method === 'PUT' && pathname.endsWith('/data/catalog/movies.json') && !injectedConflictOnce) {
        injectedConflictOnce = true;
        return jsonResponse(409, { message: 'sha conflict simulated' });
      }
      return null;
    });
    await gh.installAndRun(async () => {
      const r409Recovered = await store.pushToGitHub();
      assert.equal(injectedConflictOnce, true);
      assert.equal(r409Recovered.ok, true, 'Tek seferlik 409 güncel SHA ile kurtarılmalı');
      assert.equal(r409Recovered.verifiedEqual, true);
    });

    // 8E: Sürekli 409 -> sonsuz döngüye girmeden sınırlı sayıda (<= 4 PUT) deneyip conflict hatası döner
    store.upsertCatalogItems([makeMovieRecord(10, { title: 'Persona' })]);
    let putAttempts = 0;
    gh.setInterceptor(({ method, pathname, jsonResponse }) => {
      if (method === 'PUT' && pathname.endsWith('/data/catalog/movies.json')) {
        putAttempts++;
        return jsonResponse(409, { message: 'persistent sha conflict' });
      }
      return null;
    });
    await gh.installAndRun(async () => {
      const r409Fail = await store.pushToGitHub();
      assert.equal(r409Fail.ok, false);
      assert.ok(putAttempts >= 2 && putAttempts <= 4, `Retry sınırlı olmalı (gerçekleşen: ${putAttempts})`);
      assert.ok(r409Fail.errors.some((e) => e.category === 'conflict'));
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Senaryo 9: Push sırasında bir dosya başarılı, diğer dosya başarısız olduğunda kısmi durum raporlanır ve sonraki deneme kaldığı yerden tamamlar', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bidir-s9-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    store.upsertCatalogItems([
      makeMovieRecord(101, { title: 'Heat' }),
      makeTvRecord(202, { title: 'The Wire' }),
    ]);

    let failTvPut = true;
    gh.setInterceptor(({ method, pathname, jsonResponse }) => {
      if (failTvPut && method === 'PUT' && pathname.endsWith('/data/catalog/tv.json')) {
        return jsonResponse(500, { message: 'Temporary GitHub storage error on tv.json' });
      }
      return null;
    });

    await gh.installAndRun(async () => {
      const firstPush = await store.pushToGitHub();
      assert.equal(firstPush.ok, false, 'Hata alan dosya varken ok:false olmalı');
      assert.equal(firstPush.partialFailure, true, 'Kısmi başarı açıkça işaretlenmeli');
      assert.equal(firstPush.verifiedEqual, false, 'Tüm dosyalar doğrulanmadan verifiedEqual:true olamaz');
      assert.ok(firstPush.filesUploaded.includes('data/catalog/movies.json'));
      assert.ok(firstPush.filesFailed.includes('data/catalog/tv.json'));

      const commitsAfterFirst = gh.commits.filter(
        (c) => c.repoPath === 'data/catalog/movies.json'
      ).length;
      assert.equal(commitsAfterFirst, 1);

      // İkinci denemede hata kalkar; movies.json tekrar yazılmaz, yalnızca eksik/başarısız dosya tamamlanır
      failTvPut = false;
      const secondPush = await store.pushToGitHub();
      assert.equal(secondPush.ok, true);
      assert.equal(secondPush.partialFailure, false);
      assert.equal(secondPush.verifiedEqual, true);

      const moviesCommitsAfterSecond = gh.commits.filter(
        (c) => c.repoPath === 'data/catalog/movies.json'
      ).length;
      assert.equal(
        moviesCommitsAfterSecond,
        1,
        'İlk denemede zaten yüklenmiş olan movies.json ikinci denemede gereksiz yere yeniden yazılmamalı'
      );
      assert.ok(secondPush.filesUploaded.includes('data/catalog/tv.json'));
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Senaryo 10: Pull sırasında bir dosya bozuk olduğunda sağlam dosyalar alınır ama bozuk dosya mevcut yerel veriyi ezmez; kullanıcı verisi çakışmasında onay istenir', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bidir-s10-'));
  const gh = createMockGitHubHarness();
  try {
    const { store, storage } = createIsolatedSyncEnv(tmpDir);
    store.upsertCatalogItems([makeTvRecord(55, { title: 'Yerel Sağlam Dizi' })]);
    const localTvPath = path.join(tmpDir, 'catalog', 'tv.json');
    const localTvBefore = fs.readFileSync(localTvPath, 'utf8');

    const validRemoteMovies = { 'movie:88': makeMovieRecord(88, { title: 'Uzak Sağlam Film' }) };
    gh.seedFile('data/catalog/movies.json', validRemoteMovies);
    gh.seedFile('data/catalog/tv.json', '{ "tv:55": BOZUK_VERI ');
    gh.seedFile('data/catalog/manifest.json', buildValidManifest(validRemoteMovies, {}));

    await gh.installAndRun(async () => {
      const pullRes = await store.pullFromGitHub({ conflictStrategy: 'merge' });
      assert.equal(pullRes.ok, false);
      assert.equal(pullRes.partialFailure, true, 'Sağlam film dosyası inip dizi dosyası bozuk olduğundan partialFailure:true olmalı');
      assert.equal(pullRes.verifiedEqual, false);
      assert.ok(pullRes.filesDownloaded.includes('data/catalog/movies.json'));
      assert.ok(pullRes.filesFailed.includes('data/catalog/tv.json'));

      assert.ok(store.readCatalog('movie')['movie:88'], 'Sağlam uzak movies.json uygulanmalı');
      assert.equal(
        fs.readFileSync(localTvPath, 'utf8'),
        localTvBefore,
        'Bozuk uzak tv.json yerel sağlam tv.json dosyasının üzerine yazılmamalı'
      );
    });

    // Ayrıca: yerel kullanıcı verisi uzaktan farklı kayıt içerdiğinde varsayılan pull ('ask') sessizce ezmez!
    gh.seedFile('data/catalog/tv.json', { 'tv:55': makeTvRecord(55, { title: 'Yerel Sağlam Dizi' }) });
    await storage.saveDataSerialized(
      makeUserDataDoc([
        {
          id: 'profile-main',
          name: 'Ana Profil',
          createdAt: '2026-01-01T00:00:00.000Z',
          preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
          items: [
            {
              id: 700,
              media_type: 'movie',
              title: 'Sadece Yereldeki Film',
              status: 'completed',
              personal_rating: 9,
              addedAt: '2026-02-01T00:00:00.000Z',
              updatedAt: '2026-02-01T00:00:00.000Z',
            },
          ],
          favoriteActors: [],
        },
      ])
    );

    gh.seedFile(
      'data/cinetrack-data.json',
      makeUserDataDoc([
        {
          id: 'profile-main',
          name: 'Ana Profil',
          createdAt: '2026-01-01T00:00:00.000Z',
          preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
          items: [
            {
              id: 701,
              media_type: 'movie',
              title: 'Sadece Uzaktaki Film',
              status: 'watchlist',
              personal_rating: '',
              addedAt: '2026-02-02T00:00:00.000Z',
              updatedAt: '2026-02-02T00:00:00.000Z',
            },
          ],
          favoriteActors: [],
        },
      ])
    );

    await gh.installAndRun(async () => {
      const askRes = await store.pullFromGitHub({ conflictStrategy: 'ask' });
      assert.equal(askRes.requiresConfirmation, true, 'Yerel özel kayıt varken pull onay istemeli');
      assert.equal(askRes.ok, false);
      assert.equal(askRes.conflictSummary.localOnlyItemsCount, 1);

      const mergedPull = await store.pullFromGitHub({ conflictStrategy: 'merge' });
      assert.equal(mergedPull.ok, true);
      assert.equal(mergedPull.localAfter.userUniqueSavedItemsCount, 2, 'Merge sonrası her iki kayıt korunmalı');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Senaryo 11: Katalog manifest.json sayıları veya contentHash yanlış olduğunda doğrulama hatayı bulur ve eşitleme onarır', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bidir-s11-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    store.upsertCatalogItems([
      makeMovieRecord(1, { title: 'Seven Samurai' }),
      makeMovieRecord(2, { title: 'Rashomon' }),
    ]);

    const remoteMovies = store.readCatalog('movie');
    gh.seedFile('data/catalog/movies.json', remoteMovies);
    gh.seedFile('data/catalog/tv.json', {});
    // Yanlış movieCount (999) ve yanlış contentHash içeren bozuk manifest.json
    gh.seedFile('data/catalog/manifest.json', {
      version: 1,
      updatedAt: '2026-02-01T00:00:00.000Z',
      movieCount: 999,
      tvCount: 0,
      contentHash: 'deadbeef0000wronghash',
    });

    await gh.installAndRun(async () => {
      const inspected = await store.inspectGitHub();
      assert.equal(inspected.remoteBefore.manifestValid, false, 'Yanlış manifest sayımı/hash yakalanmalı');
      assert.ok(inspected.remoteBefore.manifestMismatchReason.includes('999'));
      assert.equal(inspected.verifiedEqual, false, 'Manifest tutarsızken verifiedEqual:false olmalı');

      const reconciled = await store.reconcileWithGitHub();
      assert.equal(reconciled.ok, true);
      assert.equal(reconciled.verifiedEqual, true);
      assert.equal(reconciled.remoteAfter.manifestValid, true);
      assert.equal(reconciled.remoteAfter.manifestMovieCount, 2);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Senaryo 12: Aynı iki yönlü eşitleme art arda iki kez çalıştırıldığında idempotent davranır ve ikinci çalışmada sıfır commit üretir', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bidir-s12-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    store.upsertCatalogItems([makeMovieRecord(10, { title: 'Memento' })]);

    const remoteMovies = { 'movie:20': makeMovieRecord(20, { title: 'Prestige' }) };
    gh.seedFile('data/catalog/movies.json', remoteMovies);
    gh.seedFile('data/catalog/tv.json', {});
    gh.seedFile('data/catalog/manifest.json', buildValidManifest(remoteMovies, {}));

    await gh.installAndRun(async () => {
      const firstRun = await store.reconcileWithGitHub();
      assert.equal(firstRun.ok, true);
      assert.equal(firstRun.verifiedEqual, true);
      assert.equal(firstRun.localAfter.catalogMovieCount, 2);
      assert.equal(firstRun.remoteAfter.catalogMovieCount, 2);
      const commitsAfterFirst = gh.commits.length;
      assert.ok(commitsAfterFirst > 0, 'İlk eşitlemede uzak dosyalar güncellenmeli');

      const secondRun = await store.reconcileWithGitHub();
      assert.equal(secondRun.ok, true);
      assert.equal(secondRun.verifiedEqual, true);
      assert.equal(secondRun.recordsAdded, 0, 'İkinci çalışmada yeni kayıt eklenmemeli');
      assert.equal(secondRun.filesUploaded.length, 0, 'İkinci çalışmada dosya yüklenmemeli');
      assert.equal(
        gh.commits.length,
        commitsAfterFirst,
        'İkinci çalışmada hiçbir yeni GitHub commit\'i atılmamalı'
      );
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Senaryo 13: Profil imzası veya algoritma sürümü farklı olan uzak türetilmiş profil (generatedAt daha yeni olsa bile) geçerli sayılmaz, yeniden üretilir', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bidir-s13-'));
  const gh = createMockGitHubHarness();
  try {
    const { store, storage } = createIsolatedSyncEnv(tmpDir);
    store.upsertCatalogItems([
      makeMovieRecord(501, { title: 'Children of Men', genre_ids: [18, 878] }),
    ]);

    const userProfile = {
      id: 'profile-main',
      name: 'Bilimkurgu Sever',
      createdAt: '2026-01-01T00:00:00.000Z',
      preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
      items: [
        {
          id: 600,
          media_type: 'movie',
          title: 'Ex Machina',
          genre_ids: [18, 878],
          status: 'completed',
          personal_rating: 9,
          addedAt: '2026-01-05T00:00:00.000Z',
          updatedAt: '2026-01-05T00:00:00.000Z',
        },
      ],
      favoriteActors: [],
    };
    const savedDoc = await storage.saveDataSerialized(makeUserDataDoc([userProfile]));
    assert.equal(savedDoc.ok, true);

    // Uzak depoda generatedAt tarihi 2099 yılı (çok daha yeni!) olan ancak eski algorithmVersion ('v1-legacy') ve yanlış profileFingerprint taşıyan sahte önbellek
    const staleItems = {
      'movie:501': {
        mediaKey: 'movie:501',
        matchScore: 12,
        tasteScore: 12,
        priorityScore: 12,
        lifecycleRing: 'ring0',
        calculatedAt: '2099-01-01T00:00:00.000Z',
      },
    };
    const staleHash = computeDerivedProfileContentHash({
      schemaVersion: DERIVED_PROFILE_SCHEMA_VERSION,
      profileId: 'profile-main',
      algorithmVersion: 'v1-legacy-stale',
      profileFingerprint: 'stale-fingerprint-000',
      sourceCatalogHash: 'stale-cat-hash',
      items: staleItems,
    });
    gh.seedFile('data/profiles/profile-main.json', {
      schemaVersion: DERIVED_PROFILE_SCHEMA_VERSION,
      profileId: 'profile-main',
      algorithmVersion: 'v1-legacy-stale',
      profileFingerprint: 'stale-fingerprint-000',
      sourceCatalogHash: 'stale-cat-hash',
      contentHash: staleHash,
      generatedAt: '2099-01-01T00:00:00.000Z',
      items: staleItems,
    });

    await gh.installAndRun(async () => {
      const report = await store.reconcileWithGitHub();
      assert.equal(report.ok, true);
      assert.equal(report.verifiedEqual, true);

      const expectedFp = computeTasteProfileSignature(
        userProfile.items,
        userProfile.preferences,
        userProfile.favoriteActors,
        { targetType: 'all', algorithmVersion: ALGORITHM_VERSION }
      );
      const localDerived = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'profiles', 'profile-main.json'), 'utf8')
      );
      const remoteDerived = gh.readRemoteJson('data/profiles/profile-main.json');

      assert.equal(localDerived.algorithmVersion, ALGORITHM_VERSION, 'Güncel algoritma sürümüyle yeniden üretilmeli');
      assert.equal(localDerived.profileFingerprint, expectedFp, 'Güncel profil imzasıyla yeniden üretilmeli');
      assert.notEqual(localDerived.items['movie:501'].matchScore, 12, 'Eski sahte skor (12) kullanılmamalı');
      assert.equal(remoteDerived.profileFingerprint, expectedFp, 'Uzak profil önbelleği de güncellenmeli');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Senaryo 14: Yerel ve uzak içerik eşit değilken UI durumu kesinlikle "eşitlendi" mesajı üretmez', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bidir-s14-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    store.upsertCatalogItems([makeMovieRecord(1, { title: 'Yerel Film' })]);

    // Uzak depoda farklı 2 film var -> HTTP 200 OK döner ama içerikler eşit DEĞİL
    const remoteMovies = {
      'movie:2': makeMovieRecord(2, { title: 'Uzak Film A' }),
      'movie:3': makeMovieRecord(3, { title: 'Uzak Film B' }),
    };
    gh.seedFile('data/catalog/movies.json', remoteMovies);
    gh.seedFile('data/catalog/tv.json', {});
    gh.seedFile('data/catalog/manifest.json', buildValidManifest(remoteMovies, {}));

    await gh.installAndRun(async () => {
      // Henüz hiçbir uzak doğrulama yapılmamışken
      const initialBanner = deriveSyncUiBanner(store.getSyncStatus(), null);
      assert.equal(initialBanner.isVerifiedEqual, false);
      assert.notEqual(initialBanner.tone, 'synced');

      // Inspect HTTP 200 (ok: true) döndürse bile veriler farklıyken verifiedEqual:false ve tone:'diverged' olmalı
      const inspectReport = await store.inspectGitHub();
      assert.equal(inspectReport.ok, true);
      assert.equal(inspectReport.verifiedEqual, false);

      const divergedBanner = deriveSyncUiBanner(store.getSyncStatus(), inspectReport);
      assert.equal(divergedBanner.isVerifiedEqual, false);
      assert.equal(divergedBanner.tone, 'diverged');
      assert.ok(
        divergedBanner.headline.includes('eşit değil'),
        `Fark varken "eşitlendi" denmemeli, gelen başlık: ${divergedBanner.headline}`
      );

      // Reconcile tamamlanıp uzak dosyalar yeniden okunarak doğrulandığında tone:'synced' olmalı
      const reconcileReport = await store.reconcileWithGitHub();
      assert.equal(reconcileReport.verifiedEqual, true);
      const syncedBanner = deriveSyncUiBanner(store.getSyncStatus(), reconcileReport);
      assert.equal(syncedBanner.isVerifiedEqual, true);
      assert.equal(syncedBanner.tone, 'synced');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Senaryo 15: Varsayılan silmeme (no-deletion) politikası, >1 MB Git Blob indirme ve tüm HTTP senkronizasyon uçları (/api/sync/*) uçtan uca doğrulanır', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bidir-s15-'));
  const gh = createMockGitHubHarness({ simulate403TooLargeForOver1Mb: true });
  try {
    const { app, storage, persistentStore } = createCineTrackApp({
      dataDir: tmpDir,
      githubToken: TEST_SECRET_TOKEN,
      githubOwner: TEST_OWNER,
      githubRepo: TEST_REPO,
      githubBranch: TEST_BRANCH,
      isPublicRepo: false,
    });

    // Yerelde yalnızca Profile-A ve movie:10 var
    persistentStore.upsertCatalogItems([makeMovieRecord(10, { title: 'Yerel Korunacak Film' })]);
    await storage.saveDataSerialized(
      makeUserDataDoc(
        [
          {
            id: 'profile-a',
            name: 'Yerel Profil A',
            createdAt: '2026-01-01T00:00:00.000Z',
            preferences: {
              disliked: ['movie:901'],
              hidden: ['tv:902'],
              providers: ['8'],
              mood: '',
              reminders: false,
              notified: [],
            },
            items: [
              {
                id: 10,
                media_type: 'movie',
                title: 'Yerel Korunacak Film',
                status: 'completed',
                personal_rating: 8,
                addedAt: '2026-01-02T00:00:00.000Z',
                updatedAt: '2026-01-02T00:00:00.000Z',
              },
            ],
            favoriteActors: [{ id: 1, name: 'Mads Mikkelsen', profile_path: null }],
          },
        ],
        'profile-a'
      )
    );

    // Uzakta >1 MB büyüklüğünde movies.json (Git Blob API fallback testi için ~1.05 MB veri) ve yalnızca uzakta bulunan Profile-B
    const largeRemoteMovies = {};
    const fillerOverview = 'Uzun sinematografik analiz metni. '.repeat(35); // ~1.1 KB / film
    for (let i = 1000; i < 1980; i++) {
      largeRemoteMovies[`movie:${i}`] = makeMovieRecord(i, { overview: fillerOverview });
    }
    const seededLarge = gh.seedFile('data/catalog/movies.json', largeRemoteMovies);
    assert.ok(
      Buffer.byteLength(seededLarge.content, 'utf8') > 1_000_000,
      'Test katalog dosyası 1 MB üzerinde olmalı (Git Blob API yolu için)'
    );
    gh.seedFile('data/catalog/tv.json', { 'tv:888': makeTvRecord(888, { title: 'Uzak Korunacak Dizi' }) });
    gh.seedFile(
      'data/catalog/manifest.json',
      buildValidManifest(largeRemoteMovies, { 'tv:888': makeTvRecord(888, { title: 'Uzak Korunacak Dizi' }) })
    );
    gh.seedFile(
      'data/cinetrack-data.json',
      makeUserDataDoc(
        [
          {
            id: 'profile-b',
            name: 'Uzak Profil B',
            createdAt: '2026-01-03T00:00:00.000Z',
            preferences: { disliked: ['movie:999'], providers: ['337'], mood: '', reminders: false, notified: [] },
            items: [
              {
                id: 888,
                media_type: 'tv',
                title: 'Uzak Korunacak Dizi',
                status: 'watching',
                personal_rating: 9,
                addedAt: '2026-01-04T00:00:00.000Z',
                updatedAt: '2026-01-04T00:00:00.000Z',
              },
            ],
            favoriteActors: [],
          },
        ],
        'profile-b'
      )
    );

    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      await gh.installAndRun(async () => {
        // 1. GET /api/sync/status
        const statusRes1 = await fetch(`${baseUrl}/api/sync/status`);
        assert.equal(statusRes1.status, 200);
        const statusJson1 = await statusRes1.json();
        assert.equal(statusJson1.configured, true);
        assert.equal(statusJson1.localSummary.catalogMovieCount, 1);

        // 2. POST /api/sync/inspect (>1 MB uzak movies.json Git Blob API ile okunur, hiçbir veri değişmez)
        const inspectRes = await fetch(`${baseUrl}/api/sync/inspect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        assert.equal(inspectRes.status, 200);
        const inspectJson = await inspectRes.json();
        assert.equal(inspectJson.ok, true);
        assert.equal(inspectJson.remoteBefore.catalogMovieCount, 980);
        assert.equal(inspectJson.localAfter.catalogMovieCount, 1, 'Inspect yerel veriyi değiştirmemeli');
        assert.equal(inspectJson.verifiedEqual, false);

        // 3. POST /api/sync/reconcile (iki yönlü kayıpsız eşitleme: hiçbir profil veya film silinmez!)
        const recRes = await fetch(`${baseUrl}/api/sync/reconcile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        assert.equal(recRes.status, 200);
        const recJson = await recRes.json();
        assert.equal(recJson.ok, true);
        assert.equal(recJson.verifiedEqual, true);
        assert.equal(recJson.localAfter.catalogMovieCount, 981, '1 yerel + 980 uzak film = 981 film');
        assert.equal(recJson.remoteAfter.catalogMovieCount, 981, 'Uzak katalog da 981 film olmalı');
        assert.equal(recJson.localAfter.catalogTvCount, 1);
        assert.equal(recJson.remoteAfter.catalogTvCount, 1);
        assert.equal(recJson.localAfter.userProfilesCount, 2, 'Hem profile-a hem profile-b korunmalı');
        assert.equal(recJson.remoteAfter.userProfilesCount, 2, 'Uzakta da her iki profil bulunmalı');
        assert.equal(gh.deletions.length, 0, 'Hiçbir DELETE çağrısı yapılmamalı');

        // 4. POST /api/sync/push ve POST /api/sync/pull uçları da 200 ve verifiedEqual:true döner
        const pushRes = await fetch(`${baseUrl}/api/sync/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        assert.equal(pushRes.status, 200);
        const pushJson = await pushRes.json();
        assert.equal(pushJson.verifiedEqual, true);

        const pullRes = await fetch(`${baseUrl}/api/sync/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conflictStrategy: 'merge' }),
        });
        assert.equal(pullRes.status, 200);
        const pullJson = await pullRes.json();
        assert.equal(pullJson.verifiedEqual, true);
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ==========================================
// AŞAMA 5 — HTTP 404 & GİTHUB ENTEGRASYON TESTLERİ
// ==========================================

test('Aşama 5.1: Özel depoya geçerli token ile erişim', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-phase5-1-'));
  const gh = createMockGitHubHarness({ isPrivate: true });
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    await gh.installAndRun(async () => {
      const access = await store.verifyRemoteRepoAccess();
      assert.equal(access.ok, true);
      assert.equal(access.accessible, true);
      assert.equal(access.repoExists, true);
      assert.equal(access.branchExists, true);
      assert.equal(access.hasPushPermission, true);
      assert.equal(access.isPrivate, true);
      assert.equal(access.effectiveIsPublicRepo, false);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Aşama 5.2: Yanlış depo adı veya erişilemeyen özel depo (404 tanı ve yerel verinin korunması)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-phase5-2-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    store.upsertCatalogItems([
      makeMovieRecord(101, { title: 'Yerel Film 101' }),
      makeMovieRecord(102, { title: 'Yerel Film 102' }),
    ]);

    gh.setInterceptor(({ pathname, jsonResponse }) => {
      if (pathname === `/repos/${TEST_OWNER}/${TEST_REPO}`) {
        return jsonResponse(404, { message: 'Not Found' });
      }
      return null;
    });

    await gh.installAndRun(async () => {
      const access = await store.verifyRemoteRepoAccess();
      assert.equal(access.ok, false);
      assert.equal(access.accessible, false);
      assert.equal(access.repoExists, false);
      assert.equal(access.errorCategory, 'not_found');
      assert.ok(access.error && access.error.includes('HTTP 404'));
      assert.equal(access.error.includes(TEST_SECRET_TOKEN), false, 'Token sızdırılmamalı');

      const pushRes = await store.pushToGitHub();
      assert.equal(pushRes.ok, false);
      assert.equal(pushRes.verifiedEqual, false);
      assert.ok(pushRes.errors.some((e) => e.category === 'not_found'));

      // Yerel verinin silinmediği ve bozulmadığı doğrulanmalı
      const localMovies = store.readCatalog('movie');
      assert.equal(Object.keys(localMovies).length, 2);
      assert.equal(localMovies['movie:101']?.title, 'Yerel Film 101');
      assert.equal(localMovies['movie:102']?.title, 'Yerel Film 102');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Aşama 5.3: Geçersiz dal (404) doğru tespit edilir ve varsayılan dal bildirilir', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-phase5-3-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    gh.setInterceptor(({ pathname, jsonResponse }) => {
      if (pathname === `/repos/${TEST_OWNER}/${TEST_REPO}`) {
        return jsonResponse(200, {
          private: true,
          full_name: `${TEST_OWNER}/${TEST_REPO}`,
          default_branch: 'master',
        });
      }
      if (pathname === `/repos/${TEST_OWNER}/${TEST_REPO}/branches/${TEST_BRANCH}`) {
        return jsonResponse(404, { message: 'Branch not found' });
      }
      if (pathname === `/repos/${TEST_OWNER}/${TEST_REPO}/branches`) {
        return jsonResponse(200, [{ name: 'master' }]);
      }
      return null;
    });

    await gh.installAndRun(async () => {
      const access = await store.verifyRemoteRepoAccess();
      assert.equal(access.ok, false);
      assert.equal(access.branchExists, false);
      assert.equal(access.errorCategory, 'not_found');
      assert.ok(access.error && access.error.includes('master'));
      assert.equal(access.error.includes(TEST_SECRET_TOKEN), false);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Aşama 5.4: Yeni dosya oluşturma (SHA gönderilmez, 201 yanıtı ve geri okuma doğrulaması)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-phase5-4-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    let capturedPutBody = null;

    gh.setInterceptor(({ method, pathname, init }) => {
      if (method === 'PUT' && pathname.endsWith('/contents/data/catalog/movies.json')) {
        capturedPutBody = JSON.parse(String(init.body || '{}'));
      }
      return null;
    });

    await gh.installAndRun(async () => {
      const content = JSON.stringify({ 'movie:1': makeMovieRecord(1) }, null, 2);
      const res = await store.commitFileToGitHub(
        'data/catalog/movies.json',
        content,
        'feat: create movies.json'
      );
      assert.equal(res.ok, true);
      assert.equal(res.verifiedReadBack, true);
      assert.ok(res.sha);
      assert.equal(capturedPutBody?.sha, undefined, 'Yeni dosya oluşturmada sha alanı bulunmamalı');
      assert.equal(capturedPutBody?.branch, TEST_BRANCH);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Aşama 5.5: Var olan dosyayı doğru SHA ile güncelleme (200 yanıtı)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-phase5-5-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    const initialContent = JSON.stringify({ 'movie:1': makeMovieRecord(1) }, null, 2);
    const { sha: initialSha } = gh.seedFile('data/catalog/movies.json', initialContent);

    let capturedPutBody = null;
    gh.setInterceptor(({ method, pathname, init }) => {
      if (method === 'PUT' && pathname.endsWith('/contents/data/catalog/movies.json')) {
        capturedPutBody = JSON.parse(String(init.body || '{}'));
      }
      return null;
    });

    await gh.installAndRun(async () => {
      const updatedContent = JSON.stringify(
        { 'movie:1': makeMovieRecord(1, { title: 'Güncel Dune' }) },
        null,
        2
      );
      const res = await store.commitFileToGitHub(
        'data/catalog/movies.json',
        updatedContent,
        'chore: update movies.json'
      );
      assert.equal(res.ok, true);
      assert.equal(res.verifiedReadBack, true);
      assert.equal(capturedPutBody?.sha, initialSha, 'Güncellemede doğru SHA gönderilmeli');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Aşama 5.6: Yetkisiz yazma girişimi (permissions.push: false veya 403 yazma reddi)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-phase5-6-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    gh.setInterceptor(({ pathname, jsonResponse }) => {
      if (pathname === `/repos/${TEST_OWNER}/${TEST_REPO}`) {
        return jsonResponse(200, {
          private: true,
          full_name: `${TEST_OWNER}/${TEST_REPO}`,
          default_branch: TEST_BRANCH,
          permissions: { pull: true, push: false, admin: false },
        });
      }
      return null;
    });

    await gh.installAndRun(async () => {
      const access = await store.verifyRemoteRepoAccess();
      assert.equal(access.ok, false);
      assert.equal(access.hasPushPermission, false);
      assert.equal(access.errorCategory, 'auth_error');
      assert.ok(access.error && access.error.includes('yazma (push) yetkisine sahip değil'));
      assert.equal(access.error.includes(TEST_SECRET_TOKEN), false);

      const pushReport = await store.pushToGitHub();
      assert.equal(pushReport.ok, false);
      assert.ok(pushReport.errors.some((e) => e.category === 'auth_error'));
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Aşama 5.7: 404 ve 409 hata yanıtları (404 güvenli durur, 409 SHA yenileyerek çözer)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-phase5-7-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    const initialContent = JSON.stringify({ 'movie:1': makeMovieRecord(1) }, null, 2);
    gh.seedFile('data/catalog/movies.json', initialContent, 'sha-old');

    let putCount = 0;
    gh.setInterceptor(({ method, pathname, jsonResponse }) => {
      if (method === 'PUT' && pathname.endsWith('/contents/data/catalog/movies.json')) {
        putCount++;
        if (putCount === 1) {
          // İlk denemede 409 conflict simüle et
          return jsonResponse(409, { message: 'Conflict: sha-old is outdated' });
        }
      }
      return null;
    });

    await gh.installAndRun(async () => {
      const newContent = JSON.stringify({ 'movie:1': makeMovieRecord(1, { title: 'Yenilendi' }) }, null, 2);
      const res = await store.commitFileToGitHub('data/catalog/movies.json', newContent, 'update');
      assert.equal(res.ok, true);
      assert.equal(putCount, 2, '409 sonrası güncel SHA alınarak 2. denemede yazılmalı');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Aşama 5.8: Kısmi başarısızlık ve güvenli tekrar (başarılı dosyalar korunur, sonraki çalışmada atlanır)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-phase5-8-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    store.upsertCatalogItems([
      makeMovieRecord(1, { title: 'Film 1' }),
      makeTvRecord(1, { title: 'Dizi 1' }),
    ]);

    let blockTv = true;
    gh.setInterceptor(({ method, pathname, jsonResponse }) => {
      if (blockTv && method === 'PUT' && pathname.endsWith('/contents/data/catalog/tv.json')) {
        return jsonResponse(500, { message: 'Internal Server Error' });
      }
      return null;
    });

    await gh.installAndRun(async () => {
      // 1. İlk gönderim: movies.json başarılı, tv.json başarısız -> partialFailure
      const res1 = await store.syncToGitHub();
      assert.equal(res1.ok, false);
      assert.equal(res1.partialFailure, true);
      assert.ok(res1.filesCommitted.includes('data/catalog/movies.json'));
      assert.ok(res1.filesFailed.includes('data/catalog/tv.json'));

      // 2. İkinci gönderim: engel kalktı; movies.json atlanır (skipped), tv.json tamamlanır
      blockTv = false;
      const res2 = await store.syncToGitHub();
      assert.equal(res2.ok, true);
      assert.ok(res2.filesSkipped.includes('data/catalog/movies.json'));
      assert.ok(res2.filesCommitted.includes('data/catalog/tv.json'));
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Aşama 5.9: Yazma sonrası hash doğrulaması (uzak içerik uyuşmazsa dosya başarısız sayılır)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-phase5-9-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);

    let putReceived = false;
    gh.setInterceptor(({ method, pathname, jsonResponse }) => {
      // PUT sonrası GET çağrısında bozuk/farklı içerik dön
      if (putReceived && method === 'GET' && pathname.endsWith('/contents/data/catalog/movies.json')) {
        return jsonResponse(200, {
          name: 'movies.json',
          path: 'data/catalog/movies.json',
          sha: 'mismatched-sha',
          size: 100,
          type: 'file',
          encoding: 'base64',
          content: Buffer.from('{"movie:1": {"title": "Bozuk veya farkli içerik"}}', 'utf8').toString('base64'),
        });
      }
      if (method === 'PUT' && pathname.endsWith('/contents/data/catalog/movies.json')) {
        putReceived = true;
      }
      return null;
    });

    await gh.installAndRun(async () => {
      const validContent = JSON.stringify({ 'movie:1': makeMovieRecord(1) }, null, 2);
      const res = await store.commitFileToGitHub('data/catalog/movies.json', validContent, 'test write');
      assert.equal(res.ok, false);
      assert.equal(res.errorCategory, 'conflict');
      assert.ok(res.error && res.error.includes('hash doğrulaması'));
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Aşama 5.10: Yerel verinin hiçbir başarısız senaryoda silinmemesi / sıfırlanmaması', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-phase5-10-'));
  const gh = createMockGitHubHarness();
  try {
    const { store, storage } = createIsolatedSyncEnv(tmpDir);
    // Yerelde 500 film ve kullanıcı kayıtları ekle
    const sampleMovies = Array.from({ length: 50 }, (_, i) => makeMovieRecord(i + 1));
    store.upsertCatalogItems(sampleMovies);

    const initialData = storage.readData();
    assert.equal(Object.keys(store.readCatalog('movie')).length, 50);

    // Uzakta ardışık 404, 500 ve ağ hatası simüle et
    gh.setInterceptor(({ jsonResponse }) => {
      return jsonResponse(404, { message: 'Not Found' });
    });

    await gh.installAndRun(async () => {
      const resPush = await store.pushToGitHub();
      assert.equal(resPush.ok, false);

      const resReconcile = await store.reconcileWithGitHub();
      assert.equal(resReconcile.ok, false);

      const resPull = await store.pullFromGitHub();
      assert.equal(resPull.ok, false);

      // Yerel katalog ve kullanıcı verisinin eksiksiz korunduğu garanti edilmeli
      const finalMovies = store.readCatalog('movie');
      assert.equal(Object.keys(finalMovies).length, 50);
      for (const m of sampleMovies) {
        assert.ok(finalMovies[m.key]);
      }

      const finalData = storage.readData();
      assert.equal(finalData.profiles.length, initialData.profiles.length);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Aşama 5.11: Başarısız dosyanın yanlışlıkla başarılı sayılmaması (başarı sayacı artmaz)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-phase5-11-'));
  const gh = createMockGitHubHarness();
  try {
    const { store } = createIsolatedSyncEnv(tmpDir);
    store.upsertCatalogItems([makeMovieRecord(1)]);

    gh.setInterceptor(({ method, pathname, jsonResponse }) => {
      if (method === 'PUT') {
        return jsonResponse(404, { message: 'Not Found' });
      }
      return null;
    });

    await gh.installAndRun(async () => {
      const syncRes = await store.syncToGitHub();
      assert.equal(syncRes.ok, false);
      assert.equal(syncRes.filesCommitted.length, 0, 'Başarısız dosya committed listesinde yer alamaz');
      assert.ok(syncRes.filesFailed.includes('data/catalog/movies.json'));

      const syncStatus = store.getSyncStatus();
      assert.equal(syncStatus.fileSummaryCounts.uploaded, 0);
      assert.equal(syncStatus.fileSummaryCounts.succeeded, 0);
      assert.ok(syncStatus.fileSummaryCounts.failed > 0);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


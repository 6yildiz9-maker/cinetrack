import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  buildCinemaKunyeContentId,
  createEmptyCinemaKunyeDocument,
  enrichSavedItemsFromCinemaKunye,
  extractCinemaKunyeFromItems,
  mergeCinemaKunyeDocumentsLossless,
} from '../src/core/cinema-kunye.ts';
import {
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  parseBackupText,
} from '../src/core/cinetrack-core.ts';
import { mergeSavedItemListsLossless } from '../src/core/user-data-merge.ts';
import { exportItemsToCsv, importItemsFromCsv } from '../src/core/exporters.ts';
import { buildYearlyWrappedSummary } from '../src/core/wrapped-summary.ts';
import {
  PersistentDataStore,
  stringifyDeterministic,
} from '../src/server/persistent-store.ts';
import { createDataStorage } from '../src/server/storage.ts';
import { createCineTrackApp } from '../src/server/app.ts';
import { resolveConfig } from '../src/server/config.ts';
import { GitHubBidirectionalSyncManager } from '../src/server/github-bidirectional-sync.ts';
import { executeProfileBackupExport } from '../src/server/excel-profile-backup.ts';

const TEST_OWNER = 'kunye-owner';
const TEST_REPO = 'cinetrack-kunye-sync';
const TEST_BRANCH = 'main';
const TEST_TOKEN = 'github_pat_11KUNYETESTTOKEN9999999999999999';

function makeSha(repoPath, content, seq = 1) {
  return crypto.createHash('sha1').update(`${repoPath}:${seq}:${content}`).digest('hex');
}

function createTempDir(prefix = 'ct-kunye-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createMockGitHubServer() {
  const files = new Map();
  const blobs = new Map();
  let seq = 1;

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
    return entry ? JSON.parse(entry.content) : null;
  }

  function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  async function withMockFetch(fn) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      const urlStr = typeof input === 'string' ? input : input.url;
      if (!urlStr.startsWith('https://api.github.com/')) {
        return originalFetch(input, init);
      }

      const method = (init.method || 'GET').toUpperCase();
      const parsedUrl = new URL(urlStr);
      const pathname = parsedUrl.pathname;
      const repoPrefix = `/repos/${TEST_OWNER}/${TEST_REPO}`;

      if (pathname === repoPrefix && method === 'GET') {
        return jsonResponse(200, {
          private: true,
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
        if (raw === undefined) return jsonResponse(404, { message: 'Blob Not Found' });
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
          if (files.has(repoPath)) {
            const entry = files.get(repoPath);
            return jsonResponse(200, {
              type: 'file',
              name: path.basename(repoPath),
              path: repoPath,
              sha: entry.sha,
              size: Buffer.byteLength(entry.content, 'utf8'),
              encoding: 'base64',
              content: Buffer.from(entry.content, 'utf8').toString('base64'),
            });
          }
          // Directory listing check
          const dirPrefix = `${repoPath.replace(/\/+$/, '')}/`;
          const children = [];
          for (const [fPath, fEntry] of files.entries()) {
            if (fPath.startsWith(dirPrefix)) {
              const rest = fPath.slice(dirPrefix.length);
              if (!rest.includes('/')) {
                children.push({
                  type: 'file',
                  name: rest,
                  path: fPath,
                  sha: fEntry.sha,
                  size: Buffer.byteLength(fEntry.content, 'utf8'),
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
          const payload = JSON.parse(String(init.body || '{}'));
          const decoded = Buffer.from(String(payload.content || ''), 'base64').toString('utf8');
          const existing = files.get(repoPath);
          if (existing && payload.sha !== existing.sha) {
            return jsonResponse(409, { message: 'sha does not match' });
          }
          const newSha = makeSha(repoPath, decoded, seq++);
          files.set(repoPath, { content: decoded, sha: newSha });
          blobs.set(newSha, decoded);
          return jsonResponse(existing ? 200 : 201, {
            content: { path: repoPath, sha: newSha },
            commit: { sha: makeSha('commit', newSha, seq++) },
          });
        }
      }

      return jsonResponse(404, { message: `Unhandled GitHub mock route: ${method} ${pathname}` });
    };

    try {
      return await fn();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  return { files, seedFile, readRemoteJson, withMockFetch };
}

test('1. contentId (film/dizi adı + yıl) deterministik üretimi ve -belirsiz yükseltmesi', () => {
  assert.equal(buildCinemaKunyeContentId('Kış Uykusu', 2014), 'kis-uykusu-2014');
  assert.equal(buildCinemaKunyeContentId('Şahsiyet', '2018-03-17'), 'sahsiyet-2018');
  assert.equal(buildCinemaKunyeContentId('Inception', '2010'), 'inception-2010');
  assert.equal(buildCinemaKunyeContentId('Dune: Çöl Gezegeni', null), 'dune-col-gezegeni-belirsiz');

  // Yılı başlangıçta bilinmeyen kayıt, yıl bilgisi geldiğinde kayıpsız olarak film-adi-yil anahtarına yükseltilir
  const docUnknownYear = extractCinemaKunyeFromItems([
    {
      id: 438631,
      media_type: 'movie',
      title: 'Dune: Çöl Gezegeni',
      status: 'completed',
      genre_ids: [878],
      cast: [{ id: 1190668, name: 'Timothée Chalamet', character: 'Paul Atreides' }],
      updatedAt: '2026-02-01T10:00:00.000Z',
    },
  ]);
  assert.ok(docUnknownYear.entries['dune-col-gezegeni-belirsiz']);

  const docKnownYear = extractCinemaKunyeFromItems([
    {
      id: 438631,
      media_type: 'movie',
      title: 'Dune: Çöl Gezegeni',
      release_date: '2021-09-15',
      status: 'completed',
      genre_ids: [12],
      cast: [{ id: 933238, name: 'Rebecca Ferguson', character: 'Lady Jessica' }],
      updatedAt: '2026-02-05T10:00:00.000Z',
    },
  ]);

  const merged = mergeCinemaKunyeDocumentsLossless(docUnknownYear, docKnownYear);
  assert.equal(merged.entries['dune-col-gezegeni-belirsiz'], undefined);
  const upgraded = merged.entries['dune-col-gezegeni-2021'];
  assert.ok(upgraded);
  assert.equal(upgraded.year, 2021);
  assert.deepEqual(upgraded.genreIds.sort((a, b) => a - b), [12, 878]);
  assert.equal(upgraded.actors.length, 2);
});

test('2. Ayrı sinema-kunyesi.json dosyası, /api/cinema-kunye uç noktaları ve Sinema Künyen zenginleştirmesi', async () => {
  const tmpDir = createTempDir();
  try {
    const dataDir = path.join(tmpDir, 'data');
    const dataFile = path.join(dataDir, 'cinetrack-data.json');
    const store = new PersistentDataStore({ dataDir });
    const storage = createDataStorage(dataFile, { persistentStore: store });
    const config = resolveConfig({
      PORT: '0',
      HOST: '127.0.0.1',
      DATA_FILE: dataFile,
    });
    const appBundle = createCineTrackApp({ config, storage, persistentStore: store });
    const server = await new Promise((resolve) => {
      const s = appBundle.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Yalnızca izlenen yapımlar künyeye alınır; sadece watchlist olanlar alınmaz
      const sampleItems = [
        {
          id: 27205,
          media_type: 'movie',
          title: 'Başlangıç',
          release_date: '2010-07-16',
          status: 'completed',
          personal_rating: 9,
          genre_ids: [28, 878],
          cast: [
            { id: 6193, name: 'Leonardo DiCaprio', character: 'Dom Cobb' },
            { id: 24045, name: 'Joseph Gordon-Levitt', character: 'Arthur' },
          ],
          completedAt: '2026-03-10T20:00:00.000Z',
          updatedAt: '2026-03-10T20:00:00.000Z',
        },
        {
          id: 99999,
          media_type: 'movie',
          title: 'Henüz İzlenmeyen Film',
          release_date: '2024-01-01',
          status: 'watchlist',
          personal_rating: '',
          genre_ids: [35],
        },
      ];

      const extracted = extractCinemaKunyeFromItems(sampleItems, {
        28: 'Aksiyon',
        878: 'Bilim Kurgu',
      });
      assert.deepEqual(Object.keys(extracted.entries), ['baslangic-2010']);

      const postRes = await fetch(`${baseUrl}/api/cinema-kunye`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: baseUrl,
        },
        body: JSON.stringify({ cinemaKunye: extracted, mode: 'merge' }),
      });
      assert.equal(postRes.status, 200);
      const postBody = await postRes.json();
      assert.equal(postBody.ok, true);
      assert.equal(postBody.entriesCount, 1);

      // Ayrı dosyanın diske yazıldığını doğrula
      const kunyeDiskPath = path.join(tmpDir, 'data', 'sinema-kunyesi.json');
      assert.equal(fs.existsSync(kunyeDiskPath), true);

      const getRes = await fetch(`${baseUrl}/api/cinema-kunye`);
      assert.equal(getRes.status, 200);
      const getBody = await getRes.json();
      assert.ok(getBody.cinemaKunye.entries['baslangic-2010']);
      assert.equal(getBody.cinemaKunye.entries['baslangic-2010'].actors[0].name, 'Leonardo DiCaprio');

      // SavedItem içinde tür/yıl/oyuncu eksik olsa bile Sinema Künyen (Wrapped) ayrı dosyadan beslenir
      const bareProfile = {
        id: 'profile-default',
        name: 'Test Profil',
        createdAt: '2026-01-01T00:00:00.000Z',
        preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
        items: [
          {
            id: 27205,
            media_type: 'movie',
            title: 'Başlangıç',
            status: 'completed',
            personal_rating: 9,
            genre_ids: [],
            completedAt: '2026-03-10T20:00:00.000Z',
            addedAt: '2026-03-10T20:00:00.000Z',
          },
        ],
      };

      const wrapped = buildYearlyWrappedSummary(
        bareProfile,
        2026,
        { 28: 'Aksiyon', 878: 'Bilim Kurgu' },
        getBody.cinemaKunye
      );
      assert.ok(wrapped.topGenres.some((g) => g.name === 'Bilim Kurgu'));
      assert.ok(wrapped.topEras.some((e) => e.era === "2010'lar"));
      assert.ok(wrapped.topActors.some((a) => a.name === 'Leonardo DiCaprio'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('3. Profil JSON ve CSV tam yedeklemesi (contentId ile) ve geri yüklemede çakışma birleştirme', async () => {
  const tmpDir = createTempDir();
  try {
    const dataDir = path.join(tmpDir, 'data');
    const dataFile = path.join(dataDir, 'cinetrack-data.json');
    const store = new PersistentDataStore({ dataDir });
    const storage = createDataStorage(dataFile, { persistentStore: store });

    const watchedMovie = {
      id: 157336,
      media_type: 'movie',
      title: 'Yıldızlararası',
      release_date: '2014-11-05',
      status: 'completed',
      personal_rating: 10,
      notes: 'Muazzam bilim kurgu',
      genre_ids: [12, 18, 878],
      cast: [
        { id: 10297, name: 'Matthew McConaughey', character: 'Cooper' },
        { id: 1813, name: 'Anne Hathaway', character: 'Brand' },
      ],
      addedAt: '2026-01-10T10:00:00.000Z',
      updatedAt: '2026-02-20T18:00:00.000Z',
      completedAt: '2026-02-20T18:00:00.000Z',
    };

    const genreMap = { 12: 'Macera', 18: 'Dram', 878: 'Bilim Kurgu', 53: 'Gerilim' };
    const kunyeDoc = extractCinemaKunyeFromItems([watchedMovie], genreMap);
    assert.ok(kunyeDoc.entries['yildizlararasi-2014']);

    await store.saveCinemaKunyeSerialized(kunyeDoc, { mode: 'merge' });
    await storage.saveDataSerialized({
      version: 3,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      activeProfileId: 'profile-default',
      profiles: [
        {
          id: 'profile-default',
          name: 'Arşivim',
          createdAt: '2026-01-01T00:00:00.000Z',
          preferences: { disliked: [], providers: ['8'], mood: '', reminders: false, notified: [] },
          items: [watchedMovie],
          favoriteActors: [],
        },
      ],
    });

    // A) Sunucu tam profil yedeği (JSON + XLSX) içinde cinemaKunye doğrulaması
    const backupReport = await executeProfileBackupExport({
      profileId: 'profile-default',
      exportMode: 'json_and_xlsx',
      includeJson: true,
      includeXlsx: true,
      genresMap: genreMap,
      storage,
      persistentStore: store,
      projectRoot: tmpDir,
      dataDir: tmpDir,
    });
    assert.equal(backupReport.jsonBackup.ok, true);
    const exportedServerJsonText = fs.readFileSync(
      backupReport.jsonBackup.absolutePath,
      'utf8'
    );
    const parsedFromJsonBackup = parseBackupText(exportedServerJsonText);
    assert.ok(parsedFromJsonBackup.cinemaKunye.entries['yildizlararasi-2014']);
    assert.equal(
      parsedFromJsonBackup.cinemaKunye.entries['yildizlararasi-2014'].actors[0].name,
      'Matthew McConaughey'
    );

    // B) CSV dışa aktarma (ContentId, Genres, Actors + #SinemaKunyesi) ve geri yükleme
    const csvText = exportItemsToCsv([watchedMovie], {
      activeProfileId: 'profile-default',
      cinemaKunye: kunyeDoc,
      genreMap,
      profile: {
        id: 'profile-default',
        name: 'Arşivim',
        createdAt: '2026-01-01T00:00:00.000Z',
        preferences: { disliked: [], providers: ['8'], mood: '', reminders: false, notified: [] },
        items: [watchedMovie],
        favoriteActors: [],
      },
    });
    assert.match(csvText, /ContentId,Genres,Actors/);
    assert.match(csvText, /yildizlararasi-2014/);
    assert.match(csvText, /#SinemaKunyesi,/);

    const csvImported = importItemsFromCsv(csvText);
    assert.equal(csvImported.importedItems.length, 1);
    assert.ok(csvImported.cinemaKunye.entries['yildizlararasi-2014']);
    assert.equal(
      csvImported.cinemaKunye.entries['yildizlararasi-2014'].actors.length,
      2
    );

    // C) Geri yükleme sırasında çakışan hem liste hem künye verilerinin kayıpsız birleştirilmesi
    const existingLocalItems = [
      {
        id: 157336,
        media_type: 'movie',
        title: 'Yıldızlararası',
        release_date: '2014-11-05',
        status: 'watchlist', // Daha eski durum
        personal_rating: 8, // Daha eski puan
        notes: 'Yerel eski not',
        genre_ids: [53],
        cast: [{ id: 1892, name: 'Matt Damon', character: 'Mann' }],
        addedAt: '2026-01-05T10:00:00.000Z',
        updatedAt: '2026-01-05T10:00:00.000Z',
      },
      {
        id: 680,
        media_type: 'movie',
        title: 'Ucuz Roman',
        release_date: '1994-09-10',
        status: 'completed',
        personal_rating: 9,
        genre_ids: [80],
        addedAt: '2026-01-12T10:00:00.000Z',
        updatedAt: '2026-01-12T10:00:00.000Z',
      },
    ];
    const existingLocalKunye = extractCinemaKunyeFromItems(existingLocalItems, genreMap);

    const mergedKunye = mergeCinemaKunyeDocumentsLossless(
      existingLocalKunye,
      csvImported.cinemaKunye
    );
    const mergedItems = enrichSavedItemsFromCinemaKunye(
      mergeSavedItemListsLossless(existingLocalItems, csvImported.importedItems, 'profile-default'),
      mergedKunye
    );

    // Her iki farklı yapım korundu + Yıldızlararası en güncel duruma/puana güncellendi + tüm oyuncular/türler birleşti
    assert.equal(mergedItems.length, 2);
    const mergedInterstellar = mergedItems.find((i) => Number(i.id) === 157336);
    assert.ok(mergedInterstellar);
    assert.equal(mergedInterstellar.status, 'completed');
    assert.equal(mergedInterstellar.personal_rating, 10);
    assert.deepEqual(
      mergedKunye.entries['yildizlararasi-2014'].genreIds.sort((a, b) => a - b),
      [12, 18, 53, 878]
    );
    assert.equal(mergedKunye.entries['yildizlararasi-2014'].actors.length, 3);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('4. GitHub çift yönlü senkronizasyonda data/sinema-kunyesi.json kayıpsız birleştirme ve doğrulama', async () => {
  const tmpDir = createTempDir();
  const gh = createMockGitHubServer();

  try {
    const dataDir = path.join(tmpDir, 'data');
    const dataFile = path.join(dataDir, 'cinetrack-data.json');
    const store = new PersistentDataStore({
      dataDir,
      githubToken: TEST_TOKEN,
      githubOwner: TEST_OWNER,
      githubRepo: TEST_REPO,
      githubBranch: TEST_BRANCH,
      isPublicRepo: false,
    });
    const storage = createDataStorage(dataFile, { persistentStore: store });
    store.attachDataStorage(storage);

    const localKunye = extractCinemaKunyeFromItems(
      [
        {
          id: 244786,
          media_type: 'movie',
          title: 'Whiplash',
          release_date: '2014-10-10',
          status: 'completed',
          genre_ids: [18],
          cast: [{ id: 996701, name: 'Miles Teller', character: 'Andrew' }],
          updatedAt: '2026-03-01T12:00:00.000Z',
        },
        {
          id: 27205,
          media_type: 'movie',
          title: 'Başlangıç',
          release_date: '2010-07-16',
          status: 'completed',
          genre_ids: [878],
          cast: [{ id: 6193, name: 'Leonardo DiCaprio', character: 'Cobb' }],
          updatedAt: '2026-03-01T12:00:00.000Z',
        },
      ],
      { 18: 'Dram', 878: 'Bilim Kurgu' }
    );
    await store.saveCinemaKunyeSerialized(localKunye, { mode: 'overwrite' });

    const remoteKunye = extractCinemaKunyeFromItems(
      [
        {
          id: 79460,
          media_type: 'tv',
          name: 'Şahsiyet',
          first_air_date: '2018-03-17',
          status: 'completed',
          genre_ids: [80, 18],
          cast: [{ id: 146418, name: 'Haluk Bilginer', character: 'Agâh Beyoğlu' }],
          updatedAt: '2026-03-02T12:00:00.000Z',
        },
        {
          id: 27205,
          media_type: 'movie',
          title: 'Başlangıç',
          release_date: '2010-07-16',
          status: 'completed',
          genre_ids: [28],
          cast: [{ id: 27578, name: 'Elliot Page', character: 'Ariadne' }],
          updatedAt: '2026-03-02T12:00:00.000Z',
        },
      ],
      { 80: 'Suç', 18: 'Dram', 28: 'Aksiyon' }
    );
    gh.seedFile('data/sinema-kunyesi.json', remoteKunye);

    await storage.saveDataSerialized({
      version: 3,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      activeProfileId: 'profile-default',
      profiles: [
        {
          id: 'profile-default',
          name: 'Ana Profil',
          createdAt: '2026-01-01T00:00:00.000Z',
          preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
          items: [],
          favoriteActors: [],
        },
      ],
    });

    await gh.withMockFetch(async () => {
      const inspectBefore = await store.inspectGitHub();
      assert.equal(inspectBefore.ok, true);
      assert.equal(
        inspectBefore.localAfter.files['data/sinema-kunyesi.json']?.uniqueKeyCount,
        2
      );
      assert.equal(
        inspectBefore.remoteBefore.files['data/sinema-kunyesi.json']?.uniqueKeyCount,
        2
      );
      assert.equal(inspectBefore.comparison.semanticEqual, false);

      const reconcileReport = await store.reconcileWithGitHub();
      assert.equal(reconcileReport.ok, true);
      assert.equal(reconcileReport.verifiedEqual, true);
      assert.equal(reconcileReport.comparison?.semanticEqual, true);
      assert.equal(reconcileReport.comparison?.rawFilesEqual, true);
      assert.ok(reconcileReport.filesMerged.includes('data/sinema-kunyesi.json'));

      const mergedDisk = store.readCinemaKunye() || createEmptyCinemaKunyeDocument();
      const mergedRemote = gh.readRemoteJson('data/sinema-kunyesi.json');

      assert.deepEqual(
        Object.keys(mergedDisk.entries).sort(),
        ['baslangic-2010', 'sahsiyet-2018', 'whiplash-2014']
      );
      assert.deepEqual(
        Object.keys(mergedRemote.entries).sort(),
        ['baslangic-2010', 'sahsiyet-2018', 'whiplash-2014']
      );
      // Çakışan 'baslangic-2010' kaydında hem yerel hem uzak oyuncular ve türler birleşti
      assert.equal(mergedDisk.entries['baslangic-2010'].actors.length, 2);
      assert.deepEqual(
        mergedDisk.entries['baslangic-2010'].genreIds.sort((a, b) => a - b),
        [28, 878]
      );
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

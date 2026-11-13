/**
 * SQLite arşivi — profil + stok + stok görsellerinin tek dosyada tam yedeği.
 * Hem modül düzeyinde hem HTTP rotaları üzerinden gidiş-dönüş doğrulanır.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

import {
  writeSqliteArchive,
  readSqliteArchive,
  restoreArchivePostersToCache,
  collectArchivePosters,
  isSqliteArchiveAvailable,
  SqliteArchiveValidationError,
} from '../src/server/sqlite-archive.ts';
import { createCineTrackApp } from '../src/server/app.ts';

const AS_OF = '2026-11-13T10:00:00.000Z';
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('stok-poster-verisi'),
]);

function makeItem(id, overrides = {}) {
  return {
    id,
    media_type: 'movie',
    title: `Film ${id}`,
    status: 'completed',
    personal_rating: 8,
    poster_path: `/poster-${id}.jpg`,
    addedAt: AS_OF,
    ...overrides,
  };
}

function makeSnapshot() {
  return {
    dataDocument: {
      version: 3,
      schemaVersion: 3,
      engineVersion: 'v3.2.0',
      activeProfileId: 'profile-a',
      revision: 7,
      updatedAt: AS_OF,
      profiles: [
        {
          id: 'profile-a',
          name: 'Ana Profil',
          createdAt: AS_OF,
          preferences: { disliked: ['movie:99'], hidden: ['tv:42'], providers: ['netflix'], mood: 'dark' },
          favoriteActors: [{ id: 525, name: 'Nolan' }],
          deleted_keys: { 'movie:900': AS_OF },
          items: [makeItem(1), makeItem(2, { media_type: 'tv', status: 'watching', id: 2 })],
        },
        {
          id: 'profile-b',
          name: 'İkinci Profil',
          createdAt: AS_OF,
          preferences: { disliked: [], providers: [] },
          favoriteActors: [],
          items: [makeItem(3, { personal_rating: 10 })],
        },
      ],
    },
    tasteMaps: {
      'profile-a': { profileId: 'profile-a', entries: { 'movie:1': { shownCount: 2 } }, lastRecommendedKeys: ['movie:2'] },
      'profile-b': { profileId: 'profile-b', entries: {} },
    },
    stock: {
      movies: [{ id: 501, title: 'Stok Film', poster_path: '/stok-film.jpg' }],
      tv: [{ id: 502, name: 'Stok Dizi', poster_path: '/stok-dizi.jpg' }],
      updatedAt: AS_OF,
      cursors: { movie: 3, tv: 1 },
    },
    posterUrls: [
      'https://image.tmdb.org/t/p/w500/stok-film.jpg',
      'https://image.tmdb.org/t/p/w500/stok-dizi.jpg',
      'https://evil.example.com/poster.jpg',
    ],
    createdAt: AS_OF,
    appVersion: 'v3.2.0',
  };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cinetrack-sqlite-'));
}

const fakePosterFetcher = async (url) => {
  if (!url.includes('image.tmdb.org')) return null;
  return { bytes: PNG_BYTES, contentType: 'image/png' };
};

test('SQLite arşivi: profil, stok, zevk haritası ve posterler tam gidiş-dönüş', async (t) => {
  if (!(await isSqliteArchiveAvailable())) {
    t.skip('node:sqlite bu ortamda kullanılamıyor');
    return;
  }
  const dir = makeTempDir();
  const filePath = path.join(dir, 'cinetrack.sqlite');

  const written = await writeSqliteArchive(makeSnapshot(), filePath, {
    fetchPoster: fakePosterFetcher,
  });

  assert.equal(written.profiles, 2);
  assert.equal(written.items, 3);
  assert.equal(written.tasteMaps, 2);
  assert.equal(written.stockMovies, 1);
  assert.equal(written.stockTv, 1);
  assert.equal(written.postersStored, 2, 'Yalnızca izinli poster alan adları arşive girer');
  assert.equal(written.postersFailed, 0, 'İzinsiz alan adı hiç istenmez, başarısız sayılmaz');
  assert.ok(written.byteLength > 0);

  const archive = await readSqliteArchive(filePath);
  assert.equal(archive.schemaVersion, 1);
  assert.equal(archive.counts.profiles, 2);
  assert.equal(archive.counts.items, 3);
  assert.equal(archive.counts.stockMovies, 1);
  assert.equal(archive.counts.stockTv, 1);
  assert.equal(archive.counts.posters, 2);
  assert.equal(archive.createdAt, AS_OF);

  // Profil tam kaydı korunuyor mu?
  const profileA = archive.dataDocument.profiles.find((p) => p.id === 'profile-a');
  assert.ok(profileA);
  assert.equal(profileA.name, 'Ana Profil');
  assert.deepEqual(profileA.preferences.disliked, ['movie:99']);
  assert.deepEqual(profileA.preferences.hidden, ['tv:42']);
  assert.equal(profileA.preferences.mood, 'dark');
  assert.deepEqual(profileA.favoriteActors, [{ id: 525, name: 'Nolan' }]);
  assert.deepEqual(profileA.deleted_keys, { 'movie:900': AS_OF });
  assert.equal(profileA.items.length, 2);
  assert.equal(profileA.items[0].personal_rating, 8);
  assert.equal(profileA.items[0].poster_path, '/poster-1.jpg');
  assert.equal(profileA.items[1].media_type, 'tv');
  assert.equal(profileA.items[1].status, 'watching');

  assert.equal(archive.dataDocument.activeProfileId, 'profile-a');
  assert.equal(archive.dataDocument.revision, 7);

  // Zevk haritaları ve stok
  assert.ok(archive.tasteMaps['profile-a']);
  assert.deepEqual(archive.tasteMaps['profile-a'].lastRecommendedKeys, ['movie:2']);
  assert.equal(archive.stock.movies.length, 1);
  assert.equal(archive.stock.tv.length, 1);
  assert.deepEqual(archive.stock.cursors, { movie: 3, tv: 1 });

  // Poster baytları birebir korunuyor
  assert.equal(archive.posters.length, 2);
  for (const poster of archive.posters) {
    assert.ok(Buffer.isBuffer(poster.bytes));
    assert.ok(poster.bytes.equals(PNG_BYTES));
    assert.equal(poster.contentType, 'image/png');
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test('SQLite arşivi: posterler önbelleğe geri yazılır (çevrimdışı görsel)', async (t) => {
  if (!(await isSqliteArchiveAvailable())) {
    t.skip('node:sqlite bu ortamda kullanılamıyor');
    return;
  }
  const dir = makeTempDir();
  const filePath = path.join(dir, 'cinetrack.sqlite');
  const cacheDir = path.join(dir, 'cache', 'posters');

  await writeSqliteArchive(makeSnapshot(), filePath, { fetchPoster: fakePosterFetcher });
  const archive = await readSqliteArchive(filePath);

  const restored = await restoreArchivePostersToCache(archive.posters, cacheDir);
  assert.equal(restored.written, 2);
  assert.equal(restored.skipped, 0);

  const files = fs.readdirSync(cacheDir).filter((name) => name.endsWith('.png'));
  assert.equal(files.length, 2);
  const expectedHash = crypto
    .createHash('sha256')
    .update('https://image.tmdb.org/t/p/w500/stok-film.jpg')
    .digest('hex');
  assert.ok(files.includes(`${expectedHash}.png`), 'Önbellek dosya adı URL özetiyle aynı olmalı');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('SQLite arşivi: geçersiz anlık görüntü reddedilir', async (t) => {
  if (!(await isSqliteArchiveAvailable())) {
    t.skip('node:sqlite bu ortamda kullanılamıyor');
    return;
  }
  const dir = makeTempDir();
  await assert.rejects(
    () =>
      writeSqliteArchive(
        { dataDocument: { profiles: [] } },
        path.join(dir, 'empty.sqlite')
      ),
    SqliteArchiveValidationError
  );

  await assert.rejects(
    () =>
      writeSqliteArchive(
        {
          dataDocument: {
            profiles: [{ id: '../escape', name: 'x', items: [] }],
            activeProfileId: '../escape',
          },
        },
        path.join(dir, 'traversal.sqlite')
      ),
    SqliteArchiveValidationError
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('collectArchivePosters: izin listesi, tekilleştirme ve sınırlar', async () => {
  const calls = [];
  const result = await collectArchivePosters(
    [
      'https://image.tmdb.org/t/p/w500/a.jpg',
      'https://image.tmdb.org/t/p/w500/a.jpg',
      'http://image.tmdb.org/t/p/w500/insecure.jpg',
      'https://evil.example.com/x.jpg',
    ],
    {
      fetchPoster: async (url) => {
        calls.push(url);
        return { bytes: PNG_BYTES, contentType: 'image/png' };
      },
    }
  );

  assert.equal(calls.length, 1, 'Tekrarlanan ve izinsiz URL’ler istenmez');
  assert.equal(result.posters.length, 1);
  assert.equal(result.failed, 0);
});

test('HTTP rotaları: SQLite arşivi indir → geri yükle uçtan uca', async (t) => {
  if (!(await isSqliteArchiveAvailable())) {
    t.skip('node:sqlite bu ortamda kullanılamıyor');
    return;
  }
  const dataDir = makeTempDir();
  const { app, storage } = createCineTrackApp({
    dataDir,
    maxDataBytes: 25 * 1024 * 1024,
    maxProfiles: 20,
    maxItemsPerProfile: 25000,
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const snapshot = makeSnapshot();
    // Sunucuda mevcut bir belge olsun (geri yükleme üzerine yazacak).
    await storage.saveDataSerialized(
      {
        version: 3,
        schemaVersion: 3,
        activeProfileId: 'profile-a',
        updatedAt: AS_OF,
        profiles: [
          {
            id: 'profile-a',
            name: 'Eski',
            createdAt: AS_OF,
            preferences: { disliked: [], providers: [] },
            favoriteActors: [],
            items: [],
          },
        ],
      },
      { forceOverwrite: true, confirmBulkDelete: true, requirePrecondition: false }
    );

    const exportRes = await fetch(`${baseUrl}/api/archive/sqlite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    });
    assert.equal(exportRes.status, 200);
    assert.match(exportRes.headers.get('content-type') || '', /sqlite/);
    const stats = JSON.parse(exportRes.headers.get('x-archive-stats') || '{}');
    assert.equal(stats.profiles, 2);
    assert.equal(stats.items, 3);

    const archiveBytes = Buffer.from(await exportRes.arrayBuffer());
    assert.equal(archiveBytes.subarray(0, 15).toString('utf8'), 'SQLite format 3');

    const restoreRes = await fetch(`${baseUrl}/api/archive/sqlite/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: archiveBytes,
    });
    assert.equal(restoreRes.status, 200);
    const restored = await restoreRes.json();

    assert.equal(restored.ok, true);
    assert.equal(restored.counts.profiles, 2);
    assert.equal(restored.counts.items, 3);
    assert.equal(restored.dataDocument.profiles.length, 2);
    const restoredA = restored.dataDocument.profiles.find((p) => p.id === 'profile-a');
    assert.equal(restoredA.name, 'Ana Profil');
    assert.equal(restoredA.items.length, 2);
    assert.deepEqual(restoredA.preferences.hidden, ['tv:42']);
    assert.deepEqual(restored.stock.cursors, { movie: 3, tv: 1 });

    // Sunucudaki kalıcı belge de arşivle değişmiş olmalı.
    const onDisk = await storage.readDataAsync();
    assert.equal(onDisk.profiles.length, 2);
    assert.equal(
      onDisk.profiles.reduce((sum, p) => sum + p.items.length, 0),
      3
    );

    // Bozuk dosya reddedilir.
    const badRes = await fetch(`${baseUrl}/api/archive/sqlite/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('bu bir sqlite dosyasi degil'),
    });
    assert.equal(badRes.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

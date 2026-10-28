import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import {
  EXCEL_SHEET_NAMES,
  buildProfileBackupDataset,
  detectImageExtension,
  executeProfileBackupExport,
  formatExportBaseName,
  generateProfileExcelBuffer,
  getNeutralPosterPlaceholderPng,
  resolveUniqueExportFileName,
  sanitizeSpreadsheetText,
} from '../src/server/excel-profile-backup.ts';
import { PersistentDataStore } from '../src/server/persistent-store.ts';
import { createCineTrackApp } from '../src/server/app.ts';

function createTempDir(prefix = 'cinetrack-excel-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Minimal valid JPEG binary fixture (SOI FF D8 FF E0 ... EOI FF D9)
 */
function makeFakeJpegBuffer(seedByte = 0x42) {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
    0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, seedByte, 0x11, 0x22, 0x33,
    0xff, 0xd9,
  ]);
}

function makeRichProfile() {
  return {
    id: 'profile-main',
    name: 'İbrahim Şahin — Özel Arşiv',
    createdAt: '2026-01-10T08:30:00.000Z',
    preferences: {
      disliked: ['movie:999', 'tv:999', 'movie:777'],
      providers: ['8', '337'],
      mood: 'mind-bending',
      reminders: true,
      notified: ['tv:200'],
    },
    favoriteActors: [
      { id: 101, name: 'Haluk Bilginer', profile_path: '/haluk.jpg', addedAt: '2026-02-01T10:00:00.000Z' },
    ],
    items: [
      // Completed movie with identical numeric ID 550 as a TV show below!
      {
        id: 550,
        media_type: 'movie',
        title: 'Dövüş Kulübü',
        release_date: '1999-10-15',
        vote_average: 8.4,
        personal_rating: 9,
        genre_ids: [18, 53],
        poster_path: '/poster-550-movie.jpg',
        status: 'completed',
        runtime: 139,
        addedAt: '2026-03-01T14:20:00.000Z',
        updatedAt: '2026-03-02T19:45:00.000Z',
        note: 'Çağdaş sinemanın en çarpıcı kurgularından biri.',
      },
      // Watchlist TV series with identical numeric ID 550!
      {
        id: 550,
        media_type: 'tv',
        title: 'Şahsiyet ve Ötesi: Çok Uzun Başlıklı Özel Bir Polisiye Mini Dizi Serüveni',
        release_date: '2018-03-17',
        vote_average: 8.9,
        personal_rating: '',
        genre_ids: [80, 9648, 18],
        poster_path: '/poster-550-tv.jpg',
        status: 'watchlist',
        number_of_seasons: 2,
        number_of_episodes: 22,
        addedAt: '2026-03-05T11:10:00.000Z',
        updatedAt: '2026-03-05T11:10:00.000Z',
      },
      // Watching TV series with episode progress and shared poster URL to verify deduplication
      {
        id: 200,
        media_type: 'tv',
        title: 'Karanlık Çağrılar',
        release_date: '2024-11-02',
        vote_average: 7.7,
        personal_rating: 8,
        genre_ids: [10765, 9648],
        poster_path: '/poster-shared.jpg',
        status: 'watching',
        watched_episodes: ['S1E1', 'S1E2', 'S1E3'],
        number_of_seasons: 1,
        number_of_episodes: 8,
        episode_run_time: 52,
        addedAt: '2026-04-01T09:00:00.000Z',
        updatedAt: '2026-04-12T21:30:00.000Z',
      },
      // Completed movie sharing the same poster URL + formula-injection title & note + missing optional fields
      {
        id: 301,
        media_type: 'movie',
        title: '=SUM(1,2) Tehlikeli Başlık',
        release_date: '',
        vote_average: 0,
        personal_rating: '',
        genre_ids: [],
        poster_path: '/poster-shared.jpg',
        status: 'completed',
        addedAt: '',
        updatedAt: '',
        note: '@cmd|calc Zararlı Not Denemesi',
      },
      // Watchlist custom movie without poster_path
      {
        id: 'custom-1',
        media_type: 'movie',
        title: 'Kış Uykusu Yönetmen Kurgusu',
        release_date: '2014-06-13',
        vote_average: 8.1,
        personal_rating: 10,
        genre_ids: [18],
        poster_path: null,
        status: 'watchlist',
        custom: true,
        addedAt: '2026-04-15T16:00:00.000Z',
        updatedAt: '2026-04-15T16:00:00.000Z',
      },
    ],
  };
}

test('1 & 2 & 3. Workbook has exact 5 sheets in order, routes list states accurately, and keeps movie:<id> & tv:<id> separate', async (t) => {
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const profile = makeRichProfile();
  const originalSnapshot = JSON.stringify(profile);

  const moviesCatalog = {
    'movie:999': {
      key: 'movie:999',
      id: 999,
      media_type: 'movie',
      title: 'İlgilenmediğim Film',
      poster_path: '/poster-disliked-999m.jpg',
      genre_ids: [27],
      vote_average: 4.3,
      release_date: '2022-08-01',
    },
  };
  const tvCatalog = {
    'tv:999': {
      key: 'tv:999',
      id: 999,
      media_type: 'tv',
      title: 'İlgilenmediğim Dizi',
      poster_path: '/poster-disliked-999t.jpg',
      genre_ids: [10764],
      vote_average: 3.9,
      first_air_date: '2021-02-14',
    },
  };

  const fetchCalls = [];
  const fakePosterFetcher = async (url) => {
    fetchCalls.push(url);
    return {
      status: 200,
      contentType: 'image/jpeg',
      buffer: makeFakeJpegBuffer(fetchCalls.length),
    };
  };

  const tmdbFetched = [];
  const fakeTmdbFetcher = async (mediaType, id) => {
    tmdbFetched.push(`${mediaType}:${id}`);
    if (mediaType === 'movie' && id === 777) {
      return {
        id: 777,
        title: 'TMDB Üzerinden Tamamlanan Film',
        release_date: '2020-05-20',
        vote_average: 5.2,
        genres: [{ id: 28, name: 'Aksiyon' }],
        poster_path: '/poster-777.jpg',
      };
    }
    return null;
  };

  const built = await generateProfileExcelBuffer({
    profile,
    exportedAt: new Date('2026-10-28T16:30:00.000Z'),
    moviesCatalog,
    tvCatalog,
    posterCacheDir: path.join(tmpDir, 'posters'),
    posterFetcher: fakePosterFetcher,
    fetchMissingTmdbItem: fakeTmdbFetcher,
  });

  // Original profile object must never be mutated
  assert.equal(JSON.stringify(profile), originalSnapshot);

  // Exact 5 sheets in exact order
  assert.deepEqual(built.sheetNames, [
    'Özet',
    'İzlenen',
    'İzlenecek',
    'İzleniyor',
    'İlgilenmiyorum',
  ]);
  assert.deepEqual(built.sheetNames, [...EXCEL_SHEET_NAMES]);

  // Verify TMDB fallback fetched missing disliked item movie:777
  assert.deepEqual(tmdbFetched, ['movie:777']);

  // Verify sheet record distribution
  assert.deepEqual(built.dataset.sheetCounts.İzlenen, { total: 2, movie: 2, tv: 0 });
  assert.deepEqual(built.dataset.sheetCounts.İzlenecek, { total: 2, movie: 1, tv: 1 });
  assert.deepEqual(built.dataset.sheetCounts.İzleniyor, { total: 1, movie: 0, tv: 1 });
  assert.deepEqual(built.dataset.sheetCounts.İlgilenmiyorum, { total: 3, movie: 2, tv: 1 });
  assert.equal(built.dataset.totalItemsCount, 8);
  assert.equal(built.dataset.totalMovieCount, 5);
  assert.equal(built.dataset.totalTvCount, 3);

  // Verify movie:550 vs tv:550 and movie:999 vs tv:999 are never conflated
  const izlenenKeys = built.dataset.sheets.İzlenen.map((r) => r.canonicalKey);
  const izlenecekKeys = built.dataset.sheets.İzlenecek.map((r) => r.canonicalKey);
  const ilgilenmiyorumKeys = built.dataset.sheets.İlgilenmiyorum.map((r) => r.canonicalKey);
  assert.ok(izlenenKeys.includes('movie:550'));
  assert.ok(!izlenenKeys.includes('tv:550'));
  assert.ok(izlenecekKeys.includes('tv:550'));
  assert.ok(!izlenecekKeys.includes('movie:550'));
  assert.ok(ilgilenmiyorumKeys.includes('movie:999'));
  assert.ok(ilgilenmiyorumKeys.includes('tv:999'));

  // Shared poster URL '/poster-shared.jpg' must be downloaded only once!
  const sharedDownloads = fetchCalls.filter((u) => u.endsWith('/poster-shared.jpg'));
  assert.equal(sharedDownloads.length, 1);

  // Re-running with warm disk cache makes zero network calls
  const secondFetchCalls = [];
  await generateProfileExcelBuffer({
    profile,
    exportedAt: new Date('2026-10-28T16:31:00.000Z'),
    moviesCatalog,
    tvCatalog,
    posterCacheDir: path.join(tmpDir, 'posters'),
    posterFetcher: async (url) => {
      secondFetchCalls.push(url);
      return { status: 200, contentType: 'image/jpeg', buffer: makeFakeJpegBuffer(9) };
    },
    fetchMissingTmdbItem: fakeTmdbFetcher,
  });
  assert.equal(secondFetchCalls.length, 0);
});

test('4, 5, 6, 7, 10, 11 & 14. Generated .xlsx opens cleanly in ExcelJS with exact columns, embedded images, AutoFilter, frozen header, Turkish text, formula safety, and matching Özet counts', async (t) => {
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const profile = makeRichProfile();
  const built = await generateProfileExcelBuffer({
    profile,
    exportedAt: new Date('2026-10-28T16:30:00.000Z'),
    moviesCatalog: {
      'movie:999': {
        key: 'movie:999',
        id: 999,
        media_type: 'movie',
        title: 'Çığlık Ötesi ĞÜŞİÖÇ ğüşıöç',
        poster_path: '/p999m.jpg',
        genre_ids: [27],
        vote_average: 5.5,
        release_date: '2021-10-10',
      },
      'movie:777': {
        key: 'movie:777',
        id: 777,
        media_type: 'movie',
        title: 'Sıradan Bir Gün',
        poster_path: '/p777m.jpg',
        genre_ids: [35],
        vote_average: 6.1,
        release_date: '2020-01-01',
      },
    },
    tvCatalog: {
      'tv:999': {
        key: 'tv:999',
        id: 999,
        media_type: 'tv',
        title: 'İzlenmeyecek Dizi',
        poster_path: '/p999t.jpg',
        genre_ids: [18],
        vote_average: 4.8,
        first_air_date: '2019-09-09',
      },
    },
    posterCacheDir: path.join(tmpDir, 'posters'),
    posterFetcher: async () => ({
      status: 200,
      contentType: 'image/jpeg',
      buffer: makeFakeJpegBuffer(0x55),
    }),
  });

  const xlsxFile = path.join(tmpDir, 'verified.xlsx');
  fs.writeFileSync(xlsxFile, built.buffer);

  // Open generated file from disk using fresh ExcelJS Workbook instance (Test #14)
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxFile);

  assert.deepEqual(
    wb.worksheets.map((s) => s.name),
    ['Özet', 'İzlenen', 'İzlenecek', 'İzleniyor', 'İlgilenmiyorum']
  );

  // Embedded media binary check (Test #7)
  assert.ok(Array.isArray(wb.model.media) && wb.model.media.length >= 2);
  assert.equal(built.embeddedPostersCount, 7); // 7 items have poster_path, 1 custom item has null poster_path
  assert.equal(built.missingPosterSourceCount, 1);
  assert.equal(built.posterErrorsCount, 0);

  // Özet sheet counts must match actual rows in the 4 content sheets (Test #11)
  const ozet = wb.getWorksheet('Özet');
  assert.ok(ozet);
  assert.equal(ozet.getCell('B2').value.includes('İbrahim Şahin — Özel Arşiv'), true);
  assert.equal(ozet.getCell('B8').value, 8); // Toplam İçerik Kaydı
  assert.equal(ozet.getCell('C8').value, 5); // Toplam Film
  assert.equal(ozet.getCell('D8').value, 3); // Toplam Dizi
  assert.equal(ozet.getCell('E8').value, 7); // Gömülü Poster Sayısı
  assert.equal(ozet.getCell('F8').value, 0); // Poster İndirme Hatası

  // Card totals on Özet (Row 12: B12=İzlenen, C12=İzlenecek, D12=İzleniyor, E12=İlgilenmiyorum, F12=Genel Toplam)
  const izlenenWs = wb.getWorksheet('İzlenen');
  const izlenecekWs = wb.getWorksheet('İzlenecek');
  const izleniyorWs = wb.getWorksheet('İzleniyor');
  const ilgilenmiyorumWs = wb.getWorksheet('İlgilenmiyorum');

  const countActualDataRows = (ws) => {
    let n = 0;
    for (let r = 5; r <= ws.rowCount; r += 1) {
      if (ws.getRow(r).getCell(13).value) n += 1;
    }
    return n;
  };

  assert.equal(ozet.getCell('B12').value, countActualDataRows(izlenenWs));
  assert.equal(ozet.getCell('C12').value, countActualDataRows(izlenecekWs));
  assert.equal(ozet.getCell('D12').value, countActualDataRows(izleniyorWs));
  assert.equal(ozet.getCell('E12').value, countActualDataRows(ilgilenmiyorumWs));
  assert.equal(ozet.getCell('F12').value, 8);

  // Check table structure, frozen header, zero merged cells, AutoFilter, and column formatting on content sheets (Tests #4, #5, #6, #10)
  for (const ws of [izlenenWs, izlenecekWs, izleniyorWs, ilgilenmiyorumWs]) {
    // Zero merged cells so Excel sorting/filtering never breaks
    assert.equal(ws.hasMerges, false, `${ws.name} must not contain merged cells`);

    // Frozen pane at row 4
    assert.equal(ws.views[0].state, 'frozen');
    assert.equal(ws.views[0].ySplit, 4);

    // Real AutoFilter starting at A4:M<last>
    assert.ok(ws.autoFilter);

    // Exact base header order
    const headers = [];
    for (let c = 1; c <= 10; c += 1) {
      headers.push(ws.getRow(4).getCell(c).value);
    }
    assert.deepEqual(headers, [
      'Poster',
      'Tür',
      'İçerik Adı',
      'Yıl',
      'TMDB Puanı',
      'Kişisel Puan',
      'Türler / Kategoriler',
      'TMDB ID',
      'Listeye Eklenme Tarihi',
      'Kullanıcı Notu',
    ]);

    // Bounded title column width (~33 chars) and poster column width (~10.5 -> ~72px)
    assert.ok(ws.getColumn(1).width >= 9.5 && ws.getColumn(1).width <= 12);
    assert.equal(ws.getColumn(3).width, 33);

    // Every data row has height 84 pt and an embedded image anchored in col 0
    const rowCount = countActualDataRows(ws);
    const images = ws.getImages();
    assert.equal(images.length, rowCount);
    for (const img of images) {
      assert.ok(img.range.tl.nativeCol === 0 || Math.floor(img.range.tl.col) === 0);
      assert.ok(img.range.br.col < 1);
    }
  }

  // Long title preserved completely without truncation & wrapText enabled (Test #6)
  const longRowTitle = izlenecekWs.getRow(6).getCell(3);
  assert.equal(
    longRowTitle.value,
    'Şahsiyet ve Ötesi: Çok Uzun Başlıklı Özel Bir Polisiye Mini Dizi Serüveni'
  );
  assert.equal(longRowTitle.alignment?.wrapText, true);
  assert.equal(longRowTitle.font?.size, 11);
  assert.equal(longRowTitle.font?.bold, true);

  // Small 7pt colored Tür badge
  const tvBadgeCell = izlenecekWs.getRow(6).getCell(2);
  assert.equal(tvBadgeCell.value, 'DİZİ');
  assert.equal(tvBadgeCell.font?.size, 7);

  // Formula-injection protection & null empty values (never 0, false, "null", "undefined") (Test #4)
  // Row 5 in İzlenen is Dövüş Kulübü (addedAt 2026-03-01), Row 6 is '=SUM(1,2) Tehlikeli Başlık' (empty addedAt)
  const safeFormulaRow = izlenenWs.getRow(6);
  assert.equal(safeFormulaRow.getCell(3).value, "'=SUM(1,2) Tehlikeli Başlık");
  assert.equal(safeFormulaRow.getCell(10).value, "'@cmd|calc Zararlı Not Denemesi");
  assert.equal(safeFormulaRow.getCell(4).value, null); // Missing year -> null, not 0
  assert.equal(safeFormulaRow.getCell(5).value, null); // vote_average 0 -> null, not 0
  assert.equal(safeFormulaRow.getCell(6).value, null); // empty personal_rating -> null
  assert.equal(safeFormulaRow.getCell(7).value, null); // empty genres -> null
  assert.equal(safeFormulaRow.getCell(9).value, null); // empty addedAt -> null

  // Turkish character preservation across all 3 disliked rows (Test #10)
  const dislikedTitlesInSheet = [
    ilgilenmiyorumWs.getRow(5).getCell(3).value,
    ilgilenmiyorumWs.getRow(6).getCell(3).value,
    ilgilenmiyorumWs.getRow(7).getCell(3).value,
  ];
  assert.ok(dislikedTitlesInSheet.includes('Sıradan Bir Gün'));
  assert.ok(dislikedTitlesInSheet.includes('İzlenmeyecek Dizi'));
  assert.ok(dislikedTitlesInSheet.includes('Çığlık Ötesi ĞÜŞİÖÇ ğüşıöç'));
});

test('8. Poster HTTP errors, timeouts, and corrupt image bytes do not abort export and report accurate posterErrorsCount', async (t) => {
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const profile = {
    id: 'p-err',
    name: 'Poster Hata Testi',
    createdAt: '2026-01-01T00:00:00.000Z',
    preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
    favoriteActors: [],
    items: [
      {
        id: 1,
        media_type: 'movie',
        title: 'Sağlam Posterli Film',
        poster_path: '/ok.jpg',
        status: 'completed',
      },
      {
        id: 2,
        media_type: 'movie',
        title: '404 Posterli Film',
        poster_path: '/missing404.jpg',
        status: 'completed',
      },
      {
        id: 3,
        media_type: 'tv',
        title: 'Bozuk Görsel Yanıtlı Dizi',
        poster_path: '/corrupt-html.jpg',
        status: 'watchlist',
      },
      {
        id: 4,
        media_type: 'movie',
        title: 'Zaman Aşımı Film',
        poster_path: '/timeout.jpg',
        status: 'watching',
      },
    ],
  };

  const built = await generateProfileExcelBuffer({
    profile,
    posterCacheDir: path.join(tmpDir, 'posters'),
    posterTimeoutMs: 50,
    posterFetcher: async (url) => {
      if (url.endsWith('/ok.jpg')) {
        return { status: 200, contentType: 'image/jpeg', buffer: makeFakeJpegBuffer(0x21) };
      }
      if (url.endsWith('/missing404.jpg')) {
        return { status: 404, contentType: 'text/plain', buffer: Buffer.from('Not Found') };
      }
      if (url.endsWith('/corrupt-html.jpg')) {
        return { status: 200, contentType: 'text/html', buffer: Buffer.from('<html>error</html>') };
      }
      const abortErr = new Error('Aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    },
  });

  assert.equal(built.embeddedPostersCount, 1);
  assert.equal(built.posterErrorsCount, 3);
  assert.equal(built.placeholderPostersCount, 3);
  assert.equal(built.posterErrors.length, 3);

  // Neutral PNG placeholder itself is a valid PNG
  assert.equal(detectImageExtension(getNeutralPosterPlaceholderPng()), 'png');

  // Workbook still opens cleanly
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(built.buffer);
  assert.equal(wb.worksheets.length, 5);
});

test('9. Empty profile generates a valid, openable 5-sheet .xlsx with zero counts', async (t) => {
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const emptyProfile = {
    id: 'profile-empty',
    name: 'Boş Profil',
    createdAt: '2026-10-28T00:00:00.000Z',
    preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
    items: [],
    favoriteActors: [],
  };

  const built = await generateProfileExcelBuffer({
    profile: emptyProfile,
    posterCacheDir: path.join(tmpDir, 'posters'),
  });

  assert.equal(built.dataset.totalItemsCount, 0);
  assert.equal(built.embeddedPostersCount, 0);
  assert.equal(built.posterErrorsCount, 0);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(built.buffer);
  assert.deepEqual(
    wb.worksheets.map((s) => s.name),
    ['Özet', 'İzlenen', 'İzlenecek', 'İzleniyor', 'İlgilenmiyorum']
  );
  assert.equal(wb.getWorksheet('Özet').getCell('B8').value, 0);
});

test('Dual-state items (simultaneously in saved items and preferences.disliked) preserve real model meaning and report dualStateKeys', async () => {
  const profile = {
    id: 'p-dual',
    name: 'Çift Durum Testi',
    createdAt: '2026-01-01T00:00:00.000Z',
    preferences: { disliked: ['movie:10'], providers: [], mood: '', reminders: false, notified: [] },
    items: [
      { id: 10, media_type: 'movie', title: 'Hem İzlenmiş Hem İlgilenmiyorum', status: 'completed' },
    ],
    favoriteActors: [],
  };

  const ds = await buildProfileBackupDataset({ profile });
  assert.deepEqual(ds.dualStateKeys, ['movie:10']);
  assert.equal(ds.sheetCounts.İzlenen.total, 1);
  assert.equal(ds.sheetCounts.İlgilenmiyorum.total, 1);
  // Deduplicated statistical summary counts unique canonical keys once
  assert.equal(ds.decadeDistribution.length, 0);
});

test('12. JSON + Excel error isolation & collision-safe timestamped filenames never overwrite existing exports', async (t) => {
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const fixedNow = new Date(2026, 9, 28, 14, 5, 0); // 2026-10-28_1405
  assert.equal(formatExportBaseName(fixedNow), 'CineTrack_Profile_2026-10-28_1405');

  const doc = {
    version: 3,
    schemaVersion: 3,
    activeProfileId: 'profile-main',
    profiles: [makeRichProfile()],
  };

  // Case A: Simulated Excel failure must NOT fail JSON backup
  const partialReport = await executeProfileBackupExport({
    dataDir: tmpDir,
    document: doc,
    includeJson: true,
    includeXlsx: true,
    now: fixedNow,
    forceExcelErrorForTest: 'Simüle edilmiş Excel motor hatası',
  });

  assert.equal(partialReport.jsonBackup.ok, true);
  assert.equal(partialReport.excelBackup.ok, false);
  assert.equal(partialReport.partialFailure, true);
  assert.equal(partialReport.jsonBackup.fileName, 'CineTrack_Profile_2026-10-28_1405.json');
  assert.ok(fs.existsSync(partialReport.jsonBackup.absolutePath));

  // Case B: Full export at exact same minute creates _02.json and primary .xlsx without overwriting first .json
  const secondReport = await executeProfileBackupExport({
    dataDir: tmpDir,
    document: doc,
    includeJson: true,
    includeXlsx: true,
    now: fixedNow,
    posterFetcher: async () => ({
      status: 200,
      contentType: 'image/jpeg',
      buffer: makeFakeJpegBuffer(0x33),
    }),
  });

  assert.equal(secondReport.ok, true);
  assert.equal(secondReport.jsonBackup.fileName, 'CineTrack_Profile_2026-10-28_1405_02.json');
  assert.equal(secondReport.excelBackup.fileName, 'CineTrack_Profile_2026-10-28_1405.xlsx');

  // Case C: Another export at exact same minute creates _02.xlsx without overwriting first .xlsx
  const thirdName = resolveUniqueExportFileName(
    path.join(tmpDir, 'exports'),
    'CineTrack_Profile_2026-10-28_1405',
    'xlsx'
  );
  assert.equal(thirdName.fileName, 'CineTrack_Profile_2026-10-28_1405_02.xlsx');

  // Formula sanitization direct unit checks
  assert.equal(sanitizeSpreadsheetText('=HYPERLINK("http://evil")'), '\'=HYPERLINK("http://evil")');
  assert.equal(sanitizeSpreadsheetText('+12345'), "'+12345");
  assert.equal(sanitizeSpreadsheetText('-cmd'), "'-cmd");
  assert.equal(sanitizeSpreadsheetText('Normal Türkçe Başlık'), 'Normal Türkçe Başlık');
  assert.equal(sanitizeSpreadsheetText('   '), null);
});

test('13. GitHub binary .xlsx upload verifies post-upload SHA-256 read-back (including >1MB Git Blob fallback), avoids overwriting existing timestamped files, and enforces public-repo privacy guard', async (t) => {
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const remoteFiles = new Map(); // repoPath -> { sha, buffer }
  const remoteBlobs = new Map(); // sha -> buffer
  let repoIsPrivate = false; // Public repo to test privacy guard first!

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input, init = {}) => {
    const urlStr = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(urlStr);

    if (u.pathname === '/repos/test-owner/test-repo' && method === 'GET') {
      return new Response(
        JSON.stringify({
          full_name: 'test-owner/test-repo',
          private: repoIsPrivate,
          default_branch: 'main',
          permissions: { push: true, pull: true },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (u.pathname === '/repos/test-owner/test-repo/branches/main' && method === 'GET') {
      return new Response(
        JSON.stringify({ name: 'main', commit: { sha: 'branch-head-sha' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const blobMatch = u.pathname.match(/^\/repos\/test-owner\/test-repo\/git\/blobs\/([^/]+)$/);
    if (blobMatch && method === 'GET') {
      const sha = decodeURIComponent(blobMatch[1]);
      const buf = remoteBlobs.get(sha);
      if (!buf) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      return new Response(
        JSON.stringify({
          sha,
          size: buf.length,
          encoding: 'base64',
          content: buf.toString('base64'),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const contentsMatch = u.pathname.match(/^\/repos\/test-owner\/test-repo\/contents\/(.+)$/);
    if (contentsMatch) {
      const repoPath = contentsMatch[1];
      if (method === 'GET') {
        const entry = remoteFiles.get(repoPath);
        if (!entry) {
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        }
        // Simulate GitHub >1MB Contents API behavior (`encoding: 'none', content: ''`)
        if (entry.buffer.length > 1024 * 1024) {
          return new Response(
            JSON.stringify({
              name: path.posix.basename(repoPath),
              path: repoPath,
              sha: entry.sha,
              size: entry.buffer.length,
              encoding: 'none',
              content: '',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            name: path.posix.basename(repoPath),
            path: repoPath,
            sha: entry.sha,
            size: entry.buffer.length,
            encoding: 'base64',
            content: entry.buffer.toString('base64'),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (method === 'PUT') {
        const body = JSON.parse(String(init.body || '{}'));
        const buf = Buffer.from(body.content, 'base64');
        const sha = crypto.createHash('sha1').update(buf).digest('hex');
        remoteFiles.set(repoPath, { sha, buffer: buf });
        remoteBlobs.set(sha, buf);
        return new Response(
          JSON.stringify({ content: { name: path.posix.basename(repoPath), path: repoPath, sha } }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response(JSON.stringify({ message: `Unhandled ${method} ${u.pathname}` }), {
      status: 500,
    });
  };

  const store = new PersistentDataStore({
    dataDir: tmpDir,
    githubToken: 'github_pat_11FAKE_TOKEN_FOR_EXCEL_UPLOAD_999999',
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    githubBranch: 'main',
    isPublicRepo: true,
    allowPublicPersonalSync: false,
  });

  const sampleBuffer = crypto.randomBytes(1_150_000); // > 1 MB binary buffer to exercise Git Blob read-back!
  const expectedSha256 = crypto.createHash('sha256').update(sampleBuffer).digest('hex');

  // 13a: Public repo WITHOUT explicit consent blocks personal Excel upload
  const blockedRes = await store.uploadBinaryBackupToGitHub({
    fileName: 'CineTrack_Profile_2026-10-28_1500.xlsx',
    contentBuffer: sampleBuffer,
  });
  assert.equal(blockedRes.ok, false);
  assert.equal(blockedRes.blockedByPublicGuard, true);
  assert.equal(blockedRes.verifiedReadBack, false);
  assert.equal(remoteFiles.size, 0);

  // 13b: Switch repo to private (or grant consent) -> >1MB binary upload + Git Blob SHA-256 read-back succeeds
  repoIsPrivate = true;
  const uploadRes = await store.uploadBinaryBackupToGitHub({
    fileName: 'CineTrack_Profile_2026-10-28_1500.xlsx',
    contentBuffer: sampleBuffer,
  });
  assert.equal(uploadRes.ok, true);
  assert.equal(uploadRes.verifiedReadBack, true);
  assert.equal(uploadRes.repoPath, 'data/exports/CineTrack_Profile_2026-10-28_1500.xlsx');
  assert.equal(uploadRes.localHash, expectedSha256);
  assert.equal(uploadRes.readBackHash, expectedSha256);

  // 13c: Uploading different content with the same timestamped filename chooses _02.xlsx instead of overwriting!
  const secondBuffer = Buffer.from('PK-second-distinct-xlsx-archive-bytes');
  const secondRes = await store.uploadBinaryBackupToGitHub({
    fileName: 'CineTrack_Profile_2026-10-28_1500.xlsx',
    contentBuffer: secondBuffer,
  });
  assert.equal(secondRes.ok, true);
  assert.equal(secondRes.verifiedReadBack, true);
  assert.equal(secondRes.repoPath, 'data/exports/CineTrack_Profile_2026-10-28_1500_02.xlsx');
  // Original file on GitHub remains untouched
  assert.equal(
    remoteFiles.get('data/exports/CineTrack_Profile_2026-10-28_1500.xlsx').buffer.length,
    sampleBuffer.length
  );
});

test('HTTP API integration: POST /api/backup/profile-export and GET /api/backup/exports/:fileName serve valid .xlsx and block path traversal', async (t) => {
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const seedDoc = {
    version: 3,
    schemaVersion: 3,
    revision: 1,
    updatedAt: '2026-10-28T10:00:00.000Z',
    activeProfileId: 'profile-main',
    profiles: [
      {
        id: 'profile-main',
        name: 'API Test Profili',
        createdAt: '2026-10-28T10:00:00.000Z',
        preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
        favoriteActors: [],
        items: [
          {
            id: 42,
            media_type: 'movie',
            title: 'Otostopçunun Galaksi Rehberi',
            release_date: '2005-04-28',
            vote_average: 6.7,
            personal_rating: 8,
            genre_ids: [878, 35],
            poster_path: null,
            status: 'completed',
            addedAt: '2026-10-28T10:05:00.000Z',
            updatedAt: '2026-10-28T10:05:00.000Z',
          },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(tmpDir, 'cinetrack-data.json'), JSON.stringify(seedDoc, null, 2));

  const { app } = createCineTrackApp({ dataDir: tmpDir });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const exportRes = await fetch(`${baseUrl}/api/backup/profile-export`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl,
    },
    body: JSON.stringify({ includeJson: true, includeXlsx: true, uploadToGithub: false }),
  });
  assert.equal(exportRes.status, 200);
  const report = await exportRes.json();
  assert.equal(report.ok, true);
  assert.equal(report.jsonBackup.ok, true);
  assert.equal(report.excelBackup.ok, true);
  assert.equal(report.excelBackup.totalItemsCount, 1);

  // Download generated .xlsx via HTTP endpoint and verify bytes match SHA-256
  const dlRes = await fetch(`${baseUrl}${report.excelBackup.downloadUrl}`);
  assert.equal(dlRes.status, 200);
  assert.match(
    dlRes.headers.get('content-type') || '',
    /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/
  );
  const dlBuf = Buffer.from(await dlRes.arrayBuffer());
  const dlSha = crypto.createHash('sha256').update(dlBuf).digest('hex');
  assert.equal(dlSha, report.excelBackup.sha256);

  // Path traversal / invalid filename must be rejected with 400
  const badRes = await fetch(`${baseUrl}/api/backup/exports/..%2Fcinetrack-data.json`);
  assert.equal(badRes.status, 400);
});

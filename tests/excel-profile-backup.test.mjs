import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import {
  EMU_PER_PIXEL,
  EXCEL_SHEET_NAMES,
  POSTER_CELL_HEIGHT_PX,
  POSTER_CELL_WIDTH_PX,
  POSTER_ROW_HEIGHT_PT,
  POSTER_TARGET_HEIGHT_PX,
  POSTER_TARGET_WIDTH_PX,
  buildProfileBackupDataset,
  computePosterPlacement,
  detectImageExtension,
  excelColumnWidthToPixels,
  executeProfileBackupExport,
  formatExportBaseName,
  generateProfileExcelBuffer,
  getNeutralPosterPlaceholderPng,
  inspectXlsxPackageBuffer,
  pixelsToExcelColumnWidth,
  pointsToPixels,
  readImageDimensions,
  resolveUniqueExportFileName,
  sanitizeSpreadsheetText,
} from '../src/server/excel-profile-backup.ts';
import { PersistentDataStore } from '../src/server/persistent-store.ts';
import { createCineTrackApp, resolveExportDocument } from '../src/server/app.ts';
import {
  downloadVerifiedBackupBinary,
  validateDownloadedXlsxBytes,
} from '../src/services/api.ts';

function createTempDir(prefix = 'cinetrack-excel-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Valid JPEG binary fixture with real JFIF APP0 + COM seed + SOF0 frame header (default TMDB w154 = 154x231 px)
 */
function makeFakeJpegBuffer(seedByte = 0x42, width = 154, height = 231) {
  return Buffer.from([
    // SOI
    0xff, 0xd8,
    // APP0 (JFIF, 16 bytes)
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    // COM (4 bytes carrying unique seedByte)
    0xff, 0xfe, 0x00, 0x04, seedByte & 0xff, 0x43,
    // SOF0 (Baseline DCT, 11 bytes carrying big-endian height & width)
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    // EOI
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

    // Bounded title column width (~33 chars) and poster column width (~10.79 chars -> exact 76 px = 72 px poster + 4 px margin)
    assert.ok(ws.getColumn(1).width >= 10 && ws.getColumn(1).width <= 11.5);
    assert.equal(excelColumnWidthToPixels(ws.getColumn(1).width), POSTER_CELL_WIDTH_PX);
    assert.equal(ws.getColumn(3).width, 33);

    // Every data row has height 84 pt (112 px) and an embedded 72x108 px oneCellAnchor image in col 0
    const rowCount = countActualDataRows(ws);
    for (let r = 5; r < 5 + rowCount; r += 1) {
      assert.equal(ws.getRow(r).height, POSTER_ROW_HEIGHT_PT);
    }
    const images = ws.getImages();
    assert.equal(images.length, rowCount);
    images.forEach((img, idx) => {
      assert.equal(img.range.editAs, 'oneCell');
      assert.equal(img.range.tl.nativeCol, 0);
      assert.equal(img.range.tl.nativeRow, 4 + idx);
      assert.equal(img.range.tl.nativeColOff, 2 * EMU_PER_PIXEL);
      assert.equal(img.range.tl.nativeRowOff, 2 * EMU_PER_PIXEL);
      assert.equal(img.range.ext.width, POSTER_TARGET_WIDTH_PX);
      assert.equal(img.range.ext.height, POSTER_TARGET_HEIGHT_PX);
    });
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

  // Unknown /api/* path must return JSON 404 (never fall through to SPA index.html)
  const unknownApiRes = await fetch(`${baseUrl}/api/backup/exports/nonexistent_route/extra`);
  assert.equal(unknownApiRes.status, 404);
  assert.match(unknownApiRes.headers.get('content-type') || '', /application\/json/);
});

test('15. ZIP/OpenXML package inspection, 10 KB HTML/JSON download rejection, binary stream fallback, favoriteActors preservation, and catalog genre hydration', async (t) => {
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const seedDoc = {
    version: 3,
    schemaVersion: 3,
    revision: 7,
    updatedAt: '2026-10-28T17:00:00.000Z',
    activeProfileId: 'profile-default',
    profiles: [
      {
        id: 'profile-default',
        name: 'ibrahim',
        createdAt: '2026-01-01T00:00:00.000Z',
        preferences: {
          disliked: ['movie:888'],
          providers: ['8'],
          mood: '',
          reminders: false,
          notified: [],
        },
        favoriteActors: [
          { id: 1, name: 'Haluk Bilginer', profile_path: '/hb.jpg' },
          { id: 2, name: 'Cansu Dere', profile_path: '/cd.jpg' },
        ],
        items: [
          {
            id: 550,
            media_type: 'movie',
            title: 'Dövüş Kulübü',
            release_date: '1999-10-15',
            vote_average: 8.4,
            personal_rating: 9,
            genre_ids: [18, 53],
            poster_path: '/m550.jpg',
            status: 'completed',
            addedAt: '2026-10-01T12:00:00.000Z',
          },
          {
            id: 550,
            media_type: 'tv',
            title: 'Aynı Numaralı Dizi',
            first_air_date: '2020-05-10',
            vote_average: 7.9,
            personal_rating: '',
            genre_ids: [80, 18],
            poster_path: '/tv550.jpg',
            status: 'watchlist',
            addedAt: '2026-10-02T12:00:00.000Z',
          },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(tmpDir, 'cinetrack-data.json'), JSON.stringify(seedDoc, null, 2));

  // Verify PersistentDataStore extracts genre_ids from TMDB detail `genres: [{ id, name }]`
  const store = new PersistentDataStore({ dataDir: tmpDir });
  store.upsertCatalogItems([
    {
      id: 888,
      media_type: 'movie',
      title: 'Detaydan Gelen Film',
      release_date: '2023-04-12',
      vote_average: 5.4,
      poster_path: '/m888.jpg',
      genres: [
        { id: 27, name: 'Korku' },
        { id: 53, name: 'Gerilim' },
      ],
    },
  ]);
  const storedMovie888 = store.readCatalog('movie')['movie:888'];
  assert.deepEqual(storedMovie888.genre_ids, [27, 53]);

  // Verify non-destructive snapshot merge preserves favoriteActors when client sends []
  const mergedDoc = resolveExportDocument(seedDoc, {
    profileSnapshot: {
      id: 'profile-default',
      name: 'ibrahim',
      preferences: seedDoc.profiles[0].preferences,
      items: seedDoc.profiles[0].items,
      favoriteActors: [], // Partial client snapshot missing favoriteActors!
    },
  });
  assert.equal(mergedDoc.profiles[0].favoriteActors.length, 2);

  // Verify transient empty unknown profile snapshot does NOT wipe persistent server profile
  const guardedDoc = resolveExportDocument(seedDoc, {
    profileSnapshot: {
      id: 'profile-unhydrated-empty',
      name: 'Profilim',
      preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
      items: [],
      favoriteActors: [],
    },
  });
  assert.equal(guardedDoc.activeProfileId, 'profile-default');
  assert.equal(guardedDoc.profiles[0].items.length, 2);

  // Build workbook and inspect raw ZIP Central Directory + OpenXML internals
  const built = await generateProfileExcelBuffer({
    profile: mergedDoc.profiles[0],
    moviesCatalog: store.readCatalog('movie'),
    tvCatalog: store.readCatalog('tv'),
    posterCacheDir: path.join(tmpDir, 'posters'),
    posterFetcher: async () => ({
      status: 200,
      contentType: 'image/jpeg',
      buffer: makeFakeJpegBuffer(0x77),
    }),
  });

  const zipInspection = inspectXlsxPackageBuffer(built.buffer);
  assert.equal(zipInspection.validZip, true);
  assert.equal(zipInspection.validOpenXmlStructure, true);
  assert.deepEqual(zipInspection.sheetNames, [
    'Özet',
    'İzlenen',
    'İzlenecek',
    'İzleniyor',
    'İlgilenmiyorum',
  ]);
  assert.equal(zipInspection.worksheetDataRowCounts.İzlenen, 1);
  assert.equal(zipInspection.worksheetDataRowCounts.İzlenecek, 1);
  assert.equal(zipInspection.worksheetDataRowCounts.İzleniyor, 0);
  assert.equal(zipInspection.worksheetDataRowCounts.İlgilenmiyorum, 1);
  assert.equal(zipInspection.mediaFilesCount, 3);
  assert.equal(zipInspection.totalOneCellAnchors, 3);
  assert.equal(zipInspection.totalTwoCellAnchors, 0);
  assert.equal(zipInspection.totalImageAnchors, 3);
  assert.equal(zipInspection.posterColumnRenderedWidthPx, POSTER_CELL_WIDTH_PX);
  assert.equal(zipInspection.dataRowHeightPt, POSTER_ROW_HEIGHT_PT);
  assert.equal(zipInspection.dataRowRenderedHeightPx, POSTER_CELL_HEIGHT_PX);
  assert.equal(zipInspection.minRenderedWidthPx, POSTER_TARGET_WIDTH_PX);
  assert.equal(zipInspection.maxRenderedWidthPx, POSTER_TARGET_WIDTH_PX);
  assert.equal(zipInspection.minRenderedHeightPx, POSTER_TARGET_HEIGHT_PX);
  assert.equal(zipInspection.maxRenderedHeightPx, POSTER_TARGET_HEIGHT_PX);
  assert.equal(zipInspection.allAnchorsInPosterColumn, true);
  assert.equal(zipInspection.allAnchorsRowAligned, true);
  assert.equal(zipInspection.anyThinStripAnchor, false);
  assert.equal(zipInspection.totalBlipEmbeds, 3);
  assert.equal(zipInspection.totalDrawingRelationships, 3);

  // Disliked movie:888 must have hydrated genres ('Korku, Gerilim') and Özet!F6 must show 2 favorite actors!
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(built.buffer);
  assert.equal(wb.getWorksheet('Özet').getCell('F6').value, 2);
  assert.equal(wb.getWorksheet('İlgilenmiyorum').getRow(5).getCell(7).value, 'Korku, Gerilim');

  // Verify 10 KB HTML response (Service Worker index.html / auth gate) is strictly rejected!
  const fake10KbHtml = Buffer.from(
    '<!DOCTYPE html><html lang="tr"><head><title>CineTrack</title></head><body>' +
      'x'.repeat(10_000) +
      '</body></html>',
    'utf8'
  );
  assert.equal(inspectXlsxPackageBuffer(fake10KbHtml).validZip, false);
  const htmlValidation = validateDownloadedXlsxBytes(fake10KbHtml, {
    contentType: 'text/html; charset=utf-8',
  });
  assert.equal(htmlValidation.ok, false);

  // Even if Content-Type was mislabeled as spreadsheet, HTML body without PK\x03\x04 must be rejected!
  const disguisedHtmlValidation = validateDownloadedXlsxBytes(fake10KbHtml, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  assert.equal(disguisedHtmlValidation.ok, false);
  assert.match(disguisedHtmlValidation.reason || '', /HTML/i);

  // End-to-end verified client download + stream fallback when GET returns HTML/404
  const { app } = createCineTrackApp({ dataDir: tmpDir });
  // Seed cached posters into tmpDir/cache/posters so stream endpoint needs zero external internet calls
  const exportReport = await executeProfileBackupExport({
    dataDir: tmpDir,
    document: mergedDoc,
    includeJson: false,
    includeXlsx: true,
    posterFetcher: async () => ({
      status: 200,
      contentType: 'image/jpeg',
      buffer: makeFakeJpegBuffer(0x77),
    }),
  });
  assert.equal(exportReport.excelBackup.ok, true);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  // Case 1: Normal verified binary download matches exact byte length and SHA-256
  const verifiedDirect = await downloadVerifiedBackupBinary({
    downloadUrl: `${baseUrl}${exportReport.excelBackup.downloadUrl}`,
    fileName: exportReport.excelBackup.fileName,
    kind: 'xlsx',
    expectedSizeBytes: exportReport.excelBackup.sizeBytes,
    expectedSha256: exportReport.excelBackup.sha256,
  });
  assert.equal(verifiedDirect.usedStreamFallback, false);
  assert.equal(verifiedDirect.sizeBytes, exportReport.excelBackup.sizeBytes);
  assert.equal(verifiedDirect.sha256, exportReport.excelBackup.sha256);

  // Case 2: Simulated Service Worker / replica 404 or HTML fallback on GET automatically recovers via POST /api/backup/profile-export/stream!
  const verifiedFallback = await downloadVerifiedBackupBinary({
    downloadUrl: `${baseUrl}/api/backup/exports/CineTrack_Profile_2099-01-01_0000.xlsx`,
    fileName: 'CineTrack_Profile_2099-01-01_0000.xlsx',
    kind: 'xlsx',
    fallbackStreamPayload: {
      profileId: 'profile-default',
      profileSnapshot: mergedDoc.profiles[0],
    },
    customFetch: (input, init) => {
      const target = typeof input === 'string' && input.startsWith('/') ? `${baseUrl}${input}` : input;
      return fetch(target, {
        ...init,
        headers: {
          ...(init?.headers || {}),
          Origin: baseUrl,
        },
      });
    },
  });
  assert.equal(verifiedFallback.usedStreamFallback, true);
  const fallbackBytes = Buffer.from(await verifiedFallback.blob.arrayBuffer());
  const fallbackZip = inspectXlsxPackageBuffer(fallbackBytes);
  assert.equal(fallbackZip.validZip, true);
  assert.equal(fallbackZip.validOpenXmlStructure, true);
  assert.equal(fallbackZip.worksheetDataRowCounts.İzlenen, 1);
  assert.equal(fallbackZip.worksheetDataRowCounts.İzlenecek, 1);

  // Ensure vite.config.ts explicitly excludes /api/ routes from Workbox NavigationRoute SPA fallback
  const viteConfigText = fs.readFileSync(path.resolve('vite.config.ts'), 'utf8');
  assert.match(viteConfigText, /navigateFallbackDenylist:\s*\[\s*\/\^\\\/api\\\/\/\s*\]/);
});

test('16. Excel poster unit conversions, aspect-ratio preservation without stretching, thin-strip prevention, and corrupt sliver source rejection', async (t) => {
  const tmpDir = createTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // 16a: ECMA-376 OpenXML column-width <-> pixel conversions and point <-> pixel conversions
  for (const targetPx of [64, 72, 76, 120]) {
    const colChars = pixelsToExcelColumnWidth(targetPx);
    assert.equal(excelColumnWidthToPixels(colChars), targetPx);
  }
  assert.equal(pointsToPixels(81), 108);
  assert.equal(pointsToPixels(84), 112);

  // 16b: Binary dimension parser for JPEG & PNG
  assert.deepEqual(readImageDimensions(makeFakeJpegBuffer(0x10, 154, 231)), {
    width: 154,
    height: 231,
    format: 'jpeg',
  });
  assert.deepEqual(readImageDimensions(getNeutralPosterPlaceholderPng()), {
    width: 144,
    height: 216,
    format: 'png',
  });

  // 16c: Proportional placement preserves exact source aspect ratio inside 72x108 target box
  const standard2x3 = computePosterPlacement(154, 231);
  assert.equal(standard2x3.widthPx, 72);
  assert.equal(standard2x3.heightPx, 108);
  assert.equal(standard2x3.cxEmu, 72 * EMU_PER_PIXEL); // 685,800 EMU
  assert.equal(standard2x3.cyEmu, 108 * EMU_PER_PIXEL); // 1,028,700 EMU
  assert.equal(standard2x3.leftOffsetPx, 2);
  assert.equal(standard2x3.topOffsetPx, 2);

  const square1x1 = computePosterPlacement(300, 300);
  assert.equal(square1x1.widthPx, 72);
  assert.equal(square1x1.heightPx, 72);
  assert.equal(square1x1.leftOffsetPx, 2);
  assert.equal(square1x1.topOffsetPx, 20); // Centered vertically in 112 px row height

  const tall1x2 = computePosterPlacement(120, 240);
  assert.equal(tall1x2.widthPx, 54);
  assert.equal(tall1x2.heightPx, 108);
  assert.equal(tall1x2.leftOffsetPx, 11); // Centered horizontally in 76 px column width
  assert.equal(tall1x2.topOffsetPx, 2);

  // 16d: End-to-end workbook with standard 2:3, square 1:1, tall 1:2, and a corrupt 4x120 px sliver
  const profile = {
    id: 'profile-aspect',
    name: 'Poster Oran ve Boyut Testi',
    createdAt: '2026-10-29T00:00:00.000Z',
    preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
    favoriteActors: [],
    items: [
      {
        id: 101,
        media_type: 'movie',
        title: 'Standart 2:3 Posterli Film',
        poster_path: '/p-2x3.jpg',
        status: 'completed',
        addedAt: '2026-10-29T10:04:00.000Z',
      },
      {
        id: 102,
        media_type: 'tv',
        title: 'Kare 1:1 Posterli Dizi',
        poster_path: '/p-square.jpg',
        status: 'completed',
        addedAt: '2026-10-29T10:03:00.000Z',
      },
      {
        id: 103,
        media_type: 'movie',
        title: 'Dar Uzun 1:2 Posterli Film',
        poster_path: '/p-tall.jpg',
        status: 'completed',
        addedAt: '2026-10-29T10:02:00.000Z',
      },
      {
        id: 104,
        media_type: 'movie',
        title: 'Bozuk 4px Şerit Görselli Film',
        poster_path: '/p-corrupt-sliver.jpg',
        status: 'completed',
        addedAt: '2026-10-29T10:01:00.000Z',
      },
    ],
  };

  const built = await generateProfileExcelBuffer({
    profile,
    posterCacheDir: path.join(tmpDir, 'posters'),
    posterFetcher: async (url) => {
      if (url.endsWith('/p-2x3.jpg')) {
        return { status: 200, contentType: 'image/jpeg', buffer: makeFakeJpegBuffer(1, 154, 231) };
      }
      if (url.endsWith('/p-square.jpg')) {
        return { status: 200, contentType: 'image/jpeg', buffer: makeFakeJpegBuffer(2, 300, 300) };
      }
      if (url.endsWith('/p-tall.jpg')) {
        return { status: 200, contentType: 'image/jpeg', buffer: makeFakeJpegBuffer(3, 120, 240) };
      }
      // Corrupt 4x120 px vertical sliver from upstream must be rejected, NOT embedded or cached!
      return { status: 200, contentType: 'image/jpeg', buffer: makeFakeJpegBuffer(4, 4, 120) };
    },
  });

  assert.equal(built.embeddedPostersCount, 3);
  assert.equal(built.posterErrorsCount, 1);
  assert.equal(built.placeholderPostersCount, 1);
  assert.match(built.posterErrors[0].reason, /4x120/);

  // Corrupt 4x120 sliver must NOT have been persisted into poster disk cache
  const cachedFiles = fs.readdirSync(path.join(tmpDir, 'posters'));
  assert.equal(cachedFiles.length, 3);

  const inspection = built.packageInspection;
  assert.equal(inspection.totalOneCellAnchors, 4);
  assert.equal(inspection.totalTwoCellAnchors, 0);
  assert.equal(inspection.anyThinStripAnchor, false);
  assert.equal(inspection.allAnchorsInPosterColumn, true);
  assert.equal(inspection.allAnchorsRowAligned, true);
  assert.equal(inspection.minRenderedWidthPx, 54);
  assert.equal(inspection.maxRenderedWidthPx, 72);
  assert.equal(inspection.minRenderedHeightPx, 72);
  assert.equal(inspection.maxRenderedHeightPx, 108);

  // Verify reloaded workbook preserves exact per-row aspect ratios without distortion
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(built.buffer);
  const izlenenImages = wb.getWorksheet('İzlenen').getImages();
  assert.equal(izlenenImages.length, 4);
  assert.deepEqual(izlenenImages.map((im) => im.range.ext), [
    { width: 72, height: 108 }, // 154x231 (2:3) -> 72x108
    { width: 72, height: 72 },  // 300x300 (1:1) -> 72x72
    { width: 54, height: 108 }, // 120x240 (1:2) -> 54x108
    { width: 72, height: 108 }, // 144x216 placeholder (2:3) -> 72x108
  ]);
});


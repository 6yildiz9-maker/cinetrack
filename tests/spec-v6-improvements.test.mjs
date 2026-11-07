import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import ExcelJS from 'exceljs';

import { personEvidenceConfidence } from '../src/core/relationship-explorer.ts';
import {
  AUTO_BACKUP_CHANGE_THRESHOLD,
  AUTO_BACKUP_INTERVAL_MS,
  recordProfileChangeAndMaybeBackup,
  checkWeeklyAutoBackup,
  recordManualBackupSuccess,
  formatLastBackupLabel,
  getAutoBackupMeta,
  resetAutoBackupForTests,
} from '../src/services/auto-backup-service.ts';
import {
  computeAvailableWrappedYears,
  buildYearlyWrappedSummary,
} from '../src/core/wrapped-summary.ts';
import {
  deriveTvProgressSummary,
  advanceTvEpisodeProgress,
} from '../src/core/tv-progress.ts';
import {
  mergePersonFilmography,
  computePersonTasteCompatibility,
} from '../src/core/person-insights.ts';
import {
  detectDuplicateSavedItems,
  mergeDuplicateSavedPair,
  areDistinctSeriesParts,
} from '../src/core/duplicate-detector.ts';
import {
  runIdleEnrichmentBatch,
  getIdleEnrichmentQuotaState,
  resetIdleEnrichmentForTests,
  DAILY_IDLE_ENRICHMENT_QUOTA,
} from '../src/services/idle-enrichment-service.ts';
import { computeStockHealthMetrics } from '../src/services/stock-health-service.ts';
import {
  setEncodingTmdbFetcherForTests,
  resetEncodingServiceForTests,
} from '../src/services/encoding-service.ts';
import {
  resetClientDepotsForTests,
  getAllStoredEncodingsIdb,
  saveUiPrefsIdb,
  loadUiPrefsIdb,
} from '../src/services/client-depots.ts';
import {
  saveStockIdb,
  loadStockIdb,
  resetIdbMemoryStateForTests,
} from '../src/services/storage-idb.ts';
import {
  resetStockEngineForTests,
  getCurrentStock,
} from '../src/services/stock-engine.ts';
import {
  generateProfileExcelBuffer,
  inspectXlsxPackageBuffer,
  EXCEL_SHEET_NAMES,
} from '../src/server/excel-profile-backup.ts';
import { createCineTrackApp } from '../src/server/app.ts';

function createMemoryLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

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

test('Spec v6 (Set I & Set J): Yeni Nesil İyileştirmeler & Doğrulamalar', async (t) => {
  t.beforeEach(() => {
    globalThis.localStorage = createMemoryLocalStorage();
    resetAutoBackupForTests();
    resetIdleEnrichmentForTests();
    resetEncodingServiceForTests();
    resetClientDepotsForTests();
    resetIdbMemoryStateForTests();
    resetStockEngineForTests();
  });

  await t.test('2.1 · Stok UI tercihleri (similarity sıralaması dahil) ct:ui-prefs deposunda kalıcı saklanır', async () => {
    await saveUiPrefsIdb({
      profileId: 'prof-v6',
      selectedType: 'all',
      selectedSort: 'similarity',
      selectedGenre: '',
      hideListedItems: false,
      updatedAt: '2026-10-15T10:00:00.000Z',
    });

    const loaded = await loadUiPrefsIdb('prof-v6');
    assert.ok(loaded);
    assert.equal(loaded.selectedSort, 'similarity');
  });

  await t.test('2.2 · W5 Confidence Kozmetiği: personEvidenceConfidence kapsama oranına göre 45 / 72..94 / 96 döndürür', () => {
    const unknownItem = { id: 1, media_type: 'movie', title: 'Eksik Kadro' };
    const minimalA = {
      id: 2,
      media_type: 'movie',
      title: 'Minimal A',
      cast: [{ id: 10, name: 'Oyuncu 1' }],
    };
    const minimalB = {
      id: 3,
      media_type: 'movie',
      title: 'Minimal B',
      cast: [{ id: 10, name: 'Oyuncu 1' }],
    };

    assert.equal(personEvidenceConfidence(unknownItem, minimalA), 45);
    assert.equal(personEvidenceConfidence(minimalA, minimalB), 72);

    const mediumA = {
      id: 4,
      media_type: 'movie',
      title: 'Orta A',
      cast: Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, name: `Oyuncu ${i}` })),
      crew: [
        { id: 201, name: 'Yönetmen 1', job: 'Director' },
        { id: 202, name: 'Senarist 1', job: 'Writer' },
      ],
    };
    const mediumB = {
      id: 5,
      media_type: 'movie',
      title: 'Orta B',
      cast: Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, name: `Oyuncu ${i}` })),
      crew: [{ id: 201, name: 'Yönetmen 1', job: 'Director' }],
    };

    const midScore = personEvidenceConfidence(mediumA, mediumB);
    assert.ok(
      midScore > 72 && midScore < 94,
      `Kısmi ama zengin kadroda ara güven skoru bekleniyor (73..93), üretilen: ${midScore}`
    );

    const richPartialA = {
      id: 6,
      media_type: 'movie',
      title: 'Zengin Kısmi A',
      cast: Array.from({ length: 10 }, (_, i) => ({ id: 300 + i, name: `Oyuncu ${i}` })),
      crew: Array.from({ length: 4 }, (_, i) => ({ id: 400 + i, name: `Ekip ${i}`, job: 'Director' })),
    };
    const richScore = personEvidenceConfidence(richPartialA, richPartialA);
    assert.equal(richScore, 94);

    const completeA = {
      ...richPartialA,
      metadataCoverage: {
        overview: true,
        genres: true,
        cast: 'complete',
        crew: 'complete',
        collection: 'not-found',
      },
    };
    assert.equal(personEvidenceConfidence(completeA, completeA), 96);
  });

  await t.test('2.3 + IMP-16 · Otomatik Yedek Zamanlaması: 25 değişiklikte ve 7 günde bir otomatik yedek tetikler', async () => {
    let backupCalls = 0;
    const mockExecutor = async () => {
      backupCalls += 1;
      return { ok: true };
    };

    const baseNow = Date.parse('2026-05-01T12:00:00.000Z');

    // İlk 24 değişiklikte yedek tetiklenmez
    for (let i = 1; i < AUTO_BACKUP_CHANGE_THRESHOLD; i += 1) {
      const res = await recordProfileChangeAndMaybeBackup({
        nowMs: baseNow + i * 1000,
        executor: mockExecutor,
      });
      assert.equal(res.triggered, false);
      assert.equal(res.meta.changesSinceLastBackup, i);
    }
    assert.equal(backupCalls, 0);

    // 25. değişiklikte otomatik yedek tetiklenir ve sayaç sıfırlanır
    const on25th = await recordProfileChangeAndMaybeBackup({
      nowMs: baseNow + 25_000,
      executor: mockExecutor,
    });
    assert.equal(on25th.triggered, true);
    assert.equal(on25th.ok, true);
    assert.equal(on25th.reason, 'changes');
    assert.equal(on25th.meta.changesSinceLastBackup, 0);
    assert.equal(backupCalls, 1);

    // 2 gün sonra haftalık yedek henüz tetiklenmez
    const after2Days = await checkWeeklyAutoBackup({
      nowMs: baseNow + 2 * 86_400_000,
      executor: mockExecutor,
    });
    assert.equal(after2Days.triggered, false);
    assert.equal(backupCalls, 1);

    // 8 gün sonra haftalık yedek otomatik tetiklenir
    const after8Days = await checkWeeklyAutoBackup({
      nowMs: baseNow + AUTO_BACKUP_INTERVAL_MS + 86_400_000,
      executor: mockExecutor,
    });
    assert.equal(after8Days.triggered, true);
    assert.equal(after8Days.reason, 'weekly');
    assert.equal(backupCalls, 2);

    // Son yedek etiketi Türkçe ve okunaklı biçimlenir
    const label = formatLastBackupLabel(getAutoBackupMeta(), baseNow + AUTO_BACKUP_INTERVAL_MS + 2 * 86_400_000);
    assert.match(label, /Son yedek: 1 gün önce \(otomatik · haftalık\)/);

    recordManualBackupSuccess(baseNow + AUTO_BACKUP_INTERVAL_MS + 3 * 86_400_000);
    const manualLabel = formatLastBackupLabel(
      getAutoBackupMeta(),
      baseNow + AUTO_BACKUP_INTERVAL_MS + 3 * 86_400_000 + 10_000
    );
    assert.match(manualLabel, /Son yedek: Az önce \(manuel\)/);
  });

  await t.test('IMP-09 · Yıl Künyesi (Wrapped): seçili yılın ilk 3 tür/dönem/oyuncu, aylık yoğunluk ve en sevilen yapımını hesaplar', () => {
    const profile = {
      id: 'prof-wrapped',
      name: 'Sinefil',
      createdAt: '2025-01-01T00:00:00.000Z',
      preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
      favoriteActors: [],
      items: [
        {
          id: 101,
          media_type: 'movie',
          title: 'Dune: Çöl Gezegeni Bölüm İki',
          release_date: '2024-02-28',
          genre_ids: [878, 12],
          status: 'completed',
          personal_rating: 10,
          vote_average: 8.4,
          runtime: 166,
          addedAt: '2026-03-10T18:00:00.000Z',
          cast: [
            { id: 1190668, name: 'Timothée Chalamet' },
            { id: 505710, name: 'Zendaya' },
          ],
        },
        {
          id: 102,
          media_type: 'movie',
          title: 'Blade Runner 2049',
          release_date: '2017-10-04',
          genre_ids: [878, 18],
          status: 'completed',
          personal_rating: 9,
          vote_average: 8.1,
          runtime: 164,
          addedAt: '2026-03-22T20:00:00.000Z',
          cast: [{ id: 30614, name: 'Ryan Gosling' }],
        },
        {
          id: 103,
          media_type: 'tv',
          name: 'Severance',
          first_air_date: '2022-02-17',
          genre_ids: [18, 9648, 878],
          status: 'watching',
          personal_rating: 9,
          vote_average: 8.7,
          episodes_watched: 9,
          addedAt: '2026-10-05T19:00:00.000Z',
          cast: [{ id: 1190668, name: 'Timothée Chalamet' }],
        },
        {
          id: 201,
          media_type: 'movie',
          title: '2025 Arşiv Filmi',
          release_date: '1999-03-31',
          genre_ids: [28],
          status: 'completed',
          personal_rating: 8,
          vote_average: 8.7,
          addedAt: '2025-07-12T10:00:00.000Z',
        },
      ],
    };

    const years = computeAvailableWrappedYears(profile.items, 2026);
    assert.deepEqual(years, [2026, 2025]);

    const summary2026 = buildYearlyWrappedSummary(profile, 2026, {
      878: 'Bilim Kurgu',
      18: 'Dram',
      12: 'Macera',
      9648: 'Gizem',
    });

    assert.equal(summary2026.year, 2026);
    assert.equal(summary2026.totalItems, 3);
    assert.equal(summary2026.completedCount, 2);
    assert.equal(summary2026.movieCount, 2);
    assert.equal(summary2026.tvCount, 1);
    assert.equal(summary2026.topGenres[0].name, 'Bilim Kurgu');
    assert.equal(summary2026.topActors[0].name, 'Timothée Chalamet');
    assert.equal(summary2026.topActors[0].count, 2);
    assert.equal(summary2026.monthlyIntensity.length, 12);
    assert.equal(summary2026.monthlyIntensity[2].count, 2); // Mart = 2 yapım
    assert.match(summary2026.peakMonthLabel || '', /^Mart/);
    assert.ok(summary2026.mostLovedItem);
    assert.equal(summary2026.mostLovedItem.title, 'Dune: Çöl Gezegeni Bölüm İki');
  });

  await t.test('IMP-10 · Sezon/Bölüm İlerleme Takibi: +1 Bölüm sezon geçişini ve dizi tamamlanmasını doğru hesaplar', () => {
    const initialShow = {
      id: 95396,
      media_type: 'tv',
      name: 'Severance',
      status: 'watching',
      personal_rating: 9,
      number_of_seasons: 2,
      number_of_episodes: 4,
      season_episode_counts: { 1: 2, 2: 2 },
      current_season: 1,
      episodes_watched: 1,
      season_progress: { 1: 1 },
      episode_run_time: [50],
    };

    const s0 = deriveTvProgressSummary(initialShow);
    assert.equal(s0.positionLabel, 'S1 · B1');
    assert.equal(s0.progressPercent, 25);

    // +1 -> S1 · B2 (1. sezon sonu)
    const afterEp2 = advanceTvEpisodeProgress(initialShow, '2026-10-01T10:00:00.000Z');
    const s1 = deriveTvProgressSummary(afterEp2);
    assert.equal(s1.positionLabel, 'S1 · B2');
    assert.equal(s1.watchedEpisodesCount, 2);
    assert.equal(afterEp2.status, 'watching');

    // +1 -> otomatik 2. sezona geçer: S2 · B1
    const afterEp3 = advanceTvEpisodeProgress(afterEp2, '2026-10-02T10:00:00.000Z');
    const s2 = deriveTvProgressSummary(afterEp3);
    assert.equal(s2.positionLabel, 'S2 · B1');
    assert.equal(s2.watchedEpisodesCount, 3);
    assert.equal(afterEp3.status, 'watching');

    // +1 -> S2 · B2 (toplam 4/4 bölüm bitti -> status = completed)
    const afterEp4 = advanceTvEpisodeProgress(afterEp3, '2026-10-03T10:00:00.000Z');
    const s3 = deriveTvProgressSummary(afterEp4);
    assert.equal(s3.positionLabel, 'S2 · B2');
    assert.equal(s3.progressPercent, 100);
    assert.equal(afterEp4.status, 'completed');
    assert.equal(afterEp4.totalWatchTimeMinutes, 200);
  });

  await t.test('IMP-11 · Boşta Zenginleştirme: /credits proxy izni açık ve runIdleEnrichmentBatch günlük kotaya uyarak ct:stock + ct:encodings günceller', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-v6-credits-'));
    try {
      await withServer({ dataDir: tmpDir, tmdbApiKey: '' }, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/tmdb?path=/movie/27205/credits`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(Array.isArray(body.cast) && body.cast.length > 0);
        assert.ok(Array.isArray(body.crew) && body.crew.length > 0);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ct:stock içine ham (cast/keywords olmayan) 3 film + 2 dizi koyalım
    await saveStockIdb({
      movies: [
        { id: 501, media_type: 'movie', title: 'Stok Film 1', genre_ids: [878], vote_average: 7.9 },
        { id: 502, media_type: 'movie', title: 'Stok Film 2', genre_ids: [18], vote_average: 7.5 },
        { id: 503, media_type: 'movie', title: 'Stok Film 3', genre_ids: [53], vote_average: 7.2 },
      ],
      tv: [
        { id: 601, media_type: 'tv', name: 'Stok Dizi 1', genre_ids: [10765], vote_average: 8.1 },
        { id: 602, media_type: 'tv', name: 'Stok Dizi 2', genre_ids: [80], vote_average: 8.0 },
      ],
      updatedAt: '2026-10-10T10:00:00.000Z',
    });

    setEncodingTmdbFetcherForTests(async (reqPath) => {
      if (reqPath.endsWith('/credits')) {
        return {
          cast: [{ id: 9001, name: 'Başrol Oyuncu', character: 'Kahraman' }],
          crew: [{ id: 9002, name: 'Usta Yönetmen', job: 'Director' }],
        };
      }
      if (reqPath.endsWith('/keywords')) {
        return { keywords: [{ id: 456, name: 'dystopia' }] };
      }
      return {};
    });

    const fixedNow = Date.parse('2026-10-10T12:00:00.000Z');
    const batch1 = await runIdleEnrichmentBatch({ batchSize: 3, dailyLimit: 4, nowMs: fixedNow });
    assert.equal(batch1.attemptedCount, 3);
    assert.equal(batch1.enrichedCount, 3);
    assert.equal(batch1.quotaState.usedCount, 3);
    assert.equal(batch1.quotaState.remainingCount, 1);

    // Kalan kota 1 olduğu için batchSize=3 istense bile en fazla 1 kayıt işlenir
    const batch2 = await runIdleEnrichmentBatch({ batchSize: 3, dailyLimit: 4, nowMs: fixedNow + 5000 });
    assert.equal(batch2.attemptedCount, 1);
    assert.equal(batch2.enrichedCount, 1);
    assert.equal(batch2.quotaState.remainingCount, 0);

    // Kota dolduğunda yeni istek atılmaz
    const batch3 = await runIdleEnrichmentBatch({ batchSize: 3, dailyLimit: 4, nowMs: fixedNow + 9000 });
    assert.equal(batch3.attemptedCount, 0);

    const updatedStock = await loadStockIdb();
    const enrichedMovie = updatedStock.movies.find((m) => m.id === 501);
    assert.ok(enrichedMovie?.cast?.length === 1);
    assert.equal(enrichedMovie.cast[0].name, 'Başrol Oyuncu');
    assert.deepEqual(enrichedMovie.topCastIds, [9001]);

    const storedEncodings = await getAllStoredEncodingsIdb();
    assert.ok(storedEncodings.length >= 4, 'Zenginleştirilen stok öğeleri ct:encodings deposuna yazılmalı');
    assert.equal(getIdleEnrichmentQuotaState(DAILY_IDLE_ENRICHMENT_QUOTA, fixedNow).dailyLimit, 40);
  });

  await t.test('IMP-12 · Kişi Sayfası Derinleştirme: yönetmen + oyuncu filmografisi, izlenen sayısı, uyum yüzdesi ve Stokta/Haritada Gör bayrakları', () => {
    const credits = {
      cast: [
        {
          id: 27205,
          media_type: 'movie',
          title: 'Inception',
          character: 'Cobb',
          release_date: '2010-07-15',
          genre_ids: [28, 878],
          popularity: 95,
          vote_average: 8.4,
        },
        {
          id: 11324,
          media_type: 'movie',
          title: 'Shutter Island',
          character: 'Teddy Daniels',
          release_date: '2010-02-14',
          genre_ids: [18, 53, 9648],
          popularity: 82,
          vote_average: 8.2,
        },
      ],
      crew: [
        {
          id: 27205,
          media_type: 'movie',
          title: 'Inception',
          job: 'Director',
          department: 'Directing',
          release_date: '2010-07-15',
          genre_ids: [28, 878],
          popularity: 95,
          vote_average: 8.4,
        },
        {
          id: 872585,
          media_type: 'movie',
          title: 'Oppenheimer',
          job: 'Director',
          department: 'Directing',
          release_date: '2023-07-19',
          genre_ids: [18, 36],
          popularity: 91,
          vote_average: 8.1,
        },
      ],
    };

    const savedItems = [
      {
        id: 27205,
        media_type: 'movie',
        title: 'Inception',
        status: 'completed',
        personal_rating: 10,
        genre_ids: [28, 878],
      },
    ];

    const works = mergePersonFilmography(credits, {
      savedItems,
      stockKeys: new Set(['movie:11324']),
      relationshipMapKeys: new Set(['movie:27205', 'movie:872585']),
    });

    assert.equal(works.length, 3, 'Aynı yapım (Inception) hem cast hem crew içinde tekilleştirilmeli');
    const inception = works.find((w) => w.mediaKey === 'movie:27205');
    assert.ok(inception);
    assert.deepEqual(inception.roles, ['Yönetmen', 'Oyuncu']);
    assert.equal(inception.inRelationshipMap, true);

    const shutter = works.find((w) => w.mediaKey === 'movie:11324');
    assert.ok(shutter);
    assert.equal(shutter.inStock, true);

    const insights = computePersonTasteCompatibility(525, works, savedItems);
    assert.equal(insights.watchedCount, 1);
    assert.equal(insights.directorWorksCount, 2);
    assert.equal(insights.actorWorksCount, 2);
    assert.equal(insights.inStockCount, 1);
    assert.equal(insights.inRelationshipMapCount, 2);
    assert.ok(insights.compatibilityPercent >= 70 && insights.compatibilityPercent <= 99);
  });

  await t.test('IMP-13 · Stok Sağlık Paneli: MMR çeşitlilik skoru, vektör/kadro doluluk oranı ve önbellek metriklerini üretir', async () => {
    const metrics = await computeStockHealthMetrics({
      moviesOverride: [
        {
          id: 1,
          media_type: 'movie',
          title: 'Uzay Yolu',
          genre_ids: [878, 12],
          cast: [{ id: 10, name: 'Oyuncu A' }],
        },
        {
          id: 2,
          media_type: 'movie',
          title: 'Tarihi Destan',
          genre_ids: [36, 18],
        },
      ],
      tvOverride: [
        {
          id: 3,
          media_type: 'tv',
          name: 'Komedi Kulübü',
          genre_ids: [35],
          topCastIds: [22],
        },
      ],
    });

    assert.equal(metrics.moviesCount, 2);
    assert.equal(metrics.tvCount, 1);
    assert.equal(metrics.totalStockCount, 3);
    assert.equal(metrics.encodedFillPercent, 100);
    assert.equal(metrics.enrichedCreditsCount, 2);
    assert.equal(metrics.enrichedCreditsPercent, 67);
    assert.ok(metrics.diversityScorePercent > 40 && metrics.diversityScorePercent <= 100);
    assert.equal(metrics.clusterThresholdCompliant, true);
    assert.equal(typeof getCurrentStock, 'function');
  });

  await t.test('IMP-14 · Excel Zevk İmzası + Zevk Kayması: varsayılan 5 sekme korunur, xlsx_only modunda 6. tasteDna sekmesi ve aylık kayma eklenir', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-v6-excel-'));
    try {
      const sampleProfile = {
        id: 'prof-dna',
        name: 'Zevk Analizi Profili',
        createdAt: '2026-01-01T00:00:00.000Z',
        preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
        favoriteActors: [],
        items: [
          {
            id: 1001,
            media_type: 'movie',
            title: 'Karanlık Sırlar',
            overview: 'Karanlık, kasvetli psikolojik gerilim ve cinayet soruşturması.',
            genre_ids: [53, 80, 9648],
            status: 'completed',
            personal_rating: 9,
            vote_average: 8.1,
            release_date: '2022-11-10',
            addedAt: '2026-03-14T20:00:00.000Z',
          },
          {
            id: 1002,
            media_type: 'movie',
            title: 'Güneşli Tatil',
            overview: 'Neşeli aile komedisi ve sıcak yaz macerası.',
            genre_ids: [35, 10751],
            status: 'completed',
            personal_rating: 8,
            vote_average: 7.4,
            release_date: '2023-06-20',
            addedAt: '2026-10-08T19:00:00.000Z',
          },
        ],
      };

      // 1) Varsayılan mod: tam 5 sekme
      const defaultExcel = await generateProfileExcelBuffer({
        profile: sampleProfile,
        posterCacheDir: path.join(tmpDir, 'posters'),
      });
      const defaultInspection = inspectXlsxPackageBuffer(defaultExcel.buffer);
      assert.equal(defaultInspection.validOpenXmlStructure, true);
      assert.deepEqual(defaultInspection.sheetNames, [...EXCEL_SHEET_NAMES]);

      // 2) xlsx_only modu (includeTasteDnaSheet: true): 6. sekme 'tasteDna' eklenir
      const dnaExcel = await generateProfileExcelBuffer({
        profile: sampleProfile,
        posterCacheDir: path.join(tmpDir, 'posters'),
        includeTasteDnaSheet: true,
      });
      const dnaInspection = inspectXlsxPackageBuffer(dnaExcel.buffer);
      assert.equal(dnaInspection.validOpenXmlStructure, true);
      assert.deepEqual(dnaInspection.sheetNames, [...EXCEL_SHEET_NAMES, 'tasteDna']);

      // ExcelJS ile geri okuyup 'tasteDna' sekmesinde Mart 2026 -> Ekim 2026 zevk kaymasını doğrula
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(dnaExcel.buffer);
      const tasteWs = wb.getWorksheet('tasteDna');
      assert.ok(tasteWs, 'tasteDna çalışma sayfası mevcut olmalı');

      const allCellTexts = [];
      tasteWs.eachRow((row) => {
        row.eachCell((cell) => {
          if (cell.value != null) {
            allCellTexts.push(String(cell.value));
          }
        });
      });
      const joinedText = allCellTexts.join(' | ');
      assert.match(joinedText, /Mart 2026:/);
      assert.match(joinedText, /→ Ekim 2026:/);

      // HTTP endpoint üzerinden exportMode: 'xlsx_only' doğrulaması
      await withServer({ dataDir: tmpDir, tmdbApiKey: '' }, async (baseUrl) => {
        const resp = await fetch(`${baseUrl}/api/backup/profile-export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profileId: sampleProfile.id,
            profileSnapshot: sampleProfile,
            includeJson: false,
            includeXlsx: true,
            exportMode: 'xlsx_only',
          }),
        });
        assert.equal(resp.status, 200);
        const report = await resp.json();
        assert.equal(report.excelBackup.ok, true);
        const dl = await fetch(`${baseUrl}${report.excelBackup.downloadUrl}`);
        assert.equal(dl.status, 200);
        const arrBuf = Buffer.from(await dl.arrayBuffer());
        const httpInspection = inspectXlsxPackageBuffer(arrBuf);
        assert.deepEqual(httpInspection.sheetNames, [...EXCEL_SHEET_NAMES, 'tasteDna']);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('IMP-15 · Çift Kayıt Temizliği: normalize başlık + encoding kosinüs benzerliği ile kopyaları bulur ve kayıpsız birleştirir', () => {
    const items = [
      {
        id: 27205,
        media_type: 'movie',
        title: 'Başlangıç',
        original_title: 'Inception',
        release_date: '2010-07-15',
        genre_ids: [28, 878, 12],
        status: 'watchlist',
        personal_rating: '',
        addedAt: '2026-02-01T10:00:00.000Z',
        note: 'IMAX versiyonu izlenecek',
      },
      {
        id: 'custom-991',
        media_type: 'movie',
        title: 'The Inception (Director Cut)',
        release_date: '2010-07-16',
        genre_ids: [28, 878],
        status: 'completed',
        personal_rating: 9,
        addedAt: '2026-01-10T10:00:00.000Z',
        note: 'Harika kurgu',
      },
      {
        id: 157336,
        media_type: 'movie',
        title: 'Yıldızlararası',
        original_title: 'Interstellar',
        release_date: '2014-11-05',
        genre_ids: [12, 18, 878],
        status: 'completed',
        personal_rating: 10,
      },
    ];

    const duplicates = detectDuplicateSavedItems(items);
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0].mediaType, 'movie');

    // TMDB kaydını (27205) koruyup custom-991 kaydını onun içine birleştirelim
    const mergeResult = mergeDuplicateSavedPair(items, 27205, 'custom-991', 'movie');
    assert.equal(mergeResult.mergedItems.length, 2);
    assert.equal(mergeResult.removedKey, 'movie:custom-991');
    assert.ok(mergeResult.mergedItem);
    assert.equal(mergeResult.mergedItem.id, 27205);
    assert.equal(mergeResult.mergedItem.status, 'completed');
    assert.equal(mergeResult.mergedItem.personal_rating, 9);
    assert.equal(mergeResult.mergedItem.addedAt, '2026-01-10T10:00:00.000Z');
    assert.match(mergeResult.mergedItem.note || '', /IMAX versiyonu izlenecek \| Harika kurgu/);
  });

  await t.test('IMP-15b · Seri Parçası Koruması: numaralı/alt başlıklı seri filmleri aynı yapım saymaz', () => {
    // Aynı serinin farklı filmleri çift kayıt DEĞİLDİR
    assert.equal(areDistinctSeriesParts('Amerikan Pastası: Düğün', 'Amerikan Pastası 2'), true);
    assert.equal(areDistinctSeriesParts('Amerikan Pastası: Düğün', 'Amerikan Pastası: Buluşma'), true);
    assert.equal(areDistinctSeriesParts('Yüzüklerin Efendisi: İki Kule', 'Yüzüklerin Efendisi 2'), true);
    assert.equal(areDistinctSeriesParts('Görevimiz Tehlike II', 'Görevimiz Tehlike III'), true);
    assert.equal(areDistinctSeriesParts('Dune: Çöl Gezegeni Bölüm İki', 'Dune: Çöl Gezegeni Bölüm Üç'), true);
    assert.equal(areDistinctSeriesParts('Testere 3', 'Testere 3D'), true);
    // Aynı yapımın farklı yazımları çift kayıttır (koruma devreye GİRMEMELİ)
    assert.equal(areDistinctSeriesParts('Görevimiz Tehlike 2', 'Görevimiz Tehlike II'), false);
    assert.equal(areDistinctSeriesParts('Amerikan Pastası: Düğün', 'Amerikan Pastası: Düğün'), false);
    assert.equal(areDistinctSeriesParts('Batman: Başlıyor', 'Batman Başlıyor'), false);

    // Metadata'sız (CSV kaynaklı) seri filmleri benzerlik skoruyla yanlış eşleştirmemeli
    const csvLike = [
      {
        id: 8273,
        media_type: 'movie',
        title: 'Amerikan Pastası: Düğün',
        release_date: '2003-01-01',
        genre_ids: [],
        status: 'completed',
      },
      {
        id: 2770,
        media_type: 'movie',
        title: 'Amerikan Pastası 2',
        release_date: '2001-01-01',
        genre_ids: [],
        status: 'completed',
      },
      {
        id: 2105,
        media_type: 'movie',
        title: 'Amerikan Pastası',
        release_date: '1999-01-01',
        genre_ids: [],
        status: 'completed',
      },
    ];
    assert.equal(detectDuplicateSavedItems(csvLike).length, 0);

    // Birebir aynı başlık metadata'sız kayıtlarda bile çift kayıt sayılır
    const identicalPoor = [
      { id: 1, media_type: 'movie', title: 'Inception', release_date: '2010-01-01', genre_ids: [], status: 'completed' },
      { id: 2, media_type: 'movie', title: 'Inception', release_date: '2010-01-01', genre_ids: [], status: 'completed' },
    ];
    assert.equal(detectDuplicateSavedItems(identicalPoor).length, 1);
  });

  await t.test('IMP-15c · Yıl engellemesi sonuçları değiştirmez: ±2 sınırı, yılı belirsiz kayıt, tür ayrımı', () => {
    const items = [
      // Yılları 2 apart, başlıkları birebir aynı → çift kayıt
      { id: 101, media_type: 'movie', title: 'Başlangıç', release_date: '2010-07-15', genre_ids: [28], status: 'completed' },
      { id: 102, media_type: 'movie', title: 'Başlangıç', release_date: '2010-07-17', genre_ids: [28], status: 'watchlist' },
      // Tam aynı başlık ama 3 yıl fark → eski davranışta da elenir
      { id: 103, media_type: 'movie', title: 'Başlangıç', release_date: '2013-07-16', genre_ids: [28], status: 'completed' },
      // Yılı hiç yok: hangi yılla kıyaslanacağı bellisiz, o yüzden dated kayıtlarla görüşür
      { id: 'custom-104', media_type: 'movie', title: 'Yıldızlararası', original_title: 'Interstellar', genre_ids: [12], status: 'completed' },
      { id: 105, media_type: 'movie', title: 'Interstellar', release_date: '2014-11-05', genre_ids: [12], status: 'completed' },
      // Aynı başlık + aynı yıl ama farklı medya türü → çift değil
      { id: 106, media_type: 'tv', title: 'Başlangıç', release_date: '2010-07-16', genre_ids: [28], status: 'completed' },
    ];

    const duplicates = detectDuplicateSavedItems(items);
    const keys = duplicates.map((p) => `${p.mediaType}:${p.primaryItem.id}__${p.secondaryItem.id}`).sort();
    assert.deepEqual(keys, ['movie:101__102', 'movie:105__custom-104']);
    // Yılı belirsiz iki kayıt birbirleriyle yalnızca bir kez görüşür (aynı çift iki kere raporlanmaz)
    const twoUnknown = [
      { id: 'custom-1', media_type: 'movie', title: 'Üçüncü Adam', genre_ids: [18], status: 'completed' },
      { id: 'custom-2', media_type: 'movie', title: 'Üçüncü Adam', genre_ids: [18], status: 'completed' },
    ];
    assert.equal(detectDuplicateSavedItems(twoUnknown).length, 1);
  });

  await t.test('2.5 · BUG-11 Modülerleştirme: tüm yeni ve bölünen v6 modülleri 1.000 satır tavanının altındadır', () => {
    const v6Modules = [
      'src/services/auto-backup-service.ts',
      'src/services/idle-enrichment-service.ts',
      'src/services/stock-health-service.ts',
      'src/core/wrapped-summary.ts',
      'src/core/tv-progress.ts',
      'src/core/person-insights.ts',
      'src/core/duplicate-detector.ts',
      'src/core/relationship-explorer.ts',
      'src/server/excel-taste-dna-sheet.ts',
      'src/components/WrappedCard.tsx',
      'src/components/StockHealthPanel.tsx',
      'src/components/DuplicateMergePanel.tsx',
      'src/components/ProfileStatsTab.tsx',
      'src/components/ProfileGitHubSyncSection.tsx',
      'src/components/ProfileModal.tsx',
      'src/components/RelationshipExplorer.tsx',
      'src/components/PersonDrawer.tsx',
      'src/components/SeasonCalendarSection.tsx',
      'src/components/Controls.tsx',
      'src/components/Stats.tsx',
    ];

    for (const relPath of v6Modules) {
      const fullPath = path.resolve(process.cwd(), relPath);
      const lineCount = fs.readFileSync(fullPath, 'utf8').split('\n').length;
      assert.ok(
        lineCount < 1000,
        `${relPath} modülü 1.000 satır sınırının altında olmalı (mevcut: ${lineCount})`
      );
    }
  });
});

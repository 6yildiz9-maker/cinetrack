import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import {
  makeMediaKey,
  parseMediaKey,
  canonicalizeMediaKey,
  canonicalizeMediaKeyList,
  migratePersistentTasteMapData,
} from '../src/core/keys.ts';
import {
  HIDE_LISTED_CATEGORIES,
  RECOMMENDATION_WEIGHTS_V3,
  buildTasteProfileSummary,
  buildTasteProfileV3,
  computeTasteProfileSignature,
  createDefaultTasteMapData,
  filterHiddenUserRegisteredItems,
  filterOutLastRecommendedCandidates,
  isMediaRegisteredInUserProfile,
  isTasteMapCacheValid,
  loadPersistentTasteMap,
  recordDisplayedRecommendations,
  recordTasteMapPoolScores,
  savePersistentTasteMap,
  scoreCandidatesV3,
  selectBalancedRecommendations,
  updateTasteMapWithBatch,
  normalizeDataDocument,
} from '../src/core/cinetrack-core.ts';
import {
  RELATIONSHIP_MODEL_VERSION,
  buildRelationshipGraph,
  getRelationshipTypeLabel,
} from '../src/core/relationship-explorer.ts';
import { evaluateRecommendationEngine } from '../src/core/evaluation.ts';
import {
  buildMediaJourneyTimeline,
  buildTasteDnaProfile,
  computeProfileWatchlistIntersection,
  exportItemsToCsv,
  extractUpcomingReleaseEvents,
  generateIcsCalendar,
  importItemsFromCsv,
} from '../src/core/exporters.ts';
import { createCineTrackApp } from '../src/server/app.ts';
import { validateTmdbResponseShape } from '../src/services/api.ts';
import { formatMatchBadge } from '../src/i18n/index.ts';
import {
  clearOfflineSyncSnapshot,
  enqueueOfflineSyncSnapshot,
  hasPendingOfflineSync,
  loadOfflineSyncSnapshot,
} from '../src/services/offline-queue.ts';

function createMemoryLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

async function withServer(appOptions, fn) {
  const { app } = createCineTrackApp(appOptions);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeSampleProfile(id = 'profile-default', items = []) {
  return {
    id,
    name: 'Test Profili',
    createdAt: '2026-01-01T00:00:00.000Z',
    preferences: {
      disliked: [],
      hidden: [],
      providers: [],
      mood: '',
      reminders: false,
      notified: [],
    },
    items,
    favoriteActors: [{ id: 1190668, name: 'Timothée Chalamet', profile_path: '' }],
  };
}

function makeCandidate(id, mediaType = 'movie', overrides = {}) {
  return {
    id,
    media_type: mediaType,
    title: mediaType === 'movie' ? `Film ${id}` : undefined,
    name: mediaType === 'tv' ? `Dizi ${id}` : undefined,
    overview: `Uzay kolonisi ve yapay zeka gerilimi ${id}.`,
    genre_ids: mediaType === 'movie' ? [878, 18] : [10765, 18],
    vote_average: 7.8,
    vote_count: 850,
    popularity: 45 + (id % 20),
    release_date: mediaType === 'movie' ? '2024-05-10' : undefined,
    first_air_date: mediaType === 'tv' ? '2024-05-10' : undefined,
    poolSources: 2,
    ...overrides,
  };
}

// ============================================================================
// FAZ 2: Zevk Haritası Anahtar Migrasyonu & İdempotans Testleri
// ============================================================================
test('Faz 2: eski movie-123 ve kanonik movie:123 kayıtları veri kaybetmeden birleşir ve idempotenttir', () => {
  assert.deepEqual(parseMediaKey('movie-123'), { type: 'movie', id: '123' });
  assert.deepEqual(parseMediaKey('tv:456'), { type: 'tv', id: '456' });
  assert.equal(parseMediaKey('bozuk-anahtar-xyz'), null);
  assert.equal(canonicalizeMediaKey('movie-777'), 'movie:777');
  assert.deepEqual(
    canonicalizeMediaKeyList(['movie-10', 'movie:10', 'tv-20', 'gecersiz', '']),
    ['movie:10', 'tv:20']
  );

  const rawLegacyMap = {
    profileId: 'p1',
    updatedAt: '2026-02-01T00:00:00.000Z',
    lastRecommendedKeys: ['movie-101', 'tv-202', 'movie:101', 'invalid_key'],
    entries: {
      'movie-101': {
        mediaKey: 'movie-101',
        mediaType: 'movie',
        id: 101,
        title: 'Eski Anahtarlı Film',
        matchScore: 84,
        tasteScore: 84,
        priorityScore: 79,
        rawScore: 84,
        ring: 'ring2',
        initialRing: 'ring0',
        parts: {},
        tags: ['Bilim Kurgu'],
        shownCount: 2,
        skippedCount: 1,
        ringDemotions: 1,
        demotionPenalty: 5,
        firstShownAt: '2026-01-10T10:00:00.000Z',
        lastShownAt: '2026-01-15T10:00:00.000Z',
        lastScoredAt: '2026-01-15T10:00:00.000Z',
        impressionHistory: [
          { shownAt: '2026-01-10T10:00:00.000Z', targetType: 'all', rank: 1 },
          { shownAt: '2026-01-15T10:00:00.000Z', targetType: 'all', rank: 3 },
        ],
        status: 'active',
      },
      'movie:101': {
        mediaKey: 'movie:101',
        mediaType: 'movie',
        id: 101,
        title: 'Eski Anahtarlı Film',
        matchScore: 88,
        tasteScore: 88,
        priorityScore: 83,
        rawScore: 88,
        ring: 'ring1',
        initialRing: 'ring0',
        parts: {},
        tags: ['Yüksek Puan'],
        shownCount: 2,
        skippedCount: 1,
        ringDemotions: 1,
        demotionPenalty: 5,
        firstShownAt: '2026-01-15T10:00:00.000Z',
        lastShownAt: '2026-01-20T10:00:00.000Z',
        lastScoredAt: '2026-01-20T10:00:00.000Z',
        impressionHistory: [
          // 15 Ocak olayı her iki kayıtta da var -> çift sayılmamalı!
          { shownAt: '2026-01-15T10:00:00.000Z', targetType: 'all', rank: 3 },
          { shownAt: '2026-01-20T10:00:00.000Z', targetType: 'all', rank: 2 },
        ],
        status: 'saved',
      },
    },
    archivedEntries: {
      'movie-101': {
        mediaKey: 'movie-101',
        mediaType: 'movie',
        id: 101,
        title: 'Arşivdeki Eski Kopya',
        matchScore: 80,
        tasteScore: 80,
        priorityScore: 80,
        rawScore: 80,
        ring: 'ring2',
        initialRing: 'ring0',
        parts: {},
        tags: [],
        shownCount: 1,
        skippedCount: 0,
        ringDemotions: 0,
        demotionPenalty: 0,
        firstShownAt: '2026-01-05T10:00:00.000Z',
        lastShownAt: '2026-01-05T10:00:00.000Z',
        lastScoredAt: '2026-01-05T10:00:00.000Z',
        impressionHistory: [{ shownAt: '2026-01-05T10:00:00.000Z', targetType: 'all', rank: 5 }],
        status: 'active',
        isArchived: true,
      },
    },
  };

  const firstRun = migratePersistentTasteMapData(rawLegacyMap, 30);
  assert.equal(firstRun.changed, true);
  assert.deepEqual(firstRun.data.lastRecommendedKeys, ['movie:101', 'tv:202']);
  assert.equal(Object.keys(firstRun.data.entries).length, 1);
  assert.equal(Object.keys(firstRun.data.archivedEntries).length, 0);

  const merged = firstRun.data.entries['movie:101'];
  assert.ok(merged);
  assert.equal(merged.status, 'saved');
  // 4 benzersiz gösterim: 5 Ocak (arşivden), 10 Ocak, 15 Ocak (tekilleştirildi), 20 Ocak
  assert.equal(merged.impressionHistory.length, 4);
  assert.equal(merged.shownCount, 4);
  assert.equal(merged.firstShownAt, '2026-01-05T10:00:00.000Z');
  assert.equal(merged.lastShownAt, '2026-01-20T10:00:00.000Z');

  // İkinci kez çalıştırıldığında hiçbir şey değişmemeli (idempotence)
  const secondRun = migratePersistentTasteMapData(firstRun.data, 30);
  assert.equal(secondRun.changed, false);
  assert.deepEqual(secondRun.data, firstRun.data);
});

// ============================================================================
// FAZ 3: Öneri Havuzu, Halka Yaşam Döngüsü (ring0 -> ring1 -> ring2) ve Cache
// ============================================================================
test('Faz 3: ardışık yenilemelerde ring1 tekrar seçilmez, ring0 önceliklidir, yetersiz ring0 durumunda ring2 tamamlar ve selectionRing korunur', () => {
  const savedItems = [
    {
      id: 9001,
      media_type: 'movie',
      title: 'Sevilen Bilim Kurgu',
      genre_ids: [878, 18],
      vote_average: 8.5,
      vote_count: 2000,
      popularity: 80,
      status: 'completed',
      personal_rating: 9,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const preferences = { disliked: ['movie:999'], hidden: [], providers: [], mood: '', reminders: false, notified: [] };
  const profile = buildTasteProfileV3(savedItems, { dislikedKeys: preferences.disliked });
  const sig = computeTasteProfileSignature(savedItems, preferences, [], { targetType: 'movie' });

  // 10 film adayı (hepsi başlangıçta ring0)
  const movies = Array.from({ length: 10 }, (_, idx) => makeCandidate(100 + idx, 'movie'));

  let tasteMap = {
    profileId: 'p-ring',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: {},
    archivedEntries: {},
    lastRecommendedKeys: [],
    lastBatchTimestamp: null,
  };

  // 1. Grup (4 öneri seçelim)
  const scored1 = scoreCandidatesV3(movies, profile, { weights: RECOMMENDATION_WEIGHTS_V3, tasteMap }).sort(
    (a, b) => b.score - a.score
  );
  assert.ok(scored1.every((e) => e.ring === 'ring0'));
  const batch1 = selectBalancedRecommendations({
    targetType: 'movie',
    scoredMovies: scored1,
    scoredTv: [],
    targetTotal: 4,
  });
  assert.equal(batch1.items.length, 4);
  const batch1Keys = batch1.items.map((e) => makeMediaKey(e.candidate));

  tasteMap = updateTasteMapWithBatch({
    tasteMap,
    newRecommendedItems: batch1.items,
    allPoolCandidates: scored1,
    savedItems,
    preferences,
    profileSignature: sig,
    targetType: 'movie',
    explanation: batch1.explanation,
    summary: buildTasteProfileSummary(profile, tasteMap, {}),
  });

  // Cache'te selectionRing === 'ring0' korundu, kalıcı haritada ise gösterilenler ring1 oldu
  assert.ok(tasteMap.cachedBalancedItems.every((e) => e.selectionRing === 'ring0'));
  for (const k of batch1Keys) {
    assert.equal(tasteMap.entries[k].ring, 'ring1');
  }
  // forceRefresh=false iken cache geçerli, forceRefresh=true iken geçersiz olmalı
  assert.equal(
    isTasteMapCacheValid({ tasteMap, currentSig: sig, targetType: 'movie', savedItems, preferences, forceRefresh: false }),
    true
  );
  assert.equal(
    isTasteMapCacheValid({ tasteMap, currentSig: sig, targetType: 'movie', savedItems, preferences, forceRefresh: true }),
    false
  );

  // 2. Yenileme: geriye 6 adet ring0 aday kaldı -> 4'ü de ring0'dan seçilmeli, batch1 (ring1) hiç girmemeli!
  const scored2 = scoreCandidatesV3(movies, profile, { weights: RECOMMENDATION_WEIGHTS_V3, tasteMap }).sort(
    (a, b) => b.score - a.score
  );
  const nonRing1ForBatch2 = scored2.filter((e) => e.ring !== 'ring1');
  const batch2 = selectBalancedRecommendations({
    targetType: 'movie',
    scoredMovies: nonRing1ForBatch2,
    scoredTv: [],
    targetTotal: 4,
  });
  const batch2Keys = batch2.items.map((e) => makeMediaKey(e.candidate));
  assert.equal(batch2Keys.length, 4);
  assert.ok(batch2Keys.every((k) => !batch1Keys.includes(k)), 'Önceki grubun ring1 öğeleri 2. gruba giremez');
  assert.ok(batch2.items.every((e) => e.ring === 'ring0'), 'Yeterli ring0 varken hepsi ring0 seçilmeli');

  tasteMap = updateTasteMapWithBatch({
    tasteMap,
    newRecommendedItems: batch2.items,
    allPoolCandidates: scored2,
    savedItems,
    preferences,
    profileSignature: sig,
    targetType: 'movie',
    explanation: batch2.explanation,
  });

  // Batch1'deki atlanan öğeler şimdi ring2'ye düşmüş ve 5 puan priorityScore cezası almış olmalı (tasteScore sabit!)
  for (const k of batch1Keys) {
    assert.equal(tasteMap.entries[k].ring, 'ring2');
    assert.equal(tasteMap.entries[k].skippedCount, 1);
    assert.equal(tasteMap.entries[k].demotionPenalty, 5);
    assert.equal(tasteMap.entries[k].priorityScore, Math.max(1, tasteMap.entries[k].tasteScore - 5));
    assert.equal(tasteMap.entries[k].matchScore, tasteMap.entries[k].tasteScore);
  }

  // 3. Yenileme: havuzda yalnızca 2 adet taze ring0 kaldı! 4'lü seçim için 2 ring0 + 2 ring2 seçilmeli, batch2 (ring1) girmemeli!
  const scored3 = scoreCandidatesV3(movies, profile, { weights: RECOMMENDATION_WEIGHTS_V3, tasteMap }).sort(
    (a, b) => b.score - a.score
  );
  const ring0AndRing2ForBatch3 = [
    ...scored3.filter((e) => e.ring === 'ring0'),
    ...scored3.filter((e) => e.ring === 'ring2'),
  ];
  const batch3 = selectBalancedRecommendations({
    targetType: 'movie',
    scoredMovies: ring0AndRing2ForBatch3,
    scoredTv: [],
    targetTotal: 4,
  });
  const batch3Keys = batch3.items.map((e) => makeMediaKey(e.candidate));
  assert.equal(batch3Keys.length, 4);
  assert.ok(batch3Keys.every((k) => !batch2Keys.includes(k)), 'Batch 2 (ring1) öğeleri Batch 3 içine giremez');
  assert.equal(batch3.items.filter((e) => e.ring === 'ring0').length, 2);
  assert.equal(batch3.items.filter((e) => e.ring === 'ring2').length, 2);

  tasteMap = updateTasteMapWithBatch({
    tasteMap,
    newRecommendedItems: batch3.items,
    allPoolCandidates: scored3,
    savedItems,
    preferences,
    profileSignature: sig,
    targetType: 'movie',
    explanation: batch3.explanation,
  });

  // Cache'teki selectionRing hem ring0 hem ring2 değerlerini kaybetmeden saklamalı!
  assert.equal(tasteMap.cachedBalancedItems.filter((e) => e.selectionRing === 'ring0').length, 2);
  assert.equal(tasteMap.cachedBalancedItems.filter((e) => e.selectionRing === 'ring2').length, 2);
});

// ============================================================================
// FAZ 4 & FAZ 5: Sunucu Yazma Güvenliği, Revizyon 409, Snapshot & TMDB Proxy
// ============================================================================
test('Faz 4 & 5: HTTP 409 çakışma, ani veri düşüşü koruması, 413 boyut sınırı, 403 Origin, 401 Token, 429 Rate Limit, Snapshot geri yükleme ve Sezon endpointi', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinetrack-phase45-'));
  try {
    await withServer(
      {
        dataDir: tmpDir,
        authToken: 'gizli-test-token',
        maxDataBytes: 15_000,
        rateLimitMaxRequests: 3,
        rateLimitWindowMs: 60_000,
        maxSnapshots: 7,
      },
      async (baseUrl) => {
        // 1. Token olmadan PUT /api/data -> 401
        const unauthRes = await fetch(`${baseUrl}/api/data`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: 3, activeProfileId: 'profile-1', profiles: [makeSampleProfile('profile-1')] }),
        });
        assert.equal(unauthRes.status, 401);

        // 2. Yabancı Origin ile PUT /api/data -> 403
        const crossOriginRes = await fetch(`${baseUrl}/api/data`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CineTrack-Token': 'gizli-test-token',
            Origin: 'https://kotu-site.example',
          },
          body: JSON.stringify({ version: 3, activeProfileId: 'profile-1', profiles: [makeSampleProfile('profile-1')] }),
        });
        assert.equal(crossOriginRes.status, 403);

        // 3. 8 öğeli geçerli ilk kayıt -> 200 ve rev-1
        const eightItems = Array.from({ length: 8 }, (_, idx) => ({
          id: 500 + idx,
          media_type: 'movie',
          title: `Kayıtlı Film ${idx}`,
          vote_average: 7.5,
          vote_count: 100,
          popularity: 20,
          genre_ids: [18],
          status: 'watchlist',
          personal_rating: 8,
        }));
        const validDoc1 = {
          version: 3,
          activeProfileId: 'profile-1',
          profiles: [makeSampleProfile('profile-1', eightItems)],
        };

        const put1 = await fetch(`${baseUrl}/api/data`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CineTrack-Token': 'gizli-test-token',
          },
          body: JSON.stringify(validDoc1),
        });
        assert.equal(put1.status, 200);
        const put1Json = await put1.json();
        assert.equal(put1Json.revision, 1);
        assert.equal(put1.headers.get('etag'), '"rev-1"');

        // İkinci geçerli güncelleme (rev-1 -> rev-2) -> döner snapshot oluşmalı
        const put2 = await fetch(`${baseUrl}/api/data`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CineTrack-Token': 'gizli-test-token',
            'If-Match': '"rev-1"',
          },
          body: JSON.stringify({
            ...validDoc1,
            profiles: [{ ...makeSampleProfile('profile-1', eightItems), name: 'Güncel İsim' }],
          }),
        });
        assert.equal(put2.status, 200);
        const put2Json = await put2.json();
        assert.equal(put2Json.revision, 2);

        // 4. Eski If-Match ("rev-1") ile yazma -> 409 revision_conflict
        const stalePut = await fetch(`${baseUrl}/api/data`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CineTrack-Token': 'gizli-test-token',
            'If-Match': '"rev-1"',
          },
          body: JSON.stringify(validDoc1),
        });
        assert.equal(stalePut.status, 409);
        const staleJson = await stalePut.json();
        assert.equal(staleJson.code, 'revision_conflict');
        assert.equal(staleJson.currentRevision, 2);

        // 5. Ani öğe düşüşü (8 öğeden 1 öğeye onaysız düşüş) -> 409 sudden_item_drop
        const dropDoc = {
          version: 3,
          activeProfileId: 'profile-1',
          profiles: [makeSampleProfile('profile-1', [eightItems[0]])],
        };
        const dropPut = await fetch(`${baseUrl}/api/data`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CineTrack-Token': 'gizli-test-token',
            'If-Match': '"rev-2"',
          },
          body: JSON.stringify(dropDoc),
        });
        assert.equal(dropPut.status, 409);
        const dropJson = await dropPut.json();
        assert.equal(dropJson.code, 'sudden_item_drop');

        // Açık onay başlığı ile aynı silme -> 200 OK (rev-3)
        const confirmedDropPut = await fetch(`${baseUrl}/api/data`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CineTrack-Token': 'gizli-test-token',
            'If-Match': '"rev-2"',
            'X-CineTrack-Confirm-Drop': '1',
          },
          body: JSON.stringify(dropDoc),
        });
        assert.equal(confirmedDropPut.status, 200);

        // 6. Döner snapshot listeleme ve geri yükleme (8 öğeli yedeğe geri dön)
        const backupsRes = await fetch(`${baseUrl}/api/data/backups`, {
          headers: { 'X-CineTrack-Token': 'gizli-test-token' },
        });
        assert.equal(backupsRes.status, 200);
        const { backups } = await backupsRes.json();
        assert.ok(backups.length >= 2);
        const snapshotWith8 = backups.find((b) => b.itemsCount === 8);
        assert.ok(snapshotWith8);

        const restoreRes = await fetch(`${baseUrl}/api/data/restore`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CineTrack-Token': 'gizli-test-token',
          },
          body: JSON.stringify({ backupId: snapshotWith8.id }),
        });
        assert.equal(restoreRes.status, 200);
        const restoredJson = await restoreRes.json();
        assert.equal(restoredJson.items, 8);
        // Favori oyuncular da geri yüklemede korunmalı!
        assert.equal(restoredJson.document.profiles[0].favoriteActors[0].id, 1190668);

        // 7. Boyut limiti aşımı -> 413 Payload Too Large
        const hugeString = 'x'.repeat(20_000);
        const tooLargeRes = await fetch(`${baseUrl}/api/data`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CineTrack-Token': 'gizli-test-token',
          },
          body: JSON.stringify({ junk: hugeString }),
        });
        assert.equal(tooLargeRes.status, 413);

        // 8. TMDB allowlist (/tv/1399/season/1) & 429 rate limit
        const seasonRes = await fetch(`${baseUrl}/api/tmdb?path=${encodeURIComponent('/tv/1399/season/1')}`);
        assert.equal(seasonRes.status, 200);
        const seasonJson = await seasonRes.json();
        assert.ok(Array.isArray(seasonJson.episodes));

        const badPathRes = await fetch(`${baseUrl}/api/tmdb?path=${encodeURIComponent('/account/999')}`);
        assert.equal(badPathRes.status, 400);

        // 3 istek sınırı dolduktan sonra 4. istek -> 429 + Retry-After
        await fetch(`${baseUrl}/api/tmdb?path=${encodeURIComponent('/genre/movie/list')}`);
        const rateLimitedRes = await fetch(`${baseUrl}/api/tmdb?path=${encodeURIComponent('/genre/tv/list')}`);
        assert.equal(rateLimitedRes.status, 429);
        assert.ok(Number(rateLimitedRes.headers.get('retry-after')) >= 1);
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Faz 5: validateTmdbResponseShape bozuk upstream şemalarını yakalar', () => {
  assert.equal(validateTmdbResponseShape('/trending/all/day', { results: [] }).valid, true);
  assert.equal(validateTmdbResponseShape('/trending/all/day', { results: 'bozuk' }).valid, false);
  assert.equal(validateTmdbResponseShape('/person/10/combined_credits', { cast: [] }).valid, true);
  assert.equal(validateTmdbResponseShape('/person/10/combined_credits', {}).valid, false);
  assert.equal(validateTmdbResponseShape('/tv/1399/season/1', { episodes: [] }).valid, true);
  assert.equal(validateTmdbResponseShape('/tv/1399/season/1', { episodes: null }).valid, false);
  assert.equal(validateTmdbResponseShape('/movie/550', { id: 550 }).valid, true);
  assert.equal(validateTmdbResponseShape('/movie/550', { title: 'Id Eksik' }).valid, false);

  // normalizeDataDocument favori oyuncuları korur
  const doc = normalizeDataDocument({
    version: 3,
    activeProfileId: 'profile-a',
    profiles: [makeSampleProfile('profile-a', [])],
  });
  assert.equal(doc.profiles[0].favoriteActors.length, 1);
  assert.equal(doc.profiles[0].favoriteActors[0].name, 'Timothée Chalamet');
});

// ============================================================================
// FAZ 6: İlişki Keşif Motoru v3 (atmosphere & contrast) ve Zevk Haritası İzolasyonu
// ============================================================================
test('Faz 6: atmosphere ve contrast ilişki türleri deterministik kanıt üretir ve TasteMap verisini değiştirmez', () => {
  assert.equal(RELATIONSHIP_MODEL_VERSION, 'relationship-v3');
  assert.ok(getRelationshipTypeLabel('atmosphere').length > 0);
  assert.ok(getRelationshipTypeLabel('contrast').length > 0);

  const memStorage = createMemoryLocalStorage();
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = memStorage;

  try {
    const initialTasteMap = loadPersistentTasteMap('isolated-prof');
    savePersistentTasteMap('isolated-prof', initialTasteMap);
    const beforeSnapshot = JSON.stringify(loadPersistentTasteMap('isolated-prof'));

    const candidates = [
      makeCandidate(1, 'movie', {
        title: 'Karanlık Labirent',
        overview: 'Karanlık, izole bir kasabada psikolojik gerilim ve gizemli sırlar çözülür.',
        genre_ids: [9648, 53, 18],
        release_date: '2022-10-01',
        vote_average: 8.1,
        vote_count: 900,
        cast: [{ id: 55, name: 'Ortak Oyuncu' }],
      }),
      makeCandidate(2, 'movie', {
        title: 'Gölge Kıyısı',
        overview: 'Kasvetli ve izole bir adada psikolojik gerilim dolu sırlar ortaya çıkar.',
        genre_ids: [9648, 53, 18],
        release_date: '2023-11-01',
        vote_average: 7.9,
        vote_count: 800,
      }),
      makeCandidate(3, 'movie', {
        title: 'Güneşli Tatil Günü',
        overview: 'Neşeli ve sıcak bir sahil kasabasında geçen eğlenceli aile komedisi.',
        genre_ids: [35, 10751],
        release_date: '2022-07-01',
        vote_average: 7.8,
        vote_count: 750,
        cast: [{ id: 55, name: 'Ortak Oyuncu' }],
      }),
    ];

    const atmosphereGraph = buildRelationshipGraph({
      mode: 'relationships',
      profileId: 'isolated-prof',
      candidates,
      savedItems: [],
      preferences: { disliked: [], hidden: [], providers: [], mood: '', reminders: false, notified: [] },
      mediaFilter: 'movie',
      sourceKey: 'movie:1',
      relationshipFilter: 'atmosphere',
      genreNames: { 9648: 'Gizem', 53: 'Gerilim', 18: 'Dram', 35: 'Komedi', 10751: 'Aile' },
    });
    assert.ok(atmosphereGraph.links.some((l) => l.type === 'atmosphere'));

    const contrastGraph = buildRelationshipGraph({
      mode: 'relationships',
      profileId: 'isolated-prof',
      candidates,
      savedItems: [],
      preferences: { disliked: [], hidden: [], providers: [], mood: '', reminders: false, notified: [] },
      mediaFilter: 'movie',
      sourceKey: 'movie:1',
      relationshipFilter: 'contrast',
      genreNames: { 9648: 'Gizem', 53: 'Gerilim', 18: 'Dram', 35: 'Komedi', 10751: 'Aile' },
    });
    assert.ok(contrastGraph.links.some((l) => l.type === 'contrast'));

    // Zevk haritası (localStorage) hiçbir şekilde değişmemiş olmalı!
    const afterTasteMap = loadPersistentTasteMap('isolated-prof');
    assert.equal(JSON.stringify(afterTasteMap), beforeSnapshot);
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

// ============================================================================
// FAZ 7, FAZ 9 & FAZ 10: UX Formatı, Offline Kuyruk, Değerlendirme, CSV, ICS, DNA
// ============================================================================
test('Faz 7 & 9: Uyum: X/100 rozeti ve çevrimdışı senkronizasyon kuyruğu doğru çalışır', () => {
  assert.equal(formatMatchBadge(87.4), 'Uyum: 87/100');
  assert.equal(formatMatchBadge(120), 'Uyum: 100/100');
  assert.equal(formatMatchBadge(0), 'Uyum: 1/100');

  const memStorage = createMemoryLocalStorage();
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = memStorage;
  try {
    assert.equal(hasPendingOfflineSync(), false);
    const sampleDoc = {
      version: 3,
      activeProfileId: 'profile-1',
      profiles: [makeSampleProfile('profile-1', [])],
    };
    enqueueOfflineSyncSnapshot(sampleDoc, 4);
    assert.equal(hasPendingOfflineSync(), true);
    const loaded = loadOfflineSyncSnapshot();
    assert.equal(loaded.baseRevision, 4);
    assert.equal(loaded.payload.activeProfileId, 'profile-1');
    clearOfflineSyncSnapshot();
    assert.equal(hasPendingOfflineSync(), false);
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('Faz 10: evaluateRecommendationEngine, Zevk DNA, CSV (Letterboxd/IMDb), ICS, Ortak Liste ve Yolculuk Zaman Çizelgesi', () => {
  const moviePool = Array.from({ length: 24 }, (_, idx) =>
    makeCandidate(1000 + idx, 'movie', { genre_ids: [878, (idx % 4) + 12] })
  );
  const tvPool = Array.from({ length: 24 }, (_, idx) =>
    makeCandidate(2000 + idx, 'tv', { genre_ids: [10765, (idx % 4) + 18] })
  );
  const profileA = makeSampleProfile('prof-a', [
    {
      id: 11,
      media_type: 'movie',
      title: 'Yıldızlararası',
      release_date: '2014-11-05',
      genre_ids: [878, 18],
      vote_average: 8.7,
      vote_count: 32000,
      popularity: 120,
      status: 'completed',
      personal_rating: 9,
      addedAt: '2026-01-02T12:00:00.000Z',
      updatedAt: '2026-01-05T12:00:00.000Z',
    },
    {
      id: 22,
      media_type: 'movie',
      title: 'Ortak İzlenecek Film',
      release_date: '2026-11-20',
      genre_ids: [878],
      vote_average: 8.1,
      vote_count: 500,
      popularity: 60,
      status: 'watchlist',
      personal_rating: '',
      addedAt: '2026-01-10T12:00:00.000Z',
    },
    {
      id: 33,
      media_type: 'tv',
      title: 'Severance',
       name: 'Severance',
      first_air_date: '2022-02-17',
      genre_ids: [10765, 9648],
      vote_average: 8.4,
      vote_count: 1500,
      popularity: 95,
      status: 'watching',
      personal_rating: 9,
      next_episode_to_air: { air_date: '2026-12-01', episode_number: 4, season_number: 2 },
      addedAt: '2026-01-12T12:00:00.000Z',
    },
  ]);

  // 1. Offline öneri değerlendirme motoru
  const evalReport = evaluateRecommendationEngine({
    profile: profileA,
    candidatePool: [...moviePool, ...tvPool],
    batchesCount: 3,
    batchSize: 8,
    targetType: 'all',
  });
  assert.equal(evalReport.ring1RepeatRate, 0);
  assert.equal(evalReport.ring0Utilization, 1);
  assert.equal(evalReport.typeBalanceAccuracy, 1);
  assert.ok(evalReport.genreEntropy > 0);

  // 2. Zevk DNA Özeti
  const dna = buildTasteDnaProfile(profileA, { 878: 'Bilim Kurgu', 18: 'Dram', 10765: 'Bilim Kurgu & Fantazi', 9648: 'Gizem' });
  assert.equal(dna.totalTracked, 3);
  assert.equal(dna.averagePersonalRating, 9);
  assert.ok(dna.topGenres.some((g) => g.name === 'Bilim Kurgu'));
  assert.equal(dna.signatureTraits.length, 3);

  // 3. CSV dışa ve içe aktarma (CineTrack + Letterboxd 5-yıldız ölçekleme)
  const csvOut = exportItemsToCsv(profileA.items);
  const reimported = importItemsFromCsv(csvOut);
  assert.equal(reimported.detectedFormat, 'cinetrack');
  assert.equal(reimported.importedItems.length, 3);

  const letterboxdCsv = [
    'Date,Name,Year,Letterboxd URI,Rating,Watched Date',
    '2026-02-01,Arrival,2016,https://boxd.it/abc,4.5,2026-02-01',
  ].join('\n');
  const lbParsed = importItemsFromCsv(letterboxdCsv);
  assert.equal(lbParsed.detectedFormat, 'letterboxd');
  assert.equal(lbParsed.importedItems[0].personal_rating, 9); // 4.5 * 2 = 9/10

  // 4. Sezon / Vizyon Takvimi ve RFC 5545 .ics üretimi
  const events = extractUpcomingReleaseEvents(profileA.items, '2026-06-01');
  assert.equal(events.length, 2); // 2026-11-20 film + 2026-12-01 S02E04 dizi
  const ics = generateIcsCalendar(events);
  assert.ok(ics.includes('BEGIN:VCALENDAR'));
  assert.ok(ics.includes('SUMMARY:Severance — S02E04'));
  assert.ok(ics.includes('END:VCALENDAR'));

  // 5. İki profil izleme listesi kesişimi
  const profileB = makeSampleProfile('prof-b', [
    { ...profileA.items[1], status: 'watchlist' },
    { ...profileA.items[0], status: 'watchlist', personal_rating: '' },
  ]);
  const overlap = computeProfileWatchlistIntersection(profileA, profileB);
  assert.equal(overlap.commonWatchlist.length, 1);
  assert.equal(overlap.commonWatchlist[0].title, 'Ortak İzlenecek Film');
  assert.equal(overlap.recommendedByOneToOther.length, 1);
  assert.equal(overlap.recommendedByOneToOther[0].item.title, 'Yıldızlararası');

  // 6. İzleme Yolculuğu Zaman Çizelgesi
  const timeline = buildMediaJourneyTimeline(profileA, {
    'movie:11': {
      tasteScore: 93,
      impressionHistory: [{ shownAt: '2026-01-01T09:00:00.000Z', targetType: 'all', rank: 1 }],
    },
  });
  assert.ok(timeline.some((m) => m.kind === 'recommended' && m.detail.includes('Uyum: 93/100')));
  assert.ok(timeline.some((m) => m.kind === 'completed'));
});

// ============================================================================
// YEREL (LOCALHOST) SIFIR ORTAM DEĞİŞKENİ, BUN.LOCK TEMİZLİĞİ VE GOLDEN SKORLAMA
// ============================================================================
test('Yerel mimari güvenceleri: bun.lock yoktur, VITE_ sırrı yoktur, CINETRACK_HOST=127.0.0.1 ve sıfır env ile token/rate-limit devre dışıdır', async () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

  // 1. bun.lock temizlenmiş olmalı
  assert.equal(fs.existsSync(path.join(repoRoot, 'bun.lock')), false, 'bun.lock depoda bulunmamalı');

  // 2. .env.example ve src/services/api.ts içinde VITE_CINETRACK_TOKEN, CINETRACK_RATE_LIMIT_MAX, CINETRACK_MAX_DATA_BYTES olmamalı
  const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  assert.equal(envExample.includes('VITE_'), false, '.env.example içinde VITE_ değişkeni bulunmamalı');
  assert.equal(envExample.includes('CINETRACK_TOKEN'), false);
  assert.equal(envExample.includes('CINETRACK_RATE_LIMIT'), false);
  assert.equal(envExample.includes('CINETRACK_MAX_DATA_BYTE'), false);

  const apiTs = fs.readFileSync(path.join(repoRoot, 'src/services/api.ts'), 'utf8');
  assert.equal(apiTs.includes('VITE_CINETRACK_TOKEN'), false, 'İstemci kodunda VITE_CINETRACK_TOKEN bulunmamalı');

  // 3. server.ts içinde CINETRACK_HOST = '127.0.0.1' ve maxDataBytes = 2_000_000 sabiti korunmalı
  const serverTs = fs.readFileSync(path.join(repoRoot, 'server.ts'), 'utf8');
  assert.ok(serverTs.includes("const CINETRACK_HOST = '127.0.0.1'"), 'CINETRACK_HOST sabiti 127.0.0.1 olmalı');
  assert.ok(serverTs.includes('const maxDataBytes = 2_000_000;'), 'maxDataBytes sabiti 2_000_000 olmalı');
  assert.equal(serverTs.includes('CINETRACK_MAX_DATA_BYTE'), false, 'maxDataBytes ortam değişkenine bağlanmamalı');

  // 4. Sıfır güvenlik seçeneği ile (varsayılan localhost) token istemeden yazma ve hız sınırı olmadan TMDB erişimi çalışmalı
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinetrack-zeroenv-'));
  try {
    await withServer({ dataDir: tmpDir }, async (baseUrl) => {
      const putRes = await fetch(`${baseUrl}/api/data`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 3,
          activeProfileId: 'profile-1',
          profiles: [makeSampleProfile('profile-1', [])],
        }),
      });
      assert.equal(putRes.status, 200, 'Varsayılan localhost modunda token olmadan PUT /api/data 200 dönmeli');

      // Ardışık 10 TMDB isteğinin hiçbiri 429 veya X-RateLimit-Limit başlığı üretmemeli
      for (let i = 0; i < 10; i++) {
        const tmdbRes = await fetch(`${baseUrl}/api/tmdb?path=${encodeURIComponent('/genre/movie/list')}`);
        assert.equal(tmdbRes.status, 200);
        assert.equal(tmdbRes.headers.get('x-ratelimit-limit'), null, 'Varsayılan modda rate limit devre dışı olmalı');
      }
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Golden Skorlama Testi: sabit referans profil ve adaylar üzerinde scoreCandidatesV3 birebir aynı deterministik puanları üretir', () => {
  const fixedNow = new Date('2026-03-01T00:00:00.000Z').getTime();
  const referenceHistory = [
    {
      id: 157336,
      media_type: 'movie',
      title: 'Interstellar',
      overview: 'Uzay solucan deliği zaman yolculuğu ve insanlığın hayatta kalma mücadelesi.',
      genre_ids: [878, 18, 12],
      vote_average: 8.7,
      vote_count: 34000,
      popularity: 140,
      status: 'completed',
      personal_rating: 10,
      updatedAt: '2026-02-15T00:00:00.000Z',
      cast: [
        { id: 10297, name: 'Matthew McConaughey' },
        { id: 1813, name: 'Anne Hathaway' },
      ],
      crew: [{ id: 525, name: 'Christopher Nolan', job: 'Director' }],
    },
    {
      id: 27205,
      media_type: 'movie',
      title: 'Inception',
      overview: 'Rüya katmanları bilinçaltı casusluk ve zaman kırılması.',
      genre_ids: [878, 28, 12],
      vote_average: 8.8,
      vote_count: 35000,
      popularity: 130,
      status: 'completed',
      personal_rating: 9,
      updatedAt: '2026-02-10T00:00:00.000Z',
      cast: [{ id: 6193, name: 'Leonardo DiCaprio' }],
      crew: [{ id: 525, name: 'Christopher Nolan', job: 'Director' }],
    },
  ];

  const profileA = buildTasteProfileV3(referenceHistory, { lambda: 1, dislikedKeys: ['movie:99999'], now: fixedNow });
  const profileB = buildTasteProfileV3(referenceHistory, { lambda: 1, dislikedKeys: ['movie:99999'], now: fixedNow });
  assert.deepEqual(profileA.genres, profileB.genres);

  const candidates = [
    {
      id: 329865,
      media_type: 'movie',
      title: 'Arrival',
      overview: 'Uzay gemileri zaman algısı dilbilim ve insanlığın geleceği.',
      genre_ids: [878, 18],
      vote_average: 7.9,
      vote_count: 17000,
      popularity: 85,
      release_date: '2016-11-11',
      poolSources: 3,
      cast: [{ id: 9273, name: 'Amy Adams' }],
      crew: [{ id: 137427, name: 'Denis Villeneuve', job: 'Director' }],
    },
    {
      id: 872585,
      media_type: 'movie',
      title: 'Oppenheimer',
      overview: 'Kuantum fiziği nükleer proje ve tarihsel sorumluluk.',
      genre_ids: [18, 36],
      vote_average: 8.1,
      vote_count: 9500,
      popularity: 110,
      release_date: '2023-07-21',
      poolSources: 2,
      cast: [{ id: 2037, name: 'Cillian Murphy' }],
      crew: [{ id: 525, name: 'Christopher Nolan', job: 'Director' }],
    },
    {
      id: 44444,
      media_type: 'movie',
      title: 'Sıradan Romantik Komedi',
      overview: 'Tatil köyünde tesadüfi karşılaşma ve düğün hazırlığı.',
      genre_ids: [35, 10749],
      vote_average: 5.4,
      vote_count: 180,
      popularity: 15,
      release_date: '2021-06-01',
      poolSources: 1,
    },
  ];

  const run1 = scoreCandidatesV3(candidates, profileA, {
    weights: RECOMMENDATION_WEIGHTS_V3,
    genreNames: { 878: 'Bilim Kurgu', 18: 'Dram', 36: 'Tarih', 35: 'Komedi', 10749: 'Romantik' },
  });
  const run2 = scoreCandidatesV3(candidates, profileB, {
    weights: RECOMMENDATION_WEIGHTS_V3,
    genreNames: { 878: 'Bilim Kurgu', 18: 'Dram', 36: 'Tarih', 35: 'Komedi', 10749: 'Romantik' },
  });

  // Birebir aynı golden skorlar ve sinyal parçaları (parts) üretilmeli
  assert.deepEqual(
    run1.map((r) => ({ id: r.candidate.id, score: r.score, tasteScore: r.tasteScore, parts: r.parts })),
    run2.map((r) => ({ id: r.candidate.id, score: r.score, tasteScore: r.tasteScore, parts: r.parts }))
  );

  const byId = Object.fromEntries(run1.map((r) => [r.candidate.id, r]));
  // Sabit golden referans değerleri (72 > 64 > 52)
  assert.equal(byId[329865].tasteScore, 72);
  assert.equal(byId[872585].tasteScore, 64);
  assert.equal(byId[44444].tasteScore, 52);
  assert.ok(byId[872585].parts.director > 0.85, 'Christopher Nolan yönetmen sinyali yüksek olmalı');
  assert.ok(byId[329865].parts.genre > 0.85, 'Bilim Kurgu + Dram tür sinyali yüksek olmalı');
});

// ============================================================================
// SANA ÖZEL RING 1 (GÖSTERİM HAFIZASI) & 'LİSTEMDEKİLERİ GİZLE' VERİ KATMANI TESTLERİ
// ============================================================================
test('Sana Özel - Ring 1 (Gösterim Hafızası): gösterilen grubun mediaKey anahtarları lastRecommendedKeys içine kaydedilir, shownCount artar ve Önerileri Güncelle turunda önceki grup kesinlikle elenir', () => {
  const prevStorage = globalThis.localStorage;
  const memStorage = createMemoryLocalStorage();
  globalThis.localStorage = memStorage;

  try {
    const profileId = 'profile-ring1-test';
    const savedItems = [
      {
        id: 10,
        media_type: 'movie',
        title: 'Referans Bilim Kurgu',
        genre_ids: [878, 18],
        vote_average: 8.6,
        status: 'completed',
        personal_rating: 9,
      },
    ];
    const preferences = { disliked: [], hidden: [], providers: [], mood: '', reminders: false, notified: [] };
    const tasteProfile = buildTasteProfileV3(savedItems, { lambda: 1 });

    // 30 film + 30 dizi aday havuzu oluştur (2 ardışık 10+10 turuna yetecek taze aday)
    const moviePool = Array.from({ length: 30 }, (_, idx) => ({
      id: 1001 + idx,
      media_type: 'movie',
      title: `Aday Film ${idx + 1}`,
      genre_ids: [878, (idx % 5) + 12],
      vote_average: 8.5 - (idx % 10) * 0.1,
      vote_count: 1500 + idx * 50,
      popularity: 80 - idx,
      release_date: `${2005 + (idx % 20)}-05-10`,
    }));
    const tvPool = Array.from({ length: 30 }, (_, idx) => ({
      id: 2001 + idx,
      media_type: 'tv',
      name: `Aday Dizi ${idx + 1}`,
      genre_ids: [18, (idx % 5) + 80],
      vote_average: 8.4 - (idx % 10) * 0.1,
      vote_count: 1200 + idx * 40,
      popularity: 75 - idx,
      first_air_date: `${2008 + (idx % 17)}-09-15`,
    }));

    const initialMap = createDefaultTasteMapData(profileId);
    const sig = computeTasteProfileSignature(savedItems, preferences, [], { targetType: 'all' });

    // 1. TUR: İlk öneri grubu seçilir ve UI'da gösterilir
    const scoredMoviesR1 = scoreCandidatesV3(moviePool, tasteProfile, { tasteMap: initialMap });
    const scoredTvR1 = scoreCandidatesV3(tvPool, tasteProfile, { tasteMap: initialMap });
    const round1 = selectBalancedRecommendations({
      targetType: 'all',
      scoredMovies: scoredMoviesR1.slice(0, 15),
      scoredTv: scoredTvR1.slice(0, 15),
      remainingMovies: scoredMoviesR1.slice(15),
      remainingTv: scoredTvR1.slice(15),
      lastRecommendedKeys: initialMap.lastRecommendedKeys,
      tasteMap: initialMap,
      targetTotal: 20,
      minPerTypeInAll: 10,
    });
    assert.equal(round1.items.length, 20, '1. turda 10 film + 10 dizi = 20 öneri seçilmeli');

    const mapAfterR1 = updateTasteMapWithBatch({
      tasteMap: initialMap,
      newRecommendedItems: round1.items,
      allPoolCandidates: [...scoredMoviesR1, ...scoredTvR1],
      savedItems,
      preferences,
      profileSignature: sig,
      targetType: 'all',
      now: '2026-03-10T10:00:00.000Z',
    });
    savePersistentTasteMap(profileId, mapAfterR1);

    // Kalıcı depodan geri yükle (migrasyonun cachedBalancedItems { candidate } sarmalayıcılarını bozmadığını doğrula)
    const reloadedR1 = loadPersistentTasteMap(profileId);
    assert.equal(reloadedR1.lastRecommendedKeys.length, 20, 'Gösterilen 20 içeriğin tamamı lastRecommendedKeys içine kaydedilmeli');
    assert.equal(reloadedR1.cachedBalancedItems?.length, 20, 'cachedBalancedItems 20 öğeyi eksiksiz korumalı');

    const round1Keys = round1.items.map((e) => makeMediaKey(e.candidate || e));
    assert.deepEqual(new Set(reloadedR1.lastRecommendedKeys), new Set(round1Keys));

    for (const key of round1Keys) {
      const entry = reloadedR1.entries[key];
      assert.ok(entry, `${key} Zevk Haritası entries içinde bulunmalı`);
      assert.equal(entry.shownCount, 1, `${key} shownCount değeri 1 olmalı`);
      assert.equal(entry.ring, 'ring1', `${key} son gösterilen grupta olduğu için ring1 olmalı`);
    }

    // Havuz puan kaydı (recordTasteMapPoolScores) lastRecommendedKeys'i asla sıfırlamamalı
    const afterPoolRescore = recordTasteMapPoolScores({
      tasteMap: reloadedR1,
      poolCandidates: [...scoredMoviesR1, ...scoredTvR1],
      savedItems,
      preferences,
      profileSignature: sig,
      targetType: 'all',
      now: '2026-03-10T10:05:00.000Z',
    });
    assert.deepEqual(new Set(afterPoolRescore.lastRecommendedKeys), new Set(round1Keys));
    for (const key of round1Keys) {
      assert.equal(afterPoolRescore.entries[key].skippedCount, 0, 'Sadece havuz puanlaması skippedCount artırmamalı');
      assert.equal(afterPoolRescore.entries[key].ring, 'ring1');
    }

    // recordDisplayedRecommendations aynı grup için idempotent olmalı (shownCount 2'ye çıkmamalı)
    const idempotentSync = recordDisplayedRecommendations(reloadedR1, reloadedR1.cachedBalancedItems, {
      targetType: 'all',
      now: '2026-03-10T10:06:00.000Z',
    });
    assert.equal(idempotentSync.changed, false);
    assert.equal(idempotentSync.tasteMap.entries[round1Keys[0]].shownCount, 1);

    // 2. TUR: Kullanıcı hiçbir içeriği listeye eklemeden 'Önerileri Güncelle' butonuna basar
    const scoredMoviesR2 = scoreCandidatesV3(moviePool, tasteProfile, { tasteMap: reloadedR1 });
    const scoredTvR2 = scoreCandidatesV3(tvPool, tasteProfile, { tasteMap: reloadedR1 });

    // kasıtlı olarak scoredMoviesR2 / remainingMovies içine 1. turun adaylarını doğrudan versek bile
    // selectBalancedRecommendations ve filterOutLastRecommendedCandidates bunları kesinlikle elemeli!
    const filteredMoviesR2 = filterOutLastRecommendedCandidates(scoredMoviesR2, reloadedR1.lastRecommendedKeys);
    assert.equal(
      filteredMoviesR2.some((e) => round1Keys.includes(makeMediaKey(e.candidate))),
      false,
      'filterOutLastRecommendedCandidates 1. turdaki hiçbir filmi geçirmemeli'
    );

    const round2 = selectBalancedRecommendations({
      targetType: 'all',
      scoredMovies: scoredMoviesR2, // filtrelenmemiş liste verilse dahi iç güvenlik katmanı ring1/lastRecommendedKeys'i elemeli
      scoredTv: scoredTvR2,
      remainingMovies: scoredMoviesR2,
      remainingTv: scoredTvR2,
      lastRecommendedKeys: reloadedR1.lastRecommendedKeys.map((k) => k.replace(':', '-')), // eski movie-123 biçimiyle bile çalışmalı
      tasteMap: reloadedR1,
      targetTotal: 20,
      minPerTypeInAll: 10,
    });

    assert.equal(round2.items.length, 20, '2. turda 20 yeni öneri seçilmeli');
    const round2Keys = round2.items.map((e) => makeMediaKey(e.candidate || e));
    const overlap = round2Keys.filter((k) => round1Keys.includes(k));
    assert.equal(
      overlap.length,
      0,
      `Önerileri Güncelle sonrasında 1. turda gösterilen hiçbir içerik 2. turda tekrar çıkmamalı (çakışan: ${overlap.join(', ')})`
    );

    const mapAfterR2 = updateTasteMapWithBatch({
      tasteMap: reloadedR1,
      newRecommendedItems: round2.items,
      allPoolCandidates: [...scoredMoviesR2, ...scoredTvR2],
      savedItems,
      preferences,
      profileSignature: sig,
      targetType: 'all',
      now: '2026-03-10T10:15:00.000Z',
    });

    assert.deepEqual(new Set(mapAfterR2.lastRecommendedKeys), new Set(round2Keys));
    for (const r1Key of round1Keys) {
      assert.equal(mapAfterR2.entries[r1Key].ring, 'ring2', '1. turda eklenmeyen içerikler 2. turda ring2 olmalı');
      assert.equal(mapAfterR2.entries[r1Key].skippedCount, 1, '1. turda eklenmeyen içeriklerin skippedCount değeri 1 olmalı');
      assert.equal(mapAfterR2.entries[r1Key].shownCount, 1);
    }
    for (const r2Key of round2Keys) {
      assert.equal(mapAfterR2.entries[r2Key].ring, 'ring1', '2. turda gösterilen içerikler ring1 olmalı');
      assert.equal(mapAfterR2.entries[r2Key].shownCount, 1, '2. turda gösterilen içeriklerin shownCount değeri 1 olmalı');
    }

    // Kota aşımı (QuotaExceededError) durumunda bile lastRecommendedKeys ve shownCount korunmalı
    let throwOnFirstWrite = true;
    const quotaStorage = {
      getItem: (k) => memStorage.getItem(k),
      setItem: (k, v) => {
        if (throwOnFirstWrite) {
          throwOnFirstWrite = false;
          throw new Error('QuotaExceededError');
        }
        memStorage.setItem(k, v);
      },
      removeItem: (k) => memStorage.removeItem(k),
      clear: () => memStorage.clear(),
    };
    globalThis.localStorage = quotaStorage;
    savePersistentTasteMap(profileId, mapAfterR2);
    const loadedAfterQuota = loadPersistentTasteMap(profileId);
    assert.deepEqual(new Set(loadedAfterQuota.lastRecommendedKeys), new Set(round2Keys));
    assert.equal(loadedAfterQuota.entries[round2Keys[0]].shownCount, 1);
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test("Keşfet - 'Listemdekileri Gizle' filtresi: Gündemdekiler, Yüksek Puanlılar ve Gizli Cevherler için tüm kayıtlı/etkileşimli durumları veri katmanında anında süzer", () => {
  assert.deepEqual(HIDE_LISTED_CATEGORIES, ['trending', 'top-rated', 'gems']);

  const savedItems = [
    { id: 501, media_type: 'movie', title: 'İzlenen Film', status: 'completed' },
    { id: 502, media_type: 'movie', title: 'İzlenecek Film', status: 'watchlist' },
    { id: 503, media_type: 'tv', name: 'İzlenen Dizi', status: 'watching' },
  ];
  const preferences = {
    disliked: ['movie:504'],
    hidden: ['tv:505'],
    providers: [],
    mood: '',
    reminders: false,
    notified: [],
  };
  const tasteMap = {
    ...createDefaultTasteMapData('profile-hide-filter'),
    entries: {
      'movie:506': { mediaKey: 'movie:506', mediaType: 'movie', id: 506, title: 'Haritada Kayıtlı', status: 'saved', shownCount: 1 },
      'movie-508': { mediaKey: 'movie-508', mediaType: 'movie', id: 508, title: 'Eski Anahtar Gizli', status: 'hidden', shownCount: 1 },
      'movie:509': { mediaKey: 'movie:509', mediaType: 'movie', id: 509, title: 'Sadece Havuzda Aday', status: 'active', shownCount: 1 },
    },
    archivedEntries: {
      'tv:507': { mediaKey: 'tv:507', mediaType: 'tv', id: 507, title: 'Arşivde İlgilenilmeyen', status: 'disliked', shownCount: 1 },
    },
  };

  const discoverCatalog = [
    { id: 501, media_type: 'movie', title: 'İzlenen Film' },
    { id: 502, media_type: 'movie', title: 'İzlenecek Film' },
    { id: 503, media_type: 'tv', name: 'İzlenen Dizi' },
    { id: 504, media_type: 'movie', title: 'İlgilenilmeyen Film' },
    { id: 505, media_type: 'tv', name: 'Gizlenen Dizi' },
    { id: 506, media_type: 'movie', title: 'Haritada Kayıtlı' },
    { id: 507, media_type: 'tv', name: 'Arşivde İlgilenilmeyen' },
    { id: 508, media_type: 'movie', title: 'Eski Anahtar Gizli' },
    { id: 509, media_type: 'movie', title: 'Sadece Havuzda Aday' },
    { id: 510, media_type: 'tv', name: 'Tamamen Yeni Keşif Dizisi' },
  ];

  // Kutucuk işaretli değilken (hideListedItems: false) katalog olduğu gibi dönmeli
  const unfiltered = filterHiddenUserRegisteredItems(discoverCatalog, {
    savedItems,
    preferences,
    tasteMap,
    hideListedItems: false,
  });
  assert.equal(unfiltered.length, 10);

  // Kutucuk işaretliyken (hideListedItems: true) İzlendi, İzlenecek, İzliyorum, İlgilenmiyorum, Gizle
  // ve Zevk Haritasındaki saved/disliked/hidden öğeler anında elenmeli; yalnızca status:'active' ve yeni içerikler kalmalı
  const filtered = filterHiddenUserRegisteredItems(discoverCatalog, {
    savedItems,
    preferences,
    tasteMap,
    hideListedItems: true,
  });
  assert.deepEqual(
    filtered.map((item) => makeMediaKey(item)),
    ['movie:509', 'tv:510']
  );

  assert.equal(isMediaRegisteredInUserProfile({ id: 501, media_type: 'movie' }, { savedItems, preferences, tasteMap }), true);
  assert.equal(isMediaRegisteredInUserProfile({ id: 509, media_type: 'movie' }, { savedItems, preferences, tasteMap }), false);

  // Controls.tsx ve App.tsx entegrasyon kontrolü
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const controlsTsx = fs.readFileSync(path.join(repoRoot, 'src/components/Controls.tsx'), 'utf8');
  const appTsx = fs.readFileSync(path.join(repoRoot, 'src/App.tsx'), 'utf8');
  assert.ok(controlsTsx.includes('Listemdekileri Gizle'), 'Controls.tsx içinde Listemdekileri Gizle etiketi bulunmalı');
  assert.ok(controlsTsx.includes('type="checkbox"'), 'Controls.tsx içinde checkbox kontrolü bulunmalı');
  assert.ok(appTsx.includes('filterHiddenUserRegisteredItems'), 'App.tsx veri katmanında filterHiddenUserRegisteredItems kullanmalı');
});



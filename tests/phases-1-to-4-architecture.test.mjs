import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveConfig } from '../src/server/config.ts';
import { createTokenAuthMiddleware } from '../src/server/security.ts';
import { PersistentDataStore } from '../src/server/persistent-store.ts';
import { createCineTrackApp } from '../src/server/app.ts';
import {
  enqueueOfflineSyncSnapshot,
  loadOfflineSyncSnapshotAsync,
  clearOfflineSyncSnapshot,
  flushOfflineQueuePersistence,
  resetOfflineQueueForTests,
} from '../src/services/offline-queue.ts';
import {
  saveIsolatedProfileIdb,
  loadIsolatedProfileIdb,
  saveUserListsIdb,
  loadUserListsIdb,
  recordSurfacedKeys,
  loadSurfacedKeys,
  removeSurfacedKey,
  loadStockIdb,
  saveStockIdb,
  loadSeriesIndexIdb,
  resetIdbMemoryStateForTests,
} from '../src/services/storage-idb.ts';
import {
  MAX_POSTER_CACHE_BYTES,
  TARGET_POSTER_CACHE_BYTES,
  POSTER_CACHE_NAME,
  recordPosterAccess,
  inspectPosterCache,
  enforcePosterCacheQuota,
  resetPosterMetaForTests,
} from '../src/services/poster-cache-manager.ts';
import {
  indexItemForSeries,
  isItemInSeries,
  computeUserSeriesUniverses,
  setSeriesTmdbFetcher,
  resetSeriesServiceForTests,
} from '../src/services/series-service.ts';
import {
  STOCK_TARGET_COUNT,
  STOCK_REPLENISH_THRESHOLD,
  initStockEngine,
  consumeStockItem,
  executeStockReplenishment,
  getStockCounts,
  setStockTmdbFetcher,
  resetStockEngineForTests,
} from '../src/services/stock-engine.ts';
import {
  savePersistentTasteMap,
  hydrateDiscoveryHistoryIdb,
  savePersistentPoolData,
  hydrateCandidatePoolsIdb,
  createDefaultTasteMapData,
  createDefaultPoolData,
  flushCoreIdbWrites,
  resetCoreIdbMirrorsForTests,
} from '../src/core/cinetrack-core.ts';

/**
 * Lightweight W3C-compatible fake IndexedDB factory so idb-keyval exercises real IDB transactions in Node tests.
 */
function createFakeIndexedDB() {
  const databases = new Map();

  function makeRequest(executor) {
    const req = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    };
    setImmediate(() => executor(req));
    return req;
  }

  return {
    open(dbName) {
      return makeRequest((req) => {
        let dbEntry = databases.get(dbName);
        const isNew = !dbEntry;
        if (!dbEntry) {
          dbEntry = { stores: new Map() };
          databases.set(dbName, dbEntry);
        }

        const db = {
          objectStoreNames: {
            contains: (name) => dbEntry.stores.has(name),
          },
          createObjectStore(name) {
            if (!dbEntry.stores.has(name)) {
              dbEntry.stores.set(name, new Map());
            }
            return {};
          },
          transaction(storeName) {
            if (!dbEntry.stores.has(storeName)) {
              dbEntry.stores.set(storeName, new Map());
            }
            const map = dbEntry.stores.get(storeName);
            const tx = {
              oncomplete: null,
              onabort: null,
              onerror: null,
              error: null,
              objectStore() {
                return {
                  transaction: tx,
                  get(key) {
                    const r = { result: map.get(key), onsuccess: null, onerror: null };
                    setImmediate(() => {
                      r.onsuccess?.({ target: r });
                      tx.oncomplete?.({ target: tx });
                    });
                    return r;
                  },
                  put(val, key) {
                    map.set(key, structuredClone(val));
                    const r = { result: key, onsuccess: null, onerror: null };
                    setImmediate(() => {
                      r.onsuccess?.({ target: r });
                      tx.oncomplete?.({ target: tx });
                    });
                    return r;
                  },
                  delete(key) {
                    map.delete(key);
                    const r = { result: undefined, onsuccess: null, onerror: null };
                    setImmediate(() => {
                      r.onsuccess?.({ target: r });
                      tx.oncomplete?.({ target: tx });
                    });
                    return r;
                  },
                  clear() {
                    map.clear();
                    const r = { result: undefined, onsuccess: null, onerror: null };
                    setImmediate(() => {
                      r.onsuccess?.({ target: r });
                      tx.oncomplete?.({ target: tx });
                    });
                    return r;
                  },
                  getAllKeys() {
                    const r = { result: Array.from(map.keys()), onsuccess: null, onerror: null };
                    setImmediate(() => {
                      r.onsuccess?.({ target: r });
                      tx.oncomplete?.({ target: tx });
                    });
                    return r;
                  },
                };
              },
            };
            return tx;
          },
          close() {},
        };

        req.result = db;
        if (isNew && typeof req.onupgradeneeded === 'function') {
          req.onupgradeneeded({ target: req });
        }
        req.onsuccess?.({ target: req });
      });
    },
    _databases: databases,
  };
}

function createFakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    _map: map,
  };
}

test('Aşama 1 (BUG-01, BUG-02, BUG-04): 127.0.0.1 varsayılan dinleme + CINETRACK_TOKEN zorunluluğu, IndexedDB göçü ve bloklamayan fs.promises G/Ç', async () => {
  // 1. BUG-01: Default host 127.0.0.1 & remote bind requires CINETRACK_TOKEN
  const defaultCfg = resolveConfig({ env: {} });
  assert.equal(defaultCfg.listenHost, '127.0.0.1');
  assert.equal(defaultCfg.effectiveBindHost, '127.0.0.1');
  assert.equal(defaultCfg.isRemoteHostWithoutToken, false);

  const remoteUnprotectedCfg = resolveConfig({ env: { CINETRACK_HOST: '0.0.0.0' } });
  assert.equal(remoteUnprotectedCfg.isRemoteHostWithoutToken, true);

  const remoteNoTokenGuard = createTokenAuthMiddleware({ authToken: '', bindHost: '0.0.0.0' });
  let statusSent = 200;
  let bodySent = null;
  remoteNoTokenGuard(
    { method: 'POST', headers: {} },
    {
      status(code) {
        statusSent = code;
        return this;
      },
      json(payload) {
        bodySent = payload;
        return this;
      },
    },
    () => {}
  );
  assert.equal(statusSent, 503);
  assert.equal(bodySent?.error, 'auth_required');

  const remoteTokenGuard = createTokenAuthMiddleware({
    authToken: 'gizli-token-99',
    bindHost: '0.0.0.0',
  });
  let unauthorizedCode = 200;
  remoteTokenGuard(
    { method: 'POST', headers: { authorization: 'Bearer hatali' } },
    {
      status(code) {
        unauthorizedCode = code;
        return this;
      },
      json() {
        return this;
      },
    },
    () => {}
  );
  assert.equal(unauthorizedCode, 401);

  let authorizedNextCalled = false;
  remoteTokenGuard(
    { method: 'POST', headers: { authorization: 'Bearer gizli-token-99' } },
    {
      status() {
        return this;
      },
      json() {
        return this;
      },
    },
    () => {
      authorizedNextCalled = true;
    }
  );
  assert.equal(authorizedNextCalled, true);

  // 2. BUG-02: IndexedDB migration for offline-queue, discovery-history, and candidate-pool (zero localStorage bloat)
  const prevIdb = globalThis.indexedDB;
  const prevLs = globalThis.localStorage;
  const fakeIdb = createFakeIndexedDB();
  const fakeLs = createFakeLocalStorage();
  globalThis.indexedDB = fakeIdb;
  globalThis.localStorage = fakeLs;
  resetCoreIdbMirrorsForTests();
  resetOfflineQueueForTests();

  try {
    const sampleDoc = {
      version: 3,
      activeProfileId: 'profile-default',
      profiles: [
        {
          id: 'profile-default',
          name: 'Test',
          createdAt: '2026-01-01T00:00:00.000Z',
          preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
          items: [],
        },
      ],
    };

    const enq = enqueueOfflineSyncSnapshot(sampleDoc, 3);
    assert.equal(enq.persisted, true);
    await flushOfflineQueuePersistence();
    assert.equal(fakeLs.getItem('cinetrack_offline_sync_queue_v1'), null);
    assert.equal(
      fakeIdb._databases
        .get('cinetrack-offline-queue-db')
        ?.stores.get('cinetrack_offline_queue_store')
        ?.has('latest_offline_snapshot'),
      true
    );

    const asyncSnap = await loadOfflineSyncSnapshotAsync();
    assert.equal(asyncSnap?.baseRevision, 3);
    clearOfflineSyncSnapshot();
    await flushOfflineQueuePersistence();

    // Discovery history & candidate pool in IndexedDB without writing to localStorage
    const tasteMap = createDefaultTasteMapData('profile-default');
    tasteMap.lastRecommendedKeys = ['movie:27205'];
    savePersistentTasteMap('profile-default', tasteMap);

    const moviePool = createDefaultPoolData('movie');
    moviePool.items = [
      {
        id: 27205,
        media_type: 'movie',
        title: 'Inception',
        vote_average: 8.4,
        vote_count: 35000,
        popularity: 120,
        genre_ids: [878, 28],
        discoveredAt: '2026-01-01T00:00:00.000Z',
        source: 'popular',
      },
    ];
    savePersistentPoolData('profile-default', moviePool);
    await flushCoreIdbWrites();

    assert.equal(fakeLs.getItem('cinetrack_taste_map_profile-default'), null);
    assert.equal(fakeLs.getItem('cinetrack_pool_movie_profile-default'), null);
    assert.equal(
      fakeIdb._databases
        .get('cinetrack-discovery-history-db')
        ?.stores.get('ct_discovery_history')
        ?.has('cinetrack_taste_map_profile-default'),
      true
    );
    assert.equal(
      fakeIdb._databases
        .get('cinetrack-candidate-pool-db')
        ?.stores.get('ct_candidate_pool')
        ?.has('cinetrack_pool_movie_profile-default'),
      true
    );

    const hydratedHistory = await hydrateDiscoveryHistoryIdb('profile-default');
    assert.deepEqual(hydratedHistory.lastRecommendedKeys, ['movie:27205']);

    const hydratedPools = await hydrateCandidatePoolsIdb('profile-default');
    assert.equal(hydratedPools.movie.items.length, 1);
    assert.equal(hydratedPools.movie.items[0].id, 27205);
  } finally {
    resetOfflineQueueForTests();
    resetCoreIdbMirrorsForTests();
    globalThis.indexedDB = prevIdb;
    globalThis.localStorage = prevLs;
  }

  // 3. BUG-04: Non-blocking async fs.promises server storage + isolated profile.json & user-lists.json
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-async-io-'));
  try {
    const persistentStore = new PersistentDataStore({ dataDir: tmpDir });
    const { app } = createCineTrackApp({
      dataDir: tmpDir,
      bindHost: '127.0.0.1',
      authToken: '',
      maxDataBytes: 25 * 1024 * 1024,
      persistentStore,
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const payload = {
        version: 3,
        activeProfileId: 'profile-default',
        profiles: [
          {
            id: 'profile-default',
            name: 'Sinema Sever',
            createdAt: '2026-01-01T00:00:00.000Z',
            preferences: { disliked: ['movie:999'], providers: ['8'], mood: 'mindbending', reminders: false, notified: [] },
            items: [
              {
                id: 603,
                media_type: 'movie',
                title: 'The Matrix',
                overview: 'Uzun açıklama metni user-lists.json içinde yer almamalıdır.',
                vote_average: 8.2,
                vote_count: 24000,
                popularity: 95,
                genre_ids: [28, 878],
                status: 'completed',
                personal_rating: 9,
                addedAt: '2026-01-02T00:00:00.000Z',
                updatedAt: '2026-01-02T00:00:00.000Z',
              },
            ],
          },
        ],
      };

      const initialGetRes = await fetch(`${baseUrl}/api/data`);
      assert.equal(initialGetRes.status, 200);
      const initialEtag = initialGetRes.headers.get('etag') || '"rev-0"';

      const putRes = await fetch(`${baseUrl}/api/data`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Origin: baseUrl,
          'If-Match': initialEtag,
        },
        body: JSON.stringify(payload),
      });
      assert.equal(putRes.status, 200);

      const isoProfRes = await fetch(`${baseUrl}/api/isolated/profile`);
      assert.equal(isoProfRes.status, 200);
      const isoProf = await isoProfRes.json();
      const profEntry = isoProf.profiles.find((p) => p.profileId === 'profile-default');
      assert.equal(profEntry?.name, 'Sinema Sever');
      assert.equal(profEntry?.theme, 'dark-navy');
      assert.equal(Array.isArray(profEntry?.dna?.positiveGenres), true);
      assert.equal(profEntry?.preferences?.mood, 'mindbending');
      assert.equal(profEntry?.items, undefined);

      const isoListsRes = await fetch(`${baseUrl}/api/isolated/user-lists`);
      assert.equal(isoListsRes.status, 200);
      const isoLists = await isoListsRes.json();
      const compactItems = isoLists.lists['profile-default'];
      assert.equal(compactItems.length, 1);
      assert.equal(compactItems[0].id, 603);
      assert.equal(compactItems[0].status, 'completed');
      assert.equal(compactItems[0].overview, undefined);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Aşama 2 (FEAT-02 & EXT-03): Yalıtılmış ct:profile, kompakt ct:user-lists, ct:surfaced FIFO ve 200 MiB Poster LRU Purge', async () => {
  resetIdbMemoryStateForTests();
  resetPosterMetaForTests();

  // Adım 4: ct:profile & compact ct:user-lists
  await saveIsolatedProfileIdb({
    profileId: 'profile-default',
    name: 'Arşivci',
    theme: 'dark-navy',
    dna: { topGenres: ['Bilim Kurgu'] },
    preferences: { disliked: ['movie:77'], providers: [], mood: '', reminders: false, notified: [] },
    updatedAt: '2026-02-01T00:00:00.000Z',
  });
  const loadedProf = await loadIsolatedProfileIdb('profile-default');
  assert.equal(loadedProf?.theme, 'dark-navy');
  assert.deepEqual(loadedProf?.dna, { topGenres: ['Bilim Kurgu'] });

  await saveUserListsIdb('profile-default', [
    {
      id: 157336,
      media_type: 'movie',
      title: 'Interstellar',
      overview: 'Çok uzun özet metni silinmeli',
      poster_path: '/interstellar.jpg',
      vote_average: 8.4,
      vote_count: 32000,
      popularity: 140,
      genre_ids: [12, 18, 878],
      status: 'completed',
      personal_rating: 10,
      addedAt: '2026-02-01T00:00:00.000Z',
    },
  ]);
  const compactLoaded = await loadUserListsIdb('profile-default');
  assert.equal(compactLoaded.length, 1);
  assert.equal(compactLoaded[0].id, 157336);
  assert.equal(compactLoaded[0].status, 'completed');
  assert.equal('overview' in compactLoaded[0], false);
  assert.equal('poster_path' in compactLoaded[0], false);

  // Adım 6: ct:surfaced FIFO eviction
  await recordSurfacedKeys(['movie:1', 'movie:2', 'movie:3', 'movie:4'], 5);
  const afterOverflow = await recordSurfacedKeys(['movie:5', 'movie:6', 'movie:7'], 5);
  assert.deepEqual(afterOverflow, ['movie:3', 'movie:4', 'movie:5', 'movie:6', 'movie:7']);

  await removeSurfacedKey('movie:5');
  const afterRemove = await loadSurfacedKeys();
  assert.deepEqual(afterRemove, ['movie:3', 'movie:4', 'movie:6', 'movie:7']);

  // Adım 7 (EXT-03): 200 MiB Poster Cache Quota & LRU Purge
  const prevCaches = globalThis.caches;
  const fakePosterMap = new Map();
  globalThis.caches = {
    async open(name) {
      assert.equal(name, POSTER_CACHE_NAME);
      return {
        async keys() {
          return Array.from(fakePosterMap.keys()).map((url) => ({ url }));
        },
        async match(req) {
          const url = typeof req === 'string' ? req : req.url;
          return fakePosterMap.get(url) || undefined;
        },
        async delete(req) {
          const url = typeof req === 'string' ? req : req.url;
          return fakePosterMap.delete(url);
        },
      };
    },
  };

  try {
    const fiftyFiveMiB = 55 * 1024 * 1024;
    // Add 4 posters = 220 MiB (> 200 MiB MAX_POSTER_CACHE_BYTES)
    const urls = [
      'https://image.tmdb.org/t/p/w500/p1.jpg',
      'https://image.tmdb.org/t/p/w500/p2.jpg',
      'https://image.tmdb.org/t/p/w500/p3.jpg',
      'https://image.tmdb.org/t/p/w500/p4.jpg',
    ];
    for (const url of urls) {
      fakePosterMap.set(url, {
        type: 'basic',
        headers: new Headers({ 'content-length': String(fiftyFiveMiB) }),
      });
    }
    // Touch p1 MORE recently than p2 & p3 so p2 & p3 are evicted first (strict LRU, not insertion order!)
    await recordPosterAccess(urls[1], fiftyFiveMiB, 1000); // oldest (p2)
    await recordPosterAccess(urls[2], fiftyFiveMiB, 2000); // second oldest (p3)
    await recordPosterAccess(urls[0], fiftyFiveMiB, 5000); // recently accessed (p1)
    await recordPosterAccess(urls[3], fiftyFiveMiB, 6000); // most recent (p4)

    const beforeStats = await inspectPosterCache();
    assert.equal(beforeStats.isOverBudget, true);
    assert.ok(beforeStats.totalSizeBytes > MAX_POSTER_CACHE_BYTES);

    const purgeRes = await enforcePosterCacheQuota();
    assert.equal(purgeRes.purgedCount, 2);
    assert.ok(purgeRes.remainingBytes <= TARGET_POSTER_CACHE_BYTES);
    assert.equal(fakePosterMap.has(urls[1]), false, 'En eski erişilen p2 silinmeli');
    assert.equal(fakePosterMap.has(urls[2]), false, 'İkinci en eski erişilen p3 silinmeli');
    assert.equal(fakePosterMap.has(urls[0]), true, 'Sonradan erişilen p1 korunmalı');
    assert.equal(fakePosterMap.has(urls[3]), true, 'En yeni p4 korunmalı');
  } finally {
    globalThis.caches = prevCaches;
  }
});

test('Aşama 3 (FEAT-01): ct:series-index film koleksiyonu + dizi keyword indeksleme, SERİ rozeti ve Seriler sekmesi kuralları', async () => {
  resetIdbMemoryStateForTests();
  resetSeriesServiceForTests();

  setSeriesTmdbFetcher(async (endpoint, params) => {
    if (endpoint === '/movie/603') {
      return { id: 603, title: 'The Matrix', belongs_to_collection: { id: 2344, name: 'The Matrix Collection' } };
    }
    if (endpoint === '/collection/2344') {
      return {
        id: 2344,
        name: 'The Matrix Serisi',
        parts: [
          { id: 603, title: 'The Matrix', release_date: '1999-03-30', genre_ids: [28, 878], vote_average: 8.2 },
          { id: 604, title: 'The Matrix Reloaded', release_date: '2003-05-15', genre_ids: [28, 878], vote_average: 7.1 },
          { id: 605, title: 'The Matrix Revolutions', release_date: '2003-11-05', genre_ids: [28, 878], vote_average: 6.7 },
        ],
      };
    }
    if (endpoint === '/movie/11') {
      return { id: 11, title: 'Star Wars', belongs_to_collection: { id: 10, name: 'Star Wars Collection' } };
    }
    if (endpoint === '/collection/10') {
      return {
        id: 10,
        name: 'Star Wars Serisi',
        parts: [
          { id: 11, title: 'Star Wars: Yeni Bir Umut', release_date: '1977-05-25', genre_ids: [12, 878], vote_average: 8.2 },
          { id: 1891, title: 'İmparator', release_date: '1980-05-20', genre_ids: [12, 878], vote_average: 8.4 },
        ],
      };
    }
    if (endpoint === '/tv/5001/keywords') {
      return {
        results: [{ id: 7701, name: 'Cyberpunk Shared Universe' }],
      };
    }
    if (endpoint === '/discover/tv' && params?.with_keywords === '7701') {
      return {
        results: [
          { id: 5001, name: 'Neon City', first_air_date: '2022-09-01', genre_ids: [10765, 16], vote_average: 8.5 },
          { id: 5002, name: 'Neon City: Aftermath', first_air_date: '2025-04-10', genre_ids: [10765, 18], vote_average: 8.1 },
        ],
      };
    }
    return {};
  });

  try {
    // Stock-only franchise (Star Wars #11 — NOT in user's list)
    await indexItemForSeries({ id: 11, media_type: 'movie', title: 'Star Wars' });
    // User-owned movie franchise (The Matrix #603 — list endpoint item without belongs_to_collection initially)
    await indexItemForSeries({ id: 603, media_type: 'movie', title: 'The Matrix' });
    // User-owned TV franchise via TMDB /tv/:id/keywords
    await indexItemForSeries({ id: 5001, media_type: 'tv', name: 'Neon City' });

    const seriesIndex = await loadSeriesIndexIdb();
    assert.ok(seriesIndex.mediaKeyToSeries['movie:603']);
    assert.ok(seriesIndex.mediaKeyToSeries['movie:604']);
    assert.ok(seriesIndex.mediaKeyToSeries['movie:11']);
    assert.ok(seriesIndex.mediaKeyToSeries['tv:5001']);
    assert.ok(seriesIndex.mediaKeyToSeries['tv:5002']);

    // Adım 9: Both stock series items and user series items get SERİ badge on MediaCard
    assert.equal(isItemInSeries({ id: 604, media_type: 'movie' }), true);
    assert.equal(isItemInSeries({ id: 11, media_type: 'movie' }), true);
    assert.equal(isItemInSeries({ id: 5002, media_type: 'tv' }), true);
    assert.equal(isItemInSeries({ id: 999999, media_type: 'movie' }), false);

    // Adım 10: Seriler tab ONLY includes missing parts of franchises in user's savedItems (Matrix & Neon City, NEVER Star Wars!)
    const userSaved = [
      {
        id: 603,
        media_type: 'movie',
        title: 'The Matrix',
        vote_average: 8.2,
        vote_count: 24000,
        popularity: 90,
        genre_ids: [28, 878],
        status: 'completed',
        personal_rating: 9,
      },
      {
        id: 5001,
        media_type: 'tv',
        title: 'Neon City',
        name: 'Neon City',
        vote_average: 8.5,
        vote_count: 4000,
        popularity: 80,
        genre_ids: [10765, 16],
        status: 'watching',
        personal_rating: '',
      },
    ];

    const universes = computeUserSeriesUniverses(userSaved);
    const missingKeys = universes.flatMap((u) =>
      u.userMissingParts.map((p) => `${p.media_type}:${p.id}`)
    );

    assert.ok(missingKeys.includes('movie:604'));
    assert.ok(missingKeys.includes('movie:605'));
    assert.ok(missingKeys.includes('tv:5002'));
    assert.equal(missingKeys.includes('movie:603'), false, 'Kullanıcının zaten sahip olduğu parça gösterilmemeli');
    assert.equal(missingKeys.includes('movie:11'), false, 'Sadece stokta olan seri asla Seriler sekmesine girmemeli');
    assert.equal(missingKeys.includes('movie:1891'), false, 'Sadece stokta olan serinin devam filmi gösterilmemeli');

    // Adım 11: Tümü / Film / Dizi filtreleri ağ isteği atmadan bellekten süzebilmeli
    const allParts = universes.flatMap((u) => u.userMissingParts);
    const onlyMovies = allParts.filter((p) => p.media_type === 'movie');
    const onlyTv = allParts.filter((p) => p.media_type === 'tv');
    assert.equal(onlyMovies.length, 2);
    assert.equal(onlyTv.length, 1);
  } finally {
    resetSeriesServiceForTests();
  }
});

test('Aşama 2 (#5) & Aşama 4 (#12–#14): ct:stock başlangıç 500 film + 500 dizi dolumu, stoktan tüketim ve <250 eşiğinde otonom yenileme', async () => {
  resetIdbMemoryStateForTests();
  resetSeriesServiceForTests();
  resetStockEngineForTests();

  // Ensure series background check is a fast no-op during stock volume test
  setSeriesTmdbFetcher(async () => ({}));

  // Seed user-lists and ct:surfaced to verify Adım 14 exclusion filtering
  await saveUserListsIdb('profile-stock', [
    { id: 10001, media_type: 'movie', status: 'completed', personal_rating: 8 },
    { id: 20001, media_type: 'tv', status: 'watching', personal_rating: '' },
  ]);
  await recordSurfacedKeys(['movie:10002', 'tv:20002']);

  setStockTmdbFetcher(async (endpoint, params) => {
    const page = Number(params?.page || 1);
    const isTv = endpoint.includes('tv');
    const base = isTv ? 20000 : 10000;
    const endpointOffset = endpoint.includes('top_rated')
      ? 2000
      : endpoint.includes('discover')
      ? 4000
      : 0;
    const results = Array.from({ length: 20 }, (_, idx) => {
      const id = base + endpointOffset + (page - 1) * 20 + idx + 1;
      return isTv
        ? { id, name: `Dizi #${id}`, media_type: 'tv', vote_average: 7.8, genre_ids: [18] }
        : { id, title: `Film #${id}`, media_type: 'movie', vote_average: 7.6, genre_ids: [28] };
    });
    return { page, total_pages: 50, results };
  });

  try {
    // Adım 5: Startup fills 500 movies + 500 TV shows into ct:stock
    const initialDepot = await initStockEngine('profile-stock', { immediate: true });
    assert.equal(initialDepot.movies.length, STOCK_TARGET_COUNT);
    assert.equal(initialDepot.tv.length, STOCK_TARGET_COUNT);

    // Verify user-lists & ct:surfaced items were strictly excluded
    assert.equal(initialDepot.movies.some((m) => Number(m.id) === 10001 || Number(m.id) === 10002), false);
    assert.equal(initialDepot.tv.some((t) => Number(t.id) === 20001 || Number(t.id) === 20002), false);

    // Adım 12: Adding an item from stock to user-lists deletes it from ct:stock
    const pickedMovie = initialDepot.movies[0];
    const consumeRes = await consumeStockItem(pickedMovie, 'profile-stock');
    assert.equal(consumeRes.removed, true);
    assert.equal(consumeRes.triggeredReplenish, false); // 499 >= 250
    assert.equal(getStockCounts().moviesCount, 499);

    // Adım 13 & 14: Drop movies to 250, then consume 1 more -> 249 (< 250 threshold) triggers autonomous refill back to 500!
    const current = await loadStockIdb();
    current.movies = current.movies.slice(0, STOCK_REPLENISH_THRESHOLD); // exactly 250
    await saveStockIdb(current);
    resetStockEngineForTests();
    setStockTmdbFetcher(async (endpoint, params) => {
      const page = Number(params?.page || 1);
      const isTv = endpoint.includes('tv');
      const base = isTv ? 50000 : 30000;
      const endpointOffset = endpoint.includes('top_rated') ? 2000 : 0;
      const results = Array.from({ length: 20 }, (_, idx) => {
        const id = base + endpointOffset + (page - 1) * 20 + idx + 1;
        return isTv
          ? { id, name: `Yeni Dizi #${id}`, media_type: 'tv', vote_average: 8.0, genre_ids: [18] }
          : { id, title: `Yeni Film #${id}`, media_type: 'movie', vote_average: 8.0, genre_ids: [28] };
      });
      return { page, total_pages: 50, results };
    });

    await initStockEngine('profile-stock', { immediate: true });
    assert.equal(getStockCounts().moviesCount, 250); // 250 is not < 250 yet

    const thresholdDropItem = current.movies[0];
    await saveUserListsIdb('profile-stock', [
      { id: 10001, media_type: 'movie', status: 'completed', personal_rating: 8 },
      { id: thresholdDropItem.id, media_type: 'movie', status: 'watchlist', personal_rating: '' },
    ]);
    const dropRes = await consumeStockItem(thresholdDropItem, 'profile-stock');
    assert.equal(dropRes.removed, true);
    assert.equal(dropRes.triggeredReplenish, true, '249 filme düştüğünde yenileme tetiklenmeli');

    const refilled = await executeStockReplenishment('profile-stock');
    assert.equal(refilled.movies.length, 500);
    assert.equal(refilled.tv.length, 500);
    assert.equal(
      refilled.movies.some((m) => Number(m.id) === Number(thresholdDropItem.id)),
      false,
      'Listeye taşınan öğe yenileme sonrası ct:stock içine geri girmemeli'
    );
  } finally {
    resetStockEngineForTests();
    resetSeriesServiceForTests();
  }
});

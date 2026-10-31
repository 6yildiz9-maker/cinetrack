import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isWithinReleaseWindow,
  isFutureWithinReleaseWindow,
  getDynamicReleaseWindowBounds,
  compareMediaDatesAscending,
} from '../src/utils/release-window.ts';
import {
  saveIsolatedProfileIdb,
  saveUserListsWithStatusIdb,
  saveUserListsIdb,
  saveStockIdb,
  loadStockIdb,
  recordSurfacedKeys,
  loadSurfacedEntries,
  resetIdbMemoryStateForTests,
  recordSkippedKeysIdb,
  getActiveSkippedKeys,
  removeSkippedKeyIdb,
  loadSkipLogIdb,
  SKIP_LOG_MAX_SIZE,
  SKIP_LOG_COOLDOWN_MS,
  saveUiPrefsIdb,
  loadUiPrefsIdb,
  saveActorCreditsIdb,
  loadActorCreditsIdb,
  setForceIdbWriteFailureForTests,
  hasUnpersistedIdbFallback,
  SURFACED_RECYCLE_COOLDOWN_MS,
} from '../src/services/storage-idb.ts';
import {
  initStockEngine,
  seedCandidatePoolFromStock,
  executeStockReplenishment,
  enrichStockItemsTopCast,
  setStockTmdbFetcher,
  resetStockEngineForTests,
} from '../src/services/stock-engine.ts';
import {
  formatSeriesCollectionName,
  getItemSeriesInfo,
  backfillSavedSeriesLazy,
  ensureSeriesCollectionLoaded,
  indexMovieCollection,
  computeUserSeriesUniverses,
  scoreSeriesUniverseGroup,
  setSeriesTmdbFetcher,
  resetSeriesServiceForTests,
} from '../src/services/series-service.ts';
import {
  loadOpenActorCreditsLazy,
  buildMergedActorCreditsWithStock,
  scoreSingleActorMemoized,
} from '../src/services/actor-recommendations-engine.ts';
import {
  SHELF_INITIAL_COUNT,
  MODAL_PAGE_SIZE,
  SCORE_DEBOUNCE_MS,
  sliceShelfItems,
  sliceModalPage,
} from '../src/components/PaginatedMediaModal.tsx';
import {
  loadPersistentPoolData,
  resetCoreIdbMirrorsForTests,
} from '../src/core/cinetrack-core.ts';
import { PersistentDataStore } from '../src/server/persistent-store.ts';
import { createCineTrackApp } from '../src/server/app.ts';

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
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (idx) => Array.from(store.keys())[idx] ?? null,
    get length() {
      return store.size;
    },
  };
}

function resetAllClientTestState() {
  globalThis.indexedDB = createFakeIndexedDB();
  globalThis.localStorage = createFakeLocalStorage();
  resetIdbMemoryStateForTests();
  resetStockEngineForTests();
  resetSeriesServiceForTests();
  resetCoreIdbMirrorsForTests();
}

// =========================================================================
// 1. Dynamic Release Window (FEAT-01 #2 & Section 3.3)
// =========================================================================
test('Dynamic release window accepts <= currentYear + 1, rejects far-future/undated, and rolls forward in 2030 without hardcoded years', () => {
  const now2026 = new Date('2026-06-15T12:00:00Z');
  const bounds2026 = getDynamicReleaseWindowBounds(now2026);
  assert.equal(bounds2026.currentYear, 2026);
  assert.equal(bounds2026.maxYear, 2027);

  assert.equal(isWithinReleaseWindow('1999-03-31', now2026), true);
  assert.equal(isWithinReleaseWindow('2026-11-10', now2026), true);
  assert.equal(isWithinReleaseWindow('2027-12-31', now2026), true);
  assert.equal(isWithinReleaseWindow('2028-01-01', now2026), false);
  assert.equal(isWithinReleaseWindow('2029-05-01', now2026), false);
  assert.equal(isWithinReleaseWindow('', now2026), false);
  assert.equal(isWithinReleaseWindow(null, now2026), false);

  assert.equal(isFutureWithinReleaseWindow('2027-07-01', now2026), true);
  assert.equal(isFutureWithinReleaseWindow('2028-02-01', now2026), false);
  assert.equal(isFutureWithinReleaseWindow('2020-01-01', now2026), false);

  // Simulated system date in 2030: window automatically shifts to [2030, 2031]
  const now2030 = new Date('2030-03-01T00:00:00Z');
  assert.equal(isWithinReleaseWindow('2030-05-01', now2030), true);
  assert.equal(isWithinReleaseWindow('2031-11-20', now2030), true);
  assert.equal(isWithinReleaseWindow('2032-01-01', now2030), false);

  const dates = ['2027-05-01', '', '2000-07-14', '2003-04-30'];
  dates.sort(compareMediaDatesAscending);
  assert.deepEqual(dates, ['2000-07-14', '2003-04-30', '2027-05-01', '']);

  // Verify zero hardcoded 4-digit year literals in release-window & series modules
  const filesToScan = [
    'src/utils/release-window.ts',
    'src/services/series-service.ts',
    'src/services/series-tv-seeds.ts',
  ];
  for (const relPath of filesToScan) {
    const content = fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
    const yearMatches = content.match(/\b20\d{2}\b/g);
    assert.equal(
      yearMatches,
      null,
      `Expected zero hardcoded 20xx literals in ${relPath}, found: ${yearMatches?.join(', ')}`
    );
  }
});

// =========================================================================
// 2. Set C — FEAT-01 (Seriler: Franchise Grouping, Single-Pass Scoring, Lazy Backfill, Demo Banner)
// =========================================================================
test('FEAT-01: X-Men 1 + X-Men 2 produce ONE "X-Men Serisi" group, filter future/undated parts, score ONCE per group, and keep data/catalog untouched', async () => {
  resetAllClientTestState();

  const moviesCatalogPath = path.resolve(process.cwd(), 'data/catalog/movies.json');
  const tvCatalogPath = path.resolve(process.cwd(), 'data/catalog/tv.json');
  const beforeMoviesMtime = fs.existsSync(moviesCatalogPath)
    ? fs.statSync(moviesCatalogPath).mtimeMs
    : 0;
  const beforeTvMtime = fs.existsSync(tvCatalogPath) ? fs.statSync(tvCatalogPath).mtimeMs : 0;

  assert.equal(formatSeriesCollectionName('X-Men Collection'), 'X-Men Serisi');

  const currentYear = new Date().getFullYear();
  const nextYearDate = `${currentYear + 1}-05-20`;
  const farFutureDate = `${currentYear + 3}-08-10`;

  setSeriesTmdbFetcher(async (reqPath) => {
    if (reqPath === '/collection/748') {
      return {
        id: 748,
        name: 'X-Men Collection',
        poster_path: '/xmen-col.jpg',
        parts: [
          { id: 36657, title: 'X-Men', release_date: '2000-07-13', vote_average: 7.0, genre_ids: [28, 878] },
          { id: 36658, title: 'X2', release_date: '2003-04-24', vote_average: 7.4, genre_ids: [28, 878] },
          { id: 36668, title: 'X-Men: The Last Stand', release_date: '2006-05-24', vote_average: 6.4, genre_ids: [28, 878] },
          { id: 49538, title: 'X-Men: First Class', release_date: '2011-06-01', vote_average: 7.3, genre_ids: [28, 878] },
          { id: 999001, title: 'X-Men Next Year', release_date: nextYearDate, vote_average: 7.5, genre_ids: [28, 878] },
          { id: 999002, title: 'X-Men Far Future', release_date: farFutureDate, vote_average: 0, genre_ids: [28, 878] },
          { id: 999003, title: 'X-Men Undated Rumor', release_date: '', vote_average: 0, genre_ids: [28, 878] },
        ],
      };
    }
    return {};
  });

  await indexMovieCollection(748);

  const savedItems = [
    {
      id: 36657,
      media_type: 'movie',
      title: 'X-Men',
      status: 'completed',
      personal_rating: 8,
      belongs_to_collection: { id: 748, name: 'X-Men Collection' },
    },
    {
      id: 36658,
      media_type: 'movie',
      title: 'X2',
      status: 'watchlist',
      personal_rating: '',
      belongs_to_collection: { id: 748, name: 'X-Men Collection' },
    },
  ];

  // Owning 2 items from the same franchise MUST produce a single franchise group
  const universes = computeUserSeriesUniverses(savedItems);
  assert.equal(universes.length, 1);
  assert.equal(universes[0].displayName, 'X-Men Serisi');
  assert.equal(universes[0].userOwnedParts.length, 2);
  // Missing parts: 36668 (2006), 49538 (2011), 999001 (currentYear + 1). Far future & undated excluded!
  assert.deepEqual(
    universes[0].userMissingParts.map((p) => Number(p.id)),
    [36668, 49538, 999001]
  );

  // Mandatory visible series affiliation info for MediaCard + DetailModal
  const cardAffiliation = getItemSeriesInfo({ id: 36668, media_type: 'movie', title: 'X-Men: The Last Stand' });
  assert.equal(cardAffiliation.inSeries, true);
  assert.equal(cardAffiliation.collectionName, 'X-Men Serisi');
  assert.ok((cardAffiliation.collection?.parts.length || 0) >= 5);

  // Single-pass group scoring: scorerFn MUST be called ONCE for the group, NOT once per owned item!
  let scorerCallCount = 0;
  const mockTasteProfile = {
    totalWatched: 2,
    avgPersonalRating: 8,
    genreAffinities: {},
    decadeAffinities: {},
    directorAffinities: {},
    actorAffinities: {},
    keywordAffinities: {},
    preferredMediaType: 'movie',
    ratingGenerosity: 0,
  };
  const scoredItems = scoreSeriesUniverseGroup(universes[0], mockTasteProfile, {
    scorerFn: (candidates) => {
      scorerCallCount += 1;
      return candidates.map((c, idx) => ({ candidate: c, score: 90 - idx * 5 }));
    },
  });
  assert.equal(scorerCallCount, 1);
  assert.equal(scoredItems.length, 3);
  assert.equal(scoredItems[0].collectionName, 'X-Men Serisi');
  assert.equal(scoredItems[0].tasteScore, 90);

  // Verify data/catalog files were never touched
  const afterMoviesMtime = fs.existsSync(moviesCatalogPath)
    ? fs.statSync(moviesCatalogPath).mtimeMs
    : 0;
  const afterTvMtime = fs.existsSync(tvCatalogPath) ? fs.statSync(tvCatalogPath).mtimeMs : 0;
  assert.equal(afterMoviesMtime, beforeMoviesMtime);
  assert.equal(afterTvMtime, beforeTvMtime);
});

test('FEAT-01: Lazy backfill makes 0 calls in demo mode, max 1 call per unchecked item in live mode, and group-lazy collection loading makes 0 calls until opened', async () => {
  resetAllClientTestState();

  const networkLog = [];
  setSeriesTmdbFetcher(async (reqPath) => {
    networkLog.push(reqPath);
    if (reqPath === '/movie/603') {
      return {
        id: 603,
        title: 'The Matrix',
        release_date: '1999-03-30',
        belongs_to_collection: { id: 2344, name: 'The Matrix Collection' },
      };
    }
    if (reqPath === '/movie/550') {
      return {
        id: 550,
        title: 'Fight Club',
        release_date: '1999-10-15',
        belongs_to_collection: null,
      };
    }
    if (reqPath === '/collection/2344') {
      return {
        id: 2344,
        name: 'The Matrix Collection',
        parts: [
          { id: 603, title: 'The Matrix', release_date: '1999-03-30', vote_average: 8.2, genre_ids: [28, 878] },
          { id: 604, title: 'The Matrix Reloaded', release_date: '2003-05-15', vote_average: 7.0, genre_ids: [28, 878] },
        ],
      };
    }
    return {};
  });

  const legacySavedItems = [
    { id: 603, media_type: 'movie', title: 'The Matrix', status: 'completed', personal_rating: 9 },
    { id: 550, media_type: 'movie', title: 'Fight Club', status: 'completed', personal_rating: 9 },
  ];

  // Demo mode: 0 network calls!
  const demoRes = await backfillSavedSeriesLazy(legacySavedItems, { isDemo: true });
  assert.equal(demoRes.skippedDemo, true);
  assert.equal(networkLog.length, 0);

  // Live mode first tab open: checks each unchecked item once (2 calls), 0 calls to /collection/2344 while closed!
  const liveRes1 = await backfillSavedSeriesLazy(legacySavedItems, { isDemo: false });
  assert.equal(liveRes1.skippedDemo, false);
  assert.deepEqual(networkLog.sort(), ['/movie/550', '/movie/603']);

  // Second tab open: 0 network calls because both items are now marked checked/indexed!
  networkLog.length = 0;
  const liveRes2 = await backfillSavedSeriesLazy(legacySavedItems, { isDemo: false });
  assert.equal(liveRes2.networkRequests, 0);
  assert.equal(networkLog.length, 0);

  // Stub franchise group is already visible before opening accordion
  const stubUniverses = computeUserSeriesUniverses(legacySavedItems, { includeStubs: true });
  assert.equal(stubUniverses.length, 1);
  assert.equal(stubUniverses[0].collectionKey, 'collection:movie:2344');
  assert.equal(stubUniverses[0].isStub, true);

  // Opening the Matrix accordion fetches /collection/2344 lazily ONCE
  const loadedCol = await ensureSeriesCollectionLoaded('collection:movie:2344', { isDemo: false });
  assert.equal(loadedCol?.isStub, false);
  assert.equal(loadedCol?.parts.length, 2);
  assert.deepEqual(networkLog, ['/collection/2344']);

  // Re-opening or filtering in-memory makes 0 network calls!
  networkLog.length = 0;
  await ensureSeriesCollectionLoaded('collection:movie:2344', { isDemo: false });
  const fullUniverses = computeUserSeriesUniverses(legacySavedItems);
  const moviesOnly = fullUniverses.filter((u) => u.collection.media_type === 'movie');
  const tvOnly = fullUniverses.filter((u) => u.collection.media_type === 'tv');
  assert.equal(moviesOnly.length, 1);
  assert.equal(tvOnly.length, 0);
  assert.equal(networkLog.length, 0);
});

// =========================================================================
// 3. Set B — BUG-14 (Favori Oyuncular > Öneriler Performance, Depo 12, Stock Cast, 429 Backoff)
// =========================================================================
test('BUG-14: Open-only lazy credits (Depo 12, 7d TTL), stock topCastIds 0-network match, 50-actor <50ms memoized scoring, 429 backoff, and 24/40 pagination', async () => {
  resetAllClientTestState();

  const actors = Array.from({ length: 50 }, (_, i) => ({
    id: 1000 + i,
    name: `Actor ${i + 1}`,
    count: 3,
    character: 'Lead',
    profile_path: null,
  }));

  let networkCalls = 0;
  const mockFetcher = async (reqPath) => {
    networkCalls += 1;
    const match = reqPath.match(/\/person\/(\d+)\/combined_credits/);
    const actorId = Number(match?.[1] || 0);
    return {
      cast: Array.from({ length: 30 }, (_, idx) => ({
        id: actorId * 100 + idx,
        media_type: idx % 2 === 0 ? 'movie' : 'tv',
        title: `Film ${actorId}-${idx}`,
        name: `Show ${actorId}-${idx}`,
        release_date: '2022-05-10',
        first_air_date: '2022-05-10',
        vote_average: 7.8,
        vote_count: 500,
        popularity: 45,
        genre_ids: [18, 53],
        order: idx % 5,
      })),
    };
  };

  // Cold open: only first 3 accordions are open -> max 3 network requests (47 closed actors make 0 calls!)
  const openIds = new Set([1000, 1001, 1002]);
  const coldRes = await loadOpenActorCreditsLazy({
    actors,
    openAccordionIds: openIds,
    fetchTmdbFn: mockFetcher,
    nowMs: 1_700_000_000_000,
  });
  assert.equal(networkCalls, 3);
  assert.equal(coldRes.networkFetchedIds.length, 3);
  assert.equal(Object.keys(coldRes.creditsMap).length, 3);

  // Warm cache in new session (< 7 days): 0 network calls and < 100ms!
  networkCalls = 0;
  const t0Warm = performance.now();
  const warmRes = await loadOpenActorCreditsLazy({
    actors,
    openAccordionIds: openIds,
    fetchTmdbFn: mockFetcher,
    nowMs: 1_700_000_000_000 + 2 * 24 * 60 * 60 * 1000,
  });
  const warmElapsedMs = performance.now() - t0Warm;
  assert.equal(networkCalls, 0);
  assert.equal(warmRes.cacheHitIds.length, 3);
  assert.ok(warmElapsedMs < 100, `Expected warm IDB hit < 100ms, took ${warmElapsedMs.toFixed(1)}ms`);

  // Stock topCastIds match with 0 network calls for open actor 1005
  await saveStockIdb({
    movies: [
      {
        id: 88801,
        media_type: 'movie',
        title: 'Stock Match Movie',
        release_date: '2024-04-01',
        vote_average: 8.1,
        vote_count: 900,
        genre_ids: [28],
      },
    ],
    tv: [],
    updatedAt: new Date().toISOString(),
  });
  await enrichStockItemsTopCast({ 'movie:88801': [1005, 2001, 2002, 2003] });
  const mergedWithStock = buildMergedActorCreditsWithStock(actors[5], undefined);
  assert.equal(mergedWithStock.length, 1);
  assert.equal(mergedWithStock[0].id, 88801);
  assert.equal(networkCalls, 0);

  // 50 actors memoized scoring: initial populate + warm memo / single-actor delta < 50ms
  const memoMap = new Map();
  const allCredits = {};
  for (const actor of actors) {
    allCredits[actor.id] = [
      {
        id: actor.id * 10 + 1,
        media_type: 'movie',
        title: `Title ${actor.id}`,
        release_date: '2021-01-01',
        vote_average: 7.9,
        vote_count: 600,
        popularity: 50,
        genre_ids: [18],
        order: 0,
      },
    ];
    scoreSingleActorMemoized(actor, allCredits[actor.id], memoMap, {
      savedItems: [],
      dislikedKeys: [],
      genresMap: { 18: 'Dram', 53: 'Gerilim' },
      preferredProviders: [],
      providerIndex: {},
      selectedType: 'all',
      selectedGenre: '',
      selectedSort: 'popular',
      enableDiversity: true,
    });
  }

  const t0Score = performance.now();
  for (const actor of actors) {
    const res = scoreSingleActorMemoized(actor, allCredits[actor.id], memoMap, {
      savedItems: [],
      dislikedKeys: [],
      genresMap: { 18: 'Dram', 53: 'Gerilim' },
      preferredProviders: [],
      providerIndex: {},
      selectedType: 'all',
      selectedGenre: '',
      selectedSort: 'popular',
      enableDiversity: true,
    });
    assert.equal(res.length, 1);
  }
  const memoScoreMs = performance.now() - t0Score;
  assert.ok(memoScoreMs < 50, `Expected 50-actor memoized pass < 50ms, took ${memoScoreMs.toFixed(2)}ms`);

  // Force refresh hitting HTTP 429: exponential backoff + preserves cached credits + Turkish warning!
  const backoffDelays = [];
  const rateLimitRes = await loadOpenActorCreditsLazy({
    actors: [actors[0]],
    openAccordionIds: [1000],
    force: true,
    baseBackoffMs: 350,
    maxRetriesOnRateLimit: 2,
    sleepFn: async (ms) => {
      backoffDelays.push(ms);
    },
    fetchTmdbFn: async () => {
      const err = new Error('TMDB 429 Too Many Requests');
      err.status = 429;
      throw err;
    },
    nowMs: 1_700_000_000_000 + 3 * 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(backoffDelays, [350, 700]);
  assert.equal(rateLimitRes.rateLimited, true);
  assert.ok(rateLimitRes.rateLimitWarning && rateLimitRes.rateLimitWarning.includes('önbellekteki veriler korundu'));
  assert.equal(rateLimitRes.creditsMap[1000].length, 30);

  // Shared shelf (24) & modal (40) pagination constants and slicers
  assert.equal(SHELF_INITIAL_COUNT, 24);
  assert.equal(MODAL_PAGE_SIZE, 40);
  assert.equal(SCORE_DEBOUNCE_MS, 300);
  const ninetyFiveItems = Array.from({ length: 95 }, (_, idx) => ({ id: idx + 1 }));
  const shelfSlice = sliceShelfItems(ninetyFiveItems);
  assert.equal(shelfSlice.visible.length, 24);
  assert.equal(shelfSlice.remaining, 71);
  const page1 = sliceModalPage(ninetyFiveItems, 1);
  const page3 = sliceModalPage(ninetyFiveItems, 3);
  assert.equal(page1.items.length, 40);
  assert.equal(page1.totalPages, 3);
  assert.equal(page3.items.length, 15);
});

// =========================================================================
// 4. Set A — FEAT-02 (Primary ct:stock Discover Pool, 7d FIFO Recycle, Depots 9 & 10, Universal Quota)
// =========================================================================
test('FEAT-02: ct:stock seeds Discover pool excluding ct:skip-log, and recycles expired ct:surfaced FIFO items when fresh upstream runs short', async () => {
  resetAllClientTestState();

  const profileId = 'default';
  const baseNow = 1_750_000_000_000;

  // Record skip-log (Depo 9) with cap & 7-day cooldown
  await recordSkippedKeysIdb(profileId, ['movie:502'], { nowMs: baseNow });
  const activeSkips = await getActiveSkippedKeys(profileId, SKIP_LOG_COOLDOWN_MS, baseNow + 1000);
  assert.equal(activeSkips.has('movie:502'), true);

  await saveStockIdb({
    movies: [
      { id: 501, media_type: 'movie', title: 'Stock Movie 1', release_date: '2023-01-10', vote_average: 7.7, vote_count: 400, genre_ids: [28] },
      { id: 502, media_type: 'movie', title: 'Skipped Stock Movie', release_date: '2023-02-10', vote_average: 7.5, vote_count: 400, genre_ids: [28] },
    ],
    tv: [],
    updatedAt: new Date(baseNow).toISOString(),
  });

  const addedToPool = await seedCandidatePoolFromStock(
    profileId,
    'movie',
    [],
    {
      disliked: [],
      hidden: [],
      providers: [],
      mood: '',
      reminders: true,
      notified: [],
    },
    { nowMs: baseNow + 1000 }
  );
  assert.equal(addedToPool, 1);
  const poolAfterSeed = loadPersistentPoolData(profileId, 'movie');
  assert.equal(poolAfterSeed.items.some((it) => it.id === 501), true);
  assert.equal(poolAfterSeed.items.some((it) => it.id === 502), false);

  // Removing from skip-log when user later adds item to list
  await removeSkippedKeyIdb(profileId, 'movie:502');
  const skipsAfterSave = await getActiveSkippedKeys(profileId, SKIP_LOG_COOLDOWN_MS, baseNow + 1000);
  assert.equal(skipsAfterSave.has('movie:502'), false);

  // Enforce SKIP_LOG_MAX_SIZE = 500
  const manySkipKeys = Array.from({ length: 530 }, (_, i) => `movie:${9000 + i}`);
  const cappedSkipRes = await recordSkippedKeysIdb(profileId, manySkipKeys, { nowMs: baseNow });
  assert.equal(cappedSkipRes.entries.length, SKIP_LOG_MAX_SIZE);
  const persistedSkips = await loadSkipLogIdb(profileId);
  assert.equal(persistedSkips.length, SKIP_LOG_MAX_SIZE);

  // Depo 10: ct:ui-prefs round-trip persistence
  await saveUiPrefsIdb({
    profileId,
    selectedType: 'tv',
    selectedSort: 'rating',
    selectedGenre: '18',
    hideListedItems: true,
    forYouSubTab: 'series',
    updatedAt: new Date(baseNow).toISOString(),
  });
  const loadedPrefs = await loadUiPrefsIdb(profileId);
  assert.equal(loadedPrefs?.selectedType, 'tv');
  assert.equal(loadedPrefs?.selectedSort, 'rating');
  assert.equal(loadedPrefs?.selectedGenre, '18');
  assert.equal(loadedPrefs?.hideListedItems, true);
  assert.equal(loadedPrefs?.forYouSubTab, 'series');

  // Halka-dönüşü (Recycle):
  // - movie:7001 surfaced 10 days ago (expired cooldown -> ELIGIBLE to recycle!)
  // - movie:7002 surfaced 10 days ago BUT is in user-lists -> MUST NEVER recycle!
  // - movie:7003 surfaced 10 days ago BUT is in disliked -> MUST NEVER recycle!
  // - movie:7004 surfaced 2 days ago (active cooldown -> MUST NOT recycle!)
  resetAllClientTestState();
  const tenDaysAgo = baseNow - 10 * 24 * 60 * 60 * 1000;
  const twoDaysAgo = baseNow - 2 * 24 * 60 * 60 * 1000;

  await recordSurfacedKeys(['movie:7001', 'movie:7002', 'movie:7003'], 1000, tenDaysAgo);
  await recordSurfacedKeys(['movie:7004'], 1000, twoDaysAgo);
  await saveUserListsIdb(profileId, [{ id: 7002, media_type: 'movie', status: 'completed', personal_rating: 8 }]);
  await saveIsolatedProfileIdb({
    profileId,
    updatedAt: new Date(baseNow).toISOString(),
    preferences: { disliked: ['movie:7003'], hidden: [] },
  });

  // Upstream only has 1 fresh movie (7999) + the surfaced candidates -> forces Halka-dönüşü recycle!
  setStockTmdbFetcher(async (reqPath) => {
    if (reqPath.includes('movie')) {
      return {
        page: 1,
        total_pages: 1,
        results: [
          { id: 7999, title: 'Fresh Movie', release_date: '2024-01-01', vote_average: 8.0, genre_ids: [18] },
          { id: 7001, title: 'Recycled Expired Movie', release_date: '2021-06-01', vote_average: 7.9, genre_ids: [18] },
          { id: 7002, title: 'Already Watched Movie', release_date: '2021-06-01', vote_average: 7.9, genre_ids: [18] },
          { id: 7003, title: 'Disliked Movie', release_date: '2021-06-01', vote_average: 7.9, genre_ids: [18] },
          { id: 7004, title: 'Recent Cooldown Movie', release_date: '2021-06-01', vote_average: 7.9, genre_ids: [18] },
        ],
      };
    }
    return { page: 1, total_pages: 1, results: [] };
  });

  await initStockEngine(profileId, { immediate: false });
  const replenished = await executeStockReplenishment(profileId, {
    recycleCooldownMs: SURFACED_RECYCLE_COOLDOWN_MS,
    nowMs: baseNow,
  });

  const replenishedMovieIds = replenished.movies.map((m) => Number(m.id));
  assert.ok(replenishedMovieIds.includes(7999), 'Fresh movie must be added first');
  assert.ok(replenishedMovieIds.includes(7001), 'Expired ct:surfaced movie must be recycled when fresh runs short');
  assert.equal(replenishedMovieIds.includes(7002), false, 'User-listed movie must never recycle');
  assert.equal(replenishedMovieIds.includes(7003), false, 'Disliked movie must never recycle');
  assert.equal(replenishedMovieIds.includes(7004), false, 'Active-cooldown surfaced movie must not recycle');

  const remainingSurfaced = await loadSurfacedEntries();
  assert.equal(remainingSurfaced.some((e) => e.key === 'movie:7001'), false);
});

test('FEAT-02 Quota Discipline: simulated IndexedDB QuotaExceededError across all depots resolves safely with { persisted: false } and surfaces warning state', async () => {
  resetAllClientTestState();
  assert.equal(hasUnpersistedIdbFallback(), false);

  setForceIdbWriteFailureForTests(true);
  try {
    const rProfile = await saveIsolatedProfileIdb({
      profileId: 'default',
      updatedAt: new Date().toISOString(),
      preferences: { disliked: [], hidden: [] },
    });
    const rLists = await saveUserListsWithStatusIdb('default', [
      { id: 101, media_type: 'movie', status: 'watchlist', personal_rating: '' },
    ]);
    const rStock = await saveStockIdb({ movies: [], tv: [], updatedAt: '' });
    const rSkip = await recordSkippedKeysIdb('default', ['movie:202']);
    const rUi = await saveUiPrefsIdb({
      profileId: 'default',
      selectedType: 'all',
      selectedSort: 'popular',
      selectedGenre: '',
      hideListedItems: false,
      forYouSubTab: 'recommendations',
      updatedAt: '',
    });
    const rActor = await saveActorCreditsIdb(500, [], {
      actorId: 500,
      actorName: 'Test Actor',
      status: 'empty',
      creditsCount: 0,
      updatedAt: Date.now(),
    });

    assert.equal(rProfile.persisted, false);
    assert.equal(rLists.persisted, false);
    assert.equal(rStock.persisted, false);
    assert.equal(rSkip.persisted, false);
    assert.equal(rUi.persisted, false);
    assert.equal(rActor.persisted, false);
    assert.equal(hasUnpersistedIdbFallback(), true);

    // In-memory session fallback remains readable without crashing UI
    const memStock = await loadStockIdb();
    assert.deepEqual(memStock.movies, []);
    const memActor = await loadActorCreditsIdb(500);
    assert.ok(memActor);
  } finally {
    setForceIdbWriteFailureForTests(false);
  }
});

// =========================================================================
// 5. Set D & BUG-11 (Async I/O Residuals, CSP Header, .env.example, GitHub Sync Doc, <1,000 Lines)
// =========================================================================
test('Set D & BUG-11: no sync file writes on hot paths, CSP worker-src/manifest-src present, .env.example & sync docs updated, modular files < 1,000 lines', async () => {
  const storageSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/server/storage.ts'), 'utf8');
  assert.equal(storageSrc.includes('copyFileSync'), false);

  const excelSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/server/excel-profile-backup.ts'),
    'utf8'
  );
  assert.equal(excelSrc.includes('writeFileSync'), false);

  const envExample = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
  assert.match(envExample, /^CINETRACK_TOKEN=$/m);
  assert.match(envExample, /^CINETRACK_TMDB_RATE_LIMIT=$/m);

  const ghSyncSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/server/github-bidirectional-sync.ts'),
    'utf8'
  );
  assert.ok(ghSyncSrc.includes('CINETRACK_ALLOW_PUBLIC_CATALOG_SYNC=true'));

  // BUG-11: Every newly created / refactored module must be strictly < 1,000 lines
  const modularFiles = [
    'src/utils/release-window.ts',
    'src/services/client-depots.ts',
    'src/services/storage-idb.ts',
    'src/services/stock-engine.ts',
    'src/services/series-tv-seeds.ts',
    'src/services/series-service.ts',
    'src/services/actor-recommendations-engine.ts',
    'src/components/PaginatedMediaModal.tsx',
    'src/components/ActorRecommendationsSection.tsx',
    'src/components/SeriesRecommendationsSection.tsx',
  ];
  for (const rel of modularFiles) {
    const lines = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8').split('\n').length;
    assert.ok(lines < 1000, `Expected ${rel} to be < 1,000 lines (BUG-11), got ${lines} lines`);
  }

  // BUG-12 & BUG-04: Verify /api/health returns CSP with worker-src & manifest-src and async posterCache stats
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinetrack-v2-csp-'));
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

  try {
    const addr = server.address();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("worker-src 'self' blob:"), `Missing worker-src in CSP: ${csp}`);
    assert.ok(csp.includes("manifest-src 'self'"), `Missing manifest-src in CSP: ${csp}`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.posterCache && typeof body.posterCache.count === 'number');
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

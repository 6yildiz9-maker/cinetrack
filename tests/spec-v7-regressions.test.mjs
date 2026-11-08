import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ENCODING_LAYOUT_VERSION,
  DENSE_VECTOR_DIM,
  encodeItemContent,
  computeItemContentSignature,
  cosineSimilarity,
  computeProfileCentroid,
} from '../src/core/encoding.ts';
import {
  getItemEncoding,
  maintainEncodingsDepot,
  resetEncodingServiceForTests,
  makeEncodingStorageKey,
} from '../src/services/encoding-service.ts';
import {
  saveStoredEncodingIdb,
  getAllStoredEncodingsIdb,
  resetClientDepotsForTests,
} from '../src/services/client-depots.ts';
import {
  RELATIONSHIP_GRAPH_SCHEMA_VERSION,
  RELATIONSHIP_MODEL_VERSION,
  computeRelationshipProfileSignature,
  buildRelationshipGraph,
} from '../src/core/relationship-explorer.ts';
import {
  RELATIONSHIP_CACHE_DB_VERSION,
  writeRelationshipCache,
  readRelationshipCache,
} from '../src/services/relationship-cache.ts';
import {
  SCHEMA_VERSION,
  IDB_DEPOT_SCHEMA_VERSIONS,
  runIdbSchemaMigrationsOnce,
  resetDerivedCachesPreserveProfileAndStock,
  readStoredDepotSchemaVersions,
  resetSchemaMigrationStateForTests,
} from '../src/services/idb-schema-version.ts';
import {
  saveStockIdb,
  loadStockIdb,
  recordSurfacedKeys,
  saveUserListsIdb,
  saveIsolatedProfileIdb,
  resetIdbMemoryStateForTests,
} from '../src/services/storage-idb.ts';
import {
  initStockEngine,
  executeStockReplenishment,
  manualPullStock,
  setStockTmdbFetcher,
  resetStockEngineForTests,
} from '../src/services/stock-engine.ts';
import { renderRelationshipCanvasNode } from '../src/components/RelationshipCanvas.ts';
import { ErrorBoundary } from '../src/components/ErrorBoundary.tsx';
import {
  runPosterHydrationPass,
  applyPosterPatchesToSavedItems,
  collectPosterHydrationCandidates,
  getPosterHydrationQuotaState,
  resetPosterHydrationForTests,
} from '../src/services/poster-hydration-service.ts';
import {
  runStockPosterHydrationPass,
  applyStockPosterPatchesToDepot,
  getStockPosterHydrationQuotaState,
  resetStockPosterHydrationForTests,
} from '../src/services/stock-poster-hydration-service.ts';
import {
  buildStockPosterCandidates,
  sanitizeStockPosterDepot,
  hasUsableStockPoster,
  applyStockPosterPatchesToItems,
  pickStockSearchMatch,
} from '../src/services/stock-poster-utils.ts';
import {
  ALLOWED_TMDB_PATH,
  ALLOWED_TMDB_QUERY_KEYS,
  validateTmdbParam,
} from '../src/server/tmdb-proxy.ts';
import {
  filterHiddenUserRegisteredItems,
  isMediaRegisteredInUserProfile,
} from '../src/core/cinetrack-core.ts';
import {
  updateStockItemsMetadata,
} from '../src/services/stock-engine.ts';
import { exportItemsToCsv, importItemsFromCsv } from '../src/core/exporters.ts';
import { mergeSavedItemListsLossless } from '../src/core/user-data-merge.ts';

function createFakeIndexedDB() {
  const databases = new Map();

  function makeRequest(executor) {
    const req = {
      result: undefined,
      error: null,
      transaction: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    };
    setImmediate(() => executor(req));
    return req;
  }

  return {
    open(dbName, requestedVersion = 1) {
      return makeRequest((req) => {
        let dbEntry = databases.get(dbName);
        const oldVersion = dbEntry ? dbEntry.version : 0;
        const needsUpgrade = !dbEntry || requestedVersion > oldVersion;
        if (!dbEntry) {
          dbEntry = { version: requestedVersion, stores: new Map() };
          databases.set(dbName, dbEntry);
        } else if (needsUpgrade) {
          dbEntry.version = requestedVersion;
        }

        const makeTx = () => {
          const tx = {
            oncomplete: null,
            onabort: null,
            onerror: null,
            error: null,
            objectStore(storeName) {
              if (!dbEntry.stores.has(storeName)) {
                dbEntry.stores.set(storeName, new Map());
              }
              const map = dbEntry.stores.get(storeName);
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
                put(val, explicitKey) {
                  const key = explicitKey !== undefined ? explicitKey : val?.key;
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
                openCursor() {
                  const entries = Array.from(map.entries());
                  let idx = 0;
                  const r = { result: null, onsuccess: null, onerror: null };
                  const advance = () => {
                    if (idx < entries.length) {
                      const [key, value] = entries[idx++];
                      r.result = { key, value, continue: () => setImmediate(advance) };
                    } else {
                      r.result = null;
                    }
                    r.onsuccess?.({ target: r });
                    if (!r.result) {
                      tx.oncomplete?.({ target: tx });
                    }
                  };
                  setImmediate(advance);
                  return r;
                },
              };
            },
          };
          return tx;
        };

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
          transaction() {
            return makeTx();
          },
          close() {},
        };

        req.result = db;
        if (needsUpgrade && typeof req.onupgradeneeded === 'function') {
          req.transaction = makeTx();
          req.onupgradeneeded({ oldVersion, newVersion: requestedVersion, target: req });
          req.transaction = null;
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

function setupCleanTestEnv() {
  globalThis.indexedDB = createFakeIndexedDB();
  globalThis.localStorage = createFakeLocalStorage();
  resetClientDepotsForTests();
  resetEncodingServiceForTests();
  resetIdbMemoryStateForTests();
  resetStockEngineForTests();
  resetSchemaMigrationStateForTests();
}

test('REG-02 + REG-03 + IMP-17: ENCODING_LAYOUT_VERSION=2 prevents 47->48 dim NaN crash, prunes legacy vectors, and resets derived caches without touching ct:stock', async () => {
  setupCleanTestEnv();

  assert.equal(ENCODING_LAYOUT_VERSION, 2);
  assert.equal(DENSE_VECTOR_DIM, 48);
  assert.equal(RELATIONSHIP_MODEL_VERSION, 'relationship-v3');
  assert.equal(RELATIONSHIP_GRAPH_SCHEMA_VERSION, 2);
  assert.equal(RELATIONSHIP_CACHE_DB_VERSION, 2);
  assert.equal(SCHEMA_VERSION, 2);
  assert.equal(IDB_DEPOT_SCHEMA_VERSIONS.ct_encodings, 2);
  assert.equal(IDB_DEPOT_SCHEMA_VERSIONS.ct_relationship_cache, 2);

  // 1. Fresh encoding embeds layoutVersion=2 and 48 finite dimensions
  const item = {
    id: 603,
    media_type: 'movie',
    title: 'The Matrix',
    overview: 'Siber gerçeklik ve yapay zeka direnişi.',
    genre_ids: [28, 878],
    release_date: '1999-03-30',
    vote_average: 8.7,
    vote_count: 25000,
  };
  const encoded = encodeItemContent(item);
  assert.equal(encoded.layoutVersion, 2);
  assert.equal(encoded.denseVector.length, 48);
  assert.ok(encoded.denseVector.every((v) => Number.isFinite(v)));

  const sig = computeItemContentSignature(item);
  const storageKey = makeEncodingStorageKey(item, sig);
  assert.ok(storageKey.startsWith('v2:movie:603:'));

  // 2. Mixing a legacy 47-dim vector and a new 48-dim vector NEVER produces NaN in centroid or cosineSimilarity
  const legacy47Vector = encoded.denseVector.slice(0, 47);
  const centroid = computeProfileCentroid([
    { encoding: { ...encoded, denseVector: legacy47Vector, layoutVersion: 1 }, personal_rating: 9 },
    { encoding: encoded, personal_rating: 8 },
  ]);
  assert.equal(centroid.length, 48);
  assert.ok(centroid.every((v) => Number.isFinite(v)), 'Centroid must never contain NaN');

  const simMixed = cosineSimilarity(centroid, legacy47Vector);
  assert.ok(Number.isFinite(simMixed), 'cosineSimilarity with legacy 47-dim vector must be finite');
  const simWithNaN = cosineSimilarity([NaN, 0.5, 0.5], [0.5, 0.5, 0.5]);
  assert.equal(Number.isFinite(simWithNaN), true);

  // 3. maintainEncodingsDepot prunes legacy 47-dim records while keeping valid v2 48-dim records
  await saveStoredEncodingIdb('legacy:movie:999:oldsig', {
    ...encoded,
    id: 999,
    layoutVersion: 1,
    denseVector: legacy47Vector,
  });
  const freshStored = await getItemEncoding(item);
  assert.equal(freshStored.denseVector.length, 48);

  const maint = await maintainEncodingsDepot();
  assert.ok(maint.prunedStaleSignatures >= 1, 'Legacy 47-dim encoding must be pruned');
  const remainingEncs = await getAllStoredEncodingsIdb();
  assert.equal(remainingEncs.some(([k]) => k === 'legacy:movie:999:oldsig'), false);
  assert.equal(remainingEncs.some(([k]) => k.startsWith('v2:movie:603:')), true);

  // 4. IMP-17 & REG-03: Migration + Manual Cache Reset clear ct:encodings & relationship-cache WITHOUT touching ct:stock!
  await saveStockIdb({
    movies: [{ id: 27205, media_type: 'movie', title: 'Inception', release_date: '2010-07-15' }],
    tv: [{ id: 1396, media_type: 'tv', name: 'Breaking Bad', first_air_date: '2008-01-20' }],
    updatedAt: '2026-06-01T00:00:00.000Z',
  });
  await writeRelationshipCache('graphs', 'latest:profile-default:taste-map', { dummy: true });
  assert.ok(await readRelationshipCache('graphs', 'latest:profile-default:taste-map'));

  const migReport = await runIdbSchemaMigrationsOnce();
  assert.equal(migReport.schemaVersion, 2);
  assert.deepEqual(migReport.migratedDepots, ['ct_encodings', 'ct_relationship_cache']);
  assert.equal(readStoredDepotSchemaVersions().ct_encodings, 2);

  // Re-populate caches and test manual REG-03 reset button handler
  await getItemEncoding(item);
  await writeRelationshipCache('graphs', 'latest:profile-default:relationships', { dummy: 2 });

  const resetReport = await resetDerivedCachesPreserveProfileAndStock();
  assert.equal(resetReport.ok, true);
  assert.equal((await getAllStoredEncodingsIdb()).length, 0, 'ct:encodings must be empty after reset');
  assert.equal(
    await readRelationshipCache('graphs', 'latest:profile-default:relationships'),
    null,
    'cinetrack-relationship-cache must be empty after reset'
  );

  // Verify ct:stock was 100% preserved!
  const preservedStock = await loadStockIdb();
  assert.equal(preservedStock.movies.length, 1);
  assert.equal(preservedStock.movies[0].id, 27205);
  assert.equal(preservedStock.tv.length, 1);
  assert.equal(preservedStock.tv[0].id, 1396);

  // 5. Relationship graph & canvas guard never throw on edge-case inputs
  const graph = buildRelationshipGraph({
    mode: 'taste-map',
    profileId: 'profile-default',
    savedItems: [{ ...item, status: 'completed', personal_rating: 9 }],
    candidates: [
      {
        id: 27205,
        media_type: 'movie',
        title: 'Inception',
        overview: 'Rüya katmanlarında bilinçaltı sızma operasyonu.',
        genre_ids: [28, 878],
        release_date: '2010-07-15',
        vote_average: 8.4,
        vote_count: 34000,
      },
    ],
    preferences: { disliked: [], hidden: [], providers: [], mood: '', reminders: false, notified: [] },
    mediaFilter: 'all',
  });
  assert.ok(graph.nodes.length >= 2);

  const arcCalls = [];
  const mockCtx = {
    beginPath() {},
    arc(x, y, r) {
      arcCalls.push({ x, y, r });
    },
    fill() {},
    save() {},
    restore() {},
    setLineDash() {},
    stroke() {},
    fillText() {},
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'middle',
  };
  renderRelationshipCanvasNode(
    { id: 'movie:603', label: 'Matrix', title: 'Matrix', mediaType: 'movie', kind: 'saved', personalScore: NaN, x: NaN, y: Infinity },
    mockCtx,
    1
  );
  assert.equal(arcCalls.length, 1);
  assert.ok(Number.isFinite(arcCalls[0].x) && Number.isFinite(arcCalls[0].y) && arcCalls[0].r > 0);

  const profSig = computeRelationshipProfileSignature({
    profileId: 'profile-default',
    mediaFilter: 'all',
    savedItems: [{ ...item, status: 'completed', personal_rating: 9 }],
    preferences: { disliked: [], hidden: [], providers: [], mood: '', reminders: false, notified: [] },
  });
  assert.ok(profSig.startsWith('profile-default:all:'));
});

test('REG-01: ct:stock items are never self-purged when surfaced, and Demo/constrained catalog starvation populates stock instead of 0/0', async () => {
  setupCleanTestEnv();
  const profileId = 'profile-default';
  const nowMs = Date.now();

  // 1. Seed existing stock items and mark them as recently surfaced (e.g. user viewed Trendler)
  await saveStockIdb({
    movies: [
      { id: 101, media_type: 'movie', title: 'Existing Stock Movie', release_date: '2022-05-01', vote_average: 7.8, genre_ids: [18] },
      { id: 102, media_type: 'movie', title: 'User Saved Movie', release_date: '2022-06-01', vote_average: 8.1, genre_ids: [18] },
    ],
    tv: [
      { id: 201, media_type: 'tv', name: 'Existing Stock TV', first_air_date: '2022-05-01', vote_average: 8.2, genre_ids: [18] },
    ],
    updatedAt: new Date(nowMs - 60_000).toISOString(),
  });
  await recordSurfacedKeys(['movie:101', 'tv:201'], 1000, nowMs - 10_000);
  await saveUserListsIdb(profileId, [
    { id: 102, media_type: 'movie', status: 'watchlist', personal_rating: '' },
  ]);
  await saveIsolatedProfileIdb({
    profileId,
    updatedAt: new Date(nowMs).toISOString(),
    preferences: { disliked: [], hidden: [] },
  });

  setStockTmdbFetcher(async () => ({ page: 1, total_pages: 1, results: [] }));
  await initStockEngine(profileId, { immediate: false });
  const afterPurgeCheck = await executeStockReplenishment(profileId, { nowMs });

  // movie:102 was saved -> must be purged; movie:101 & tv:201 were only surfaced -> MUST remain in stock!
  assert.deepEqual(afterPurgeCheck.movies.map((m) => Number(m.id)), [101]);
  assert.deepEqual(afterPurgeCheck.tv.map((t) => Number(t.id)), [201]);

  // 2. Demo / Constrained Catalog Starvation Scenario:
  // Suppose ct:stock starts at 0/0 and ALL 3 demo movies/TV items were already surfaced on Trending 5 seconds ago.
  setupCleanTestEnv();
  await recordSurfacedKeys(['movie:301', 'movie:302', 'movie:303', 'tv:401', 'tv:402'], 1000, nowMs - 5_000);
  await saveUserListsIdb(profileId, [
    { id: 303, media_type: 'movie', status: 'completed', personal_rating: 9 },
  ]);
  await saveIsolatedProfileIdb({
    profileId,
    updatedAt: new Date(nowMs).toISOString(),
    preferences: { disliked: ['tv:402'], hidden: [] },
  });

  setStockTmdbFetcher(async (reqPath) => {
    if (reqPath.includes('movie')) {
      return {
        page: 1,
        total_pages: 1,
        results: [
          { id: 301, title: 'Demo Movie A', release_date: '2023-03-10', vote_average: 7.7, genre_ids: [28] },
          { id: 302, title: 'Demo Movie B', release_date: '2021-11-20', vote_average: 8.0, genre_ids: [18] },
          { id: 303, title: 'Saved Demo Movie', release_date: '2020-01-15', vote_average: 8.5, genre_ids: [18] },
        ],
      };
    }
    return {
      page: 1,
      total_pages: 1,
      results: [
        { id: 401, name: 'Demo TV A', first_air_date: '2022-09-01', vote_average: 8.3, genre_ids: [18] },
        { id: 402, name: 'Disliked Demo TV', first_air_date: '2021-04-01', vote_average: 7.2, genre_ids: [18] },
      ],
    };
  });

  await initStockEngine(profileId, { immediate: false });
  const demoFilled = await executeStockReplenishment(profileId, { nowMs });
  assert.deepEqual(
    demoFilled.movies.map((m) => Number(m.id)).sort((a, b) => a - b),
    [301, 302],
    'Constrained/Demo catalog must populate non-saved movies instead of starving at 0'
  );
  assert.deepEqual(
    demoFilled.tv.map((t) => Number(t.id)),
    [401],
    'Constrained/Demo catalog must populate non-disliked TV items instead of starving at 0'
  );
});

test('REG-04: Supabase cloud database package, repositories, migrations, and server branches are completely removed', () => {
  const root = process.cwd();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.equal(pkg.dependencies?.['@supabase/supabase-js'], undefined);
  assert.equal(pkg.devDependencies?.['@supabase/supabase-js'], undefined);

  assert.equal(fs.existsSync(path.join(root, 'src/server/user-data-repository.ts')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/server/catalog-repository.ts')), false);
  assert.equal(fs.existsSync(path.join(root, 'supabase')), false);

  const serverSrc = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
  const storageSrc = fs.readFileSync(path.join(root, 'src/server/storage.ts'), 'utf8');
  assert.equal(/supabase|UserDataRepository|CatalogRepository/i.test(serverSrc), false);
  assert.equal(/supabase|UserDataRepository|CatalogRepository/i.test(storageSrc), false);
});

test('IMP-18 + IMP-19 + BUG-11: ErrorBoundary diagnostic recovery, empty-state guides, Vite manualChunks safety, and <1,000-line ceiling', () => {
  const root = process.cwd();

  // IMP-18: ErrorBoundary state derivation & Turkish recovery actions
  const sampleErr = new Error('NaN coordinate in ForceGraph2D');
  sampleErr.name = 'TypeError';
  const derived = ErrorBoundary.getDerivedStateFromError(sampleErr);
  assert.equal(derived.hasError, true);
  assert.equal(derived.errorName, 'TypeError');
  assert.equal(derived.errorMessage, 'NaN coordinate in ForceGraph2D');

  const ebSrc = fs.readFileSync(path.join(root, 'src/components/ErrorBoundary.tsx'), 'utf8');
  assert.ok(ebSrc.includes('Tekrar dene'));
  assert.ok(ebSrc.includes('Hata metnini kopyala'));
  assert.ok(ebSrc.includes('Önbellekleri sıfırla ve dene'));

  // IMP-19: Empty-state guides in MediaGrid, TasteMapView, RelationshipExplorer, and REG-03 in ProfileModal
  const mediaGridSrc = fs.readFileSync(path.join(root, 'src/components/MediaGrid.tsx'), 'utf8');
  assert.ok(mediaGridSrc.includes('Stok havuzunu indir'));
  assert.ok(mediaGridSrc.includes('Stok İçerik Çek'));
  assert.ok(mediaGridSrc.includes('İzleme listen henüz boş — ilk içeriğini ekle'));

  const stockHealthSrc = fs.readFileSync(path.join(root, 'src/components/StockHealthPanel.tsx'), 'utf8');
  assert.ok(stockHealthSrc.includes('Stok İçerik Çek'));

  const tasteViewSrc = fs.readFileSync(path.join(root, 'src/components/TasteMapView.tsx'), 'utf8');
  assert.ok(tasteViewSrc.includes('Harita hazırlanıyor…'));

  const relExpSrc = fs.readFileSync(path.join(root, 'src/components/RelationshipExplorer.tsx'), 'utf8');
  assert.ok(relExpSrc.includes('Harita hazırlanıyor…'));

  const profileModalSrc = fs.readFileSync(path.join(root, 'src/components/ProfileModal.tsx'), 'utf8');
  assert.ok(profileModalSrc.includes('Önbellekleri Sıfırla'));

  // REG-02: vite.config.ts matches react-vendor BEFORE d3-graph
  const viteSrc = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
  const reactVendorIdx = viteSrc.indexOf("return 'react-vendor'");
  const d3GraphIdx = viteSrc.indexOf("return 'd3-graph'");
  assert.ok(reactVendorIdx > 0 && d3GraphIdx > reactVendorIdx, 'react-vendor must precede d3-graph in manualChunks');

  // BUG-11: Every v7 new or touched modular file must remain strictly < 1,000 lines and free of inline style={{}}
  const v7Modules = [
    'src/services/idb-schema-version.ts',
    'src/core/encoding.ts',
    'src/services/encoding-service.ts',
    'src/services/client-depots.ts',
    'src/core/relationship-explorer.ts',
    'src/services/relationship-cache.ts',
    'src/services/stock-filter.ts',
    'src/services/stock-batch-fetcher.ts',
    'src/services/stock-engine.ts',
    'src/components/ErrorBoundary.tsx',
    'src/components/RelationshipCanvas.ts',
    'src/components/RelationshipExplorer.tsx',
    'src/components/TasteMapView.tsx',
    'src/components/MediaGrid.tsx',
    'src/components/StockHealthPanel.tsx',
    'src/components/ProfileModal.tsx',
  ];

  for (const relPath of v7Modules) {
    const content = fs.readFileSync(path.join(root, relPath), 'utf8');
    const lineCount = content.split('\n').length;
    assert.ok(
      lineCount < 1000,
      `Expected ${relPath} to stay < 1,000 lines (BUG-11), got ${lineCount} lines`
    );
    if (relPath.endsWith('.tsx')) {
      assert.equal(
        content.includes('style={{'),
        false,
        `Expected zero inline style={{}} in ${relPath}`
      );
    }
  }
});

test('Manual Stock Pull: works above 250/500 threshold and never re-saves items already in user lists or already in stock', async () => {
  setupCleanTestEnv();
  const profileId = 'profile-manual-stock';

  // Seed 300 movies (plus 1 accidental duplicate of 1005) and 500 TV shows (both >= 250 threshold!)
  const seedMovies = Array.from({ length: 300 }, (_, idx) => ({
    id: 1001 + idx,
    media_type: 'movie',
    title: `Mevcut Stok Film #${1001 + idx}`,
    release_date: '2022-05-10',
    vote_average: 7.5,
    genre_ids: [18, 28],
  }));
  seedMovies.push({ ...seedMovies[4] }); // duplicate movie:1005

  const seedTv = Array.from({ length: 500 }, (_, idx) => ({
    id: 2001 + idx,
    media_type: 'tv',
    name: `Mevcut Stok Dizi #${2001 + idx}`,
    first_air_date: '2022-05-10',
    vote_average: 8.0,
    genre_ids: [18],
  }));

  await saveStockIdb({
    movies: seedMovies,
    tv: seedTv,
    updatedAt: '2026-10-01T00:00:00.000Z',
  });

  const userItems = [
    { id: 1401, media_type: 'movie', title: 'İzliyorum Film', status: 'watching' },
    { id: 1402, media_type: 'movie', title: 'İzlenecek Film', status: 'watchlist' },
    { id: 1403, media_type: 'movie', title: 'Tamamlanan Film', status: 'completed' },
    { id: 2601, media_type: 'tv', name: 'İzlenecek Dizi', status: 'watchlist' },
  ];
  const preferences = {
    disliked: ['movie:1404', 'tv:2602'],
    hidden: ['movie:1405'],
  };

  await saveUserListsIdb(profileId, userItems);
  await saveIsolatedProfileIdb({
    profileId,
    updatedAt: '2026-10-01T00:00:00.000Z',
    preferences,
  });

  setStockTmdbFetcher(async (reqPath) => {
    if (reqPath.includes('movie')) {
      return {
        page: 1,
        total_pages: 1,
        results: [
          // Already in stock -> MUST NOT be re-saved
          { id: 1001, title: 'Mevcut Stok Film #1001', release_date: '2022-05-10', vote_average: 7.5, genre_ids: [18] },
          { id: 1002, title: 'Mevcut Stok Film #1002', release_date: '2022-05-10', vote_average: 7.5, genre_ids: [18] },
          // Already in user lists / disliked / hidden -> MUST NOT enter stock
          { id: 1401, title: 'İzliyorum Film', release_date: '2023-01-10', vote_average: 8.1, genre_ids: [28] },
          { id: 1402, title: 'İzlenecek Film', release_date: '2023-02-10', vote_average: 8.2, genre_ids: [12] },
          { id: 1403, title: 'Tamamlanan Film', release_date: '2023-03-10', vote_average: 8.3, genre_ids: [878] },
          { id: 1404, title: 'Disliked Film', release_date: '2023-04-10', vote_average: 6.1, genre_ids: [27] },
          { id: 1405, title: 'Hidden Film', release_date: '2023-05-10', vote_average: 7.0, genre_ids: [53] },
          // Genuinely new movies (1501 repeated twice across response to test intra-batch dedupe!)
          { id: 1501, title: 'Yeni Keşif Film A', release_date: '2024-01-15', vote_average: 8.4, genre_ids: [878] },
          { id: 1501, title: 'Yeni Keşif Film A Kopya', release_date: '2024-01-15', vote_average: 8.4, genre_ids: [878] },
          { id: 1502, title: 'Yeni Keşif Film B', release_date: '2023-08-20', vote_average: 7.9, genre_ids: [35] },
          { id: 1503, title: 'Yeni Keşif Film C', release_date: '2021-11-05', vote_average: 8.0, genre_ids: [80] },
        ],
      };
    }
    return {
      page: 1,
      total_pages: 1,
      results: [
        // Already in stock -> MUST NOT be re-saved
        { id: 2001, name: 'Mevcut Stok Dizi #2001', first_air_date: '2022-05-10', vote_average: 8.0, genre_ids: [18] },
        // Already in user lists / disliked -> MUST NOT enter stock
        { id: 2601, name: 'İzlenecek Dizi', first_air_date: '2023-02-01', vote_average: 8.5, genre_ids: [18] },
        { id: 2602, name: 'Disliked Dizi', first_air_date: '2023-03-01', vote_average: 6.5, genre_ids: [10765] },
        // Genuinely new TV shows (even though TV stock is already at 500!)
        { id: 2701, name: 'Yeni Dizi X', first_air_date: '2024-02-12', vote_average: 8.6, genre_ids: [10765] },
        { id: 2702, name: 'Yeni Dizi Y', first_air_date: '2023-09-18', vote_average: 8.1, genre_ids: [9648] },
      ],
    };
  });

  await initStockEngine(profileId, { immediate: false });

  // Autonomous replenishment stays idle when >= 250 (300 unique movies, 500 TV shows)
  const autoAfter = await executeStockReplenishment(profileId, { userListItems: userItems, preferences });
  assert.equal(autoAfter.movies.length, 300, 'Duplicate 1005 cleaned, autonomous does not pull when >= 250');
  assert.equal(autoAfter.tv.length, 500);

  // Manual pull MUST fetch new items even at 300 movies & 500 TV shows, skipping listed & existing stock!
  const pullRes = await manualPullStock(profileId, {
    userListItems: userItems,
    preferences,
    batchSizePerType: 10,
  });

  assert.equal(pullRes.ok, true);
  assert.equal(pullRes.addedMovies, 3, 'Exactly 3 genuinely new movies (1501, 1502, 1503) must be added');
  assert.equal(pullRes.addedTv, 2, 'Exactly 2 genuinely new TV shows (2701, 2702) must be added');
  assert.ok(pullRes.skippedListedCount > 0, 'Listed/disliked/hidden candidates must be counted as skipped');
  assert.ok(pullRes.skippedDuplicateStockCount > 0, 'Existing stock candidates must be counted as skipped');

  const persisted = await loadStockIdb();
  const movieIds = persisted.movies.map((m) => Number(m.id));
  const tvIds = persisted.tv.map((t) => Number(t.id));

  assert.equal(movieIds.length, 303);
  assert.equal(tvIds.length, 502);
  assert.equal(new Set(movieIds).size, movieIds.length, 'Zero duplicate movie IDs in ct:stock');
  assert.equal(new Set(tvIds).size, tvIds.length, 'Zero duplicate TV IDs in ct:stock');

  // Listed / disliked / hidden items MUST NOT be in stock
  for (const forbiddenMovieId of [1401, 1402, 1403, 1404, 1405]) {
    assert.equal(movieIds.includes(forbiddenMovieId), false, `Forbidden movie ${forbiddenMovieId} must not enter stock`);
  }
  for (const forbiddenTvId of [2601, 2602]) {
    assert.equal(tvIds.includes(forbiddenTvId), false, `Forbidden TV ${forbiddenTvId} must not enter stock`);
  }

  // Genuinely new items MUST be in stock
  for (const expectedMovieId of [1501, 1502, 1503]) {
    assert.equal(movieIds.includes(expectedMovieId), true);
  }
  for (const expectedTvId of [2701, 2702]) {
    assert.equal(tvIds.includes(expectedTvId), true);
  }

  // Second manual pull against the exact same catalog adds 0 duplicates
  const secondPull = await manualPullStock(profileId, {
    userListItems: userItems,
    preferences,
    batchSizePerType: 10,
  });
  assert.equal(secondPull.addedMovies, 0);
  assert.equal(secondPull.addedTv, 0);
  assert.equal(secondPull.moviesCount, 303);
  assert.equal(secondPull.tvCount, 502);
});

function makePosterlessSavedItem(id, mediaType = 'movie', extra = {}) {
  return {
    id,
    media_type: mediaType,
    title: `İçerik ${id}`,
    vote_average: 0,
    vote_count: 0,
    popularity: 0,
    genre_ids: [],
    status: 'watchlist',
    personal_rating: '',
    poster_path: '',
    poster_url: '',
    tasteFit: 71,
    tasteReason: 'Kalıcı zevk damgası',
    ...extra,
  };
}


test('POSTER-01: Poster hidrasyonu poster_path boş liste kayıtlarını TMDB detayından doldurur', async () => {
  setupCleanTestEnv();
  resetPosterHydrationForTests();

  const items = [
    makePosterlessSavedItem(60574, 'tv'),
    makePosterlessSavedItem(4922),
    makePosterlessSavedItem(165),
    makePosterlessSavedItem(777),
    makePosterlessSavedItem(999, 'movie', { poster_path: '/zaten-var.jpg' }),
    makePosterlessSavedItem('custom-1', 'movie', { custom: true }),
  ];

  assert.deepEqual(
    collectPosterHydrationCandidates(items).map((c) => c.key),
    ['tv:60574', 'movie:165', 'movie:777', 'movie:4922'],
    'custom, posteri olan ve sayısal olmayan kimlikler aday olmaz; TV havuzu önce dolar'
  );

  const calls = [];
  const fetcher = async (endpoint) => {
    calls.push(endpoint);
    const numericId = Number(endpoint.split('/').pop());
    // 777: TMDB kaydı var ama posteri yok
    if (numericId === 777) return { id: 777, title: 'Postersiz Yapım' };
    return {
      id: numericId,
      poster_path: `/poster-${numericId}.jpg`,
      backdrop_path: `/backdrop-${numericId}.jpg`,
    };
  };

  const first = await runPosterHydrationPass({ items, fetcher, itemsPerPass: 4 });
  assert.equal(first.attemptedCount, 4);
  assert.equal(first.hydratedCount, 3);
  assert.equal(first.failedCount, 0);
  assert.deepEqual(
    calls.slice().sort(),
    ['/movie/165', '/movie/4922', '/movie/777', '/tv/60574'],
    'her içerik kendi türünün detay ucundan sorulur'
  );
  assert.equal(first.patches['movie:4922'].poster_path, '/poster-4922.jpg');
  assert.equal(first.patches['tv:60574'].poster_path, '/poster-60574.jpg');
  assert.equal(first.patches['movie:777'], undefined);

  const applied = applyPosterPatchesToSavedItems(items, first.patches);
  assert.equal(applied.changedCount, 3);
  assert.equal(applied.items[0].poster_path, '/poster-60574.jpg');
  assert.equal(applied.items[0].backdrop_path, '/backdrop-60574.jpg');
  assert.equal(
    applied.items[0].tasteReason,
    'Kalıcı zevk damgası',
    'poster yazımı zevk damgasını bozmaz'
  );
  assert.equal(applied.items[3].poster_path, '', 'postersiz kayıt boş kalır');
  assert.equal(applied.items[4], items[4], 'posteri olan kayıt aynı nesne olarak kalır');
  assert.equal(applied.items[5], items[5], 'custom kayıt hidrasyona girmez');

  const nothing = applyPosterPatchesToSavedItems(items, {});
  assert.equal(nothing.changedCount, 0);
  assert.equal(nothing.items, items, 'yama yoksa dizi referansı korunur');

  // 777 postersiz: sonraki geçişlerde tekrar sorulmaz
  calls.length = 0;
  const second = await runPosterHydrationPass({ items, fetcher, itemsPerPass: 4 });
  assert.equal(second.attemptedCount, 3);
  assert.deepEqual(calls.slice().sort(), ['/movie/165', '/movie/4922', '/tv/60574']);
  assert.equal(getPosterHydrationQuotaState().missingPosterCount, 1);
});

test('POSTER-02: Poster hidrasyonu geçiş başına sınıra, günlük kotaya ve hata halinde tekrar denemeye uyar', async () => {
  setupCleanTestEnv();
  resetPosterHydrationForTests();

  const many = Array.from({ length: 30 }, (_, i) => makePosterlessSavedItem(1000 + i));
  const calls = [];
  let offline = false;
  const fetcher = async (endpoint) => {
    calls.push(endpoint);
    if (offline) throw new Error('Yerel TMDB servisine ulaşılamadı.');
    const numericId = Number(endpoint.split('/').pop());
    return { id: numericId, poster_path: `/poster-${numericId}.jpg` };
  };

  const pass = await runPosterHydrationPass({ items: many, fetcher, itemsPerPass: 12 });
  assert.equal(pass.attemptedCount, 12);
  assert.equal(pass.hydratedCount, 12);
  assert.equal(pass.remainingCount, 18);
  assert.equal(calls.length, 12);

  offline = true;
  const failed = await runPosterHydrationPass({ items: many, fetcher, itemsPerPass: 10 });
  assert.equal(failed.failedCount, 10);
  assert.equal(failed.attemptedCount, 0);
  assert.equal(failed.hydratedCount, 0);
  assert.equal(
    getPosterHydrationQuotaState(12).remainingCount,
    0,
    'başarısız istekler kotayı tüketmez'
  );

  calls.length = 0;
  offline = false;
  const blocked = await runPosterHydrationPass({ items: many, fetcher, dailyLimit: 12 });
  assert.equal(blocked.attemptedCount, 0);
  assert.equal(calls.length, 0, 'kota dolarken yeni istek çıkmaz');

  const nextDay = await runPosterHydrationPass({
    items: many,
    fetcher,
    dailyLimit: 12,
    itemsPerPass: 5,
    nowMs: Date.now() + 26 * 60 * 60 * 1000,
  });
  assert.equal(nextDay.attemptedCount, 5, 'gün değişince kota tazelenir');
});

test('POSTER-03: Vekilden gelen yanlış kimlikli yanıt posteri başka yapıma yazmaz', async () => {
  setupCleanTestEnv();
  resetPosterHydrationForTests();

  const items = [makePosterlessSavedItem(165), makePosterlessSavedItem(4922)];
  const fetcher = async (endpoint) => {
    const numericId = Number(endpoint.split('/').pop());
    // Vekil önbelleği 165 yerine başka bir yapımı döndürse de poster yazılmaz
    if (numericId === 165) return { id: 999999, poster_path: '/yanlis.jpg' };
    // Göreli yol öneki olmayan yanıt poster sayılmaz
    if (numericId === 4922) return { id: 4922, poster_path: 'postgresiz.jpg' };
    return null;
  };

  const pass = await runPosterHydrationPass({ items, fetcher, itemsPerPass: 2 });
  assert.equal(pass.attemptedCount, 2);
  assert.equal(pass.hydratedCount, 0);
  assert.deepEqual(Object.keys(pass.patches), []);
  assert.equal(
    getPosterHydrationQuotaState().missingPosterCount,
    1,
    'kimliği tutmayan yanıt tekrar denenir, olumsuz önbelleğe alınmaz'
  );
});

test('POSTER-04: Profil CSV turu poster/backdrop yollarını taşır; sütunsuz eski CSV posterleri silmez', () => {
  const items = [
    makePosterlessSavedItem(4922, 'tv', {
      poster_path: '/poster-4922.jpg',
      backdrop_path: '/backdrop-4922.jpg',
    }),
    makePosterlessSavedItem(165, 'movie', {
      poster_path: '',
      poster_url: 'https://artworks.thetvdb.com/banners/poster-165.jpg',
    }),
    makePosterlessSavedItem(777, 'movie'),
  ];

  const csv = exportItemsToCsv(items, null);
  const header = csv.split('\r\n')[0];
  assert.ok(header.includes('PosterPath') && header.includes('BackdropPath'), 'CSV başlığında poster sütunları');

  const { importedItems } = importItemsFromCsv(csv);
  assert.equal(importedItems.length, 3);
  const office = importedItems.find((it) => it.id === 4922);
  assert.equal(office.poster_path, '/poster-4922.jpg');
  assert.equal(office.backdrop_path, '/backdrop-4922.jpg');
  const tvdbOnly = importedItems.find((it) => it.id === 165);
  assert.equal(tvdbOnly.poster_url, 'https://artworks.thetvdb.com/banners/poster-165.jpg');
  assert.equal(tvdbOnly.poster_path, undefined, 'tam URL poster_path gibi yazılmaz');
  const withoutPoster = importedItems.find((it) => it.id === 777);
  assert.equal(withoutPoster.poster_path, undefined);

  const legacyHeader = [
    'Title',
    'Year',
    'Rating10',
    'WatchedDate',
    'Status',
    'MediaType',
    'tmdbID',
    'AddedDate',
    'Custom',
  ].join(',');
  const legacyCsv = [
    legacyHeader,
    '"İçerik 4922","2005","","","watching","tv","4922","",""',
    '"İçerik 5000","2010","","","watching","tv","5000","",""',
  ].join('\r\n');

  const legacy = importItemsFromCsv(legacyCsv);
  assert.equal(legacy.importedItems.find((it) => it.id === 4922).poster_path, undefined);

  const merged = mergeSavedItemListsLossless(items, legacy.importedItems, 'profile-default');
  const mergedOffice = merged.find((it) => String(it.id) === '4922');
  assert.equal(mergedOffice.poster_path, '/poster-4922.jpg', 'eski CSV posterleri temizlemez');
  assert.equal(merged.length, 4, 'postersiz yeni kayıt listeye eklenir');
});

test('POSTER-05: Başlığı # ile başlayan içerik profil bloğu sanılmaz, CSV turundan sağlam çıkar', () => {
  const items = [
    makePosterlessSavedItem(614696, 'movie', {
      title: '#Alive',
      poster_path: '/zb06eXz3Pg5JzytPnMFb3cIDV7B.jpg',
    }),
  ];

  const csv = exportItemsToCsv(items, null);
  const { importedItems, detectedFormat } = importItemsFromCsv(csv);

  assert.equal(detectedFormat, 'cinetrack');
  assert.equal(importedItems.length, 1, '# ile başlayan başlık veri satırıdır');
  assert.equal(importedItems[0].title, '#Alive');
  assert.equal(importedItems[0].poster_path, '/zb06eXz3Pg5JzytPnMFb3cIDV7B.jpg');

  const withProfileBlock = exportItemsToCsv(items, {
    profile: {
      id: 'profile-default',
      name: 'Ben',
      items: [],
      preferences: { disliked: ['#Alive'], providers: [], mood: '', reminders: false, notified: [] },
    },
    activeProfileId: 'profile-default',
  });
  const reparsed = importItemsFromCsv(withProfileBlock);
  assert.equal(reparsed.importedItems.length, 1, 'profil bloğu satırları kayıp yaratmaz');
  assert.equal(reparsed.importedItems[0].poster_path, '/zb06eXz3Pg5JzytPnMFb3cIDV7B.jpg');
});

test('BACKUP-CSV-01: #CINETRACK-PROFILE bölümü dışa aktarımda yazılır ve importta geri okunur', () => {
  const items = [
    makePosterlessSavedItem(4922, 'tv', { poster_path: '/poster-4922.jpg' }),
    makePosterlessSavedItem(614696, 'movie', { title: '#Alive', poster_path: '/zb06eXz.jpg' }),
  ];

  const csv = exportItemsToCsv(items, {
    profile: {
      id: 'profile-default',
      name: 'Benim Profilim',
      items: [],
      preferences: {
        disliked: ['#Alive', 'Breaking Bad'],
        hidden: ['The Office'],
        providers: ['netflix', 'BluTV'],
        mood: 'gerilim',
        reminders: false,
        notified: ['4922'],
      },
      favoriteActors: [{ id: 287, name: 'Brad Pitt', character: '', profile_path: '/brad.jpg' }],
    },
    activeProfileId: 'profile-default',
  });

  assert.ok(csv.includes('#CINETRACK-PROFILE'), 'profil bölümü dosyada yazılı');

  const result = importItemsFromCsv(csv);
  assert.equal(result.importedItems.length, 2, '# ile başlayan başlık veri satırı olarak okunur');

  const block = result.profileBlock;
  assert.ok(block, 'profil bölümü geri çözümlendi');
  assert.equal(block.profileName, 'Benim Profilim');
  assert.equal(block.profileId, 'profile-default');
  assert.equal(block.activeProfileId, 'profile-default');
  assert.equal(block.mood, 'gerilim');
  assert.deepEqual(block.providers, ['netflix', 'BluTV']);
  assert.deepEqual(block.disliked, ['#Alive', 'Breaking Bad']);
  assert.deepEqual(block.hidden, ['The Office']);
  assert.deepEqual(block.notified, ['4922']);
  assert.equal(block.reminders, false);
  assert.deepEqual(block.favoriteActors, [
    { id: 287, name: 'Brad Pitt', profile_path: '/brad.jpg' },
  ]);

  const plain = importItemsFromCsv(
    ['Title,Year,Rating10,WatchedDate,Status,MediaType,tmdbID', '"Film","2001","","","watching","movie","1"'].join('\r\n')
  );
  assert.equal(plain.profileBlock, null, 'profil bölümü olmayan CSV blok üretmez');
});

import React from 'react';
import {
  buildRatingHistogramColumns,
  buildReleaseDecadeColumns,
} from '../src/components/charts/profile-chart-data.ts';

test('CHART-01: puan histogramı 1-10 kovalarını eksiksiz üretir', () => {
  const items = [
    { id: 1, media_type: 'movie', title: 'A', personal_rating: 9, status: 'completed' },
    { id: 2, media_type: 'movie', title: 'B', personal_rating: 8.2, status: 'completed' },
    { id: 3, media_type: 'movie', title: 'C', personal_rating: 5, status: 'completed' },
    { id: 4, media_type: 'movie', title: 'D', personal_rating: '', status: 'watchlist' },
    { id: 5, media_type: 'movie', title: 'E', personal_rating: 0, status: 'watchlist' },
    { id: 6, media_type: 'movie', title: 'F', personal_rating: 5, status: 'completed' },
  ];

  const columns = buildRatingHistogramColumns(items);
  assert.equal(columns.length, 10, '10 puan kovası');
  assert.deepEqual(
    columns.map((c) => c.label),
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']
  );
  assert.deepEqual(
    columns.map((c) => c.value),
    [0, 0, 0, 0, 2, 0, 0, 1, 1, 0],
    '8.2 → 8 kovasına yuvarlanır, boş/0 puan sayılmaz'
  );
  assert.equal(columns[8].hint, '9 puan: 1 yapım (%25)');
  assert.deepEqual(buildRatingHistogramColumns([]).map((c) => c.value), new Array(10).fill(0));
});

test('CHART-02: yayın onyılı dağılımı aralığı doldurur ve filtresiz boş üretir', () => {
  const items = [
    { id: 1, media_type: 'movie', title: 'a', release_date: '2023-05-01' },
    { id: 2, media_type: 'movie', title: 'b', release_date: '2011-01-01' },
    { id: 3, media_type: 'tv', title: 'c', first_air_date: '1998-01-01' },
    { id: 4, media_type: 'movie', title: 'd' },
  ];

  const columns = buildReleaseDecadeColumns(items);
  assert.deepEqual(
    columns.map((c) => c.label),
    ['1990', '2000', '2010', '2020'],
    'boş onyıllar sıfır ile yer tutar'
  );
  assert.deepEqual(columns.map((c) => c.value), [1, 0, 1, 1]);
  assert.equal(columns[3].hint, '2020-2029: 1 yapım (%33)');
  assert.deepEqual(buildReleaseDecadeColumns([]), []);

  const singleDecade = buildReleaseDecadeColumns([
    { id: 1, media_type: 'movie', title: 'a', release_date: '2021-01-01' },
    { id: 2, media_type: 'movie', title: 'b', release_date: '2024-01-01' },
  ]);
  assert.deepEqual(singleDecade, [], 'tek onyıl grafik üretmez');
});

test('CHART-03: ColumnChart SVG + HTML etiket satırı olarak render edilir', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ColumnChart } = await import('../src/components/charts/ColumnChart.tsx');

  const markup = renderToStaticMarkup(
    React.createElement(ColumnChart, {
      ariaLabel: 'Kişisel puan dağılımı',
      tone: 'gold',
      points: [
        { label: '8', value: 4 },
        { label: '9', value: 12 },
      ],
    })
  );

  assert.ok(markup.includes('ct-chart ct-chart-gold'), 'ton sınıfı container üzerinde');
  assert.ok(markup.includes('preserveAspectRatio="none"'), 'barlar genişliğe yayılır');
  assert.equal((markup.match(/class="ct-chart-bar"/g) || []).length, 2);
  assert.equal((markup.match(/class="ct-chart-labels"/g) || []).length, 1);
  assert.ok(markup.includes('grid-template-columns'), 'etiketler ızgara ile hizalanır');
  assert.ok(markup.includes('aria-label="Kişisel puan dağılımı. 8: 4, 9: 12"'));
  assert.ok(markup.indexOf('class="ct-chart-bar"') < markup.indexOf('ct-chart-labels'));

  const empty = renderToStaticMarkup(
    React.createElement(ColumnChart, { ariaLabel: 'bos', points: [] })
  );
  assert.equal(empty, '', 'boş veri render edilmez');
});

test('CHART-04: grafik/oran bar sınıflarının CSS karşılığı var', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src/styles/app.css'), 'utf8');
  for (const selector of [
    '.ct-chart-svg',
    '.ct-chart-accent .ct-chart-bar',
    '.ct-chart-gold .ct-chart-bar',
    '.ct-chart-labels',
    '.profile-ratio-svg',
    '.profile-ratio-movie',
    '.profile-ratio-tv',
    '.genre-bar-svg-track',
    '.genre-bar-svg-fill.rank-1',
    '.profile-stat-footnote',
    '.profile-genre-filter-btn',
  ]) {
    assert.ok(css.includes(selector), `${selector} stil tanımlı olmalı`);
  }
  assert.match(css, /\.ct-chart-gold \.ct-chart-bar\s*\{\s*fill:\s*var\(--gold\)/);
  assert.match(css, /\.profile-ratio-movie\s*\{\s*fill:\s*var\(--turquoise\)/);
});

test('PAL-01: komut paleti açıkken komut gruplarını ve arama alanını render eder', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { CommandPalette } = await import('../src/components/CommandPalette.tsx');

  const markup = renderToStaticMarkup(
    React.createElement(CommandPalette, {
      isOpen: true,
      onClose: () => {},
      savedItems: [],
      onSelectTab: () => {},
      onOpenProfile: () => {},
      onOpenAddCustom: () => {},
      onQuickSave: () => {},
      onFocusSearch: () => {},
      onOpenItem: () => {},
    })
  );

  assert.ok(markup.includes('command-palette'), 'palet modal kabuğunu kullanır');
  assert.ok(markup.includes('role="dialog"') && markup.includes('aria-modal="true"'));
  assert.ok(markup.includes('Komutlar'), 'komut grubu başlığı');
  for (const label of ['Keşfet', 'Listem', 'Kaydet ve eşitle', 'Özel içerik ekle']) {
    assert.ok(markup.includes(label), `${label} komutu listelenir`);
  }
  assert.ok(
    !markup.includes('command-item-media'),
    'boş sorguda içerik sonucu listelenmez'
  );
  assert.ok(markup.includes('en az 2 harf'), 'TMDB bölümü yönlendirme metni gösterir');
});

test('PAL-02: kapalı palet render edilmez ve ⌘K bağlaması modifier önceliğini korur', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { CommandPalette } = await import('../src/components/CommandPalette.tsx');

  const closed = renderToStaticMarkup(
    React.createElement(CommandPalette, {
      isOpen: false,
      onClose: () => {},
      savedItems: [],
      onSelectTab: () => {},
      onOpenProfile: () => {},
      onOpenAddCustom: () => {},
      onQuickSave: () => {},
      onFocusSearch: () => {},
      onOpenItem: () => {},
    })
  );
  assert.equal(closed, '', 'kapalı palet DOM üretmez');

  const hookSource = fs.readFileSync(
    path.join(process.cwd(), 'src/hooks/useKeyboardShortcuts.ts'),
    'utf8'
  );
  const paletteIndex = hookSource.indexOf("e.key.toLowerCase() === 'k'");
  const bailIndex = hookSource.indexOf('if (e.ctrlKey || e.metaKey || e.altKey) return;');
  assert.ok(paletteIndex > -1, '⌘K/Ctrl+K dalı var');
  assert.ok(bailIndex > paletteIndex, '⌘K, modifier erken-çıkışından önce yakalanır');
  assert.ok(hookSource.includes('onOpenCommandPalette?.()'));

  const appSource = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');
  assert.ok(appSource.includes('onOpenCommandPalette: () => {'), 'App paleti açar');
  assert.ok(
    appSource.includes("document.querySelector<HTMLInputElement>('#searchInput')"),
    'aramaya odaklanma gerçek input id sini kullanır'
  );
  assert.ok(
    !appSource.includes("'.search-input'"),
    'var olmayan .search-input seçici bırakılmaz'
  );

  const headerSource = fs.readFileSync(
    path.join(process.cwd(), 'src/components/Header.tsx'),
    'utf8'
  );
  assert.ok(headerSource.includes('commandPaletteTrigger'), 'Header tetikleyicisi var');
});

function makeStockItem(id, mediaType, extra = {}) {
  return {
    id,
    media_type: mediaType,
    title: mediaType === 'movie' ? `Film ${id}` : undefined,
    name: mediaType === 'tv' ? `Dizi ${id}` : undefined,
    ...extra,
  };
}

test('STOCK-POSTER-01: Kırık TVDB posterleri aday sayılır, sağlam posterlere dokunulmaz', () => {
  const brokenTvdb = makeStockItem('tvdb-2801', 'movie', {
    title: 'Dune: Part Two (TVDB Edition)',
    release_date: '2024-01-01',
    poster_path: 'https://artworks.thetvdb.com/banners/v4/movie/2801/posters/a.jpg',
    poster_url: 'https://artworks.thetvdb.com/banners/v4/movie/2801/posters/a.jpg',
    source: 'tvdb',
    _source: 'demo',
  });
  const numericMissing = makeStockItem(165, 'movie', { release_date: '2020-05-01' });
  const numericWithPoster = makeStockItem(603, 'movie', { poster_path: '/matrix.jpg' });
  const validUrlPoster = makeStockItem(604, 'movie', {
    poster_url: 'https://image.tmdb.org/t/p/original/x.jpg',
  });
  const tvBroken = makeStockItem('tvdb-3901', 'tv', {
    title: 'Shōgun (TVDB Edition)',
    first_air_date: '2024-02-27',
    poster_path: 'https://artworks.thetvdb.com/banners/v4/series/3919/posters/b.jpg',
    poster_url: 'https://artworks.thetvdb.com/banners/v4/series/3919/posters/b.jpg',
    source: 'tvdb',
    _source: 'demo',
  });

  assert.equal(hasUsableStockPoster(brokenTvdb), false);
  assert.equal(hasUsableStockPoster(numericWithPoster), true);
  assert.equal(hasUsableStockPoster(validUrlPoster), true);

  const candidates = buildStockPosterCandidates(
    [brokenTvdb, numericMissing, numericWithPoster, validUrlPoster],
    [tvBroken]
  );
  assert.deepEqual(
    candidates.map((c) => [c.key, c.numericId, c.query, c.year]),
    [
      ['tv:tvdb-3901', null, 'Shōgun', '2024'],
      ['movie:tvdb-2801', null, 'Dune: Part Two', '2024'],
      ['movie:165', 165, 'Film 165', '2020'],
    ],
    'TV önce gelir; TVDB kimlikleri başlıkla aranır, sayısallar detay ucundan'
  );

  const sanitized = sanitizeStockPosterDepot({
    movies: [brokenTvdb, numericWithPoster],
    tv: [tvBroken],
  });
  assert.equal(sanitized.changedCount, 2, 'iki kırık kayıt ayıklanır');
  assert.equal(sanitized.depot.movies[0].poster_path, null);
  assert.equal('poster_url' in sanitized.depot.movies[0], false);
  assert.equal(sanitized.depot.movies[1], numericWithPoster, 'sağlam kayıt aynı nesne kalır');

  const untouched = sanitizeStockPosterDepot({ movies: [numericWithPoster], tv: [] });
  assert.equal(untouched.changedCount, 0);
  assert.equal(untouched.depot.movies[0].id, 603);

  const match = pickStockSearchMatch(
    [
      { id: 1, title: 'Shogun Assassin', release_date: '1980-01-01', poster_path: '/wrong.jpg' },
      { id: 2, name: 'Shōgun', first_air_date: '2024-02-27', poster_path: '/right.jpg' },
    ],
    { query: 'Shōgun', year: '2024', mediaType: 'tv' }
  );
  assert.equal(match.poster_path, '/right.jpg', 'yıl ve başlık eşleşmesi en yakın sonucu seçer');
});

test('STOCK-POSTER-02: Stok poster hidrasyonu detay ve başlık aramasıyla doldurur, kotaya uyar', async () => {
  setupCleanTestEnv();
  resetStockPosterHydrationForTests();

  const stock = {
    movies: [
      makeStockItem(165, 'movie', {}),
      makeStockItem('tvdb-2801', 'movie', {
        title: 'Dune: Part Two',
        release_date: '2024-01-01',
        poster_path: 'https://artworks.thetvdb.com/banners/x.jpg',
        poster_url: 'https://artworks.thetvdb.com/banners/x.jpg',
        source: 'tvdb',
        _source: 'demo',
      }),
      makeStockItem('tvdb-3999', 'movie', {
        title: 'Bilinmeyen Yapım',
        release_date: '1999-01-01',
        source: 'tvdb',
      }),
      makeStockItem(777, 'movie', {}),
    ],
    tv: [
      makeStockItem('tvdb-3901', 'tv', {
        title: 'Shōgun (TVDB Edition)',
        first_air_date: '2024-01-01',
        poster_path: 'https://artworks.thetvdb.com/banners/y.jpg',
        poster_url: 'https://artworks.thetvdb.com/banners/y.jpg',
        source: 'tvdb',
        _source: 'demo',
      }),
    ],
  };

  const calls = [];
  const fetcher = async (endpoint, params = {}) => {
    calls.push([endpoint, params]);
    if (endpoint === '/movie/165') {
      return { id: 165, poster_path: '/p165.jpg', backdrop_path: '/b165.jpg' };
    }
    if (endpoint === '/movie/777') return { id: 777 };
    if (endpoint === '/search/movie' && params.query === 'Dune: Part Two') {
      return {
        results: [
          { id: 693134, title: 'Dune: Part Two', release_date: '2024-03-01', poster_path: '/dune2.jpg' },
        ],
      };
    }
    if (endpoint === '/search/movie') return { results: [] };
    if (endpoint === '/search/tv') {
      return {
        results: [
          { id: 126308, name: 'Shōgun', first_air_date: '2024-02-27', poster_path: '/shogun.jpg' },
        ],
      };
    }
    return null;
  };

  const pass = await runStockPosterHydrationPass({ stock, fetcher, itemsPerPass: 6 });
  assert.equal(pass.attemptedCount, 5);
  assert.equal(pass.hydratedCount, 3);
  assert.equal(pass.failedCount, 0);
  assert.equal(pass.patches['movie:165'].poster_path, '/p165.jpg');
  assert.equal(pass.patches['movie:165'].poster_url, null);
  assert.equal(pass.patches['movie:165'].backdrop_path, '/b165.jpg');
  assert.equal(pass.patches['movie:tvdb-2801'].poster_path, '/dune2.jpg');
  assert.equal(pass.patches['tv:tvdb-3901'].poster_path, '/shogun.jpg');
  assert.equal(pass.patches['movie:tvdb-3999'], undefined);

  const searchCall = calls.find(([ep]) => ep === '/search/tv');
  assert.equal(searchCall[1].query, 'Shōgun', 'TVDB soneki arama metnine girmez');
  assert.equal(searchCall[1].first_air_date_year, undefined, 'uydurma yıl doğru sonucu elemesin');
  assert.equal(searchCall[1].language, 'en-US', 'İngilizce başlıklarla eşleştirilir');
  assert.equal(
    getStockPosterHydrationQuotaState().missingPosterCount,
    2,
    'TMDB posteri olmayan ve eşleşmeyen kayıtlar olumsuz önbelleğe alınır'
  );

  const applied = applyStockPosterPatchesToItems(stock.movies, pass.patches);
  assert.equal(applied[0].poster_path, '/p165.jpg');
  assert.equal('poster_url' in applied[0], false);
  assert.equal(applied[1].poster_path, '/dune2.jpg');

  calls.length = 0;
  const second = await runStockPosterHydrationPass({
    stock: {
      movies: [
        makeStockItem(165, 'movie', { poster_path: '/p165.jpg' }),
        applied[1],
        stock.movies[2],
      ],
      tv: [],
    },
    fetcher,
  });
  assert.equal(second.attemptedCount, 0);
  assert.equal(calls.length, 0);

  const blocked = await runStockPosterHydrationPass({ stock, fetcher, dailyLimit: 5 });
  assert.equal(blocked.attemptedCount, 0, 'kota dolunca yeni istek çıkmaz');
});

test('STOCK-POSTER-03: Yamalar ct:stock deposuna yazılır (yedekleme yolu aynı kalır)', async () => {
  setupCleanTestEnv();
  resetStockPosterHydrationForTests();

  const broken = makeStockItem('tvdb-2801', 'movie', {
    title: 'Dune: Part Two',
    poster_path: 'https://artworks.thetvdb.com/banners/v4/movie/2801/posters/a.jpg',
    poster_url: 'https://artworks.thetvdb.com/banners/v4/movie/2801/posters/a.jpg',
    source: 'tvdb',
    _source: 'demo',
  });
  const plain = makeStockItem(165, 'movie', { poster_path: '/mevcut.jpg' });
  await saveStockIdb({
    movies: [broken, plain],
    tv: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    cursors: {},
  });

  const loaded = await loadStockIdb();
  assert.equal(loaded.movies[0].poster_path, null, 'okuma anında kırık adres ayıklanır');
  assert.equal('poster_url' in loaded.movies[0], false);

  const updated = await applyStockPosterPatchesToDepot({
    'movie:tvdb-2801': {
      poster_path: '/dune2.jpg',
      poster_url: null,
      backdrop_path: '/dune2-b.jpg',
    },
  });
  assert.equal(updated, 1);

  const persisted = await loadStockIdb();
  assert.equal(persisted.movies[0].poster_path, '/dune2.jpg');
  assert.equal(persisted.movies[0].backdrop_path, '/dune2-b.jpg');
  assert.equal('poster_url' in persisted.movies[0], false);
  assert.equal(persisted.movies[1].poster_path, '/mevcut.jpg', 'diğer kayıt değişmez');

  const noop = await updateStockItemsMetadata({
    'movie:tvdb-2801': { poster_path: '/dune2.jpg', poster_url: null },
  });
  assert.equal(noop, 0);
});

test('STOCK-PERF-01: Listemdekileri gizle filtresi indeksli yolla aynı sonucu üretir', () => {
  const savedItems = [
    { id: 603, media_type: 'movie', title: 'The Matrix', status: 'completed' },
    { id: 1399, media_type: 'tv', title: 'Game of Thrones', status: 'watching' },
  ];
  const preferences = {
    disliked: ['movie:550'],
    hidden: ['tv:1396'],
    liked: [],
    watchProviders: [],
    topGenres: [],
  };
  const tasteMap = {
    entries: {
      'movie:27205': { status: 'saved' },
    },
  };
  const items = [
    { id: 603, media_type: 'movie', title: 'The Matrix' },
    { id: 603, media_type: 'tv', title: 'The Matrix' },
    { id: 1399, media_type: 'tv', title: 'Game of Thrones' },
    { id: 550, media_type: 'movie', title: 'Fight Club' },
    { id: 1396, media_type: 'tv', title: 'Breaking Bad' },
    { id: 27205, media_type: 'movie', title: 'Inception' },
    { id: 999, media_type: 'movie', title: 'The Matrix' },
    { id: 1234, media_type: 'movie', title: 'Serbest Yapım' },
  ];

  const expected = items.filter(
    (item) => !isMediaRegisteredInUserProfile(item, { savedItems, preferences, tasteMap })
  );
  const actual = filterHiddenUserRegisteredItems(items, {
    savedItems,
    preferences,
    tasteMap,
    hideListedItems: true,
  });
  assert.deepEqual(
    actual.map((i) => `${i.media_type}:${i.id}`),
    expected.map((i) => `${i.media_type}:${i.id}`)
  );
  assert.deepEqual(
    actual.map((i) => `${i.media_type}:${i.id}`),
    ['tv:603', 'movie:1234'],
    'başlık eşleşmesi türle sınırlı kalır'
  );
});

test('STOCK-POSTER-04: TVDB türevi kayıtlar için tür araması proxy izin listesinde', () => {
  assert.ok(ALLOWED_TMDB_PATH.test('/search/movie'), 'film araması izinli olmalı');
  assert.ok(ALLOWED_TMDB_PATH.test('/search/tv'), 'dizi araması izinli olmalı');
  assert.ok(!ALLOWED_TMDB_PATH.test('/search/person'), 'person araması izinli olmamalı');
  assert.ok(ALLOWED_TMDB_QUERY_KEYS.has('year'));
  assert.ok(ALLOWED_TMDB_QUERY_KEYS.has('first_air_date_year'));
  assert.ok(!validateTmdbParam('year', '2024'));
  assert.ok(!validateTmdbParam('first_air_date_year', '1999'));
  assert.ok(validateTmdbParam('year', '20x4'));
  assert.ok(validateTmdbParam('first_air_date_year', '2024-01-01'));

  const localized = pickStockSearchMatch(
    [
      {
        id: 693134,
        title: 'Dune: Bölüm İki',
        original_title: 'Dune: Part Two',
        release_date: '2024-03-01',
        poster_path: '/dune2.jpg',
      },
    ],
    { query: 'Dune: Part Two', year: '2024', mediaType: 'movie' }
  );
  assert.equal(localized.poster_path, '/dune2.jpg', 'yerelleşmiş başlık orijinal adla eşleşir');
});

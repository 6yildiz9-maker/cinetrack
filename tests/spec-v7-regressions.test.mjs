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
  setStockTmdbFetcher,
  resetStockEngineForTests,
} from '../src/services/stock-engine.ts';
import { renderRelationshipCanvasNode } from '../src/components/RelationshipCanvas.ts';
import { ErrorBoundary } from '../src/components/ErrorBoundary.tsx';

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
  assert.ok(mediaGridSrc.includes('İzleme listen henüz boş — ilk içeriğini ekle'));

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
    'src/services/stock-engine.ts',
    'src/components/ErrorBoundary.tsx',
    'src/components/RelationshipCanvas.ts',
    'src/components/RelationshipExplorer.tsx',
    'src/components/TasteMapView.tsx',
    'src/components/MediaGrid.tsx',
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

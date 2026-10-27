import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PersistentDataStore,
  mergeCatalogItem,
  redactSecrets,
} from '../src/server/persistent-store.ts';
import {
  cleanupStaleTempFiles,
  CorruptJsonFileError,
  writeJsonFileAtomic,
} from '../src/server/atomic-json.ts';
import { createDataStorage } from '../src/server/storage.ts';
import { createCineTrackApp } from '../src/server/app.ts';
import {
  DEFAULT_MAX_DATA_BYTES,
  formatMaxDataLimitMb,
  measureUtf8Bytes,
} from '../src/core/limits.ts';
import {
  DERIVED_PROFILE_SCHEMA_VERSION,
  validateDerivedProfileCache,
} from '../src/core/derived-profile-cache.ts';
import {
  buildDerivedProfilePayloadFromTasteMap,
  hydrateTasteMapWithDerivedCache,
} from '../src/core/recommendation-orchestrator.ts';

async function withTestApp(options, fn) {
  const { app, storage, persistentStore } = createCineTrackApp(options);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await fn({ baseUrl, storage, persistentStore });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Katalog Tekilleştirme: Aynı film iki kez indirildiğinde tek kayıt tutulur, aynı sayısal ID film ve dizi ayrışır', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinetrack-store-test-'));
  try {
    const store = new PersistentDataStore({ dataDir: tmpDir });

    const movie1 = { id: 550, media_type: 'movie', title: 'Fight Club', vote_average: 8.4 };
    const movie1Dup = { id: 550, media_type: 'movie', title: 'Fight Club', vote_average: 8.4 };
    const tv1WithSameId = { id: 550, media_type: 'tv', name: 'Some TV Show', vote_average: 7.9 };

    const res1 = store.upsertCatalogItems([movie1, movie1Dup, tv1WithSameId]);
    assert.equal(res1.inserted, 2, '2 benzersiz kayıt (1 film, 1 dizi) eklenmeli');
    assert.equal(res1.unchanged, 1, 'Tekrarlayan Fight Club eklenmemeli');

    const movies = store.readCatalog('movie');
    const tv = store.readCatalog('tv');

    assert.ok(movies['movie:550'], 'movie:550 katalogda bulunmalı');
    assert.ok(tv['tv:550'], 'tv:550 katalogda bulunmalı');
    assert.equal(Object.keys(movies).length, 1, 'Katalogda sadece 1 film olmalı');
    assert.equal(Object.keys(tv).length, 1, 'Katalogda sadece 1 dizi olmalı');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Katalog No-op ve Güncelleme: Mevcut kayıt aynı payload ile gelince dosya yeniden yazılmaz; gerçek güncellemede tek kayıt güncellenir', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinetrack-store-test-'));
  try {
    const store = new PersistentDataStore({ dataDir: tmpDir });

    const initial = { id: 101, media_type: 'movie', title: 'Matrix', vote_average: 8.7, overview: 'Sci-fi classic' };
    store.upsertCatalogItems([initial]);
    const moviesFile = path.join(tmpDir, 'catalog', 'movies.json');
    const beforeContent = fs.readFileSync(moviesFile, 'utf8');

    const resNoop = store.upsertCatalogItems([initial]);
    assert.equal(resNoop.inserted, 0);
    assert.equal(resNoop.updated, 0);
    assert.equal(resNoop.unchanged, 1, 'Aynı içerik değişmemiş sayılmalı');
    assert.equal(fs.readFileSync(moviesFile, 'utf8'), beforeContent, 'Değişmeyen kayıt dosyayı yeniden yazmamalı');

    const updated = { id: 101, media_type: 'movie', title: 'The Matrix (Remastered)', vote_average: 8.8, overview: 'Sci-fi classic upgraded' };
    const resUpdate = store.upsertCatalogItems([updated]);
    assert.equal(resUpdate.updated, 1, 'Kayıt güncellenmeli');

    const movies = store.readCatalog('movie');
    assert.equal(Object.keys(movies).length, 1, 'Hala tek Matrix kaydı olmalı');
    assert.equal(movies['movie:101'].title, 'The Matrix (Remastered)');
    assert.equal(movies['movie:101'].vote_average, 8.8);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Katalog Alan Birleştirme: Kısmi payload mevcut zengin kaydı silmez', () => {
  const existingRich = {
    key: 'movie:200',
    id: 200,
    media_type: 'movie',
    title: 'Interstellar',
    overview: 'A team of explorers travel through a wormhole in space.',
    poster_path: '/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg',
    backdrop_path: '/xJHokMbljvjADYdit5fK5VQsXEG.jpg',
    genre_ids: [12, 18, 878],
    vote_average: 8.6,
    firstStoredAt: '2026-01-01T00:00:00.000Z',
    lastUpdatedAt: '2026-01-01T00:00:00.000Z',
  };

  const partialIncoming = {
    id: 200,
    media_type: 'movie',
    vote_average: 8.7,
  };

  const merged = mergeCatalogItem(existingRich, partialIncoming);
  assert.equal(merged.id, 200);
  assert.equal(merged.title, 'Interstellar');
  assert.equal(merged.overview, existingRich.overview);
  assert.equal(merged.poster_path, existingRich.poster_path);
  assert.deepEqual(merged.genre_ids, [12, 18, 878]);
  assert.equal(merged.vote_average, 8.7);
});

test('Faz A: Atomik JSON yazma başarısı, yazma ortası hata koruması, yarım .tmp temizliği ve bozuk JSON kurtarma / ezmeme koruması', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinetrack-atomic-test-'));
  try {
    const targetFile = path.join(tmpDir, 'sample.json');
    const backupFile = `${targetFile}.bak`;

    // 1. Atomik yazma başarı durumu
    writeJsonFileAtomic(targetFile, JSON.stringify({ hello: 'world', count: 1 }), {
      backupPath: backupFile,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(targetFile, 'utf8')), { hello: 'world', count: 1 });

    // 2. Yazma ortası hata: rename öncesinde hata oluşursa önceki geçerli JSON korunur ve .tmp temizlenir
    assert.throws(() => {
      writeJsonFileAtomic(targetFile, JSON.stringify({ hello: 'broken-mid-write', count: 2 }), {
        backupPath: backupFile,
        beforeRenameHook: (tempPath) => {
          assert.equal(fs.existsSync(tempPath), true, 'Geçici dosya oluşturulmuş olmalı');
          throw new Error('Simüle edilmiş disk/kesinti hatası');
        },
      });
    }, /Simüle edilmiş disk\/kesinti hatası/);

    assert.deepEqual(
      JSON.parse(fs.readFileSync(targetFile, 'utf8')),
      { hello: 'world', count: 1 },
      'Başarısız yazma sonrasında önceki geçerli JSON korunmalı'
    );
    const lingeringTmp = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
    assert.equal(lingeringTmp.length, 0, 'Hata sonrası geçici .tmp dosyası temizlenmeli');

    // 3. Önceki süreçten kalma yarım .tmp dosyaları açılışta kontrollü temizlenir
    const staleTmp = path.join(tmpDir, 'catalog', 'movies.json.9999.12345.1.tmp');
    fs.mkdirSync(path.dirname(staleTmp), { recursive: true });
    fs.writeFileSync(staleTmp, '{"incomplete":', 'utf8');
    const store = new PersistentDataStore({ dataDir: tmpDir });
    assert.equal(fs.existsSync(staleTmp), false, 'Yarım kalmış .tmp dosyası açılışta temizlenmeli');

    // 4. Geçerli .bak varken bozuk JSON kurtarma
    store.upsertCatalogItems([{ id: 10, media_type: 'movie', title: 'Inception', vote_average: 8.8 }]);
    store.upsertCatalogItems([{ id: 11, media_type: 'movie', title: 'Arrival', vote_average: 7.9 }]);
    const moviesPath = path.join(tmpDir, 'catalog', 'movies.json');
    assert.equal(fs.existsSync(`${moviesPath}.bak`), true, '.bak yedeği oluşmalı');

    // movies.json dosyasını boz -> .bak üzerinden kurtarılmalı
    fs.writeFileSync(moviesPath, '{corrupt_json_payload', 'utf8');
    const recoveredMovies = store.readCatalog('movie');
    assert.ok(recoveredMovies['movie:10'], 'Bozuk movies.json geçerli .bak yedeğinden kurtarılmalı');
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(moviesPath, 'utf8')));

    // 5. Yedeği OLMAYAN bozuk JSON sessizce boş veriyle ezilmez! (Katalog ve profil ayrı ayrı hata verir)
    const tvPath = path.join(tmpDir, 'catalog', 'tv.json');
    fs.writeFileSync(tvPath, '<<<BOZUK_TV_JSON>>>', 'utf8');
    assert.throws(
      () => store.upsertCatalogItems([{ id: 99, media_type: 'tv', name: 'Dark', vote_average: 8.7 }]),
      (err) => err instanceof CorruptJsonFileError,
      'Kurtarılamayan bozuk tv.json üzerine yazılmamalı, CorruptJsonFileError fırlatmalı'
    );
    assert.equal(
      fs.readFileSync(tvPath, 'utf8'),
      '<<<BOZUK_TV_JSON>>>',
      'Bozuk hedef dosyanın mevcut içeriği ezilmemeli'
    );

    // Katalog (tv.json) bozuk olsa bile bağımsız profil dosyası çalışmaya devam eder;
    // tersine profil dosyası bozuksa katalog etkilenmez!
    fs.unlinkSync(tvPath); // tv.json temizlendi
    const badProfilePath = store.getProfileFilePath('corrupt-prof');
    fs.writeFileSync(badProfilePath, '{bozuk_profil', 'utf8');
    assert.throws(
      () =>
        store.upsertDerivedProfile({
          profileId: 'corrupt-prof',
          algorithmVersion: '3.0.0',
          profileFingerprint: 'fp-1',
          items: {},
        }),
      (err) => err instanceof CorruptJsonFileError
    );
    // Aynı anda sağlıklı katalog güncellenebilir
    const catOk = store.upsertCatalogItems([{ id: 99, media_type: 'tv', name: 'Dark', vote_average: 8.7 }]);
    assert.equal(catOk.inserted, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Faz B: Tek kaynaklı boyut sınırı (UTF-8 bayt ölçümü), sınır altı/üstü kabul-ret ve mevcut dosyanın korunması', async () => {
  assert.equal(DEFAULT_MAX_DATA_BYTES, 25 * 1024 * 1024, 'Varsayılan sınır 25 MiB (26_214_400 bayt) olmalı');
  assert.equal(formatMaxDataLimitMb(DEFAULT_MAX_DATA_BYTES), '25 MB');

  // Çok baytlı UTF-8 karakter doğrulaması: karakter sayısı != bayt sayısı
  const multiByteSample = 'ğüşıöç🎬'.repeat(100);
  assert.ok(measureUtf8Bytes(multiByteSample) > multiByteSample.length);

  // Belge tutarlılığı: README.md ve ARCHITECTURE.md artık eski 2_000_000 sınırını içermemeli, 25 MB/MiB belirtmeli
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const arch = fs.readFileSync(path.join(repoRoot, 'ARCHITECTURE.md'), 'utf8');
  assert.equal(readme.includes('2_000_000'), false);
  assert.equal(arch.includes('2_000_000'), false);
  assert.ok(readme.includes('25 MB') || readme.includes('25 MiB'));
  assert.ok(arch.includes('25 MiB') || arch.includes('26_214_400'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinetrack-limit-test-'));
  try {
    const tightLimitBytes = 4_000;
    await withTestApp({ dataDir: tmpDir, maxDataBytes: tightLimitBytes }, async ({ baseUrl, storage }) => {
      // 1. Sınırın hemen altındaki çok baytlı UTF-8 payload kabul edilir
      const underLimitOverview = 'ğ'.repeat(800); // 1600 UTF-8 bayt
      const validPayload = {
        version: 3,
        activeProfileId: 'profile-main',
        profiles: [
          {
            id: 'profile-main',
            name: 'Ana Profil',
            createdAt: '2026-01-01T00:00:00.000Z',
            preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
            items: [
              {
                id: 101,
                media_type: 'movie',
                title: 'Kabul Edilen Film',
                overview: underLimitOverview,
                genre_ids: [18],
                vote_average: 8.1,
                vote_count: 500,
                popularity: 30,
                status: 'watchlist',
                personal_rating: '',
              },
            ],
          },
        ],
      };

      const acceptRes = await fetch(`${baseUrl}/api/data`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });
      assert.equal(acceptRes.status, 200, 'Sınırın altındaki istek kabul edilmeli');
      const diskBeforeReject = fs.readFileSync(storage.dataFile, 'utf8');

      // 2. Karakter uzunluğu < 4000 olduğu hâlde UTF-8 bayt uzunluğu > 4000 olan payload reddedilmeli (413)!
      const multiByteOverLimit = '🎬'.repeat(900); // length=1800 karakter, fakat UTF-8 = 3600 bayt (+ JSON zarfı > 4000 bayt!)
      assert.ok(multiByteOverLimit.length < tightLimitBytes, 'Karakter sayısı limitin altında');
      assert.ok(measureUtf8Bytes(multiByteOverLimit) + 600 > tightLimitBytes, 'UTF-8 bayt sayısı limitin üstünde');

      const overLimitPayload = {
        ...validPayload,
        profiles: [
          {
            ...validPayload.profiles[0],
            items: [
              {
                ...validPayload.profiles[0].items[0],
                overview: multiByteOverLimit,
              },
            ],
          },
        ],
      };

      const rejectRes = await fetch(`${baseUrl}/api/data`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(overLimitPayload),
      });
      assert.equal(rejectRes.status, 413, 'UTF-8 bayt sınırını aşan istek 413 ile reddedilmeli');
      const rejectJson = await rejectRes.json();
      assert.equal(rejectJson.code, 'payload_too_large');

      // Reddedilen istek diskteki mevcut dosyayı kesinlikle değiştirmemeli
      assert.equal(fs.readFileSync(storage.dataFile, 'utf8'), diskBeforeReject);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Faz C: Türetilmiş profil verisi (signals & reasons değişiklik tespiti, deterministik no-op, invalidation ve uçtan uca okuma)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinetrack-derived-cache-'));
  try {
    await withTestApp({ dataDir: tmpDir }, async ({ baseUrl, persistentStore }) => {
      // Katalog ekle
      persistentStore.upsertCatalogItems([
        { id: 550, media_type: 'movie', title: 'Fight Club', genre_ids: [18], vote_average: 8.4 },
      ]);
      const manifestHash = persistentStore.readCatalogManifest()?.contentHash || '';
      assert.ok(manifestHash.length > 10);

      // 1. İlk kayıt
      const initialUpsert = persistentStore.upsertDerivedProfile({
        profileId: 'profile-cache-test',
        algorithmVersion: 'v3.2-lifecycle-rings',
        profileFingerprint: 'fp-v1',
        sourceCatalogHash: manifestHash,
        items: {
          'movie:550': {
            mediaKey: 'movie:550',
            matchScore: 92,
            lifecycleRing: 'ring0',
            signals: { genre: 18, director: 12 },
            reasons: ['Dram uyumu', 'David Fincher'],
            calculatedAt: '2026-10-01T10:00:00.000Z',
          },
        },
      });
      assert.equal(initialUpsert.updated, true);

      // 2. Nesne anahtarı sırası farklı ve yeni calculatedAt verilse bile anlamlı alanlar aynıysa no-op olmalı!
      const noopUpsert = persistentStore.upsertDerivedProfile({
        profileId: 'profile-cache-test',
        algorithmVersion: 'v3.2-lifecycle-rings',
        profileFingerprint: 'fp-v1',
        sourceCatalogHash: manifestHash,
        items: {
          'movie:550': {
            mediaKey: 'movie:550',
            matchScore: 92,
            lifecycleRing: 'ring0',
            signals: { director: 12, genre: 18 }, // ters anahtar sırası
            reasons: ['Dram uyumu', 'David Fincher'],
            calculatedAt: '2026-10-25T23:59:59.000Z', // farklı zaman damgası
          },
        },
      });
      assert.equal(noopUpsert.updated, false, 'Anlamlı veri aynıyken gereksiz dosya yazımı yapılmamalı');

      // 3. Yalnızca `reasons` değiştiğinde yeni değer kalıcı kayda geçmeli!
      const reasonsChanged = persistentStore.upsertDerivedProfile({
        profileId: 'profile-cache-test',
        algorithmVersion: 'v3.2-lifecycle-rings',
        profileFingerprint: 'fp-v1',
        sourceCatalogHash: manifestHash,
        items: {
          'movie:550': {
            mediaKey: 'movie:550',
            matchScore: 92,
            lifecycleRing: 'ring0',
            signals: { genre: 18, director: 12 },
            reasons: ['Dram uyumu', 'Kült Başyapıt'], // SADECE reasons değişti
            calculatedAt: '2026-10-02T10:00:00.000Z',
          },
        },
      });
      assert.equal(reasonsChanged.updated, true, 'Yalnızca reasons değiştiğinde kayıt güncellenmeli');
      assert.deepEqual(
        persistentStore.readDerivedProfile('profile-cache-test')?.items['movie:550'].reasons,
        ['Dram uyumu', 'Kült Başyapıt']
      );

      // 4. Yalnızca `signals` değiştiğinde yeni değer kalıcı kayda geçmeli!
      const signalsChanged = persistentStore.upsertDerivedProfile({
        profileId: 'profile-cache-test',
        algorithmVersion: 'v3.2-lifecycle-rings',
        profileFingerprint: 'fp-v1',
        sourceCatalogHash: manifestHash,
        items: {
          'movie:550': {
            mediaKey: 'movie:550',
            matchScore: 92,
            lifecycleRing: 'ring0',
            signals: { genre: 20, director: 12 }, // SADECE signals değişti
            reasons: ['Dram uyumu', 'Kült Başyapıt'],
            calculatedAt: '2026-10-03T10:00:00.000Z',
          },
        },
      });
      assert.equal(signalsChanged.updated, true, 'Yalnızca signals değiştiğinde kayıt güncellenmeli');
      assert.equal(
        persistentStore.readDerivedProfile('profile-cache-test')?.items['movie:550'].signals?.genre,
        20
      );

      // 5. Uçtan uca HTTP üzerinden cache HIT ve invalidation (profil, katalog, algoritma, şema sürümü) testleri
      const hitRes = await fetch(
        `${baseUrl}/api/profiles/derived/profile-cache-test?profileFingerprint=fp-v1&algorithmVersion=v3.2-lifecycle-rings&sourceCatalogHash=${manifestHash}`
      );
      assert.equal(hitRes.status, 200, 'Aynı profil, algoritma ve katalog imzasında cache HIT dönmeli');
      const hitDoc = await hitRes.json();
      assert.equal(hitDoc.schemaVersion, DERIVED_PROFILE_SCHEMA_VERSION);

      // Profil tercihi değiştiğinde -> 409 cache miss
      const missFp = await fetch(
        `${baseUrl}/api/profiles/derived/profile-cache-test?profileFingerprint=fp-v2-changed&algorithmVersion=v3.2-lifecycle-rings&sourceCatalogHash=${manifestHash}`
      );
      assert.equal(missFp.status, 409);
      assert.equal((await missFp.json()).reason, 'profile_fingerprint_mismatch');

      // Algoritma sürümü değiştiğinde -> 409 cache miss
      const missAlg = await fetch(
        `${baseUrl}/api/profiles/derived/profile-cache-test?profileFingerprint=fp-v1&algorithmVersion=v9.9-new&sourceCatalogHash=${manifestHash}`
      );
      assert.equal(missAlg.status, 409);
      assert.equal((await missAlg.json()).reason, 'algorithm_version_mismatch');

      // Kaynak katalog verisi değiştiğinde -> 409 cache miss
      const missCat = await fetch(
        `${baseUrl}/api/profiles/derived/profile-cache-test?profileFingerprint=fp-v1&algorithmVersion=v3.2-lifecycle-rings&sourceCatalogHash=farkli-katalog-ozeti`
      );
      assert.equal(missCat.status, 409);
      assert.equal((await missCat.json()).reason, 'source_catalog_mismatch');

      // Şema sürümü değiştiğinde -> cache miss
      const schemaValidation = validateDerivedProfileCache(
        { ...hitDoc, schemaVersion: 1 },
        {
          profileId: 'profile-cache-test',
          profileFingerprint: 'fp-v1',
          algorithmVersion: 'v3.2-lifecycle-rings',
          sourceCatalogHash: manifestHash,
          expectedSchemaVersion: 2,
        }
      );
      assert.equal(schemaValidation.valid, false);
      if (!schemaValidation.valid) {
        assert.equal(schemaValidation.reason, 'schema_version_mismatch');
      }

      // 6. Cache doğruluk kaynağı olamaz: kullanıcı öğeyi sonradan listesine eklediyse (saved),
      // önbellekte 'active' görünse dahi canlı durum 'saved' olarak işaretlenir!
      const coldTasteMap = {
        profileId: 'profile-cache-test',
        entries: {},
        archivedEntries: {},
        lastRecommendedKeys: [],
      };
      const hydrated = hydrateTasteMapWithDerivedCache({
        tasteMap: coldTasteMap,
        derivedDoc: hitDoc,
        profileId: 'profile-cache-test',
        profileFingerprint: 'fp-v1',
        algorithmVersion: 'v3.2-lifecycle-rings',
        sourceCatalogHash: manifestHash,
        savedItems: [
          {
            id: 550,
            media_type: 'movie',
            title: 'Fight Club',
            genre_ids: [18],
            vote_average: 8.4,
            vote_count: 1000,
            popularity: 50,
            status: 'completed',
            personal_rating: 9,
          },
        ],
        preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
      });
      assert.equal(hydrated.cacheHit, true);
      assert.equal(hydrated.tasteMap.entries['movie:550'].matchScore, 92);
      assert.deepEqual(hydrated.tasteMap.entries['movie:550'].tags, ['Dram uyumu', 'Kült Başyapıt']);
      assert.equal(
        hydrated.tasteMap.entries['movie:550'].status,
        'saved',
        'Önbellek, kullanıcının güncel izleme listesini ezemez'
      );

      // buildDerivedProfilePayloadFromTasteMap doğrulaması
      const rebuiltPayload = buildDerivedProfilePayloadFromTasteMap({
        profileId: 'profile-cache-test',
        tasteMap: hydrated.tasteMap,
        profileFingerprint: 'fp-v1',
        algorithmVersion: 'v3.2-lifecycle-rings',
        sourceCatalogHash: manifestHash,
      });
      assert.deepEqual(rebuiltPayload.items['movie:550'].signals, { director: 12, genre: 20 });
      assert.deepEqual(rebuiltPayload.items['movie:550'].reasons, ['Dram uyumu', 'Kült Başyapıt']);

      // App.tsx içinde fetchDerivedProfileData'nın gerçekten çağrıldığının statik doğrulaması
      const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
      const appCode = fs.readFileSync(path.join(repoRoot, 'src/App.tsx'), 'utf8');
      assert.ok(
        appCode.includes('fetchDerivedProfileData('),
        'App.tsx öneri akışında fetchDerivedProfileData gerçekten çağrılmalı'
      );
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Faz D: GitHub senkronizasyonu (ilk sync, no-op, 409 retry, rate limit, ağ hatası, kısmi hata + kaldığı yerden devam, görünürlük uyarısı ve token gizliliği)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinetrack-gh-sync-'));
  const originalFetch = globalThis.fetch;
  try {
    const secretToken = 'github_pat_SUPER_SECRET_TOKEN_987654321';
    const store = new PersistentDataStore({
      dataDir: tmpDir,
      githubToken: secretToken,
      githubOwner: 'owner-x',
      githubRepo: 'private-vault',
      githubBranch: 'main',
      isPublicRepo: false,
    });

    store.upsertCatalogItems([{ id: 550, media_type: 'movie', title: 'Fight Club', vote_average: 8.4 }]);
    store.upsertDerivedProfile({
      profileId: 'profile-1',
      algorithmVersion: '3.0.0',
      profileFingerprint: 'fp-1',
      items: {
        'movie:550': { mediaKey: 'movie:550', matchScore: 90, lifecycleRing: 'ring0', calculatedAt: '2026-10-01' },
      },
    });

    // Sanal uzak GitHub deposu durumu
    const remoteFiles = new Map();
    let repoPrivateFlag = true;
    let failProfileWithRateLimitOnce = true;
    let simulateConflictOnMoviesOnce = false;
    let putCallLog = [];

    globalThis.fetch = async (url, init = {}) => {
      const urlStr = String(url);
      const method = (init.method || 'GET').toUpperCase();

      // Repo metadata endpoint
      if (urlStr === 'https://api.github.com/repos/owner-x/private-vault') {
        return new Response(JSON.stringify({ private: repoPrivateFlag }), { status: 200 });
      }

      const match = urlStr.match(/\/contents\/([^?]+)/);
      const repoPath = match ? decodeURIComponent(match[1]) : '';

      if (method === 'GET') {
        const existing = remoteFiles.get(repoPath);
        if (!existing) {
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        }
        return new Response(
          JSON.stringify({
            sha: existing.sha,
            content: Buffer.from(existing.content, 'utf8').toString('base64'),
          }),
          { status: 200 }
        );
      }

      if (method === 'PUT') {
        putCallLog.push(repoPath);
        const body = JSON.parse(String(init.body || '{}'));

        if (repoPath === 'data/profiles/profile-1.json' && failProfileWithRateLimitOnce) {
          failProfileWithRateLimitOnce = false;
          return new Response(
            JSON.stringify({ message: `API rate limit exceeded with Bearer ${secretToken}` }),
            {
              status: 403,
              headers: { 'x-ratelimit-remaining': '0' },
            }
          );
        }

        if (repoPath === 'data/catalog/movies.json' && simulateConflictOnMoviesOnce) {
          simulateConflictOnMoviesOnce = false;
          remoteFiles.set(repoPath, {
            sha: 'sha-updated-concurrently',
            content: '{"concurrent":true}',
          });
          return new Response(JSON.stringify({ message: 'sha does not match' }), { status: 409 });
        }

        const existing = remoteFiles.get(repoPath);
        if (existing && body.sha !== existing.sha) {
          return new Response(JSON.stringify({ message: 'Conflict sha mismatch' }), { status: 409 });
        }

        const decoded = Buffer.from(body.content, 'base64').toString('utf8');
        const newSha = `sha-${putCallLog.length}`;
        remoteFiles.set(repoPath, { sha: newSha, content: decoded });
        return new Response(JSON.stringify({ content: { sha: newSha } }), { status: 201 });
      }

      return new Response('Unhandled', { status: 500 });
    };

    // 1. İlk senkronizasyon: katalog başarılı, profil rate_limit ile başarısız -> KISMİ BAŞARISIZLIK!
    const sync1 = await store.syncToGitHub();
    assert.equal(sync1.ok, false, 'Tek dosya başarısız olduğunda tüm senkronizasyon başarılı gösterilmemeli');
    assert.equal(sync1.partialFailure, true, 'Kısmi başarısızlık açıkça işaretlenmeli');
    assert.ok(sync1.filesCommitted.includes('data/catalog/movies.json'));
    assert.deepEqual(sync1.filesFailed, ['data/profiles/profile-1.json']);
    assert.equal(sync1.fileStates['data/catalog/movies.json'].status, 'succeeded');
    assert.equal(sync1.fileStates['data/profiles/profile-1.json'].status, 'failed');
    assert.equal(sync1.fileStates['data/profiles/profile-1.json'].errorCategory, 'rate_limit');

    // Hata mesajında gerçek GitHub token kesinlikle sızmamalı!
    for (const errText of sync1.errors) {
      assert.equal(errText.includes(secretToken), false, 'Hata mesajında token bulunmamalı');
    }
    assert.equal(redactSecrets(`Auth Bearer ${secretToken}`), 'Auth Bearer [REDACTED]');

    // 2. Yeniden deneme: katalog dosyaları değişmediği için yeniden PUT yapılmaz; başarısız profil dosyasından devam edilir!
    putCallLog = [];
    const sync2 = await store.syncToGitHub();
    assert.equal(sync2.ok, true, 'Yeniden denemede kalan başarısız dosya tamamlanmalı');
    assert.deepEqual(putCallLog, ['data/profiles/profile-1.json'], 'Sadece başarısız kalan dosya yeniden gönderilmeli');
    assert.ok(sync2.filesSkipped.includes('data/catalog/movies.json'));
    assert.equal(sync2.fileStates['data/profiles/profile-1.json'].status, 'succeeded');

    // 3. Değişmemiş içerikte 3. senkronizasyon hiçbir commit üretmez
    putCallLog = [];
    const sync3 = await store.syncToGitHub();
    assert.equal(sync3.ok, true);
    assert.equal(putCallLog.length, 0, 'Değişmemiş içerik için GitHub commit üretilmemeli');

    // 4. İçerik güncellemesi + HTTP 409 çakışma ve sınırlı retry ile başarı
    simulateConflictOnMoviesOnce = true;
    store.upsertCatalogItems([{ id: 551, media_type: 'movie', title: 'Se7en', vote_average: 8.3 }]);
    const sync4 = await store.syncToGitHub();
    assert.equal(sync4.ok, true, '409 çakışması güncel SHA çekilerek sınırlı retry ile çözülmeli');
    assert.ok(sync4.filesCommitted.includes('data/catalog/movies.json'));

    // 5. Uzak depo gerçekte PUBLIC iken CINETRACK_DATA_REPO_IS_PUBLIC=false ise:
    // Uyarı üretilmeli ve kişisel profil dosyaları açık depoya gönderilmemeli!
    repoPrivateFlag = false;
    store.upsertDerivedProfile({
      profileId: 'profile-1',
      algorithmVersion: '3.0.0',
      profileFingerprint: 'fp-2',
      items: {},
    });
    putCallLog = [];
    const syncPublicMismatch = await store.syncToGitHub();
    assert.ok(syncPublicMismatch.repoVisibilityWarning, 'Public/private uyumsuzluğu raporlanmalı');
    assert.equal(
      putCallLog.some((p) => p.startsWith('data/profiles/')),
      false,
      'Uzak depo gerçekte public iken kişisel profil dosyası asla gönderilmemeli'
    );

    // 6. Ağ hatası sınıflandırması (sonsuz döngü olmadan sınırlı deneme)
    let networkAttempts = 0;
    globalThis.fetch = async () => {
      networkAttempts++;
      throw new Error(`ECONNRESET while using ${secretToken}`);
    };
    const netFail = await store.commitFileToGitHub('data/catalog/movies.json', '{}', 'test');
    assert.equal(netFail.ok, false);
    assert.equal(netFail.errorCategory, 'network_error');
    assert.equal(netFail.error?.includes(secretToken), false);
    assert.equal(networkAttempts, 1, 'İlk GET ağ hatasında anında kontrollü dönmeli');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Faz D: 7 döner sunucu yedeği sınırı, bozuk yedeğin geri yüklenmemesi ve sağlam verinin korunması', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinetrack-backups-test-'));
  try {
    const storage = createDataStorage({ dataDir: tmpDir, maxSnapshots: 7 });

    // 10 ardışık güncelleme yap -> en yeni 7 geçerli snapshot korunmalı
    for (let i = 1; i <= 10; i++) {
      const res = storage.saveData({
        version: 3,
        activeProfileId: 'profile-1',
        profiles: [
          {
            id: 'profile-1',
            name: `Profil Tur ${i}`,
            createdAt: '2026-01-01T00:00:00.000Z',
            preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
            items: Array.from({ length: 6 }, (_, idx) => ({
              id: 100 + idx,
              media_type: 'movie',
              title: `Film ${idx} (v${i})`,
              genre_ids: [18],
              vote_average: 8.0,
              vote_count: 100,
              popularity: 20,
              status: 'watchlist',
              personal_rating: '',
            })),
          },
        ],
      });
      assert.equal(res.ok, true);
    }

    const snapshotFiles = fs
      .readdirSync(storage.backupsDir)
      .filter((f) => f.startsWith('cinetrack-') && f.endsWith('.json'));
    assert.equal(snapshotFiles.length, 7, 'Döner yedek sayısı en fazla 7 ile sınırlı kalmalı');

    // Bozuk bir yedek dosyası oluşturulduğunda mevcut sağlam verinin üzerine geri yüklenmemeli!
    const corruptBackupName = 'cinetrack-2026-10-25-rev99-corrupt.json';
    fs.writeFileSync(path.join(storage.backupsDir, corruptBackupName), '{bozuk_yedek_json', 'utf8');

    const invalidSchemaBackupName = 'cinetrack-2026-10-25-rev98-invalidschema.json';
    fs.writeFileSync(
      path.join(storage.backupsDir, invalidSchemaBackupName),
      JSON.stringify({ unexpected: true }),
      'utf8'
    );

    const beforeRestoreDoc = storage.readData();
    assert.equal(beforeRestoreDoc.profiles[0].name, 'Profil Tur 10');

    assert.equal(storage.restoreBackup(corruptBackupName), null, 'Bozuk JSON yedek reddedilmeli');
    assert.equal(storage.restoreBackup(invalidSchemaBackupName), null, 'Şeması geçersiz yedek reddedilmeli');

    const afterRejectedRestore = storage.readData();
    assert.equal(
      afterRejectedRestore.profiles[0].name,
      'Profil Tur 10',
      'Başarısız geri yükleme mevcut geçerli veriyi değiştirmemeli'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Sır İzolasyonu: İstemci kodu ve .env.example içinde hiçbir GitHub token veya VITE_ sırrı sızmaz', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');

  assert.equal(envExample.includes('ghp_'), false);
  assert.equal(envExample.includes('github_pat_'), false);
  assert.equal(envExample.includes('VITE_'), false);

  const clientFiles = [
    'src/services/api.ts',
    'src/App.tsx',
    'src/core/cinetrack-core.ts',
    'src/core/recommendation-orchestrator.ts',
    'src/core/derived-profile-cache.ts',
  ];
  for (const rel of clientFiles) {
    const full = path.join(repoRoot, rel);
    if (fs.existsSync(full)) {
      const code = fs.readFileSync(full, 'utf8');
      assert.equal(code.includes('CINETRACK_GITHUB_TOKEN'), false, `${rel} içinde GitHub token referansı olmamalı`);
      assert.equal(code.includes('CINETRACK_GITHUB_PAT'), false, `${rel} içinde GitHub token referansı olmamalı`);
    }
  }
});

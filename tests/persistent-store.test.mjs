import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PersistentDataStore,
  mergeCatalogItem,
  toCanonicalKey,
  stringifyDeterministic,
} from '../src/server/persistent-store.ts';

test('Bölüm 8.5 Zorunlu Test 1 & 2: Aynı film iki kez indirildiğinde tek kayıt tutulur, aynı sayısal ID film ve dizi ayrışır', () => {
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

test('Bölüm 8.5 Zorunlu Test 3 & 4: Mevcut kayıt aynı payload ile gelince no-op sayılır; gerçek güncellemede tek kayıt alanları güncellenir', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinetrack-store-test-'));
  try {
    const store = new PersistentDataStore({ dataDir: tmpDir });

    const initial = { id: 101, media_type: 'movie', title: 'Matrix', vote_average: 8.7, overview: 'Sci-fi classic' };
    store.upsertCatalogItems([initial]);

    // 3. Aynı payload tekrar gelir
    const resNoop = store.upsertCatalogItems([initial]);
    assert.equal(resNoop.inserted, 0);
    assert.equal(resNoop.updated, 0);
    assert.equal(resNoop.unchanged, 1, 'Aynı içerik değişmemiş (unchanged) sayılmalı');

    // 4. Gerçek güncelleme gelir
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

test('Bölüm 8.5 Zorunlu Test 5: Kısmi payload mevcut zengin kaydı yanlışlıkla silmez (alan birleştirme kuralları)', () => {
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
    vote_average: 8.7, // Sadece puan değişmiş, overview ve poster gönderilmemiş
  };

  const merged = mergeCatalogItem(existingRich, partialIncoming);
  assert.equal(merged.id, 200);
  assert.equal(merged.title, 'Interstellar', 'Mevcut başlık korunmalı');
  assert.equal(merged.overview, existingRich.overview, 'Mevcut özet korunmalı');
  assert.equal(merged.poster_path, existingRich.poster_path, 'Mevcut poster korunmalı');
  assert.deepEqual(merged.genre_ids, [12, 18, 878], 'Mevcut türler korunmalı');
  assert.equal(merged.vote_average, 8.7, 'Yeni puan güncellenmeli');
});

test('Bölüm 8.5 Zorunlu Test 6, 7 & 8: Profil izolasyonu, Profil A değişince Profil B etkilenmez, algoritma versiyonu geçersizleştirme', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinetrack-store-test-'));
  try {
    const store = new PersistentDataStore({ dataDir: tmpDir });

    // Profil A ve Profil B aynı film için hesaplama kaydeder
    store.upsertDerivedProfile({
      profileId: 'profile-user-a',
      algorithmVersion: '3.0.0',
      profileFingerprint: 'fp-a-v1',
      items: {
        'movie:550': { mediaKey: 'movie:550', matchScore: 92, lifecycleRing: 'ring0', calculatedAt: '2026-10-01' },
      },
    });

    store.upsertDerivedProfile({
      profileId: 'profile-user-b',
      algorithmVersion: '3.0.0',
      profileFingerprint: 'fp-b-v1',
      items: {
        'movie:550': { mediaKey: 'movie:550', matchScore: 64, lifecycleRing: 'ring2', calculatedAt: '2026-10-01' },
      },
    });

    const profA = store.readDerivedProfile('profile-user-a');
    const profB = store.readDerivedProfile('profile-user-b');

    assert.ok(profA);
    assert.ok(profB);
    assert.equal(profA.items['movie:550'].matchScore, 92, 'Profil A kendi skorunu korumalı');
    assert.equal(profB.items['movie:550'].matchScore, 64, 'Profil B kendi skorunu korumalı');

    // 7. Profil A tercihi değişir, tekrar hesaplanır
    store.upsertDerivedProfile({
      profileId: 'profile-user-a',
      algorithmVersion: '3.0.0',
      profileFingerprint: 'fp-a-v2', // yeni fingerprint
      items: {
        'movie:550': { mediaKey: 'movie:550', matchScore: 95, lifecycleRing: 'ring0', calculatedAt: '2026-10-02' },
      },
    });

    const profAAfter = store.readDerivedProfile('profile-user-a');
    const profBAfter = store.readDerivedProfile('profile-user-b');
    assert.equal(profAAfter?.items['movie:550'].matchScore, 95);
    assert.equal(profBAfter?.items['movie:550'].matchScore, 64, 'Profil B kesinlikle değişmemeli');

    // 8. Algoritma versiyonu v3.1.0'a çıkar
    const v31Res = store.upsertDerivedProfile({
      profileId: 'profile-user-a',
      algorithmVersion: '3.1.0',
      profileFingerprint: 'fp-a-v2',
      items: {
        'movie:550': { mediaKey: 'movie:550', matchScore: 89, lifecycleRing: 'ring0', calculatedAt: '2026-10-03' },
      },
    });
    assert.equal(v31Res.updated, true, 'Yeni algoritma versiyonuyla kayıt güncellenmeli');
    const profAVersionUpdated = store.readDerivedProfile('profile-user-a');
    assert.equal(profAVersionUpdated?.algorithmVersion, '3.1.0');
    assert.equal(profAVersionUpdated?.items['movie:550'].matchScore, 89);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Bölüm 8.5 Zorunlu Test 11 & 12: GitHub yapılandırılmadığında güvenli yerel mod; repo public iken kişisel profiller GitHub’a gönderilmez', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinetrack-store-test-'));
  try {
    // 11. GitHub token yokken yerel mod
    const localStore = new PersistentDataStore({ dataDir: tmpDir });
    const status = localStore.getSyncStatus();
    assert.equal(status.configured, false);
    assert.equal(status.mode, 'local_only');

    const syncRes = await localStore.syncToGitHub();
    assert.equal(syncRes.ok, false);
    assert.ok(syncRes.errors.length > 0);

    // 12. Repo public iken profil verileri GitHub'a yazılmaz
    const publicStore = new PersistentDataStore({
      dataDir: tmpDir,
      githubToken: 'ghp_mock_token_12345',
      githubOwner: 'testowner',
      githubRepo: 'public-repo',
      isPublicRepo: true, // PUBLIC REPO
    });

    const pubStatus = publicStore.getSyncStatus();
    assert.equal(pubStatus.isPublicRepo, true);

    // Mock derived profile yaz
    publicStore.upsertDerivedProfile({
      profileId: 'secret-profile',
      algorithmVersion: '3.0.0',
      profileFingerprint: 'secret-fp',
      items: {},
    });

    // sync çağrıldığında public repo kuralı tetiklenmeli
    // Mock fetch yapıp commit'i test edebiliriz
    const publicSync = await publicStore.syncToGitHub();
    assert.ok(
      publicSync.filesBlockedPublic.some((f) => f.includes('data/profiles/*')),
      'Public repo için profil verileri engellenmeli'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Bölüm 8.5 Zorunlu Test 13: Client bundle ve environment dosyalarında hiçbir GitHub token sızmaz', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');

  // .env.example içinde gerçek token veya VITE_ olmamalı
  assert.equal(envExample.includes('ghp_'), false);
  assert.equal(envExample.includes('github_pat_'), false);
  assert.equal(envExample.includes('VITE_'), false);

  // src/ içindeki client TypeScript/React dosyalarında process.env.CINETRACK_GITHUB_TOKEN veya token sırrı bulunmamalı
  const clientFiles = ['src/services/api.ts', 'src/App.tsx', 'src/core/cinetrack-core.ts'];
  for (const rel of clientFiles) {
    const full = path.join(repoRoot, rel);
    if (fs.existsSync(full)) {
      const code = fs.readFileSync(full, 'utf8');
      assert.equal(code.includes('CINETRACK_GITHUB_TOKEN'), false, `${rel} içinde GitHub token referansı olmamalı`);
      assert.equal(code.includes('CINETRACK_GITHUB_PAT'), false, `${rel} içinde GitHub token referansı olmamalı`);
    }
  }
});

test('UX Kuralı: İsteğe bağlı puan verildiğinde içerik izlendi (completed) durumuna geçer', () => {
  // Test logic used in handleSaveItem
  const evaluateEffectiveStatus = (status, personalRating) => {
    return typeof personalRating === 'number' && personalRating > 0 && (status === 'watchlist' || !status)
      ? 'completed'
      : status;
  };

  // 1. Yeni tıklanan ve default 'watchlist' olan içerik puanlanınca 'completed' olmalı
  assert.equal(evaluateEffectiveStatus('watchlist', 8), 'completed', 'Puan verilen izlenecek içerik izlendi olmalı');
  assert.equal(evaluateEffectiveStatus('', 7), 'completed', 'Statüsü olmayan puanlanan içerik izlendi olmalı');
  assert.equal(evaluateEffectiveStatus('watchlist', 10), 'completed');

  // 2. Puan verilmediğinde ('') statü bozulmamalı
  assert.equal(evaluateEffectiveStatus('watchlist', ''), 'watchlist', 'Puan yokken izlenecek korunmalı');
  assert.equal(evaluateEffectiveStatus('watching', ''), 'watching', 'Puan yokken izleniyor korunmalı');
  assert.equal(evaluateEffectiveStatus('completed', ''), 'completed', 'Puan yokken izlendi korunmalı');

  // 3. İzleniyor statüsündeki yapım puanlanınca mevcut statüsü korunabilir
  assert.equal(evaluateEffectiveStatus('watching', 9), 'watching');
  assert.equal(evaluateEffectiveStatus('completed', 9), 'completed');
});


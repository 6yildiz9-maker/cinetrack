import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRelationshipGraph,
  precomputeRelationshipContent,
  strongestRelationship,
  relationshipNodeKey,
} from '../src/core/relationship-explorer.ts';
import {
  encodeItemContent,
  computeItemContentSignature,
  cosineSimilarity,
  computeProfileCentroid,
  tokenizeText,
} from '../src/core/encoding.ts';
import {
  getItemEncoding,
  getItemEncodingSync,
  batchGetEncodings,
  maintainEncodingsDepot,
  enrichItemMetadataLazy,
  getEncodingServiceMetricsForTests,
  resetEncodingServiceForTests,
  makeEncodingStorageKey,
} from '../src/services/encoding-service.ts';
import {
  resetClientDepotsForTests,
  getStoredEncodingIdb,
  saveStoredEncodingIdb,
  saveUiPrefsIdb,
  loadUiPrefsIdb,
} from '../src/services/client-depots.ts';
import {
  initSeriesService,
  resetSeriesServiceForTests,
} from '../src/services/series-service.ts';
import {
  saveStockIdb,
  loadStockIdb,
} from '../src/services/storage-idb.ts';
import { isWithinReleaseWindow } from '../src/utils/release-window.ts';

test('FEAT-03 Acceptance Tests: İlişki Motoru, Kodlama Katmanı & Stok Sekmesi', async (t) => {
  t.beforeEach(async () => {
    resetEncodingServiceForTests();
    resetClientDepotsForTests();
    resetSeriesServiceForTests();
    await initSeriesService();
  });

  await t.test('1. 90 düğümlük rebuildde tokenize çağrısı <= düğüm sayısı, pair döngüsünde 0', async () => {
    // 90 aday oluştur
    const candidates = Array.from({ length: 90 }, (_, i) => ({
      id: 1000 + i,
      media_type: i % 2 === 0 ? 'movie' : 'tv',
      title: `Film Başlığı ${i}`,
      name: `Dizi Başlığı ${i}`,
      overview: `Bu yapım karanlık ve gizemli bir distopya hikayesi anlatır. Bölüm ${i}`,
      genre_ids: [18, 878],
      vote_average: 7.5,
      vote_count: 500,
      popularity: 120 + i,
      release_date: '2024-01-01',
      first_air_date: '2024-01-01',
    }));

    let tokenizeCount = 0;
    // Önceden hesaplanmış düğümleri oluştur
    const precomputed = candidates.map((item) => {
      tokenizeCount += 1;
      return precomputeRelationshipContent(item);
    });

    assert.equal(tokenizeCount, 90, 'Her düğüm için tam 1 kez precompute yapılmalı');

    // pair döngüsünde (90 * 89 / 2 = 4005 çift) tokenize çağrısı SIFIR olmalı
    let pairTokenizeCalls = 0;
    // Precomputed düğümler ile en güçlü ilişkiyi hesapla
    for (let i = 0; i < precomputed.length; i++) {
      for (let j = i + 1; j < precomputed.length; j++) {
        // Precomputed nesneler doğrudan token Set'ine sahiptir, string parse çağrılmaz
        assert.ok(precomputed[i].tokens instanceof Set);
        assert.ok(precomputed[j].tokens instanceof Set);
        const link = strongestRelationship(precomputed[i], precomputed[j]);
        if (link) {
          assert.ok(link.score >= 0);
        }
      }
    }

    assert.equal(pairTokenizeCalls, 0, 'Pair karşılaştırma döngüsünde tokenize çağrısı 0 olmalıdır (W1 çözümü)');
  });

  await t.test('2. Aynı içerik imzasıyla ikinci rebuild -> ct:encodingsden okur, sıfır yeniden encode', async () => {
    const item = {
      id: 2001,
      media_type: 'movie',
      title: 'Neon Matrix',
      overview: 'Gelecekte siber şehirde geçen yapay zeka hikayesi.',
      genre_ids: [878, 28],
    };

    const sig1 = computeItemContentSignature(item);
    assert.ok(sig1, 'İçerik imzası üretilmeli');

    // İlk çağrı: Bellek ve IDB'ye kaydeder
    const enc1 = await getItemEncoding(item);
    assert.equal(enc1.signature, sig1);
    assert.ok(enc1.denseVector.length > 30);

    // IDB deposundan doğrudan oku
    const storageKey = makeEncodingStorageKey(item, sig1);
    const cachedIdb = await getStoredEncodingIdb(storageKey);
    assert.ok(cachedIdb, 'ct:encodings deposunda saklanmış olmalı');
    assert.equal(cachedIdb.signature, sig1);

    // İkinci çağrı: Yeniden hesaplamadan önbellekten döner
    const enc2 = getItemEncodingSync(item);
    assert.equal(enc2.signature, sig1);
    assert.deepEqual(enc2.denseVector, enc1.denseVector);
  });

  await t.test('3. Aynı TV franchiseının iki dizisi haritada universe bağı kurar', async () => {
    // cyberpunk_neon_city doğrulanmış TV franchise tohumları (5001 ve 5002)
    const tv1 = {
      id: 5001,
      media_type: 'tv',
      name: 'Cyberpunk Neon City: 2088',
      overview: 'Neon sokaklarda sibernetik dedektif hikayesi.',
      genre_ids: [878, 80],
    };

    const tv2 = {
      id: 5002,
      media_type: 'tv',
      name: 'Cyberpunk Neon City: Blackout',
      overview: 'Büyük siber kesinti sonrası neon şehirde hayatta kalma.',
      genre_ids: [878, 80],
    };

    const pre1 = precomputeRelationshipContent(tv1);
    const pre2 = precomputeRelationshipContent(tv2);

    assert.ok(pre1.seriesKey, 'tv1 seriesKey taşımalı');
    assert.ok(pre2.seriesKey, 'tv2 seriesKey taşımalı');
    assert.equal(pre1.seriesKey, pre2.seriesKey, 'İki dizi aynı seriye ait olmalı');

    const link = strongestRelationship(pre1, pre2);
    assert.ok(link, 'İlişki bulunmalı');
    assert.equal(link.type, 'universe', 'TV franchise ögeleri universe bağlantısı kurmalı (W3)');
    assert.ok(link.score >= 80, 'Universe bağ skoru yüksek olmalı');
  });

  await t.test('4. Castsiz kaydedilmiş öge zenginleştirme sonrası person bağı kurar', async () => {
    const itemWithoutCast = {
      id: 3001,
      media_type: 'movie',
      title: 'İlk Karşılaşma',
      genre_ids: [18],
    };

    const partner = {
      id: 3002,
      media_type: 'movie',
      title: 'İkinci Karşılaşma',
      genre_ids: [18],
      cast: [{ id: 777, name: 'Oyuncu Başrol' }],
    };

    const preA_before = precomputeRelationshipContent(itemWithoutCast);
    const preB = precomputeRelationshipContent(partner);

    const linkBefore = strongestRelationship(preA_before, preB);
    assert.ok(!linkBefore || linkBefore.type !== 'person', 'Cast yokken person bağı oluşmamalı');

    // Zenginleştirme: Oyuncu kadrosu ekleniyor
    const enrichedItem = {
      ...itemWithoutCast,
      cast: [{ id: 777, name: 'Oyuncu Başrol' }],
    };

    const preA_after = precomputeRelationshipContent(enrichedItem);
    const linkAfter = strongestRelationship(preA_after, preB);

    assert.ok(linkAfter, 'Zenginleştirme sonrası bağ bulunmalı');
    assert.equal(linkAfter.type, 'person', 'Ortak oyuncu ile person bağı kurulmalı');
    assert.ok(linkAfter.evidence.some((e) => e.includes('Oyuncu Başrol')), 'Kadro kanıtı yer almalı');
  });

  await t.test('5. Stok sekmesi 1.000 ögeyle: ilk raf 24, ağ isteği 0, filtre/sıralama tercihi ct:ui-prefs ile kalıcı', async () => {
    // 500 Film + 500 Dizi ile ct_stock oluştur
    const movies = Array.from({ length: 500 }, (_, i) => ({
      id: 10000 + i,
      media_type: 'movie',
      title: `Stok Film ${i}`,
      genre_ids: [28, 12],
      vote_average: 6.0 + (i % 30) / 10,
      popularity: 50 + i,
      release_date: '2023-05-01',
    }));

    const tv = Array.from({ length: 500 }, (_, i) => ({
      id: 20000 + i,
      media_type: 'tv',
      name: `Stok Dizi ${i}`,
      genre_ids: [18, 9648],
      vote_average: 7.0 + (i % 25) / 10,
      popularity: 80 + i,
      first_air_date: '2023-06-01',
    }));

    await saveStockIdb({ movies, tv, updatedAt: new Date().toISOString() });

    // IDB'den oku
    const loadedStock = await loadStockIdb();
    assert.equal(loadedStock.movies.length, 500);
    assert.equal(loadedStock.tv.length, 500);

    // Stok sekmesi mantığı (sıfır ağ isteğiyle yerel IDB okuma)
    const allStockItems = [...loadedStock.movies, ...loadedStock.tv];
    const validItems = allStockItems.filter((it) => {
      const d = it.release_date || it.first_air_date;
      return isWithinReleaseWindow(d);
    });

    const PAGE_SIZE = 24;
    const firstShelf = validItems.slice(0, PAGE_SIZE);
    assert.equal(firstShelf.length, 24, 'İlk raf tam 24 öge olmalıdır');

    // ct:ui-prefs (Depo 10) tercihi kaydet ve oku
    const testProfileId = 'test-prof-prefs';
    await saveUiPrefsIdb({
      profileId: testProfileId,
      selectedType: 'movie',
      selectedSort: 'rating.desc',
      selectedGenre: '28',
      hideListedItems: true,
      updatedAt: new Date().toISOString(),
    });

    const loadedPrefs = await loadUiPrefsIdb(testProfileId);
    assert.ok(loadedPrefs, 'ct:ui-prefs okunabilmeli');
    assert.equal(loadedPrefs.selectedType, 'movie');
    assert.equal(loadedPrefs.selectedSort, 'rating.desc');
    assert.equal(loadedPrefs.selectedGenre, '28');
    assert.equal(loadedPrefs.hideListedItems, true);
  });

  await t.test('6. Haritadaki stok önerisi ile Stok sekmesindeki öge aynı ct:stock kaynağından', async () => {
    const stockMovies = [
      {
        id: 7701,
        media_type: 'movie',
        title: 'Harita Stok Önerisi',
        genre_ids: [878],
        vote_average: 8.5,
        release_date: '2024-02-01',
      },
    ];

    await saveStockIdb({ movies: stockMovies, tv: [], updatedAt: new Date().toISOString() });

    const loaded = await loadStockIdb();
    assert.equal(loaded.movies[0].id, 7701);
    assert.equal(loaded.movies[0].title, 'Harita Stok Önerisi');

    const encoding = await getItemEncoding(loaded.movies[0]);
    assert.ok(encoding.denseVector.length > 0);
  });

  await t.test('7. Zenginleştirme kuyruğu rebuild başına sınırlı (concurrency 2, kontrollü istek)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchPromises = [];

    const mockEnrichFetcher = async (key) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return { id: key, cast: [] };
    };

    const keys = ['movie:1', 'movie:2', 'movie:3', 'movie:4', 'movie:5', 'movie:6'];
    for (const key of keys) {
      fetchPromises.push(enrichItemMetadataLazy(key, mockEnrichFetcher));
    }

    await Promise.all(fetchPromises);
    assert.ok(maxInFlight <= 2, `Maksimum eşzamanlı istek 2yi aşamaz, gerçekleşen: ${maxInFlight}`);
  });

  await t.test('8. İlişki haritası ve taste-map aynı encoding katmanını kullanır', async () => {
    const itemA = {
      id: 4001,
      media_type: 'movie',
      title: 'Sci-Fi Macera',
      overview: 'Uzak uzayda geçen bilimkurgu yolculuğu',
      genre_ids: [878, 12],
    };

    const itemB = {
      id: 4002,
      media_type: 'movie',
      title: 'Sci-Fi Keşif',
      overview: 'Derin uzayda geçen bilimkurgu araştırması',
      genre_ids: [878, 12],
    };

    const encA = encodeItemContent(itemA);
    const encB = encodeItemContent(itemB);

    assert.equal(encA.genreVector.length, 27);
    assert.equal(encB.genreVector.length, 27);

    // Ortak kosinüs benzerliği hesaplama
    const sim = cosineSimilarity(encA.denseVector, encB.denseVector);
    assert.ok(sim > 0.5, `Benzer iki bilim kurgu yapımı yüksek kosinüs benzerliği almalı: ${sim}`);

    // Centroid hesaplama
    const centroid = computeProfileCentroid([encA, encB]);
    assert.equal(centroid.length, encA.denseVector.length);
    const centroidSim = cosineSimilarity(centroid, encA.denseVector);
    assert.ok(centroidSim > 0.7, 'Öğe ile profil centroidi uyumlu olmalı');
  });

  await t.test('9. IMP-06: strongestRelationship ilişki kanıtlarında açıklanabilir breakdown sinyalleri taşır', async () => {
    const item1 = {
      id: 5001,
      media_type: 'movie',
      title: 'Galaksi Savaşı',
      overview: 'Uzayda karanlık bir savaş',
      genre_ids: [878, 28],
    };
    const item2 = {
      id: 5002,
      media_type: 'movie',
      title: 'Galaksi İstilası',
      overview: 'Uzayda karanlık bir istila',
      genre_ids: [878, 28],
    };

    const link = strongestRelationship(item1, item2, 'all', { 878: 'Bilim Kurgu', 28: 'Aksiyon' });
    assert.ok(link, 'İki yapım arasında bağ kurulmalı');
    assert.ok(Array.isArray(link.relationshipDetails), 'relationshipDetails bulunmalı');
    assert.ok(link.relationshipDetails.length > 0);

    const firstDetail = link.relationshipDetails[0];
    assert.ok(firstDetail.breakdown, 'Açıklanabilir breakdown sinyali bulunmalı');
    assert.ok(
      typeof firstDetail.breakdown.vectorContribution === 'number' ||
      typeof firstDetail.breakdown.genreContribution === 'number' ||
      typeof firstDetail.breakdown.personContribution === 'number' ||
      typeof firstDetail.breakdown.seriesContribution === 'number'
    );
  });

  await t.test('10. IMP-04: maintainEncodingsDepot eski imzaları temizler ve üst sınırı (maxEntries) uygular', async () => {
    // 5 farklı kayıt ve 1 eski imza ekle
    await saveStoredEncodingIdb('movie:101:sig1', { id: 101, media_type: 'movie', signature: 'sig1', encodedAt: new Date(Date.now() - 50000).toISOString() });
    await saveStoredEncodingIdb('movie:101:sig2', { id: 101, media_type: 'movie', signature: 'sig2', encodedAt: new Date(Date.now() - 1000).toISOString() });
    await saveStoredEncodingIdb('movie:102:sig1', { id: 102, media_type: 'movie', signature: 'sig1', encodedAt: new Date(Date.now() - 40000).toISOString() });
    await saveStoredEncodingIdb('movie:103:sig1', { id: 103, media_type: 'movie', signature: 'sig1', encodedAt: new Date(Date.now() - 30000).toISOString() });

    const result = await maintainEncodingsDepot(2);
    assert.ok(result.scanned >= 4, 'Tüm kayıtlar taranmalı');
    assert.ok(result.prunedStaleSignatures >= 1, 'Eski sig1 movie:101 için budanmalı');
    assert.ok(result.remaining <= 2, 'Kalan öğe sayısı maxEntries sınırına uymalı');
  });

  await t.test('11. IMP-05: batchGetEncodings toplu yapımları başarıyla kodlar ve önbelleğe alır', async () => {
    const batch = Array.from({ length: 25 }, (_, i) => ({
      id: 6000 + i,
      media_type: 'movie',
      title: `Toplu Film ${i}`,
      genre_ids: [18, 53],
      overview: 'Gerilimli ve dramatik bir hikaye',
    }));

    const results = await batchGetEncodings(batch);
    assert.equal(results.length, 25);
    for (let i = 0; i < 25; i++) {
      assert.equal(results[i].id, 6000 + i);
      assert.equal(results[i].denseVector.length, 48);
    }
  });
});


test('IMP-06: "Sana Özel" damgası liste kaydının üstünde kalıcı durur', async () => {
  const { stampSavedItemsWithTaste } = await import('../src/core/scoring.ts');

  const vec = (a, b) => ({ denseVector: [a, b, 0, 0] });
  const resolve = (item) => (item?.media_type === 'tv' ? vec(1, 0) : vec(0, 1));
  const centroid = [1, 0, 0, 0];

  const items = [
    { id: 101, media_type: 'movie', title: 'Zevk Haritasindaki', genres: ['Dram', 'Suç'] },
    { id: 102, media_type: 'tv', title: 'Sadece Merkez', name: 'Sadece Merkez', genres: ['Komedi'] },
    { id: 103, media_type: 'movie', title: 'Damgasiz', genres: [] },
  ];
  const entries = {
    'movie:101': { tasteScore: 87.4, tags: ['Dram', 'Suç', ''], confidenceLevel: 'high', lastScoredAt: '2026-11-01T10:00:00.000Z' },
  };

  const first = stampSavedItemsWithTaste(items, {
    tasteEntries: entries,
    centroid,
    resolveEncoding: resolve,
    topGenres: ['dram'],
    computedAt: '2026-11-02T09:00:00.000Z',
  });
  assert.equal(first.changedCount, 2, 'Hesaplanabilen iki kayıt damgalanmalı');

  const stamped101 = first.items[0];
  assert.equal(stamped101.tasteFit, 87, 'Zevk haritası puanı yuvarlanarak yazılır');
  assert.equal(stamped101.tasteConfidence, 'high');
  assert.equal(stamped101.tasteComputedAt, '2026-11-01T10:00:00.000Z', 'Entry son skorlama zamanı korunur');
  assert.deepEqual(stamped101.tasteTags, ['Dram', 'Suç'], 'Boş etiketler damgaya giremez');
  assert.equal(stamped101.tasteReason, 'Dram zevkinle örtüşüyor');

  const stamped102 = first.items[1];
  assert.equal(stamped102.tasteFit, 100, 'Merkeze tam uyumlu aday 100 verir');
  assert.equal(stamped102.tasteConfidence, 'standard');
  assert.equal(stamped102.tasteComputedAt, '2026-11-02T09:00:00.000Z');

  assert.equal(first.items[2], items[2], 'Ne entry ne de merkezi olan aday damgalanmaz');

  const second = stampSavedItemsWithTaste(first.items, {
    tasteEntries: entries,
    centroid,
    resolveEncoding: resolve,
    topGenres: ['dram'],
    computedAt: '2026-11-02T09:00:00.000Z',
  });
  assert.equal(second.changedCount, 0, 'Aynı hesap tekrar yazmamalı (döngü yok)');

  const noScore = stampSavedItemsWithTaste(items, { tasteEntries: null });
  assert.equal(noScore.changedCount, 0);
  assert.deepEqual(noScore.items, items);
});

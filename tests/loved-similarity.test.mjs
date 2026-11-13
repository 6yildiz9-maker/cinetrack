import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateGenreSim,
  calculateStorySim,
  calculateCastSim,
  calculateAtmosphereSim,
  calculateEraSim,
  computeItemToItemLovedSim,
  computeLovedSimilarityScore,
  buildTasteProfileV3,
  scoreCandidatesV3,
  RECOMMENDATION_WEIGHTS_V3,
} from '../src/core/cinetrack-core.ts';

test('1. Tür Benzerliği (calculateGenreSim): Dice katsayısı ortak türleri doğru hesaplar', () => {
  // Tam eşleşme
  assert.equal(calculateGenreSim([878, 18], [878, 18]), 1.0);

  // Kısmi eşleşme: 2 ortak, toplam 5 eleman -> (2 * 2) / 5 = 0.8
  const partial = calculateGenreSim([878, 18], [878, 18, 12]);
  assert.equal(Math.round(partial * 100) / 100, 0.8);

  // Sıfır ortak tür -> 0.05 taban
  assert.equal(calculateGenreSim([35, 10749], [878, 18]), 0.05);

  // Veri yoksa nötr 0.5
  assert.equal(calculateGenreSim([], [878]), 0.5);
  assert.equal(calculateGenreSim([878], []), 0.5);
});

test('2. Hikâye Benzerliği (calculateStorySim): özet anahtar sözcüklerinin örtüşmesini hesaplar', () => {
  const lovedTokens = new Set(['uzay', 'zaman', 'solucan', 'deligi', 'insanlik']);
  // Yüksek örtüşme
  const highSim = calculateStorySim(['uzay', 'zaman', 'insanlik', 'bilim'], lovedTokens);
  assert.ok(highSim >= 0.7, `Beklenen >= 0.7, alınan ${highSim}`);

  // Sıfır örtüşme
  const zeroSim = calculateStorySim(['romantik', 'dugun', 'komedi'], lovedTokens);
  assert.equal(zeroSim, 0.15);

  // Boş özet nötr 0.5 döner
  assert.equal(calculateStorySim([], lovedTokens), 0.5);
  assert.equal(calculateStorySim(['uzay'], new Set()), 0.5);
});

test('3. Oyuncu Kadrosu Benzerliği (calculateCastSim): ortak oyuncu varlığını değerlendirir', () => {
  // 2 veya daha fazla ortak oyuncu
  assert.equal(calculateCastSim([101, 102, 103], [101, 102, 999]), 0.95);

  // 1 ortak oyuncu
  assert.equal(calculateCastSim([101, 201], [101, 301]), 0.80);

  // Ortak oyuncu yok
  assert.equal(calculateCastSim([201, 202], [101, 102]), 0.15);

  // Kadro verisi yoksa nötr 0.5
  assert.equal(calculateCastSim([], [101]), 0.5);
});

test('4. Atmosfer & Yönetmen / Koleksiyon Benzerliği (calculateAtmosphereSim)', () => {
  // Aynı koleksiyon / franchise -> 1.0
  assert.equal(calculateAtmosphereSim([], [], 9999, 9999), 1.0);

  // Aynı yönetmen (Christopher Nolan) -> 0.95
  assert.equal(calculateAtmosphereSim([525], [525]), 0.95);

  // Farklı yönetmen -> 0.35
  assert.equal(calculateAtmosphereSim([137427], [525]), 0.35);

  // Yönetmen verisi yoksa nötr 0.5
  assert.equal(calculateAtmosphereSim([], []), 0.5);
});

test('5. Dönem Benzerliği (calculateEraSim): yapım yılları yakınlığını hesaplar', () => {
  // Aynı yıl
  assert.equal(calculateEraSim(2024, 2024), 1.0);

  // 5 yıl fark (20/25 = 0.80)
  assert.equal(calculateEraSim(2019, 2024), 0.80);

  // 30 yıl fark (0.0)
  assert.equal(calculateEraSim(1990, 2024), 0.0);

  // Yıl yoksa nötr 0.5
  assert.equal(calculateEraSim(undefined, 2024), 0.5);
});

test('6. Kullanıcının sevilen içerikleri yoksa lovedSimScore nötr (0.50) kalır', () => {
  const profileWithoutLoved = buildTasteProfileV3([]);
  const candidate = {
    id: 100,
    media_type: 'movie',
    title: 'Herhangi Bir Film',
    genre_ids: [28, 12],
    seedSourceType: 'completed', // seedSourceType artık puanı yapay olarak 0.95 yapmaz!
    poolSources: 1,
  };

  const [scored] = scoreCandidatesV3([candidate], profileWithoutLoved);
  assert.equal(scored.parts.lovedSim, 0.5);
  assert.equal(candidate.lovedSimDetail, null);
});

test('7. Gerçek Çok Boyutlu Benzerlik: seedSourceType ne olursa olsun içerik özellikleri puanı belirler', () => {
  const history = [
    {
      id: 157336,
      media_type: 'movie',
      title: 'Interstellar',
      overview: 'Uzay solucan deliği zaman yolculuğu ve insanlığın kurtuluşu.',
      genre_ids: [878, 18, 12],
      personal_rating: 10,
      status: 'completed',
      release_date: '2014-11-05',
      cast: [{ id: 10297, name: 'Matthew McConaughey' }],
      crew: [{ id: 525, name: 'Christopher Nolan', job: 'Director' }],
    },
  ];

  const profile = buildTasteProfileV3(history);

  // Aday A: seedSourceType='watchlist' (eski kodda 0.65 alacaktı), fakat Nolan yönetmenliğinde Sci-Fi drama
  const candidateSimilar = {
    id: 2001,
    media_type: 'movie',
    title: 'Benzer Bilim Kurgu',
    overview: 'Uzay yolculuğu zaman kırılması ve solucan deliği araştırması.',
    genre_ids: [878, 18],
    release_date: '2017-06-01',
    seedSourceType: 'watchlist', // eski sistem 0.65 veriyordu
    crew: [{ id: 525, name: 'Christopher Nolan', job: 'Director' }],
  };

  // Aday B: seedSourceType='completed' (eski kodda 0.95 alacaktı), fakat tamamen alakasız romantik komedi
  const candidateUnrelated = {
    id: 2002,
    media_type: 'movie',
    title: 'Alakasız Romantik Komedi',
    overview: 'Sahil kasabasında düğün telaşı ve aşk dedikoduları.',
    genre_ids: [35, 10749],
    release_date: '1995-02-14',
    seedSourceType: 'completed', // eski sistem haksız yere 0.95 veriyordu
  };

  const [scoredSimilar, scoredUnrelated] = scoreCandidatesV3(
    [candidateSimilar, candidateUnrelated],
    profile
  );

  // Benzer yapım, seedSourceType düşük olmasına rağmen içerik uyumuyla çok daha yüksek lovedSim alır
  assert.ok(
    scoredSimilar.parts.lovedSim > 0.65,
    `Benzer yapım yüksek puan almalı, alınan: ${scoredSimilar.parts.lovedSim}`
  );
  assert.ok(
    scoredUnrelated.parts.lovedSim < 0.35,
    `Alakasız yapım seedSourceType completed olsa dahi düşük puan almalı, alınan: ${scoredUnrelated.parts.lovedSim}`
  );
  assert.ok(scoredSimilar.parts.lovedSim > scoredUnrelated.parts.lovedSim);

  // Açıklama ve etiket verisi kontrolü
  assert.ok(scoredSimilar.candidate.lovedSimDetail);
  assert.equal(scoredSimilar.candidate.lovedSimDetail.matchedTitle, 'Interstellar');
  assert.ok(scoredSimilar.candidate.lovedSimDetail.similarity > 0.65);
  assert.ok(scoredSimilar.candidate.tags.some((t) => t.includes('Interstellar')));
});

test('8. Sevilen yapım ağırlığı en iyi eşleşmeyi ve nihai puanı etkiler', () => {
  const baseFeatures = {
    media_type: 'movie',
    genre_ids: [878],
    overviewTokens: new Set(),
    castIds: [],
    directorIds: [],
  };

  const lovedItems = [
    {
      ...baseFeatures,
      key: 'movie:1',
      id: 1,
      title: 'Düşük Ağırlıklı Benzer',
      weight: 0.2,
    },
    {
      ...baseFeatures,
      key: 'movie:2',
      id: 2,
      title: 'Yüksek Ağırlıklı Az Benzer',
      genre_ids: [35],
      weight: 1,
    },
  ];

  const candidate = { genre_ids: [878], overview: '', cast: [], crew: [] };
  const result = computeLovedSimilarityScore(candidate, lovedItems);

  assert.ok(result.breakdown);
  // Benzerlik düşük olsa da ağırlığı yüksek referans en iyi eşleşme olmalı.
  assert.equal(result.breakdown.matchedTitle, 'Yüksek Ağırlıklı Az Benzer');
});

test('9. Film ↔ dizi tür taksonomisi ortak aile üzerinden eşleşir', () => {
  const movieScifi = [878];
  const tvScifiFantasy = [10765];

  assert.ok(
    calculateGenreSim(movieScifi, tvScifiFantasy) > 0.5,
    'Film bilim kurgu ile dizi bilim kurgu-fantastik aynı ailede eşleşmeli'
  );
  assert.equal(calculateGenreSim([28], [10759]) > 0.0, true);
  assert.equal(calculateGenreSim([16], [10765]), 0.05);
});

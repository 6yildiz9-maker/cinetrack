import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRelationshipGraph,
  computeRelationshipPoolSignature,
  computeRelationshipProfileSignature,
  RELATIONSHIP_MODEL_VERSION,
} from '../src/core/relationship-explorer.ts';
import {
  graphCacheKey,
  latestGraphCacheKey,
  readRelationshipCache,
  relationshipEdgeCacheKey,
} from '../src/services/relationship-cache.ts';

const preferences = {
  disliked: [],
  hidden: [],
  providers: [],
  mood: '',
  reminders: false,
  notified: [],
};

function candidate(id, overrides = {}) {
  return {
    id,
    media_type: 'movie',
    title: `Film ${id}`,
    overview: 'Bilinç ve insanlık teknoloji karşısında değişir.',
    genre_ids: [878, 18],
    vote_average: 7,
    vote_count: 100,
    popularity: 10,
    poolSource: 'exploration',
    poolSources: 1,
    era: 'modern',
    popularityTier: 'medium',
    ...overrides,
  };
}

function savedMovie(id, overrides = {}) {
  return {
    id,
    media_type: 'movie',
    title: `Kayıtlı Film ${id}`,
    vote_average: 7.5,
    vote_count: 250,
    popularity: 20,
    genre_ids: [878, 18],
    status: 'completed',
    personal_rating: 8,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('aynı koleksiyon ilişki bağlantısı üretir', () => {
  const data = buildRelationshipGraph({
    mode: 'relationships',
    profileId: 'test',
    candidates: [
      candidate(1, { title: 'Kaynak', belongs_to_collection: { id: 10, name: 'Seri A' } }),
      candidate(2, { title: 'Devam', belongs_to_collection: { id: 10, name: 'Seri A' } }),
      candidate(3, { title: 'Başka', belongs_to_collection: { id: 99, name: 'Seri B' } }),
    ],
    savedItems: [],
    preferences,
    mediaFilter: 'movie',
    sourceKey: 'movie:1',
    relationshipFilter: 'universe',
  });

  assert.ok(data.links.some((link) => link.type === 'universe' && link.score >= 90));
  assert.ok(data.nodes.every((node) => node.mediaType === 'movie' || node.mediaType === 'profile'));
});

test('film filtresinde diziler grafiğe girmez', () => {
  const data = buildRelationshipGraph({
    mode: 'taste-map',
    profileId: 'test',
    candidates: [
      candidate(1),
      candidate(2, { id: 2, media_type: 'tv', title: 'Dizi 2' }),
    ],
    savedItems: [],
    preferences,
    mediaFilter: 'movie',
  });

  assert.ok(data.nodes.every((node) => node.mediaType !== 'tv'));
});

test('ilişki modu kaynak düğümü merkezde tutar', () => {
  const data = buildRelationshipGraph({
    mode: 'relationships',
    profileId: 'test',
    candidates: [
      candidate(1),
      candidate(2, { belongs_to_collection: { id: 10, name: 'Seri A' } }),
    ],
    savedItems: [],
    preferences,
    mediaFilter: 'movie',
    sourceKey: 'movie:1',
    relationshipFilter: 'all',
  });

  assert.equal(data.nodes[0]?.id, 'movie:1');
  assert.equal(data.nodes[0]?.fx, 0);
  assert.equal(data.nodes[0]?.fy, 0);
});

test('ilişki modu kaynak belirtilmediğinde veya geçersiz olduğunda sessizce rastgele yapım seçmez', () => {
  const dataWithoutSource = buildRelationshipGraph({
    mode: 'relationships',
    profileId: 'test',
    candidates: [
      candidate(1),
      candidate(2),
    ],
    savedItems: [],
    preferences,
    mediaFilter: 'movie',
    sourceKey: '',
    relationshipFilter: 'all',
  });

  assert.equal(dataWithoutSource.nodes.length, 0);
  assert.equal(dataWithoutSource.links.length, 0);

  const dataWithInvalidSource = buildRelationshipGraph({
    mode: 'relationships',
    profileId: 'test',
    candidates: [
      candidate(1),
      candidate(2),
    ],
    savedItems: [],
    preferences,
    mediaFilter: 'movie',
    sourceKey: 'movie:9999',
    relationshipFilter: 'all',
  });

  assert.equal(dataWithInvalidSource.nodes.length, 0);
  assert.equal(dataWithInvalidSource.links.length, 0);
});

test('film kaynağı dizi filtresiyle uyuşmadığında grafiğe girmez ve rastgele dizi seçilmez', () => {
  const data = buildRelationshipGraph({
    mode: 'relationships',
    profileId: 'test',
    candidates: [
      candidate(1, { id: 1, media_type: 'movie', title: 'Film 1' }),
      candidate(2, { id: 2, media_type: 'tv', title: 'Dizi 2' }),
    ],
    savedItems: [],
    preferences,
    mediaFilter: 'tv',
    sourceKey: 'movie:1',
    relationshipFilter: 'all',
  });

  assert.equal(data.nodes.length, 0);
  assert.equal(data.links.length, 0);
});

test('uyuşan ilişki bulunamadığında boş bağlantı listesi döner', () => {
  const data = buildRelationshipGraph({
    mode: 'relationships',
    profileId: 'test',
    candidates: [
      candidate(1, { title: 'Film 1', overview: 'A', genre_ids: [18] }),
      candidate(2, { title: 'Film 2', overview: 'Z', genre_ids: [35] }),
    ],
    savedItems: [],
    preferences,
    mediaFilter: 'movie',
    sourceKey: 'movie:1',
    relationshipFilter: 'universe',
  });

  assert.equal(data.links.length, 0);
  assert.equal(data.nodes.length, 1);
});

test('profil durumu ve puanı değişince ilişki profili imzası değişir', () => {
  const base = {
    profileId: 'test',
    mediaFilter: 'movie',
    savedItems: [savedMovie(1, { status: 'completed', personal_rating: 8 })],
    preferences,
  };
  const original = computeRelationshipProfileSignature(base);
  const statusChanged = computeRelationshipProfileSignature({
    ...base,
    savedItems: [savedMovie(1, { status: 'watchlist', personal_rating: 8 })],
  });
  const ratingChanged = computeRelationshipProfileSignature({
    ...base,
    savedItems: [savedMovie(1, { status: 'completed', personal_rating: 6 })],
  });

  assert.notEqual(original, statusChanged);
  assert.notEqual(original, ratingChanged);
  assert.ok(!original.endsWith(':v1'));
});

test('tercihler ve favori oyuncu listesi değişince ilişki profili imzası değişir', () => {
  const base = {
    profileId: 'test',
    mediaFilter: 'movie',
    savedItems: [],
    preferences,
    favoriteActorIds: [11],
  };
  const original = computeRelationshipProfileSignature(base);
  const dislikedChanged = computeRelationshipProfileSignature({
    ...base,
    preferences: { ...preferences, disliked: ['movie:9'] },
  });
  const actorChanged = computeRelationshipProfileSignature({
    ...base,
    favoriteActorIds: [12],
  });

  assert.notEqual(original, dislikedChanged);
  assert.notEqual(original, actorChanged);
});

test('buildRelationshipGraph tüm modlarda gerçek profil imzası döndürür', () => {
  const expectedSig = computeRelationshipProfileSignature({
    profileId: 'test',
    mediaFilter: 'movie',
    savedItems: [savedMovie(1)],
    preferences,
    favoriteActorIds: [77],
  });

  const tasteGraph = buildRelationshipGraph({
    mode: 'taste-map',
    profileId: 'test',
    candidates: [candidate(2)],
    savedItems: [savedMovie(1)],
    preferences,
    mediaFilter: 'movie',
    favoriteActorIds: [77],
  });
  const emptyRelGraph = buildRelationshipGraph({
    mode: 'relationships',
    profileId: 'test',
    candidates: [candidate(2)],
    savedItems: [savedMovie(1)],
    preferences,
    mediaFilter: 'movie',
    sourceKey: '',
    favoriteActorIds: [77],
  });

  assert.equal(tasteGraph.profileSignature, expectedSig);
  assert.equal(emptyRelGraph.profileSignature, expectedSig);
});

test('havuz metaverisi değişince havuz imzası değişir ve sıralamadan bağımsızdır', () => {
  const first = candidate(1, { overview: 'Bilinç ve teknoloji.' });
  const second = candidate(1, { overview: 'Bilinç ve insanlık.' });
  const other = candidate(2, { overview: 'Uzay istasyonu.' });

  assert.notEqual(
    computeRelationshipPoolSignature([first]),
    computeRelationshipPoolSignature([second]),
  );
  assert.equal(
    computeRelationshipPoolSignature([first, other]),
    computeRelationshipPoolSignature([other, first]),
  );
});

test('aynı çiftte birden fazla ilişki tek çizgide tutulur ama relationshipDetails içinde ayrı saklanır', () => {
  const data = buildRelationshipGraph({
    mode: 'relationships',
    profileId: 'test',
    candidates: [
      candidate(1, {
        title: 'Dune: Çöl Gezegeni',
        belongs_to_collection: { id: 726871, name: 'Dune Serisi' },
        cast: [{ id: 1190668, name: 'Timothée Chalamet' }],
        crew: [{ id: 137427, name: 'Denis Villeneuve', job: 'Director' }],
      }),
      candidate(2, {
        title: 'Dune: Çöl Gezegeni Bölüm İki',
        belongs_to_collection: { id: 726871, name: 'Dune Serisi' },
        cast: [{ id: 1190668, name: 'Timothée Chalamet' }],
        crew: [{ id: 137427, name: 'Denis Villeneuve', job: 'Director' }],
      }),
    ],
    savedItems: [],
    preferences,
    mediaFilter: 'movie',
    sourceKey: 'movie:1',
    relationshipFilter: 'all',
    genreNames: { 878: 'Bilim Kurgu', 18: 'Dram' },
  });

  assert.equal(data.links.length, 1);
  const link = data.links[0];
  assert.equal(link.type, 'universe');
  assert.ok(Array.isArray(link.relationshipDetails));
  const detailTypes = link.relationshipDetails.map((d) => d.type);
  assert.ok(detailTypes.includes('universe'));
  assert.ok(detailTypes.includes('person'));

  const universeDetail = link.relationshipDetails.find((d) => d.type === 'universe');
  const personDetail = link.relationshipDetails.find((d) => d.type === 'person');
  assert.ok(universeDetail.evidence.some((e) => e.includes('Dune Serisi')));
  assert.ok(universeDetail.evidence.every((e) => !e.includes('Timothée Chalamet')));
  assert.ok(personDetail.evidence.some((e) => e.includes('Timothée Chalamet')));
});

test('ortak tür kanıtları sayısal kimlik yerine genreNames adlarıyla gösterilir', () => {
  const data = buildRelationshipGraph({
    mode: 'relationships',
    profileId: 'test',
    candidates: [
      candidate(1, { title: 'Kuantum Ufku', overview: 'Galaksi kolonisinde sibernetik isyan.' }),
      candidate(2, { title: 'Sibernetik Şafak', overview: 'Galaksi kolonisinde sibernetik uyanış.' }),
    ],
    savedItems: [],
    preferences,
    mediaFilter: 'movie',
    sourceKey: 'movie:1',
    relationshipFilter: 'semantic',
    genreNames: { 878: 'Bilim Kurgu', 18: 'Dram' },
  });

  assert.equal(data.links.length, 1);
  const evidenceText = data.links[0].evidence.join(' ');
  assert.ok(evidenceText.includes('Ortak türler: Bilim Kurgu, Dram.'));
  assert.ok(!evidenceText.includes('878'));
});

test('jenerik özet kelimeleri tek başına yapay anlamsal ilişki üretmez', () => {
  const data = buildRelationshipGraph({
    mode: 'relationships',
    profileId: 'test',
    candidates: [
      candidate(1, {
        title: 'Kuzey Rüzgarı',
        overview: 'Gerçek dünyada yaşayan insanlar birlikte hayat ve zaman karşısında mücadele hikaye başlar.',
        genre_ids: [18],
      }),
      candidate(2, {
        title: 'Güney Limanı',
        overview: 'Gerçek dünyada yaşayan insanlar birlikte hayat ve zaman karşısında mücadele hikaye başlar.',
        genre_ids: [35],
      }),
    ],
    savedItems: [],
    preferences,
    mediaFilter: 'movie',
    sourceKey: 'movie:1',
    relationshipFilter: 'semantic',
  });

  assert.equal(data.links.length, 0);
});

test('kişi kanıt güveni kısmi kadro verisinde 72, tam kapsamda 96 döner', () => {
  const partialGraph = buildRelationshipGraph({
    mode: 'relationships',
    profileId: 'test',
    candidates: [
      candidate(1, { overview: 'Kısa.', genre_ids: [18], cast: [{ id: 500, name: 'Oyuncu A' }] }),
      candidate(2, { overview: 'Farklı.', genre_ids: [35], cast: [{ id: 500, name: 'Oyuncu A' }] }),
    ],
    savedItems: [],
    preferences,
    mediaFilter: 'movie',
    sourceKey: 'movie:1',
    relationshipFilter: 'person',
  });
  assert.equal(partialGraph.links[0]?.confidence, 72);

  const completeGraph = buildRelationshipGraph({
    mode: 'relationships',
    profileId: 'test',
    candidates: [
      candidate(1, {
        overview: 'Kısa.',
        genre_ids: [18],
        cast: [{ id: 500, name: 'Oyuncu A' }],
        crew: [{ id: 600, name: 'Yönetmen B', job: 'Director' }],
        metadataCoverage: {
          overview: true,
          genres: true,
          cast: 'complete',
          crew: 'complete',
          collection: 'unknown',
        },
      }),
      candidate(2, {
        overview: 'Farklı.',
        genre_ids: [35],
        cast: [{ id: 500, name: 'Oyuncu A' }],
        crew: [{ id: 600, name: 'Yönetmen B', job: 'Director' }],
        metadataCoverage: {
          overview: true,
          genres: true,
          cast: 'complete',
          crew: 'complete',
          collection: 'unknown',
        },
      }),
    ],
    savedItems: [],
    preferences,
    mediaFilter: 'movie',
    sourceKey: 'movie:1',
    relationshipFilter: 'person',
  });
  assert.equal(completeGraph.links[0]?.confidence, 96);
});

test('zevk haritasında puanlanmamış izlenmiş içerik nötr uyum puanını korurken durum sinyalini ayrı taşır', () => {
  const data = buildRelationshipGraph({
    mode: 'taste-map',
    profileId: 'test',
    candidates: [candidate(10)],
    savedItems: [
      savedMovie(1, { status: 'completed', personal_rating: '' }),
      savedMovie(2, { status: 'watchlist', personal_rating: '' }),
    ],
    preferences,
    mediaFilter: 'movie',
  });

  const completedNode = data.nodes.find((node) => node.id === 'movie:1');
  const watchlistNode = data.nodes.find((node) => node.id === 'movie:2');

  assert.equal(completedNode?.personalScore, 50);
  assert.equal(completedNode?.statusSignal, 'completed-history');
  assert.equal(completedNode?.statusWeight, 1);

  assert.equal(watchlistNode?.personalScore, 50);
  assert.equal(watchlistNode?.statusSignal, 'interest');
  assert.equal(watchlistNode?.statusWeight, 0.5);
});

test('önbellek anahtarı yardımcıları kanonik sıra üretir ve IndexedDB yokken güvenli hata verir', async () => {
  assert.equal(latestGraphCacheKey('default', 'relationships'), 'latest:default:relationships');

  const keyA = relationshipEdgeCacheKey({
    sourceKey: 'movie:10',
    targetKey: 'movie:2',
    sourceFeatureHash: 'aaaa',
    targetFeatureHash: 'bbbb',
    modelVersion: RELATIONSHIP_MODEL_VERSION,
  });
  const keyB = relationshipEdgeCacheKey({
    sourceKey: 'movie:2',
    targetKey: 'movie:10',
    sourceFeatureHash: 'bbbb',
    targetFeatureHash: 'aaaa',
    modelVersion: RELATIONSHIP_MODEL_VERSION,
  });
  assert.equal(keyA, keyB);

  const gKey = graphCacheKey({
    profileId: 'p1',
    mode: 'taste-map',
    mediaFilter: 'all',
    sourceKey: '',
    relationshipFilter: 'all',
    profileSignature: 'p1:all:1234abcd',
    poolSignature: '99887766',
    modelVersion: RELATIONSHIP_MODEL_VERSION,
  });
  assert.ok(gKey.includes('1234abcd'));
  assert.ok(gKey.includes('no-source'));

  await assert.rejects(
    () => readRelationshipCache('graphs', 'latest:p1:taste-map'),
    /IndexedDB/,
  );
});

test('buildRelationshipGraph boş verilerle (aday ve kayıtlı liste boş) güvenle çalışır ve çökmez', () => {
  const resultTaste = buildRelationshipGraph({
    mode: 'taste-map',
    profileId: 'empty-user',
    candidates: [],
    savedItems: [],
    preferences,
    mediaFilter: 'all',
  });
  assert.ok(Array.isArray(resultTaste.nodes));
  assert.ok(Array.isArray(resultTaste.links));
  assert.equal(resultTaste.nodes.length, 1); // profile node
  assert.equal(resultTaste.nodes[0]?.kind, 'profile');
  assert.equal(resultTaste.links.length, 0);

  const resultRel = buildRelationshipGraph({
    mode: 'relationships',
    profileId: 'empty-user',
    candidates: [],
    savedItems: [],
    preferences,
    mediaFilter: 'all',
    sourceKey: '',
  });
  assert.equal(resultRel.nodes.length, 0);
  assert.equal(resultRel.links.length, 0);
});

test('buildRelationshipGraph bozuk ve eksik metaverili yapımlarla güvenle çalışır', () => {
  const malformedCandidates = [
    { id: 999 }, // missing media_type, title, genres
    { id: 'bad-1', media_type: 'movie', title: null, genre_ids: null, overview: undefined },
    { id: 888, media_type: 'tv', title: 'Normal Dizi', genre_ids: [18] },
  ];
  const malformedSaved = [
    { id: 777, media_type: null, title: 'Kayıtlı Eksik', personal_rating: 'invalid' },
  ];

  const result = buildRelationshipGraph({
    mode: 'taste-map',
    profileId: 'malformed-user',
    candidates: malformedCandidates,
    savedItems: malformedSaved,
    preferences,
    mediaFilter: 'all',
  });

  assert.ok(result.nodes.length >= 1);
  assert.ok(Array.isArray(result.links));
  for (const node of result.nodes) {
    assert.ok(typeof node.id === 'string' && node.id.length > 0);
    assert.ok(typeof node.title === 'string');
    assert.ok(Number.isFinite(node.personalScore));
  }
});

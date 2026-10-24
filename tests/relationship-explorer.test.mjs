import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelationshipGraph } from '../src/core/relationship-explorer.ts';

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
    sourceKey: 'movie:1', // Kaynak film, filtre dizi!
    relationshipFilter: 'all',
  });

  // Uyuşmayan kaynak sessizce başka bir diziye geçmemeli, boş dönmelidir
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
    relationshipFilter: 'universe', // Seri ilişkisi yok
  });

  assert.equal(data.links.length, 0);
  assert.equal(data.nodes.length, 1); // Sadece kaynak düğüm, bağ kurulan aday yok
});



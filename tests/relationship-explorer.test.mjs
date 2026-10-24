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

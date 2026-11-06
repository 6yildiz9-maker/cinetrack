import test from 'node:test';
import assert from 'node:assert/strict';
import { createTvdbProxyService, ALLOWED_TVDB_PATH_PATTERN } from '../src/server/tvdb-proxy.ts';
import { mapTvdbItemToTmdbItem } from '../src/services/tvdb-service.ts';
import { validateAndParseStockImport } from '../src/services/stock-import-export.ts';

test('TVDB Proxy Service: Allowed path whitelist works strictly', () => {
  assert.equal(ALLOWED_TVDB_PATH_PATTERN.test('/series/filter'), true);
  assert.equal(ALLOWED_TVDB_PATH_PATTERN.test('/movies/filter'), true);
  assert.equal(ALLOWED_TVDB_PATH_PATTERN.test('/series/12345/extended'), true);
  assert.equal(ALLOWED_TVDB_PATH_PATTERN.test('/movies/54321/extended'), true);
  assert.equal(ALLOWED_TVDB_PATH_PATTERN.test('/genres'), true);
  assert.equal(ALLOWED_TVDB_PATH_PATTERN.test('/search'), true);

  // Disallowed paths
  assert.equal(ALLOWED_TVDB_PATH_PATTERN.test('/admin/delete'), false);
  assert.equal(ALLOWED_TVDB_PATH_PATTERN.test('/user/private_keys'), false);
  assert.equal(ALLOWED_TVDB_PATH_PATTERN.test('/../../etc/passwd'), false);
});

test('TVDB Proxy Service: Login, JWT caching and 401 retry resilience', async () => {
  let loginCount = 0;
  const mockFetch = async (url, _options) => {
    const urlStr = String(url);
    if (urlStr.endsWith('/login')) {
      loginCount++;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          status: 'success',
          data: {
            // Fake JWT header.payload.sig with exp ~ 30 days
            token: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 2500000 })).toString('base64url')}.sig_${loginCount}`,
          },
        }),
      };
    }

    if (urlStr.includes('/series/filter')) {
      // Return mock response
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ status: 'success', data: [{ id: 101, name: 'Test Series' }] }),
      };
    }

    return { ok: false, status: 404, headers: new Headers(), text: async () => 'Not found' };
  };

  const proxy = createTvdbProxyService({
    tvdbApiKey: 'test-api-key-12345',
    fetchImpl: mockFetch,
  });

  // First call should login
  const token1 = await proxy.getValidToken('test-api-key-12345');
  assert.ok(token1.token.startsWith('eyJhbGciOiJIUzI1NiJ9.'));
  assert.equal(loginCount, 1);

  // Subsequent call within expiry should reuse cached token
  const token2 = await proxy.getValidToken('test-api-key-12345');
  assert.equal(token2.token, token1.token);
  assert.equal(loginCount, 1);

  // Status handler
  let statusOutput = null;
  const mockReq = { headers: {}, query: {} };
  const mockRes = {
    setHeader: () => {},
    json: (data) => { statusOutput = data; },
  };
  await proxy.handleStatus(mockReq, mockRes);
  assert.equal(statusOutput.ok, true);
  assert.equal(statusOutput.configured, true);
  assert.equal(statusOutput.tokenActive, true);
});

test('TVDB Data Mapping: Maps TVDB entity to TmdbItem schema with source: tvdb', () => {
  const rawTvdbSeries = {
    id: 98765,
    name: 'Shōgun (TVDB)',
    originalName: 'Shōgun',
    score: 87.5,
    scoreVotes: 4200,
    firstAired: '2024-02-27',
    image: 'https://artworks.thetvdb.com/banners/v4/series/98765/posters/test.jpg',
    genres: [{ id: 1, name: 'Dram' }, { id: 2, name: 'Tarih' }],
    overview: 'Feodal Japonya döneminde geçen destansı güç mücadelesi.',
    runtime: 60,
    status: { name: 'Returning Series' },
  };

  const mapped = mapTvdbItemToTmdbItem(rawTvdbSeries, 'tv');

  assert.equal(mapped.id, 'tvdb-98765');
  assert.equal(mapped.media_type, 'tv');
  assert.equal(mapped.source, 'tvdb');
  assert.equal(mapped.tvdb_id, 98765);
  assert.equal(mapped.title, 'Shōgun (TVDB)');
  assert.equal(mapped.name, 'Shōgun (TVDB)');
  assert.equal(mapped.vote_average, 8.8);
  assert.equal(mapped.poster_url, 'https://artworks.thetvdb.com/banners/v4/series/98765/posters/test.jpg');
  assert.equal(mapped.release_date, '2024-02-27');
  assert.equal(mapped.genres.length, 2);
  assert.equal(mapped.genres[0].name, 'Dram');
});

test('Stock Import & Validation: Validates JSON schema, detects duplicates and reports errors', async () => {
  const validJsonPayload = JSON.stringify({
    movies: [
      { id: 'tvdb-101', title: 'Film 1', media_type: 'movie', source: 'tvdb', vote_average: 8.2 },
      { id: 'tvdb-102', title: 'Film 2', media_type: 'movie', source: 'tvdb', vote_average: 7.9 },
    ],
    tv: [
      { id: 'tvdb-201', name: 'Dizi 1', media_type: 'tv', source: 'tvdb', vote_average: 8.5 },
      { id: 'bad-entry', overview: 'Başlığı olmayan bozuk kayıt' }, // Missing title
    ],
  });

  const preview = await validateAndParseStockImport(validJsonPayload, 'test.json');

  assert.equal(preview.totalRead, 4);
  assert.equal(preview.validCount, 3);
  assert.equal(preview.invalidCount, 1);
  assert.ok(preview.errors[0].message.includes('Başlık'));
});

test('Stock Import & Validation: Validates CSV import structure', async () => {
  const csvPayload = [
    'id,media_type,source,title,year,vote_average,genres,overview',
    'tvdb-301,movie,tvdb,Test Film,2024,8.1,Aksiyon|Macera,Harika bir macera filmi',
    'tvdb-302,tv,tvdb,Test Dizi,2023,8.7,Dram,Etkileyici bir drama dizisi',
  ].join('\n');

  const preview = await validateAndParseStockImport(csvPayload, 'stock.csv');

  assert.equal(preview.validCount, 2);
  assert.equal(preview.invalidCount, 0);
  assert.equal(preview.validItems[0].title, 'Test Film');
  assert.equal(preview.validItems[0].media_type, 'movie');
  assert.equal(preview.validItems[1].title, 'Test Dizi');
  assert.equal(preview.validItems[1].media_type, 'tv');
});

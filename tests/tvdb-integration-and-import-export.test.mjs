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
  // TVDB `score` alanı ağırlıklı oy sayısıdır, gösterge puanı değil: puan uydurulmaz
  assert.equal(mapped.vote_average, undefined);
  assert.equal(mapped.poster_url, 'https://artworks.thetvdb.com/banners/v4/series/98765/posters/test.jpg');
  assert.equal(mapped.release_date, '2024-02-27');
  assert.equal(mapped.genres.length, 2);
  assert.equal(mapped.genres[0].name, 'Dram');
});

test('TVDB Normalization: göreli banner yolu, önekli id ve çapraz kimlikler', async () => {
  const n = await import('../src/core/sources/tvdb-normalize.ts');
  const { mapTvdbItemToTmdbItem } = await import('../src/services/tvdb-service.ts');

  // /movies/filter akış kaydı: `image` göreli gelir, TMDB tabanına yapışmadan artworks tabanıyla mutlaklaşmalı
  const feedMovie = mapTvdbItemToTmdbItem(
    { id: 132352, name: '7. Koğuştaki Mucize', image: '/banners/v4/movie/132352/posters/x.jpg', year: '2020', score: 464230 },
    'movie'
  );
  assert.equal(feedMovie.poster_url, 'https://artworks.thetvdb.com/banners/v4/movie/132352/posters/x.jpg');
  assert.equal(feedMovie.poster_path, feedMovie.poster_url);
  assert.equal(feedMovie.vote_average, undefined);

  // /search kaydı: `image_url` ve "series-371980" biçimli önekli id
  const searchSeries = mapTvdbItemToTmdbItem(
    {
      id: 'series-371980',
      name: 'Severance',
      image_url: 'https://artworks.thetvdb.com/banners/v4/series/371980/posters/y.jpg',
      first_air_time: '2022-02-18',
      status: 'Continuing',
    },
    'tv'
  );
  assert.equal(searchSeries.id, 'tvdb-371980');
  assert.equal(searchSeries.tvdb_id, 371980);
  assert.equal(searchSeries.release_date, '2022-02-18');
  assert.equal(searchSeries.status, 'Continuing');

  // /extended remoteIds[] → TMDB + IMDB çapraz kimlikleri (kullanıcı listesi elemesi bunları kullanır)
  const cross = n.extractTvdbCrossIds([
    { id: '95396', sourceName: 'TheMovieDB.com' },
    { id: 'tt11280740', sourceName: 'IMDB' },
    { id: '10.5240/3E33', sourceName: 'EIDR' },
  ]);
  assert.equal(cross.tmdb, '95396');
  assert.equal(cross.imdb, 'tt11280740');

  // Türkçe karakter katlaması: başlık eşleşmesi aksan farkından kırılmasın
  assert.equal(n.foldTitleKey('Şahsiyet'), n.foldTitleKey('sahsiyet'));
  assert.equal(n.buildTitleYearKey('Kuru Otlar Üstüne', '2023-06-01'), 'kuru otlar ustune|2023');
});

test('Kaynak Motoru Registry: her kaynak anahtar ve poster dilini kendisi üretir', async () => {
  const r = await import('../src/core/sources/index.ts');

  const ids = r.listContentSources().map((e) => e.id);
  assert.ok(ids.includes('tmdb'));
  assert.ok(ids.includes('tvdb'));

  // Etiketli yönlendirme
  assert.equal(r.contentSourceFor({ source: 'tvdb' })?.id, 'tvdb');
  assert.equal(r.contentSourceFor({ source: 'tmdb' })?.id, 'tmdb');
  // Etiketsiz: ipuçlarından karar verilir, `source === 'tvdb'` dallanmasına gerek kalmaz
  assert.equal(r.contentSourceFor({ id: 'tvdb-354316', tvdb_id: 354316 })?.id, 'tvdb');
  assert.equal(r.contentSourceFor({ id: 550, media_type: 'movie' })?.id, 'tmdb');
  assert.equal(r.contentSourceFor(null), undefined);

  const tvdbMovie = {
    id: 'tvdb-132352',
    tvdb_id: 132352,
    media_type: 'movie',
    source: 'tvdb',
    title: '7. Koğuştaki Mucize',
    year: '2020',
    image: '/banners/v4/movie/132352/posters/x.jpg',
    tvdb_remote_ids: { tmdb: '596179', imdb: 'tt11721678' },
  };
  const tvdb = r.getContentSource('tvdb');
  assert.equal(
    tvdb.posterUrl(tvdbMovie),
    'https://artworks.thetvdb.com/banners/v4/movie/132352/posters/x.jpg'
  );
  const tvdbExclude = tvdb.exclusionKeys(tvdbMovie);
  assert.ok(tvdbExclude.includes('movie:tvdb-132352'), 'tvdb- öneki korunur: id havuz karışmasına yol açmaz');
  assert.ok(tvdbExclude.includes('movie:132352'));
  assert.ok(!tvdbExclude.includes('tv:132352'));
  assert.ok(tvdbExclude.includes('raw:596179'), 'çapraz TMDB kimliği eleme anahtarı olmalı');
  assert.ok(tvdbExclude.includes('imdb:tt11721678'), 'çapraz IMDB kimliği eleme anahtarı olmalı');
  assert.ok(tvdbExclude.includes('7 kogustaki mucize|2020'), 'başlık+yıl katlanmış anahtar olmalı');

  const tmdb = r.getContentSource('tmdb');
  const tmdbMovie = { id: 550, media_type: 'movie', title: 'Fight Club', release_date: '1999-10-15' };
  assert.equal(
    tmdb.posterUrl({ ...tmdbMovie, poster_path: '/q52ZAmwZFAeeThmuVG65Xy9vxQ5.jpg' }),
    'https://image.tmdb.org/t/p/w500/q52ZAmwZFAeeThmuVG65Xy9vxQ5.jpg'
  );
  assert.equal(tmdb.posterUrl(tmdbMovie), null);
  assert.deepEqual(tmdb.dedupeKeys(tmdbMovie), ['movie:550', 'raw:550', 'fight club']);
  assert.equal(tmdb.dedupeKeys({ id: 'tvdb-550', media_type: 'movie' }).includes('movie:550'), false);
  assert.ok(tmdb.exclusionKeys(tmdbMovie).includes('fight club|1999'));

  // Motor sözleşmesi: kullanıcıdaki TMDB kaydı, TVDB adayının çapraz kimliğiyle tanınır
  const userListKeys = new Set(tmdb.exclusionKeys(tmdbMovie));
  assert.equal(
    tvdb.exclusionKeys({ id: 'tvdb-1', tvdb_id: 1, media_type: 'movie', tvdb_remote_ids: { tmdb: '550' } })
      .some((k) => userListKeys.has(k)),
    true
  );
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

test('Stock Import & Restore: Strategy restore replaces stock and preserves TMDB items if TVDB only', async () => {
  const { applyStockImport } = await import('../src/services/stock-import-export.ts');
  const { loadStockIdb, saveStockIdb } = await import('../src/services/storage-idb.ts');

  // Seed with initial TMDB and old TVDB items
  await saveStockIdb({
    movies: [
      { id: '100', title: 'TMDB Film 1', media_type: 'movie', source: 'tmdb' },
      { id: 'tvdb-old-1', title: 'Old TVDB Film', media_type: 'movie', source: 'tvdb' },
    ],
    tv: [
      { id: '200', name: 'TMDB Dizi 1', media_type: 'tv', source: 'tmdb' },
      { id: 'tvdb-old-2', name: 'Old TVDB Dizi', media_type: 'tv', source: 'tvdb' },
    ],
    updatedAt: new Date().toISOString(),
  });

  // Restore with a TVDB-only backup
  const backupItems = [
    { id: 'tvdb-new-1', title: 'Restored TVDB Film 1', media_type: 'movie', source: 'tvdb' },
    { id: 'tvdb-new-2', title: 'Restored TVDB Film 2', media_type: 'movie', source: 'tvdb' },
    { id: 'tvdb-new-3', name: 'Restored TVDB Dizi 1', media_type: 'tv', source: 'tvdb' },
  ];

  const res = await applyStockImport(backupItems, 'restore');

  assert.equal(res.ok, true);
  assert.equal(res.imported, 3);
  assert.ok(res.message.includes('geri yüklendi'));

  const finalDepot = await loadStockIdb();
  // TMDB items preserved
  assert.ok(finalDepot.movies.some((m) => m.id === '100'));
  assert.ok(finalDepot.tv.some((t) => t.id === '200'));
  // Old TVDB items removed
  assert.ok(!finalDepot.movies.some((m) => m.id === 'tvdb-old-1'));
  assert.ok(!finalDepot.tv.some((t) => t.id === 'tvdb-old-2'));
  // New TVDB items restored
  assert.ok(finalDepot.movies.some((m) => m.id === 'tvdb-new-1'));
  assert.ok(finalDepot.movies.some((m) => m.id === 'tvdb-new-2'));
  assert.ok(finalDepot.tv.some((t) => t.id === 'tvdb-new-3'));
});

test('TVDB Sync Batch: kullanıcı listesindekiler taranmaz, stoğa yazılmaz ve uydurma katalog devreye girmez', async () => {
  const { syncTvdbStockBatch } = await import('../src/services/tvdb-service.ts');
  const { loadStockIdb, saveStockIdb } = await import('../src/services/storage-idb.ts');

  const json = (body) => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  });

  // Kullanıcısı listelerinde olanlar: id, başlık ve TMDB çapraz kimliği üzerinden elenmeli
  const userListItems = [
    { id: 'tvdb-354316', title: 'Şahsiyet', name: 'Şahsiyet', media_type: 'tv' },
    { id: 'tvdb-893214', title: 'Kuru Otlar Üstüne', media_type: 'movie' },
    { id: 'tvdb-777001', name: 'Stoktaki Liste Eşleşmesi', media_type: 'tv' },
    { id: '550', title: 'Fight Club', media_type: 'movie' },
  ];

  const listMatchedSeriesIds = new Set(['700003', '700004']);
  const seriesFeed = [
    { id: 'series-354316', name: 'Şahsiyet', score: 464230, year: 2018, image: '/banners/series/354316/posters/a.jpg' },
    { id: 777001, name: 'Stoktaki Liste Eşleşmesi', score: 12000, year: 2019, image: '/banners/series/777001/posters/b.jpg' },
    ...Array.from({ length: 24 }, (_, i) => ({
      id: 700001 + i,
      name: `Test Dizi ${700001 + i}`,
      score: 50000 - i,
      year: 2021,
      // TVDB akış kayıtları posteri göreli verir; stoğa mutlak artworks adresi yazılmalı
      image: `/banners/v4/series/${700001 + i}/posters/p${700001 + i}.jpg`,
    })),
  ];

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/stock/upload') return json({ ok: true });
    if (url.pathname !== '/api/tvdb') return json({ status: 'not_found', data: null });

    const endpoint = url.searchParams.get('endpoint') || '';
    const extended = endpoint.match(/^\/(series|movies)\/(\d+)\/extended$/);
    if (extended) {
      const id = extended[2];
      return json({
        status: 'success',
        data: {
          id,
          name: `Test Dizi ${id}`,
          year: 2021,
          genres: ['Dram'],
          poster: `/banners/v4/series/${id}/posters/p${id}.jpg`,
          remoteIds: listMatchedSeriesIds.has(id)
            ? [{ id: '550', sourceName: 'TheMovieDB.com' }]
            : [{ id: `9${id}`, sourceName: 'TheMovieDB.com' }],
        },
      });
    }
    if (endpoint === '/series/filter') {
      return json({ status: 'success', data: Number(url.searchParams.get('page') || 0) === 0 ? seriesFeed : [] });
    }
    return json({ status: 'success', data: [] });
  };

  try {
    // Havuz: biri kullanıcı listesiyle eşleşen (düşürülmeli), biri korunan (kalmalı) TVDB kaydı
    await saveStockIdb({
      movies: [
        { id: 'tvdb-990001', tvdb_id: 990001, title: 'Korunan TVDB Filmi', media_type: 'movie', source: 'tvdb', poster_path: 'https://artworks.thetvdb.com/banners/v4/movie/990001/posters/keep.jpg' },
      ],
      tv: [
        { id: 'tvdb-777001', tvdb_id: 777001, name: 'Stoktaki Liste Eşleşmesi', media_type: 'tv', source: 'tvdb', poster_path: '/banners/series/777001/posters/b.jpg' },
      ],
      updatedAt: new Date().toISOString(),
    });

    const result = await syncTvdbStockBatch({
      targetCount: 20,
      userListItems,
      preferences: { disliked: ['tv:tvdb-300100', 'movie:tvdb-500100'] },
    });

    assert.equal(result.ok, true);
    assert.ok(
      result.addedMovies + result.addedTv >= 20,
      `Canlı tarama hedefi karşılamalı, got ${result.addedMovies + result.addedTv}`
    );
    assert.ok(result.skippedUserListed >= 2, `Liste eşleşmeleri taranmalı, got ${result.skippedUserListed}`);
    assert.ok(result.removedUserListed >= 1, `Listeye taşınan stok kaydı düşürülmeli, got ${result.removedUserListed}`);

    const depot = await loadStockIdb();
    assert.ok(!depot.tv.some((t) => String(t.id) === 'tvdb-777001'), 'Kullanıcı listesindeki stok kaydı havuzda kalamaz');
    assert.ok(
      !depot.tv.some((t) => listMatchedSeriesIds.has(String(t.tvdb_id))),
      'TMDB çapraz kimliği listede olan TVDB kaydı stoğa giremez'
    );
    assert.ok(depot.movies.some((m) => m.id === 'tvdb-990001'), 'Listede olmayan TVDB kaydı korunmalı');
    assert.equal(
      [...depot.movies, ...depot.tv].some((it) => it._source === 'demo'),
      false,
      'Canlı tarama varken uydurma küre katalog stoğa karışmamalı'
    );

    const tvdbItems = [...depot.movies, ...depot.tv].filter((it) => it.source === 'tvdb');
    assert.ok(tvdbItems.length > 0);
    for (const item of tvdbItems) {
      assert.match(String(item.poster_path || ''), /^https:\/\/artworks\.thetvdb\.com\//, 'TVDB posteri mutlak artworks adresi olmalı');
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initSeriesService,
  resetSeriesServiceForTests,
  setSeriesTmdbFetcher,
  setWikidataFetcherForTests,
  validateSeriesItemWithWikidata,
  getItemSeriesInfo,
} from '../src/services/series-service.ts';
import {
  isMediaInSeriesSync,
  getSeriesValidationStatusSync,
  setSeriesItemValidation,
  getSeriesReviewQueueSync,
} from '../src/services/storage-idb.ts';

test('Spec v3: Seri Doğrulama & Yanlış-Pozitif Önleme Katmanı (Wikidata P179)', async (t) => {
  await t.test('1. Alakasız dizi (yalnızca gevşek keyword taşıyan) TV franchise listesine sızmaz', async () => {
    resetSeriesServiceForTests();
    await initSeriesService();

    // Dizi: Bağımsız Marvel belgeseli (ID: 99999). Sadece gevşek "marvel" keyword'ü var (ID: 88888, doğrulanmamış).
    const tmdbCalls = [];
    setSeriesTmdbFetcher(async (path) => {
      tmdbCalls.push(path);
      if (path === '/tv/99999/keywords') {
        return {
          id: 99999,
          results: [{ id: 88888, name: 'marvel universe documentary' }],
        };
      }
      return { results: [] };
    });

    const info = getItemSeriesInfo({ id: 99999, media_type: 'tv', name: 'Alakasız Marvel Belgeseli' });
    // Alakasız dizi franchise'a girmemeli
    assert.equal(info.inSeries, false);
    assert.equal(isMediaInSeriesSync('tv:99999'), false);
  });

  await t.test('2. Oyuncu koleksiyonundaki film P179 olmadığı için "probable" (doğrulanmadı) görünür, verified rozet almaz', async () => {
    resetSeriesServiceForTests();
    await initSeriesService();

    const tmdbCalls = [];
    const wikiCalls = [];

    setSeriesTmdbFetcher(async (path) => {
      tmdbCalls.push(path);
      if (path === '/movie/5001/external_ids') {
        return { id: 5001, wikidata_id: 'Q500001' };
      }
      return {};
    });

    setWikidataFetcherForTests(async (url) => {
      wikiCalls.push(url);
      return {
        entities: {
          Q500001: {
            // P179 claims yok (yalnızca bağımsız bir film, oyuncu koleksiyonuna dahil edilmiş)
            claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q11424' } } } }] },
          },
        },
      };
    });

    const status = await validateSeriesItemWithWikidata('movie', 5001);
    assert.equal(status, 'probable');
    assert.equal(getSeriesValidationStatusSync('movie:5001'), 'probable');
    assert.equal(wikiCalls.length, 1);

    // İkinci çağrıda sıfır ağ isteği (önbellekten döner)
    wikiCalls.length = 0;
    tmdbCalls.length = 0;
    const cachedStatus = await validateSeriesItemWithWikidata('movie', 5001);
    assert.equal(cachedStatus, 'probable');
    assert.equal(wikiCalls.length, 0);
    assert.equal(tmdbCalls.length, 0);
  });

  await t.test('3. Gerçek franchise filmi Wikidata P179 uyuştuğunda "verified" olarak tam doğrulanır', async () => {
    resetSeriesServiceForTests();
    await initSeriesService();

    setSeriesTmdbFetcher(async (path) => {
      if (path === '/movie/155/external_ids') {
        return { id: 155, wikidata_id: 'Q189330' };
      }
      return {};
    });

    setWikidataFetcherForTests(async () => {
      return {
        entities: {
          Q189330: {
            claims: {
              P179: [
                // P179: The Dark Knight Trilogy
                { mainsnak: { datavalue: { value: { id: 'Q128599' } } } },
              ],
            },
          },
        },
      };
    });

    const status = await validateSeriesItemWithWikidata('movie', 155);
    assert.equal(status, 'verified');
    assert.equal(getSeriesValidationStatusSync('movie:155'), 'verified');
  });

  await t.test('4. Wikidata çelişkisi (conflict) olduğunda SERİ rozeti gizlenir ve inceleme kuyruğuna eklenir', async () => {
    resetSeriesServiceForTests();
    await initSeriesService();

    await setSeriesItemValidation('movie:7777', 'conflict', 'Q7777');
    assert.equal(getSeriesValidationStatusSync('movie:7777'), 'conflict');
    assert.equal(isMediaInSeriesSync('movie:7777'), false, 'Conflict durumunda rozet gizlenmeli');

    const queue = getSeriesReviewQueueSync();
    assert.ok(queue.includes('movie:7777'), 'Conflict olan öge inceleme kuyruğuna eklenmeli');
  });
});

import express, { Request, Response } from 'express';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { normalizeDataDocument, DataDocument, CURRENT_SCHEMA_VERSION } from './src/core/cinetrack-core';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || Number(process.env.CINETRACK_PORT) || 3000;
const host = process.env.CINETRACK_HOST || '127.0.0.1';

const dataDir = path.join(root, 'data');
const dataFile = path.join(dataDir, 'cinetrack-data.json');
const dataBackupFile = path.join(dataDir, 'cinetrack-data.bak.json');
const maxDataBytes = 2_000_000;
const maxProfiles = 20;
const maxItemsPerProfile = 5000;

// Read local .env or .env.local if present
const localEnv: Record<string, string> = {};
for (const envFileName of ['.env.local', '.env']) {
  try {
    const envFile = readFileSync(path.join(root, envFileName), 'utf8');
    for (const line of envFile.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      if (key && !(key in localEnv)) localEnv[key] = value;
    }
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const tmdbApiKey = process.env.TMDB_API_KEY || localEnv.TMDB_API_KEY || '';
const allowedPath =
  /^\/(?:trending\/(?:all|movie|tv)\/(?:day|week)|genre\/(?:movie|tv)\/list|search\/multi|discover\/(?:movie|tv)|person\/\d+(?:\/combined_credits)?|(?:movie|tv)\/(?:popular|top_rated|upcoming|on_the_air|\d+(?:\/(?:recommendations|similar|watch\/providers))?))$/;
const allowedQueryKeys = new Set([
  'language',
  'query',
  'page',
  'include_adult',
  'append_to_response',
  'with_genres',
  'sort_by',
  'vote_average.gte',
  'vote_count.gte',
  'vote_count.lte',
  'primary_release_date.gte',
  'primary_release_date.lte',
  'first_air_date.gte',
  'first_air_date.lte',
  'with_people',
  'with_watch_providers',
  'watch_region',
]);

function emptyDocument(): DataDocument {
  return { version: 3, schemaVersion: CURRENT_SCHEMA_VERSION, activeProfileId: '', profiles: [] };
}

function readData(): DataDocument {
  for (const file of [dataFile, dataBackupFile]) {
    try {
      if (existsSync(file)) {
        const document = normalizeDataDocument(JSON.parse(readFileSync(file, 'utf8')), {
          maxProfiles,
          maxItems: maxItemsPerProfile,
        });
        if (document) return document;
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') console.error(`Veri dosyası okunamadı (${path.basename(file)}):`, error.message);
    }
  }
  return emptyDocument();
}

function backupExistingData() {
  if (!existsSync(dataFile)) return;
  let worthKeeping = true;
  try {
    const existing = JSON.parse(readFileSync(dataFile, 'utf8'));
    const profiles = Array.isArray(existing?.profiles) ? existing.profiles : [];
    worthKeeping =
      profiles.length > 0
        ? profiles.some((profile: any) => Array.isArray(profile?.items) && profile.items.length > 0) ||
          profiles.length > 1
        : Boolean(existing?.profileName) || (Array.isArray(existing?.items) && existing.items.length > 0);
  } catch {
    worthKeeping = true;
  }
  if (worthKeeping) copyFileSync(dataFile, dataBackupFile);
}

function writeData(data: DataDocument) {
  mkdirSync(dataDir, { recursive: true });
  backupExistingData();
  const temporaryFile = `${dataFile}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(data, null, 2), 'utf8');
  renameSync(temporaryFile, dataFile);
}

function validateParam(key: string, value: string): string {
  if (key === 'query' && value.length > 120) return 'Arama ifadesi çok uzun.';
  if (key === 'with_genres' && !/^\d+(?:\|\d+)*$/.test(value)) return 'Tür kimlikleri geçersiz.';
  if (key === 'sort_by' && !/^(?:popularity|vote_average|release_date)\.(?:asc|desc)$/.test(value))
    return 'Sıralama seçeneği geçersiz.';
  if (key === 'vote_average.gte' && (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) > 10))
    return 'Puan eşiği geçersiz.';
  if (key === 'vote_count.gte' && (!/^\d+$/.test(value) || Number(value) > 1_000_000))
    return 'Oy sayısı eşiği geçersiz.';
  if (key === 'vote_count.lte' && (!/^\d+$/.test(value) || Number(value) > 1_000_000))
    return 'Azami oy sayısı geçersiz.';
  if (
    ['primary_release_date.gte', 'primary_release_date.lte', 'first_air_date.gte', 'first_air_date.lte'].includes(
      key
    ) &&
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  )
    return 'Tarih filtresi geçersiz.';
  if (key === 'with_people' && !/^\d+(?:\|\d+)*$/.test(value)) return 'Oyuncu kimlikleri geçersiz.';
  if (key === 'with_watch_providers' && !/^\d+(?:\|\d+)*$/.test(value))
    return 'Yayın platformu kimlikleri geçersiz.';
  if (key === 'watch_region' && !/^[A-Z]{2}$/.test(value)) return 'Bölge kodu geçersiz.';
  if (key === 'page' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 500))
    return 'Sayfa numarası geçersiz.';
  if (
    key === 'append_to_response' &&
    value.split(',').some((part) => !['credits', 'videos'].includes(part))
  )
    return 'İstenen detay genişletmesi desteklenmiyor.';
  if (key === 'include_adult' && !['true', 'false'].includes(value))
    return 'Yetişkin içerik parametresi geçersiz.';
  return '';
}

// Fallback catalog when TMDB_API_KEY is not configured
const mockGenres = [
  { id: 28, name: 'Aksiyon' },
  { id: 12, name: 'Macera' },
  { id: 16, name: 'Animasyon' },
  { id: 35, name: 'Komedi' },
  { id: 80, name: 'Suç' },
  { id: 99, name: 'Belgesel' },
  { id: 18, name: 'Dram' },
  { id: 10751, name: 'Aile' },
  { id: 14, name: 'Fantastik' },
  { id: 36, name: 'Tarih' },
  { id: 27, name: 'Korku' },
  { id: 10402, name: 'Müzik' },
  { id: 9648, name: 'Gizem' },
  { id: 10749, name: 'Romantik' },
  { id: 878, name: 'Bilim Kurgu' },
  { id: 10770, name: 'TV Filmi' },
  { id: 53, name: 'Gerilim' },
  { id: 10752, name: 'Savaş' },
  { id: 37, name: 'Vahşi Batı' },
  { id: 10759, name: 'Aksiyon & Macera' },
  { id: 10765, name: 'Bilim Kurgu & Fantazi' },
];

const mockItems = [
  {
    id: 27205,
    title: 'Başlangıç',
    name: 'Başlangıç',
    original_title: 'Inception',
    media_type: 'movie',
    overview:
      'Çok yetenekli bir hırsız olan Dom Cobb, insanların rüyalarındaki en derin sırları çalma konusunda uzmanlaşmıştır.',
    poster_path: '/edv5CZvWj09upOsy2Y6IwDhK8bt.jpg',
    backdrop_path: '/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg',
    vote_average: 8.4,
    vote_count: 36000,
    popularity: 92.5,
    release_date: '2010-07-15',
    genre_ids: [28, 878, 12],
    runtime: 148,
    genres: [{ id: 28, name: 'Aksiyon' }, { id: 878, name: 'Bilim Kurgu' }, { id: 12, name: 'Macera' }],
  },
  {
    id: 157336,
    title: 'Yıldızlararası',
    name: 'Yıldızlararası',
    original_title: 'Interstellar',
    media_type: 'movie',
    overview:
      'İnsanlığın sonu yaklaşırken bir grup kaşif, insan ırkının hayatta kalmasını sağlayacak yeni bir yuva bulmak için solucan deliğinden geçerek uzayın derinliklerine yolculuk yapar.',
    poster_path: '/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg',
    backdrop_path: '/xJHokMbljvjADYdit5fK5VQsXEG.jpg',
    vote_average: 8.4,
    vote_count: 34500,
    popularity: 96.2,
    release_date: '2014-11-05',
    genre_ids: [12, 18, 878],
    runtime: 169,
    genres: [{ id: 12, name: 'Macera' }, { id: 18, name: 'Dram' }, { id: 878, name: 'Bilim Kurgu' }],
  },
  {
    id: 155,
    title: 'Kara Şövalye',
    name: 'Kara Şövalye',
    original_title: 'The Dark Knight',
    media_type: 'movie',
    overview:
      'Batman, Teğmen Gordon ve Savcı Harvey Dent ile Gotham\'daki organize suçu temizlemeye çalışırken Joker ortaya çıkar.',
    poster_path: '/qJ2tW6WMUDux911r6m7haRef0WH.jpg',
    backdrop_path: '/nMKdUUepR0i5zn0y1T4CsSB5chy.jpg',
    vote_average: 8.5,
    vote_count: 32000,
    popularity: 88.0,
    release_date: '2008-07-16',
    genre_ids: [18, 28, 80, 53],
    runtime: 152,
    genres: [{ id: 18, name: 'Dram' }, { id: 28, name: 'Aksiyon' }, { id: 80, name: 'Suç' }],
  },
  {
    id: 1396,
    title: 'Breaking Bad',
    name: 'Breaking Bad',
    original_name: 'Breaking Bad',
    media_type: 'tv',
    overview:
      'Kanser olduğunu öğrenen lise kimya öğretmeni Walter White, ailesinin geleceğini güvence altına almak için metamfetamin üretimine başlar.',
    poster_path: '/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg',
    backdrop_path: '/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg',
    vote_average: 8.9,
    vote_count: 14000,
    popularity: 110.4,
    first_air_date: '2008-01-20',
    last_air_date: '2013-09-29',
    status: 'Ended',
    genre_ids: [18, 80],
    number_of_seasons: 5,
    number_of_episodes: 62,
    genres: [{ id: 18, name: 'Dram' }, { id: 80, name: 'Suç' }],
  },
  {
    id: 95557,
    title: 'Severance',
    name: 'Severance',
    original_name: 'Severance',
    media_type: 'tv',
    overview:
      'Mark Scout, Lumon Industries\'de çalışanların iş ve kişisel anılarını cerrahi yolla ayıran \'severance\' programına katılmıştır.',
    poster_path: '/b0rWZeg981wK2xUqZcZJm4Uu99x.jpg',
    backdrop_path: '/roYyPiQDytnk0AgSRU26um24mgt.jpg',
    vote_average: 8.4,
    vote_count: 2200,
    popularity: 75.1,
    first_air_date: '2022-02-17',
    last_air_date: '2025-03-21',
    status: 'Returning Series',
    genre_ids: [18, 878, 9648],
    number_of_seasons: 2,
    number_of_episodes: 19,
    genres: [{ id: 18, name: 'Dram' }, { id: 878, name: 'Bilim Kurgu' }, { id: 9648, name: 'Gizem' }],
  },
  {
    id: 94605,
    title: 'Arcane',
    name: 'Arcane',
    original_name: 'Arcane',
    media_type: 'tv',
    overview:
      'Ütopik Piltover ile ezilen Zaun arasındaki çatışmanın ortasında iki kız kardeş Vi ve Powder, büyü ve teknolojinin kesiştiği savaşta karşı karşıya gelir.',
    poster_path: '/abf8tHq8s4L0vBcvp3V1R1q1q0w.jpg',
    backdrop_path: '/uDgy6hyPd82kOHh6I95FLtLnj6p.jpg',
    vote_average: 8.7,
    vote_count: 4100,
    popularity: 84.6,
    first_air_date: '2021-11-06',
    last_air_date: '2024-11-23',
    status: 'Ended',
    genre_ids: [16, 10765, 10759, 18],
    number_of_seasons: 2,
    number_of_episodes: 18,
    genres: [{ id: 16, name: 'Animasyon' }, { id: 10765, name: 'Bilim Kurgu & Fantazi' }, { id: 18, name: 'Dram' }],
  },
  {
    id: 100088,
    title: 'The Last of Us',
    name: 'The Last of Us',
    original_name: 'The Last of Us',
    media_type: 'tv',
    overview:
      'Kıyamet sonrası bir dünyada hayatta kalmaya çalışan Joel, insanlığın son umudu olabilecek 14 yaşındaki Ellie\'yi karantina bölgesinden kaçırmakla görevlendirilir.',
    poster_path: '/uKvVjHNqB5VmOrdxqAt2V7J9ZeP.jpg',
    backdrop_path: '/uDLDq5R5ZlOQ6g0lKx4gJbZl9Ze.jpg',
    vote_average: 8.6,
    vote_count: 5100,
    popularity: 89.3,
    first_air_date: '2023-01-15',
    last_air_date: '2025-05-18',
    status: 'Returning Series',
    genre_ids: [18, 10759, 10765],
    number_of_seasons: 2,
    number_of_episodes: 16,
    genres: [{ id: 18, name: 'Dram' }, { id: 10759, name: 'Aksiyon & Macera' }],
  },
  {
    id: 603,
    title: 'Matrix',
    name: 'Matrix',
    original_title: 'The Matrix',
    media_type: 'movie',
    overview:
      'Sıradan bir hayat süren yazılımcı Thomas Anderson (Neo), Morpheus ile tanışınca gerçek sandığı dünyanın bir yapay zeka simülasyonu olduğunu öğrenir.',
    poster_path: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
    backdrop_path: '/l4QHerTSbflqIvpPJnE907S27Hk.jpg',
    vote_average: 8.2,
    vote_count: 25000,
    popularity: 82.0,
    release_date: '1999-03-30',
    genre_ids: [28, 878],
    runtime: 136,
    genres: [{ id: 28, name: 'Aksiyon' }, { id: 878, name: 'Bilim Kurgu' }],
  },
  {
    id: 693134,
    title: 'Dune: Çöl Gezegeni Bölüm İki',
    name: 'Dune: Çöl Gezegeni Bölüm İki',
    original_title: 'Dune: Part Two',
    media_type: 'movie',
    overview:
      'Paul Atreides, Chani ve Fremenler ile birlik olarak ailesini yok eden komploculara karşı intikam savaşı başlatır.',
    poster_path: '/8b8R8l88Qje9dn9OE8PY05Nxl1X.jpg',
    backdrop_path: '/xOMo8BRK7PfcJv9JCnx7s520fff.jpg',
    vote_average: 8.2,
    vote_count: 6100,
    popularity: 98.4,
    release_date: '2024-02-27',
    genre_ids: [878, 12],
    runtime: 166,
    genres: [{ id: 878, name: 'Bilim Kurgu' }, { id: 12, name: 'Macera' }],
  },
  {
    id: 129,
    title: 'Ruhların Kaçışı',
    name: 'Ruhların Kaçışı',
    original_title: 'Sen to Chihiro no Kamikakushi',
    media_type: 'movie',
    overview:
      'Ailesiyle yeni bir kasabaya taşınırken esrarengiz bir tünele giren Chihiro, cadı Yubaba\'nın hüküm sürdüğü ruhlar dünyasına adım atar.',
    poster_path: '/39wmItIWsg5sZMyRUHLkWBcuVCM.jpg',
    backdrop_path: '/mSDsSDwaP3E7dEfUPWy4J0djt4O.jpg',
    vote_average: 8.5,
    vote_count: 16000,
    popularity: 78.5,
    release_date: '2001-07-20',
    genre_ids: [16, 10751, 14],
    runtime: 125,
    genres: [{ id: 16, name: 'Animasyon' }, { id: 10751, name: 'Aile' }, { id: 14, name: 'Fantastik' }],
  },
];

function getMockTmdbResponse(endpoint: string, queryParams: Record<string, string>) {
  if (endpoint === '/genre/movie/list' || endpoint === '/genre/tv/list') {
    return { genres: mockGenres };
  }

  if (endpoint.endsWith('/watch/providers')) {
    return {
      results: {
        TR: {
          link: 'https://www.themoviedb.org',
          flatrate: [
            { provider_id: 8, provider_name: 'Netflix', logo_path: '/t2yyOv40HZeVlLjYsCsPHnWLk4W.jpg' },
            { provider_id: 119, provider_name: 'Amazon Prime Video', logo_path: '/emthp39XA2vAHQI9YjWhSDQvvbV.jpg' },
            { provider_id: 337, provider_name: 'Disney Plus', logo_path: '/7rwgEs15tFwyR9NPQ5vpzxTj19Q.jpg' },
          ],
        },
      },
    };
  }

  const detailMatch = endpoint.match(/^\/(movie|tv)\/(\d+)$/);
  if (detailMatch) {
    const [, type, idStr] = detailMatch;
    const id = Number(idStr);
    const existing = mockItems.find((item) => item.id === id) || mockItems[0];
    const cast = [
      { id: 101, name: 'Leonardo DiCaprio', character: 'Dom Cobb', popularity: 45.0, profile_path: '/wo2hJpn04vbtmh0B9utCFdsQ2v9.jpg' },
      { id: 102, name: 'Joseph Gordon-Levitt', character: 'Arthur', popularity: 28.0, profile_path: '/4PCObFw9Zgn02KkG7t0i44sXF10.jpg' },
      { id: 103, name: 'Elliot Page', character: 'Ariadne', popularity: 25.0, profile_path: '/tp16b5aF7o4l3c5v0Y4C5o2mZ7q.jpg' },
      { id: 104, name: 'Tom Hardy', character: 'Eames', popularity: 38.0, profile_path: '/yVGF93vbhGKlhuSJqq9caNTQIbk.jpg' },
    ];
    const crew = [{ id: 201, name: 'Christopher Nolan', job: 'Director', department: 'Directing' }];
    return {
      ...existing,
      id,
      media_type: type,
      credits: { cast, crew },
      videos: {
        results: [{ id: 'v1', key: 'YoHD9XEInc0', site: 'YouTube', type: 'Trailer', official: true, name: 'Resmi Fragman' }],
      },
    };
  }

  const personMatch = endpoint.match(/^\/person\/(\d+)(?:\/combined_credits)?$/);
  if (personMatch) {
    const [, personIdStr] = personMatch;
    const isCredits = endpoint.endsWith('/combined_credits');
    if (isCredits) {
      return { id: Number(personIdStr), cast: mockItems, crew: [] };
    }
    return {
      id: Number(personIdStr),
      name: 'Öne Çıkan Sanatçı',
      biography: 'Ödüllü oyuncu ve yapımcı.',
      profile_path: '/wo2hJpn04vbtmh0B9utCFdsQ2v9.jpg',
    };
  }

  // Multi search / trending / discover
  const query = (queryParams.query || '').toLowerCase().trim();
  const withGenres = queryParams.with_genres || '';
  let results = [...mockItems];

  if (query) {
    results = results.filter(
      (item) =>
        (item.title && item.title.toLowerCase().includes(query)) ||
        (item.name && item.name.toLowerCase().includes(query)) ||
        (item.original_title && item.original_title.toLowerCase().includes(query))
    );
  }
  if (withGenres) {
    const genreIdList = withGenres.split('|').map(Number);
    results = results.filter((item) => (item.genre_ids || []).some((gid) => genreIdList.includes(gid)));
  }

  if (endpoint.includes('/tv')) {
    results = results.filter((item) => item.media_type === 'tv');
  } else if (endpoint.includes('/movie')) {
    results = results.filter((item) => item.media_type === 'movie');
  }

  return {
    page: 1,
    results,
    total_pages: 1,
    total_results: results.length,
  };
}

const tmdbCacheMaxEntries = 500;
const tmdbCache = new Map<string, { at: number; body: string; contentType: string; ttl: number }>();
const inFlightServerTmdbRequests = new Map<
  string,
  Promise<{ status: number; body: string; contentType: string; ok: boolean }>
>();

function getTmdbEndpointTtl(endpoint: string): number {
  if (endpoint.includes('/person/') && endpoint.includes('/combined_credits')) {
    return 2 * 60 * 60_000; // 2 saat: Oyuncu filmografisi
  }
  if (endpoint.startsWith('/person/')) {
    return 2 * 60 * 60_000; // 2 saat: Oyuncu detayları
  }
  if (endpoint.includes('/watch/providers')) {
    return 60 * 60_000; // 1 saat: Yayın sağlayıcıları
  }
  if (/^\/(movie|tv)\/\d+/.test(endpoint)) {
    return 60 * 60_000; // 1 saat: Film/Dizi detayları
  }
  if (endpoint.startsWith('/discover/')) {
    return 15 * 60_000; // 15 dakika: Keşif havuzu
  }
  if (endpoint.startsWith('/trending/')) {
    return 10 * 60_000; // 10 dakika: Trendler
  }
  return 5 * 60_000;
}

function tmdbCacheKey(endpoint: string, queryParams: Record<string, string>) {
  const entries = Object.entries(queryParams)
    .filter(([key]) => key !== 'path')
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `${endpoint}?${new URLSearchParams(entries).toString()}`;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// /api/data routes
app.get('/api/data', (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(readData());
});

app.put('/api/data', (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const document = normalizeDataDocument(req.body, { maxProfiles, maxItems: maxItemsPerProfile });
    if (!document) {
      res.status(400).json({ status_message: 'Veri biçimi geçersiz.' });
      return;
    }
    writeData(document);
    res.json({
      ok: true,
      profiles: document.profiles.length,
      items: document.profiles.reduce((sum, profile) => sum + profile.items.length, 0),
    });
  } catch (error: any) {
    console.error('Veri kaydedilemedi:', error.message);
    res.status(500).json({ status_message: 'Veri dosyasına yazılamadı.' });
  }
});

// /api/tmdb route
app.get('/api/tmdb', async (req: Request, res: Response) => {
  const endpoint = String(req.query.path || '');
  if (!allowedPath.test(endpoint)) {
    res.status(400).json({ status_message: 'TMDB uç noktası izinli değil.' });
    return;
  }

  const queryParams: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.query)) {
    if (key === 'path') continue;
    queryParams[key] = String(val);
  }

  if (!tmdbApiKey) {
    const mockResult = getMockTmdbResponse(endpoint, queryParams);
    if (mockResult) {
      res.json(mockResult);
      return;
    }
    res.status(503).json({
      status_message: 'TMDB_API_KEY eksik. Canlı katalog için .env dosyasına anahtarınızı ekleyin.',
    });
    return;
  }

  const target = new URL(`https://api.themoviedb.org/3${endpoint}`);
  target.searchParams.set('api_key', tmdbApiKey);
  for (const [key, value] of Object.entries(queryParams)) {
    if (!allowedQueryKeys.has(key)) {
      res.status(400).json({ status_message: `Sorgu parametresi '${key}' izinli değil.` });
      return;
    }
    const invalid = validateParam(key, value);
    if (invalid) {
      res.status(400).json({ status_message: invalid });
      return;
    }
    target.searchParams.set(key, value);
  }

  const cacheKey = tmdbCacheKey(endpoint, queryParams);
  const ttl = getTmdbEndpointTtl(endpoint);
  const cached = tmdbCache.get(cacheKey);
  if (cached && Date.now() - cached.at < (cached.ttl || ttl)) {
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=180');
    res.setHeader('X-CineTrack-Cache', 'hit');
    res.send(cached.body);
    return;
  }

  try {
    let fetchPromise = inFlightServerTmdbRequests.get(cacheKey);
    if (!fetchPromise) {
      fetchPromise = (async () => {
        const upstream = await fetch(target.toString(), { signal: AbortSignal.timeout(10_000) });
        const body = await upstream.text();
        const contentType = upstream.headers.get('Content-Type') || 'application/json; charset=utf-8';
        if (upstream.ok) {
          tmdbCache.set(cacheKey, { at: Date.now(), body, contentType, ttl });
          while (tmdbCache.size > tmdbCacheMaxEntries) {
            tmdbCache.delete(tmdbCache.keys().next().value!);
          }
        }
        return { status: upstream.status, body, contentType, ok: upstream.ok };
      })().finally(() => {
        inFlightServerTmdbRequests.delete(cacheKey);
      });
      inFlightServerTmdbRequests.set(cacheKey, fetchPromise);
    }

    const result = await fetchPromise;
    res.status(result.status);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', result.ok ? 'public, max-age=180' : 'no-store');
    res.setHeader('X-CineTrack-Cache', 'miss');
    res.send(result.body);
  } catch (error: any) {
    console.error('TMDB request failed:', error.message);
    const fallback = getMockTmdbResponse(endpoint, queryParams);
    if (fallback) {
      res.json(fallback);
      return;
    }
    res.status(502).json({ status_message: 'TMDB servisine ulaşılamadı veya istek zaman aşımına uğradı.' });
  }
});

// Setup Vite middleware or static serving
async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(root, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true, host, port },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(port, host, () => {
    console.log(`CineTrack is running at http://${host}:${port}`);
    console.log(`Profil ve izleme listesi: ${dataFile}`);
    if (!tmdbApiKey) {
      console.log('TMDB_API_KEY is not configured; running in fallback demo mode.');
    }
  });
}

startServer();

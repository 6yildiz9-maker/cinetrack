import type { Request, Response } from 'express';

export const ALLOWED_TMDB_PATH =
  /^\/(?:trending\/(?:all|movie|tv)\/(?:day|week)|genre\/(?:movie|tv)\/list|search\/multi|discover\/(?:movie|tv)|person\/\d+(?:\/combined_credits)?|tv\/\d+\/season\/\d+|(?:movie|tv)\/(?:popular|top_rated|upcoming|now_playing|on_the_air|\d+(?:\/(?:recommendations|similar|watch\/providers))?))$/;

export const ALLOWED_TMDB_QUERY_KEYS = new Set([
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
  'with_cast',
  'with_watch_providers',
  'watch_region',
]);

export function validateTmdbParam(key: string, value: string): string {
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
  if ((key === 'with_people' || key === 'with_cast') && !/^\d+(?:\|\d+)*$/.test(value))
    return 'Oyuncu kimlikleri geçersiz.';
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
      "Batman, Teğmen Gordon ve Savcı Harvey Dent ile Gotham'daki organize suçu temizlemeye çalışırken Joker ortaya çıkar.",
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
      "Mark Scout, Lumon Industries'de çalışanların iş ve kişisel anılarını cerrahi yolla ayıran 'severance' programına katılmıştır.",
    poster_path: '/b0rWZeg981wK2xUqZcZJm4Uu99x.jpg',
    backdrop_path: '/roYyPiQDytnk0AgSRU26um24mgt.jpg',
    vote_average: 8.4,
    vote_count: 2200,
    popularity: 75.1,
    first_air_date: '2022-02-17',
    last_air_date: '2025-03-21',
    next_episode_to_air: {
      id: 9555701,
      name: 'Cold Harbor Sonrası',
      episode_number: 1,
      season_number: 3,
      air_date: '2026-11-15',
    },
    status: 'Returning Series',
    genre_ids: [18, 878, 9648],
    number_of_seasons: 3,
    number_of_episodes: 28,
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
      "Kıyamet sonrası bir dünyada hayatta kalmaya çalışan Joel, insanlığın son umudu olabilecek 14 yaşındaki Ellie'yi karantina bölgesinden kaçırmakla görevlendirilir.",
    poster_path: '/uKvVjHNqB5VmOrdxqAt2V7J9ZeP.jpg',
    backdrop_path: '/uDLDq5R5ZlOQ6g0lKx4gJbZl9Ze.jpg',
    vote_average: 8.6,
    vote_count: 5100,
    popularity: 89.3,
    first_air_date: '2023-01-15',
    last_air_date: '2025-05-18',
    next_episode_to_air: {
      id: 10008801,
      name: 'Seattle Gün 1',
      episode_number: 1,
      season_number: 3,
      air_date: '2026-12-06',
    },
    status: 'Returning Series',
    genre_ids: [18, 10759, 10765],
    number_of_seasons: 3,
    number_of_episodes: 24,
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
      "Ailesiyle yeni bir kasabaya taşınırken esrarengiz bir tünele giren Chihiro, cadı Yubaba'nın hüküm sürdüğü ruhlar dünyasına adım atar.",
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
  { id: 329865, title: 'Geliş', name: 'Geliş', original_title: 'Arrival', media_type: 'movie', overview: 'Dünyanın on iki noktasına inen gizemli uzay gemileriyle iletişim kurmak için dilbilimci Louise Banks görevlendirilir.', poster_path: null, backdrop_path: null, vote_average: 7.9, vote_count: 17200, popularity: 71.4, release_date: '2016-11-10', genre_ids: [18, 878, 9648], runtime: 116 },
  { id: 872585, title: 'Oppenheimer', name: 'Oppenheimer', original_title: 'Oppenheimer', media_type: 'movie', overview: 'Fizikçi J. Robert Oppenheimer ve Manhattan Projesi ekibinin atom bombasını geliştirme süreci.', poster_path: null, backdrop_path: null, vote_average: 8.1, vote_count: 9800, popularity: 91.2, release_date: '2023-07-19', genre_ids: [18, 36], runtime: 181 },
  { id: 496243, title: 'Parazit', name: 'Parazit', original_title: 'Gisaengchung', media_type: 'movie', overview: 'Yoksul Kim ailesi, varlıklı Park ailesinin evinde birer birer çalışmaya başlayınca beklenmedik sırlar açığa çıkar.', poster_path: null, backdrop_path: null, vote_average: 8.5, vote_count: 18100, popularity: 83.6, release_date: '2019-05-30', genre_ids: [35, 53, 18], runtime: 132 },
  { id: 335984, title: 'Blade Runner 2049: Bıçak Sırtı', name: 'Blade Runner 2049: Bıçak Sırtı', original_title: 'Blade Runner 2049', media_type: 'movie', overview: 'Genç bir blade runner, toplumu kaosa sürükleyebilecek uzun süredir gömülü bir sırrı ortaya çıkarır.', poster_path: null, backdrop_path: null, vote_average: 7.6, vote_count: 13400, popularity: 76.8, release_date: '2017-10-04', genre_ids: [878, 18, 9648], runtime: 164 },
  { id: 550, title: 'Dövüş Kulübü', name: 'Dövüş Kulübü', original_title: 'Fight Club', media_type: 'movie', overview: 'Uykusuzluk çeken bir ofis çalışanı ile karizmatik sabun satıcısı Tyler Durden yeraltı dövüş kulübü kurar.', poster_path: null, backdrop_path: null, vote_average: 8.4, vote_count: 29100, popularity: 80.1, release_date: '1999-10-15', genre_ids: [18, 53], runtime: 139 },
  { id: 1124, title: 'Prestij', name: 'Prestij', original_title: 'The Prestige', media_type: 'movie', overview: 'Viktorya dönemi Londrasında iki rakip illüzyonist, kusursuz sahne numarası uğruna tehlikeli bir saplantıya sürüklenir.', poster_path: null, backdrop_path: null, vote_average: 8.2, vote_count: 15800, popularity: 69.5, release_date: '2006-10-19', genre_ids: [18, 9648, 878], runtime: 130 },
  { id: 244786, title: 'Whiplash', name: 'Whiplash', original_title: 'Whiplash', media_type: 'movie', overview: 'Genç caz davulcusu Andrew, acımasız eğitmeni Terence Fletcher yönetiminde sınırlarını zorlar.', poster_path: null, backdrop_path: null, vote_average: 8.4, vote_count: 14900, popularity: 67.3, release_date: '2014-10-10', genre_ids: [18, 10402], runtime: 107 },
  { id: 545611, title: 'Her Şey Her Yerde Aynı Anda', name: 'Her Şey Her Yerde Aynı Anda', original_title: 'Everything Everywhere All at Once', media_type: 'movie', overview: 'Çamaşırhane işleten Evelyn, paralel evrenlerdeki versiyonlarıyla bağlantı kurarak çoklu evreni kurtarmak zorunda kalır.', poster_path: null, backdrop_path: null, vote_average: 7.8, vote_count: 6800, popularity: 72.9, release_date: '2022-03-24', genre_ids: [28, 12, 878, 35], runtime: 139 },
  { id: 680, title: 'Ucuz Roman', name: 'Ucuz Roman', original_title: 'Pulp Fiction', media_type: 'movie', overview: 'Los Angeles yeraltı dünyasından kesişen dört çarpıcı suç öyküsü.', poster_path: null, backdrop_path: null, vote_average: 8.5, vote_count: 27600, popularity: 85.4, release_date: '1994-09-10', genre_ids: [53, 80], runtime: 154 },
  { id: 13, title: 'Forrest Gump', name: 'Forrest Gump', original_title: 'Forrest Gump', media_type: 'movie', overview: 'İyi kalpli Forrest Gump, yirminci yüzyıl Amerikan tarihinin dönüm noktalarına tanıklık eder.', poster_path: null, backdrop_path: null, vote_average: 8.5, vote_count: 27100, popularity: 79.0, release_date: '1994-06-23', genre_ids: [35, 18, 10749], runtime: 142 },
  { id: 278, title: 'Esaretin Bedeli', name: 'Esaretin Bedeli', original_title: 'The Shawshank Redemption', media_type: 'movie', overview: 'Haksız yere müebbet hapse mahkûm edilen bankacı Andy Dufresne ile Red arasındaki unutulmaz dostluk.', poster_path: null, backdrop_path: null, vote_average: 8.7, vote_count: 26900, popularity: 90.3, release_date: '1994-09-23', genre_ids: [18, 80], runtime: 142 },
  { id: 76341, title: 'Mad Max: Öfkeli Yollar', name: 'Mad Max: Öfkeli Yollar', original_title: 'Mad Max: Fury Road', media_type: 'movie', overview: 'Çorak topraklarda İmparatoriçe Furiosa ve Max, tiran Immortan Joe ordusundan kaçış mücadelesi verir.', poster_path: null, backdrop_path: null, vote_average: 7.6, vote_count: 22300, popularity: 74.1, release_date: '2015-05-13', genre_ids: [28, 12, 878], runtime: 120 },
  { id: 376867, title: 'Ay Işığı', name: 'Ay Işığı', original_title: 'Moonlight', media_type: 'movie', overview: 'Miami mahallelerinde büyüyen Chiron adlı genç bir adamın hayatının üç dönemi.', poster_path: null, backdrop_path: null, vote_average: 7.4, vote_count: 6900, popularity: 42.5, release_date: '2016-10-21', genre_ids: [18], runtime: 111 },
  { id: 508442, title: 'Soul', name: 'Soul', original_title: 'Soul', media_type: 'movie', overview: 'Caz piyanisti Joe Gardner, beklenmedik bir kaza sonucu ruhların hayata hazırlandığı Öncesi Dünyası ile tanışır.', poster_path: null, backdrop_path: null, vote_average: 8.1, vote_count: 10300, popularity: 61.2, release_date: '2020-12-25', genre_ids: [16, 10751, 35, 14], runtime: 100 },
  { id: 399055, title: 'Suyun Sesi', name: 'Suyun Sesi', original_title: 'The Shape of Water', media_type: 'movie', overview: 'Soğuk Savaş döneminde gizli bir devlet laboratuvarında çalışan dilsiz temizlikçi ile gizemli su canlısının öyküsü.', poster_path: null, backdrop_path: null, vote_average: 7.2, vote_count: 11900, popularity: 48.7, release_date: '2017-12-01', genre_ids: [18, 14, 10749], runtime: 123 },
  { id: 530915, title: '1917', name: '1917', original_title: '1917', media_type: 'movie', overview: 'Birinci Dünya Savaşında iki genç İngiliz askeri, binlerce askeri kurtaracak mesajı düşman hattının ötesine taşımalıdır.', poster_path: null, backdrop_path: null, vote_average: 8.0, vote_count: 12100, popularity: 66.0, release_date: '2019-12-25', genre_ids: [10752, 18, 36], runtime: 119 },
  { id: 70523, title: 'Dark', name: 'Dark', original_name: 'Dark', media_type: 'tv', overview: 'Almanya kasabası Winden içinde kaybolan iki çocuk, dört ailenin kuşaklar boyu süren zaman yolculuğu sırlarını açığa çıkarır.', poster_path: null, backdrop_path: null, vote_average: 8.4, vote_count: 6500, popularity: 81.2, first_air_date: '2017-12-01', status: 'Ended', genre_ids: [18, 9648, 10765], number_of_seasons: 3, number_of_episodes: 26 },
  { id: 87108, title: 'Chernobyl', name: 'Chernobyl', original_name: 'Chernobyl', media_type: 'tv', overview: '1986 Çernobil nükleer felaketinin perde arkası ve felaketi durdurmak için hayatını feda eden insanların hikâyesi.', poster_path: null, backdrop_path: null, vote_average: 8.7, vote_count: 6100, popularity: 77.9, first_air_date: '2019-05-06', status: 'Ended', genre_ids: [18, 36], number_of_seasons: 1, number_of_episodes: 5 },
  { id: 60059, title: 'Better Call Saul', name: 'Better Call Saul', original_name: 'Better Call Saul', media_type: 'tv', overview: 'Küçük çaplı avukat Jimmy McGill adım adım ahlaki sınırları esneterek Saul Goodman kimliğine dönüşür.', poster_path: null, backdrop_path: null, vote_average: 8.7, vote_count: 5200, popularity: 88.1, first_air_date: '2015-02-08', status: 'Ended', genre_ids: [80, 18], number_of_seasons: 6, number_of_episodes: 63 },
  { id: 136315, title: 'The Bear', name: 'The Bear', original_name: 'The Bear', media_type: 'tv', overview: 'Genç şef Carmy, ağabeyinden kalan Chicago sandviç dükkânını ayakta tutmak için kaotik mutfak ekibiyle mücadele eder.', poster_path: null, backdrop_path: null, vote_average: 8.3, vote_count: 1400, popularity: 79.4, first_air_date: '2022-06-23', status: 'Returning Series', genre_ids: [18, 35], number_of_seasons: 3, number_of_episodes: 28 },
  { id: 76331, title: 'Succession', name: 'Succession', original_name: 'Succession', media_type: 'tv', overview: 'Medya imparatoru Logan Roy yaşlanırken dört çocuğu küresel şirketin kontrolü için acımasız bir güç savaşına girer.', poster_path: null, backdrop_path: null, vote_average: 8.3, vote_count: 1300, popularity: 73.6, first_air_date: '2018-06-03', status: 'Ended', genre_ids: [18], number_of_seasons: 4, number_of_episodes: 39 },
  { id: 67744, title: 'Mindhunter', name: 'Mindhunter', original_name: 'Mindhunter', media_type: 'tv', overview: '1970 sonlarında iki FBI ajanı, hapisteki seri suçlularla görüşerek davranış bilimi profilleme yöntemlerini kurar.', poster_path: null, backdrop_path: null, vote_average: 8.1, vote_count: 2400, popularity: 64.5, first_air_date: '2017-10-13', status: 'Ended', genre_ids: [18, 80], number_of_seasons: 2, number_of_episodes: 19 },
  { id: 125988, title: 'Silo', name: 'Silo', original_name: 'Silo', media_type: 'tv', overview: 'Zehirli bir gelecekte yerin yüzlerce kat altındaki dev bir siloda yaşayan toplulukta mühendis Juliette gerçeğin peşine düşer.', poster_path: null, backdrop_path: null, vote_average: 8.2, vote_count: 1350, popularity: 82.7, first_air_date: '2023-05-04', status: 'Returning Series', genre_ids: [10765, 18, 9648], number_of_seasons: 2, number_of_episodes: 20 },
  { id: 126308, title: 'Shōgun', name: 'Shōgun', original_name: 'Shōgun', media_type: 'tv', overview: '1600 yılı Japonyasında Lord Yoshii Toranaga ile gemisi kıyıya vuran İngiliz kılavuz John Blackthorne kader birliği yapar.', poster_path: null, backdrop_path: null, vote_average: 8.5, vote_count: 1650, popularity: 86.2, first_air_date: '2024-02-27', status: 'Returning Series', genre_ids: [18, 10759, 10768], number_of_seasons: 1, number_of_episodes: 10 },
  { id: 66732, title: 'Stranger Things', name: 'Stranger Things', original_name: 'Stranger Things', media_type: 'tv', overview: 'Küçük Hawkins kasabasında bir çocuğun kayboluşu gizli deneyleri ve doğaüstü Baş Aşağı dünyayı ortaya çıkarır.', poster_path: null, backdrop_path: null, vote_average: 8.6, vote_count: 17400, popularity: 94.0, first_air_date: '2016-07-15', status: 'Returning Series', genre_ids: [18, 10765, 9648], number_of_seasons: 4, number_of_episodes: 34 },
  { id: 42009, title: 'Black Mirror', name: 'Black Mirror', original_name: 'Black Mirror', media_type: 'tv', overview: 'Modern toplumun teknolojiyle karanlık ve beklenmedik kesişimlerini ele alan bağımsız bilim kurgu antolojisi.', poster_path: null, backdrop_path: null, vote_average: 8.3, vote_count: 4900, popularity: 78.3, first_air_date: '2011-12-04', status: 'Returning Series', genre_ids: [10765, 18, 9648], number_of_seasons: 6, number_of_episodes: 27 },
  { id: 60625, title: 'Fargo', name: 'Fargo', original_name: 'Fargo', media_type: 'tv', overview: 'Orta Batı kasabalarında sıradan insanların karıştığı kara mizah dolu suç öyküleri.', poster_path: null, backdrop_path: null, vote_average: 8.3, vote_count: 2600, popularity: 68.4, first_air_date: '2014-04-15', status: 'Ended', genre_ids: [80, 18], number_of_seasons: 5, number_of_episodes: 51 },
  { id: 46648, title: 'True Detective', name: 'True Detective', original_name: 'True Detective', media_type: 'tv', overview: 'Zorlu cinayet soruşturmalarında kendi geçmişleriyle yüzleşen dedektiflerin karanlık antoloji dizisi.', poster_path: null, backdrop_path: null, vote_average: 8.3, vote_count: 3400, popularity: 74.9, first_air_date: '2014-01-12', status: 'Returning Series', genre_ids: [18, 9648, 80], number_of_seasons: 4, number_of_episodes: 30 },
  { id: 82856, title: 'The Mandalorian', name: 'The Mandalorian', original_name: 'The Mandalorian', media_type: 'tv', overview: 'Yeni Cumhuriyet sınırlarının ötesinde yalnız bir ödül avcısı, gizemli bir çocuğu korumak için galakside yolculuk eder.', poster_path: null, backdrop_path: null, vote_average: 8.4, vote_count: 9900, popularity: 83.1, first_air_date: '2019-11-12', status: 'Returning Series', genre_ids: [10765, 10759, 18], number_of_seasons: 3, number_of_episodes: 24 },
  { id: 83867, title: 'Andor', name: 'Andor', original_name: 'Andor', media_type: 'tv', overview: 'İmparatorluğun yükselişine karşı filizlenen direnişin ortasında Cassian Andor casusluk dünyasına adım atar.', poster_path: null, backdrop_path: null, vote_average: 8.2, vote_count: 1200, popularity: 69.8, first_air_date: '2022-09-21', status: 'Returning Series', genre_ids: [10765, 10759, 18], number_of_seasons: 1, number_of_episodes: 12 },
  { id: 1438, title: 'The Wire', name: 'The Wire', original_name: 'The Wire', media_type: 'tv', overview: 'Baltimore şehrini emniyet, liman işçileri, siyaset, okullar ve basın gözünden inceleyen gerçekçi suç draması.', poster_path: null, backdrop_path: null, vote_average: 8.6, vote_count: 2200, popularity: 66.7, first_air_date: '2002-06-02', status: 'Ended', genre_ids: [80, 18], number_of_seasons: 5, number_of_episodes: 60 },
  { id: 1398, title: 'The Sopranos', name: 'The Sopranos', original_name: 'The Sopranos', media_type: 'tv', overview: 'New Jersey suç örgütü lideri Tony Soprano, aile hayatı ile yeraltı dünyası arasındaki dengeyi korumaya çalışır.', poster_path: null, backdrop_path: null, vote_average: 8.6, vote_count: 2700, popularity: 72.1, first_air_date: '1999-01-10', status: 'Ended', genre_ids: [18, 80], number_of_seasons: 6, number_of_episodes: 86 },
  { id: 63351, title: 'Mr. Robot', name: 'Mr. Robot', original_name: 'Mr. Robot', media_type: 'tv', overview: 'Siber güvenlik mühendisi Elliot Alderson, gizemli aktivist grubu fsociety tarafından küresel finans devine karşı göreve çağrılır.', poster_path: null, backdrop_path: null, vote_average: 8.2, vote_count: 4500, popularity: 70.4, first_air_date: '2015-06-24', status: 'Ended', genre_ids: [80, 18], number_of_seasons: 4, number_of_episodes: 45 },
  { id: 93405, title: 'Squid Game', name: 'Squid Game', original_name: 'Ojingeo Geim', media_type: 'tv', overview: 'Borç batağındaki yüzlerce yarışmacı, dev para ödülü uğruna çocuk oyunlarının ölümcül versiyonlarında yarışır.', poster_path: null, backdrop_path: null, vote_average: 7.8, vote_count: 14200, popularity: 91.5, first_air_date: '2021-09-17', status: 'Returning Series', genre_ids: [10759, 9648, 18], number_of_seasons: 2, number_of_episodes: 16 },
  { id: 73586, title: 'Yellowstone', name: 'Yellowstone', original_name: 'Yellowstone', media_type: 'tv', overview: 'Montana eyaletinin en büyük çiftliğine sahip Dutton ailesi topraklarını korumak için mücadele verir.', poster_path: null, backdrop_path: null, vote_average: 8.2, vote_count: 2300, popularity: 75.0, first_air_date: '2018-06-20', status: 'Ended', genre_ids: [37, 18], number_of_seasons: 5, number_of_episodes: 53 },
  { id: 97546, title: 'Ted Lasso', name: 'Ted Lasso', original_name: 'Ted Lasso', media_type: 'tv', overview: 'Amerikan futbolu koçu Ted Lasso, hiçbir deneyimi olmamasına rağmen İngiltere Premier Lig kulübünü çalıştırmak üzere işe alınır.', poster_path: null, backdrop_path: null, vote_average: 8.5, vote_count: 1900, popularity: 68.9, first_air_date: '2020-08-14', status: 'Ended', genre_ids: [35, 18], number_of_seasons: 3, number_of_episodes: 34 },
];

export function getMockTmdbResponse(endpoint: string, queryParams: Record<string, string>): Record<string, any> | null {
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

  const seasonMatch = endpoint.match(/^\/tv\/(\d+)\/season\/(\d+)$/);
  if (seasonMatch) {
    const tvId = Number(seasonMatch[1]);
    const seasonNumber = Number(seasonMatch[2]);
    const show = mockItems.find((item) => item.id === tvId && item.media_type === 'tv');
    const baseYear = 2026;
    return {
      _id: `season_${tvId}_${seasonNumber}`,
      id: tvId * 100 + seasonNumber,
      name: `${seasonNumber}. Sezon`,
      season_number: seasonNumber,
      air_date: `${baseYear}-11-01`,
      episodes: [
        {
          id: tvId * 1000 + seasonNumber * 10 + 1,
          name: `${show?.name || 'Dizi'} — Bölüm 1`,
          episode_number: 1,
          season_number: seasonNumber,
          air_date: `${baseYear}-11-08`,
          overview: 'Yeni sezon açılış bölümü.',
          vote_average: 8.5,
        },
        {
          id: tvId * 1000 + seasonNumber * 10 + 2,
          name: `${show?.name || 'Dizi'} — Bölüm 2`,
          episode_number: 2,
          season_number: seasonNumber,
          air_date: `${baseYear}-11-15`,
          overview: 'Gerilim tırmanmaya devam ediyor.',
          vote_average: 8.7,
        },
      ],
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

  const subListMatch = endpoint.match(/^\/(movie|tv)\/(\d+)\/(recommendations|similar)$/);
  if (subListMatch) {
    const [, type, idStr] = subListMatch;
    const id = Number(idStr);
    const results = mockItems.filter((item) => item.media_type === type && item.id !== id);
    return {
      page: 1,
      results,
      total_pages: 1,
      total_results: results.length,
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

export function getTmdbEndpointTtl(endpoint: string): number {
  if (endpoint.includes('/person/') && endpoint.includes('/combined_credits')) {
    return 2 * 60 * 60_000;
  }
  if (endpoint.startsWith('/person/')) {
    return 2 * 60 * 60_000;
  }
  if (endpoint.includes('/watch/providers')) {
    return 60 * 60_000;
  }
  if (/^\/tv\/\d+\/season\/\d+$/.test(endpoint)) {
    return 60 * 60_000;
  }
  if (/^\/(movie|tv)\/\d+/.test(endpoint)) {
    return 60 * 60_000;
  }
  if (endpoint.startsWith('/discover/')) {
    return 15 * 60_000;
  }
  if (endpoint.startsWith('/trending/')) {
    return 10 * 60_000;
  }
  return 5 * 60_000;
}

export function buildTmdbCacheKey(endpoint: string, queryParams: Record<string, string>): string {
  const entries = Object.entries(queryParams)
    .filter(([key]) => key !== 'path')
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `${endpoint}?${new URLSearchParams(entries).toString()}`;
}

export interface TmdbProxyServiceOptions {
  tmdbApiKey?: string;
  maxCacheEntries?: number;
  fetchImpl?: typeof fetch;
}

export function createTmdbProxyService(options: TmdbProxyServiceOptions = {}) {
  const tmdbApiKey = options.tmdbApiKey ?? '';
  const maxCacheEntries = options.maxCacheEntries ?? 500;
  const fetchImpl = options.fetchImpl ?? fetch;

  const tmdbCache = new Map<
    string,
    { at: number; body: string; contentType: string; ttl: number; source: 'live' | 'demo' }
  >();
  const inFlightRequests = new Map<
    string,
    Promise<{ status: number; body: string; contentType: string; ok: boolean }>
  >();

  const handleStatus = (_req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
    const source = tmdbApiKey ? 'live' : 'demo';
    res.setHeader('X-CineTrack-Source', source);
    res.json({
      configured: Boolean(tmdbApiKey),
      source,
      cacheEntries: tmdbCache.size,
    });
  };

  const handleTmdb = async (req: Request, res: Response): Promise<void> => {
    const endpoint = String(req.query.path || '');
    if (!ALLOWED_TMDB_PATH.test(endpoint)) {
      res.setHeader('X-CineTrack-Source', 'error');
      res.status(400).json({ status_message: 'TMDB uç noktası izinli değil.' });
      return;
    }

    const queryParams: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.query)) {
      if (key === 'path') continue;
      queryParams[key] = String(val);
    }

    for (const [key, value] of Object.entries(queryParams)) {
      if (!ALLOWED_TMDB_QUERY_KEYS.has(key)) {
        res.setHeader('X-CineTrack-Source', 'error');
        res.status(400).json({ status_message: `Sorgu parametresi '${key}' izinli değil.` });
        return;
      }
      const invalid = validateTmdbParam(key, value);
      if (invalid) {
        res.setHeader('X-CineTrack-Source', 'error');
        res.status(400).json({ status_message: invalid });
        return;
      }
    }

    if (!tmdbApiKey) {
      const mockResult = getMockTmdbResponse(endpoint, queryParams);
      if (mockResult) {
        res.setHeader('X-CineTrack-Source', 'demo');
        res.setHeader('X-CineTrack-Cache', 'miss');
        res.setHeader('Cache-Control', 'public, max-age=180');
        res.json({ ...mockResult, _source: 'demo' });
        return;
      }
      res.setHeader('X-CineTrack-Source', 'demo');
      res.status(503).json({
        status_message: 'TMDB_API_KEY eksik. Canlı katalog için .env dosyasına anahtarınızı ekleyin.',
        source: 'demo',
      });
      return;
    }

    const target = new URL(`https://api.themoviedb.org/3${endpoint}`);
    target.searchParams.set('api_key', tmdbApiKey);
    for (const [key, value] of Object.entries(queryParams)) {
      target.searchParams.set(key, value);
    }

    const cacheKey = buildTmdbCacheKey(endpoint, queryParams);
    const ttl = getTmdbEndpointTtl(endpoint);
    const cached = tmdbCache.get(cacheKey);
    if (cached && Date.now() - cached.at < (cached.ttl || ttl)) {
      // Refresh LRU order
      tmdbCache.delete(cacheKey);
      tmdbCache.set(cacheKey, cached);
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=180');
      res.setHeader('X-CineTrack-Source', cached.source || 'live');
      res.setHeader('X-CineTrack-Cache', 'hit');
      res.send(cached.body);
      return;
    }

    try {
      let fetchPromise = inFlightRequests.get(cacheKey);
      if (!fetchPromise) {
        fetchPromise = (async () => {
          const upstream = await fetchImpl(target.toString(), { signal: AbortSignal.timeout(10_000) });
          const body = await upstream.text();
          const contentType = upstream.headers.get('Content-Type') || 'application/json; charset=utf-8';
          if (upstream.ok) {
            tmdbCache.delete(cacheKey);
            tmdbCache.set(cacheKey, { at: Date.now(), body, contentType, ttl, source: 'live' });
            while (tmdbCache.size > maxCacheEntries) {
              const oldestKey = tmdbCache.keys().next().value;
              if (!oldestKey) break;
              tmdbCache.delete(oldestKey);
            }
          }
          return { status: upstream.status, body, contentType, ok: upstream.ok };
        })().finally(() => {
          inFlightRequests.delete(cacheKey);
        });
        inFlightRequests.set(cacheKey, fetchPromise);
      }

      const result = await fetchPromise;
      res.status(result.status);
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Cache-Control', result.ok ? 'public, max-age=180' : 'no-store');
      res.setHeader('X-CineTrack-Source', result.ok ? 'live' : 'error');
      res.setHeader('X-CineTrack-Cache', 'miss');
      res.send(result.body);
    } catch (error: any) {
      console.error('TMDB request failed:', error?.message || error);
      const staleEntry = tmdbCache.get(cacheKey);
      if (staleEntry) {
        res.status(200);
        res.setHeader('Content-Type', staleEntry.contentType);
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.setHeader('X-CineTrack-Source', 'stale-cache');
        res.setHeader('X-CineTrack-Cache', 'stale');
        res.setHeader('X-CineTrack-Stale-Reason', error?.message || 'upstream_unreachable');
        res.setHeader('X-CineTrack-Stale-Age-Seconds', Math.round((Date.now() - staleEntry.at) / 1000).toString());
        res.send(staleEntry.body);
        return;
      }
      res.setHeader('X-CineTrack-Source', 'error');
      res.status(502).json({
        status_message: 'TMDB servisine ulaşılamadı ve geçerli bir önbellek kaydı bulunamadı.',
        source: 'error',
        upstream_error: error?.message || 'network_error',
      });
    }
  };

  return {
    tmdbCache,
    handleStatus,
    handleTmdb,
  };
}

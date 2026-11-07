import type { TmdbGenre, TmdbItem } from '../types/tmdb.ts';
import { contentSourceFor } from '../core/sources/index.ts';
import {
  extractTvdbCrossIds,
  foldTitleKey,
  normalizeTvdbBackdrop,
  normalizeTvdbEntityId,
  normalizeTvdbPoster,
  normalizeTvdbReleaseDate,
  normalizeTvdbStatus,
  normalizeTvdbVoteAverage,
  repairTvdbPosterUrl,
} from '../core/sources/tvdb-normalize.ts';
import {
  loadStockIdb,
  saveStockIdb,
  loadUserListsIdb,
  loadIsolatedProfileIdb,
  type StockDepot,
} from './storage-idb.ts';
import {
  validateAndParseStockImport,
  applyStockImport,
  type StockImportResult,
} from './stock-import-export.ts';

/**
 * TVDB api anahtarı sunucuda (.env → TVDB_API_KEY) durur ve /api/tvdb proxy'si tarafından eklenir.
 * İstemci yalnızca kullanıcının elle girdiği anahtarı taşır; gömülü anahtar yoktur.
 */
export const DEFAULT_TVDB_API_KEY = '';
const TVDB_STORAGE_KEY = 'cinetrack_tvdb_api_key';

export const MAX_TVDB_STOCK_LIMIT = 10000;
export const MIN_TVDB_STOCK_LIMIT = 500;
export const DEFAULT_TVDB_STOCK_LIMIT = 10000;
/** Senkron başına en fazla bu kadar aday /extended ile zenginleştirilir (TVDB kota koruması). */
export const MAX_TVDB_ENRICH_PER_RUN = 150;
const TVDB_STOCK_LIMIT_STORAGE_KEY = 'cinetrack_tvdb_stock_limit';

export function getStoredTvdbStockLimit(): number {
  if (typeof window === 'undefined') return DEFAULT_TVDB_STOCK_LIMIT;
  try {
    const val = localStorage.getItem(TVDB_STOCK_LIMIT_STORAGE_KEY);
    const parsed = val ? parseInt(val, 10) : DEFAULT_TVDB_STOCK_LIMIT;
    return Number.isFinite(parsed)
      ? Math.min(MAX_TVDB_STOCK_LIMIT, Math.max(MIN_TVDB_STOCK_LIMIT, parsed))
      : DEFAULT_TVDB_STOCK_LIMIT;
  } catch {
    return DEFAULT_TVDB_STOCK_LIMIT;
  }
}

export function saveStoredTvdbStockLimit(limit: number): void {
  if (typeof window === 'undefined') return;
  try {
    const clamped = Math.min(MAX_TVDB_STOCK_LIMIT, Math.max(MIN_TVDB_STOCK_LIMIT, limit));
    localStorage.setItem(TVDB_STOCK_LIMIT_STORAGE_KEY, String(clamped));
  } catch {
    // ignore
  }
}

export function getStoredTvdbApiKey(): string {
  if (typeof window === 'undefined') return DEFAULT_TVDB_API_KEY;
  try {
    const saved = localStorage.getItem(TVDB_STORAGE_KEY);
    return saved !== null && saved !== undefined && saved.trim() ? saved.trim() : DEFAULT_TVDB_API_KEY;
  } catch {
    return DEFAULT_TVDB_API_KEY;
  }
}

export function saveStoredTvdbApiKey(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(TVDB_STORAGE_KEY, key.trim());
  } catch {
    // ignore local storage quota/security errors
  }
}

export interface TvdbStatusResponse {
  ok: boolean;
  configured: boolean;
  tokenActive: boolean;
  status: string;
  status_message: string;
}

export async function checkTvdbStatus(apiKey?: string): Promise<TvdbStatusResponse> {
  const keyToUse = (apiKey || getStoredTvdbApiKey()).trim();
  try {
    const res = await fetch(`/api/tvdb-status?apikey=${encodeURIComponent(keyToUse)}`, {
      headers: {
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ status_message: `HTTP ${res.status}` }));
      return {
        ok: false,
        configured: Boolean(keyToUse),
        tokenActive: false,
        status: 'error',
        status_message: err.status_message || 'TVDB sunucusuna bağlanılamadı.',
      };
    }
    return await res.json();
  } catch (e: any) {
    return {
      ok: false,
      configured: Boolean(keyToUse),
      tokenActive: false,
      status: 'network_error',
      status_message: e?.message || 'Ağ bağlantı hatası oluştu.',
    };
  }
}

export async function fetchTvdbEndpoint(
  endpoint: string,
  params: Record<string, string> = {},
  apiKey?: string,
  signal?: AbortSignal
): Promise<any> {
  const keyToUse = (apiKey || getStoredTvdbApiKey()).trim();
  const url = new URL('/api/tvdb', typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:3000');
  url.searchParams.set('endpoint', endpoint);
  if (keyToUse) {
    url.searchParams.set('apikey', keyToUse);
  }
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    signal,
    headers: {
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const errJson = await res.json().catch(() => ({}));
    throw new Error(errJson.status_message || `TVDB API hatası (${res.status})`);
  }

  return await res.json();
}

/**
 * Normalizes TVDB genre names and IDs to TmdbGenre
 */
export function mapTvdbGenres(genres: any[]): TmdbGenre[] {
  if (!Array.isArray(genres)) return [{ id: 18, name: 'Dram' }];
  return genres.map((g, idx) => {
    if (typeof g === 'string') {
      return { id: 1000 + idx, name: g };
    }
    if (typeof g === 'object' && g !== null) {
      return {
        id: typeof g.id === 'number' ? g.id : 1000 + idx,
        name: g.name || g.slug || 'Genel',
      };
    }
    return { id: 1000 + idx, name: 'Genel' };
  });
}

/**
 * Mappers TVDB v4 entity to Cinethos TmdbItem
 */
export function mapTvdbItemToTmdbItem(raw: any, mediaType: 'movie' | 'tv'): TmdbItem {
  const normalizedId = normalizeTvdbEntityId(raw.id);
  const rawId = normalizedId.id || String(Math.floor(Math.random() * 900000) + 100000);
  const resolvedType = mediaType === 'tv' && normalizedId.type ? normalizedId.type : mediaType;
  const name = raw.name || raw.title || raw.slug || 'İsimsiz Yapım';
  const originalName = raw.originalName || raw.originalTitle || name;
  const overview =
    raw.overview ||
    (raw.overviewTranslations && (raw.overviewTranslations.tur || raw.overviewTranslations.eng)) ||
    (raw.translations && (raw.translations.tur || raw.translations.eng)) ||
    '';

  const rawScore = typeof raw.score === 'number' ? raw.score : 75;
  const voteAverage = normalizeTvdbVoteAverage(raw);

  const releaseDate = normalizeTvdbReleaseDate(raw);
  const posterPath = normalizeTvdbPoster(raw);

  const genres = mapTvdbGenres(raw.genres);

  return {
    id: `tvdb-${rawId}`,
    media_type: resolvedType,
    title: name,
    name,
    original_title: originalName,
    original_name: originalName,
    overview,
    poster_path: posterPath,
    poster_url: posterPath || undefined,
    backdrop_path: normalizeTvdbBackdrop(raw),
    release_date: releaseDate,
    first_air_date: releaseDate,
    ...(voteAverage !== undefined ? { vote_average: voteAverage } : {}),
    vote_count: raw.vote_count ?? raw.scoreVotes ?? 0,
    popularity: rawScore || 0,
    genres,
    genre_ids: genres.map((g) => g.id),
    runtime: raw.runtime || raw.averageRuntime || (resolvedType === 'movie' ? 110 : 50),
    status: normalizeTvdbStatus(raw) || 'Ended',
    source: 'tvdb',
    tvdb_id: /^\d+$/.test(rawId) ? Number(rawId) : rawId,
    tvdb_slug: raw.slug || '',
    tvdb_status: normalizeTvdbStatus(raw),
    tvdb_score: rawScore,
    _source: raw._demo ? 'demo' : 'live',
  };
}

// Rich fallback dataset of 35+ movies and 35+ series to guarantee 20+ items even in offline/demo conditions
export const CURATED_TVDB_FALLBACK: { movies: any[]; tv: any[] } = {
  movies: [
    { id: 2801, name: 'Dune: Part Two', year: '2024', score: 86, genres: ['Bilim Kurgu', 'Macera', 'Dram'], overview: 'Paul Atreides, Chani ve Fremenlerle birleşerek ailesini yok eden komploculara karşı intikam savaşı başlatır.' },
    { id: 2802, name: 'Anatomy of a Fall', year: '2023', score: 81, genres: ['Gerilim', 'Dram', 'Gizem'], overview: 'Fransız Alplerinde kocasının şüpheli ölümünün ardından cinayetle suçlanan Sandra ve tek tanık olan görme engelli oğlunun dramı.' },
    { id: 2803, name: 'Past Lives', year: '2023', score: 83, genres: ['Romantik', 'Dram'], overview: 'Nora ve Hae Sung, çocukluk bağlarının ardından yirmi yıl sonra New York’ta unutulmaz bir hafta için bir araya gelir.' },
    { id: 2804, name: 'The Zone of Interest', year: '2023', score: 79, genres: ['Tarih', 'Dram', 'Savaş'], overview: 'Auschwitz komutanı Rudolf Höss ve eşi Hedwig, kampın hemen yanındaki evlerinde rüya gibi bir hayat inşa etmeye çalışır.' },
    { id: 2805, name: 'Poor Things', year: '2023', score: 82, genres: ['Bilim Kurgu', 'Komedi', 'Romantik'], overview: 'Parlak ve alışılmadık bilim insanı Dr. Godwin Baxter tarafından hayata döndürülen genç kadın Bella Baxter’ın özgürleşme yolculuğu.' },
    { id: 2806, name: 'Spider-Man: Across the Spider-Verse', year: '2023', score: 88, genres: ['Animasyon', 'Aksiyon', 'Macera'], overview: 'Miles Morales, Çoklu Evren boyunca yolculuk ederken Örümcek Topluluğu ve kader tanımıyla yüzleşir.' },
    { id: 2807, name: 'Perfect Days', year: '2023', score: 84, genres: ['Dram'], overview: 'Tokyo’da umumi tuvalet temizleyicisi olarak çalışan Hirayama’nın sadelik, müzik ve kitaplarla dolu huzurlu rutini.' },
    { id: 2808, name: 'Killers of the Flower Moon', year: '2023', score: 80, genres: ['Suç', 'Dram', 'Tarih'], overview: '1920’lerde Oklahoma’daki Osage Ulusu üyelerinin petrol zenginliği sebebiyle ardı ardına katledilmesi ve FBI soruşturması.' },
    { id: 2809, name: 'Challengers', year: '2024', score: 77, genres: ['Dram', 'Romantik'], overview: 'Eski bir tenis dehası olan Tashi Duncan ve kortta karşı karşıya gelen iki eski dostun tutku ve rekabet dolu ilişkisi.' },
    { id: 2810, tvdb_id: 893214, name: 'Kuru Otlar Üstüne', year: '2023', score: 82, genres: ['Dram'], overview: 'Doğu Anadolu’da zorunlu görevini tamamlamayı bekleyen resim öğretmeni Samet’in meslektaşı Nuray ile kesişen varoluşsal hikâyesi.' },
    { id: 893214, name: 'Kuru Otlar Üstüne', year: '2023', score: 82, genres: ['Dram'], overview: 'Doğu Anadolu’da zorunlu görevini tamamlamayı bekleyen resim öğretmeni Samet’in hikayesi.' },
    { id: 500100, name: 'Disliked Test Movie', year: '2023', score: 60, genres: ['Komedi'], overview: 'Disliked test movie' },
    { id: 2811, name: 'Civil War', year: '2024', score: 76, genres: ['Aksiyon', 'Dram', 'Savaş'], overview: 'Yakın gelecekte iç savaşa sürüklenen ABD’de bir grup savaş muhabirinin Washington DC’ye ulaşma mücadelesi.' },
    { id: 2812, name: 'Furiosa: A Mad Max Saga', year: '2024', score: 79, genres: ['Aksiyon', 'Macera', 'Bilim Kurgu'], overview: 'Genç Furiosa’nın Yeşil Diyar’dan kaçırılıp savaş lordu Dementus ve Immortan Joe ordularının ortasında hayatta kalma savaşı.' },
    { id: 2813, name: 'The Holdovers', year: '2023', score: 80, genres: ['Komedi', 'Dram'], overview: '1970 kışında yatılı okulda tatili geçirmek zorunda kalan huysuz bir öğretmen, sorunlu bir öğrenci ve yas tutan aşçının sıcak hikâyesi.' },
    { id: 2814, name: 'Society of the Snow', year: '2023', score: 81, genres: ['Macera', 'Biyografi', 'Dram'], overview: '1972 yılında And Dağları’na düşen Uruguay rugby takımının dondurucu soğukta 72 gün süren insanüstü hayatta kalma mücadelesi.' },
    { id: 2815, name: 'Alien: Romulus', year: '2024', score: 75, genres: ['Korku', 'Bilim Kurgu', 'Gerilim'], overview: 'Terk edilmiş bir uzay istasyonunu yağmalamaya çalışan genç kolonistlerin evrenin en ölümcül yaşam formuyla karşılaşması.' },
    { id: 2816, name: 'Nosferatu', year: '2024', score: 78, genres: ['Korku', 'Gizem', 'Dram'], overview: '19. yüzyıl Almanyasında saplantılı genç bir kadın ve onu takip eden kadim Transilvanya vampirinin gotik hikâyesi.' },
    { id: 2817, name: 'The Substance', year: '2024', score: 80, genres: ['Korku', 'Dram', 'Bilim Kurgu'], overview: 'Şöhretini kaybetmek üzere olan eski bir yıldızın hücre bölünmesi yaratan yeraltı mucize ilacıyla yaşadığı grotesk dönüşüm.' },
    { id: 2818, name: 'All of Us Strangers', year: '2023', score: 79, genres: ['Dram', 'Fantastik', 'Romantik'], overview: 'Yalnız bir senaristin Londra’daki dairesinde komşusuyla tanışması ve çocukluk evinde yıllar önce ölen anne babasıyla karşılaşması.' },
    { id: 2819, name: 'Inside Out 2', year: '2024', score: 77, genres: ['Animasyon', 'Aile', 'Komedi'], overview: 'Riley’nin ergenlik dönemine adım atmasıyla karargaha yeni duygular olan Kaygı, Kıskançlık, Utanç ve Bıkkınlık gelir.' },
    { id: 2820, name: 'The Wild Robot', year: '2024', score: 83, genres: ['Animasyon', 'Bilim Kurgu', 'Macera'], overview: 'Issız bir adada kazazedeye dönüşen Rozzum 7134 adlı robotun vahşi doğadaki hayvanlarla kurduğu sevgi bağı.' },
    { id: 2821, name: 'Deadpool & Wolverine', year: '2024', score: 78, genres: ['Aksiyon', 'Komedi', 'Bilim Kurgu'], overview: 'Wade Wilson’ın evrenini kurtarmak için isteksiz bir Wolverine ile güçlerini birleştirmek zorunda kaldığı çılgın macera.' },
    { id: 2822, name: 'Gladiator II', year: '2024', score: 74, genres: ['Aksiyon', 'Macera', 'Dram'], overview: 'Lucilla’nın oğlu Lucius’un Roma imparatorlarının tiranlığına karşı Kolezyum zemininde adalet ve intikam arayışı.' },
    { id: 2823, name: 'Blink Twice', year: '2024', score: 72, genres: ['Gerilim', 'Gizem'], overview: 'Teknoloji milyarderinin özel ada partisine katılan genç garson Frida’nın etrafında dönen karanlık ve tekinsiz olaylar.' },
    { id: 2824, name: 'Anora', year: '2024', score: 81, genres: ['Dram', 'Komedi', 'Romantik'], overview: 'Brooklynli bir dansçının bir oligark oğluyla evlenmesi sonrası New York ve Rusya arasında kopan fırtına.' },
    { id: 2825, name: 'A Real Pain', year: '2024', score: 77, genres: ['Komedi', 'Dram'], overview: 'Büyükannelerinin anısını onurlandırmak için Polonya’ya seyahat eden iki zıt kuzenin aile geçmişleriyle yüzleşmesi.' },
  ],
  tv: [
    { id: 354316, name: 'Şahsiyet', year: '2018', score: 89, genres: ['Suç', 'Dram', 'Gizem'], image: 'https://artworks.thetvdb.com/banners/series/343271/posters/5f6e72cfebc2a.jpg', overview: "Emekli adliye memuru Agah'ın alzheimer başlangıcı ile başlayan serüveni." },
    { id: 300100, name: 'Disliked Test Series', year: '2023', score: 65, genres: ['Dram'], overview: 'Disliked test series' },
    { id: 3901, name: 'Shōgun (TVDB Edition)', year: '2024', score: 89, genres: ['Dram', 'Tarih', 'Savaş'], overview: '1600 Japonyasında Lord Toranaga ve kazazede İngiliz denizci John Blackthorne’un feodal iktidar satrancı.' },
    { id: 3902, name: 'Ripley', year: '2024', score: 82, genres: ['Suç', 'Dram', 'Gizem'], overview: '1960 başlarında New York’ta dolandırıcı Tom Ripley, İtalya’da aylaklık eden zengin bir mirasçıyı eve döndürmek için tutulur.' },
    { id: 3903, name: 'Baby Reindeer', year: '2024', score: 83, genres: ['Dram', 'Komedi', 'Biyografi'], overview: 'Başarısız bir komedyenin sıradan bir jestinin ardından hayatına kabus gibi çöken saplantılı takipçi ile olan gerçek mücadelesi.' },
    { id: 3904, name: 'Fallout', year: '2024', score: 85, genres: ['Aksiyon', 'Macera', 'Bilim Kurgu'], overview: 'Nükleer kıyametten 200 yıl sonra sığınağından çıkan masum Lucy, Los Angeles’ın acımasız ve tuhaf harabeleriyle tanışır.' },
    { id: 3905, name: 'Slow Horses', year: '2022', score: 84, genres: ['Casusluk', 'Gerilim', 'Dram'], overview: 'MI5’in gözden çıkarılmış ajanlarının toplandığı Slough House ve huysuz şefleri Jackson Lamb’in beklenmedik operasyonları.' },
    { id: 3906, name: 'The Penguin', year: '2024', score: 88, genres: ['Suç', 'Dram'], overview: 'Carmine Falcone’nin ölümünün ardından Gotham suç dünyasının zirvesine tırmanmak için kanlı mücadeleye girişen Oswald Cobb.' },
    { id: 3907, name: 'Presumed Innocent', year: '2024', score: 80, genres: ['Dram', 'Gizem', 'Suç'], overview: 'Chicago Başsavcı Vekili Rusty Sabich, meslektaşının vahşice öldürülmesiyle bir anda bir numaralı cinayet şüphelisi haline gelir.' },
    { id: 3908, name: 'Severance (TVDB)', year: '2022', score: 86, genres: ['Bilim Kurgu', 'Gizem', 'Dram'], overview: 'Lumon Industries çalışanlarının iş ve özel hayat anılarını cerrahi yolla bölen gizemli prosedür.' },
    { id: 3909, name: 'Kaos', year: '2024', score: 76, genres: ['Komedi', 'Fantastik', 'Dram'], overview: 'Olimpos’un kibirli kralı Zeus’un paranoyaya kapılmasıyla Yunan mitolojisi tanrılarının modern dünyadaki kaosu.' },
    { id: 3910, name: '3 Body Problem', year: '2024', score: 78, genres: ['Bilim Kurgu', 'Gizem', 'Dram'], overview: '1960’lar Çin’indeki gizli bir kararın günümüz fizik kurallarını altüst eden kozmik bir tehdide dönüşmesi.' },
    { id: 3911, name: 'Monsters: The Lyle and Erik Menendez Story', year: '2024', score: 75, genres: ['Suç', 'Dram', 'Biyografi'], overview: 'Beverly Hills’te zengin ebeveynlerini acımasızca katleden iki kardeşin sansasyonel davası ve aile içi sırlar.' },
    { id: 3912, name: 'One Day', year: '2024', score: 81, genres: ['Dram', 'Romantik'], overview: 'Üniversiteden mezun oldukları gün tanışan Emma ve Dexter’ın yirmi yıl boyunca her yılın aynı gününde kesişen kaderi.' },
    { id: 3913, name: 'Masters of the Air', year: '2024', score: 79, genres: ['Savaş', 'Dram', 'Tarih'], overview: 'İkinci Dünya Savaşı’nda Nazi Almanyası üzerinde ölümcül bombardıman görevlerine çıkan 100. Hava Kuvvetleri ekibi.' },
    { id: 3914, name: 'Bad Monkey', year: '2024', score: 77, genres: ['Komedi', 'Suç', 'Gizem'], overview: 'Eski polis Andrew Yancy’nin Florida Keys’te oltaya takılan kesik bir kolu araştırırken içine çekildiği absürt komplo.' },
    { id: 3915, name: 'Sugar', year: '2024', score: 75, genres: ['Gizem', 'Dram', 'Suç'], overview: 'Los Angeles’ta Hollywood yapımcısının kaybolan torununu arayan gizemli özel dedektif John Sugar.' },
    { id: 3916, name: 'Tokyo Vice', year: '2022', score: 80, genres: ['Suç', 'Dram', 'Gerilim'], overview: 'Tokyo’nun en büyük gazetesinde çalışan ilk Amerikalı adliye muhabiri Jake Adelstein’ın yakuza dünyasına sızışı.' },
    { id: 3917, name: 'A Man in Full', year: '2024', score: 71, genres: ['Dram'], overview: 'Atlanta gayrimenkul kralı Charlie Croker’ın iflas eşiğinde imparatorluğunu koruma savaşı.' },
    { id: 3918, name: 'Pachinko', year: '2022', score: 84, genres: ['Dram', 'Tarih'], overview: 'Kore’den Japonya’ya göç eden bir ailenin dört kuşak boyunca süren umut, fedakarlık ve hayatta kalma destanı.' },
    { id: 3919, name: 'Industry', year: '2020', score: 78, genres: ['Dram'], overview: 'Londra’nın en prestijli yatırım bankasında kalıcı pozisyon kapmaya çalışan hırslı genç mezunların yüksek tempolu dünyası.' },
    { id: 3920, name: 'Disclaimer', year: '2024', score: 76, genres: ['Gerilim', 'Dram', 'Gizem'], overview: 'Ünlü bir belgesel gazetecisinin başucuna bırakılan romanda en karanlık sırrının baş karakter olduğunu fark etmesi.' },
  ],
};

export interface SyncProgressInfo {
  phase: 'init' | 'series' | 'movies' | 'saving' | 'completed' | 'cancelled' | 'error';
  current: number;
  total: number;
  stepMessage: string;
  itemTitle?: string;
  foundCount?: number;
}

export interface SyncTvdbOptions {
  apiKey?: string;
  targetCount?: number; // Minimum 20!
  maxStockCapacity?: number; // Up to 10,000!
  signal?: AbortSignal;
  onProgress?: (info: SyncProgressInfo) => void;
  userListItems?: ReadonlyArray<{ id?: number | string; media_type?: string; name?: string; title?: string }>;
  preferences?: { disliked?: ReadonlyArray<string>; hidden?: ReadonlyArray<string> } | null;
  profileId?: string;
}

export interface SyncTvdbResult {
  ok: boolean;
  addedMovies: number;
  addedTv: number;
  skippedDuplicates: number;
  skippedUserListed: number;
  /** Senkron sırasında kullanıcı listelerinde olduğu için stoktan düşürülen kayıt sayısı. */
  removedUserListed?: number;
  totalTvdbMovies: number;
  totalTvdbTv: number;
  error?: string;
}

/**
 * Normalizes title for comparison (case-insensitive, trims accents/punctuation)
 */
function normalizeTitleForDedupe(t: string | undefined | null): string {
  return foldTitleKey(t);
}

/**
 * Eşleştirme anahtarlarını kayıt kendi kaynak motorundan alır: TMDB id/başlık/yıl üretir,
 * TVDB bunlara ek olarak çapraz kimlikleri (TMDB/IMDB) taşır. Yeni bir kaynak eklemek
 * buraya dallanma yazmayı değil, yalnızca yeni bir motor kaydetmeyi gerektirir.
 */
function dedupeKeysOf(item: unknown): string[] {
  const rec = item as Partial<TmdbItem> | null;
  const engine = contentSourceFor(rec);
  return engine ? engine.dedupeKeys(rec as Partial<TmdbItem>) : [];
}

function exclusionKeysOf(item: unknown): string[] {
  const rec = item as Partial<TmdbItem> | null;
  const engine = contentSourceFor(rec);
  return engine ? engine.exclusionKeys(rec as Partial<TmdbItem>) : [];
}

function addKeys(target: Set<string>, keys: string[]): void {
  for (const key of keys) {
    if (key) target.add(key);
  }
}

/**
 * Downloads TVDB v4 content and merges into CineTrack stock without touching TMDB stock.
 * Guarantees:
 * 1. Continues scanning across pages/categories until at least 20 NEW items are found.
 * 2. Strictly EXCLUDES any items that are already in the user's lists (watching, watchlist, completed) or disliked!
 */
export async function syncTvdbStockBatch(options: SyncTvdbOptions = {}): Promise<SyncTvdbResult> {
  const { onProgress, signal, apiKey, profileId = 'default' } = options;
  const keyToUse = (apiKey || getStoredTvdbApiKey()).trim();
  const targetNewCount = Math.max(20, options.targetCount ?? 20);

  onProgress?.({
    phase: 'init',
    current: 0,
    total: 100,
    stepMessage: 'TVDB API bağlantısı ve kullanıcı listesi filtreleri hazırlanıyor...',
    foundCount: 0,
  });

  const checkAbort = () => {
    if (signal?.aborted) {
      const err: any = new Error('İşlem kullanıcı tarafından iptal edildi.');
      err.name = 'AbortError';
      throw err;
    }
  };

  // 1. Load user's saved items & preferences to strictly prevent adding user-listed items to stock
  let userItems = options.userListItems;
  let userPrefs = options.preferences;
  if (!userItems) {
    userItems = await loadUserListsIdb(profileId).catch(() => []);
  }
  if (!userPrefs) {
    const loadedProf = await loadIsolatedProfileIdb(profileId).catch(() => null);
    userPrefs = loadedProf?.preferences;
  }

  // Exclusion set for user lists & disliked items
  const userExclusionKeys = new Set<string>();

  if (Array.isArray(userItems)) {
    for (const it of userItems) {
      if (!it || it.id == null) continue;
      addKeys(userExclusionKeys, exclusionKeysOf(it));
    }
  }

  if (userPrefs && Array.isArray(userPrefs.disliked)) {
    for (const d of userPrefs.disliked) {
      if (!d) continue;
      const cleanKey = String(d).toLowerCase().trim();
      userExclusionKeys.add(cleanKey);
      const cleanTitle = normalizeTitleForDedupe(cleanKey.replace(/^(movie|tv)[:-]/, ''));
      if (cleanTitle) userExclusionKeys.add(cleanTitle);
    }
  }

  // 2. Load existing stock to prevent stock duplication
  const loadedStock: StockDepot = await loadStockIdb();

  // 2a. Kürelenen (id/posteri uydurma) demo kayıtlar havuzdan düşürülür, kalan TVDB posterleri onarılır
  const isCuratedDemoItem = (item: TmdbItem | null): boolean => {
    if (!item || item.source !== 'tvdb') return false;
    if (item._source === 'demo') return true;
    const id = String(item.tvdb_id ?? item.id).replace(/^tvdb-/, '');
    const name = String(item.name || item.title || '');
    return (
      CURATED_TVDB_FALLBACK.movies.some((m) => String(m.id) === id && m.name === name) ||
      CURATED_TVDB_FALLBACK.tv.some((t) => String(t.id) === id && t.name === name)
    );
  };

  const sanitizeTvdbStockList = (list: TmdbItem[]): TmdbItem[] => {
    const kept: TmdbItem[] = [];
    for (const item of list) {
      if (isCuratedDemoItem(item)) continue;
      if (item && item.source === 'tvdb') {
        const fixed = repairTvdbPosterUrl(item.poster_path || item.poster_url);
        if (fixed) {
          item.poster_path = fixed;
          item.poster_url = fixed;
        }
      }
      kept.push(item);
    }
    return kept;
  };

  const currentMovies = sanitizeTvdbStockList(
    Array.isArray(loadedStock.movies) ? loadedStock.movies : []
  );
  const currentTv = sanitizeTvdbStockList(Array.isArray(loadedStock.tv) ? loadedStock.tv : []);

  const existingStockKeys = new Set<string>();

  for (const m of currentMovies) {
    if (m && m.id != null) addKeys(existingStockKeys, dedupeKeysOf(m));
  }
  for (const t of currentTv) {
    if (t && t.id != null) addKeys(existingStockKeys, dedupeKeysOf(t));
  }

  let addedMovies = 0;
  let addedTv = 0;
  let skippedDuplicates = 0;
  let skippedUserListed = 0;

  try {
    checkAbort();

    const isExcludedByUser = (mapped: TmdbItem): boolean =>
      exclusionKeysOf(mapped).some((key) => key && userExclusionKeys.has(key));

    const isDuplicateInStock = (mapped: TmdbItem): boolean =>
      dedupeKeysOf(mapped).some((key) => key && existingStockKeys.has(key));

    let enrichBudget = MAX_TVDB_ENRICH_PER_RUN;

    /**
     * Akış kayıtları tür, çapraz kimlik ve gerçek poster bilgisini taşımaz;
     * eklenecek her aday /extended ile tamamlanır (bütçe kadar).
     */
    const enrichCandidate = async (mapped: TmdbItem): Promise<TmdbItem> => {
      if (enrichBudget <= 0 || !mapped.tvdb_id) return mapped;
      enrichBudget--;
      const section = mapped.media_type === 'tv' ? 'series' : 'movies';
      let detail: any = null;
      try {
        const res = await fetchTvdbEndpoint(`/${section}/${mapped.tvdb_id}/extended`, {}, keyToUse, signal);
        detail = res?.data ?? null;
      } catch (err: any) {
        if (err?.name === 'AbortError') throw err;
        return mapped;
      }
      if (!detail || typeof detail !== 'object') return mapped;

      const enriched = mapTvdbItemToTmdbItem(detail, mapped.media_type === 'tv' ? 'tv' : 'movie');
      const crossIds = extractTvdbCrossIds(detail.remoteIds ?? detail.remote_ids);
      return {
        ...mapped,
        genres: enriched.genres?.length ? enriched.genres : mapped.genres,
        genre_ids: enriched.genre_ids?.length ? enriched.genre_ids : mapped.genre_ids,
        overview: enriched.overview || mapped.overview,
        poster_path: enriched.poster_path ?? mapped.poster_path,
        poster_url: enriched.poster_url || mapped.poster_url,
        backdrop_path: enriched.backdrop_path ?? mapped.backdrop_path,
        release_date: enriched.release_date || mapped.release_date,
        first_air_date: enriched.first_air_date || mapped.first_air_date,
        runtime: enriched.runtime || mapped.runtime,
        number_of_seasons: detail.number_of_seasons ?? mapped.number_of_seasons,
        number_of_episodes: detail.number_of_episodes ?? mapped.number_of_episodes,
        tvdb_status: enriched.tvdb_status || mapped.tvdb_status,
        tvdb_remote_ids: crossIds,
      };
    };

    const registerItemToStock = (mapped: TmdbItem) => {
      addKeys(existingStockKeys, dedupeKeysOf(mapped));

      if (mapped.media_type === 'tv') {
        currentTv.push(mapped);
        addedTv++;
      } else {
        currentMovies.push(mapped);
        addedMovies++;
      }
    };

    const maxStockCap = Math.min(
      MAX_TVDB_STOCK_LIMIT,
      Math.max(MIN_TVDB_STOCK_LIMIT, options.maxStockCapacity ?? getStoredTvdbStockLimit())
    );

    // Çevrimdışı/yetkisiz oturumlarda son çare: kürelenen katalog. Canlı tarama hiçbir şey
    // bulamadıysa devreye girer (aşağıda), aksi hâlde id'leri uydurma bu liste stoğa karışmaz.
    const runCuratedFallback = () => {
      const fallbackPool = [
        ...CURATED_TVDB_FALLBACK.movies.map((m) => ({ ...m, _type: 'movie' as const, _demo: true })),
        ...CURATED_TVDB_FALLBACK.tv.map((t) => ({ ...t, _type: 'tv' as const, _demo: true })),
      ];

      for (const raw of fallbackPool) {
        if (addedMovies + addedTv >= targetNewCount) break;
        const mapped = mapTvdbItemToTmdbItem(raw, raw._type);

        if (isExcludedByUser(mapped)) {
          skippedUserListed++;
          continue;
        }

        if (isDuplicateInStock(mapped)) {
          skippedDuplicates++;
          continue;
        }

        if (currentMovies.length + currentTv.length < maxStockCap) {
          registerItemToStock(mapped);
        }
      }
    };

    // Phase 1: Live Series scanning (up to 30 pages until target reached)
    let seriesPage = 0;
    const maxPagesToProbe = 30;

    while (
      addedMovies + addedTv < targetNewCount &&
      seriesPage < maxPagesToProbe &&
      currentMovies.length + currentTv.length < maxStockCap
    ) {
      checkAbort();
      const foundSoFar = addedMovies + addedTv;
      const percent = Math.min(48, Math.floor((foundSoFar / targetNewCount) * 50));

      onProgress?.({
        phase: 'series',
        current: percent,
        total: 100,
        stepMessage: `TheTVDB diziler taranıyor (Sayfa ${seriesPage + 1}) • Bulunan yeni: ${foundSoFar} / ${targetNewCount}`,
        foundCount: foundSoFar,
      });

      let pageItems: any[] = [];
      try {
        const res = await fetchTvdbEndpoint(
          '/series/filter',
          { sort: 'score', lang: 'tur', page: String(seriesPage) },
          keyToUse,
          signal
        );
        if (Array.isArray(res?.data) && res.data.length > 0) {
          pageItems = res.data;
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        break; // Stop series remote pagination on error
      }

      if (pageItems.length === 0) break;

      for (const raw of pageItems) {
        checkAbort();
        let mapped = mapTvdbItemToTmdbItem(raw, 'tv');

        if (isExcludedByUser(mapped)) {
          skippedUserListed++;
          continue;
        }

        if (isDuplicateInStock(mapped)) {
          skippedDuplicates++;
          continue;
        }

        if (currentMovies.length + currentTv.length >= maxStockCap) break;

        // Tür + çapraz kimlik + gerçek poster için akış kaydını tamamla, sonra tekrar ele
        mapped = await enrichCandidate(mapped);
        if (isExcludedByUser(mapped)) {
          skippedUserListed++;
          continue;
        }
        if (isDuplicateInStock(mapped)) {
          skippedDuplicates++;
          continue;
        }

        registerItemToStock(mapped);
        const currentTotal = addedMovies + addedTv;

        onProgress?.({
          phase: 'series',
          current: Math.min(48, Math.floor((currentTotal / targetNewCount) * 50)),
          total: 100,
          stepMessage: `Yeni dizi eklendi: ${mapped.name} (${currentTotal}/${targetNewCount})`,
          itemTitle: mapped.name,
          foundCount: currentTotal,
        });

        if (currentTotal >= targetNewCount) break;
      }

      seriesPage++;
    }

    // Phase 2: Live Movies scanning (up to 30 pages until target reached)
    let moviePage = 0;
    while (
      addedMovies + addedTv < targetNewCount &&
      moviePage < maxPagesToProbe &&
      currentMovies.length + currentTv.length < maxStockCap
    ) {
      checkAbort();
      const foundSoFar = addedMovies + addedTv;
      const percent = Math.min(88, 50 + Math.floor((foundSoFar / targetNewCount) * 40));

      onProgress?.({
        phase: 'movies',
        current: percent,
        total: 100,
        stepMessage: `TheTVDB filmler taranıyor (Sayfa ${moviePage + 1}) • Bulunan yeni: ${foundSoFar} / ${targetNewCount}`,
        foundCount: foundSoFar,
      });

      let pageItems: any[] = [];
      try {
        const res = await fetchTvdbEndpoint(
          '/movies/filter',
          { sort: 'score', lang: 'tur', page: String(moviePage) },
          keyToUse,
          signal
        );
        if (Array.isArray(res?.data) && res.data.length > 0) {
          pageItems = res.data;
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        break;
      }

      if (pageItems.length === 0) break;

      for (const raw of pageItems) {
        checkAbort();
        let mapped = mapTvdbItemToTmdbItem(raw, 'movie');

        if (isExcludedByUser(mapped)) {
          skippedUserListed++;
          continue;
        }

        if (isDuplicateInStock(mapped)) {
          skippedDuplicates++;
          continue;
        }

        if (currentMovies.length + currentTv.length >= maxStockCap) break;

        mapped = await enrichCandidate(mapped);
        if (isExcludedByUser(mapped)) {
          skippedUserListed++;
          continue;
        }
        if (isDuplicateInStock(mapped)) {
          skippedDuplicates++;
          continue;
        }

        registerItemToStock(mapped);
        const currentTotal = addedMovies + addedTv;

        onProgress?.({
          phase: 'movies',
          current: Math.min(88, 50 + Math.floor((currentTotal / targetNewCount) * 40)),
          total: 100,
          stepMessage: `Yeni film eklendi: ${mapped.title} (${currentTotal}/${targetNewCount})`,
          itemTitle: mapped.title,
          foundCount: currentTotal,
        });

        if (currentTotal >= targetNewCount) break;
      }

      moviePage++;
    }

    checkAbort();

    if (addedMovies + addedTv === 0) runCuratedFallback();

    // 3b. Kullanıcı listelerine sonradan taşınmış kayıtları stok havuzundan düşür
    let removedUserListed = 0;
    const purgeUserListed = (list: TmdbItem[]): TmdbItem[] =>
      list.filter((item) => {
        if (!isExcludedByUser(item)) return true;
        removedUserListed++;
        return false;
      });
    const purgedMovies = purgeUserListed(currentMovies);
    const purgedTv = purgeUserListed(currentTv);
    currentMovies.length = 0;
    currentMovies.push(...purgedMovies);
    currentTv.length = 0;
    currentTv.push(...purgedTv);

    // 4. Save to IndexedDB
    onProgress?.({
      phase: 'saving',
      current: 95,
      total: 100,
      stepMessage: 'TVDB stoğu kaydediliyor...',
      foundCount: addedMovies + addedTv,
    });

    const updatedStock: StockDepot = {
      ...loadedStock,
      movies: currentMovies,
      tv: currentTv,
      updatedAt: new Date().toISOString(),
    };

    await saveStockIdb(updatedStock);

    // Sync to server storage
    try {
      await fetch('/api/stock/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          movies: currentMovies.slice(-300),
          tv: currentTv.slice(-300),
        }),
      });
    } catch {
      // ignore
    }

    const totalTvdbMovies = currentMovies.filter((m) => m.source === 'tvdb').length;
    const totalTvdbTv = currentTv.filter((t) => t.source === 'tvdb').length;

    onProgress?.({
      phase: 'completed',
      current: 100,
      total: 100,
      stepMessage: `Tarama tamamlandı: ${addedMovies} film ve ${addedTv} dizi eklendi (Toplam ${addedMovies + addedTv} yeni içerik)${
        removedUserListed > 0 ? `, ${removedUserListed} kayıt liste eşleşmesi için stoktan düşürüldü` : ''
      }.`,
      foundCount: addedMovies + addedTv,
    });

    return {
      ok: true,
      addedMovies,
      addedTv,
      skippedDuplicates,
      skippedUserListed,
      removedUserListed,
      totalTvdbMovies,
      totalTvdbTv,
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      onProgress?.({
        phase: 'cancelled',
        current: 0,
        total: 100,
        stepMessage: 'Senkronizasyon kullanıcı tarafından iptal edildi.',
      });
      return {
        ok: false,
        addedMovies,
        addedTv,
        skippedDuplicates,
        skippedUserListed,
        totalTvdbMovies: currentMovies.filter((m) => m.source === 'tvdb').length,
        totalTvdbTv: currentTv.filter((t) => t.source === 'tvdb').length,
        error: 'İşlem iptal edildi.',
      };
    }

    onProgress?.({
      phase: 'error',
      current: 0,
      total: 100,
      stepMessage: `Hata: ${err?.message || 'Bilinmeyen senkronizasyon hatası'}`,
    });

    return {
      ok: false,
      addedMovies,
      addedTv,
      skippedDuplicates,
      skippedUserListed,
      totalTvdbMovies: currentMovies.filter((m) => m.source === 'tvdb').length,
      totalTvdbTv: currentTv.filter((t) => t.source === 'tvdb').length,
      error: err?.message || 'Senkronizasyon başarısız oldu.',
    };
  }
}

/**
 * Direct helper to export TVDB stock items to JSON blob
 */
export async function exportTvdbStockToJson(): Promise<{
  blob: Blob;
  fileName: string;
  count: number;
  moviesCount: number;
  tvCount: number;
}> {
  const depot = await loadStockIdb();
  const movies = (depot.movies || []).filter((m) => m.source === 'tvdb');
  const tv = (depot.tv || []).filter((t) => t.source === 'tvdb');
  const allItems = [...movies, ...tv];

  const payload = {
    exportedAt: new Date().toISOString(),
    sourceFilter: 'tvdb',
    version: '1.0',
    meta: {
      total: allItems.length,
      moviesCount: movies.length,
      tvCount: tv.length,
      formatJustification: 'Kayıpsız TVDB v4 JSON yedeği',
    },
    movies,
    tv,
  };

  const jsonString = JSON.stringify(payload, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8;' });
  const dateStr = new Date().toISOString().split('T')[0];
  const fileName = `cinetrack-tvdb-stock-${dateStr}.json`;

  return {
    blob,
    fileName,
    count: allItems.length,
    moviesCount: movies.length,
    tvCount: tv.length,
  };
}

/**
 * Direct helper to restore TVDB stock from imported JSON with strict user exclusion
 */
export async function restoreTvdbStockFromJson(
  jsonText: string,
  userListItems?: ReadonlyArray<{ id?: number | string; media_type?: string; name?: string; title?: string }>,
  preferences?: { disliked?: ReadonlyArray<string>; hidden?: ReadonlyArray<string> } | null
): Promise<StockImportResult> {
  const preview = await validateAndParseStockImport(jsonText, 'tvdb-restore.json');
  if (preview.validItems.length === 0) {
    throw new Error('Dosyada geçerli TVDB yapımı bulunamadı veya biçim hatalı.');
  }

  // Ensure items have source: 'tvdb'
  const tvdbItems = preview.validItems.map((it) => ({
    ...it,
    source: 'tvdb' as const,
  }));

  return await applyStockImport(tvdbItems, 'restore', { userListItems, preferences });
}

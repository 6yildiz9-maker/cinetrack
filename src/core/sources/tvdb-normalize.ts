/**
 * TheTVDB v4 yüklerinin Cinethos TmdbItem alanlarına dönüştürülmesi.
 * Saf fonksiyonlar: ağ erişimi ve depolama yok, böylece kaynak motoru tek başına test edilebilir.
 */

export const TVDB_ARTWORK_BASE = 'https://artworks.thetvdb.com';

export type TvdbEntityType = 'movie' | 'tv';

type RawRecord = Record<string, unknown> | null | undefined;

const POSTER_FIELDS = ['image', 'image_url', 'poster', 'filename', 'backed_poster_path'] as const;

/** TVDB alan kayıtlı (`artwork-`, `series-`, `movie-`) veya salt sayı olabilir. */
export function normalizeTvdbEntityId(rawId: unknown): { id: string; type: TvdbEntityType | null } {
  const text = String(rawId ?? '').trim().toLowerCase();
  if (!text) return { id: '', type: null };
  const prefixed = /^(movie|series|episode|season|artwork)-(\d+)$/.exec(text);
  if (prefixed) {
    const kind = prefixed[1];
    const type: TvdbEntityType | null =
      kind === 'movie' ? 'movie' : kind === 'series' ? 'tv' : null;
    return { id: prefixed[2], type };
  }
  return { id: text, type: null };
}

function firstImageString(raw: RawRecord, fields: readonly string[]): string {
  if (!raw) return '';
  for (const field of fields) {
    const value = raw[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function withArtworkBase(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${TVDB_ARTWORK_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** artworks[] içindeki tip kodları: 2 = poster, 3 = background. */
function pickFromArtworks(raw: RawRecord, wantedType: number): string {
  if (!raw || !Array.isArray(raw.artworks)) return '';
  for (const artwork of raw.artworks as unknown[]) {
    if (!artwork || typeof artwork !== 'object') continue;
    const entry = artwork as Record<string, unknown>;
    if (Number(entry.type) !== wantedType) continue;
    const image = typeof entry.image === 'string' ? entry.image.trim() : '';
    if (image) return image;
  }
  return '';
}

export function normalizeTvdbPoster(raw: RawRecord): string | null {
  const direct = firstImageString(raw, POSTER_FIELDS);
  if (direct) return withArtworkBase(direct);
  const fromArtworks = pickFromArtworks(raw, 2);
  return fromArtworks ? withArtworkBase(fromArtworks) : null;
}

export function normalizeTvdbBackdrop(raw: RawRecord): string | null {
  const fromArtworks = pickFromArtworks(raw, 3);
  if (fromArtworks) return withArtworkBase(fromArtworks);
  const direct = firstImageString(raw, ['backdrop', 'backdrop_path', 'banner']);
  return direct ? withArtworkBase(direct) : null;
}

export function normalizeTvdbStatus(raw: RawRecord): string {
  if (!raw) return '';
  const status = raw.status;
  if (typeof status === 'string') return status.trim();
  if (status && typeof status === 'object') {
    const name = (status as Record<string, unknown>).name;
    if (typeof name === 'string') return name.trim();
  }
  return '';
}

/** `firstAired` (dizi), `first_air_time` (arama) veya yalnızca yıl. */
export function normalizeTvdbReleaseDate(raw: RawRecord): string {
  if (!raw) return '';
  for (const field of ['firstAired', 'first_air_time', 'first_air_date', 'release_date']) {
    const value = raw[field];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 10);
  }
  const year = raw.year;
  const text = typeof year === 'number' ? String(year) : String(year ?? '').trim();
  return /^\d{4}$/.test(text) ? `${text}-01-01` : '';
}

/**
 * TVDB `score` alanı topluluk ağırlıklı bir puandır (ör. 464230), gösterge puanı değildir.
 * Yalnızca gerçek bir gösterge puanı varsa 0-10 aralığına taşınır; yoksa undefined döner
 * ki kart puan rozetini uydurma değerle doldurmasın.
 */
export function normalizeTvdbVoteAverage(raw: RawRecord): number | undefined {
  if (!raw) return undefined;
  const direct = raw.vote_average ?? raw.voteAverage ?? raw.rating;
  const value = typeof direct === 'number' ? direct : Number(direct);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const onTen = value > 10 ? value / 10 : value;
  return Math.min(10, Number(onTen.toFixed(1)));
}

export interface TvdbCrossIds {
  tmdb?: string;
  imdb?: string;
}

/** `/extended` kaydındaki `remoteIds[]` → TMDB + IMDB çapraz kimlikleri. */
export function extractTvdbCrossIds(remoteIds: unknown): TvdbCrossIds {
  const out: TvdbCrossIds = {};
  if (!Array.isArray(remoteIds)) return out;
  for (const entry of remoteIds) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const source = String(record.sourceName ?? record.type ?? '').trim().toLowerCase();
    const id = String(record.id ?? '').trim();
    if (!id) continue;
    if (!out.tmdb && (source.includes('themoviedb') || source === 'tmdb')) out.tmdb = id;
    if (!out.imdb && source === 'imdb') out.imdb = id;
  }
  return out;
}

/**
 * Eski kayıtlarda TVDB posteri ya göreli (`/banners/...`) ya da TMDB tabanına yapışmış
 * (`https://image.tmdb.org/t/p/w500/banners/...`) hâlde durabilir. İkisini de artworks adresine çevirir.
 */
export function repairTvdbPosterUrl(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  const bannersAt = text.indexOf('/banners/');
  if (bannersAt >= 0) return `${TVDB_ARTWORK_BASE}${text.slice(bannersAt)}`;
  if (/^https?:\/\//i.test(text)) return text;
  return withArtworkBase(text);
}

const TURKISH_FOLD: Record<string, string> = {
  ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u',
  â: 'a', î: 'i', û: 'u', é: 'e', è: 'e',
};

/** Türkçe karakter katlaması + noktalama temizliği: "Şahsiyet" ≡ "sahsiyet". */
export function foldTitleKey(title: unknown): string {
  const text = String(title ?? '')
    .toLowerCase()
    .replace(/[çğıöşüâîûéè]/g, (ch) => TURKISH_FOLD[ch] ?? ch)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Yıl, parantez içindeki eşanlamlı kuyruk veya "II" gibi seri numaraları başlıkla birlikte anahtar olur. */
export function buildTitleYearKey(title: unknown, year?: unknown): string {
  const folded = foldTitleKey(title);
  if (!folded) return '';
  const digits = String(year ?? '').match(/\d{4}/);
  return digits ? `${folded}|${digits[0]}` : folded;
}

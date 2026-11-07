import type { TmdbItem } from '../types/tmdb.ts';

/**
 * TVDB v4 artwork adresleri canlı TVDB akışında geçerlidir; yalnızca yerleşik
 * demo/fallback kayıtlarındaki uydurma adresler S3 403 döndürür. Bu yüzden
 * adres, kayıt demo olmadıkça kullanılabilir sayılır.
 */
const UNUSABLE_POSTER_HOSTS = new Set(['artworks.thetvdb.com']);

const TVDB_TITLE_SUFFIX = /\s*\((?:TVDB|TVDB Edition|TVDB Sürümü)\)\s*$/i;

export function isDemoStockItem(item: TmdbItem | null | undefined): boolean {
  return Boolean(item && (item._source === 'demo' || (item as { isDemo?: boolean }).isDemo === true));
}

export interface StockPosterPatch {
  poster_path: string;
  poster_url: null;
  backdrop_path?: string;
}

export type StockPosterPatchMap = Record<string, StockPosterPatch>;

export interface StockPosterCandidate {
  key: string;
  mediaType: 'movie' | 'tv';
  item: TmdbItem;
  /** TMDB sayısal kimliği; TVDB türevi kayıtlarda null (başlıkla aranır). */
  numericId: number | null;
  query: string;
  year: string;
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isUnusableStockPosterUrl(
  value: unknown,
  item?: TmdbItem | null
): boolean {
  const url = parseUrl(value);
  if (!url) return false;
  if (!UNUSABLE_POSTER_HOSTS.has(url.hostname.toLowerCase())) return false;
  // Demo kaydı verilmezse eski çağrı davranışı korunur (kırık kabul et).
  return item === undefined ? true : isDemoStockItem(item);
}

/** Kartın poster basabileceği bir yol var mı? `getPoster` ile aynı öncelik. */
export function hasUsableStockPoster(item: TmdbItem | null | undefined): boolean {
  if (!item) return false;
  if (typeof item.poster_url === 'string' && item.poster_url.length > 0) {
    const url = parseUrl(item.poster_url);
    if (
      url &&
      url.protocol === 'https:' &&
      !isUnusableStockPosterUrl(item.poster_url, item)
    ) {
      return true;
    }
  }
  if (typeof item.poster_path === 'string' && item.poster_path.startsWith('/')) return true;
  // Canlı TVDB kayıtları posteri mutlak artworks adresi olarak taşıyabilir
  return (
    typeof item.poster_path === 'string' &&
    item.poster_path.startsWith('https://') &&
    !isUnusableStockPosterUrl(item.poster_path, item)
  );
}

function stripTitleSuffix(value: string): string {
  return value.trim().replace(TVDB_TITLE_SUFFIX, '').trim();
}

function firstYear(item: TmdbItem): string {
  const raw = item.release_date || item.first_air_date || '';
  const match = String(raw).match(/^(\d{4})/);
  return match ? match[1] : '';
}

export function readStockPosterPatch(detail: any): StockPosterPatch | null {
  const posterPath = typeof detail?.poster_path === 'string' ? detail.poster_path : '';
  if (!posterPath.startsWith('/')) return null;
  const backdropPath = typeof detail?.backdrop_path === 'string' ? detail.backdrop_path : '';
  return {
    poster_path: posterPath,
    poster_url: null,
    ...(backdropPath.startsWith('/') ? { backdrop_path: backdropPath } : {}),
  };
}

/** TVDB türevi kimlikler (tvdb-2801) TMDB'de sayısal kimlik değildir; başlıkla aranır. */
export function resolveStockNumericId(item: TmdbItem): number | null {
  const raw = String(item?.id ?? '').trim();
  if (!raw || item.source === 'tvdb' || /^tvdb[:-]/i.test(raw)) return null;
  const numericId = Number(raw);
  return Number.isInteger(numericId) && numericId > 0 ? numericId : null;
}

export function buildStockPosterCandidates(
  movies: ReadonlyArray<TmdbItem> = [],
  tv: ReadonlyArray<TmdbItem> = [],
  skipKeys?: ReadonlySet<string>
): StockPosterCandidate[] {
  const candidates: StockPosterCandidate[] = [];
  const seen = new Set<string>();
  const collect = (list: ReadonlyArray<TmdbItem>, mediaType: 'movie' | 'tv') => {
    for (const item of list) {
      if (!item || item.id == null || item.custom) continue;
      if (hasUsableStockPoster(item)) continue;
      const key = `${mediaType}:${item.id}`;
      if (seen.has(key) || skipKeys?.has(key)) continue;
      const query = stripTitleSuffix(String(item.title || item.name || ''));
      if (!query) continue;
      seen.add(key);
      candidates.push({
        key,
        mediaType,
        item,
        numericId: resolveStockNumericId(item),
        query,
        year: firstYear(item),
      });
    }
  };
  collect(tv, 'tv');
  collect(movies, 'movie');
  return candidates;
}

function normalizeTitle(value: unknown): string {
  return String(value ?? '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[’'`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** TMDB tr-TR aramasında başlık yerelleşir; orijinal adı da eşleştiririz. */
function resultTitles(result: any): string[] {
  const raw = [result?.title, result?.original_title, result?.name, result?.original_name];
  const names: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const normalized = normalizeTitle(value);
    if (normalized && !names.includes(normalized)) names.push(normalized);
  }
  return names;
}

function resultYear(result: any): number {
  const match = String(result?.release_date || result?.first_air_date || '').match(/^(\d{4})/);
  return match ? Number(match[1]) : 0;
}

/** Başlık aramasında yanlış yapımı seçmemek için en yakın sonucu döndürür. */
export function pickStockSearchMatch(
  results: ReadonlyArray<any> | null | undefined,
  candidate: StockPosterCandidate
): any | null {
  if (!Array.isArray(results)) return null;
  const wanted = normalizeTitle(candidate.query);
  if (!wanted) return null;
  const wantedYear = Number(candidate.year) || 0;
  let best: any = null;
  let bestScore = -1;

  for (const result of results) {
    const titles = resultTitles(result);
    if (titles.length === 0) continue;
    let titleScore = 0;
    for (const title of titles) {
      if (title === wanted) titleScore = Math.max(titleScore, 6);
      else if (title.startsWith(wanted) || wanted.startsWith(title)) titleScore = Math.max(titleScore, 3);
    }
    if (titleScore === 0) continue;
    let score = titleScore;

    if (wantedYear) {
      const year = resultYear(result);
      if (year) {
        const diff = Math.abs(wantedYear - year);
        score += diff === 0 ? 3 : diff === 1 ? 2 : diff <= 2 ? 1 : 0;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = result;
    }
  }
  return best;
}

export interface SanitizedStockDepot<T> {
  depot: T;
  changedCount: number;
}

/** Kullanılamayan poster alanlarını temizler; kırık adreslerin ağ isteğini keser. */
export function sanitizeStockPosterDepot<T extends { movies?: TmdbItem[]; tv?: TmdbItem[] }>(
  depot: T
): SanitizedStockDepot<T> {
  if (!depot || typeof depot !== 'object') return { depot, changedCount: 0 };
  let changedCount = 0;

  const sanitizeList = (list: TmdbItem[] | undefined) => {
    if (!Array.isArray(list)) return list;
    let listChanged = false;
    const next = list.map((item) => {
      if (!item) return item;
      const posterPath = typeof item.poster_path === 'string' ? item.poster_path : '';
      const badPath =
        isDemoStockItem(item) && posterPath.length > 0 && !posterPath.startsWith('/');
      const badUrl = isUnusableStockPosterUrl(item.poster_url, item);
      if (!badPath && !badUrl) return item;
      listChanged = true;
      changedCount += 1;
      const cleaned: TmdbItem = { ...item };
      if (badPath) cleaned.poster_path = null;
      if (badUrl) delete cleaned.poster_url;
      return cleaned;
    });
    return listChanged ? next : list;
  };

  const movies = sanitizeList(depot.movies);
  const tv = sanitizeList(depot.tv);
  if (changedCount === 0) return { depot, changedCount: 0 };
  return { depot: { ...depot, movies: movies as TmdbItem[], tv: tv as TmdbItem[] }, changedCount };
}

/** Sayfa üzerindeki stok kopyalarına poster yamalarını uygular. */
export function applyStockPosterPatchesToItems<T extends TmdbItem>(
  items: ReadonlyArray<T> | null | undefined,
  patches: StockPosterPatchMap
): T[] {
  const list = Array.isArray(items) ? items : [];
  const keys = Object.keys(patches || {});
  if (keys.length === 0) return list as T[];

  let changed = false;
  const next = list.map((item) => {
    if (!item) return item;
    const mediaType = item.media_type === 'tv' ? 'tv' : 'movie';
    const patch = patches[`${mediaType}:${item.id}`];
    if (!patch) return item;
    changed = true;
    const updated: TmdbItem = {
      ...item,
      poster_path: patch.poster_path,
      ...(item.backdrop_path ? {} : patch.backdrop_path ? { backdrop_path: patch.backdrop_path } : {}),
    };
    delete updated.poster_url;
    return updated as T;
  });

  return changed ? next : (list as T[]);
}

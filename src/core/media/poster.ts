/**
 * Poster adresi çözümünün TEK kaynağı (ARCH-03).
 *
 * Daha önce aynı kurallar `utils/helpers.ts`, `core/sources/tmdb-source.ts` ve
 * `services/stock-poster-utils.ts` içinde üç kez yazılıydı; biri değişince diğerleri
 * sessizce sapıyordu. Tüm poster kararları artık buradan geçer.
 */

export type PosterInput = {
  poster_path?: string | null;
  poster_url?: string | null;
};

export type PosterResolution =
  | { kind: 'url'; value: string }
  | { kind: 'path'; value: string }
  | { kind: 'none'; value: '' };

const TMDB_IMAGE_URL = /^https:\/\/(image|img)\.tmdb\.org\//i;

/** JSON'da `null`, boş dize, boşluk ve sayı karışıklığını tek yerde temizler. */
function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Kural:
 * 1. Mutlak TMDB CDN adresi varsa doğrudan kullanılır.
 * 2. Yerel göreli yol (`/poster.jpg`) varsa `/` ile normalize edilir.
 * 3. Yabancı mutlak adres (http/https) poster sayılmaz; güvenlik ve CSP nedeniyle atılır.
 */
export function resolvePoster(item?: PosterInput | null): PosterResolution {
  if (!item) return { kind: 'none', value: '' };

  const url = readString(item.poster_url);
  if (url) {
    if (TMDB_IMAGE_URL.test(url)) return { kind: 'url', value: url };
    if (url.startsWith('/')) return { kind: 'path', value: url };
    if (url.startsWith('https://')) return { kind: 'none', value: '' };
  }

  const path = readString(item.poster_path);
  if (!path) return { kind: 'none', value: '' };
  if (TMDB_IMAGE_URL.test(path)) return { kind: 'url', value: path };
  if (path.startsWith('https://')) return { kind: 'none', value: '' };
  return { kind: 'path', value: path.startsWith('/') ? path : `/${path}` };
}

/** Kartın poster basabileceği bir değer var mı? */
export function hasPoster(item?: PosterInput | null): boolean {
  return resolvePoster(item).kind !== 'none';
}

/** Mutlak TMDB adresini mutlak URL'e çevirir (proxy tercihi çağıranın işi). */
export function posterUrlForAbsolute(value: string, size = 'w500'): string {
  if (!/^https?:\/\//i.test(value)) return '';
  return value;
}

import type { SavedItem } from '../core/cinetrack-core.ts';
import type { TmdbItem } from '../types/tmdb.ts';

export const IMAGE_BASE = 'https://image.tmdb.org/t/p/';

export interface StreamingProviderConfig {
  id: string;
  label: string;
  chipClass?: string;
  featuredInDiscover?: boolean;
}

/**
 * Tek kaynaklı (Single Source of Truth) Türkiye TMDB yayın platformu yapılandırması.
 * TMDB TR bölgesinde Amazon Prime Video = 119, BluTV = 410, Netflix = 8, Disney+ = 337'dir.
 */
export const STREAMING_PROVIDERS: readonly StreamingProviderConfig[] = Object.freeze([
  { id: '8', label: 'Netflix', chipClass: 'provider-netflix', featuredInDiscover: true },
  { id: '119', label: 'Prime Video', chipClass: 'provider-prime', featuredInDiscover: true },
  { id: '337', label: 'Disney+', chipClass: 'provider-disney', featuredInDiscover: true },
  { id: '410', label: 'BluTV', chipClass: 'provider-blutv', featuredInDiscover: true },
  { id: '1899', label: 'Max', featuredInDiscover: false },
  { id: '350', label: 'Apple TV+', featuredInDiscover: false },
  { id: '2', label: 'Apple TV', featuredInDiscover: false },
]);

export const PROVIDER_OPTIONS: [string, string][] = STREAMING_PROVIDERS.map((p) => [p.id, p.label]);

export const DISCOVER_PROVIDER_CHIPS: readonly StreamingProviderConfig[] = STREAMING_PROVIDERS.filter(
  (p) => p.featuredInDiscover
);

export const MOOD_GENRES: Record<string, number[]> = {
  cheerful: [35, 10751, 16],
  thrilling: [53, 9648, 80],
  thoughtful: [18, 99, 36],
  energetic: [28, 12, 878],
  'feel-good': [35, 10751, 16],
  dark: [53, 9648, 80],
  adrenaline: [28, 12, 878],
  'mind-bending': [878, 9648, 53],
};

export const MOOD_LABELS: Record<string, string> = {
  cheerful: 'Neşeli',
  thrilling: 'Gerilimli',
  thoughtful: 'Düşündürücü',
  energetic: 'Enerjik',
  'feel-good': 'İyi Hissettiren',
  dark: 'Karanlık & Gerilimli',
  adrenaline: 'Adrenalin',
  'mind-bending': 'Kafa Yoran',
};

export const RATING_DESCRIPTIONS: Record<number, string> = {
  1: '1/10 Çok Kötü',
  2: '2/10 Kötü',
  3: '3/10 Zayıf',
  4: '4/10 Fena Değil',
  5: '5/10 Ortalama',
  6: '6/10 İyi',
  7: '7/10 Başarılı',
  8: '8/10 Çok İyi',
  9: '9/10 Harika',
  10: '10/10 Başyapıt',
};

export const DEFAULT_TR_GENRES: Readonly<Record<number, string>> = Object.freeze({
  28: 'Aksiyon',
  12: 'Macera',
  16: 'Animasyon',
  35: 'Komedi',
  80: 'Suç',
  99: 'Belgesel',
  18: 'Dram',
  10751: 'Aile',
  14: 'Fantastik',
  36: 'Tarih',
  27: 'Korku',
  10402: 'Müzik',
  9648: 'Gizem',
  10749: 'Romantik',
  878: 'Bilim Kurgu',
  10770: 'TV Filmi',
  53: 'Gerilim',
  10752: 'Savaş',
  37: 'Vahşi Batı',
  10759: 'Aksiyon & Macera',
  10762: 'Çocuk',
  10763: 'Haber',
  10764: 'Reality',
  10765: 'Bilim Kurgu & Fantazi',
  10766: 'Pembe Dizi',
  10767: 'Talk Show',
  10768: 'Savaş & Politik',
});

export function extractGenreNames(
  item?: Partial<TmdbItem> | SavedItem | any,
  genresMap?: Record<number, string>
): string[] {
  if (!item) return [];
  const map: Record<number, string> = { ...DEFAULT_TR_GENRES, ...(genresMap || {}) };
  const names: string[] = [];

  if (Array.isArray(item.genres) && item.genres.length > 0) {
    for (const g of item.genres) {
      if (typeof g === 'string' && g.trim()) {
        names.push(g.trim());
      } else if (g && typeof g === 'object') {
        if (typeof g.name === 'string' && g.name.trim()) {
          names.push(g.name.trim());
        } else if (typeof g.id === 'number' && map[g.id]) {
          names.push(map[g.id]);
        }
      }
    }
  }

  if (names.length === 0 && Array.isArray(item.genre_ids) && item.genre_ids.length > 0) {
    for (const id of item.genre_ids) {
      const numId = Number(id);
      if (map[numId]) {
        names.push(map[numId]);
      }
    }
  }

  return names;
}

let preferImageProxy = false;
if (typeof window !== 'undefined') {
  try {
    preferImageProxy = window.sessionStorage?.getItem('cinetrack_prefer_image_proxy') === '1';
  } catch {}
}

export function isImageProxyPreferred(): boolean {
  return preferImageProxy;
}

export function setImageProxyPreferred(preferred: boolean): void {
  preferImageProxy = preferred;
  if (typeof window !== 'undefined') {
    try {
      if (preferred) {
        window.sessionStorage?.setItem('cinetrack_prefer_image_proxy', '1');
      } else {
        window.sessionStorage?.removeItem('cinetrack_prefer_image_proxy');
      }
    } catch {}
  }
}

export function tmdbProxyUrl(pathOrUrl: string, size = 'w500'): string {
  if (!pathOrUrl) return '';
  if (pathOrUrl.startsWith('/api/tmdb-image')) return pathOrUrl;
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    return `/api/tmdb-image?url=${encodeURIComponent(pathOrUrl)}&size=${size}`;
  }
  const cleanPath = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `/api/tmdb-image?path=${encodeURIComponent(cleanPath)}&size=${size}`;
}

export function imageUrl(path?: string | null, size = 'w500'): string {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) {
    if (preferImageProxy && (path.includes('image.tmdb.org') || path.includes('img.tmdb.org'))) {
      return tmdbProxyUrl(path, size);
    }
    return path;
  }
  if (preferImageProxy) {
    return tmdbProxyUrl(path, size);
  }
  return `${IMAGE_BASE}${size}${path}`;
}

export function handleImageError(
  e: React.SyntheticEvent<HTMLImageElement>,
  fallbackPathOrUrl?: string,
  size = 'w500',
  onFinalFail?: () => void
): void {
  const img = e.currentTarget;
  if (!img) return;

  const currentSrc = img.src || '';
  const isAlreadyProxy = currentSrc.includes('/api/tmdb-image');

  if (!isAlreadyProxy) {
    setImageProxyPreferred(true);
    const target = fallbackPathOrUrl || currentSrc;
    if (target) {
      img.src = tmdbProxyUrl(target, size);
      return;
    }
  }

  if (onFinalFail) {
    onFinalFail();
  } else {
    img.style.display = 'none';
  }
}

export function displayTitle(item?: Partial<TmdbItem> | SavedItem | null): string {
  if (!item) return 'Başlıksız içerik';
  return item.title || item.name || 'Başlıksız içerik';
}

export function releaseYear(item?: Partial<TmdbItem> | SavedItem | null): string {
  if (!item) return 'Yıl bilgisi yok';
  const rawItem = item as Partial<TmdbItem>;
  const date = rawItem.release_date || rawItem.first_air_date || rawItem.releaseDate || '';
  return date ? date.slice(0, 4) : 'Yıl bilgisi yok';
}

export function formatMediaDates(
  item?: Partial<TmdbItem> | SavedItem | null,
  saved?: SavedItem | null
): string {
  if (!item) return '';
  const raw = item as Partial<TmdbItem>;
  if (raw.media_type === 'movie' || (!raw.media_type && raw.title)) {
    const rawDate = raw.release_date || raw.releaseDate || '';
    return rawDate ? rawDate.slice(0, 4) : 'Yıl bilgisi yok';
  }
  if (raw.media_type === 'tv' || (!raw.media_type && raw.name)) {
    const firstDate = raw.first_air_date || raw.releaseDate || raw.release_date || '';
    const firstYear = firstDate ? firstDate.slice(0, 4) : '';
    const lastDate = raw.last_air_date || saved?.last_air_date || '';
    const lastYear = lastDate ? lastDate.slice(0, 4) : '';
    const isEnded =
      raw.status === 'Ended' ||
      raw.status === 'Canceled' ||
      (!raw.in_production && Boolean(lastYear) && lastYear !== firstYear);

    if (!firstYear && !lastYear) return 'Tarih bilgisi yok';
    if (firstYear && lastYear) {
      if (firstYear === lastYear) return firstYear;
      return `${firstYear} – ${lastYear}`;
    }
    if (firstYear) {
      return isEnded ? firstYear : `${firstYear} – Günümüz`;
    }
    return lastYear || 'Tarih bilgisi yok';
  }
  return releaseYear(item);
}

export function getPoster(item?: Partial<TmdbItem> | SavedItem | null, size = 'w500'): string {
  if (!item) return '';
  if (item.poster_url) {
    try {
      const url = new URL(item.poster_url);
      if (url.protocol === 'https:') {
        if (preferImageProxy && (url.hostname === 'image.tmdb.org' || url.hostname === 'img.tmdb.org')) {
          return tmdbProxyUrl(url.href, size);
        }
        return url.href;
      }
      return '';
    } catch {
      return '';
    }
  }
  return imageUrl(item.poster_path, size);
}

export function dateYearsAgo(years: number): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() - years);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export const ESTIMATED_MOVIE_MINUTES = 110;
export const ESTIMATED_TV_EPISODE_MINUTES = 45;
export const ESTIMATED_TV_FALLBACK_EPISODES = 10;

export function calculateItemWatchMinutes(item?: Partial<SavedItem> | null): number {
  if (!item || typeof item !== 'object') return 0;
  if (item.media_type === 'movie') {
    const runtime = Number(item.runtime) || ESTIMATED_MOVIE_MINUTES;
    if (item.status === 'completed') return runtime;
    if (item.status === 'watching') return Math.round(runtime * 0.5);
    return 0;
  }
  if (item.media_type === 'tv') {
    const epTime =
      Number(item.episode_run_time?.[0]) || Number(item.runtime) || ESTIMATED_TV_EPISODE_MINUTES;
    const explicitEpisodes = Number(item.episodes_watched) || 0;
    if (item.status === 'completed') {
      const totalShowEpisodes =
        Number(item.number_of_episodes) ||
        (Number(item.number_of_seasons)
          ? Number(item.number_of_seasons) * ESTIMATED_TV_FALLBACK_EPISODES
          : ESTIMATED_TV_FALLBACK_EPISODES);
      const eps = Math.max(
        explicitEpisodes,
        totalShowEpisodes > 0 ? totalShowEpisodes : ESTIMATED_TV_FALLBACK_EPISODES
      );
      return eps * epTime;
    }
    if (item.status === 'watching') {
      const eps = explicitEpisodes > 0 ? explicitEpisodes : 1;
      return eps * epTime;
    }
    return 0;
  }
  return 0;
}

export function getTvShowEpisodesCount(item?: Partial<SavedItem> | null): number {
  if (!item || item.media_type !== 'tv') return 0;
  const explicit = Number(item.episodes_watched) || 0;
  if (item.status === 'completed') {
    const total =
      Number(item.number_of_episodes) ||
      (Number(item.number_of_seasons)
        ? Number(item.number_of_seasons) * ESTIMATED_TV_FALLBACK_EPISODES
        : ESTIMATED_TV_FALLBACK_EPISODES);
    return Math.max(explicit, total > 0 ? total : ESTIMATED_TV_FALLBACK_EPISODES);
  }
  if (item.status === 'watching') {
    return explicit > 0 ? explicit : 1;
  }
  return 0;
}

export function formatWatchTime(totalMinutes: number): string {
  const mins = Math.max(0, Math.round(Number(totalMinutes) || 0));
  if (mins === 0) return '0 dk';
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  if (hours === 0) return `${remainingMins} dk`;
  if (remainingMins === 0) return `${hours} sa`;
  return `${hours} sa ${remainingMins} dk`;
}


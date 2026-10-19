import { SavedItem } from '../core/cinetrack-core';

export const IMAGE_BASE = 'https://image.tmdb.org/t/p/';

export const PROVIDER_OPTIONS: [string, string][] = [
  ['8', 'Netflix'],
  ['9', 'Amazon Prime Video'],
  ['337', 'Disney+'],
  ['1899', 'Max'],
  ['350', 'Apple TV+'],
  ['2', 'Apple TV'],
  ['119', 'Amazon Prime Video Store'],
];

export const MOOD_GENRES: Record<string, number[]> = {
  cheerful: [35, 10751, 16],
  thrilling: [53, 9648, 80],
  thoughtful: [18, 99, 36],
  energetic: [28, 12, 878],
};

export const MOOD_LABELS: Record<string, string> = {
  cheerful: 'Neşeli',
  thrilling: 'Gerilimli',
  thoughtful: 'Düşündürücü',
  energetic: 'Enerjik',
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

export function imageUrl(path?: string, size = 'w500'): string {
  return path ? `${IMAGE_BASE}${size}${path}` : '';
}

export function displayTitle(item?: any): string {
  if (!item) return 'Başlıksız içerik';
  return item.title || item.name || 'Başlıksız içerik';
}

export function releaseYear(item?: any): string {
  if (!item) return 'Yıl bilgisi yok';
  const date = item.release_date || item.first_air_date || item.releaseDate || '';
  return date ? date.slice(0, 4) : 'Yıl bilgisi yok';
}

export function formatMediaDates(item?: any, saved?: SavedItem | null): string {
  if (!item) return '';
  if (item.media_type === 'movie' || (!item.media_type && item.title)) {
    const rawDate = item.release_date || item.releaseDate || '';
    return rawDate ? rawDate.slice(0, 4) : 'Yıl bilgisi yok';
  }
  if (item.media_type === 'tv' || (!item.media_type && item.name)) {
    const firstDate = item.first_air_date || item.releaseDate || item.release_date || '';
    const firstYear = firstDate ? firstDate.slice(0, 4) : '';
    const lastDate = item.last_air_date || saved?.last_air_date || '';
    const lastYear = lastDate ? lastDate.slice(0, 4) : '';
    const isEnded =
      item.status === 'Ended' ||
      item.status === 'Canceled' ||
      (!item.in_production && lastYear && lastYear !== firstYear);

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

export function getPoster(item?: any): string {
  if (!item) return '';
  if (item.poster_url) {
    try {
      const url = new URL(item.poster_url);
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }
  return imageUrl(item.poster_path);
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

export function calculateItemWatchMinutes(item: any): number {
  if (!item || typeof item !== 'object') return 0;
  if (item.media_type === 'movie') {
    const runtime = Number(item.runtime) || 110;
    if (item.status === 'completed') return runtime;
    if (item.status === 'watching') return Math.round(runtime * 0.5);
    return 0;
  }
  if (item.media_type === 'tv') {
    // TMDB episode_run_time is often an array or missing; default to 45 mins
    const epTime =
      Number(item.episode_run_time?.[0]) ||
      Number(item.runtime) ||
      45;
    const explicitEpisodes = Number(item.episodes_watched) || 0;
    if (item.status === 'completed') {
      const totalShowEpisodes =
        Number(item.number_of_episodes) ||
        (Number(item.number_of_seasons) ? Number(item.number_of_seasons) * 10 : 10);
      const eps = Math.max(explicitEpisodes, totalShowEpisodes > 0 ? totalShowEpisodes : 10);
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

export function getTvShowEpisodesCount(item: any): number {
  if (item.media_type !== 'tv') return 0;
  const explicit = Number(item.episodes_watched) || 0;
  if (item.status === 'completed') {
    const total =
      Number(item.number_of_episodes) ||
      (Number(item.number_of_seasons) ? Number(item.number_of_seasons) * 10 : 10);
    return Math.max(explicit, total > 0 ? total : 10);
  }
  if (item.status === 'watching') {
    return explicit > 0 ? explicit : 1;
  }
  return 0;
}


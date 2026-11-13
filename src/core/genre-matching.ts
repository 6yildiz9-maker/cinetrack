/**
 * TMDB film ve dizi tür kimlikleri arasındaki çapraz eşdeğerliği denetler.
 * Örn: Film Fantastik (14) / Bilim Kurgu (878) <-> Dizi Bilim Kurgu & Fantazi (10765),
 * Film Aksiyon (28) / Macera (12) <-> Dizi Aksiyon & Macera (10759),
 * Film Savaş (10752) <-> Dizi Savaş & Politik (10768).
 */
export function canonicalGenreKeys(genreIds: number[]): Set<string> {
  const keys = new Set<string>();
  for (const rawId of genreIds || []) {
    const id = Number(rawId);
    if (!Number.isFinite(id)) continue;
    const families = CANONICAL_GENRE_FAMILIES[id];
    if (families) {
      for (const family of families) keys.add(`family:${family}`);
    } else {
      keys.add(`id:${id}`);
    }
  }
  return keys;
}

/**
 * Film ve dizi tür kimliklerini ortak kavram anahtarlarına indirger.
 * Böylece 878 (film) ile 10765 (dizi) aynı ``scifi`` ailesinde buluşur.
 */
const CANONICAL_GENRE_FAMILIES: Record<number, string[]> = {
  878: ['scifi'],
  14: ['fantasy'],
  10765: ['scifi', 'fantasy'],
  28: ['action'],
  12: ['adventure'],
  10759: ['action', 'adventure'],
  10752: ['war'],
  10768: ['war'],
};

export function matchesSelectedGenre(
  item: any,
  selectedGenre?: string | number | null
): boolean {
  if (selectedGenre === undefined || selectedGenre === null || selectedGenre === '') {
    return true;
  }
  const gId = Number(selectedGenre);
  if (!Number.isFinite(gId) || gId <= 0) return true;

  const cand = item?.candidate && typeof item.candidate === 'object' ? item.candidate : item;
  if (!cand || typeof cand !== 'object') return false;

  const rawGenres: number[] = Array.isArray(cand.genre_ids)
    ? cand.genre_ids.map(Number).filter((n: number) => Number.isFinite(n))
    : Array.isArray(cand.genres)
    ? cand.genres
        .map((g: any) => Number(typeof g === 'object' ? g?.id : g))
        .filter((n: number) => Number.isFinite(n))
    : [];

  if (rawGenres.includes(gId)) return true;

  const mediaType =
    cand.media_type === 'tv' || cand.mediaType === 'tv'
      ? 'tv'
      : cand.media_type === 'movie' || cand.mediaType === 'movie'
      ? 'movie'
      : cand.title && !cand.first_air_date
      ? 'movie'
      : 'tv';

  if (mediaType === 'tv') {
    if ((gId === 14 || gId === 878) && rawGenres.includes(10765)) return true;
    if ((gId === 28 || gId === 12) && rawGenres.includes(10759)) return true;
    if (gId === 10752 && rawGenres.includes(10768)) return true;
  } else {
    if (gId === 10765 && (rawGenres.includes(14) || rawGenres.includes(878))) return true;
    if (gId === 10759 && (rawGenres.includes(28) || rawGenres.includes(12))) return true;
    if (gId === 10768 && rawGenres.includes(10752)) return true;
  }

  return false;
}

/**
 * TMDB /discover/{movie|tv} uç noktası için çapraz tür parametresini çözümler.
 */
export function resolveDiscoverGenreParam(
  selectedGenre: string | number | undefined | null,
  mediaType: 'movie' | 'tv'
): string {
  if (selectedGenre === undefined || selectedGenre === null || selectedGenre === '') {
    return '';
  }
  const gId = Number(selectedGenre);
  if (!Number.isFinite(gId) || gId <= 0) return '';

  if (mediaType === 'tv') {
    if (gId === 14 || gId === 878) return '10765';
    if (gId === 28 || gId === 12) return '10759';
    if (gId === 10752) return '10768';
    return String(gId);
  }

  if (gId === 10765) return '878|14';
  if (gId === 10759) return '28|12';
  if (gId === 10768) return '10752';
  return String(gId);
}

import type { Profile, SavedItem } from './cinetrack-core.ts';
import { buildTasteDnaProfile } from './exporters.ts';
import { computeProfileCentroid, cosineSimilarity, encodeItemContent } from './encoding.ts';

const TR_MONTH_SHORT = [
  'Oca',
  'Şub',
  'Mar',
  'Nis',
  'May',
  'Haz',
  'Tem',
  'Ağu',
  'Eyl',
  'Eki',
  'Kas',
  'Ara',
] as const;

const TR_MONTH_FULL = [
  'Ocak',
  'Şubat',
  'Mart',
  'Nisan',
  'Mayıs',
  'Haziran',
  'Temmuz',
  'Ağustos',
  'Eylül',
  'Ekim',
  'Kasım',
  'Aralık',
] as const;

const FALLBACK_GENRE_NAMES: Record<number, string> = {
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
  10765: 'Bilim Kurgu & Fantazi',
};

export interface WrappedRankedGenre {
  id: number;
  name: string;
  count: number;
  sharePercent: number;
}

export interface WrappedRankedEra {
  era: string;
  count: number;
  sharePercent: number;
}

export interface WrappedRankedActor {
  id: number;
  name: string;
  count: number;
}

export interface WrappedMonthBucket {
  monthIndex: number;
  shortLabel: string;
  fullLabel: string;
  count: number;
  intensityRatio: number;
}

export interface WrappedMostLovedItem {
  id: number | string;
  media_type: 'movie' | 'tv';
  title: string;
  releaseYear: number | null;
  personalRating: number | null;
  tmdbRating: number;
  posterPath: string | null;
  tasteMatchPercent: number;
}

export interface YearlyWrappedSummary {
  year: number;
  totalItems: number;
  completedCount: number;
  movieCount: number;
  tvCount: number;
  estimatedHours: number;
  averagePersonalRating: number | null;
  ratedCount: number;
  topGenres: WrappedRankedGenre[];
  topEras: WrappedRankedEra[];
  topActors: WrappedRankedActor[];
  monthlyIntensity: WrappedMonthBucket[];
  peakMonthLabel: string | null;
  mostLovedItem: WrappedMostLovedItem | null;
  dnaHeadline: string;
  usedAllTimeFallback: boolean;
}

export function resolveItemTrackedDate(item: SavedItem): Date | null {
  const candidates = [item.updatedAt, item.addedAt, item.firstAddedAt];
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '1970-01-01T00:00:00.000Z') continue;
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      const yr = parsed.getUTCFullYear();
      if (yr >= 2000 && yr <= 2100) {
        return parsed;
      }
    }
  }
  return null;
}

export function computeAvailableWrappedYears(
  items: SavedItem[],
  referenceYear: number = new Date().getFullYear()
): number[] {
  const yearSet = new Set<number>();
  for (const item of items) {
    const dt = resolveItemTrackedDate(item);
    if (dt) {
      yearSet.add(dt.getUTCFullYear());
    }
  }
  if (yearSet.size === 0 && items.length > 0) {
    yearSet.add(referenceYear);
  }
  return Array.from(yearSet).sort((a, b) => b - a);
}

/**
 * Generates a personal annual cinema summary ("Yıl Künyesi / Wrapped") from SavedItem[]
 * and Taste DNA / feature encodings (IMP-09).
 */
export function buildYearlyWrappedSummary(
  profile: Profile,
  targetYear: number,
  genreMap: Record<number, string> = {}
): YearlyWrappedSummary {
  const allItems = Array.isArray(profile.items) ? profile.items : [];
  const itemsWithYear: Array<{ item: SavedItem; date: Date | null }> = [];

  for (const item of allItems) {
    const dt = resolveItemTrackedDate(item);
    if (dt && dt.getUTCFullYear() === targetYear) {
      itemsWithYear.push({ item, date: dt });
    }
  }

  let usedAllTimeFallback = false;
  const anyTimestampedAnywhere = allItems.some((it) => resolveItemTrackedDate(it) !== null);
  if (itemsWithYear.length === 0 && !anyTimestampedAnywhere && allItems.length > 0) {
    usedAllTimeFallback = true;
    for (const item of allItems) {
      itemsWithYear.push({ item, date: null });
    }
  }

  const scopedItems = itemsWithYear.map((entry) => entry.item);
  const totalItems = scopedItems.length;
  const completedCount = scopedItems.filter((it) => it.status === 'completed').length;
  const movieCount = scopedItems.filter((it) => it.media_type !== 'tv').length;
  const tvCount = totalItems - movieCount;

  let totalMinutes = 0;
  for (const it of scopedItems) {
    if (typeof it.totalWatchTimeMinutes === 'number' && it.totalWatchTimeMinutes > 0) {
      totalMinutes += it.totalWatchTimeMinutes;
    } else if (it.status === 'completed' || it.status === 'watching') {
      totalMinutes += it.media_type === 'tv' ? (it.episodes_watched || 8) * 45 : it.runtime || 115;
    }
  }
  const estimatedHours = Math.round(totalMinutes / 60);

  const ratedItems = scopedItems.filter(
    (it) =>
      typeof it.personal_rating === 'number' &&
      Number.isFinite(it.personal_rating) &&
      it.personal_rating > 0
  );
  const averagePersonalRating =
    ratedItems.length > 0
      ? Math.round(
          (ratedItems.reduce((acc, it) => acc + Number(it.personal_rating || 0), 0) /
            ratedItems.length) *
            10
        ) / 10
      : null;

  // Top 3 genres
  const genreWeights = new Map<number, number>();
  const genreRawCounts = new Map<number, number>();
  for (const it of scopedItems) {
    const gids = Array.isArray(it.genre_ids) ? it.genre_ids : [];
    const weight =
      typeof it.personal_rating === 'number' && it.personal_rating >= 8
        ? 1.4
        : it.status === 'completed'
          ? 1.2
          : 1.0;
    for (const gid of gids) {
      if (typeof gid === 'number' && gid > 0) {
        genreWeights.set(gid, (genreWeights.get(gid) || 0) + weight);
        genreRawCounts.set(gid, (genreRawCounts.get(gid) || 0) + 1);
      }
    }
  }
  const totalGenreWeight =
    Array.from(genreWeights.values()).reduce((sum, val) => sum + val, 0) || 1;
  const topGenres: WrappedRankedGenre[] = Array.from(genreWeights.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([gid, weighted]) => ({
      id: gid,
      name: genreMap[gid] || FALLBACK_GENRE_NAMES[gid] || `Tür #${gid}`,
      count: genreRawCounts.get(gid) || 1,
      sharePercent: Math.max(1, Math.round((weighted / totalGenreWeight) * 100)),
    }));

  // Top 3 release eras (decades)
  const eraCounts = new Map<string, number>();
  let totalWithEra = 0;
  for (const it of scopedItems) {
    const rawDate = it.release_date || it.first_air_date || '';
    const relYear = Number(rawDate.slice(0, 4));
    if (Number.isFinite(relYear) && relYear >= 1920 && relYear <= 2040) {
      const decadeStart = Math.floor(relYear / 10) * 10;
      const label = `${decadeStart}'lar`;
      eraCounts.set(label, (eraCounts.get(label) || 0) + 1);
      totalWithEra += 1;
    }
  }
  const topEras: WrappedRankedEra[] = Array.from(eraCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([era, count]) => ({
      era,
      count,
      sharePercent: totalWithEra > 0 ? Math.max(1, Math.round((count / totalWithEra) * 100)) : 0,
    }));

  // Top 3 actors across scoped items
  const actorCounts = new Map<number, { id: number; name: string; count: number }>();
  for (const it of scopedItems) {
    const castList = Array.isArray(it.cast) ? it.cast.slice(0, 5) : [];
    for (const actor of castList) {
      if (!actor || typeof actor.id !== 'number' || !actor.name) continue;
      const prev = actorCounts.get(actor.id);
      if (prev) {
        prev.count += 1;
      } else {
        actorCounts.set(actor.id, { id: actor.id, name: actor.name, count: 1 });
      }
    }
  }
  if (actorCounts.size === 0 && Array.isArray(profile.favoriteActors)) {
    for (const fav of profile.favoriteActors.slice(0, 3)) {
      if (fav && fav.id > 0 && fav.name) {
        actorCounts.set(fav.id, { id: fav.id, name: fav.name, count: 1 });
      }
    }
  }
  const topActors: WrappedRankedActor[] = Array.from(actorCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  // 12-month intensity distribution
  const rawMonthCounts = new Array<number>(12).fill(0);
  for (const { date } of itemsWithYear) {
    if (date) {
      const m = date.getUTCMonth();
      if (m >= 0 && m < 12) {
        rawMonthCounts[m] += 1;
      }
    }
  }
  const maxMonthCount = Math.max(0, ...rawMonthCounts);
  const monthlyIntensity: WrappedMonthBucket[] = rawMonthCounts.map((count, idx) => ({
    monthIndex: idx,
    shortLabel: TR_MONTH_SHORT[idx],
    fullLabel: TR_MONTH_FULL[idx],
    count,
    intensityRatio: maxMonthCount > 0 ? Math.round((count / maxMonthCount) * 100) / 100 : 0,
  }));

  let peakMonthLabel: string | null = null;
  if (maxMonthCount > 0) {
    const peakIdx = rawMonthCounts.indexOf(maxMonthCount);
    if (peakIdx >= 0) {
      peakMonthLabel = `${TR_MONTH_FULL[peakIdx]} (${maxMonthCount} yapım)`;
    }
  }

  // Year's centroid + most loved item
  const encodedPairs = scopedItems.map((item) => ({
    item,
    encoding: encodeItemContent(item),
    personal_rating: item.personal_rating,
  }));
  const statusWeights: Record<string, number> = {};
  for (const { item, encoding } of encodedPairs) {
    const key = `${encoding.media_type}:${encoding.id}`;
    statusWeights[key] =
      item.status === 'completed' ? 1.0 : item.status === 'watching' ? 0.75 : 0.45;
  }
  const yearCentroid = computeProfileCentroid(encodedPairs, statusWeights);

  let mostLovedItem: WrappedMostLovedItem | null = null;
  if (encodedPairs.length > 0) {
    const ranked = [...encodedPairs].sort((a, b) => {
      const ratingA = typeof a.item.personal_rating === 'number' ? a.item.personal_rating : -1;
      const ratingB = typeof b.item.personal_rating === 'number' ? b.item.personal_rating : -1;
      if (ratingB !== ratingA) return ratingB - ratingA;

      const compA = a.item.status === 'completed' ? 1 : 0;
      const compB = b.item.status === 'completed' ? 1 : 0;
      if (compB !== compA) return compB - compA;

      const simA = yearCentroid.length ? cosineSimilarity(a.encoding.denseVector, yearCentroid) : 0;
      const simB = yearCentroid.length ? cosineSimilarity(b.encoding.denseVector, yearCentroid) : 0;
      if (Math.abs(simB - simA) > 0.02) return simB - simA;

      return (b.item.vote_average || 0) - (a.item.vote_average || 0);
    });

    const winner = ranked[0];
    const relDate = winner.item.release_date || winner.item.first_air_date || '';
    const relYearNum = Number(relDate.slice(0, 4));
    const sim = yearCentroid.length
      ? cosineSimilarity(winner.encoding.denseVector, yearCentroid)
      : 0.85;

    mostLovedItem = {
      id: winner.item.id,
      media_type: winner.item.media_type,
      title: winner.item.title || winner.item.name || 'İsimsiz Yapım',
      releaseYear: Number.isFinite(relYearNum) && relYearNum >= 1900 ? relYearNum : null,
      personalRating:
        typeof winner.item.personal_rating === 'number' ? winner.item.personal_rating : null,
      tmdbRating: Math.round((winner.item.vote_average || 0) * 10) / 10,
      posterPath: winner.item.poster_path || winner.item.poster_url || null,
      tasteMatchPercent: Math.max(50, Math.min(99, Math.round(sim * 100))),
    };
  }

  const scopedProfile: Profile = {
    ...profile,
    items: scopedItems,
  };
  const dna = buildTasteDnaProfile(scopedProfile, genreMap);
  const formatTrait = dna.signatureTraits[0]?.value || 'Sinema Tutkunu';
  const topGenreName = topGenres[0]?.name || 'Çok Türlü';
  const dnaHeadline = `${formatTrait} · ${topGenreName} Ekseni`;

  return {
    year: targetYear,
    totalItems,
    completedCount,
    movieCount,
    tvCount,
    estimatedHours,
    averagePersonalRating,
    ratedCount: ratedItems.length,
    topGenres,
    topEras,
    topActors,
    monthlyIntensity,
    peakMonthLabel,
    mostLovedItem,
    dnaHeadline,
    usedAllTimeFallback,
  };
}

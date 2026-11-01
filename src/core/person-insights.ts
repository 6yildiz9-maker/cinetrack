import { makeMediaKey, type SavedItem } from './cinetrack-core.ts';
import { computeProfileCentroid, cosineSimilarity, encodeItemContent } from './encoding.ts';
import type { TmdbPersonCreditItem } from '../types/tmdb.ts';

export type PersonCreditRole = 'Oyuncu' | 'Yönetmen' | 'Yaratıcı';

export interface MergedPersonWork extends TmdbPersonCreditItem {
  mediaKey: string;
  resolvedMediaType: 'movie' | 'tv';
  roles: PersonCreditRole[];
  roleSummary: string;
  year: number | null;
  inSavedList: boolean;
  savedStatus: SavedItem['status'] | null;
  inStock: boolean;
  inRelationshipMap: boolean;
}

export interface PersonTasteInsights {
  watchedCount: number;
  watchlistCount: number;
  compatibilityPercent: number;
  inStockCount: number;
  inRelationshipMapCount: number;
  directorWorksCount: number;
  actorWorksCount: number;
}

function classifyCrewRole(job?: string, department?: string): PersonCreditRole | null {
  const normJob = String(job || '').trim().toLowerCase();
  const normDept = String(department || '').trim().toLowerCase();
  if (
    normJob === 'director' ||
    normJob === 'series director' ||
    normJob === 'co-director' ||
    normDept === 'directing'
  ) {
    return 'Yönetmen';
  }
  if (normJob === 'creator' || normJob === 'created by' || normJob === 'showrunner') {
    return 'Yaratıcı';
  }
  return null;
}

function resolveCreditMediaType(item: TmdbPersonCreditItem): 'movie' | 'tv' {
  return item.media_type === 'tv' || (!item.media_type && Boolean(item.name) && !item.title)
    ? 'tv'
    : 'movie';
}

/**
 * Merges cast + directing/creating crew credits into a unified, deduplicated filmography
 * enriched with saved-list, ct:stock, and Relationship Map membership flags (IMP-12).
 */
export function mergePersonFilmography(
  credits: { cast?: TmdbPersonCreditItem[]; crew?: TmdbPersonCreditItem[] } | null | undefined,
  context: {
    savedItems: SavedItem[];
    stockKeys?: ReadonlySet<string>;
    relationshipMapKeys?: ReadonlySet<string>;
  }
): MergedPersonWork[] {
  if (!credits) return [];

  const savedByKey = new Map<string, SavedItem>();
  for (const saved of context.savedItems || []) {
    const mType = saved.media_type === 'tv' ? 'tv' : 'movie';
    savedByKey.set(makeMediaKey(mType, saved.id), saved);
  }

  const workMap = new Map<string, MergedPersonWork>();

  const upsertWork = (raw: TmdbPersonCreditItem, role: PersonCreditRole) => {
    if (!raw || raw.id == null) return;
    if (!(raw.title || raw.name)) return;

    const resolvedMediaType = resolveCreditMediaType(raw);
    const mediaKey = makeMediaKey(resolvedMediaType, raw.id);
    const existing = workMap.get(mediaKey);

    if (existing) {
      if (!existing.roles.includes(role)) {
        // Place Yönetmen/Yaratıcı first if present
        existing.roles =
          role === 'Yönetmen' || role === 'Yaratıcı'
            ? [role, ...existing.roles]
            : [...existing.roles, role];
      }
      if (!existing.character && raw.character) {
        existing.character = raw.character;
      }
      if (!existing.job && raw.job) {
        existing.job = raw.job;
      }
      existing.roleSummary = buildRoleSummary(existing);
      return;
    }

    const rawDate = raw.release_date || raw.first_air_date || '';
    const parsedYear = Number(rawDate.slice(0, 4));
    const year = Number.isFinite(parsedYear) && parsedYear >= 1890 ? parsedYear : null;
    const saved = savedByKey.get(mediaKey) || null;

    const created: MergedPersonWork = {
      ...raw,
      media_type: resolvedMediaType,
      mediaKey,
      resolvedMediaType,
      roles: [role],
      roleSummary: '',
      year,
      inSavedList: Boolean(saved),
      savedStatus: saved?.status ?? null,
      inStock: Boolean(context.stockKeys?.has(mediaKey)),
      inRelationshipMap: Boolean(context.relationshipMapKeys?.has(mediaKey)),
    };
    created.roleSummary = buildRoleSummary(created);
    workMap.set(mediaKey, created);
  };

  for (const crewItem of credits.crew || []) {
    const crewWithDept = crewItem as TmdbPersonCreditItem & { department?: string };
    const role = classifyCrewRole(crewWithDept.job, crewWithDept.department);
    if (role) {
      upsertWork(crewItem, role);
    }
  }

  for (const castItem of credits.cast || []) {
    upsertWork(castItem, 'Oyuncu');
  }

  return Array.from(workMap.values()).sort((a, b) => {
    const popDiff = (b.popularity || 0) - (a.popularity || 0);
    if (Math.abs(popDiff) > 1) return popDiff;
    return (b.vote_count || 0) - (a.vote_count || 0);
  });
}

function buildRoleSummary(work: MergedPersonWork): string {
  const parts: string[] = [];
  if (work.roles.includes('Yönetmen')) {
    parts.push('Yönetmen');
  }
  if (work.roles.includes('Yaratıcı')) {
    parts.push('Yaratıcı');
  }
  if (work.roles.includes('Oyuncu')) {
    parts.push(work.character ? `Oyuncu (${work.character})` : 'Oyuncu');
  }
  return parts.join(' · ');
}

/**
 * Computes watched count and Taste DNA compatibility percentage between a person's filmography
 * and the user's saved profile centroid (IMP-12).
 */
export function computePersonTasteCompatibility(
  personId: number,
  works: MergedPersonWork[],
  savedItems: SavedItem[]
): PersonTasteInsights {
  const watchedKeys = new Set<string>();
  const watchlistKeys = new Set<string>();
  const personRatings: number[] = [];

  for (const work of works) {
    if (work.savedStatus === 'completed' || work.savedStatus === 'watching') {
      watchedKeys.add(work.mediaKey);
    } else if (work.savedStatus === 'watchlist') {
      watchlistKeys.add(work.mediaKey);
    }
  }

  for (const item of savedItems) {
    const key = makeMediaKey(item.media_type === 'tv' ? 'tv' : 'movie', item.id);
    const inCast = (item.cast || []).some((c) => Number(c.id) === personId);
    const inCrew = (item.crew || []).some((c) => Number(c.id) === personId);
    const matchedInWorks = watchedKeys.has(key) || watchlistKeys.has(key);

    if (inCast || inCrew || matchedInWorks) {
      if (item.status === 'completed' || item.status === 'watching') {
        watchedKeys.add(key);
      } else if (item.status === 'watchlist') {
        watchlistKeys.add(key);
      }
      if (typeof item.personal_rating === 'number' && item.personal_rating > 0) {
        personRatings.push(item.personal_rating);
      }
    }
  }

  // Compute user profile centroid
  const encodedSaved = savedItems.map((it) => ({
    encoding: encodeItemContent(it),
    personal_rating: it.personal_rating,
  }));
  const statusWeights: Record<string, number> = {};
  for (const it of savedItems) {
    const mType = it.media_type === 'tv' ? 'tv' : 'movie';
    statusWeights[`${mType}:${it.id}`] =
      it.status === 'completed' ? 1.0 : it.status === 'watching' ? 0.75 : 0.5;
  }
  const userCentroid = computeProfileCentroid(encodedSaved, statusWeights);

  // Compute person filmography centroid from top 20 representative works
  const personSample = works.slice(0, 20).map((w) => encodeItemContent(w));
  const personCentroid = computeProfileCentroid(personSample);

  let compatibilityPercent = 65;
  if (userCentroid.length > 0 && personCentroid.length > 0) {
    const rawCosine = cosineSimilarity(userCentroid, personCentroid);
    // Calibrate cosine [0.25..0.95] smoothly onto intuitive [45..98]%
    let score = Math.round(38 + rawCosine * 58);

    if (personRatings.length > 0) {
      const avgPersonal =
        personRatings.reduce((sum, r) => sum + r, 0) / personRatings.length;
      score = Math.round(score * 0.65 + avgPersonal * 10 * 0.35);
    } else if (watchedKeys.size >= 3) {
      score += 4;
    }

    compatibilityPercent = Math.max(25, Math.min(99, score));
  }

  return {
    watchedCount: watchedKeys.size,
    watchlistCount: watchlistKeys.size,
    compatibilityPercent,
    inStockCount: works.filter((w) => w.inStock).length,
    inRelationshipMapCount: works.filter((w) => w.inRelationshipMap).length,
    directorWorksCount: works.filter(
      (w) => w.roles.includes('Yönetmen') || w.roles.includes('Yaratıcı')
    ).length,
    actorWorksCount: works.filter((w) => w.roles.includes('Oyuncu')).length,
  };
}

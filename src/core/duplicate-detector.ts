import { makeMediaKey, type SavedItem } from './cinetrack-core.ts';
import { cosineSimilarity, encodeItemContent } from './encoding.ts';

export interface DuplicatePairCandidate {
  pairId: string;
  primaryItem: SavedItem;
  secondaryItem: SavedItem;
  mediaType: 'movie' | 'tv';
  titleSimilarity: number;
  encodingSimilarity: number;
  combinedScore: number;
  reason: string;
}

const EDITION_SUFFIX_PATTERN =
  /\b(extended|remastered|uncut|director\s*s?\s*cut|special\s*edition|anniversary\s*edition|imax|4k|dublaj|altyazili|altyazılı)\b/giu;

const LEADING_ARTICLE_PATTERN = /^(the|a|an|bir|le|la|les|el|los|las|der|die|das)\s+/iu;

export function normalizeWorkTitle(raw: string): string {
  const lowered = String(raw || '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(EDITION_SUFFIX_PATTERN, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

  return lowered.replace(LEADING_ARTICLE_PATTERN, '').replace(/\s+/g, ' ').trim();
}

function buildBigrams(str: string): string[] {
  const compact = str.replace(/\s+/g, '');
  if (compact.length < 2) return compact ? [compact] : [];
  const out: string[] = [];
  for (let i = 0; i < compact.length - 1; i += 1) {
    out.push(compact.slice(i, i + 2));
  }
  return out;
}

export function computeNormalizedTitleSimilarity(titleA: string, titleB: string): number {
  const normA = normalizeWorkTitle(titleA);
  const normB = normalizeWorkTitle(titleB);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;

  const bigramsA = buildBigrams(normA);
  const bigramsB = buildBigrams(normB);
  if (bigramsA.length === 0 || bigramsB.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const bg of bigramsA) {
    counts.set(bg, (counts.get(bg) || 0) + 1);
  }
  let intersection = 0;
  for (const bg of bigramsB) {
    const c = counts.get(bg) || 0;
    if (c > 0) {
      intersection += 1;
      counts.set(bg, c - 1);
    }
  }

  return (2 * intersection) / (bigramsA.length + bigramsB.length);
}

function collectCandidateTitles(item: SavedItem): string[] {
  const raw = [item.title, item.name, item.original_title, item.original_name];
  const unique = new Set<string>();
  for (const t of raw) {
    if (typeof t === 'string' && t.trim()) {
      unique.add(t.trim());
    }
  }
  return Array.from(unique);
}

function extractReleaseYear(item: SavedItem): number | null {
  const dateStr = item.release_date || item.first_air_date || '';
  const yr = Number(dateStr.slice(0, 4));
  return Number.isFinite(yr) && yr >= 1890 && yr <= 2040 ? yr : null;
}

function statusPriority(status: SavedItem['status']): number {
  if (status === 'completed') return 3;
  if (status === 'watching') return 2;
  return 1;
}

function itemCompletenessScore(item: SavedItem): number {
  let score = statusPriority(item.status) * 10;
  if (typeof item.personal_rating === 'number' && item.personal_rating > 0) score += 15;
  if (!String(item.id).startsWith('custom-')) score += 12;
  if (item.poster_path || item.poster_url) score += 5;
  if (item.overview && item.overview.length > 20) score += 4;
  if (Array.isArray(item.cast) && item.cast.length > 0) score += 4;
  return score;
}

/**
 * Detects duplicate variants of the same movie or TV show (e.g. custom entry + TMDB entry,
 * localized vs original title duplicate IDs) using normalized title similarity + encoding cosine similarity (IMP-15).
 */
export function detectDuplicateSavedItems(items: SavedItem[]): DuplicatePairCandidate[] {
  if (!Array.isArray(items) || items.length < 2) return [];

  const encodings = items.map((it) => encodeItemContent(it));
  const titlesPerItem = items.map((it) => collectCandidateTitles(it));
  const yearsPerItem = items.map((it) => extractReleaseYear(it));

  const pairs: DuplicatePairCandidate[] = [];

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      if (a.media_type !== b.media_type) continue;
      if (String(a.id) === String(b.id)) continue;

      const yearA = yearsPerItem[i];
      const yearB = yearsPerItem[j];
      if (yearA !== null && yearB !== null && Math.abs(yearA - yearB) > 2) {
        continue;
      }

      let bestTitleSim = 0;
      for (const tA of titlesPerItem[i]) {
        for (const tB of titlesPerItem[j]) {
          const sim = computeNormalizedTitleSimilarity(tA, tB);
          if (sim > bestTitleSim) bestTitleSim = sim;
        }
      }

      if (bestTitleSim < 0.65) continue;

      const encSim = cosineSimilarity(encodings[i].denseVector, encodings[j].denseVector);
      const sameYear = yearA !== null && yearB !== null && yearA === yearB;

      const isDuplicate =
        bestTitleSim >= 0.94 ||
        (bestTitleSim >= 0.82 && encSim >= 0.65) ||
        (sameYear && bestTitleSim >= 0.72 && encSim >= 0.84);

      if (!isDuplicate) continue;

      const aPrimary = itemCompletenessScore(a) >= itemCompletenessScore(b);
      const primaryItem = aPrimary ? a : b;
      const secondaryItem = aPrimary ? b : a;
      const combinedScore = Math.round((bestTitleSim * 0.6 + encSim * 0.4) * 100);

      const reasonParts: string[] = [
        `Başlık benzerliği %${Math.round(bestTitleSim * 100)}`,
        `özellik vektörü %${Math.round(encSim * 100)}`,
      ];
      if (sameYear && yearA) {
        reasonParts.push(`aynı yıl (${yearA})`);
      }

      pairs.push({
        pairId: `${a.media_type}:${primaryItem.id}__${secondaryItem.id}`,
        primaryItem,
        secondaryItem,
        mediaType: a.media_type,
        titleSimilarity: Math.round(bestTitleSim * 100) / 100,
        encodingSimilarity: Math.round(encSim * 100) / 100,
        combinedScore,
        reason: reasonParts.join(' · '),
      });
    }
  }

  return pairs.sort((a, b) => b.combinedScore - a.combinedScore);
}

/**
 * Merges two duplicate SavedItem records non-destructively on explicit user approval ("Bunları Birleştir"),
 * preserving personal ratings, highest watch status, TV episode progress, and metadata (IMP-15).
 */
export function mergeDuplicateSavedPair(
  items: SavedItem[],
  keepId: SavedItem['id'],
  dropId: SavedItem['id'],
  mediaType: 'movie' | 'tv'
): {
  mergedItems: SavedItem[];
  mergedItem: SavedItem | null;
  removedKey: string | null;
} {
  const keepIdx = items.findIndex(
    (it) => it.media_type === mediaType && String(it.id) === String(keepId)
  );
  const dropIdx = items.findIndex(
    (it) => it.media_type === mediaType && String(it.id) === String(dropId)
  );

  if (keepIdx < 0 || dropIdx < 0 || keepIdx === dropIdx) {
    return { mergedItems: items, mergedItem: null, removedKey: null };
  }

  const keep = items[keepIdx];
  const drop = items[dropIdx];

  const mergedStatus =
    statusPriority(keep.status) >= statusPriority(drop.status) ? keep.status : drop.status;

  const mergedRating: number | '' =
    typeof keep.personal_rating === 'number' && keep.personal_rating > 0
      ? keep.personal_rating
      : typeof drop.personal_rating === 'number' && drop.personal_rating > 0
        ? drop.personal_rating
        : '';

  const mergedGenres = Array.from(
    new Set([...(keep.genre_ids || []), ...(drop.genre_ids || [])])
  );

  let mergedSeasonProgress: Record<number, number> | undefined = keep.season_progress;
  if (keep.season_progress || drop.season_progress) {
    mergedSeasonProgress = { ...(drop.season_progress || {}), ...(keep.season_progress || {}) };
    for (const [sKey, epVal] of Object.entries(drop.season_progress || {})) {
      const sNum = Number(sKey);
      mergedSeasonProgress[sNum] = Math.max(
        Number(mergedSeasonProgress[sNum] || 0),
        Number(epVal || 0)
      );
    }
  }

  const earliestAdded =
    keep.addedAt && drop.addedAt
      ? keep.addedAt <= drop.addedAt
        ? keep.addedAt
        : drop.addedAt
      : keep.addedAt || drop.addedAt;

  const keepWithNote = keep as SavedItem & { note?: string; notes?: string; user_note?: string };
  const dropWithNote = drop as SavedItem & { note?: string; notes?: string; user_note?: string };
  const noteA = String(keepWithNote.note || keepWithNote.notes || keepWithNote.user_note || '').trim();
  const noteB = String(dropWithNote.note || dropWithNote.notes || dropWithNote.user_note || '').trim();
  const combinedNote =
    noteA && noteB && noteA !== noteB ? `${noteA} | ${noteB}` : noteA || noteB || undefined;

  const mergedItem: SavedItem & { note?: string } = {
    ...drop,
    ...keep,
    id: keep.id,
    media_type: mediaType,
    status: mergedStatus,
    personal_rating: mergedRating,
    genre_ids: mergedGenres,
    poster_path: keep.poster_path || drop.poster_path,
    poster_url: keep.poster_url || drop.poster_url,
    backdrop_path: keep.backdrop_path || drop.backdrop_path,
    overview:
      keep.overview && keep.overview.length >= (drop.overview?.length || 0)
        ? keep.overview
        : drop.overview || keep.overview,
    original_title: keep.original_title || drop.original_title,
    original_name: keep.original_name || drop.original_name,
    cast: keep.cast?.length ? keep.cast : drop.cast,
    crew: keep.crew?.length ? keep.crew : drop.crew,
    episodes_watched: Math.max(keep.episodes_watched || 0, drop.episodes_watched || 0) || undefined,
    current_season: Math.max(keep.current_season || 0, drop.current_season || 0) || undefined,
    ...(mergedSeasonProgress ? { season_progress: mergedSeasonProgress } : {}),
    addedAt: earliestAdded,
    firstAddedAt: keep.firstAddedAt || drop.firstAddedAt || earliestAdded,
    updatedAt: new Date().toISOString(),
    ...(combinedNote ? { note: combinedNote } : {}),
  };

  const mergedItems: SavedItem[] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (i === dropIdx) continue;
    if (i === keepIdx) {
      mergedItems.push(mergedItem);
    } else {
      mergedItems.push(items[i]);
    }
  }

  return {
    mergedItems,
    mergedItem,
    removedKey: makeMediaKey(mediaType, drop.id),
  };
}

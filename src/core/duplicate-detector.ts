import { makeMediaKey, type SavedItem } from './cinetrack-core.ts';
import { cosineSimilarity, encodeItemContent, type ItemFeatureEncoding } from './encoding.ts';

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

const ROMAN_VALUE: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
};

const NUMBER_WORD_VALUE: Record<string, number> = {
  bir: 1, iki: 2, uc: 3, üç: 3, dort: 4, dört: 4, bes: 5, beş: 5,
  alti: 6, altı: 6, yedi: 7, sekiz: 8, dokuz: 9, on: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function normalizePartToken(raw: string): string {
  return String(raw)
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .trim();
}

function parsePartToken(token: string): number | null {
  const t = normalizePartToken(token);
  if (/^\d{1,2}$/.test(t)) return Number(t);
  if (Object.prototype.hasOwnProperty.call(ROMAN_VALUE, t)) return ROMAN_VALUE[t];
  if (Object.prototype.hasOwnProperty.call(NUMBER_WORD_VALUE, t)) return NUMBER_WORD_VALUE[t];
  return null;
}

export interface SeriesPartInfo {
  partNumber: number | null;
  baseTitle: string;
  subtitle: string | null;
  is3d?: boolean;
}

// "Şafak Vakti Bölüm 1", "Godfather Part II", "Bölüm İki/Üç" gibi sonda parça ibaresi
const PART_PHRASE_PATTERN =
  /^(.*?)\s+(?:part|bölüm|bolum|kısım|kisim)\s*(?:[:-]?\s*)([\p{L}\d]{1,12})\s*$/iu;
// "Görevimiz Tehlike III" gibi sonda Romen rakamı
const TRAILING_ROMAN_PATTERN = /^(.*?)\s+(i{1,3}|iv|v|vi|vii|viii|ix|x)$/i;
// "Hızlı ve Öfkeli 9" gibi sonda Arap rakamı ("Testere 3D" de yakalanır, 3D işareti ayrı tutulur)
const TRAILING_ARABIC_PATTERN = /^(.*?)\s+(\d{1,2}\s*d|\d{1,2})$/i;
// "Amerikan Pastası: Düğün" gibi iki noktalı alt başlık
const COLON_SUBTITLE_PATTERN = /^(.{2,}?)\s*:\s*(.{1,})\s*$/u;
// "X: Part 2", "X: Bölüm İki", "X: Episode IV" gibi alt başlık içinde parça ibaresi
const SUBTITLE_PART_PREFIX_PATTERN =
  /^(?:part|bölüm|bolum|kısım|kisim|episode|epizod)\s*(?:[:-]?\s*)([\p{L}\d]{1,12})\s*$/iu;

/**
 * Bir başlıktan seri/film sıra numarasını, numarasız taban başlığı ve varsa
 * iki noktadan sonraki alt başlığı çıkarır. Tek başına sayı olan başlıklar ("9")
 * parça sayılmaz.
 */
export function extractSeriesPartInfo(title: string): SeriesPartInfo {
  const t = String(title || '').trim();
  if (!t) return { partNumber: null, baseTitle: t, subtitle: null };
  const phrase = PART_PHRASE_PATTERN.exec(t);
  if (phrase) {
    const phrasePart = parsePartToken(phrase[2]);
    if (phrasePart !== null && phrase[1].trim().length >= 2) {
      return { partNumber: phrasePart, baseTitle: phrase[1].trim(), subtitle: null };
    }
  }
  const roman = TRAILING_ROMAN_PATTERN.exec(t);
  if (roman && roman[1].trim().length >= 2) {
    return {
      partNumber: parsePartToken(roman[2]),
      baseTitle: roman[1].trim(),
      subtitle: null,
    };
  }
  const arabic = TRAILING_ARABIC_PATTERN.exec(t);
  if (arabic && arabic[1].trim().length >= 2) {
    const token = arabic[2].replace(/\s+/g, '');
    const is3d = /d$/i.test(token);
    return {
      partNumber: parsePartToken(token.replace(/d$/i, '')),
      baseTitle: arabic[1].trim(),
      subtitle: null,
      is3d,
    };
  }
  const colon = COLON_SUBTITLE_PATTERN.exec(t);
  if (colon && colon[1].trim().length >= 2) {
    const base = colon[1].trim();
    const rawSub = colon[2].trim();
    const prefixMatch = SUBTITLE_PART_PREFIX_PATTERN.exec(rawSub);
    const parsed = parsePartToken(prefixMatch ? prefixMatch[1] : rawSub);
    if (parsed !== null) {
      return { partNumber: parsed, baseTitle: base, subtitle: null };
    }
    return { partNumber: null, baseTitle: base, subtitle: normalizePartToken(rawSub) };
  }
  return { partNumber: null, baseTitle: t, subtitle: null };
}

/**
 * İki başlık aynı serinin FARKLI filmleri mi?
 * "X" ↔ "X 2", "X II" ↔ "X III", "X Bölüm 1" ↔ "X Bölüm 2",
 * "X 2" ↔ "X: Düğün", "X: Düğün" ↔ "X: Buluşma" → true (çift kayıt DEĞİL).
 * "X 2" ↔ "X II" → false (aynı film, farklı yazım).
 */
export function areDistinctSeriesParts(titleA: string, titleB: string): boolean {
  const infoA = extractSeriesPartInfo(titleA);
  const infoB = extractSeriesPartInfo(titleB);
  const hasA = infoA.partNumber !== null;
  const hasB = infoB.partNumber !== null;
  const baseEqual =
    normalizeWorkTitle(infoA.baseTitle) === normalizeWorkTitle(infoB.baseTitle);
  if (!baseEqual) return false;
  if (hasA && hasB) {
    if (infoA.partNumber === infoB.partNumber) {
      // "X 3D" ile "X 3" farklı yapımlardır; aynı numara + aynı 3D işareti → aynı yapım
      return Boolean(infoA.is3d) !== Boolean(infoB.is3d);
    }
    return true;
  }
  if (hasA !== hasB) {
    return true;
  }
  // İkisinde de parça numarası yok: aynı taban üzerindeki farklı alt başlıklar
  // aynı serinin farklı filmleridir ("X: Düğün" ≠ "X: Buluşma" ≠ "X")
  const subA = infoA.subtitle;
  const subB = infoB.subtitle;
  if (subA !== null || subB !== null) {
    return subA !== subB;
  }
  return false;
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
 * Özellik vektörü yalnızca içerik sinyali varsa anlamlıdır. CSV'den ithal edilen
 * kayıtlarda genre/cast/overview gibi veriler boş olduğundan iki farklı filmin
 * vektörleri birbirine neredeyse eşit (cos ≈ 1.0) çıkar ve yanlış eşleşmelere yol açar.
 */
function hasInformativeEncoding(enc: ItemFeatureEncoding, item: SavedItem): boolean {
  if (enc.genreVector.some((v) => v > 0)) return true;
  if (enc.toneVector.some((v) => v > 0)) return true;
  if (enc.keywordIds.length > 0 || enc.castIds.length > 0 || enc.crewIds.length > 0) return true;
  if (typeof item.overview === 'string' && item.overview.trim().length > 20) return true;
  if (Number(item.vote_count) > 0) return true;
  return false;
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
  const richEncodingPerItem = items.map((it, idx) => hasInformativeEncoding(encodings[idx], it));

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
      let bestTitlePair: [string, string] | null = null;
      for (const tA of titlesPerItem[i]) {
        for (const tB of titlesPerItem[j]) {
          const sim = computeNormalizedTitleSimilarity(tA, tB);
          if (sim > bestTitleSim) {
            bestTitleSim = sim;
            bestTitlePair = [tA, tB];
          }
        }
      }

      if (bestTitleSim < 0.65) continue;

      // Bir serinin farklı filmleri (2/3, II/III, Bölüm 1/2) aynı yapım değildir
      if (bestTitlePair && areDistinctSeriesParts(bestTitlePair[0], bestTitlePair[1])) {
        continue;
      }

      const bothRich = richEncodingPerItem[i] && richEncodingPerItem[j];
      const encSim = bothRich
        ? cosineSimilarity(encodings[i].denseVector, encodings[j].denseVector)
        : 0;
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
      ];
      if (bothRich) {
        reasonParts.push(`özellik vektörü %${Math.round(encSim * 100)}`);
      } else {
        reasonParts.push('özellik vektörü yetersiz (metadata eksik)');
      }
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

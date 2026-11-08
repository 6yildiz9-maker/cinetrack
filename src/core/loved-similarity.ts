/**
 * Sevilen Yapımlara Benzerlik (Loved Similarity) Motoru
 *
 * Adayın başlangıç kaynağı (seedSourceType) yerine; kullanıcının gerçekten sevdiği
 * (yüksek puanlı / tamamlanmış) yapımların özellik vektörleri ile adayın özellikleri
 * arasındaki çok boyutlu anlamsal benzerliği hesaplar:
 * 1. Tür benzerliği (Genre similarity - Dice katsayısı)
 * 2. Hikâye benzerliği (Story / Overview token örtüşmesi)
 * 3. Oyuncu kadrosu benzerliği (Cast overlap)
 * 4. Atmosfer / Yönetmen / Evren benzerliği (Director & Franchise affinity)
 * 5. Dönem / Zaman benzerliği (Release era proximity)
 */

export interface LovedItemFeatures {
  key: string;
  id: number | string;
  media_type: string;
  title: string;
  genre_ids: number[];
  overviewTokens: Set<string>;
  castIds: number[];
  directorIds: number[];
  collectionId?: number;
  year?: number;
  weight: number;
}

export interface LovedSimBreakdown {
  matchedTitle: string;
  matchedKey: string;
  similarity: number;       // 0..1 birleşik benzerlik
  genreSim: number;         // 0..1 tür benzerliği
  storySim: number;         // 0..1 hikâye benzerliği
  castSim: number;          // 0..1 oyuncu benzerliği
  atmosphereSim: number;    // 0..1 atmosfer / yönetmen / evren benzerliği
  eraSim: number;           // 0..1 dönem benzerliği
}

export interface LovedSimMatchResult {
  score: number;            // 0..1 genel öneri sinyali
  breakdown: LovedSimBreakdown | null;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * 1. Tür Benzerliği (0..1)
 * İki yapımın tür kümesi arasındaki Dice katsayısı.
 */
export function calculateGenreSim(candGenres: number[], lovedGenres: number[]): number {
  if (!candGenres?.length || !lovedGenres?.length) return 0.5;
  const lovedSet = new Set(lovedGenres);
  let shared = 0;
  for (const g of candGenres) {
    if (lovedSet.has(g)) shared++;
  }
  if (shared === 0) return 0.05;
  return clamp01((2 * shared) / (candGenres.length + lovedGenres.length));
}

/**
 * 2. Hikâye Benzerliği (0..1)
 * Özet metinlerindeki anlamlı sözcük token örtüşmesi.
 */
export function calculateStorySim(
  candTokens: string[] | Set<string>,
  lovedTokens: Set<string>
): number {
  if (!lovedTokens || lovedTokens.size === 0) return 0.5;
  const tokenArr = Array.isArray(candTokens) ? candTokens : Array.from(candTokens || []);
  if (tokenArr.length === 0) return 0.5;

  let shared = 0;
  for (const t of tokenArr) {
    if (lovedTokens.has(t)) shared++;
  }
  if (shared === 0) return 0.15;
  const denominator = Math.max(1, Math.min(tokenArr.length, lovedTokens.size, 8));
  const ratio = shared / denominator;
  return clamp01(0.25 + 0.75 * Math.min(1, ratio));
}

/**
 * 3. Oyuncu Kadrosu Benzerliği (0..1)
 * Öne çıkan oyuncuların ortaklığı.
 */
export function calculateCastSim(candCastIds: number[], lovedCastIds: number[]): number {
  if (!candCastIds?.length || !lovedCastIds?.length) return 0.5;
  const lovedSet = new Set(lovedCastIds);
  let shared = 0;
  for (const id of candCastIds) {
    if (lovedSet.has(id)) shared++;
  }
  if (shared >= 2) return 0.95;
  if (shared === 1) return 0.80;
  return 0.15;
}

/**
 * 4. Atmosfer & Yönetmen / Evren Benzerliği (0..1)
 */
export function calculateAtmosphereSim(
  candDirectorIds: number[],
  lovedDirectorIds: number[],
  candCollectionId?: number,
  lovedCollectionId?: number
): number {
  if (candCollectionId && lovedCollectionId && candCollectionId === lovedCollectionId) {
    return 1.0;
  }
  if (candDirectorIds?.length && lovedDirectorIds?.length) {
    const lovedSet = new Set(lovedDirectorIds);
    if (candDirectorIds.some((id) => lovedSet.has(id))) {
      return 0.95;
    }
    return 0.35;
  }
  return 0.5;
}

/**
 * 5. Dönem Benzerliği (0..1)
 * Yapım yılları arasındaki yakınlık (25 yıllık pencere).
 */
export function calculateEraSim(candYear?: number, lovedYear?: number): number {
  if (!candYear || !lovedYear) return 0.5;
  const delta = Math.abs(candYear - lovedYear);
  return clamp01(Math.max(0, 1 - delta / 25));
}

/**
 * Aday ile belirli bir sevilen yapım arasındaki birleşik benzerliği hesaplar.
 */
export function computeItemToItemLovedSim(
  cand: {
    genre_ids?: number[];
    tokens?: string[] | Set<string>;
    castIds?: number[];
    directorIds?: number[];
    collectionId?: number;
    year?: number;
  },
  loved: LovedItemFeatures
): LovedSimBreakdown {
  const genreSim = calculateGenreSim(cand.genre_ids || [], loved.genre_ids || []);
  const storySim = calculateStorySim(cand.tokens || [], loved.overviewTokens);
  const castSim = calculateCastSim(cand.castIds || [], loved.castIds || []);
  const atmosphereSim = calculateAtmosphereSim(
    cand.directorIds || [],
    loved.directorIds || [],
    cand.collectionId,
    loved.collectionId
  );
  const eraSim = calculateEraSim(cand.year, loved.year);

  // Ağırlıklar: Tür (%35), Hikâye (%25), Oyuncu (%15), Atmosfer (%15), Dönem (%10)
  const composite = clamp01(
    0.35 * genreSim +
    0.25 * storySim +
    0.15 * castSim +
    0.15 * atmosphereSim +
    0.10 * eraSim
  );

  return {
    matchedTitle: loved.title,
    matchedKey: loved.key,
    similarity: Math.round(composite * 1000) / 1000,
    genreSim: Math.round(genreSim * 1000) / 1000,
    storySim: Math.round(storySim * 1000) / 1000,
    castSim: Math.round(castSim * 1000) / 1000,
    atmosphereSim: Math.round(atmosphereSim * 1000) / 1000,
    eraSim: Math.round(eraSim * 1000) / 1000,
  };
}

/**
 * Bir adayı kullanıcının tüm sevilen yapımlarıyla karşılaştırıp en yüksek uyumlu yapımı
 * ve genel sevilen benzerlik puanını (lovedSimScore) hesaplar.
 */
export function computeLovedSimilarityScore(
  candidate: any,
  lovedItems: LovedItemFeatures[],
  precomputedTokens?: string[]
): LovedSimMatchResult {
  if (!lovedItems || lovedItems.length === 0) {
    return { score: 0.5, breakdown: null };
  }

  const rawGenres: number[] = Array.isArray(candidate.genre_ids)
    ? candidate.genre_ids.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
    : Array.isArray(candidate.genres)
    ? candidate.genres.map((g: any) => Number(typeof g === 'object' ? g?.id : g)).filter((n: number) => Number.isFinite(n) && n > 0)
    : [];

  const rawCast: any[] = Array.isArray(candidate.cast) ? candidate.cast : [];
  const castIds: number[] = rawCast
    .slice(0, 10)
    .map((c: any) => Number(c?.id))
    .filter((id: number) => Number.isFinite(id) && id > 0);

  const rawCrew: any[] = Array.isArray(candidate.crew) ? candidate.crew : [];
  const directorIds: number[] = rawCrew
    .filter((m: any) => m && (m.job === 'Director' || m.job === 'Creator'))
    .map((m: any) => Number(m.id))
    .filter((id: number) => Number.isFinite(id) && id > 0);
  if (candidate.director?.id && !directorIds.includes(Number(candidate.director.id))) {
    const dId = Number(candidate.director.id);
    if (Number.isFinite(dId) && dId > 0) directorIds.push(dId);
  }

  const dateStr = candidate.release_date || candidate.first_air_date;
  const year = typeof dateStr === 'string' && /^\d{4}/.test(dateStr)
    ? parseInt(dateStr.slice(0, 4), 10)
    : undefined;

  const collectionId = candidate.belongs_to_collection?.id
    ? Number(candidate.belongs_to_collection.id)
    : undefined;

  const tokens = Array.isArray(precomputedTokens)
    ? precomputedTokens
    : Array.isArray(candidate._extractedTokens)
    ? candidate._extractedTokens
    : typeof candidate.overview === 'string'
    ? candidate.overview.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
    : [];

  const candMeta = {
    genre_ids: rawGenres,
    tokens,
    castIds,
    directorIds,
    collectionId,
    year,
  };

  let bestMatch: LovedSimBreakdown | null = null;
  const allSimilarities: number[] = [];

  for (const loved of lovedItems) {
    const res = computeItemToItemLovedSim(candMeta, loved);
    allSimilarities.push(res.similarity);
    if (!bestMatch || res.similarity > bestMatch.similarity) {
      bestMatch = res;
    }
  }

  if (!bestMatch) {
    return { score: 0.5, breakdown: null };
  }

  // Çoklu sevilen yapım varsa, tepe benzerliği (%80) ile en iyi ilk 3'ün ortalamasını (%20) harmanla
  allSimilarities.sort((a, b) => b - a);
  const top3 = allSimilarities.slice(0, 3);
  const top3Avg = top3.reduce((s, v) => s + v, 0) / top3.length;
  const finalScore = lovedItems.length >= 2
    ? clamp01(0.80 * bestMatch.similarity + 0.20 * top3Avg)
    : bestMatch.similarity;

  return {
    score: clamp01(finalScore),
    breakdown: bestMatch,
  };
}

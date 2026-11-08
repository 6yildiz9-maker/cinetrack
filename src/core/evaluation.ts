import {
  RECOMMENDATION_WEIGHTS_V3,
  buildTasteProfileSummary,
  buildTasteProfileV3,
  canonicalizeMediaKey,
  computeTasteProfileSignature,
  computeWeightsSignature,
  isCandidateEligibleInPool,
  makeMediaKey,
  scoreCandidatesV3,
  selectBalancedRecommendations,
  updateTasteMapWithBatch,
  type PersistentTasteMapData,
  type Profile,
} from './cinetrack-core.ts';

export interface EvaluationBatchMetrics {
  batchIndex: number;
  selectedCount: number;
  movieCount: number;
  tvCount: number;
  ring0Count: number;
  ring1Count: number;
  ring2Count: number;
  uniqueGenresCount: number;
}

export interface RecommendationEvaluationReport {
  weightsSignature: string;
  batchesEvaluated: number;
  batchSize: number;
  targetType: 'all' | 'movie' | 'tv';
  /** Fraction of subsequent-batch items that repeated the immediately preceding batch (target: 0 when Ring 0/2 suffices). */
  ring1RepeatRate: number;
  /** Fraction of total slots filled by fresh Ring 0 candidates across all batches. */
  ring0Utilization: number;
  /** Normalized Shannon entropy of genres across recommended items in [0, 1]. */
  genreEntropy: number;
  /** Accuracy of movie/tv balance relative to 50/50 target when targetType === 'all' (1.0 = exact 50/50). */
  typeBalanceAccuracy: number;
  /** Cutoff used for Save@K and NDCG@K. */
  k: number;
  /**
   * Fraction of the top-K recommendations that appear in `groundTruthKeys` (temporal hold-out).
   * null when no ground truth is supplied, since the harness cannot invent labels.
   */
  saveAtK: number | null;
  /** Binary-gain NDCG@K against `groundTruthKeys`, averaged across batches. null without labels. */
  ndcgAtK: number | null;
  /** Mean self-information novelty in [0, 1] (1.0 = uniformly niche, 0.0 = uniformly popular). */
  novelty: number;
  /** Intra-list genre diversity in [0, 1] (1.0 = disjoint genre sets, 0.0 = identical). */
  diversity: number;
  batches: EvaluationBatchMetrics[];
}

export interface EvaluateEngineInput {
  profile: Profile;
  candidatePool: any[];
  batchesCount?: number;
  batchSize?: number;
  targetType?: 'all' | 'movie' | 'tv';
  initialTasteMap?: PersistentTasteMapData;
  /**
   * Keys of items the user actually saved after the evaluation window (temporal hold-out).
   * Both canonical (`movie:123`) and legacy (`movie-123`) forms are accepted.
   */
  groundTruthKeys?: string[];
  /** Cutoff for Save@K / NDCG@K; defaults to batchSize. */
  k?: number;
  /** Reference time forwarded to scoring; defaults to now. */
  now?: Date | number | string;
}

function resolveReferenceDate(now?: Date | number | string): Date {
  if (now instanceof Date && Number.isFinite(now.getTime())) return new Date(now.getTime());
  if (typeof now === 'number' || typeof now === 'string') {
    const parsed = new Date(now);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return new Date();
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function computeNovelty(pickedCandidates: any[], pool: any[]): number {
  if (pickedCandidates.length === 0 || pool.length === 0) return 0;
  let totalPopularity = 0;
  for (const item of pool) {
    totalPopularity += Math.max(0, Number(item?.popularity) || 0);
  }
  const smoothingDenominator = totalPopularity + pool.length;
  const maxSelfInformation = Math.log2(smoothingDenominator);
  if (!(maxSelfInformation > 0)) return 0;

  let sum = 0;
  for (const item of pickedCandidates) {
    const popularity = Math.max(0, Number(item?.popularity) || 0);
    const probability = (popularity + 1) / smoothingDenominator;
    const selfInformation = -Math.log2(probability);
    sum += Math.min(1, Math.max(0, selfInformation / maxSelfInformation));
  }
  return round3(sum / pickedCandidates.length);
}

function computeGenreDiversity(genreSets: number[][]): number {
  const sets = genreSets.filter((ids) => ids.length > 0);
  if (sets.length < 2) return 0;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const left = new Set(sets[i]);
      const right = new Set(sets[j]);
      let intersection = 0;
      for (const id of left) {
        if (right.has(id)) intersection += 1;
      }
      const union = left.size + right.size - intersection;
      if (union > 0) total += 1 - intersection / union;
      pairs += 1;
    }
  }
  return pairs > 0 ? round3(total / pairs) : 0;
}

function computeNdcgAtK(keys: string[], groundTruth: ReadonlySet<string>, k: number): number {
  const idealRelevant = Math.min(groundTruth.size, k);
  if (idealRelevant <= 0) return 0;
  let dcg = 0;
  const top = keys.slice(0, k);
  for (let i = 0; i < top.length; i += 1) {
    if (groundTruth.has(top[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  for (let i = 0; i < idealRelevant; i += 1) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? round3(dcg / idcg) : 0;
}

function computeNormalizedShannonEntropy(counts: Map<number, number>): number {
  const values = Array.from(counts.values()).filter((v) => v > 0);
  if (values.length <= 1) return 0;
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return 0;

  let entropy = 0;
  for (const count of values) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(values.length);
  return maxEntropy > 0 ? Math.round((entropy / maxEntropy) * 1000) / 1000 : 0;
}

/**
 * Deterministic offline evaluation harness for Cinethos's recommendation engine (Faz 10).
 * Simulates sequential recommendation batches without mutating global browser storage.
 */
export function evaluateRecommendationEngine(input: EvaluateEngineInput): RecommendationEvaluationReport {
  const batchesCount = Math.max(1, input.batchesCount ?? 3);
  const batchSize = Math.max(2, input.batchSize ?? 12);
  const targetType = input.targetType ?? 'all';
  const referenceDate = resolveReferenceDate(input.now);
  const k = Math.max(1, input.k ?? batchSize);
  const profile = input.profile;
  const savedItems = profile.items || [];
  const preferences = profile.preferences || {
    disliked: [],
    hidden: [],
    providers: [],
    mood: '',
    reminders: false,
    notified: [],
  };
  const favoriteActors = profile.favoriteActors || [];
  const groundTruth = new Set<string>(
    (input.groundTruthKeys || []).map((key) => canonicalizeMediaKey(key))
  );

  let currentMap: PersistentTasteMapData = input.initialTasteMap
    ? JSON.parse(JSON.stringify(input.initialTasteMap))
    : {
        profileId: profile.id,
        updatedAt: referenceDate.toISOString(),
        entries: {},
        archivedEntries: {},
        lastRecommendedKeys: [],
        lastBatchTimestamp: null,
      };

  const tasteProfile = buildTasteProfileV3(savedItems, {
    lambda: 1,
    dislikedKeys: preferences.disliked || [],
  });
  const profileSig = computeTasteProfileSignature(savedItems, preferences, favoriteActors, { targetType });

  const eligiblePool = (input.candidatePool || []).filter((c) =>
    isCandidateEligibleInPool(c, savedItems, preferences)
  );
  const moviePool = eligiblePool.filter((c) => c.media_type !== 'tv');
  const tvPool = eligiblePool.filter((c) => c.media_type === 'tv');

  const batchReports: EvaluationBatchMetrics[] = [];
  const genreHistogram = new Map<number, number>();
  let totalSlots = 0;
  let totalRing0 = 0;
  let subsequentSlots = 0;
  let subsequentRing1Repeats = 0;
  let totalMovies = 0;
  let totalTvs = 0;
  const pickedCandidates: any[] = [];
  const batchDiversities: number[] = [];
  let saveAtKSum = 0;
  let ndcgAtKSum = 0;
  let rankedBatches = 0;

  for (let b = 0; b < batchesCount; b += 1) {
    const prevBatchKeys = new Set(currentMap.lastRecommendedKeys || []);

    const scoredMoviesAll = scoreCandidatesV3(moviePool, tasteProfile, {
      weights: RECOMMENDATION_WEIGHTS_V3,
      mood: preferences.mood,
      tasteMap: currentMap,
      now: referenceDate,
    }).sort((a, z) => z.score - a.score);

    const scoredTvAll = scoreCandidatesV3(tvPool, tasteProfile, {
      weights: RECOMMENDATION_WEIGHTS_V3,
      mood: preferences.mood,
      tasteMap: currentMap,
      now: referenceDate,
    }).sort((a, z) => z.score - a.score);

    const nonRing1Movies = scoredMoviesAll.filter((e) => e.ring !== 'ring1');
    const ring1Movies = scoredMoviesAll.filter((e) => e.ring === 'ring1');
    const nonRing1Tv = scoredTvAll.filter((e) => e.ring !== 'ring1');
    const ring1Tv = scoredTvAll.filter((e) => e.ring === 'ring1');

    const balanced = selectBalancedRecommendations({
      targetType,
      scoredMovies: nonRing1Movies,
      scoredTv: nonRing1Tv,
      remainingMovies: ring1Movies,
      remainingTv: ring1Tv,
      targetTotal: batchSize,
      minPerTypeInAll: Math.floor(batchSize / 2),
    });

    const picked = balanced.items || [];
    let movieCount = 0;
    let tvCount = 0;
    let ring0Count = 0;
    let ring1Count = 0;
    let ring2Count = 0;
    const batchGenres = new Set<number>();
    const batchGenreSets: number[][] = [];
    const batchKeys: string[] = [];

    for (const entry of picked) {
      const cand = entry.candidate || entry;
      const key = canonicalizeMediaKey(makeMediaKey(cand));
      const isTv = cand.media_type === 'tv';
      if (isTv) tvCount += 1;
      else movieCount += 1;

      pickedCandidates.push(cand);
      batchKeys.push(key);
      const genreIds = (cand.genre_ids || []).filter(
        (gid: unknown): gid is number => typeof gid === 'number' && gid > 0
      );
      batchGenreSets.push(genreIds);

      const wasInPrevBatch = prevBatchKeys.has(key);
      const existingEntry = currentMap.entries?.[key];
      const wasShownBefore =
        Boolean(existingEntry) &&
        ((existingEntry.shownCount ?? 0) > 0 || (existingEntry.skippedCount ?? 0) > 0 || Boolean(existingEntry.lastShownAt));

      if (wasInPrevBatch) {
        ring1Count += 1;
        if (b > 0) subsequentRing1Repeats += 1;
      } else if (wasShownBefore) {
        ring2Count += 1;
      } else {
        ring0Count += 1;
      }

      if (b > 0) {
        subsequentSlots += 1;
      }

      for (const gid of genreIds) {
        batchGenres.add(gid);
        genreHistogram.set(gid, (genreHistogram.get(gid) || 0) + 1);
      }
    }

    totalSlots += picked.length;
    totalRing0 += ring0Count;
    totalMovies += movieCount;
    totalTvs += tvCount;
    batchDiversities.push(computeGenreDiversity(batchGenreSets));

    if (groundTruth.size > 0 && batchKeys.length > 0) {
      const topK = batchKeys.slice(0, k);
      let hits = 0;
      for (const key of topK) {
        if (groundTruth.has(key)) hits += 1;
      }
      saveAtKSum += hits / k;
      ndcgAtKSum += computeNdcgAtK(batchKeys, groundTruth, k);
      rankedBatches += 1;
    }

    batchReports.push({
      batchIndex: b + 1,
      selectedCount: picked.length,
      movieCount,
      tvCount,
      ring0Count,
      ring1Count,
      ring2Count,
      uniqueGenresCount: batchGenres.size,
    });

    const summary = buildTasteProfileSummary(tasteProfile, currentMap, {});
    currentMap = updateTasteMapWithBatch({
      tasteMap: currentMap,
      newRecommendedItems: picked,
      allPoolCandidates: [...scoredMoviesAll, ...scoredTvAll],
      savedItems,
      preferences,
      favoriteActors,
      now: referenceDate.toISOString(),
      profileSignature: profileSig,
      targetType,
      explanation: balanced.explanation,
      summary,
      isFilterChange: false,
      normalizeLegacyRings: true,
    });
  }

  const ring1RepeatRate =
    subsequentSlots > 0 ? Math.round((subsequentRing1Repeats / subsequentSlots) * 1000) / 1000 : 0;
  const ring0Utilization = totalSlots > 0 ? Math.round((totalRing0 / totalSlots) * 1000) / 1000 : 0;
  const genreEntropy = computeNormalizedShannonEntropy(genreHistogram);
  const novelty = computeNovelty(pickedCandidates, eligiblePool);
  const diversity =
    batchDiversities.length > 0
      ? round3(batchDiversities.reduce((sum, value) => sum + value, 0) / batchDiversities.length)
      : 0;
  const saveAtK = rankedBatches > 0 ? round3(saveAtKSum / rankedBatches) : null;
  const ndcgAtK = rankedBatches > 0 ? round3(ndcgAtKSum / rankedBatches) : null;

  let typeBalanceAccuracy = 1;
  if (targetType === 'all' && totalSlots > 0) {
    const movieShare = totalMovies / totalSlots;
    typeBalanceAccuracy = Math.max(0, Math.round((1 - Math.abs(0.5 - movieShare) * 2) * 1000) / 1000);
  } else if (targetType === 'movie' && totalSlots > 0) {
    typeBalanceAccuracy = Math.round((totalMovies / totalSlots) * 1000) / 1000;
  } else if (targetType === 'tv' && totalSlots > 0) {
    typeBalanceAccuracy = Math.round((totalTvs / totalSlots) * 1000) / 1000;
  }

  return {
    weightsSignature: computeWeightsSignature(),
    batchesEvaluated: batchesCount,
    batchSize,
    targetType,
    ring1RepeatRate,
    ring0Utilization,
    genreEntropy,
    typeBalanceAccuracy,
    k,
    saveAtK,
    ndcgAtK,
    novelty,
    diversity,
    batches: batchReports,
  };
}

// ===========================================================================
// Faz 6 — Taste Archaeology değerlendirme metrikleri
// ===========================================================================

/**
 * Taste Archaeology Spearman ρ (TP-036)
 * Test setindeki tasteFit skoru ile gerçek puan arasındaki sıra korelasyonu.
 * null = yetersiz veri (Faz 0 bulgusu: tüm geçmiş imported)
 */
export type TasteArchaeologySpearman = number | null;

/**
 * Taste metrik kapsam oranı
 * (Profilde "unknown" olmayan metrik sayısı / toplam aktif metrik sayısı)
 * Kapsam > 0.5 → güvenilir profil
 */
export function tasteCoverage(
  profileMetrics: Record<string, { status: string }>,
  totalActiveMetrics: number
): number {
  if (totalActiveMetrics <= 0) return 0;
  const known = Object.values(profileMetrics).filter(
    (m) => m.status !== "unknown"
  ).length;
  return Math.round((known / totalActiveMetrics) * 1000) / 1000;
}

/**
 * Taste metrik "unknown" oranı
 * Yüksek unknown oranı → feature extractor veya event coverage eksik
 */
export function tasteUnknownRate(
  profileMetrics: Record<string, { status: string }>,
  totalActiveMetrics: number
): number {
  if (totalActiveMetrics <= 0) return 1;
  const unknown = Object.values(profileMetrics).filter(
    (m) => m.status === "unknown"
  ).length;
  return Math.round((unknown / totalActiveMetrics) * 1000) / 1000;
}

import {
  RECOMMENDATION_WEIGHTS_V3,
  buildTasteProfileSummary,
  buildTasteProfileV3,
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
  batches: EvaluationBatchMetrics[];
}

export interface EvaluateEngineInput {
  profile: Profile;
  candidatePool: any[];
  batchesCount?: number;
  batchSize?: number;
  targetType?: 'all' | 'movie' | 'tv';
  initialTasteMap?: PersistentTasteMapData;
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
 * Deterministic offline evaluation harness for CineTrack's recommendation engine (Faz 10).
 * Simulates sequential recommendation batches without mutating global browser storage.
 */
export function evaluateRecommendationEngine(input: EvaluateEngineInput): RecommendationEvaluationReport {
  const batchesCount = Math.max(1, input.batchesCount ?? 3);
  const batchSize = Math.max(2, input.batchSize ?? 12);
  const targetType = input.targetType ?? 'all';
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

  let currentMap: PersistentTasteMapData = input.initialTasteMap
    ? JSON.parse(JSON.stringify(input.initialTasteMap))
    : {
        profileId: profile.id,
        updatedAt: new Date().toISOString(),
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

  for (let b = 0; b < batchesCount; b += 1) {
    const prevBatchKeys = new Set(currentMap.lastRecommendedKeys || []);

    const scoredMoviesAll = scoreCandidatesV3(moviePool, tasteProfile, {
      weights: RECOMMENDATION_WEIGHTS_V3,
      mood: preferences.mood,
      tasteMap: currentMap,
    }).sort((a, z) => z.score - a.score);

    const scoredTvAll = scoreCandidatesV3(tvPool, tasteProfile, {
      weights: RECOMMENDATION_WEIGHTS_V3,
      mood: preferences.mood,
      tasteMap: currentMap,
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

    for (const entry of picked) {
      const cand = entry.candidate || entry;
      const key = makeMediaKey(cand);
      const isTv = cand.media_type === 'tv';
      if (isTv) tvCount += 1;
      else movieCount += 1;

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

      for (const gid of cand.genre_ids || []) {
        if (typeof gid === 'number' && gid > 0) {
          batchGenres.add(gid);
          genreHistogram.set(gid, (genreHistogram.get(gid) || 0) + 1);
        }
      }
    }

    totalSlots += picked.length;
    totalRing0 += ring0Count;
    totalMovies += movieCount;
    totalTvs += tvCount;

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
    batches: batchReports,
  };
}

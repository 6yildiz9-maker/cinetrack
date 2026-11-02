// ===========================================================================
// CineTrack Taste Engine — Taste Archaeology (v1.0)
// Zaman sıralı holdout, Spearman ρ, taban karşılaştırma (TP-036, §13.2)
//
// KRİTİK: ratedAt/watchedAt yoksa (Faz 0 bulgusu), zaman sıralı ayrım yapılamaz.
// Bu durumda sonuç "insufficient_data" olur, başarısız değil.
// ===========================================================================

import type { TasteEvent, TasteProfile, ContentTasteItem } from "./types";
import { aggregateProfiles } from "./profile-aggregator";

export interface ArchaeologyResult {
  spearmanRho: number | null;          // null = yetersiz veri
  confidenceInterval?: [number, number]; // bootstrap %95 CI
  testSampleSize: number;
  baselineResults: {
    genreOnly: number | null;
    voteAverage: number | null;
    currentMethod: number | null;
  };
  shadowMetrics?: {
    baseRate: number | null;
    centeredRating: number | null;
  };
  status: "pass" | "fail" | "insufficient_data";
  warnings: string[];
  completedAt: string;
}

export interface ArchaeologyOptions {
  trainRatio?: number;           // varsayılan 0.80
  minTestSize?: number;          // varsayılan 30
  asOf: string;
  includeShadowMetrics?: boolean; // TP-023: gölge metrikler
}

/**
 * Taste Archaeology: Geçmişe dönük doğruluk testi
 *
 * KRİTİK: ratedAt/watchedAt yoksa (Faz 0 bulgusu), zaman sıralı ayrım yapılamaz.
 * Bu durumda sonuç "insufficient_data" olur, başarısız değil.
 */
export async function runTasteArchaeology(
  events: TasteEvent[],
  contentIndex: Record<string, ContentTasteItem>,
  options: ArchaeologyOptions
): Promise<ArchaeologyResult> {
  const {
    trainRatio = 0.80,
    minTestSize = 30,
    asOf,
    includeShadowMetrics = false,
  } = options;
  const warnings: string[] = [];

  // 1. Sadece rating_changed olaylarını al (TP-036: test puanları)
  const ratingEvents = events.filter((e) => e.eventType === "rating_changed");

  // 2. Zaman sıralı ayrım yapabilir miyiz?
  // Faz 0 bulgusu: tüm migration olayları imported → zaman sıralı ayrım yapılamaz
  const hasActualTimeSource = ratingEvents.some((e) => e.timeSource === "actual");
  if (!hasActualTimeSource) {
    warnings.push(
      "Tüm olaylar timeSource: imported — zaman sıralı ayrım yapılamaz"
    );
    return {
      spearmanRho: null,
      testSampleSize: 0,
      baselineResults: {
        genreOnly: null,
        voteAverage: null,
        currentMethod: null,
      },
      status: "insufficient_data",
      warnings,
      completedAt: asOf,
    };
  }

  // 3. Zaman sıralı sırala (actual olanları önce dene)
  const sorted = [...ratingEvents].sort(
    (a, b) =>
      new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime()
  );

  // 4. %80/%20 böl
  const splitIndex = Math.floor(sorted.length * trainRatio);
  const trainEvents = sorted.slice(0, splitIndex);
  const testEvents = sorted.slice(splitIndex);

  if (testEvents.length < minTestSize) {
    warnings.push(
      `Test seti çok küçük: ${testEvents.length} < ${minTestSize}`
    );
    return {
      spearmanRho: null,
      testSampleSize: testEvents.length,
      baselineResults: {
        genreOnly: null,
        voteAverage: null,
        currentMethod: null,
      },
      status: "insufficient_data",
      warnings,
      completedAt: asOf,
    };
  }

  // 5. Eğitim setinden profil çıkar
  const profiles = aggregateProfiles(trainEvents, asOf, contentIndex);
  const unifiedProfile = profiles.unified;

  // 6. Test seti için uyum skoru hesapla
  const testScores = testEvents.map((event) => {
    const contentItem = contentIndex[event.contentId];
    if (!contentItem) {
      return { contentId: event.contentId, tasteFit: 0, actualRating: 0 };
    }

    // Basit uyum skoru: içeriğin özellikleri × profil afinite
    let tasteFit = 0;
    let featureCount = 0;

    for (const [metricId, feature] of Object.entries(contentItem.features)) {
      const profileMetric = unifiedProfile.metrics[metricId];
      if (profileMetric && profileMetric.status !== "unknown") {
        tasteFit +=
          (feature.strength / 100) *
          feature.confidence *
          (profileMetric.affinity / 100);
        featureCount++;
      }
    }

    if (featureCount > 0) {
      tasteFit /= featureCount;
    }

    const actualRating = event.payload.newValue as number;
    return { contentId: event.contentId, tasteFit, actualRating };
  });

  // 7. Spearman korelasyonu hesapla
  const spearmanRho = computeSpearmanCorrelation(
    testScores.map((s) => s.tasteFit),
    testScores.map((s) => s.actualRating)
  );

  // 8. Taban yöntemler (en az 3 taban — §13.2 kuralı)
  const baselineResults = {
    genreOnly: computeGenreOnlyBaseline(
      testEvents,
      contentIndex,
      unifiedProfile
    ),
    voteAverage: computeVoteAverageBaseline(testEvents),
    currentMethod: computeCurrentMethodBaseline(testEvents),
  };

  // 9. Gölge metrikler (TP-023)
  let shadowMetrics: ArchaeologyResult["shadowMetrics"] | undefined;
  if (includeShadowMetrics) {
    shadowMetrics = {
      baseRate: computeBaseRateMetric(testEvents, contentIndex),
      centeredRating: computeCenteredRatingMetric(testEvents),
    };
  }

  // 10. Durum belirle
  const status =
    spearmanRho !== null && spearmanRho > 0.3 ? "pass" : "fail";

  return {
    spearmanRho,
    confidenceInterval: computeBootstrapCI(testScores, 1000),
    testSampleSize: testEvents.length,
    baselineResults,
    shadowMetrics,
    status,
    warnings,
    completedAt: asOf,
  };
}

// === İstatistik Yardımcıları ===

/** Spearman sıra korelasyonu */
function computeSpearmanCorrelation(
  x: number[],
  y: number[]
): number | null {
  if (x.length !== y.length || x.length < 2) return null;
  const n = x.length;
  const rankX = computeRanks(x);
  const rankY = computeRanks(y);

  let sumDiffSq = 0;
  for (let i = 0; i < n; i++) {
    const diff = rankX[i] - rankY[i];
    sumDiffSq += diff * diff;
  }
  return 1 - (6 * sumDiffSq) / (n * (n * n - 1));
}

function computeRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ value: v, index: i }));
  indexed.sort((a, b) => a.value - b.value);
  const ranks = new Array(values.length);
  for (let i = 0; i < indexed.length; i++) {
    ranks[indexed[i].index] = i + 1;
  }
  return ranks;
}

/** Bootstrap güven aralığı (%95) */
function computeBootstrapCI(
  testScores: Array<{ tasteFit: number; actualRating: number }>,
  iterations: number
): [number, number] | undefined {
  if (testScores.length < 2) return undefined;
  const rhos: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample = testScores.map(
      () => testScores[Math.floor(Math.random() * testScores.length)]
    );
    const rho = computeSpearmanCorrelation(
      sample.map((s) => s.tasteFit),
      sample.map((s) => s.actualRating)
    );
    if (rho !== null) {
      rhos.push(rho);
    }
  }
  if (rhos.length === 0) return undefined;
  rhos.sort((a, b) => a - b);
  const lower = rhos[Math.floor(rhos.length * 0.025)];
  const upper = rhos[Math.floor(rhos.length * 0.975)];
  return [lower, upper];
}

// === Taban Yöntemler ===

/** Taban 1: sadece tür eşleşmesi */
function computeGenreOnlyBaseline(
  testEvents: TasteEvent[],
  contentIndex: Record<string, ContentTasteItem>,
  profile: TasteProfile
): number | null {
  const scores = testEvents.map((event) => {
    const contentItem = contentIndex[event.contentId];
    if (!contentItem) return 0;

    let genreFit = 0;
    let genreCount = 0;

    for (const [metricId, feature] of Object.entries(contentItem.features)) {
      if (metricId.startsWith("genre.")) {
        const profileMetric = profile.metrics[metricId];
        if (profileMetric && profileMetric.status !== "unknown") {
          genreFit +=
            (feature.strength / 100) * (profileMetric.affinity / 100);
          genreCount++;
        }
      }
    }
    return genreCount > 0 ? genreFit / genreCount : 0;
  });

  const actualRatings = testEvents.map((e) => e.payload.newValue as number);
  return computeSpearmanCorrelation(scores, actualRatings);
}

/** Taban 2: TMDB vote_average */
function computeVoteAverageBaseline(
  _testEvents: TasteEvent[]
): number | null {
  // V1'de placeholder: vote_average verisi contentIndex'te yok
  // Gerçek implementasyonda TMDB catalog'dan alınır
  return null;
}

/** Taban 3: mevcut öneri yöntemi */
function computeCurrentMethodBaseline(
  _testEvents: TasteEvent[]
): number | null {
  // V1'de placeholder: mevcut recommendation-orchestrator çağrılır
  return null;
}

// === Gölge Metrikler ===

/** Gölge metrik: baz oran (TP-023) */
function computeBaseRateMetric(
  _testEvents: TasteEvent[],
  _contentIndex: Record<string, ContentTasteItem>
): number | null {
  // V1'de placeholder: metriğin sevilen içeriklerdeki oranı / tüm geçmişteki oranı
  return null;
}

/** Gölge metrik: merkezlenmiş puan (TP-023) */
function computeCenteredRatingMetric(testEvents: TasteEvent[]): number | null {
  if (testEvents.length < 2) return null;
  const ratings = testEvents.map((e) => e.payload.newValue as number);
  const mean = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  const centered = ratings.map((r) => r - mean);
  // Basit korelasyon: merkezlenmiş puan ile zaman indeksi
  const timeIndices = ratings.map((_, i) => i);
  return computeSpearmanCorrelation(centered, timeIndices);
}

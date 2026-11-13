// ===========================================================================
// Cinethos Taste Engine — Taste Archaeology (v1.1)
// Zaman sıralı holdout, tie-aware Spearman ρ, taban karşılaştırma (TP-036, §13.2)
//
// KRİTİK: ratedAt/watchedAt yoksa (Faz 0 bulgusu), zaman sıralı ayrım yapılamaz.
// Bu durumda sonuç "insufficient_data" olur, başarısız değil.
//
// v1.1 düzeltmeleri:
// - Holdout yalnızca timeSource: "actual" olaylarla kurulur; imported olaylar
//   gerçek zaman sırasına karışmaz.
// - Eşit puanlar ortalama sıra (average rank) alır; Spearman, sıraların
//   Pearson korelasyonu olarak hesaplanır (bağlı sıralarda 6Σd² formülü geçersiz).
// - Tüm gözlemler aynı değeri taşıyorsa korelasyon null döner (yapay sıralama yok).
// - Özellik verisi olmayan içerikler 0 puanla cezalandırılmaz, değerlendirme
//   dışı bırakılır ve rapora eksik veri olarak yazılır.
// ===========================================================================

import type { TasteEvent, TasteProfile, ContentTasteItem } from "./types.ts";
import { aggregateProfiles } from "./profile-aggregator.ts";

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

  // 2. Holdout yalnızca gerçek zaman kaynağı olan olaylarla kurulur (TP-029).
  //    Imported olayların gerçek tarihi bilinmediği için zaman sırasına katılmaz.
  const actualTimeEvents = ratingEvents.filter((e) => e.timeSource === "actual");
  const excludedImported = ratingEvents.length - actualTimeEvents.length;
  if (excludedImported > 0) {
    warnings.push(
      `${excludedImported} imported olay gerçek zaman sırası bilinmediği için holdout dışı bırakıldı`
    );
  }

  if (actualTimeEvents.length === 0) {
    warnings.push(
      "Tüm olaylar timeSource: imported — zaman sıralı ayrım yapılamaz"
    );
    return insufficient(asOf, warnings, 0);
  }

  // 3. Zaman sıralı sırala
  const sorted = [...actualTimeEvents].sort(
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
    return insufficient(asOf, warnings, testEvents.length);
  }

  // 5. Eğitim setinden profil çıkar
  const profiles = aggregateProfiles(trainEvents, asOf, contentIndex);
  const unifiedProfile = profiles.unified;

  // 6. Test seti için uyum skoru hesapla.
  //    Özellik verisi olmayan içerikler 0 verilerek cezalandırılmaz; değerlendirme
  //    dışı bırakılır (eksik veri ≠ kötü uyum).
  let missingFeatureCount = 0;
  const testScores: Array<{
    contentId: string;
    tasteFit: number;
    actualRating: number;
  }> = [];

  for (const event of testEvents) {
    const contentItem = contentIndex[event.contentId];
    if (!contentItem) {
      missingFeatureCount++;
      continue;
    }

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

    if (featureCount === 0) {
      missingFeatureCount++;
      continue;
    }

    const actualRating = Number(event.payload.newValue);
    if (!Number.isFinite(actualRating)) {
      missingFeatureCount++;
      continue;
    }

    testScores.push({
      contentId: event.contentId,
      tasteFit: tasteFit / featureCount,
      actualRating,
    });
  }

  if (missingFeatureCount > 0) {
    warnings.push(
      `${missingFeatureCount} test olayı eksik özellik/puan verisi nedeniyle değerlendirme dışı bırakıldı`
    );
  }

  const evaluatedEvents = testEvents.filter((event) =>
    testScores.some((score) => score.contentId === event.contentId)
  );

  if (testScores.length < 2) {
    warnings.push("Değerlendirilebilir test örneği 2'den az");
    return insufficient(asOf, warnings, testScores.length);
  }

  // 7. Spearman korelasyonu hesapla (tie-aware)
  const spearmanRho = computeSpearmanCorrelation(
    testScores.map((s) => s.tasteFit),
    testScores.map((s) => s.actualRating)
  );

  if (spearmanRho === null) {
    warnings.push(
      "Test puanlarının tamamı aynı — sıralama korelasyonu tanımsız"
    );
  }

  // 8. Taban yöntemler (en az 3 taban — §13.2 kuralı)
  const baselineResults = {
    genreOnly: computeGenreOnlyBaseline(
      evaluatedEvents,
      contentIndex,
      unifiedProfile
    ),
    voteAverage: computeVoteAverageBaseline(evaluatedEvents, contentIndex, warnings),
    currentMethod: computeCurrentMethodBaseline(evaluatedEvents, contentIndex, warnings),
  };

  // 9. Gölge metrikler (TP-023)
  let shadowMetrics: ArchaeologyResult["shadowMetrics"] | undefined;
  if (includeShadowMetrics) {
    shadowMetrics = {
      baseRate: computeBaseRateMetric(evaluatedEvents),
      centeredRating: computeCenteredRatingMetric(evaluatedEvents),
    };
  }

  // 10. Durum belirle
  const status: ArchaeologyResult["status"] =
    spearmanRho === null
      ? "insufficient_data"
      : spearmanRho > 0.3
      ? "pass"
      : "fail";

  return {
    spearmanRho,
    confidenceInterval: computeBootstrapCI(testScores, 1000),
    testSampleSize: testScores.length,
    baselineResults,
    shadowMetrics,
    status,
    warnings,
    completedAt: asOf,
  };
}

function insufficient(
  asOf: string,
  warnings: string[],
  testSampleSize: number
): ArchaeologyResult {
  return {
    spearmanRho: null,
    testSampleSize,
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

// === İstatistik Yardımcıları ===

/**
 * Spearman sıra korelasyonu.
 * Sıralar tie-aware ortalama sıralardır ve korelasyon sıraların Pearson
 * katsayısı olarak hesaplanır; 6Σd² kısayolu bağlı (tie) sıralarda geçersizdir.
 * Tüm değerler eşitse (varyans 0) null döner.
 */
export function computeSpearmanCorrelation(
  x: number[],
  y: number[]
): number | null {
  if (x.length !== y.length || x.length < 2) return null;
  const rankX = computeRanks(x);
  const rankY = computeRanks(y);
  return computePearson(rankX, rankY);
}

/** Eşit değerlere ortalama sıra atayan 1-tabanlı sıralama. */
export function computeRanks(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);

  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) {
      j++;
    }
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      ranks[indexed[k].index] = averageRank;
    }
    i = j + 1;
  }
  return ranks;
}

function computePearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 2 || b.length !== n) return null;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;

  let numerator = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    numerator += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return numerator / Math.sqrt(varA * varB);
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
  const scores: number[] = [];
  const ratings: number[] = [];

  for (const event of testEvents) {
    const contentItem = contentIndex[event.contentId];
    if (!contentItem) continue;

    let genreFit = 0;
    let genreCount = 0;

    for (const [metricId, feature] of Object.entries(contentItem.features)) {
      if (metricId.startsWith("genre.")) {
        const profileMetric = profile.metrics[metricId];
        if (profileMetric && profileMetric.status !== "unknown") {
          genreFit += (feature.strength / 100) * (profileMetric.affinity / 100);
          genreCount++;
        }
      }
    }

    const actualRating = Number(event.payload.newValue);
    if (genreCount === 0 || !Number.isFinite(actualRating)) continue;

    scores.push(genreFit / genreCount);
    ratings.push(actualRating);
  }

  return computeSpearmanCorrelation(scores, ratings);
}

/**
 * Taban 2: TMDB vote_average.
 * ContentTasteItem şeması vote_average taşımadığı için bu taban şimdilik
 * hesaplanamaz; durum sessizce yutulmaz, rapora uyarı olarak yazılır.
 */
function computeVoteAverageBaseline(
  _testEvents: TasteEvent[],
  _contentIndex: Record<string, ContentTasteItem>,
  warnings: string[]
): number | null {
  warnings.push(
    "vote_average tabanı hesaplanamadı: içerik indeksinde TMDB oy ortalaması yok"
  );
  return null;
}

/**
 * Taban 3: mevcut öneri yöntemi.
 * Üretim motoru (scoreCandidatesV3) aday havuzu + profil imzası gerektirdiği ve
 * bu modül yalnızca olay/indeks verisi aldığı için burada çağrılamaz; ana
 * spearmanRho zaten mevcut yöntemin uyum skorunu ölçer.
 */
function computeCurrentMethodBaseline(
  _testEvents: TasteEvent[],
  _contentIndex: Record<string, ContentTasteItem>,
  warnings: string[]
): number | null {
  warnings.push(
    "currentMethod tabanı ayrıca hesaplanmadı: ana spearmanRho mevcut uyum skorunu ölçer"
  );
  return null;
}

// === Gölge Metrikler ===

/**
 * Gölge metrik: baz oran (TP-023).
 * Test setindeki olumlu puan (>= 7) oranı. 0.5 nötr tabandan farkı, modelin
 * gerçekten ayırt edici olup olmadığını gösterir.
 */
function computeBaseRateMetric(testEvents: TasteEvent[]): number | null {
  const ratings = testEvents
    .map((event) => Number(event.payload.newValue))
    .filter((value) => Number.isFinite(value));
  if (ratings.length === 0) return null;
  const positives = ratings.filter((value) => value >= 7).length;
  return Math.round((positives / ratings.length) * 1000) / 1000;
}

/** Gölge metrik: merkezlenmiş puan (TP-023) */
function computeCenteredRatingMetric(testEvents: TasteEvent[]): number | null {
  if (testEvents.length < 2) return null;
  const ratings = testEvents.map((e) => Number(e.payload.newValue));
  if (ratings.some((r) => !Number.isFinite(r))) return null;
  const mean = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  const centered = ratings.map((r) => r - mean);
  // Basit korelasyon: merkezlenmiş puan ile zaman indeksi
  const timeIndices = ratings.map((_, i) => i);
  return computeSpearmanCorrelation(centered, timeIndices);
}

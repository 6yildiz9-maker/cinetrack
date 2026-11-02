// ===========================================================================
// CineTrack Taste Engine — Recommendation Adapter (v1.0)
// Tek dar arayüz: suggestFor(candidates, mediaType) (TP-001, TP-037)
//
// KRİTİK:
// 1. Orchestrator iç yapısına erişmez
// 2. Eksik özellik ceza değil (kalan geçerlilerde normalizasyon)
// 3. Gizli/izlenmiş filtreleri mevcut sistemde kalır
// 4. Gölge modda sıralama değişmez, sadece loglanır (TP-037)
// ===========================================================================

import type { TasteProfile, ContentTasteItem } from "./types";
import { RECOMMENDATION_WEIGHTS } from "./constants";
import { resolveEffectiveMetricView } from "./metric-labels";

export interface RecommendationCandidate {
  contentId: string;
  mediaType: "movie" | "tv";
  genreIds?: number[];
  voteAverage?: number;
  // Mevcut orchestrator'dan gelen diğer alanlar
}

export interface TasteFitResult {
  contentId: string;
  tasteFit: number;          // 0-100
  confidence: "low" | "medium" | "high";
  reasonIds: string[];       // en etkili 2-3 metrik
  vetoed: boolean;           // yüksek güvenli olumsuz eşleşme (TP-034)
}

export interface RecommendationAdapter {
  suggestFor(
    candidates: RecommendationCandidate[],
    mediaType: "movie" | "tv",
    profile: TasteProfile,
    contentIndex: Record<string, ContentTasteItem>
  ): TasteFitResult[];
}

/** Gölge mod logu — production'da console.debug, test'te bastırılabilir */
let _shadowLogger: ((msg: string, data: unknown) => void) | null = null;

export function setShadowLogger(
  logger: ((msg: string, data: unknown) => void) | null
) {
  _shadowLogger = logger;
}

function logShadow(msg: string, data: unknown) {
  if (_shadowLogger) {
    _shadowLogger(msg, data);
  }
  // Default: silent (gölge modda gerçek çıktı etkilenmemeli)
}

/**
 * Recommendation Adapter: Mevcut öneri motoruna dar arayüz
 *
 * Gölge modda: `suggestFor` tasteFit skorlarını hesaplar ve loglar,
 * ancak bu değerler mevcut orchestrator'ın sıralamasını DEĞİŞTİRMEZ.
 * Orijinal `candidates` sırası korunur (TP-037).
 */
export function createRecommendationAdapter(): RecommendationAdapter {
  return {
    suggestFor(candidates, mediaType, profile, contentIndex) {
      const results: TasteFitResult[] = candidates.map((candidate) => {
        const contentItem = contentIndex[candidate.contentId];

        if (!contentItem) {
          return {
            contentId: candidate.contentId,
            tasteFit: 0,
            confidence: "low" as const,
            reasonIds: [],
            vetoed: false,
          };
        }

        // 1. Kategori bazlı uyum hesapla
        const categoryScores: Record<string, number> = {};
        const categoryWeights: Record<string, number> = {};

        for (const [metricId, feature] of Object.entries(contentItem.features)) {
          const profileMetric = profile.metrics[metricId];
          const view = resolveEffectiveMetricView(profileMetric);
          if (!profileMetric || view.isExcluded || view.effectiveStatus === "unknown") {
            continue;
          }

          // Kategori belirle
          const categoryId = metricId.split(".")[0];
          const weight = getCategoryWeight(categoryId);

          if (!categoryScores[categoryId]) {
            categoryScores[categoryId] = 0;
            categoryWeights[categoryId] = 0;
          }

          // Uyum: özellik gücü × güven × efektif profil afinite (0-1 normalize)
          const fit =
            (feature.strength / 100) *
            feature.confidence *
            ((view.effectiveAffinity + 100) / 200);
          categoryScores[categoryId] += fit;
          categoryWeights[categoryId] += weight;
        }

        // 2. Normalize: eksik veri ceza değil (kalan geçerlilerde normalizasyon)
        let totalFit = 0;
        let totalWeight = 0;
        const featureCount = Object.keys(contentItem.features).length;

        for (const [categoryId, score] of Object.entries(categoryScores)) {
          const weight = categoryWeights[categoryId];
          if (weight > 0 && featureCount > 0) {
            totalFit += (score / featureCount) * weight;
            totalWeight += weight;
          }
        }

        const normalizedFit = totalWeight > 0 ? totalFit / totalWeight : 0;
        const tasteFit = Math.round(normalizedFit * 100);

        // 3. Güven belirle (TP-025)
        const confidence = determineConfidence(profile, contentItem);

        // 4. Veto kontrolü (TP-034)
        const vetoed = checkVeto(profile, contentItem);

        // 5. En etkili metrikleri bul
        const reasonIds = findTopMetrics(contentItem, profile, 3);

        return {
          contentId: candidate.contentId,
          tasteFit,
          confidence,
          reasonIds,
          vetoed,
        };
      });

      // Gölge mod: log yaz, sıralama DEĞİŞTİRME (TP-037)
      logShadow("[taste-adapter] suggestFor", {
        mediaType,
        candidateCount: candidates.length,
        results: results.map((r) => ({
          contentId: r.contentId,
          tasteFit: r.tasteFit,
          confidence: r.confidence,
          vetoed: r.vetoed,
        })),
      });

      // Orijinal candidates sırasını koru (gölge mod)
      return results;
    },
  };
}

/** Kategori ağırlığı (§11.1 — RECOMMENDATION_WEIGHTS'ten alınır) */
function getCategoryWeight(categoryId: string): number {
  const weights: Record<string, number> = {
    concept:   RECOMMENDATION_WEIGHTS.theme_concept,
    genre:     RECOMMENDATION_WEIGHTS.genre,
    mood:      RECOMMENDATION_WEIGHTS.mood,
    narrative: RECOMMENDATION_WEIGHTS.narrative,
    character: RECOMMENDATION_WEIGHTS.character,
    style:     RECOMMENDATION_WEIGHTS.style,
    emotional: RECOMMENDATION_WEIGHTS.emotional,
    sensory:   RECOMMENDATION_WEIGHTS.sensory,
    setting:   RECOMMENDATION_WEIGHTS.setting,
    creator:   RECOMMENDATION_WEIGHTS.creator,
  };
  return weights[categoryId] ?? 0;
}

/** Güven belirle (TP-025) */
function determineConfidence(
  profile: TasteProfile,
  contentItem: ContentTasteItem
): "low" | "medium" | "high" {
  const metrics = Object.keys(contentItem.features).filter((m) => {
    const view = resolveEffectiveMetricView(profile.metrics[m]);
    return !view.isExcluded;
  });
  if (metrics.length === 0) return "low";
  const knownMetrics = metrics.filter((m) => {
    const view = resolveEffectiveMetricView(profile.metrics[m]);
    return view.effectiveStatus !== "unknown";
  });
  const coverage = knownMetrics.length / metrics.length;
  if (coverage >= 0.7) return "high";
  if (coverage >= 0.4) return "medium";
  return "low";
}

/** Veto kontrolü: yüksek güvenli olumsuz eşleşme (TP-034) */
function checkVeto(
  profile: TasteProfile,
  contentItem: ContentTasteItem
): boolean {
  for (const [metricId, feature] of Object.entries(contentItem.features)) {
    const profileMetric = profile.metrics[metricId];
    if (!profileMetric) continue;
    const view = resolveEffectiveMetricView(profileMetric);
    if (view.isExcluded) continue;

    // Yüksek güvenli + güçlü olumsuz
    if (
      view.effectiveStatus === "directional" &&
      view.effectiveAffinity < -70 &&
      profileMetric.evidence.negMass > 5 &&
      feature.strength > 80 &&
      feature.confidence > 0.8
    ) {
      return true;
    }
  }
  return false;
}

/** En etkili metrikleri bul */
function findTopMetrics(
  contentItem: ContentTasteItem,
  profile: TasteProfile,
  limit: number
): string[] {
  const scores: Array<{ metricId: string; score: number }> = [];

  for (const [metricId, feature] of Object.entries(contentItem.features)) {
    const profileMetric = profile.metrics[metricId];
    const view = resolveEffectiveMetricView(profileMetric);
    if (!profileMetric || view.isExcluded || view.effectiveStatus === "unknown") continue;

    const score =
      (feature.strength / 100) *
      feature.confidence *
      Math.abs(view.effectiveAffinity / 100);
    scores.push({ metricId, score });
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, limit).map((s) => s.metricId);
}

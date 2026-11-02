// ===========================================================================
// CineTrack Taste Engine — Profile Explainer (v1.0)
// Metrik kartı açıklama verisi: kanıt listesi, ilgili metrikler (L10)
// KRİTİK: UI hesaplama yapmaz, yalnızca gösterir
// ===========================================================================

import type { TasteProfile, TasteMetric, MetricDefinition, ContentTasteItem } from "./types";
import { TAXONOMY_V01, getMetricById } from "./taxonomy";

export interface MetricExplanation {
  metricId: string;
  metric: TasteMetric;
  definition: MetricDefinition;
  positiveEvidence: EvidenceItem[];
  negativeEvidence: EvidenceItem[];
  neutralEvidence: EvidenceItem[];
  relatedMetrics: RelatedMetric[];
  spoilerRisk: "none" | "possible" | "high";
}

export interface EvidenceItem {
  contentId: string;
  contribution: number;
  behaviorSignal: number;
  featureStrength: number;
  confidence: number;
  timeWeight: number;
  direction: "positive" | "negative" | "neutral";
  title?: string;
  year?: number | string;
  mediaType?: "movie" | "tv";
  posterPath?: string;
  personalRating?: number;
}

export interface RelatedMetric {
  metricId: string;
  affinity: number;
  relationship: "parent" | "child" | "semantic_group" | "related";
}

/**
 * Metrik kartı için açıklama verisi üret
 *
 * KRİTİK: UI hesaplama yapmaz, yalnızca gösterir (L10)
 * "Bunu nasıl bildin?" prensibine uygun — her metrik kanıtla gelir.
 */
export function explainMetric(
  metricId: string,
  profile: TasteProfile,
  contentIndex: Record<string, ContentTasteItem>
): MetricExplanation | null {
  const metric = profile.metrics[metricId];
  if (!metric) {
    return null;
  }

  const definition = getMetricById(metricId);
  if (!definition) {
    return null;
  }

  // Olumlu kanıt: topPositiveContentIds
  const positiveEvidence: EvidenceItem[] = metric.evidence.topPositiveContentIds.map(
    (contentId) => {
      const contentItem = contentIndex[contentId];
      const feature = contentItem?.features[metricId];
      return {
        contentId,
        contribution: feature
          ? (feature.strength / 100) * feature.confidence
          : 0,
        behaviorSignal: 1, // placeholder: gerçek sinyal evidence-ledger'dan alınmalı
        featureStrength: feature?.strength ?? 0,
        confidence: feature?.confidence ?? 0,
        timeWeight: 1, // placeholder: gerçek zaman ağırlığı temporal-analyzer'dan
        direction: "positive" as const,
      };
    }
  );

  // Olumsuz kanıt: topNegativeContentIds
  const negativeEvidence: EvidenceItem[] = metric.evidence.topNegativeContentIds.map(
    (contentId) => {
      const contentItem = contentIndex[contentId];
      const feature = contentItem?.features[metricId];
      return {
        contentId,
        contribution: feature
          ? (feature.strength / 100) * feature.confidence
          : 0,
        behaviorSignal: -1,
        featureStrength: feature?.strength ?? 0,
        confidence: feature?.confidence ?? 0,
        timeWeight: 1,
        direction: "negative" as const,
      };
    }
  );

  // Nötr kanıt: V1'de boş (V2'de uncertainMass'tan türetilecek)
  const neutralEvidence: EvidenceItem[] = [];

  // İlgili metrikler: parent, child, semanticGroup
  const relatedMetrics = findRelatedMetrics(metricId, profile);

  return {
    metricId,
    metric,
    definition,
    positiveEvidence,
    negativeEvidence,
    neutralEvidence,
    relatedMetrics,
    spoilerRisk: definition.spoilerRisk,
  };
}

/**
 * İlgili metrikleri bul (parent, child, semanticGroup)
 */
function findRelatedMetrics(
  metricId: string,
  profile: TasteProfile
): RelatedMetric[] {
  const related: RelatedMetric[] = [];
  const metric = getMetricById(metricId);
  if (!metric) {
    return related;
  }

  // Parent
  if (metric.parentId) {
    const parentProfileMetric = profile.metrics[metric.parentId];
    if (parentProfileMetric) {
      related.push({
        metricId: metric.parentId,
        affinity: parentProfileMetric.affinity,
        relationship: "parent",
      });
    }
  }

  // Children
  for (const otherMetric of TAXONOMY_V01) {
    if (otherMetric.parentId === metricId) {
      const otherProfileMetric = profile.metrics[otherMetric.id];
      if (otherProfileMetric) {
        related.push({
          metricId: otherMetric.id,
          affinity: otherProfileMetric.affinity,
          relationship: "child",
        });
      }
    }
  }

  // Semantic group
  if (metric.semanticGroup) {
    for (const otherMetric of TAXONOMY_V01) {
      if (
        otherMetric.id !== metricId &&
        otherMetric.semanticGroup === metric.semanticGroup
      ) {
        const otherProfileMetric = profile.metrics[otherMetric.id];
        if (otherProfileMetric) {
          related.push({
            metricId: otherMetric.id,
            affinity: otherProfileMetric.affinity,
            relationship: "semantic_group",
          });
        }
      }
    }
  }

  return related;
}

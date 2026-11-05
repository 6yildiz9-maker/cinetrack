// ===========================================================================
// Cinethos Taste Engine — Confidence Calculator (v1.0)
// Destek/nitelik/kapsam üçlüsü (TP-025)
// ===========================================================================

import type { MetricMasses } from "./evidence-ledger.ts";

export type ConfidenceLevel = "low" | "medium" | "high";

export interface ConfidenceResult {
  support: ConfidenceLevel;   // kaç bağımsız içerik/variety
  quality: ConfidenceLevel;   // etiket kaynağı + tarih kesinliği
  coverage: ConfidenceLevel;  // hangi kategoriler dolu
  overall: ConfidenceLevel;
}

/**
 * Güven üçlüsünü hesapla (TP-025)
 *
 * KRİTİK: Kalibrasyonsuz yüzde YOK; low/medium/high dil kullan.
 */
export function computeConfidence(
  masses: MetricMasses,
  avgFeatureConfidence: number,
  hasExactDate: boolean
): ConfidenceResult {
  const { evidenceCount } = masses;

  // 1. Destek: kaç bağımsız içerik
  let support: ConfidenceLevel;
  if (evidenceCount >= 10) {
    support = "high";
  } else if (evidenceCount >= 5) {
    support = "medium";
  } else {
    support = "low";
  }

  // 2. Nitelik: etiket kaynağı + tarih kesinliği
  let quality: ConfidenceLevel;
  if (avgFeatureConfidence >= 0.8 && hasExactDate) {
    quality = "high";
  } else if (avgFeatureConfidence >= 0.6) {
    quality = "medium";
  } else {
    quality = "low";
  }

  // 3. Kapsam: V1'de basit (tüm kategoriler dolu mu?)
  // Gerçek kapsam hesabı Faz 4'te yapılacak
  const coverage: ConfidenceLevel = evidenceCount > 0 ? "medium" : "low";

  // Overall: en düşük seviye belirler
  const levels: ConfidenceLevel[] = [support, quality, coverage];
  const overall: ConfidenceLevel = levels.includes("low")
    ? "low"
    : levels.includes("medium")
    ? "medium"
    : "high";

  return { support, quality, coverage, overall };
}

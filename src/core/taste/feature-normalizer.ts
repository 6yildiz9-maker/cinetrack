// ===========================================================================
// CineTrack Taste Engine — Feature Normalizer v1.0
//
// Sorumluluk: Aynı içerikte fazla etiketlerin şişirme yapmasını engeller.
//
// Kurallar:
// - strength 0-100 tamsayı kalmalı
// - confidence 0-1 aralığında kalmalı
// - Aynı semanticGroup içindeki eşdeğer metrikler toplam bonusu şişirmemeli
// - Kategori içi normalize yapılmalı
// - Shadow metrikler (scoringEnabled=false) aktif hale getirilmez
// ===========================================================================

import type { ContentFeature, MetricDefinition } from "./types.ts";

// === Yardımcılar ===

function clampStrength(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function clampConfidence(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Feature map'i kopyalar, strength ve confidence değerlerini geçerli aralıklara sıkıştırır.
 */
function sanitizeFeatureValues(
  features: Record<string, ContentFeature>
): Record<string, ContentFeature> {
  const result: Record<string, ContentFeature> = {};
  for (const [metricId, feat] of Object.entries(features)) {
    result[metricId] = {
      ...feat,
      strength: clampStrength(feat.strength),
      confidence: clampConfidence(feat.confidence),
    };
  }
  return result;
}

/**
 * Shadow metrikleri (scoringEnabled=false) feature map'inden kaldırır.
 * V1'de profil hesabına girmemeli.
 */
function removeShadowMetrics(
  features: Record<string, ContentFeature>,
  taxonomy: MetricDefinition[]
): Record<string, ContentFeature> {
  const shadowIds = new Set(
    taxonomy.filter((m) => !m.scoringEnabled).map((m) => m.id)
  );
  const result: Record<string, ContentFeature> = {};
  for (const [metricId, feat] of Object.entries(features)) {
    if (!shadowIds.has(metricId)) {
      result[metricId] = feat;
    }
    // Shadow metrik aktif hale gelmiyor — feature map'ten çıkarılıyor
  }
  return result;
}

/**
 * Aynı semanticGroup içindeki eşdeğer metrikler toplam bonusu şişirmemeli (TP-013).
 *
 * Örnek: genre.scifi ve genre.fantasy aynı semanticGroup'taysa ve ikisi de mevcutsa
 * confidence değerleri group içindeki ağırlık oranına göre bastırılır.
 *
 * V0.1 taxonomy'sinde semanticGroup tanımlı metrik sayısı az olduğundan
 * bu adım şimdilik hafif bir geçiştir.
 */
export function applySemanticGroupDamping(
  features: Record<string, ContentFeature>,
  taxonomy: MetricDefinition[]
): Record<string, ContentFeature> {
  // semanticGroup → metricId listesi haritası
  const groupMap = new Map<string, string[]>();
  for (const m of taxonomy) {
    if (m.semanticGroup && features[m.id]) {
      const existing = groupMap.get(m.semanticGroup) ?? [];
      existing.push(m.id);
      groupMap.set(m.semanticGroup, existing);
    }
  }

  const result = { ...features };

  for (const [, metricIds] of groupMap) {
    if (metricIds.length <= 1) continue;

    // Group içinde birden fazla aktif feature varsa confidence'ı eşit bölüştür
    // (en güçlü olanı korur, diğerlerini bastırır)
    const sorted = [...metricIds].sort(
      (a, b) => (result[b]?.confidence ?? 0) - (result[a]?.confidence ?? 0)
    );

    // İlk (en güçlü) olduğu gibi kalır; sonrakiler azalan oranda bastırılır
    for (let i = 1; i < sorted.length; i++) {
      const metricId = sorted[i];
      const feat = result[metricId];
      if (feat) {
        // Her sıradaki metrik için confidence %30 azaltma (TP-013)
        result[metricId] = {
          ...feat,
          confidence: clampConfidence(feat.confidence * Math.pow(0.7, i)),
        };
      }
    }
  }

  return result;
}

/**
 * Kategori içi katkı şişirmesini sınırlar.
 *
 * Bir kategoride (ör. genre) çok sayıda eşleşme varsa her birinin strength değeri
 * kategori içindeki eşleşme sayısına göre hafifçe bastırılır.
 * Bu, çok geniş genre listesi olan içeriklerin diğerlerine oranla avantaj kazanmasını önler.
 */
export function capCategoryContribution(
  features: Record<string, ContentFeature>,
  taxonomy: MetricDefinition[]
): Record<string, ContentFeature> {
  // metricId → categoryId haritası
  const categoryMap = new Map<string, string>();
  for (const m of taxonomy) {
    categoryMap.set(m.id, m.categoryId);
  }

  // Kategori başına kaç feature var?
  const categoryCount = new Map<string, number>();
  for (const metricId of Object.keys(features)) {
    const cat = categoryMap.get(metricId);
    if (cat) {
      categoryCount.set(cat, (categoryCount.get(cat) ?? 0) + 1);
    }
  }

  const result = { ...features };

  for (const [metricId, feat] of Object.entries(features)) {
    const cat = categoryMap.get(metricId);
    if (!cat) continue;
    const count = categoryCount.get(cat) ?? 1;

    // 3'ten fazla eşleşme varsa katkıyı bastır (PER_CONTENT_CAP mantığı)
    if (count > 3) {
      const dampFactor = 3 / count; // 4 eşleşme → 0.75, 6 eşleşme → 0.5
      result[metricId] = {
        ...feat,
        strength: clampStrength(feat.strength * dampFactor),
      };
    }
  }

  return result;
}

/**
 * Ana normalize fonksiyonu. Sırasıyla:
 * 1. strength/confidence değerlerini geçerli aralıklara sıkıştır
 * 2. Shadow metrikleri kaldır (aktif hale getirme)
 * 3. semanticGroup damping uygula
 * 4. Kategori içi katkı sınırlaması uygula
 */
export function normalizeContentFeatures(
  features: Record<string, ContentFeature>,
  taxonomy: MetricDefinition[]
): Record<string, ContentFeature> {
  let result = sanitizeFeatureValues(features);
  result = removeShadowMetrics(result, taxonomy);
  result = applySemanticGroupDamping(result, taxonomy);
  result = capCategoryContribution(result, taxonomy);
  return result;
}

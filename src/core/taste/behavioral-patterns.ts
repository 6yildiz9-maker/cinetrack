// ===========================================================================
// Cinethos Taste Engine — Behavioral Patterns (v1.0)
// pattern.completionist/sampler/devotee/explorer (TP-020)
// V1'de sadece alan hazırlığı; güvenilir veri yoksa hesaplanmaz
// ===========================================================================

import type { TasteEvent } from "./types.ts";

export interface BehavioralPatterns {
  completionist: number | null; // 0-1 arası veya null (veri yetersiz)
  sampler: number | null;
  devotee: number | null;
  explorer: number | null;
  computedAt: string;
  dataSufficient: boolean;
}

// Minimum olay sayısı — bu değerin altında anlamlı pattern çıkarılamaz
const MIN_EVENTS_FOR_PATTERN = 30;

/**
 * Behavioral DNA hesapla (TP-020)
 *
 * V1'de sadece alan hazırlığı; güvenilir veri yoksa null döner.
 * Gerçek hesaplama V2'de yapılacak:
 *   completionist: sezon/dizi tamamlama oranı
 *   sampler:       çok sayıda farklı içeriğe kısa maruz kalma eğilimi
 *   devotee:       belirli bir türe/yönetmene derin bağlılık
 *   explorer:      yeni/az bilinen içeriklere açıklık
 */
export function computeBehavioralPatterns(
  events: TasteEvent[],
  asOf: string
): BehavioralPatterns {
  const dataSufficient = events.length >= MIN_EVENTS_FOR_PATTERN;

  if (!dataSufficient) {
    return {
      completionist: null,
      sampler: null,
      devotee: null,
      explorer: null,
      computedAt: asOf,
      dataSufficient: false,
    };
  }

  // V1'de placeholder: tümü null (V2'de gerçek hesaplama yapılacak)
  return {
    completionist: null,
    sampler: null,
    devotee: null,
    explorer: null,
    computedAt: asOf,
    dataSufficient: true,
  };
}

/**
 * Minimum olay eşiğini döndür (test edilebilirlik için export)
 */
export function getMinEventsForPattern(): number {
  return MIN_EVENTS_FOR_PATTERN;
}

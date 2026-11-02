// ===========================================================================
// CineTrack Taste Engine — Temporal Analyzer (v1.5)
// lifetime/longTerm(730g)/recent(180g); timeSource (TP-029) + V1.5 experiencedAt
// ===========================================================================

import { HALF_LIFE_RECENT_DAYS, HALF_LIFE_LONG_TERM_DAYS } from "./constants.ts";

export type TimeSource = "actual" | "imported";
export type TimePrecision = "exact" | "approximate" | "unknown";

export interface TemporalWeights {
  lifetime: number;                  // azalma yok (her zaman 1)
  longTerm: number;                  // 730 gün yarılanma
  recent: number;                    // 180 gün yarılanma
  effectiveTimeSource: TimeSource;
}

export interface TemporalTimestampSources {
  ratedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  addedAt?: string;
}

function sanitizeTimestamp(value?: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Deneyim zamanını (experiencedAt) belirle (V1.5).
 * Eğer timeSource === "actual" ise öncelik sırasıyla:
 *   ratedAt -> completedAt -> updatedAt -> addedAt
 * kullanılır. timeSource === "imported" ise undefined döner (TP-029).
 */
export function resolveExperiencedAt(
  sources: TemporalTimestampSources | undefined,
  timeSource: TimeSource
): string | undefined {
  if (timeSource !== "actual" || !sources) {
    return undefined;
  }

  return (
    sanitizeTimestamp(sources.ratedAt) ??
    sanitizeTimestamp(sources.completedAt) ??
    sanitizeTimestamp(sources.updatedAt) ??
    sanitizeTimestamp(sources.addedAt)
  );
}

/**
 * Zaman ağırlıklarını hesapla (TP-029 & V1.5)
 *
 * T_i = 2^(-yaş_gün / yarılanma)
 *
 * KRİTİK:
 * - timeSource: "imported" → recent/longTerm'e girmez (Faz 0 kuralı)
 * - timeSource: "actual" → experiencedAt için öncelik sırası:
 *   ratedAt -> completedAt -> updatedAt -> addedAt
 */
export function computeTemporalWeights(
  recordedAt: string,
  experiencedAt: string | undefined,
  timeSource: TimeSource,
  timePrecision: TimePrecision,
  asOf: string,
  timestampSources?: TemporalTimestampSources
): TemporalWeights {
  // timePrecision şimdilik metadata olarak saklanıyor, V1 hesaplamasını etkilemiyor
  void timePrecision;

  const resolvedExperiencedAt =
    timeSource === "actual"
      ? resolveExperiencedAt(timestampSources, timeSource) ??
        sanitizeTimestamp(experiencedAt)
      : sanitizeTimestamp(experiencedAt);

  // Kullanılacak zaman: experiencedAt (biliniyorsa) veya recordedAt
  const effectiveDate = resolvedExperiencedAt ?? recordedAt;
  const asOfDate = new Date(asOf);
  const effectiveDateObj = new Date(effectiveDate);

  // Geçerli tarih kontrolü — geleceğe taşmış tarih → ağırlık 1 (karantina)
  if (isNaN(effectiveDateObj.getTime()) || effectiveDateObj > asOfDate) {
    return {
      lifetime: 1,
      longTerm: 1,
      recent: 1,
      effectiveTimeSource: timeSource,
    };
  }

  const ageInDays =
    (asOfDate.getTime() - effectiveDateObj.getTime()) / (1000 * 60 * 60 * 24);

  // Lifetime: azalma yok
  const lifetime = 1;

  // timeSource: imported → recent/longTerm'e girmez (TP-029)
  // Faz 0 kuralı: eski kayıtlarda ratedAt/completedAt yoksa "imported" kalır
  if (timeSource === "imported") {
    return {
      lifetime,
      longTerm: 0,
      recent: 0,
      effectiveTimeSource: timeSource,
    };
  }

  // Long-term: 730 gün yarılanma
  const longTerm = Math.pow(2, -ageInDays / HALF_LIFE_LONG_TERM_DAYS);

  // Recent: 180 gün yarılanma
  const recent = Math.pow(2, -ageInDays / HALF_LIFE_RECENT_DAYS);

  return {
    lifetime,
    longTerm,
    recent,
    effectiveTimeSource: timeSource,
  };
}

// ===========================================================================
// CineTrack Taste Engine — Preference Calculator (v1.0)
// A_m formülü, shrinkage, nötr payda, durum etiketi (TP-015/021/024)
// ===========================================================================

import { SHRINKAGE_K, MIN_EVIDENCE_FOR_DIRECTIONAL } from "./constants";
import type { MetricMasses } from "./evidence-ledger";

export type MetricState = "unknown" | "directional" | "neutral" | "mixed" | "excluded";

export interface PreferenceResult {
  affinity: number;          // -100...+100
  longTermAffinity: number;
  recentAffinity: number;
  status: MetricState;
}

/**
 * Metrik tercihi hesapla (TP-015)
 *
 * A_m = (S_m + k_m × μ_m) / (D_m + k_m)
 *
 * V1'de μ_m = 0, k_m = SHRINKAGE_K = 2.5
 *
 * KRİTİK KURALLAR:
 * 1. Nötr kanıt paydada kalır (D_m gerçek ağırlık toplamı — nötr dahil)
 * 2. Shrinkage zorunlu (k_m = 2.5 paydada) — 1 filmden "+100" olmaz
 */
export function computePreference(masses: MetricMasses): PreferenceResult {
  const { posMass, negMass, evidenceMass } = masses;

  // S_m = Σ w_im × s_i (yönlü katkıların toplamı — pos pozitif, neg negatif)
  const weightedSum = posMass - negMass;

  // D_m = Σ w_im (nötr dahil gerçek ağırlık toplamı — KRİTİK)
  // evidenceMass zaten |contribution| toplamıdır (nötr dahil)
  const evidenceMassWithNeutral = evidenceMass;

  // A_m = (S_m + k × 0) / (D_m + k)
  // μ_m = 0 (V1 prior)
  const affinityRaw = weightedSum / (evidenceMassWithNeutral + SHRINKAGE_K);

  // -100...+100 aralığına ölçekle
  const affinity = Math.round(affinityRaw * 100);

  // Durum etiketi (TP-024)
  const status = determineStatus(masses);

  return {
    affinity,
    longTermAffinity: affinity, // V1'de aynı (Faz 4'te ayrılacak)
    recentAffinity: affinity,   // V1'de aynı (Faz 4'te ayrılacak)
    status,
  };
}

/**
 * Durum etiketi belirle (TP-024)
 *
 * Sıralama: excluded → unknown → mixed → neutral → directional
 */
function determineStatus(masses: MetricMasses): MetricState {
  const { posMass, negMass, uncertainMass, evidenceMass, evidenceCount } = masses;

  // 1. Kanıt yok veya çok az
  if (evidenceCount === 0 || evidenceMass < 0.1) {
    return "unknown";
  }

  // 2. Yeterli kanıt sayısı yok → yön belirsiz
  if (evidenceCount < MIN_EVIDENCE_FOR_DIRECTIONAL) {
    return "unknown";
  }

  // 3. Hem olumlu hem olumsuz güçlü kanıt → karışık
  const totalDirected = posMass + negMass;
  if (totalDirected > 0) {
    const posRatio = posMass / totalDirected;
    const negRatio = negMass / totalDirected;
    // Her iki yön de %30'dan fazlaysa → mixed
    if (posRatio > 0.3 && negRatio > 0.3) {
      return "mixed";
    }
  }

  // 4. Yeterli kanıt var, belirgin yön yok (nötr ağırlıklı)
  if (uncertainMass > posMass && uncertainMass > negMass) {
    return "neutral";
  }

  // 5. Yön belirlenmiş
  return "directional";
}

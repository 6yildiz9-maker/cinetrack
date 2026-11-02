// ===========================================================================
// CineTrack Taste Engine — Profile Aggregator (v1.0)
// movie/series/unified profil üretimi, aktarım politikaları (TP-026/027)
//
// MUTLAK KURALLAR:
// 1. Medya izolasyonu: film olayları → yalnızca film profili
//    dizi olayları → yalnızca dizi profili
// 2. Unified çift sayım yok: unified profil film/dizi profillerini
//    tekrar karıştırıp ikinci kez öğrenmez
// 3. Aktarım politikası metrik başına: shared / limited_transfer / media_specific
// 4. Veri yoksa unknown: iki medyada da destek yoksa sahte nötr değil unknown
// ===========================================================================

import type { TasteEvent, TasteProfile, TasteMetric } from "./types";
import { EvidenceLedger } from "./evidence-ledger";
import { computePreference } from "./preference-calculator";
import { computeConfidence } from "./confidence-calculator";
import { TAXONOMY_V01, getMetricById } from "./taxonomy";
import { SHRINKAGE_K, ALGORITHM_VERSION, TAXONOMY_VERSION } from "./constants";

export type MediaType = "movie" | "series" | "unified";

export interface AggregatedProfiles {
  movie: TasteProfile;
  series: TasteProfile;
  unified: TasteProfile;
  asOf: string;
  algorithmVersion: string;
  taxonomyVersion: string;
}

/**
 * contentId'den medya tipini çıkar
 * "movie:123" → "movie", "tv:456" → "tv"
 */
export function extractMediaType(contentId: string): "movie" | "tv" | null {
  const colonIdx = contentId.indexOf(":");
  if (colonIdx === -1) return null;
  const media = contentId.slice(0, colonIdx);
  if (media === "movie") return "movie";
  if (media === "tv") return "tv";
  return null;
}

/**
 * Olayları medya tipine göre ayır (KRİTİK: izolasyon garantisi)
 */
export function separateEventsByMedia(events: TasteEvent[]): {
  movieEvents: TasteEvent[];
  seriesEvents: TasteEvent[];
} {
  const movieEvents: TasteEvent[] = [];
  const seriesEvents: TasteEvent[] = [];

  for (const event of events) {
    const media = extractMediaType(event.contentId);
    if (media === "movie") {
      movieEvents.push(event);
    } else if (media === "tv") {
      seriesEvents.push(event);
    }
    // Bilinmeyen medya tipi her iki listeye de girmez
  }

  return { movieEvents, seriesEvents };
}

/**
 * Tek medya için profil hesapla (film veya dizi)
 *
 * V1'de feature extractor entegrasyonu placeholder düzeyindedir.
 * EvidenceLedger katkı = 0 olduğundan tüm metrikler "unknown" döner.
 * Faz 5'te feature-extractor + evidence-ledger entegrasyonu yapılacak.
 */
export function computeSingleMediaProfile(
  events: TasteEvent[],
  mediaType: "movie" | "series",
  asOf: string
): TasteProfile {
  const ledger = new EvidenceLedger();
  const metrics: Record<string, TasteMetric> = {};

  // Medya tipinin TMDB string karşılığı
  const tmdbMediaType = mediaType === "movie" ? "movie" : "tv";

  // Her metrik için katkı hesapla
  for (const metricDef of TAXONOMY_V01) {
    // Bu medya için geçerli değilse atla
    if (!metricDef.applicableMedia.includes(tmdbMediaType)) {
      continue;
    }

    // Gölge metrik → atla
    if (!metricDef.scoringEnabled) {
      continue;
    }

    // V1 placeholder: feature extractor olmadan feature strength bilinmiyor
    // Her olay için contribution = 0 (featureStrength=0 × ... = 0)
    // Gerçek implementasyonda feature-extractor'tan strength/confidence alınacak
    for (const event of events) {
      const featureStrength = 0;
      const confidence = 0;
      const timeWeight = 1;
      const groupDamping = 1;
      ledger.addEvent(
        event,
        metricDef.id,
        featureStrength,
        confidence,
        timeWeight,
        groupDamping
      );
    }

    // Kütleleri hesapla
    const masses = ledger.computeMasses(metricDef.id);

    // Tercihi hesapla
    const preference = computePreference(masses);

    // Güveni hesapla (V1 placeholder)
    const avgFeatureConfidence = 0.8;
    const hasExactDate = true;
    computeConfidence(masses, avgFeatureConfidence, hasExactDate);

    metrics[metricDef.id] = {
      metricId: metricDef.id,
      affinity: preference.affinity,
      longTermAffinity: preference.longTermAffinity,
      recentAffinity: preference.recentAffinity,
      status: preference.status,
      evidence: {
        posMass: masses.posMass,
        negMass: masses.negMass,
        uncertainMass: masses.uncertainMass,
        topPositiveContentIds: masses.topPositiveContentIds,
        topNegativeContentIds: masses.topNegativeContentIds,
      },
    };
  }

  return {
    mediaType,
    algorithmVersion: ALGORITHM_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    asOf,
    metrics,
  };
}

/**
 * Unified profil hesapla (TP-027)
 *
 * Formül:
 *   b_t = κ / (D_t + κ)
 *   A^rec_t,m = (S_t + τ_m × b_t × S_o) / (D_t + τ_m × b_t × D_o + k_m)
 *
 * Ağırlıklı birleşim:
 *   w_movie  = D_movie / (D_movie + D_series)  [evidence ağırlıklı]
 *   w_series = D_series / (D_movie + D_series)
 *
 * KRİTİK: Unified profil film/dizi profillerini tekrar karıştırmaz —
 * yalnızca önceden hesaplanmış film ve dizi metriklerini birleştirir.
 */
export function computeUnifiedProfile(
  movieProfile: TasteProfile,
  seriesProfile: TasteProfile,
  asOf: string
): TasteProfile {
  const metrics: Record<string, TasteMetric> = {};
  const KAPPA = 2.0; // destek yumuşatması

  // Tüm aktif metrik ID'leri (her iki profildeki birleşim)
  const allMetricIds = new Set([
    ...Object.keys(movieProfile.metrics),
    ...Object.keys(seriesProfile.metrics),
  ]);

  for (const metricId of allMetricIds) {
    const metricDef = getMetricById(metricId);
    if (!metricDef || !metricDef.scoringEnabled) {
      continue;
    }

    const movieMetric = movieProfile.metrics[metricId];
    const seriesMetric = seriesProfile.metrics[metricId];

    // Aktarım katsayısı (τ_m) — metrik başına aktarım politikası (TP-026)
    let transferCoeff: number;
    if (metricDef.transferPolicy === "shared") {
      transferCoeff = 1.0;
    } else if (metricDef.transferPolicy === "limited_transfer") {
      transferCoeff = 0.3;
    } else {
      // media_specific: karşı medyaya aktarım yok
      transferCoeff = 0.0;
    }

    // Her iki medyada da veri yoksa → unknown (sahte nötr değil)
    if (!movieMetric && !seriesMetric) {
      metrics[metricId] = {
        metricId,
        affinity: 0,
        longTermAffinity: 0,
        recentAffinity: 0,
        status: "unknown",
        evidence: {
          posMass: 0,
          negMass: 0,
          uncertainMass: 0,
          topPositiveContentIds: [],
          topNegativeContentIds: [],
        },
      };
      continue;
    }

    // Sadece bir medya varsa → doğrudan kullan (aktarım yok)
    if (!movieMetric) {
      metrics[metricId] = { ...seriesMetric };
      continue;
    }
    if (!seriesMetric) {
      metrics[metricId] = { ...movieMetric };
      continue;
    }

    // Her iki medya da var → aktarım formülü (TP-027)

    // Film tarafı
    const movieS = movieMetric.evidence.posMass - movieMetric.evidence.negMass;
    const movieD =
      movieMetric.evidence.posMass +
      movieMetric.evidence.negMass +
      movieMetric.evidence.uncertainMass;

    // Dizi tarafı
    const seriesS = seriesMetric.evidence.posMass - seriesMetric.evidence.negMass;
    const seriesD =
      seriesMetric.evidence.posMass +
      seriesMetric.evidence.negMass +
      seriesMetric.evidence.uncertainMass;

    // b_movie = κ / (D_movie + κ) — film tarafının destek azlığı
    const b_movie = KAPPA / (movieD + KAPPA);
    // A^rec_movie = (S_movie + τ × b_movie × S_series) / (D_movie + τ × b_movie × D_series + k)
    const unifiedMovieAffinity =
      (movieS + transferCoeff * b_movie * seriesS) /
      (movieD + transferCoeff * b_movie * seriesD + SHRINKAGE_K);

    // b_series = κ / (D_series + κ)
    const b_series = KAPPA / (seriesD + KAPPA);
    // A^rec_series = (S_series + τ × b_series × S_movie) / (D_series + τ × b_series × D_movie + k)
    const unifiedSeriesAffinity =
      (seriesS + transferCoeff * b_series * movieS) /
      (seriesD + transferCoeff * b_series * movieD + SHRINKAGE_K);

    // Güven ağırlıklı birleşim: evidence kütlesine orantılı ağırlık
    const totalEvidence = movieD + seriesD;
    const movieWeight = totalEvidence > 0 ? movieD / totalEvidence : 0.5;
    const seriesWeight = totalEvidence > 0 ? seriesD / totalEvidence : 0.5;

    const unifiedAffinity =
      unifiedMovieAffinity * movieWeight + unifiedSeriesAffinity * seriesWeight;

    // -100...+100
    const affinity = Math.round(unifiedAffinity * 100);

    // Durum: her iki medyanın durumuna göre belirle (öncelik sırası)
    let status: TasteMetric["status"] = "unknown";
    if (
      movieMetric.status === "excluded" ||
      seriesMetric.status === "excluded"
    ) {
      status = "excluded";
    } else if (
      movieMetric.status === "directional" ||
      seriesMetric.status === "directional"
    ) {
      status = "directional";
    } else if (
      movieMetric.status === "mixed" ||
      seriesMetric.status === "mixed"
    ) {
      status = "mixed";
    } else if (
      movieMetric.status === "neutral" ||
      seriesMetric.status === "neutral"
    ) {
      status = "neutral";
    }

    metrics[metricId] = {
      metricId,
      affinity,
      longTermAffinity: affinity, // V1'de aynı (Faz 5'te ayrılacak)
      recentAffinity: affinity,   // V1'de aynı
      status,
      evidence: {
        posMass: movieMetric.evidence.posMass + seriesMetric.evidence.posMass,
        negMass: movieMetric.evidence.negMass + seriesMetric.evidence.negMass,
        uncertainMass:
          movieMetric.evidence.uncertainMass +
          seriesMetric.evidence.uncertainMass,
        topPositiveContentIds: [
          ...movieMetric.evidence.topPositiveContentIds,
          ...seriesMetric.evidence.topPositiveContentIds,
        ].slice(0, 3),
        topNegativeContentIds: [
          ...movieMetric.evidence.topNegativeContentIds,
          ...seriesMetric.evidence.topNegativeContentIds,
        ].slice(0, 3),
      },
    };
  }

  return {
    mediaType: "unified",
    algorithmVersion: ALGORITHM_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    asOf,
    metrics,
  };
}

/**
 * Üç profili birden hesapla (film + dizi + unified)
 *
 * Film ve dizi profilleri tamamen bağımsız EvidenceLedger örnekleriyle
 * hesaplanır → izolasyon garantisi.
 * Unified profil yalnızca önceden hesaplanmış film/dizi metriklerini birleştirir
 * → çift sayım yok.
 */
export function aggregateProfiles(
  events: TasteEvent[],
  asOf: string
): AggregatedProfiles {
  // Olayları medya tipine göre ayır (izolasyon)
  const { movieEvents, seriesEvents } = separateEventsByMedia(events);

  // Bağımsız profil hesabı — her biri kendi EvidenceLedger'ını kullanır
  const movieProfile = computeSingleMediaProfile(movieEvents, "movie", asOf);
  const seriesProfile = computeSingleMediaProfile(seriesEvents, "series", asOf);

  // Unified: yalnızca önceden hesaplanmış profilleri birleştirir
  const unifiedProfile = computeUnifiedProfile(movieProfile, seriesProfile, asOf);

  return {
    movie: movieProfile,
    series: seriesProfile,
    unified: unifiedProfile,
    asOf,
    algorithmVersion: ALGORITHM_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
  };
}

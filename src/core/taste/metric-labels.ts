// ===========================================================================
// CineTrack Taste Engine — Türkçe Metrik Başlıkları & Efektif Override Çözümleyici
// ===========================================================================

import type { MetricState, TasteMetric } from "./types";
import { getMetricById } from "./taxonomy";

export const CATEGORY_LABELS_TR: Record<string, string> = {
  all: "Tümü",
  genre: "Tür",
  mood: "Atmosfer",
  narrative: "Anlatı",
  concept: "Tema",
  character: "Karakter",
  style: "Stil",
  setting: "Ortam",
  origin: "Köken",
  format: "Format",
};

export const METRIC_TITLES_TR: Record<string, string> = {
  // Genre (10)
  "genre.scifi": "Bilim Kurgu",
  "genre.fantasy": "Fantastik",
  "genre.thriller": "Gerilim",
  "genre.horror": "Korku",
  "genre.drama": "Dram",
  "genre.comedy": "Komedi",
  "genre.crime": "Suç & Polisiye",
  "genre.animation": "Animasyon",
  "genre.documentary": "Belgesel",
  "genre.romance": "Romantik",

  // Mood (6)
  "mood.melancholic": "Melankolik Atmosfer",
  "mood.dark": "Karanlık & Kasvetli",
  "mood.hopeful": "Umut Verici",
  "mood.tense": "Yüksek Gerilim",
  "mood.cozy": "Sıcak & Dingin",
  "mood.unsettling": "Tekinsiz Atmosfer",

  // Narrative (4)
  "narrative.non_linear": "Doğrusal Olmayan Kurgu",
  "narrative.open_ending": "Açık Uçlu Final",
  "narrative.twist": "Sürpriz Final",
  "narrative.slow_burn": "Yavaş Açılan Anlatı",

  // Concept (6)
  "concept.identity": "Kimlik & Benlik",
  "concept.mortality": "Ölümlülük & Zaman",
  "concept.technology": "Teknoloji & Yapay Zekâ",
  "concept.freedom": "Özgürlük & Direniş",
  "concept.love": "Aşk & İnsan İlişkileri",
  "concept.power": "Güç & Politika",

  // Character (3)
  "character.antihero": "Anti-Kahraman",
  "character.solitary": "Yalnız Karakter",
  "character.ensemble": "Geniş Kadro",

  // Style (4)
  "style.surreal": "Sürreal & Düşsel",
  "style.stylized": "Çarpıcı Görsel Stil",
  "style.minimalist": "Minimalist Üslup",
  "style.realistic": "Gerçekçi Üslup",

  // Setting (4)
  "setting.dystopia": "Distopya",
  "setting.space": "Uzay & Kozmos",
  "setting.historical": "Tarihsel Dönem",
  "setting.contemporary": "Günümüz Dünyası",

  // Origin (3)
  "origin.asian_cinema": "Asya Sineması",
  "origin.european": "Avrupa Sineması",
  "origin.turkish": "Türk Sineması",

  // Format (2)
  "format.miniseries": "Mini Dizi",
  "format.long_running": "Uzun Soluklu Dizi",
};

export function getCategoryDisplayLabel(categoryId: string): string {
  return CATEGORY_LABELS_TR[categoryId] ?? categoryId;
}

export function getMetricDisplayTitle(metricId: string): string {
  if (METRIC_TITLES_TR[metricId]) {
    return METRIC_TITLES_TR[metricId];
  }
  const def = getMetricById(metricId);
  if (def?.definition) {
    return def.definition;
  }
  const tail = metricId.split(".").slice(1).join(" ").replace(/_/g, " ").trim();
  if (!tail) return metricId;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

export function getStatusLabelTr(status: MetricState | string): string {
  switch (status) {
    case "directional":
      return "Güçlü Eğilim";
    case "mixed":
      return "Karışık Kanıt";
    case "neutral":
      return "Dengeli";
    case "excluded":
      return "İlgisiz";
    case "unknown":
      return "Veri Yetersiz";
    default:
      return status;
  }
}

function clampAffinity(val: number): number {
  return Math.max(-100, Math.min(100, Math.round(val)));
}

export interface EffectiveMetricView {
  computedAffinity: number;
  effectiveAffinity: number;
  effectiveStatus: MetricState;
  isExcluded: boolean;
  hasOverride: boolean;
}

/**
 * Kullanıcının manuel kontrolünü (TP-028: replace | boost | suppress | exclude)
 * bozulmamış algoritmik afinite üzerinde efektif görünüme çevirir.
 */
export function resolveEffectiveMetricView(
  metric: TasteMetric | null | undefined
): EffectiveMetricView {
  if (!metric) {
    return {
      computedAffinity: 0,
      effectiveAffinity: 0,
      effectiveStatus: "unknown",
      isExcluded: false,
      hasOverride: false,
    };
  }

  const base = Number.isFinite(metric.affinity) ? metric.affinity : 0;
  const override = metric.manualOverride;

  if (!override) {
    return {
      computedAffinity: base,
      effectiveAffinity: base,
      effectiveStatus: metric.status,
      isExcluded: metric.status === "excluded",
      hasOverride: false,
    };
  }

  if (override.mode === "exclude") {
    return {
      computedAffinity: base,
      effectiveAffinity: 0,
      effectiveStatus: "excluded",
      isExcluded: true,
      hasOverride: true,
    };
  }

  if (override.mode === "replace") {
    const eff = clampAffinity(override.value);
    return {
      computedAffinity: base,
      effectiveAffinity: eff,
      effectiveStatus: Math.abs(eff) >= 15 ? "directional" : "neutral",
      isExcluded: false,
      hasOverride: true,
    };
  }

  if (override.mode === "boost") {
    const delta = Number.isFinite(override.value) && override.value !== 0
      ? Math.abs(override.value)
      : 30;
    const eff = clampAffinity(base + delta);
    return {
      computedAffinity: base,
      effectiveAffinity: eff,
      effectiveStatus: Math.abs(eff) >= 15 ? "directional" : metric.status === "unknown" ? "neutral" : metric.status,
      isExcluded: false,
      hasOverride: true,
    };
  }

  // suppress
  const dampenRatio =
    Number.isFinite(override.value) && override.value !== 0
      ? Math.max(0, Math.min(0.85, Math.abs(override.value) / 100))
      : 0.6;
  const eff = clampAffinity(base * (1 - dampenRatio));
  return {
    computedAffinity: base,
    effectiveAffinity: eff,
    effectiveStatus: Math.abs(eff) >= 20 ? "directional" : "neutral",
    isExcluded: false,
    hasOverride: true,
  };
}

export function estimateMetricEvidenceCount(
  metric: TasteMetric | null | undefined
): number {
  if (!metric) return 0;
  const uniqueIds = new Set([
    ...(metric.evidence.topPositiveContentIds ?? []),
    ...(metric.evidence.topNegativeContentIds ?? []),
  ]);
  const massTotal =
    (metric.evidence.posMass ?? 0) +
    (metric.evidence.negMass ?? 0) +
    (metric.evidence.uncertainMass ?? 0);
  if (massTotal <= 0 && uniqueIds.size === 0) return 0;
  const estimatedFromMass = Math.round(massTotal * 1.4);
  return Math.max(uniqueIds.size, estimatedFromMass, massTotal > 0 ? 1 : 0);
}

const TMDB_GENRE_TO_METRIC_ID: Record<number, string> = {
  878: "genre.scifi",
  10765: "genre.scifi",
  14: "genre.fantasy",
  53: "genre.thriller",
  9648: "genre.thriller",
  27: "genre.horror",
  18: "genre.drama",
  35: "genre.comedy",
  80: "genre.crime",
  16: "genre.animation",
  99: "genre.documentary",
  10749: "genre.romance",
};

const ASIAN_LANGS = new Set(["ja", "ko", "zh", "cn", "th", "hi", "ta", "id", "vi", "tl"]);
const EUROPEAN_LANGS = new Set([
  "fr",
  "de",
  "es",
  "it",
  "sv",
  "da",
  "no",
  "fi",
  "pl",
  "nl",
  "ru",
  "cs",
  "el",
  "pt",
]);

/**
 * Keşfet kartındaki "Neden buradaydı?" etiketine tıklandığında ilgili yapımın
 * en baskın zevk metriğini (Kanıt Modalı için) çözümler.
 */
export function resolvePrimaryMetricIdForItem(
  item: Record<string, unknown> | null | undefined,
  metrics?: Record<string, TasteMetric> | null
): string {
  const candidates: string[] = [];

  if (item && typeof item === "object") {
    const rawGenres: number[] = Array.isArray(item.genre_ids)
      ? item.genre_ids.map(Number).filter(Number.isFinite)
      : Array.isArray(item.genres)
        ? (item.genres as Array<{ id?: unknown }>)
            .map((g) => Number(g?.id))
            .filter(Number.isFinite)
        : [];

    for (const gid of rawGenres) {
      const mapped = TMDB_GENRE_TO_METRIC_ID[gid];
      if (mapped && !candidates.includes(mapped)) {
        candidates.push(mapped);
      }
    }

    const lang = typeof item.original_language === "string" ? item.original_language.toLowerCase() : "";
    if (lang === "tr") {
      candidates.push("origin.turkish");
    } else if (ASIAN_LANGS.has(lang)) {
      candidates.push("origin.asian_cinema");
    } else if (EUROPEAN_LANGS.has(lang)) {
      candidates.push("origin.european");
    }
  }

  if (metrics && candidates.length > 0) {
    let bestId = candidates[0];
    let bestScore = -1;
    for (const cid of candidates) {
      const m = metrics[cid];
      const view = resolveEffectiveMetricView(m);
      const weight = (view.effectiveStatus !== "unknown" ? 100 : 0) + Math.abs(view.effectiveAffinity);
      if (weight > bestScore) {
        bestScore = weight;
        bestId = cid;
      }
    }
    return bestId;
  }

  if (candidates.length > 0) {
    return candidates[0];
  }

  if (metrics) {
    const sorted = Object.values(metrics)
      .filter((m) => m.status !== "unknown")
      .sort((a, b) => Math.abs(b.affinity) - Math.abs(a.affinity));
    if (sorted[0]) return sorted[0].metricId;
  }

  return "genre.drama";
}


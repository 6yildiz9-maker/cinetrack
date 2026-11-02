// ===========================================================================
// CineTrack Taste Engine — Feature Extractor v1.0
//
// KURALLAR:
// - LLM çağrısı yok
// - Overview/metin/keyword name eşleştirmesi yok
// - Sadece sayısal TMDB genre ID ve keyword ID kullanılır
// - Keyword ID mapping yoksa → unknown bırak; absent yazma
// - Eksik veri = absent değil, unknown
// - Shadow metrikler (scoringEnabled=false) hesaplanır ama aktif feature gibi davranmaz
// - contentId formatı keys.ts → makeMediaKey ile uyumlu: "movie:123" / "tv:456"
// ===========================================================================

import type { ContentTasteItem, ContentFeature, TasteMetadataInput } from "./types";
import { TAXONOMY_V01 } from "./taxonomy";
import {
  MOVIE_GENRE_IDS,
  TV_GENRE_IDS,
  KEYWORD_TO_METRIC,
  ORIGIN_RULES,
  FORMAT_RULES,
} from "./tmdb-mappings";
import {
  EXTRACTOR_VERSION,
  TMDB_MAPPING_VERSION,
  FEATURE_STRENGTH,
  FEATURE_CONFIDENCE,
  TAXONOMY_VERSION,
} from "./constants";

// === Deterministik hash (Node.js crypto veya SubtleCrypto olmadan senkron) ===
// Faz 2 için: JSON serileştirmesi + djb2 varyantı (hızlı, çakışma riski düşük)
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // unsigned 32-bit
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * TMDB metadata girişinden deterministik hash üretir.
 * hash(metadata + extractorVersion + mappingVersion + taxonomyVersion)
 */
export function buildMetadataHash(input: TasteMetadataInput): string {
  const canonical = JSON.stringify({
    contentId: input.contentId,
    mediaType: input.mediaType,
    tmdbId: input.tmdbId,
    genreIds: (input.genreIds ?? []).slice().sort((a, b) => a - b),
    keywords: (input.keywords ?? [])
      .map((k) => k.id)
      .sort((a, b) => a - b),
    originalLanguage: input.originalLanguage ?? null,
    productionCountries: (input.productionCountries ?? []).slice().sort(),
    originCountry: (input.originCountry ?? []).slice().sort(),
    runtime: input.runtime ?? null,
    episodeRunTime: (input.episodeRunTime ?? []).slice().sort((a, b) => a - b),
    numberOfSeasons: input.numberOfSeasons ?? null,
    releaseDate: input.releaseDate ?? null,
    firstAirDate: input.firstAirDate ?? null,
    _extractor: EXTRACTOR_VERSION,
    _mapping: TMDB_MAPPING_VERSION,
    _taxonomy: TAXONOMY_VERSION,
  });
  return hashString(canonical);
}

/**
 * Mevcut ContentTasteItem ile gelen yeni hash'i karşılaştırır.
 * Hash aynıysa yeniden extract gerekmez.
 */
export function shouldReextract(
  existing: ContentTasteItem | undefined,
  incomingHash: string
): boolean {
  if (!existing) return true;
  return existing.metadataHash !== incomingHash;
}

// === İç yardımcılar ===

function clampStrength(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function clampConfidence(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Film genre_ids → metric feature'ları üretir */
function extractMovieGenreFeatures(
  genreIds: number[]
): Record<string, ContentFeature> {
  const features: Record<string, ContentFeature> = {};
  const genreIdSet = new Set(genreIds);

  // Doğrudan eşleşmeler
  const directMappings: Array<[keyof typeof MOVIE_GENRE_IDS, string]> = [
    ["scifi", "genre.scifi"],
    ["fantasy", "genre.fantasy"],
    ["drama", "genre.drama"],
    ["comedy", "genre.comedy"],
    ["crime", "genre.crime"],
    ["animation", "genre.animation"],
    ["documentary", "genre.documentary"],
    ["romance", "genre.romance"],
    ["thriller", "genre.thriller"],
    ["horror", "genre.horror"],
  ];

  for (const [key, metricId] of directMappings) {
    const id = MOVIE_GENRE_IDS[key];
    if (genreIdSet.has(id)) {
      features[metricId] = {
        strength: clampStrength(FEATURE_STRENGTH.directGenre),
        confidence: clampConfidence(FEATURE_CONFIDENCE.directGenre),
        source: "tmdb",
        evidence: [String(id)],
        state: "present",
      };
    }
  }

  return features;
}

/** TV genre_ids → metric feature'ları üretir (TV genre ID'leri film'den farklı) */
function extractTvGenreFeatures(
  genreIds: number[]
): Record<string, ContentFeature> {
  const features: Record<string, ContentFeature> = {};
  const genreIdSet = new Set(genreIds);

  // TV'de drama, comedy, crime, animation, documentary doğrudan eşleşir
  const directMappings: Array<[keyof typeof TV_GENRE_IDS, string[]]> = [
    ["drama", ["genre.drama"]],
    ["comedy", ["genre.comedy"]],
    ["crime", ["genre.crime"]],
    ["animation", ["genre.animation"]],
    ["documentary", ["genre.documentary"]],
  ];

  for (const [key, metricIds] of directMappings) {
    const id = TV_GENRE_IDS[key];
    if (genreIdSet.has(id)) {
      for (const metricId of metricIds) {
        features[metricId] = {
          strength: clampStrength(FEATURE_STRENGTH.directGenre),
          confidence: clampConfidence(FEATURE_CONFIDENCE.directGenre),
          source: "tmdb",
          evidence: [String(id)],
          state: "present",
        };
      }
    }
  }

  // TV Sci-Fi & Fantasy birleşik ID (10765) → iki metriği de düşük/orta confidence ile işaretle
  if (genreIdSet.has(TV_GENRE_IDS.scifi_fantasy)) {
    // Her iki metriğe de aynı confidence (tvCombinedScifiFantasy = 0.75) ver
    features["genre.scifi"] = {
      strength: clampStrength(FEATURE_STRENGTH.directGenre),
      confidence: clampConfidence(FEATURE_CONFIDENCE.tvCombinedScifiFantasy),
      source: "tmdb",
      evidence: [String(TV_GENRE_IDS.scifi_fantasy)],
      state: "present",
    };
    features["genre.fantasy"] = {
      strength: clampStrength(FEATURE_STRENGTH.directGenre),
      confidence: clampConfidence(FEATURE_CONFIDENCE.tvCombinedScifiFantasy),
      source: "tmdb",
      evidence: [String(TV_GENRE_IDS.scifi_fantasy)],
      state: "present",
    };
  }

  // TV'de horror/thriller/romance için ayrı genre ID YOK → keyword'den türetilmeli
  // Keyword mapping olmadan bu metrikler üretilmez (unknown kalır)

  return features;
}

/** Keyword ID'ler → metric feature'ları üretir (KEYWORD_TO_METRIC boşsa hiçbir şey üretme) */
function extractKeywordFeatures(
  keywords: Array<{ id: number; name?: string }>
): Record<string, ContentFeature> {
  const features: Record<string, ContentFeature> = {};

  // Keyword ID mapping boşsa → hiçbir metin eşleşmesi yapma (Faz 2 kuralı)
  if (Object.keys(KEYWORD_TO_METRIC).length === 0) {
    return features; // boş → ilgili metrikler unknown kalır
  }

  for (const kw of keywords) {
    const metricId = KEYWORD_TO_METRIC[kw.id];
    if (!metricId) continue;

    // Yalnızca sayısal ID eşleşmesi — keyword.name string matching YASAK
    const existing = features[metricId];
    if (!existing) {
      features[metricId] = {
        strength: clampStrength(FEATURE_STRENGTH.keywordStrong),
        confidence: clampConfidence(FEATURE_CONFIDENCE.keyword),
        source: "tmdb",
        evidence: [String(kw.id)],
        state: "present",
      };
    } else {
      // Aynı metriğe birden fazla keyword eşleşti → evidence'a ekle, gücü artırma
      existing.evidence = [...(existing.evidence ?? []), String(kw.id)];
    }
  }

  return features;
}

/** Origin metrikleri (original_language + production_countries/origin_country) */
function extractOriginFeatures(
  originalLanguage: string | undefined,
  productionCountries: string[] | undefined,
  originCountry: string[] | undefined
): Record<string, ContentFeature> {
  const features: Record<string, ContentFeature> = {};
  const lang = originalLanguage ?? "";
  const countries = new Set([
    ...(productionCountries ?? []),
    ...(originCountry ?? []),
  ]);

  // Asya sineması
  if (
    ORIGIN_RULES.asian_cinema.languages.includes(lang as never) ||
    ORIGIN_RULES.asian_cinema.countries.some((c) => countries.has(c))
  ) {
    features["origin.asian_cinema"] = {
      strength: clampStrength(FEATURE_STRENGTH.origin),
      confidence: clampConfidence(FEATURE_CONFIDENCE.origin),
      source: "tmdb",
      evidence: [lang, ...Array.from(countries)].filter(Boolean),
      state: "present",
    };
  }

  // Avrupa sineması
  if (ORIGIN_RULES.european.countries.some((c) => countries.has(c))) {
    features["origin.european"] = {
      strength: clampStrength(FEATURE_STRENGTH.origin),
      confidence: clampConfidence(FEATURE_CONFIDENCE.origin),
      source: "tmdb",
      evidence: Array.from(countries).filter((c) =>
        ORIGIN_RULES.european.countries.includes(c as never)
      ),
      state: "present",
    };
  }

  // Türk sineması
  if (
    ORIGIN_RULES.turkish.languages.includes(lang as never) ||
    ORIGIN_RULES.turkish.countries.some((c) => countries.has(c))
  ) {
    features["origin.turkish"] = {
      strength: clampStrength(FEATURE_STRENGTH.origin),
      confidence: clampConfidence(FEATURE_CONFIDENCE.origin),
      source: "tmdb",
      evidence: [lang, ...Array.from(countries)].filter(Boolean),
      state: "present",
    };
  }

  return features;
}

/** Format metrikleri — sadece TV için */
function extractFormatFeatures(
  mediaType: "movie" | "tv",
  numberOfSeasons: number | undefined,
  episodeRunTime: number[] | undefined
): Record<string, ContentFeature> {
  const features: Record<string, ContentFeature> = {};

  // Format metrikleri sadece TV için geçerli
  if (mediaType !== "tv") return features;

  const seasons = numberOfSeasons ?? 0;
  const maxRunTime = episodeRunTime && episodeRunTime.length > 0
    ? Math.max(...episodeRunTime)
    : 0;

  // format.miniseries: number_of_seasons === 1 VE episode_run_time > 40
  if (
    seasons === FORMAT_RULES.miniseries.seasons &&
    maxRunTime > FORMAT_RULES.miniseries.minEpisodeRuntime
  ) {
    features["format.miniseries"] = {
      strength: clampStrength(FEATURE_STRENGTH.format),
      confidence: clampConfidence(FEATURE_CONFIDENCE.format),
      source: "tmdb",
      evidence: [`seasons:${seasons}`, `maxRunTime:${maxRunTime}`],
      state: "present",
    };
  }

  // format.long_running: number_of_seasons >= 3
  if (seasons >= FORMAT_RULES.long_running.minSeasons) {
    features["format.long_running"] = {
      strength: clampStrength(FEATURE_STRENGTH.format),
      confidence: clampConfidence(FEATURE_CONFIDENCE.format),
      source: "tmdb",
      evidence: [`seasons:${seasons}`],
      state: "present",
    };
  }

  return features;
}

/**
 * Tamamlanma oranı hesapla:
 * (üretilen aktif feature sayısı) / (toplam aktif metrik sayısı)
 */
function computeCompleteness(
  features: Record<string, ContentFeature>,
  mediaType: "movie" | "tv"
): number {
  const activeMetrics = TAXONOMY_V01.filter(
    (m) => m.scoringEnabled && m.applicableMedia.includes(mediaType)
  );
  if (activeMetrics.length === 0) return 0;
  const covered = activeMetrics.filter((m) => features[m.id] !== undefined).length;
  return Math.round((covered / activeMetrics.length) * 100) / 100;
}

/**
 * TMDB metadata'dan ContentTasteItem üretir.
 *
 * - LLM çağrısı YOK
 * - Metin/overview eşleştirmesi YOK
 * - Keyword name string matching YOK
 * - Sadece sayısal TMDB genre ID + keyword ID kullanılır
 * - Keyword mapping boşsa → unknown bırak, absent yazma
 * - Shadow metrikler hesaplanır ama state'i "unknown" kalır (aktif feature sayılmaz)
 */
export function extractContentTasteItem(input: TasteMetadataInput): ContentTasteItem {
  const features: Record<string, ContentFeature> = {};

  const genreIds = input.genreIds ?? [];
  const keywords = input.keywords ?? [];

  // 1. Genre features
  const genreFeatures =
    input.mediaType === "movie"
      ? extractMovieGenreFeatures(genreIds)
      : extractTvGenreFeatures(genreIds);

  Object.assign(features, genreFeatures);

  // 2. Keyword features (mevcut direct genre gücünü/güvenini düşürmeden kanıtları birleştir)
  const kwFeatures = extractKeywordFeatures(keywords);
  for (const [metricId, kwFeat] of Object.entries(kwFeatures)) {
    const existing = features[metricId];
    if (!existing) {
      features[metricId] = kwFeat;
    } else {
      existing.evidence = [...(existing.evidence ?? []), ...(kwFeat.evidence ?? [])];
    }
  }

  // 3. Origin features
  const originFeatures = extractOriginFeatures(
    input.originalLanguage,
    input.productionCountries,
    input.originCountry
  );
  Object.assign(features, originFeatures);

  // 4. Format features (sadece TV)
  const formatFeatures = extractFormatFeatures(
    input.mediaType,
    input.numberOfSeasons,
    input.episodeRunTime
  );
  Object.assign(features, formatFeatures);

  // 5. Shadow metrikler: scoringEnabled=false olanlar feature listesine girmez
  //    (genre/keyword extraction bunları üretemez zaten — taxonomy'de yalnızca
  //     heuristic shadow metrikler bu gruba dahil, bunlar için veri kaynağı yok)
  //    Shadow metrikler için hiçbir feature üretilmez → profilde etkisiz kalır.

  const metadataHash = buildMetadataHash(input);
  const completeness = computeCompleteness(features, input.mediaType);

  return {
    contentId: input.contentId,
    mediaType: input.mediaType,
    extractedAt: new Date().toISOString(),
    metadataHash,
    completeness,
    features,
  };
}

// ===========================================================================
// Cinethos Taste Engine — Versioned Constants (v1.0)
// Tüm sabitler sürümlüdür; değiştirildiğinde algorithmConfigVersion artar.
// ===========================================================================

export const TASTE_SCHEMA_VERSION = "1.0.0";
export const TAXONOMY_VERSION = "v0.1";
export const ALGORITHM_VERSION = "v1.0";
export const CONFIG_VERSION = "v1.1";

// === HESAPLAMA SABİTLERİ ===
export const SHRINKAGE_K = 2.5;                    // k_m (TP-021)
export const HALF_LIFE_RECENT_DAYS = 180;           // TP-029
export const HALF_LIFE_LONG_TERM_DAYS = 730;        // TP-029
export const PER_CONTENT_CAP = 1.0;                 // kategori başına üst sınır (TP-022)
export const SERIES_CLUSTER_CONTRIBUTION_CAP = 5;   // seri kümesi tavanı
export const MIN_EVIDENCE_FOR_DIRECTIONAL = 3;      // durum eşiği (§6.3)

// === DAVRANIŞ SİNYAL TABLOSU (TP-015/017/019) ===
export const BEHAVIOR_SIGNALS = {
  rating_9_10: +1.00,
  rating_8_89: +0.75,
  rating_7_79: +0.45,
  rating_5_69: 0,           // nötr, paydada kalır
  rating_3_49: -0.55,
  rating_1_29: -1.00,       // 0 puan yok (Faz 0 bulgusu)
  quick_like: +0.75,
  quick_neutral: 0,
  quick_dislike: -0.55,
  watchlist: +0.25,         // niyet, kanıt sayacına girmez
  watching: +0.10,
  watched_no_rating: +0.25, // izlendi+tamamlandı, puan yok → zayıf pozitif kanıt
  not_interested: 0,        // öneri kontrolü, negatif tercih değil
  hidden: 0,                // kesin dışlama, sinyal üretmez
  abandoned_disliked: -0.80,
  abandoned_time: 0,
  abandoned_paused: +0.10,
} as const;

// === ÖNERİ AĞIRLIKLARI (§11.1) ===
export const RECOMMENDATION_WEIGHTS = {
  theme_concept: 0.20,
  genre: 0.15,
  mood: 0.15,
  narrative: 0.12,
  character: 0.10,
  style: 0.10,
  emotional: 0.08,
  sensory: 0.05,
  setting: 0.03,
  creator: 0.02,
} as const;

// === SINIRLAR (limits.ts'e eklenecek) ===
export const DEFAULT_MAX_TASTE_INDEX_BYTES = 50 * 1024 * 1024; // ~50 MiB
export const DEFAULT_MAX_TASTE_EVENTS = 100_000;
export const DEFAULT_MAX_METRIC_EVIDENCE_CACHE = 20;            // metrik başına

// === FAZ 2 — EXTRACTOR SABİTLERİ ===
export const EXTRACTOR_VERSION = "v1.0";
export const TMDB_MAPPING_VERSION = "tmdb-2026-11";

// Feature strength tablosu — 0-100 tamsayı (§4.3)
export const FEATURE_STRENGTH = {
  directGenre: 100,       // TMDB genre_id doğrudan eşleşmesi
  origin: 90,             // original_language / production_countries
  format: 85,             // number_of_seasons / episode_run_time
  keywordStrong: 80,      // KEYWORD_TO_METRIC eşleşmesi (yüksek özgünlük)
  keywordWeak: 60,        // KEYWORD_TO_METRIC eşleşmesi (düşük özgünlük)
  heuristicShadow: 50,    // shadow metrik (scoringEnabled=false)
} as const;

// Feature confidence tablosu — 0-1 arası
export const FEATURE_CONFIDENCE = {
  directGenre: 0.95,
  tvCombinedScifiFantasy: 0.75, // TV'de scifi+fantasy birleşik → her iki metrik de düşük/orta güven
  origin: 0.90,
  format: 0.85,
  keyword: 0.80,
  heuristicShadow: 0.50,
} as const;

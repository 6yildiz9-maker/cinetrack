// ===========================================================================
// CineTrack Taste Engine — Type Definitions (v1.1)
// Faz 1 + Faz 2 çıktısı. Değiştirilmeden önce ADR onayı gerekir.
// ===========================================================================

// === METRIC DEFINITION ===
export type TransferPolicy = "shared" | "limited_transfer" | "media_specific";
export type FeatureState = "present" | "absent" | "unknown";
export type DerivationType = "direct" | "keyword" | "heuristic" | "semantic";
export type MetricStatus = "candidate" | "validated" | "deferred" | "retired";
export type SpoilerRisk = "none" | "possible" | "high";

export interface MetricDefinition {
  id: string;               // örn: "concept.consciousness.artificial"
  categoryId: string;       // "genre" | "mood" | "narrative" | ...
  definition: string;       // İnsan okunabilir tanım
  parentId?: string;        // Hiyerarşik üst metrik
  semanticGroup?: string;   // Eşdeğer etiket sönümlemesi (TP-013)
  sourceFields: string[];   // TMDB alanları (örn: ["genre_ids"])
  derivationType: DerivationType;
  applicableMedia: Array<"movie" | "tv">;
  transferPolicy: TransferPolicy;
  scoringEnabled: boolean;  // false = gölge metrik (V1'de profile girmez)
  status: MetricStatus;
  evidenceRequirement: string; // Kanıt gereksinimi açıklaması
  spoilerRisk: SpoilerRisk;
  defaultConfidence: number;   // 0-1 arası varsayılan güven
  mappingVersion: string;      // TMDB eşleme sürümü
}

// === TASTE EVENT (Event Sourcing) ===
export type TasteEventType =
  | "rating_changed"
  | "status_changed"
  | "content_hidden"     // preferences.hidden → kesin dışlama, sinyal üretmez
  | "content_disliked"   // preferences.disliked → negatif tercih sinyali (Faz 1 kapanış düzeltmesi)
  | "manual_preference_changed";

export type RatingSource = "numeric" | "quick";
export type AbandonReason = "disliked" | "time" | "access" | "paused";
export type TimeSource = "actual" | "imported";
export type TimePrecision = "exact" | "approximate" | "unknown";

export interface TasteEvent {
  eventId: string;          // crypto.randomUUID(), idempotent (TP-005)
  contentId: string;        // "movie:123" veya "tv:456"
  eventType: TasteEventType;
  payload: {
    previousValue?: unknown;
    newValue: unknown;
    ratingSource?: RatingSource; // TP-019: hızlı yanıt sayısal puanı ezmez
    reason?: AbandonReason;      // TP-017: bırakma nedenleri
  };
  recordedAt: string;        // ISO — sisteme giriş
  experiencedAt?: string;    // ISO — izleme tarihi (bilinmiyorsa recordedAt)
  timeSource: TimeSource;    // imported → recent/long-term'e girmez (TP-029)
  timePrecision: TimePrecision;
}

// === CONTENT FEATURE (Faz 2) ===
export interface ContentFeature {
  strength: number;    // 0-100 tamsayı (§4.3)
  confidence: number;  // 0-1
  source: "tmdb" | "semantic" | "inferred" | "manual";
  evidence?: string[]; // kanıt ID'leri (ör. genre ID listesi)
  state?: "present" | "absent" | "unknown";
}

// === CONTENT INDEX ITEM ===
export interface ContentTasteItem {
  contentId: string;
  mediaType: "movie" | "tv";
  extractedAt: string;
  metadataHash: string; // hash(metadata + extractorVersion + mappingVersion + taxonomyVersion)
  completeness: number; // 0-1 arası: kaç metriğin feature ürettiğinin oranı
  features: Record<string, ContentFeature>;
}

// === CONTENT INDEX (üst sarmalayıcı) ===
export interface ContentTasteIndex {
  schemaVersion: string;
  revision: number;
  updatedAt: string;
  extractorVersion: string;
  taxonomyVersion: string;
  mappingVersion: string;
  items: Record<string, ContentTasteItem>;
}

// === TMDB METADATA INPUT (Faz 2) ===
export interface TasteMetadataInput {
  contentId: string;        // "movie:123" / "tv:456" — makeMediaKey'den gelir
  mediaType: "movie" | "tv";
  tmdbId: number;

  genreIds?: number[];
  keywords?: Array<{ id: number; name?: string }>;

  originalLanguage?: string;
  productionCountries?: string[];
  originCountry?: string[];

  runtime?: number;           // film süresi (dk)
  episodeRunTime?: number[];  // dizi bölüm süreleri
  numberOfSeasons?: number;

  releaseDate?: string;
  firstAirDate?: string;

  overview?: string;  // V1'de kullanılmaz (LLM yok, metin eşleştirme yok)
  castCount?: number;

  raw?: unknown; // orijinal TMDB yanıtı (debug/future use)
}

// === INDEX BUILD STATS (Faz 2) ===
export interface TasteIndexBuildStats {
  processed: number;
  created: number;
  updated: number;
  skippedByHash: number;
  unknownFeatureCount: number;
  shadowFeatureCount: number;
  warnings: string[];
}

// === TASTE PROFILE ===
export type MetricState =
  | "unknown"
  | "directional"
  | "neutral"
  | "mixed"
  | "excluded";
// "contextual" V2'de eklenecek (§6.3)

export type ManualOverrideMode = "replace" | "boost" | "suppress" | "exclude";

export interface TasteFeatureObjection {
  contentId: string;
  metricId: string;
  createdAt: string;
}

export interface TasteMetric {
  metricId: string;
  affinity: number;          // -100...+100
  longTermAffinity: number;
  recentAffinity: number;
  status: MetricState;
  evidence: {
    posMass: number;
    negMass: number;
    uncertainMass: number;
    topPositiveContentIds: string[]; // en çok + katkı veren 3 içerik
    topNegativeContentIds: string[]; // en çok - katkı veren 3 içerik
  };
  manualOverride?: {
    value: number;
    mode: ManualOverrideMode;
  };
}

export interface TasteProfile {
  mediaType: "unified" | "movie" | "series";
  algorithmVersion: string;
  taxonomyVersion: string;
  asOf: string; // determinizm sözleşmesi (TP-003)
  metrics: Record<string, TasteMetric>;
}

// === MANIFEST ===
export interface TasteManifest {
  generationId: string;
  taxonomyVersion: string;
  algorithmVersion: string;
  configVersion: string;
  asOf: string;
  files: {
    taxonomy: string;
    index: string;
    events: string;
    profile: string;
  };
  eventWatermark: string; // son işlenen eventId
}

// === MIGRATION ===
export interface MigrationResult {
  eventsCreated: number;
  eventsSkipped: number;
  warnings: string[];
  completedAt: string;
}

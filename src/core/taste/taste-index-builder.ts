// ===========================================================================
// CineTrack Taste Engine — Taste Index Builder v1.0
//
// Sorumluluk: Toplu içerik listesini indeksler.
//
// Kurallar:
// - metadataHash aynı ise yeniden extract yapma (skippedByHash++)
// - Yeni içerik indirilmesi kullanıcı zevkini değiştirmez (profil hesaplanmaz)
// - Index dosyası: schemaVersion, revision, updatedAt, extractorVersion,
//   taxonomyVersion, mappingVersion, items taşımalı
// - data/cinetrack-data.json'a kesinlikle yazma
// ===========================================================================

import type {
  TasteMetadataInput,
  ContentTasteIndex,
  ContentTasteItem,
  TasteIndexBuildStats,
} from "./types.ts";
import { TAXONOMY_V01 } from "./taxonomy.ts";
import { extractContentTasteItem, buildMetadataHash, shouldReextract } from "./feature-extractor.ts";
import { normalizeContentFeatures } from "./feature-normalizer.ts";
import {
  TASTE_SCHEMA_VERSION,
  EXTRACTOR_VERSION,
  TAXONOMY_VERSION,
  TMDB_MAPPING_VERSION,
} from "./constants.ts";

/** Boş ContentTasteIndex oluşturur */
export function createEmptyTasteIndex(options?: {
  extractorVersion?: string;
  taxonomyVersion?: string;
  mappingVersion?: string;
}): ContentTasteIndex {
  return {
    schemaVersion: TASTE_SCHEMA_VERSION,
    revision: 0,
    updatedAt: new Date().toISOString(),
    extractorVersion: options?.extractorVersion ?? EXTRACTOR_VERSION,
    taxonomyVersion: options?.taxonomyVersion ?? TAXONOMY_VERSION,
    mappingVersion: options?.mappingVersion ?? TMDB_MAPPING_VERSION,
    items: {},
  };
}

/**
 * Toplu içerik listesini indeksler.
 *
 * @param inputs - İşlenecek TMDB metadata girişleri
 * @param existingIndex - Mevcut index (boş olabilir)
 * @param options - Sürüm bilgileri ve zaman damgası
 * @returns Güncellenmiş index ve işlem istatistikleri
 */
export function buildTasteIndex(
  inputs: TasteMetadataInput[],
  existingIndex: ContentTasteIndex,
  options: {
    asOf: string;
    extractorVersion: string;
    taxonomyVersion: string;
    mappingVersion: string;
  }
): {
  index: ContentTasteIndex;
  stats: TasteIndexBuildStats;
} {
  const stats: TasteIndexBuildStats = {
    processed: 0,
    created: 0,
    updated: 0,
    skippedByHash: 0,
    unknownFeatureCount: 0,
    shadowFeatureCount: 0,
    warnings: [],
  };

  // Mevcut index'i kopyala (mutasyon önleme)
  const newItems: Record<string, ContentTasteItem> = { ...existingIndex.items };

  // Shadow metrik ID listesi (istatistik için)
  const shadowMetricIds = new Set(
    TAXONOMY_V01.filter((m) => !m.scoringEnabled).map((m) => m.id)
  );

  // Aktif metrik sayısı (completeness hesabı için)
  const totalActiveMetrics = TAXONOMY_V01.filter((m) => m.scoringEnabled).length;

  for (const input of inputs) {
    stats.processed++;

    // contentId doğrulama
    if (!input.contentId || !/^(movie|tv):[A-Za-z0-9_-]+$/.test(input.contentId)) {
      stats.warnings.push(`Geçersiz contentId: ${input.contentId}`);
      continue;
    }

    const incomingHash = buildMetadataHash(input);
    const existing = newItems[input.contentId];

    // metadataHash aynı ise yeniden extract yapma
    if (!shouldReextract(existing, incomingHash)) {
      stats.skippedByHash++;
      continue;
    }

    // Extract + normalize
    const rawItem = extractContentTasteItem(input);
    const normalizedFeatures = normalizeContentFeatures(
      rawItem.features,
      TAXONOMY_V01
    );

    const item: ContentTasteItem = {
      ...rawItem,
      features: normalizedFeatures,
    };

    // İstatistik: unknown feature sayısı
    // (toplam aktif metrik - üretilen feature sayısı = unknown kalan metrik sayısı)
    const activeMetricsForMediaType = TAXONOMY_V01.filter(
      (m) => m.scoringEnabled && m.applicableMedia.includes(input.mediaType)
    ).length;
    const coveredFeatures = Object.keys(normalizedFeatures).length;
    stats.unknownFeatureCount += Math.max(0, activeMetricsForMediaType - coveredFeatures);

    // İstatistik: shadow feature sayısı (extract sonrası temizlendi ama sayıyoruz)
    for (const metricId of Object.keys(rawItem.features)) {
      if (shadowMetricIds.has(metricId)) {
        stats.shadowFeatureCount++;
      }
    }

    // Uyarı: hiç feature üretilemediyse
    if (coveredFeatures === 0 && totalActiveMetrics > 0) {
      stats.warnings.push(
        `'${input.contentId}' için hiç aktif feature üretilemedi (keyword mapping eksik olabilir)`
      );
    }

    if (existing) {
      stats.updated++;
    } else {
      stats.created++;
    }

    newItems[input.contentId] = item;
  }

  const newIndex: ContentTasteIndex = {
    schemaVersion: TASTE_SCHEMA_VERSION,
    revision: existingIndex.revision + 1,
    updatedAt: options.asOf,
    extractorVersion: options.extractorVersion,
    taxonomyVersion: options.taxonomyVersion,
    mappingVersion: options.mappingVersion,
    items: newItems,
  };

  return { index: newIndex, stats };
}

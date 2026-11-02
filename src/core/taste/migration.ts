// ===========================================================================
// CineTrack Taste Engine — Migration Service (v1.1)
// Eski cinetrack-data.json → yeni taste-events.json dönüşümü (TP-029)
// KRİTİK: cinetrack-data.json ASLA değiştirilmez, sadece okunur
// ===========================================================================

import type { TasteEvent, MigrationResult } from "./types";
import type { DataDocument, SavedItem } from "../cinetrack-core";

export interface MigrationInput {
  dataDocument: DataDocument;
  asOf: string;
}

/**
 * Eski veriyi yeni olay formatına dönüştür
 *
 * KRİTİK KURALLAR:
 * 1. cinetrack-data.json ASLA değiştirilmez
 * 2. Tüm geçmiş timeSource: "imported" (Faz 0: ratedAt/watchedAt yok)
 * 3. contentId formatı makeMediaKey'ten alınır
 * 4. preferences.disliked → content_disliked (TP-018)
 * 5. preferences.hidden → content_hidden (TP-018)
 * 6. Aynı contentId için çift yazım yok
 */
export function migrateExistingData(input: MigrationInput): {
  events: TasteEvent[];
  result: MigrationResult;
} {
  const { dataDocument, asOf } = input;
  const events: TasteEvent[] = [];
  const processedContentIds = new Set<string>();
  const warnings: string[] = [];
  let eventsCreated = 0;
  let eventsSkipped = 0;

  // Aktif profili bul
  const activeProfile = dataDocument.profiles.find(
    (p) => p.id === dataDocument.activeProfileId
  );

  if (!activeProfile) {
    warnings.push("Aktif profil bulunamadı");
    return {
      events: [],
      result: {
        eventsCreated: 0,
        eventsSkipped: 0,
        warnings,
        completedAt: asOf,
      },
    };
  }

  // 1. Puanlı kayıtlar → rating_changed olayları
  for (const item of activeProfile.items) {
    const contentId = makeContentId(item);
    if (!contentId) {
      eventsSkipped++;
      continue;
    }

    // Çift yazım kontrolü
    if (processedContentIds.has(contentId)) {
      warnings.push(`Çift kayıt atlandı: ${contentId}`);
      eventsSkipped++;
      continue;
    }

    // Puan kontrolü
    const rawRating = item.personal_rating;
    const hasRating =
      rawRating !== "" &&
      rawRating !== null &&
      rawRating !== undefined &&
      Number(rawRating) >= 1 &&
      Number(rawRating) <= 10;

    if (!hasRating) {
      eventsSkipped++;
      continue;
    }

    {
      const rating = Number(rawRating);
      const event: TasteEvent = {
        eventId: newUUID(),
        contentId,
        eventType: "rating_changed",
        payload: {
          newValue: rating,
          ratingSource: "numeric",
        },
        recordedAt:
          item.updatedAt ||
          item.firstAddedAt ||
          item.addedAt ||
          asOf,
        experiencedAt: undefined, // ratedAt yok (Faz 0 bulgusu)
        timeSource: "imported",   // KRİTİK: tüm geçmiş imported
        timePrecision: "unknown", // KRİTİK: tarih kesinliği bilinmiyor
      };
      events.push(event);
      processedContentIds.add(contentId);
      eventsCreated++;
    }
  }

  // 2. preferences.disliked → content_disliked olayları (TP-018)
  if (activeProfile.preferences.disliked) {
    for (const contentId of activeProfile.preferences.disliked) {
      if (!contentId || typeof contentId !== "string") {
        eventsSkipped++;
        continue;
      }

      // contentId format doğrulama: "movie:N" veya "tv:N"
      if (!/^(movie|tv):[A-Za-z0-9_-]+$/.test(contentId)) {
        warnings.push(`Geçersiz disliked key formatı: ${contentId}`);
        eventsSkipped++;
        continue;
      }

      // Çift durum uyarısı (veri silme yok)
      if (processedContentIds.has(contentId)) {
        warnings.push(`Çift durum: ${contentId} hem items hem disliked'da`);
        // disliked olay ekleme — sadece uyarı ver, olay ekle
      }

      const event: TasteEvent = {
        eventId: newUUID(),
        contentId,
        eventType: "content_disliked", // TP-018: content_hidden değil!
        payload: {
          newValue: true,
        },
        recordedAt: asOf,
        timeSource: "imported",
        timePrecision: "unknown",
      };
      events.push(event);
      processedContentIds.add(contentId);
      eventsCreated++;
    }
  }

  // 3. preferences.hidden → content_hidden olayları (TP-018)
  if (activeProfile.preferences.hidden) {
    for (const contentId of activeProfile.preferences.hidden) {
      if (!contentId || typeof contentId !== "string") {
        eventsSkipped++;
        continue;
      }

      const event: TasteEvent = {
        eventId: newUUID(),
        contentId,
        eventType: "content_hidden", // TP-018: nötr dışlama
        payload: {
          newValue: true,
        },
        recordedAt: asOf,
        timeSource: "imported",
        timePrecision: "unknown",
      };
      events.push(event);
      processedContentIds.add(contentId);
      eventsCreated++;
    }
  }

  return {
    events,
    result: {
      eventsCreated,
      eventsSkipped,
      warnings,
      completedAt: asOf,
    },
  };
}

/**
 * SavedItem'dan contentId üret
 * makeMediaKey desenini kullan (src/core/keys.ts)
 * Sonuç: "movie:123" / "tv:456"
 */
function makeContentId(item: SavedItem): string | null {
  if (!item.id || !item.media_type) {
    return null;
  }
  const mediaType =
    item.media_type === "movie"
      ? "movie"
      : item.media_type === "tv"
      ? "tv"
      : null;
  if (!mediaType) {
    return null;
  }
  return `${mediaType}:${item.id}`;
}

/** UUID üret (Node.js crypto / Web Crypto uyumlu) */
function newUUID(): string {
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as Record<string, unknown>).crypto === "object" &&
    typeof (
      (globalThis as Record<string, unknown>).crypto as Record<string, unknown>
    ).randomUUID === "function"
  ) {
    return (
      (globalThis as Record<string, unknown>).crypto as { randomUUID: () => string }
    ).randomUUID();
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID } = require("crypto") as { randomUUID: () => string };
  return randomUUID();
}

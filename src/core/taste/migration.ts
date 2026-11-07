// ===========================================================================
// Cinethos Taste Engine — Migration Service (v1.5)
// Eski cinetrack-data.json → yeni taste-events.json dönüşümü (TP-029 & V1.5)
// KRİTİK: cinetrack-data.json ASLA değiştirilmez, sadece okunur
// ===========================================================================

import type { TasteEvent, MigrationResult, TimeSource, TimePrecision } from "./types.ts";
import type { DataDocument, SavedItem } from "../cinetrack-core.ts";
import { resolveExperiencedAt } from "./temporal-analyzer.ts";

export interface MigrationInput {
  dataDocument: DataDocument;
  asOf: string;
}

function validOptionalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : undefined;
}

/**
 * Eski veriyi yeni olay formatına dönüştür
 *
 * KRİTİK KURALLAR:
 * 1. cinetrack-data.json ASLA değiştirilmez
 * 2. Eski kayıtlarda ratedAt/completedAt yoksa timeSource: "imported" ve timePrecision: "unknown" (Faz 0)
 * 3. V1.5 yeni kayıtlarda ratedAt/completedAt mevcutsa timeSource: "actual" ve timePrecision: "exact"
 * 4. contentId formatı makeMediaKey'ten alınır
 * 5. preferences.disliked → content_disliked (TP-018)
 * 6. preferences.hidden → content_hidden (TP-018)
 * 7. Aynı contentId için çift yazım yok
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

  if (!dataDocument || !Array.isArray(dataDocument.profiles)) {
    warnings.push("Geçersiz veri belgesi veya profiller eksik");
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

  // Aktif profili bul
  const activeProfile = dataDocument.profiles.find(
    (p) => p && p.id === dataDocument.activeProfileId
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

  // 1. Puanlı kayıtlar → rating_changed; puansız tamamlananlar → status_changed
  const items = Array.isArray(activeProfile.items) ? activeProfile.items : [];
  const dislikedSet = new Set(
    Array.isArray(activeProfile.preferences?.disliked)
      ? activeProfile.preferences.disliked.filter((v): v is string => typeof v === "string")
      : []
  );
  for (const item of items) {
    if (!item || typeof item !== "object") {
      eventsSkipped++;
      continue;
    }

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
      // Puan yok ama içerik tamamlanmışsa zayıf pozitif izleme kanıtı üret.
      // Beğenmeme (disliked) daha güçlü negatif sinyaldir; onu gölgelememek için atlanır.
      const isCompleted = item.status === "completed";
      if (!isCompleted || dislikedSet.has(contentId)) {
        eventsSkipped++;
        continue;
      }

      const validCompletedAt = validOptionalTimestamp(item.completedAt);
      const fallbackRecordedAt =
        validCompletedAt ||
        validOptionalTimestamp(item.updatedAt) ||
        validOptionalTimestamp(item.addedAt) ||
        asOf;

      events.push({
        eventId: newUUID(),
        contentId,
        eventType: "status_changed",
        payload: {
          previousValue: null,
          newValue: "completed",
        },
        recordedAt: fallbackRecordedAt,
        experiencedAt: fallbackRecordedAt,
        timeSource: validCompletedAt ? "actual" : "imported",
        timePrecision: validCompletedAt ? "exact" : "unknown",
      });
      processedContentIds.add(contentId);
      eventsCreated++;
      continue;
    }

    {
      const rating = Number(rawRating);
      const validRatedAt = validOptionalTimestamp(item.ratedAt);
      const validCompletedAt = validOptionalTimestamp(item.completedAt);
      const hasV15Timestamp = Boolean(validRatedAt || validCompletedAt);

      // Eski kayıtlarda ratedAt/completedAt eksikse hata vermeden "imported" / "unknown" olarak işlenir (Faz 0)
      const timeSource: TimeSource = hasV15Timestamp ? "actual" : "imported";
      const timePrecision: TimePrecision = hasV15Timestamp ? "exact" : "unknown";
      const experiencedAt = resolveExperiencedAt(
        {
          ratedAt: validRatedAt,
          completedAt: validCompletedAt,
          updatedAt: validOptionalTimestamp(item.updatedAt),
          addedAt: validOptionalTimestamp(item.addedAt),
        },
        timeSource
      );

      const event: TasteEvent = {
        eventId: newUUID(),
        contentId,
        eventType: "rating_changed",
        payload: {
          newValue: rating,
          ratingSource: "numeric",
        },
        recordedAt:
          validRatedAt ||
          validCompletedAt ||
          item.updatedAt ||
          item.firstAddedAt ||
          item.addedAt ||
          asOf,
        experiencedAt,
        timeSource,
        timePrecision,
      };
      events.push(event);
      processedContentIds.add(contentId);
      eventsCreated++;
    }
  }

  // 2. preferences.disliked → content_disliked olayları (TP-018)
  if (Array.isArray(activeProfile.preferences?.disliked)) {
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
  if (Array.isArray(activeProfile.preferences?.hidden)) {
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

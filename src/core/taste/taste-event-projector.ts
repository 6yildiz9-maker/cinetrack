// ===========================================================================
// Cinethos Taste Engine — Taste Event Projector (v1.0)
// Olay → geçerli öğrenme durumu (TP-005)
// ===========================================================================

import type { TasteEvent } from "./types.ts";

export interface LearningState {
  contentId: string;
  currentRating?: number;
  currentStatus?: string;
  isHidden: boolean;
  isDisliked: boolean;       // content_disliked olayından (Faz 1 kapanış düzeltmesi)
  lastEventId: string;
  lastUpdatedAt: string;
}

/**
 * Olayları içerik başına geçerli öğrenme durumuna indirge (TP-005)
 *
 * KRİTİK: Olay ≠ kanıt. Aynı içeriğin beş işlemi beş bağımsız kanıt değil.
 * Bu fonksiyon yalnızca her içerik için SON geçerli durumu döndürür;
 * kanıt ağırlıkları EvidenceLedger tarafından hesaplanır.
 */
export function projectEventsToLearningState(events: TasteEvent[]): Map<string, LearningState> {
  const stateMap = new Map<string, LearningState>();

  // Olayları zamana göre sırala (en eski önce)
  const sortedEvents = [...events].sort(
    (a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime()
  );

  for (const event of sortedEvents) {
    const contentId = event.contentId;
    if (!contentId) continue;

    let state = stateMap.get(contentId);
    if (!state) {
      state = {
        contentId,
        isHidden: false,
        isDisliked: false,
        lastEventId: event.eventId,
        lastUpdatedAt: event.recordedAt,
      };
      stateMap.set(contentId, state);
    }

    // Olay tipine göre durumu güncelle
    if (event.eventType === "rating_changed") {
      state.currentRating = event.payload.newValue as number;
    } else if (event.eventType === "status_changed") {
      state.currentStatus = event.payload.newValue as string;
    } else if (event.eventType === "content_hidden") {
      state.isHidden = true;
    } else if (event.eventType === "content_disliked") {
      state.isDisliked = true;
    }

    state.lastEventId = event.eventId;
    state.lastUpdatedAt = event.recordedAt;
  }

  return stateMap;
}

/**
 * Faz 3 — Taste Event Projector Testleri
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectEventsToLearningState } from "../../src/core/taste/taste-event-projector.ts";

// === Fixture ===
let _cnt = 0;
function makeEvent(contentId, eventType, newValue, overrides = {}) {
  _cnt++;
  return {
    eventId: `e-${_cnt}`,
    contentId,
    eventType,
    payload: { previousValue: null, newValue },
    recordedAt: new Date(2026, 0, _cnt).toISOString(),
    timeSource: "actual",
    timePrecision: "exact",
    ...overrides,
  };
}

describe("Taste Event Projector — Temel", () => {
  it("Boş liste → boş Map", () => {
    const result = projectEventsToLearningState([]);
    assert.strictEqual(result.size, 0);
  });

  it("Tek rating_changed → currentRating ayarlanır", () => {
    const events = [makeEvent("movie:100", "rating_changed", 9)];
    const state = projectEventsToLearningState(events).get("movie:100");
    assert.ok(state);
    assert.strictEqual(state.currentRating, 9);
    assert.strictEqual(state.isHidden, false);
    assert.strictEqual(state.isDisliked, false);
  });

  it("content_hidden → isHidden: true", () => {
    const events = [makeEvent("movie:200", "content_hidden", true)];
    const state = projectEventsToLearningState(events).get("movie:200");
    assert.ok(state);
    assert.strictEqual(state.isHidden, true);
  });

  it("content_disliked → isDisliked: true", () => {
    const events = [makeEvent("movie:300", "content_disliked", "disliked")];
    const state = projectEventsToLearningState(events).get("movie:300");
    assert.ok(state);
    assert.strictEqual(state.isDisliked, true);
  });

  it("status_changed → currentStatus ayarlanır", () => {
    const events = [makeEvent("tv:400", "status_changed", "completed")];
    const state = projectEventsToLearningState(events).get("tv:400");
    assert.ok(state);
    assert.strictEqual(state.currentStatus, "completed");
  });
});

describe("Taste Event Projector — Olay ≠ Kanıt (TP-005)", () => {
  it("Aynı içerik için 5 olay → tek LearningState (kanıt sayısı değil durum)", () => {
    // 5 farklı olay ama hepsi movie:999 için
    const events = [
      makeEvent("movie:999", "status_changed", "watchlist"),
      makeEvent("movie:999", "status_changed", "watching"),
      makeEvent("movie:999", "status_changed", "completed"),
      makeEvent("movie:999", "rating_changed", 8),
      makeEvent("movie:999", "rating_changed", 9), // puan güncelleme
    ];
    const result = projectEventsToLearningState(events);
    assert.strictEqual(result.size, 1, "Tek içerik → tek LearningState");
    const state = result.get("movie:999");
    // Son değer geçerli
    assert.strictEqual(state?.currentRating, 9);
    assert.strictEqual(state?.currentStatus, "completed");
  });

  it("Puan değişimi → son puan geçerli (sonraki ezer)", () => {
    const events = [
      makeEvent("movie:500", "rating_changed", 5, { recordedAt: "2026-01-01T00:00:00.000Z" }),
      makeEvent("movie:500", "rating_changed", 9, { recordedAt: "2026-06-01T00:00:00.000Z" }),
    ];
    const state = projectEventsToLearningState(events).get("movie:500");
    assert.strictEqual(state?.currentRating, 9); // son puan geçerli
  });
});

describe("Taste Event Projector — Zaman Sıralaması", () => {
  it("Olaylar tarihe göre sıralanarak işlenir (eski önce)", () => {
    // Karışık sırayla ver
    const events = [
      makeEvent("movie:600", "rating_changed", 9, { recordedAt: "2026-06-01T00:00:00.000Z" }),
      makeEvent("movie:600", "rating_changed", 3, { recordedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const state = projectEventsToLearningState(events).get("movie:600");
    // Haziran (sonraki) olan 9 geçerli olmalı
    assert.strictEqual(state?.currentRating, 9);
  });
});

describe("Taste Event Projector — Çok İçerik", () => {
  it("Farklı içerikler ayrı state'e sahip olmalı", () => {
    const events = [
      makeEvent("movie:A", "rating_changed", 8),
      makeEvent("movie:B", "rating_changed", 4),
      makeEvent("tv:C", "content_hidden", true),
    ];
    const result = projectEventsToLearningState(events);
    assert.strictEqual(result.size, 3);
    assert.strictEqual(result.get("movie:A")?.currentRating, 8);
    assert.strictEqual(result.get("movie:B")?.currentRating, 4);
    assert.strictEqual(result.get("tv:C")?.isHidden, true);
  });
});

describe("Taste Event Projector — lastEventId / lastUpdatedAt", () => {
  it("lastEventId ve lastUpdatedAt son olayı yansıtmalı", () => {
    const events = [
      { eventId: "first", contentId: "movie:700", eventType: "rating_changed",
        payload: { previousValue: null, newValue: 7 },
        recordedAt: "2026-01-01T00:00:00.000Z", timeSource: "actual", timePrecision: "exact" },
      { eventId: "last", contentId: "movie:700", eventType: "rating_changed",
        payload: { previousValue: 7, newValue: 9 },
        recordedAt: "2026-11-01T00:00:00.000Z", timeSource: "actual", timePrecision: "exact" },
    ];
    const state = projectEventsToLearningState(events).get("movie:700");
    assert.strictEqual(state?.lastEventId, "last");
    assert.strictEqual(state?.lastUpdatedAt, "2026-11-01T00:00:00.000Z");
  });
});

/**
 * Faz 5 — Migration Service Testleri (DataDocument tabanlı)
 * BÖLÜM 6'daki kritik testler
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { migrateExistingData } from "../../src/core/taste/migration.ts";

const AS_OF = "2026-11-02T00:00:00.000Z";

// === Fixture ===
function makeDoc(overrides = {}) {
  return {
    version: 3,
    schemaVersion: 3,
    activeProfileId: "profile-default",
    profiles: [
      {
        id: "profile-default",
        name: "ibrahim",
        createdAt: "2026-01-01T00:00:00.000Z",
        preferences: { disliked: [], providers: [], mood: "", reminders: false, notified: [] },
        items: [],
        favoriteActors: [],
        ...overrides,
      },
    ],
    updatedAt: AS_OF,
  };
}

// === BÖLÜM 6 Kritik Test 1: tüm geçmiş imported ===

describe("Faz5 Migration — timeSource: imported (KRİTİK)", () => {
  it("Tüm geçmiş olaylar timeSource: imported, timePrecision: unknown olmalı", () => {
    const doc = makeDoc({
      items: [
        { id: 123, media_type: "movie", personal_rating: 9, updatedAt: "2020-01-01T00:00:00Z" },
        { id: 456, media_type: "tv",    personal_rating: 8, updatedAt: "2021-06-15T00:00:00Z" },
      ],
      preferences: {
        disliked: ["movie:789"],
        hidden:   ["tv:101"],
        providers: [], mood: "", reminders: false, notified: [],
      },
    });

    const { events } = migrateExistingData({ dataDocument: doc, asOf: AS_OF });

    for (const event of events) {
      assert.strictEqual(
        event.timeSource,
        "imported",
        `timeSource "imported" değil: ${event.contentId}`
      );
      assert.strictEqual(
        event.timePrecision,
        "unknown",
        `timePrecision "unknown" değil: ${event.contentId}`
      );
    }
  });
});

// === BÖLÜM 6 Kritik Test 2: disliked → content_disliked ===

describe("Faz5 Migration — preferences.disliked → content_disliked (TP-018)", () => {
  it("preferences.disliked → content_disliked (content_hidden değil)", () => {
    const doc = makeDoc({
      items: [],
      preferences: {
        disliked: ["movie:123"],
        providers: [], mood: "", reminders: false, notified: [],
      },
    });

    const { events } = migrateExistingData({ dataDocument: doc, asOf: AS_OF });
    const dislikedEvent = events.find((e) => e.contentId === "movie:123");

    assert.ok(dislikedEvent, "movie:123 için olay oluşturulmadı");
    assert.strictEqual(
      dislikedEvent.eventType,
      "content_disliked",
      "eventType content_disliked olmalı (content_hidden değil!)"
    );
  });

  it("preferences.hidden → content_hidden", () => {
    const doc = makeDoc({
      items: [],
      preferences: {
        hidden: ["tv:999"],
        providers: [], mood: "", reminders: false, notified: [],
      },
    });

    const { events } = migrateExistingData({ dataDocument: doc, asOf: AS_OF });
    const hiddenEvent = events.find((e) => e.contentId === "tv:999");

    assert.ok(hiddenEvent, "tv:999 için olay oluşturulmadı");
    assert.strictEqual(hiddenEvent.eventType, "content_hidden");
  });
});

// === BÖLÜM 6 Kritik Test 3: boş puanlar atlanır ===

describe("Faz5 Migration — Boş puanlar atlanır", () => {
  it("personal_rating boş olan kayıt atlanmalı, puanlı olan işlenmeli", () => {
    const doc = makeDoc({
      items: [
        { id: 123, media_type: "movie", personal_rating: "",  addedAt: AS_OF, updatedAt: AS_OF },
        { id: 456, media_type: "tv",    personal_rating: 9,   addedAt: AS_OF, updatedAt: AS_OF },
      ],
    });

    const { events } = migrateExistingData({ dataDocument: doc, asOf: AS_OF });

    assert.strictEqual(events.length, 1, "Yalnızca 1 olay olmalı");
    assert.strictEqual(events[0].contentId, "tv:456");
  });
});

// === contentId formatı ===

describe("Faz5 Migration — contentId formatı", () => {
  it("contentId 'movie:N' veya 'tv:N' formatında olmalı", () => {
    const doc = makeDoc({
      items: [
        { id: 550,  media_type: "movie", personal_rating: 8, addedAt: AS_OF, updatedAt: AS_OF },
        { id: 1396, media_type: "tv",    personal_rating: 9, addedAt: AS_OF, updatedAt: AS_OF },
      ],
    });

    const { events } = migrateExistingData({ dataDocument: doc, asOf: AS_OF });
    const contentIds = events.map((e) => e.contentId);

    assert.ok(contentIds.includes("movie:550"), "movie:550 yok");
    assert.ok(contentIds.includes("tv:1396"),   "tv:1396 yok");
    for (const cid of contentIds) {
      assert.match(cid, /^(movie|tv):\d+$/, `Geçersiz format: ${cid}`);
    }
  });
});

// === cinetrack-data.json değişmedi ===

describe("Faz5 Migration — Kaynak veri korunması", () => {
  it("dataDocument referansı mutation almaz", () => {
    const doc = makeDoc({
      items: [
        { id: 100, media_type: "movie", personal_rating: 7, addedAt: AS_OF, updatedAt: AS_OF },
      ],
    });
    const originalItemsLength = doc.profiles[0].items.length;

    migrateExistingData({ dataDocument: doc, asOf: AS_OF });

    assert.strictEqual(
      doc.profiles[0].items.length,
      originalItemsLength,
      "dataDocument mutasyona uğradı!"
    );
  });
});

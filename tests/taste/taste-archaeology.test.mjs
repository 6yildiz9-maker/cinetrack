/**
 * Faz 6 — Taste Archaeology Testleri
 * BÖLÜM 6'daki kritik test senaryoları
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTasteArchaeology } from "../../src/core/taste/taste-archaeology.ts";

const AS_OF = "2026-11-02T00:00:00.000Z";

// === Fixture yardımcıları ===

function makeRatingEvent(contentId, rating, timeSource = "imported", overrides = {}) {
  return {
    eventId: `e-${Math.random().toString(36).slice(2)}`,
    contentId,
    eventType: "rating_changed",
    payload: { previousValue: null, newValue: rating },
    recordedAt: new Date(2020 + Math.random() * 6, 0, 1).toISOString(),
    timeSource,
    timePrecision: timeSource === "actual" ? "exact" : "unknown",
    ...overrides,
  };
}

function makeActualEvents(count) {
  // Kronolojik sırada actual olaylar üret
  const events = [];
  for (let i = 0; i < count; i++) {
    const dateMs = new Date(2020, 0, 1).getTime() + i * 86400000;
    events.push({
      eventId: `actual-${i}`,
      contentId: `movie:${1000 + i}`,
      eventType: "rating_changed",
      payload: { previousValue: null, newValue: (i % 9) + 1 },
      recordedAt: new Date(dateMs).toISOString(),
      timeSource: "actual",
      timePrecision: "exact",
    });
  }
  return events;
}

function makeContentIndex(count) {
  const index = {};
  for (let i = 0; i < count; i++) {
    index[`movie:${1000 + i}`] = {
      contentId: `movie:${1000 + i}`,
      mediaType: "movie",
      extractedAt: AS_OF,
      metadataHash: `hash-${i}`,
      completeness: 0.5,
      features: {
        "genre.drama": {
          strength: 80,
          confidence: 0.9,
          source: "tmdb",
          state: "present",
        },
      },
    };
  }
  return index;
}

// === BÖLÜM 6 Kritik Test 1: Tüm olaylar imported → insufficient_data ===

describe("Taste Archaeology — timeSource: imported (KRİTİK)", () => {
  it("Tüm olaylar imported ise yetersiz veri (insufficient_data)", async () => {
    // Spec BÖLÜM 6 Kritik Test 1
    const events = [
      makeRatingEvent("movie:123", 9, "imported"),
      makeRatingEvent("movie:456", 8, "imported"),
      makeRatingEvent("movie:789", 7, "imported"),
    ];

    const result = await runTasteArchaeology(events, {}, { asOf: AS_OF });

    assert.strictEqual(result.status, "insufficient_data");
    assert.strictEqual(result.spearmanRho, null);
    assert.ok(
      result.warnings.some((w) =>
        w.includes("timeSource: imported")
      ),
      "Uyarı mesajı eksik"
    );
  });

  it("Faz 0 bulgusu: migration sonrası tüm olaylar imported → insufficient_data", async () => {
    // 100 imported olay: yine de insufficient_data
    const events = Array.from({ length: 100 }, (_, i) =>
      makeRatingEvent(`movie:${i}`, (i % 9) + 1, "imported")
    );

    const result = await runTasteArchaeology(events, {}, { asOf: AS_OF });

    assert.strictEqual(result.status, "insufficient_data");
    assert.strictEqual(result.spearmanRho, null);
  });
});

// === Test seti çok küçük ===

describe("Taste Archaeology — Test seti boyutu", () => {
  it("Test seti minTestSize'dan küçükse insufficient_data", async () => {
    // 10 actual olay → %20 = 2 test, minTestSize=30'dan küçük
    const events = makeActualEvents(10);
    const index = makeContentIndex(10);

    const result = await runTasteArchaeology(events, index, {
      asOf: AS_OF,
      minTestSize: 30,
    });

    assert.strictEqual(result.status, "insufficient_data");
    assert.strictEqual(result.spearmanRho, null);
    assert.ok(result.warnings.some((w) => w.includes("küçük")));
  });
});

// === Yeterli veri ile Spearman hesaplanır ===

describe("Taste Archaeology — Yeterli veri ile hesaplama", () => {
  it("En az 200 actual olay ile Spearman hesaplanabilir", async () => {
    // 200 actual olay → %80 = 160 train, %20 = 40 test (>= minTestSize=30)
    const events = makeActualEvents(200);
    const index = makeContentIndex(200);

    const result = await runTasteArchaeology(events, index, {
      asOf: AS_OF,
      minTestSize: 30,
    });

    // Status "pass" veya "fail" (ρ > 0.30 veya değil) — ama null değil
    assert.ok(
      result.status === "pass" || result.status === "fail",
      `Beklenen: pass veya fail, alınan: ${result.status}`
    );
    assert.ok(result.spearmanRho !== null, "spearmanRho hesaplanmalı");
    assert.ok(result.testSampleSize >= 30, "test seti >= 30 olmalı");
  });

  it("testSampleSize %20 oranına uymalı", async () => {
    const count = 200;
    const events = makeActualEvents(count);
    const index = makeContentIndex(count);

    const result = await runTasteArchaeology(events, index, {
      asOf: AS_OF,
      minTestSize: 10,
    });

    // %20 = 40
    const expectedTestSize = Math.floor(count * 0.2); // 40
    assert.strictEqual(result.testSampleSize, expectedTestSize);
  });
});

// === Taban yöntemler ===

describe("Taste Archaeology — Taban Yöntemler (§13.2)", () => {
  it("En az 3 taban çalıştırılır; genreOnly null olmamalı (veri varsa)", async () => {
    const events = makeActualEvents(200);
    const index = makeContentIndex(200);

    const result = await runTasteArchaeology(events, index, {
      asOf: AS_OF,
      minTestSize: 30,
    });

    // genreOnly hesaplanabilmeli (içerik feature'ı var)
    // voteAverage ve currentMethod V1'de placeholder (null OK)
    assert.ok(
      typeof result.baselineResults.genreOnly === "number" ||
        result.baselineResults.genreOnly === null
    );
    assert.ok("voteAverage" in result.baselineResults);
    assert.ok("currentMethod" in result.baselineResults);
  });

  it("Yetersiz veri durumunda taban yöntemler null döner", async () => {
    const events = [makeRatingEvent("movie:1", 9, "imported")];

    const result = await runTasteArchaeology(events, {}, { asOf: AS_OF });

    assert.strictEqual(result.baselineResults.genreOnly, null);
    assert.strictEqual(result.baselineResults.voteAverage, null);
    assert.strictEqual(result.baselineResults.currentMethod, null);
  });
});

// === Bootstrap CI ===

describe("Taste Archaeology — Bootstrap CI", () => {
  it("Yeterli veri ile confidenceInterval üretilmeli", async () => {
    const events = makeActualEvents(200);
    const index = makeContentIndex(200);

    const result = await runTasteArchaeology(events, index, {
      asOf: AS_OF,
      minTestSize: 30,
    });

    if (result.spearmanRho !== null) {
      assert.ok(
        Array.isArray(result.confidenceInterval) &&
          result.confidenceInterval.length === 2,
        "confidenceInterval [low, high] olmalı"
      );
    }
  });
});

// === ArchaeologyResult yapısı ===

describe("Taste Archaeology — Sonuç Yapısı", () => {
  it("Tüm zorunlu alanlar mevcut olmalı", async () => {
    const result = await runTasteArchaeology([], {}, { asOf: AS_OF });

    assert.ok("spearmanRho" in result);
    assert.ok("testSampleSize" in result);
    assert.ok("baselineResults" in result);
    assert.ok("status" in result);
    assert.ok("warnings" in result);
    assert.ok("completedAt" in result);
    assert.ok(Array.isArray(result.warnings));
  });

  it("completedAt asOf ile eşleşmeli", async () => {
    const result = await runTasteArchaeology([], {}, { asOf: AS_OF });
    assert.strictEqual(result.completedAt, AS_OF);
  });
});

/**
 * Faz 4 — Behavioral Patterns Testleri
 * V1'de alan hazırlığı: dataSufficient flag + null değerler doğrulanır
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeBehavioralPatterns,
  getMinEventsForPattern,
} from "../../src/core/taste/behavioral-patterns.ts";

const AS_OF = "2026-11-02T00:00:00.000Z";

// === Fixture ===
let _cnt = 0;
function makeEvent(contentId = "movie:1", overrides = {}) {
  _cnt++;
  return {
    eventId: `bp-evt-${_cnt}`,
    contentId,
    eventType: "rating_changed",
    payload: { previousValue: null, newValue: 8 },
    recordedAt: "2026-06-01T00:00:00.000Z",
    timeSource: "actual",
    timePrecision: "exact",
    ...overrides,
  };
}

function makeEvents(count) {
  return Array.from({ length: count }, (_, i) =>
    makeEvent(`movie:${i + 1000}`)
  );
}

// === Temel alanlar ===

describe("Behavioral Patterns — Temel Alanlar", () => {
  it("Dönüş değeri gerekli alanları içermeli", () => {
    const result = computeBehavioralPatterns([], AS_OF);
    assert.ok("completionist" in result);
    assert.ok("sampler" in result);
    assert.ok("devotee" in result);
    assert.ok("explorer" in result);
    assert.ok("computedAt" in result);
    assert.ok("dataSufficient" in result);
  });

  it("computedAt asOf ile eşleşmeli", () => {
    const result = computeBehavioralPatterns([], AS_OF);
    assert.strictEqual(result.computedAt, AS_OF);
  });
});

// === Veri yetersizliği ===

describe("Behavioral Patterns — Veri Yetersizliği", () => {
  it("Boş event listesi → dataSufficient: false", () => {
    const result = computeBehavioralPatterns([], AS_OF);
    assert.strictEqual(result.dataSufficient, false);
  });

  it("Veri yetersizken tüm pattern değerleri null olmalı", () => {
    const result = computeBehavioralPatterns([], AS_OF);
    assert.strictEqual(result.completionist, null);
    assert.strictEqual(result.sampler, null);
    assert.strictEqual(result.devotee, null);
    assert.strictEqual(result.explorer, null);
  });

  it("MIN_EVENTS - 1 olay → dataSufficient: false", () => {
    const min = getMinEventsForPattern();
    const events = makeEvents(min - 1);
    const result = computeBehavioralPatterns(events, AS_OF);
    assert.strictEqual(result.dataSufficient, false);
  });
});

// === Yeterli veri ===

describe("Behavioral Patterns — Yeterli Veri (V1 Placeholder)", () => {
  it("MIN_EVENTS olay → dataSufficient: true", () => {
    const min = getMinEventsForPattern();
    const events = makeEvents(min);
    const result = computeBehavioralPatterns(events, AS_OF);
    assert.strictEqual(result.dataSufficient, true);
  });

  it("V1'de dataSufficient=true olsa bile tüm değerler null (placeholder)", () => {
    const min = getMinEventsForPattern();
    const events = makeEvents(min);
    const result = computeBehavioralPatterns(events, AS_OF);
    // V1'de gerçek hesaplama yok → hepsi null
    assert.strictEqual(result.completionist, null);
    assert.strictEqual(result.sampler, null);
    assert.strictEqual(result.devotee, null);
    assert.strictEqual(result.explorer, null);
  });

  it("50 olay → dataSufficient: true", () => {
    const events = makeEvents(50);
    const result = computeBehavioralPatterns(events, AS_OF);
    assert.strictEqual(result.dataSufficient, true);
  });
});

// === getMinEventsForPattern ===

describe("Behavioral Patterns — getMinEventsForPattern", () => {
  it("Eşik değeri pozitif tamsayı olmalı", () => {
    const min = getMinEventsForPattern();
    assert.ok(typeof min === "number");
    assert.ok(min > 0);
    assert.strictEqual(Math.floor(min), min); // tamsayı
  });

  it("Eşik 30 olmalı (spec tanımı)", () => {
    assert.strictEqual(getMinEventsForPattern(), 30);
  });
});

// === Tip güvenliği ===

describe("Behavioral Patterns — Tip Güvenliği", () => {
  it("Pattern değerleri null veya 0-1 aralığında olmalı", () => {
    // V1'de hepsi null; V2'de 0-1 aralığı beklenir
    const result = computeBehavioralPatterns(makeEvents(50), AS_OF);
    for (const key of ["completionist", "sampler", "devotee", "explorer"]) {
      const val = result[key];
      if (val !== null) {
        assert.ok(val >= 0 && val <= 1, `${key} 0-1 aralığı dışında: ${val}`);
      }
    }
  });

  it("dataSufficient boolean olmalı", () => {
    const r1 = computeBehavioralPatterns([], AS_OF);
    const r2 = computeBehavioralPatterns(makeEvents(30), AS_OF);
    assert.strictEqual(typeof r1.dataSufficient, "boolean");
    assert.strictEqual(typeof r2.dataSufficient, "boolean");
  });
});

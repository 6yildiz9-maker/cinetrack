/**
 * Faz 3 — Temporal Analyzer Testleri
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeTemporalWeights } from "../../src/core/taste/temporal-analyzer.ts";
import { HALF_LIFE_RECENT_DAYS, HALF_LIFE_LONG_TERM_DAYS } from "../../src/core/taste/constants.ts";

const AS_OF = "2026-11-01T00:00:00.000Z";

describe("Temporal Analyzer — timeSource: imported (TP-029 KRİTİK)", () => {
  it("imported zaman kaynağı → longTerm=0, recent=0, lifetime=1", () => {
    // Spec BÖLÜM 8'deki kritik test
    const weights = computeTemporalWeights(
      "2020-01-01T00:00:00.000Z",
      undefined,
      "imported",
      "unknown",
      "2026-11-02T00:00:00.000Z"
    );
    assert.strictEqual(weights.lifetime, 1);
    assert.strictEqual(weights.longTerm, 0);   // KRİTİK
    assert.strictEqual(weights.recent, 0);     // KRİTİK
    assert.strictEqual(weights.effectiveTimeSource, "imported");
  });

  it("imported: tarihi ne kadar eski olursa olsun longTerm/recent = 0", () => {
    const weights = computeTemporalWeights(
      "2000-01-01T00:00:00.000Z",
      undefined,
      "imported",
      "unknown",
      AS_OF
    );
    assert.strictEqual(weights.longTerm, 0);
    assert.strictEqual(weights.recent, 0);
  });

  it("imported: experiencedAt versek de recent/longTerm = 0 kalır", () => {
    const weights = computeTemporalWeights(
      "2026-10-01T00:00:00.000Z",
      "2026-10-15T00:00:00.000Z", // çok yakın tarih
      "imported",
      "exact",
      AS_OF
    );
    assert.strictEqual(weights.longTerm, 0);
    assert.strictEqual(weights.recent, 0);
  });
});

describe("Temporal Analyzer — timeSource: actual (yarılanma)", () => {
  it("Bugünkü tarih (yaş = 0 gün) → recent ≈ longTerm ≈ 1", () => {
    const weights = computeTemporalWeights(
      AS_OF,
      undefined,
      "actual",
      "exact",
      AS_OF
    );
    assert.strictEqual(weights.lifetime, 1);
    // 2^(-0/180) = 1, 2^(-0/730) = 1
    assert.ok(Math.abs(weights.recent - 1.0) < 0.001);
    assert.ok(Math.abs(weights.longTerm - 1.0) < 0.001);
  });

  it("180 gün önce → recent ≈ 0.5 (tam yarılanma)", () => {
    const date = new Date(new Date(AS_OF).getTime() - HALF_LIFE_RECENT_DAYS * 24 * 60 * 60 * 1000);
    const weights = computeTemporalWeights(
      date.toISOString(),
      undefined,
      "actual",
      "exact",
      AS_OF
    );
    assert.ok(Math.abs(weights.recent - 0.5) < 0.01, `recent=${weights.recent}`);
  });

  it("730 gün önce → longTerm ≈ 0.5 (tam yarılanma)", () => {
    const date = new Date(new Date(AS_OF).getTime() - HALF_LIFE_LONG_TERM_DAYS * 24 * 60 * 60 * 1000);
    const weights = computeTemporalWeights(
      date.toISOString(),
      undefined,
      "actual",
      "exact",
      AS_OF
    );
    assert.ok(Math.abs(weights.longTerm - 0.5) < 0.01, `longTerm=${weights.longTerm}`);
  });

  it("Eski tarih → recent < longTerm (recent daha hızlı söner)", () => {
    // 400 gün önce → recent küçüktür, longTerm daha büyük
    const date = new Date(new Date(AS_OF).getTime() - 400 * 24 * 60 * 60 * 1000);
    const weights = computeTemporalWeights(
      date.toISOString(),
      undefined,
      "actual",
      "exact",
      AS_OF
    );
    assert.ok(weights.recent < weights.longTerm,
      `Beklenen recent < longTerm: recent=${weights.recent} longTerm=${weights.longTerm}`);
  });

  it("lifetime her zaman 1 (azalma yok)", () => {
    const date = new Date(new Date(AS_OF).getTime() - 5000 * 24 * 60 * 60 * 1000);
    const weights = computeTemporalWeights(
      date.toISOString(),
      undefined,
      "actual",
      "exact",
      AS_OF
    );
    assert.strictEqual(weights.lifetime, 1);
  });
});

describe("Temporal Analyzer — experiencedAt kullanımı", () => {
  it("experiencedAt recordedAt'tan önce → yaşı büyük → recent daha düşük", () => {
    // experiencedAt: 2 yıl önce, recordedAt: bugün
    const twoYearsAgo = new Date(new Date(AS_OF).getTime() - 730 * 24 * 60 * 60 * 1000).toISOString();

    const withExperienced = computeTemporalWeights(
      AS_OF,            // recordedAt: bugün
      twoYearsAgo,      // experiencedAt: 2 yıl önce
      "actual",
      "approximate",
      AS_OF
    );

    const withoutExperienced = computeTemporalWeights(
      AS_OF,
      undefined,
      "actual",
      "exact",
      AS_OF
    );

    // experiencedAt eskiyse recent daha düşük
    assert.ok(withExperienced.recent < withoutExperienced.recent,
      "experiencedAt eskiyse recent daha düşük olmalı");
  });
});

describe("Temporal Analyzer — Gelecek tarih karantinası", () => {
  it("recordedAt gelecekte → tüm ağırlıklar 1 (karantina)", () => {
    const future = "2030-01-01T00:00:00.000Z";
    const weights = computeTemporalWeights(
      future,
      undefined,
      "actual",
      "exact",
      AS_OF
    );
    assert.strictEqual(weights.lifetime, 1);
    assert.strictEqual(weights.longTerm, 1);
    assert.strictEqual(weights.recent, 1);
  });
});

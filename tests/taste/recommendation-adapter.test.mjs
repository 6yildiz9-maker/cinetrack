/**
 * Faz 6 — Recommendation Adapter Testleri
 * BÖLÜM 6'daki kritik testler: gölge mod, filtre regresyonu, veto
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRecommendationAdapter,
  setShadowLogger,
} from "../../src/core/taste/recommendation-adapter.ts";

// === Fixture yardımcıları ===

function makeProfile(overrides = {}) {
  return {
    mediaType: "movie",
    algorithmVersion: "v1.0",
    taxonomyVersion: "v0.1",
    asOf: "2026-11-02T00:00:00.000Z",
    metrics: {
      "genre.drama": {
        metricId: "genre.drama",
        affinity: 50,
        longTermAffinity: 50,
        recentAffinity: 50,
        status: "directional",
        evidence: {
          posMass: 3.0,
          negMass: 0.0,
          uncertainMass: 0.0,
          topPositiveContentIds: ["movie:1"],
          topNegativeContentIds: [],
        },
      },
      "genre.comedy": {
        metricId: "genre.comedy",
        affinity: -20,
        longTermAffinity: -20,
        recentAffinity: -20,
        status: "directional",
        evidence: {
          posMass: 0.0,
          negMass: 1.0,
          uncertainMass: 0.0,
          topPositiveContentIds: [],
          topNegativeContentIds: ["movie:2"],
        },
      },
    },
    ...overrides,
  };
}

function makeProfileWithVeto() {
  return makeProfile({
    metrics: {
      "genre.horror": {
        metricId: "genre.horror",
        affinity: -80,
        longTermAffinity: -80,
        recentAffinity: -80,
        status: "directional",
        evidence: {
          posMass: 0.0,
          negMass: 10.0, // negMass > 5
          uncertainMass: 0.0,
          topPositiveContentIds: [],
          topNegativeContentIds: ["movie:999"],
        },
      },
    },
  });
}

function makeContentIndex() {
  return {
    "movie:1": {
      contentId: "movie:1",
      mediaType: "movie",
      extractedAt: "2026-11-01T00:00:00.000Z",
      metadataHash: "h1",
      completeness: 0.8,
      features: {
        "genre.drama": {
          strength: 100,
          confidence: 0.95,
          source: "tmdb",
          state: "present",
        },
      },
    },
    "movie:2": {
      contentId: "movie:2",
      mediaType: "movie",
      extractedAt: "2026-11-01T00:00:00.000Z",
      metadataHash: "h2",
      completeness: 0.6,
      features: {
        "genre.comedy": {
          strength: 90,
          confidence: 0.9,
          source: "tmdb",
          state: "present",
        },
      },
    },
  };
}

function makeContentIndexWithVetoFeature() {
  return {
    "movie:1": {
      contentId: "movie:1",
      mediaType: "movie",
      extractedAt: "2026-11-01T00:00:00.000Z",
      metadataHash: "hv",
      completeness: 0.9,
      features: {
        "genre.horror": {
          strength: 90,     // > 80
          confidence: 0.95, // > 0.8
          source: "tmdb",
          state: "present",
        },
      },
    },
  };
}

function makeContentIndexWithFewFeatures() {
  return {
    "movie:1": {
      contentId: "movie:1",
      mediaType: "movie",
      extractedAt: "2026-11-01T00:00:00.000Z",
      metadataHash: "hf",
      completeness: 0.3,
      features: {
        "genre.drama": {
          strength: 80,
          confidence: 0.9,
          source: "tmdb",
          state: "present",
        },
      },
    },
  };
}

// === BÖLÜM 6 Kritik Test: Gölge mod — sıralama değişmez ===

describe("Recommendation Adapter — Gölge Mod (KRİTİK TP-037)", () => {
  it("Adapter sadece tasteFit döndürür, orijinal sıra korunur", () => {
    // Spec BÖLÜM 6 kritik test
    const adapter = createRecommendationAdapter();
    const candidates = [
      { contentId: "movie:1", mediaType: "movie" },
      { contentId: "movie:2", mediaType: "movie" },
    ];
    const profile = makeProfile();
    const index = makeContentIndex();

    const results = adapter.suggestFor(candidates, "movie", profile, index);

    // KRİTİK: Adapter sadece tasteFit döndürür, sıralama yapmaz
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].contentId, "movie:1"); // orijinal sıra korunur
    assert.strictEqual(results[1].contentId, "movie:2");
  });

  it("Gölge logger çağrılır ama sıralama değişmez", () => {
    let logCalled = false;
    setShadowLogger(() => { logCalled = true; });

    const adapter = createRecommendationAdapter();
    const candidates = [{ contentId: "movie:1", mediaType: "movie" }];

    adapter.suggestFor(candidates, "movie", makeProfile(), makeContentIndex());

    assert.strictEqual(logCalled, true, "Logger çağrılmalı");

    // Logger'ı temizle
    setShadowLogger(null);
  });
});

// === Veto ===

describe("Recommendation Adapter — Veto (TP-034)", () => {
  it("Yüksek güvenli olumsuz eşleşme vetoed: true üretmeli", () => {
    // Spec BÖLÜM 6 kritik test
    const adapter = createRecommendationAdapter();
    const candidates = [{ contentId: "movie:1", mediaType: "movie" }];
    const profile = makeProfileWithVeto();
    const index = makeContentIndexWithVetoFeature();

    const results = adapter.suggestFor(candidates, "movie", profile, index);

    assert.strictEqual(results[0].vetoed, true, "Veto aktif olmalı");
  });

  it("Zayıf olumsuz eşleşmede vetoed: false", () => {
    const adapter = createRecommendationAdapter();
    const candidates = [{ contentId: "movie:2", mediaType: "movie" }];

    const results = adapter.suggestFor(
      candidates,
      "movie",
      makeProfile(),
      makeContentIndex()
    );

    // genre.comedy affinity: -20 → veto eşiği aşılmıyor
    assert.strictEqual(results[0].vetoed, false);
  });
});

// === Eksik veri ceza değil ===

describe("Recommendation Adapter — Eksik Veri Ceza Değil", () => {
  it("Content index'te olmayan içerik tasteFit: 0 döner ama çökmez", () => {
    // Spec BÖLÜM 6 kritik test
    const adapter = createRecommendationAdapter();
    const candidates = [{ contentId: "movie:999", mediaType: "movie" }]; // index'te yok

    const results = adapter.suggestFor(
      candidates,
      "movie",
      makeProfile(),
      makeContentIndex()
    );

    assert.strictEqual(results[0].tasteFit, 0);
    assert.strictEqual(results[0].confidence, "low");
    assert.strictEqual(results[0].vetoed, false);
  });

  it("Sadece 1 özelliği olan içerik normalize edilir, tasteFit > 0", () => {
    // Spec BÖLÜM 6 kritik test: "eksik veri ceza değil"
    const adapter = createRecommendationAdapter();
    const candidates = [{ contentId: "movie:1", mediaType: "movie" }];

    const results = adapter.suggestFor(
      candidates,
      "movie",
      makeProfile(),
      makeContentIndexWithFewFeatures()
    );

    // genre.drama affinity 50 ile güçlü eşleşme → tasteFit > 0
    assert.ok(results[0].tasteFit > 0, `tasteFit ${results[0].tasteFit} > 0 olmalı`);
  });
});

// === TasteFitResult yapısı ===

describe("Recommendation Adapter — TasteFitResult Yapısı", () => {
  it("Her sonuç zorunlu alanları içermeli", () => {
    const adapter = createRecommendationAdapter();
    const candidates = [{ contentId: "movie:1", mediaType: "movie" }];

    const results = adapter.suggestFor(
      candidates,
      "movie",
      makeProfile(),
      makeContentIndex()
    );

    const r = results[0];
    assert.ok(typeof r.contentId === "string");
    assert.ok(typeof r.tasteFit === "number");
    assert.ok(["low", "medium", "high"].includes(r.confidence));
    assert.ok(Array.isArray(r.reasonIds));
    assert.ok(typeof r.vetoed === "boolean");
  });

  it("tasteFit 0-100 aralığında olmalı", () => {
    const adapter = createRecommendationAdapter();
    const candidates = [
      { contentId: "movie:1", mediaType: "movie" },
      { contentId: "movie:2", mediaType: "movie" },
    ];

    const results = adapter.suggestFor(
      candidates,
      "movie",
      makeProfile(),
      makeContentIndex()
    );

    for (const r of results) {
      assert.ok(
        r.tasteFit >= 0 && r.tasteFit <= 100,
        `tasteFit sınır dışı: ${r.tasteFit}`
      );
    }
  });

  it("reasonIds en fazla 3 metrik içermeli", () => {
    const adapter = createRecommendationAdapter();
    const results = adapter.suggestFor(
      [{ contentId: "movie:1", mediaType: "movie" }],
      "movie",
      makeProfile(),
      makeContentIndex()
    );

    assert.ok(results[0].reasonIds.length <= 3);
  });
});

// === Filtre regresyon testi: mevcut filtreler bozulmaz ===

describe("Recommendation Adapter — Filtre Regresyon", () => {
  it("Adapter disliked/hidden listelerini okumaz; bu filtreler orchestrator'da kalır", () => {
    // Adapter bu filtreleri uygulamamalı — mevcut sistemde kalır
    const adapter = createRecommendationAdapter();
    const candidates = [
      { contentId: "movie:disliked", mediaType: "movie" },
      { contentId: "movie:hidden",   mediaType: "movie" },
    ];

    // Adapter boş content index ile çağrılsa bile çökmemeli
    const results = adapter.suggestFor(candidates, "movie", makeProfile(), {});

    assert.strictEqual(results.length, 2);
    // Adapter filtre uygulamaz — bunlar orchestrator'da disliked/hidden kontrolünden geçer
    assert.strictEqual(results[0].tasteFit, 0); // index'te yok
    assert.strictEqual(results[1].tasteFit, 0);
  });
});

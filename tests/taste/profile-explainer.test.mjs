/**
 * Faz 5 — Profile Explainer Testleri
 * "Bunu nasıl bildin?" — kanıt listesi doğrulama
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { explainMetric } from "../../src/core/taste/profile-explainer.ts";

// === Fixture ===
function makeProfile(overrides = {}) {
  return {
    mediaType: "movie",
    algorithmVersion: "v1.0",
    taxonomyVersion: "v0.1",
    asOf: "2026-11-02T00:00:00.000Z",
    metrics: {
      "genre.drama": {
        metricId: "genre.drama",
        affinity: 45,
        longTermAffinity: 45,
        recentAffinity: 45,
        status: "directional",
        evidence: {
          posMass: 3.0,
          negMass: 0.2,
          uncertainMass: 0.5,
          topPositiveContentIds: ["movie:550", "movie:807"],
          topNegativeContentIds: ["movie:999"],
        },
      },
      "genre.comedy": {
        metricId: "genre.comedy",
        affinity: -15,
        longTermAffinity: -15,
        recentAffinity: -15,
        status: "unknown",
        evidence: {
          posMass: 0,
          negMass: 0.5,
          uncertainMass: 0,
          topPositiveContentIds: [],
          topNegativeContentIds: ["movie:123"],
        },
      },
    },
    ...overrides,
  };
}

function makeIndex(overrides = {}) {
  return {
    "movie:550": {
      contentId: "movie:550",
      mediaType: "movie",
      extractedAt: "2026-11-01T00:00:00.000Z",
      metadataHash: "abc123",
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
    ...overrides,
  };
}

// === explainMetric testleri ===

describe("Profile Explainer — explainMetric", () => {
  it("Mevcut metrik için açıklama döndürmeli", () => {
    const profile = makeProfile();
    const result = explainMetric("genre.drama", profile, makeIndex());

    assert.ok(result !== null, "Açıklama null döndü");
    assert.strictEqual(result.metricId, "genre.drama");
    assert.ok(result.metric.affinity === 45);
    assert.ok(result.definition !== null);
    assert.ok(typeof result.definition.definition === "string");
  });

  it("Olmayan metrik ID için null döndürmeli", () => {
    const profile = makeProfile();
    const result = explainMetric("non.existent", profile, {});
    assert.strictEqual(result, null);
  });

  it("Profilde olmayan metrik için null döndürmeli", () => {
    const profile = makeProfile();
    // genre.scifi profilde yok
    const result = explainMetric("genre.scifi", profile, {});
    assert.strictEqual(result, null);
  });
});

describe("Profile Explainer — Kanıt Listesi", () => {
  it("positiveEvidence topPositiveContentIds'den oluşturulmalı", () => {
    const profile = makeProfile();
    const result = explainMetric("genre.drama", profile, makeIndex());

    assert.ok(result !== null);
    assert.strictEqual(result.positiveEvidence.length, 2); // movie:550, movie:807
    const contentIds = result.positiveEvidence.map((e) => e.contentId);
    assert.ok(contentIds.includes("movie:550"));
    assert.ok(contentIds.includes("movie:807"));
  });

  it("negativeEvidence topNegativeContentIds'den oluşturulmalı", () => {
    const profile = makeProfile();
    const result = explainMetric("genre.drama", profile, makeIndex());

    assert.ok(result !== null);
    assert.strictEqual(result.negativeEvidence.length, 1);
    assert.strictEqual(result.negativeEvidence[0].contentId, "movie:999");
    assert.strictEqual(result.negativeEvidence[0].direction, "negative");
  });

  it("Content index'te bulunan içerik için feature verisi kullanılmalı", () => {
    const profile = makeProfile();
    const result = explainMetric("genre.drama", profile, makeIndex());

    assert.ok(result !== null);
    const movie550 = result.positiveEvidence.find((e) => e.contentId === "movie:550");
    assert.ok(movie550, "movie:550 evidence yok");
    // feature: strength=100, confidence=0.95 → contribution = (100/100) * 0.95 = 0.95
    assert.ok(Math.abs(movie550.contribution - 0.95) < 0.01);
    assert.strictEqual(movie550.featureStrength, 100);
    assert.strictEqual(movie550.confidence, 0.95);
  });

  it("Content index'te olmayan içerik için sıfır katkı", () => {
    const profile = makeProfile();
    // Boş index
    const result = explainMetric("genre.drama", profile, {});

    assert.ok(result !== null);
    const movie807 = result.positiveEvidence.find((e) => e.contentId === "movie:807");
    assert.ok(movie807);
    assert.strictEqual(movie807.contribution, 0);
    assert.strictEqual(movie807.featureStrength, 0);
  });

  it("neutralEvidence V1'de boş olmalı", () => {
    const profile = makeProfile();
    const result = explainMetric("genre.drama", profile, makeIndex());

    assert.ok(result !== null);
    assert.deepStrictEqual(result.neutralEvidence, []);
  });
});

describe("Profile Explainer — spoilerRisk", () => {
  it("spoilerRisk definition'dan alınmalı", () => {
    const profile = makeProfile();
    const result = explainMetric("genre.drama", profile, makeIndex());

    assert.ok(result !== null);
    // genre.drama spoilerRisk: "none"
    assert.strictEqual(result.spoilerRisk, "none");
  });
});

describe("Profile Explainer — İlgili Metrikler", () => {
  it("parentId olmayan metrikte relatedMetrics boş olmalı (parent yok)", () => {
    const profile = makeProfile();
    const result = explainMetric("genre.drama", profile, makeIndex());

    assert.ok(result !== null);
    // genre.drama parentId yok ve profilde child da yok
    const parents = result.relatedMetrics.filter((r) => r.relationship === "parent");
    assert.strictEqual(parents.length, 0);
  });

  it("relatedMetrics dizisi dizi tipi olmalı", () => {
    const profile = makeProfile();
    const result = explainMetric("genre.drama", profile, makeIndex());

    assert.ok(result !== null);
    assert.ok(Array.isArray(result.relatedMetrics));
  });
});

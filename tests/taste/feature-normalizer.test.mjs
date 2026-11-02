/**
 * Faz 2 — Feature Normalizer Testleri
 * Çalıştırma: tsx --test tests/taste/feature-normalizer.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeContentFeatures,
  applySemanticGroupDamping,
  capCategoryContribution,
} from "../../src/core/taste/feature-normalizer.ts";
import { TAXONOMY_V01 } from "../../src/core/taste/taxonomy.ts";

// === Yardımcılar ===

function makeFeature(strength, confidence, overrides = {}) {
  return {
    strength,
    confidence,
    source: "tmdb",
    state: "present",
    ...overrides,
  };
}

// Tüm shadow metrik ID'leri
const shadowIds = TAXONOMY_V01.filter((m) => !m.scoringEnabled).map((m) => m.id);

// === strength / confidence sınır testleri ===

describe("Feature Normalizer — strength / confidence Sınırları", () => {
  it("strength 0-100 tamsayı kalmalı", () => {
    const features = {
      "genre.drama": makeFeature(150, 0.5), // 150 → 100 sınırlanmalı
      "genre.comedy": makeFeature(-10, 0.3), // -10 → 0 sınırlanmalı
      "genre.crime": makeFeature(75.7, 0.8), // 75.7 → 76 (round)
    };
    const result = normalizeContentFeatures(features, TAXONOMY_V01);
    assert.ok(result["genre.drama"]?.strength <= 100, "strength 100 üstünde");
    assert.ok(result["genre.comedy"]?.strength >= 0, "strength negatif");
    assert.strictEqual(
      result["genre.crime"]?.strength,
      Math.round(75.7),
      "strength tamsayıya yuvarlanmalı"
    );
  });

  it("confidence 0-1 aralığında kalmalı", () => {
    const features = {
      "genre.drama": makeFeature(80, 1.5), // 1.5 → 1.0 sınırlanmalı
      "genre.scifi": makeFeature(80, -0.1), // -0.1 → 0 sınırlanmalı
    };
    const result = normalizeContentFeatures(features, TAXONOMY_V01);
    assert.ok(result["genre.drama"]?.confidence <= 1, "confidence 1 üstünde");
    assert.ok(result["genre.scifi"]?.confidence >= 0, "confidence negatif");
  });
});

// === Shadow metrik testleri ===

describe("Feature Normalizer — Shadow Metrikler Aktif Edilmez", () => {
  it("Shadow metrikler normalize sonrası feature map'ten çıkarılmalı", () => {
    const features = {};
    for (const id of shadowIds) {
      features[id] = makeFeature(50, 0.5);
    }
    const result = normalizeContentFeatures(features, TAXONOMY_V01);
    for (const id of shadowIds) {
      assert.ok(
        !result[id],
        `Shadow metrik '${id}' normalize sonrası hâlâ mevcut`
      );
    }
  });

  it("Aktif metriklere dokunulmamalı", () => {
    const features = {
      "genre.drama": makeFeature(100, 0.95),
      "narrative.slow_burn": makeFeature(50, 0.5), // shadow
    };
    const result = normalizeContentFeatures(features, TAXONOMY_V01);
    assert.ok(result["genre.drama"], "Aktif metrik kaldırıldı");
    assert.ok(!result["narrative.slow_burn"], "Shadow metrik kaldırılmadı");
  });
});

// === semanticGroup damping ===

describe("Feature Normalizer — semanticGroup Çift Sayım Engeli", () => {
  it("semanticGroup tanımlı birden fazla metrik varsa confidence bastırılmalı", () => {
    // Taxonomy'de semanticGroup tanımlı metrik üretelim (test fixture)
    const testTaxonomy = [
      {
        id: "test.metric.a",
        categoryId: "test",
        semanticGroup: "group-x",
        scoringEnabled: true,
        sourceFields: [],
        derivationType: "direct",
        applicableMedia: ["movie"],
        transferPolicy: "shared",
        status: "validated",
        definition: "",
        evidenceRequirement: "",
        spoilerRisk: "none",
        defaultConfidence: 0.9,
        mappingVersion: "v1",
      },
      {
        id: "test.metric.b",
        categoryId: "test",
        semanticGroup: "group-x",
        scoringEnabled: true,
        sourceFields: [],
        derivationType: "direct",
        applicableMedia: ["movie"],
        transferPolicy: "shared",
        status: "validated",
        definition: "",
        evidenceRequirement: "",
        spoilerRisk: "none",
        defaultConfidence: 0.9,
        mappingVersion: "v1",
      },
    ];

    const features = {
      "test.metric.a": makeFeature(80, 0.9),
      "test.metric.b": makeFeature(80, 0.8),
    };

    const result = applySemanticGroupDamping(features, testTaxonomy);

    // En güçlü olan (a) değişmemeli, ikincisi (b) confidence bastırılmalı
    assert.ok(
      result["test.metric.b"].confidence < features["test.metric.b"].confidence,
      "Grup içi ikinci metrik confidence bastırılmadı"
    );
  });

  it("Tek metrik içeren semanticGroup'ta değişiklik olmamak", () => {
    const testTaxonomy = [
      {
        id: "single.metric",
        categoryId: "test",
        semanticGroup: "solo-group",
        scoringEnabled: true,
        sourceFields: [],
        derivationType: "direct",
        applicableMedia: ["movie"],
        transferPolicy: "shared",
        status: "validated",
        definition: "",
        evidenceRequirement: "",
        spoilerRisk: "none",
        defaultConfidence: 0.9,
        mappingVersion: "v1",
      },
    ];

    const features = { "single.metric": makeFeature(80, 0.9) };
    const result = applySemanticGroupDamping(features, testTaxonomy);
    assert.strictEqual(result["single.metric"].confidence, 0.9);
  });
});

// === Kategori içi katkı sınırlaması ===

describe("Feature Normalizer — capCategoryContribution", () => {
  it("3 veya daha az genre feature → strength değişmemeli", () => {
    const features = {
      "genre.drama": makeFeature(100, 0.95),
      "genre.comedy": makeFeature(100, 0.95),
      "genre.crime": makeFeature(100, 0.95),
    };
    const result = capCategoryContribution(features, TAXONOMY_V01);
    assert.strictEqual(result["genre.drama"].strength, 100);
    assert.strictEqual(result["genre.comedy"].strength, 100);
  });

  it("4'ten fazla genre feature varsa strength bastırılmalı", () => {
    const features = {
      "genre.drama": makeFeature(100, 0.95),
      "genre.comedy": makeFeature(100, 0.95),
      "genre.crime": makeFeature(100, 0.95),
      "genre.scifi": makeFeature(100, 0.95),
      "genre.animation": makeFeature(100, 0.95), // 5. → bastırılmalı
    };
    const result = capCategoryContribution(features, TAXONOMY_V01);
    // 5 eşleşme → dampFactor = 3/5 = 0.6 → strength = round(100 * 0.6) = 60
    assert.ok(result["genre.drama"].strength < 100, "Bastırma çalışmadı");
  });

  it("strength bastırıldıktan sonra 0-100 aralığında kalmalı", () => {
    const features = {};
    // 10 genre feature ekle
    const genreMetrics = TAXONOMY_V01.filter((m) => m.categoryId === "genre").slice(0, 8);
    for (const m of genreMetrics) {
      features[m.id] = makeFeature(100, 0.9);
    }
    const result = capCategoryContribution(features, TAXONOMY_V01);
    for (const [, feat] of Object.entries(result)) {
      assert.ok(feat.strength >= 0 && feat.strength <= 100, `strength sınır dışı: ${feat.strength}`);
    }
  });
});

// === normalizeContentFeatures bütünleşik test ===

describe("Feature Normalizer — normalizeContentFeatures Bütünleşik", () => {
  it("Boş feature map → boş sonuç döner", () => {
    const result = normalizeContentFeatures({}, TAXONOMY_V01);
    assert.deepStrictEqual(result, {});
  });

  it("Aktif metrik geçerliyse feature korunmalı", () => {
    const features = { "genre.drama": makeFeature(100, 0.95) };
    const result = normalizeContentFeatures(features, TAXONOMY_V01);
    assert.ok(result["genre.drama"]);
  });

  it("Tüm shadow + aktif karışımında shadow temizlenmeli, aktif korunmalı", () => {
    const features = {
      "genre.drama": makeFeature(100, 0.95),
      "origin.turkish": makeFeature(90, 0.9),
      "narrative.slow_burn": makeFeature(50, 0.5), // shadow
      "style.minimalist": makeFeature(50, 0.5),    // shadow
    };
    const result = normalizeContentFeatures(features, TAXONOMY_V01);
    assert.ok(result["genre.drama"], "aktif metrik silindi");
    assert.ok(result["origin.turkish"], "aktif metrik silindi");
    assert.ok(!result["narrative.slow_burn"], "shadow silinmedi");
    assert.ok(!result["style.minimalist"], "shadow silinmedi");
  });
});

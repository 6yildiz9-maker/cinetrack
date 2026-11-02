/**
 * Faz 3 — Confidence Calculator Testleri
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeConfidence } from "../../src/core/taste/confidence-calculator.ts";

function makeMasses(overrides = {}) {
  return {
    posMass: 0,
    negMass: 0,
    uncertainMass: 0,
    evidenceMass: 0,
    evidenceCount: 0,
    topPositiveContentIds: [],
    topNegativeContentIds: [],
    ...overrides,
  };
}

describe("Confidence Calculator — Destek (Support)", () => {
  it("0 kanıt → support: low", () => {
    const r = computeConfidence(makeMasses({ evidenceCount: 0 }), 0.9, true);
    assert.strictEqual(r.support, "low");
  });

  it("4 kanıt → support: low (< 5)", () => {
    const r = computeConfidence(makeMasses({ evidenceCount: 4 }), 0.9, true);
    assert.strictEqual(r.support, "low");
  });

  it("5 kanıt → support: medium", () => {
    const r = computeConfidence(makeMasses({ evidenceCount: 5 }), 0.9, true);
    assert.strictEqual(r.support, "medium");
  });

  it("9 kanıt → support: medium (< 10)", () => {
    const r = computeConfidence(makeMasses({ evidenceCount: 9 }), 0.9, true);
    assert.strictEqual(r.support, "medium");
  });

  it("10 kanıt → support: high", () => {
    const r = computeConfidence(makeMasses({ evidenceCount: 10 }), 0.9, true);
    assert.strictEqual(r.support, "high");
  });
});

describe("Confidence Calculator — Nitelik (Quality)", () => {
  it("avgFeatureConfidence >= 0.8 + exactDate → quality: high", () => {
    const r = computeConfidence(makeMasses({ evidenceCount: 10 }), 0.9, true);
    assert.strictEqual(r.quality, "high");
  });

  it("avgFeatureConfidence >= 0.8 ama tarih yok → quality: medium", () => {
    const r = computeConfidence(makeMasses({ evidenceCount: 10 }), 0.85, false);
    assert.strictEqual(r.quality, "medium");
  });

  it("avgFeatureConfidence = 0.6 → quality: medium", () => {
    const r = computeConfidence(makeMasses({ evidenceCount: 5 }), 0.6, false);
    assert.strictEqual(r.quality, "medium");
  });

  it("avgFeatureConfidence < 0.6 → quality: low", () => {
    const r = computeConfidence(makeMasses({ evidenceCount: 5 }), 0.5, false);
    assert.strictEqual(r.quality, "low");
  });
});

describe("Confidence Calculator — Kapsam (Coverage)", () => {
  it("evidenceCount > 0 → coverage: medium (V1 basit)", () => {
    const r = computeConfidence(makeMasses({ evidenceCount: 1 }), 0.9, true);
    assert.strictEqual(r.coverage, "medium");
  });

  it("evidenceCount = 0 → coverage: low", () => {
    const r = computeConfidence(makeMasses({ evidenceCount: 0 }), 0.9, true);
    assert.strictEqual(r.coverage, "low");
  });
});

describe("Confidence Calculator — Overall (en düşük seviye)", () => {
  it("Tüm high → overall: high", () => {
    const r = computeConfidence(makeMasses({ evidenceCount: 10 }), 0.9, true);
    // support: high, quality: high, coverage: medium → overall: medium
    assert.strictEqual(r.overall, "medium"); // coverage medium nedeniyle
  });

  it("Bir tane low var → overall: low", () => {
    const r = computeConfidence(makeMasses({ evidenceCount: 3 }), 0.5, false);
    // support: low, quality: low → overall: low
    assert.strictEqual(r.overall, "low");
  });

  it("support: high, quality: medium → overall: medium", () => {
    const r = computeConfidence(makeMasses({ evidenceCount: 15 }), 0.7, false);
    // support: high, quality: medium, coverage: medium → overall: medium
    assert.strictEqual(r.overall, "medium");
  });

  it("Tüm düşük → overall: low", () => {
    const r = computeConfidence(makeMasses({ evidenceCount: 0 }), 0.3, false);
    assert.strictEqual(r.overall, "low");
  });
});

describe("Confidence Calculator — Tip doğrulaması", () => {
  it("Tüm alanlar low/medium/high olmalı", () => {
    const r = computeConfidence(makeMasses({ evidenceCount: 5 }), 0.7, true);
    const validLevels = ["low", "medium", "high"];
    assert.ok(validLevels.includes(r.support));
    assert.ok(validLevels.includes(r.quality));
    assert.ok(validLevels.includes(r.coverage));
    assert.ok(validLevels.includes(r.overall));
  });
});

/**
 * Faz 3 — Preference Calculator Testleri
 * En kritik testler: nötr kanıt paydada kalır, shrinkage k=2.5
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computePreference } from "../../src/core/taste/preference-calculator.ts";
import { SHRINKAGE_K } from "../../src/core/taste/constants.ts";

// === Fixture ===
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

// === Shrinkage testleri (KRİTİK) ===

describe("Preference Calculator — Shrinkage k=2.5 (TP-021)", () => {
  it("Tek içerik shrinkage ile sınırlanır — 1 filmden +100 olmaz", () => {
    const masses = makeMasses({
      posMass: 1.0,
      negMass: 0,
      uncertainMass: 0,
      evidenceMass: 1.0,
      evidenceCount: 1,
      topPositiveContentIds: ["movie:123"],
    });
    const result = computePreference(masses);
    // A_m = 1.0 / (1.0 + 2.5) = 0.2857
    // Affinity = round(0.2857 * 100) = 29
    assert.ok(result.affinity < 50, `Shrinkage çalışmıyor: affinity=${result.affinity}`);
    assert.strictEqual(result.affinity, Math.round((1.0 / (1.0 + SHRINKAGE_K)) * 100));
  });

  it("Büyük pozitif kütlede bile shrinkage aşırı değerleri bastırır", () => {
    const masses = makeMasses({
      posMass: 100,
      negMass: 0,
      uncertainMass: 0,
      evidenceMass: 100,
      evidenceCount: 50,
    });
    const result = computePreference(masses);
    // A_m = 100 / (100 + 2.5) = 0.9756 → ~98
    assert.ok(result.affinity <= 100);
    assert.ok(result.affinity >= 90, `Beklenen ~98, alınan: ${result.affinity}`);
  });

  it("Sıfır kanıt → affinity 0", () => {
    const masses = makeMasses({
      evidenceCount: 0,
      evidenceMass: 0,
    });
    const result = computePreference(masses);
    // A_m = 0 / (0 + 2.5) = 0
    assert.strictEqual(result.affinity, 0);
    assert.strictEqual(result.status, "unknown");
  });
});

// === Nötr kanıt paydada kalır (KRİTİK) ===

describe("Preference Calculator — Nötr Kanıt Paydada Kalır (TP-015)", () => {
  it("Nötr puan (5-6.9) paydada kalır, silinmez — durum neutral", () => {
    // Spec BÖLÜM 8'deki kritik test
    const masses = makeMasses({
      posMass: 0,
      negMass: 0,
      uncertainMass: 2.5, // nötr kanıt
      evidenceMass: 2.5,
      evidenceCount: 3,
    });
    const result = computePreference(masses);

    // Affinity 0 olmalı (nötr)
    assert.strictEqual(result.affinity, 0);
    // Durum "neutral" olmalı (unknown DEĞİL!)
    assert.strictEqual(result.status, "neutral");
  });

  it("Nötr kanıt affinity'yi sıfıra çeker (dilute etkisi)", () => {
    // Hem pozitif hem nötr kanıt varken nötr ağır basarsa affinity düşer
    const onlyPos = makeMasses({
      posMass: 1.0,
      negMass: 0,
      uncertainMass: 0,
      evidenceMass: 1.0,
      evidenceCount: 3,
    });
    const posAndNeutral = makeMasses({
      posMass: 1.0,
      negMass: 0,
      uncertainMass: 5.0, // ağır nötr baskısı
      evidenceMass: 6.0,
      evidenceCount: 6,
    });

    const r1 = computePreference(onlyPos);
    const r2 = computePreference(posAndNeutral);

    // Nötr kanıt paydayı büyütür → affinity daha düşük olmalı
    assert.ok(r1.affinity > r2.affinity,
      `Nötr kanıt paydayı büyütmeli: r1=${r1.affinity} r2=${r2.affinity}`);
  });

  it("evidenceMass = posMass + negMass + uncertainMass formülü doğrulanır", () => {
    const masses = makeMasses({
      posMass: 2.0,
      negMass: 1.0,
      uncertainMass: 1.5,
      evidenceMass: 4.5, // 2.0 + 1.0 + 1.5
      evidenceCount: 5,
    });
    const result = computePreference(masses);
    // A_m = (2.0 - 1.0) / (4.5 + 2.5) = 1.0 / 7.0 = 0.1428 → 14
    const expected = Math.round((1.0 / 7.0) * 100);
    assert.strictEqual(result.affinity, expected);
  });
});

// === Formül doğruluğu ===

describe("Preference Calculator — A_m Formülü", () => {
  it("Tam pozitif kanıt: A_m = S_m / (D_m + k)", () => {
    const S = 5.0;
    const D = 5.0;
    const k = SHRINKAGE_K;
    const masses = makeMasses({
      posMass: S,
      negMass: 0,
      uncertainMass: 0,
      evidenceMass: D,
      evidenceCount: 5,
    });
    const result = computePreference(masses);
    const expected = Math.round((S / (D + k)) * 100);
    assert.strictEqual(result.affinity, expected);
  });

  it("Tam negatif kanıt: affinty negatif", () => {
    const masses = makeMasses({
      posMass: 0,
      negMass: 3.0,
      uncertainMass: 0,
      evidenceMass: 3.0,
      evidenceCount: 4,
    });
    const result = computePreference(masses);
    assert.ok(result.affinity < 0, "Negatif kanıt → negatif affinity");
  });

  it("Affinity -100...+100 aralığında kalır", () => {
    const extremePos = makeMasses({
      posMass: 1000,
      negMass: 0,
      uncertainMass: 0,
      evidenceMass: 1000,
      evidenceCount: 500,
    });
    const r = computePreference(extremePos);
    assert.ok(r.affinity >= -100 && r.affinity <= 100);
  });
});

// === Durum etiketleri ===

describe("Preference Calculator — Durum Etiketleri (TP-024)", () => {
  it("Kanıt yok → unknown", () => {
    const r = computePreference(makeMasses({ evidenceCount: 0, evidenceMass: 0 }));
    assert.strictEqual(r.status, "unknown");
  });

  it("1 kanıt (< MIN_EVIDENCE_FOR_DIRECTIONAL=3) → unknown", () => {
    const r = computePreference(makeMasses({
      posMass: 1.0, evidenceMass: 1.0, evidenceCount: 1,
    }));
    assert.strictEqual(r.status, "unknown");
  });

  it("Her iki yön de güçlü → mixed", () => {
    // Spec BÖLÜM 8'deki kritik test
    const masses = makeMasses({
      posMass: 5.0,
      negMass: 4.0,
      uncertainMass: 0,
      evidenceMass: 9.0,
      evidenceCount: 10,
      topPositiveContentIds: ["movie:1", "movie:2", "movie:3"],
      topNegativeContentIds: ["movie:4", "movie:5"],
    });
    const result = computePreference(masses);
    assert.strictEqual(result.status, "mixed");
  });

  it("Belirgin pozitif yön → directional", () => {
    const masses = makeMasses({
      posMass: 8.0,
      negMass: 0,
      uncertainMass: 0,
      evidenceMass: 8.0,
      evidenceCount: 5,
    });
    const r = computePreference(masses);
    assert.strictEqual(r.status, "directional");
  });

  it("Nötr ağırlıklı → neutral (not unknown)", () => {
    const masses = makeMasses({
      posMass: 0.5,
      negMass: 0.2,
      uncertainMass: 5.0,
      evidenceMass: 5.7,
      evidenceCount: 4,
    });
    const r = computePreference(masses);
    assert.strictEqual(r.status, "neutral");
  });
});

// === longTermAffinity ve recentAffinity ===

describe("Preference Calculator — V1 Zaman Katmanları", () => {
  it("V1'de longTermAffinity = recentAffinity = affinity", () => {
    const masses = makeMasses({
      posMass: 3.0,
      negMass: 0,
      uncertainMass: 0,
      evidenceMass: 3.0,
      evidenceCount: 3,
    });
    const r = computePreference(masses);
    assert.strictEqual(r.longTermAffinity, r.affinity);
    assert.strictEqual(r.recentAffinity, r.affinity);
  });
});

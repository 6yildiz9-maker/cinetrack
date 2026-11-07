/**
 * Faz 3 — Evidence Ledger Testleri
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EvidenceLedger } from "../../src/core/taste/evidence-ledger.ts";

// === Fixture ===
let _counter = 0;
function makeEvent(overrides = {}) {
  _counter++;
  return {
    eventId: `evt-${_counter}`,
    contentId: "movie:550",
    eventType: "rating_changed",
    payload: { previousValue: null, newValue: 8 },
    recordedAt: "2026-01-01T00:00:00.000Z",
    timeSource: "actual",
    timePrecision: "exact",
    ...overrides,
  };
}

describe("Evidence Ledger — Temel Ekleme", () => {
  it("Puanlı olay kanıt oluşturur", () => {
    const ledger = new EvidenceLedger();
    const event = makeEvent({ payload: { previousValue: null, newValue: 8 } });
    ledger.addEvent(event, "genre.drama", 100, 0.95, 1.0, 1.0);
    const masses = ledger.computeMasses("genre.drama");
    assert.ok(masses.evidenceCount > 0);
    assert.ok(masses.posMass > 0);
  });

  it("Niyet (watchlist) kanıt oluşturmaz — isEvidence: false", () => {
    const ledger = new EvidenceLedger();
    const event = makeEvent({
      eventType: "status_changed",
      payload: { previousValue: null, newValue: "watchlist" },
    });
    ledger.addEvent(event, "genre.drama", 100, 0.95, 1.0, 1.0);
    const masses = ledger.computeMasses("genre.drama");
    assert.strictEqual(masses.evidenceCount, 0, "Niyet kanıt sayılmamalı");
  });

  it("hidden olay kanıt oluşturmaz", () => {
    const ledger = new EvidenceLedger();
    const event = makeEvent({ eventType: "content_hidden", payload: { previousValue: null, newValue: "hidden" } });
    ledger.addEvent(event, "genre.drama", 100, 0.95, 1.0, 1.0);
    const masses = ledger.computeMasses("genre.drama");
    assert.strictEqual(masses.evidenceCount, 0, "hidden kanıt sayılmamalı");
  });
});

describe("Evidence Ledger — Idempotency (TP-005)", () => {
  it("Aynı eventId iki kez işlenmez (idempotent)", () => {
    const ledger = new EvidenceLedger();
    const event = makeEvent({ eventId: "sabit-id-001" });
    ledger.addEvent(event, "genre.drama", 100, 0.95, 1.0, 1.0);
    ledger.addEvent(event, "genre.drama", 100, 0.95, 1.0, 1.0); // tekrar
    const masses = ledger.computeMasses("genre.drama");
    assert.strictEqual(masses.evidenceCount, 1, "Çift sayım yapılmamalı");
  });

  it("Farklı eventId → iki ayrı kanıt", () => {
    const ledger = new EvidenceLedger();
    const e1 = makeEvent({ eventId: "id-a", contentId: "movie:1", payload: { previousValue: null, newValue: 9 } });
    const e2 = makeEvent({ eventId: "id-b", contentId: "movie:2", payload: { previousValue: null, newValue: 8 } });
    ledger.addEvent(e1, "genre.drama", 100, 0.95, 1.0, 1.0);
    ledger.addEvent(e2, "genre.drama", 100, 0.95, 1.0, 1.0);
    const masses = ledger.computeMasses("genre.drama");
    assert.strictEqual(masses.evidenceCount, 2);
  });

  it("Aynı olay farklı metrikler için bir kez sayılır", () => {
    const ledger = new EvidenceLedger();
    const event = makeEvent({ eventId: "multi-metric-001" });
    ledger.addEvent(event, "genre.drama", 100, 0.95, 1.0, 1.0);
    ledger.addEvent(event, "mood.dark", 80, 0.8, 1.0, 1.0);
    ledger.addEvent(event, "concept.identity", 70, 0.7, 1.0, 1.0);

    assert.strictEqual(ledger.computeMasses("genre.drama").evidenceCount, 1, "genre kanıtı olmalı");
    assert.strictEqual(ledger.computeMasses("mood.dark").evidenceCount, 1, "mood kanıtı olmalı");
    assert.strictEqual(ledger.computeMasses("concept.identity").evidenceCount, 1, "concept kanıtı olmalı");
    assert.ok(ledger.computeMasses("mood.dark").posMass > 0, "mood posMass > 0");
  });
});

describe("Evidence Ledger — Katkı Geri Çekme (TP-005)", () => {
  it("removeContributions içeriğin katkısını geri çeker", () => {
    const ledger = new EvidenceLedger();
    const event = makeEvent({ contentId: "movie:100", payload: { previousValue: null, newValue: 9 } });
    ledger.addEvent(event, "genre.drama", 100, 0.95, 1.0, 1.0);

    const before = ledger.computeMasses("genre.drama");
    assert.ok(before.evidenceCount > 0);

    ledger.removeContributions("movie:100");

    const after = ledger.computeMasses("genre.drama");
    assert.strictEqual(after.evidenceCount, 0, "Katkı geri çekilmeli");
    assert.strictEqual(after.posMass, 0);
  });

  it("Olay ≠ kanıt: puan değişiminde removeContributions + yeni addEvent doğru çalışır", () => {
    const ledger = new EvidenceLedger();
    const e1 = makeEvent({ eventId: "v1", contentId: "movie:200", payload: { previousValue: null, newValue: 9 } });
    ledger.addEvent(e1, "genre.drama", 100, 0.95, 1.0, 1.0);

    const massesV1 = ledger.computeMasses("genre.drama");
    const posMassV1 = massesV1.posMass;

    // Puan değişiyor: eski katkıyı geri çek, yeni puanla ekle
    ledger.removeContributions("movie:200");
    const e2 = makeEvent({ eventId: "v2", contentId: "movie:200", payload: { previousValue: 9, newValue: 3 } });
    ledger.addEvent(e2, "genre.drama", 100, 0.95, 1.0, 1.0);

    const massesV2 = ledger.computeMasses("genre.drama");
    // Eski pozitif katkı gitti, yeni negatif katkı geldi
    assert.ok(massesV2.negMass > 0, "Negatif kanıt oluşmalı");
    assert.ok(massesV2.posMass < posMassV1, "Eski pozitif katkı geri çekilmeli");
    assert.strictEqual(massesV2.evidenceCount, 1, "Hâlâ tek içerik");
  });
});

describe("Evidence Ledger — Kütleler (TP-015)", () => {
  it("posMass / negMass / uncertainMass doğru ayrılmalı", () => {
    const ledger = new EvidenceLedger();

    // 9 puanlı → pozitif kanıt (signal=+1.0)
    const ep = makeEvent({ eventId: "pos", contentId: "movie:P", payload: { previousValue: null, newValue: 9 } });
    // 1 puanlı → negatif kanıt (signal=-1.0)
    const en = makeEvent({ eventId: "neg", contentId: "movie:N", payload: { previousValue: null, newValue: 1 } });
    // 5 puanlı → nötr sinyal (signal=0), kanıt sayılır (isEvidence=true)
    // baseWeight = featureStrength/100 * confidence * time * damping > 0
    // contribution = signal * baseWeight = 0 * baseWeight = 0
    // → uncertainMass += baseWeight → nötr kanıt paydada kalır (KRİTİK KURAL)
    const eu = makeEvent({ eventId: "neu", contentId: "movie:U", payload: { previousValue: null, newValue: 5 } });

    ledger.addEvent(ep, "genre.drama", 100, 0.95, 1.0, 1.0);
    ledger.addEvent(en, "genre.drama", 100, 0.95, 1.0, 1.0);
    ledger.addEvent(eu, "genre.drama", 100, 0.95, 1.0, 1.0);

    const masses = ledger.computeMasses("genre.drama");

    assert.ok(masses.posMass > 0, "posMass > 0");
    assert.ok(masses.negMass > 0, "negMass > 0");
    // Nötr sinyal (5 puan) → baseWeight > 0 → uncertainMass > 0 (KRİTİK)
    assert.ok(masses.uncertainMass > 0, "uncertainMass > 0 — nötr kanıt paydada kalır");
    assert.strictEqual(masses.evidenceCount, 3, "3 kanıt sayılmalı");

    // D_m = posMass + negMass + uncertainMass
    const expectedEvidenceMass = masses.posMass + masses.negMass + masses.uncertainMass;
    assert.ok(
      Math.abs(masses.evidenceMass - expectedEvidenceMass) < 0.0001,
      "evidenceMass = posMass + negMass + uncertainMass"
    );
  });

  it("Nötr kanıt evidenceMass'a dahil edilmeli (KRİTİK KURAL)", () => {
    const ledger = new EvidenceLedger();
    const eu = makeEvent({ eventId: "only-neu", contentId: "movie:U", payload: { previousValue: null, newValue: 6 } });
    ledger.addEvent(eu, "genre.drama", 100, 1.0, 1.0, 1.0);
    const masses = ledger.computeMasses("genre.drama");
    // signal=0 → contribution=0, ama baseWeight = (100/100)*1.0*1.0*1.0 = 1.0
    // → uncertainMass = 1.0 → nötr kanıt paydada kalır (KRİTİK KURAL)
    assert.strictEqual(masses.evidenceCount, 1);
    assert.ok(masses.uncertainMass > 0, "Nötr kanıt uncertainMass > 0 olmalı");
    assert.ok(masses.evidenceMass > 0, "Nötr kanıt evidenceMass > 0 olmalı (paydada kalır)");
  });

  it("topPositiveContentIds en fazla 3 içerik içermeli", () => {
    const ledger = new EvidenceLedger();
    for (let i = 1; i <= 5; i++) {
      const e = makeEvent({
        eventId: `pos-${i}`,
        contentId: `movie:${i}`,
        payload: { previousValue: null, newValue: 9 },
      });
      ledger.addEvent(e, "genre.scifi", 100, 0.95, 1.0, 1.0);
    }
    const masses = ledger.computeMasses("genre.scifi");
    assert.ok(masses.topPositiveContentIds.length <= 3, "En fazla 3 içerik");
  });
});

describe("Evidence Ledger — content_disliked", () => {
  it("content_disliked olayı negatif kanıt oluşturur", () => {
    const ledger = new EvidenceLedger();
    const event = makeEvent({
      eventType: "content_disliked",
      payload: { previousValue: null, newValue: "disliked" },
    });
    ledger.addEvent(event, "genre.drama", 100, 0.95, 1.0, 1.0);
    const masses = ledger.computeMasses("genre.drama");
    assert.strictEqual(masses.evidenceCount, 1);
    assert.ok(masses.negMass > 0, "content_disliked negatif kanıt üretmeli");
  });
});

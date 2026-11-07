/**
 * Faz 3 — Behavior Signals Testleri
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeBehaviorSignal } from "../../src/core/taste/behavior-signals.ts";
import { BEHAVIOR_SIGNALS } from "../../src/core/taste/constants.ts";

describe("Behavior Signals — Puan Sinyalleri", () => {
  it("9-10 → +1.00 kanıt", () => {
    const r = computeBehaviorSignal({ type: "rating", value: 10 });
    assert.strictEqual(r.signal, BEHAVIOR_SIGNALS.rating_9_10);
    assert.strictEqual(r.isEvidence, true);
    assert.strictEqual(r.category, "positive");
  });

  it("8-8.99 → +0.75 kanıt", () => {
    const r = computeBehaviorSignal({ type: "rating", value: 8 });
    assert.strictEqual(r.signal, BEHAVIOR_SIGNALS.rating_8_89);
    assert.strictEqual(r.isEvidence, true);
  });

  it("7-7.99 → +0.45 kanıt", () => {
    const r = computeBehaviorSignal({ type: "rating", value: 7 });
    assert.strictEqual(r.signal, BEHAVIOR_SIGNALS.rating_7_79);
  });

  it("5-6.99 → 0 nötr (paydada kalır, kanıt sayılır)", () => {
    const r = computeBehaviorSignal({ type: "rating", value: 6 });
    assert.strictEqual(r.signal, BEHAVIOR_SIGNALS.rating_5_69);
    assert.strictEqual(r.signal, 0);
    assert.strictEqual(r.isEvidence, true); // nötr ama kanıt
    assert.strictEqual(r.category, "neutral");
  });

  it("5 nötr kanıt (alt sınır)", () => {
    const r = computeBehaviorSignal({ type: "rating", value: 5 });
    assert.strictEqual(r.signal, 0);
    assert.strictEqual(r.isEvidence, true);
  });

  it("3-4.99 → -0.55 negatif kanıt", () => {
    const r = computeBehaviorSignal({ type: "rating", value: 4 });
    assert.strictEqual(r.signal, BEHAVIOR_SIGNALS.rating_3_49);
    assert.strictEqual(r.isEvidence, true);
    assert.strictEqual(r.category, "negative");
  });

  it("1-2.99 → -1.00 negatif kanıt", () => {
    const r = computeBehaviorSignal({ type: "rating", value: 1 });
    assert.strictEqual(r.signal, BEHAVIOR_SIGNALS.rating_1_29);
    assert.strictEqual(r.signal, -1.0);
    assert.strictEqual(r.isEvidence, true);
    assert.strictEqual(r.category, "negative");
  });

  it("Puan 9 → +1.00 (tam sınır testi)", () => {
    const r = computeBehaviorSignal({ type: "rating", value: 9 });
    assert.strictEqual(r.signal, 1.0);
  });

  it("Puan 0 → geçersiz, sinyal 0, ratingSource numeric", () => {
    const r = computeBehaviorSignal({ type: "rating", value: 0 });
    assert.strictEqual(r.signal, 0);
  });

  it("ratingSource: quick ile quick_feedback gibi değil, rating olarak işlenir", () => {
    const r = computeBehaviorSignal({ type: "rating", value: 9, source: "quick" });
    assert.strictEqual(r.ratingSource, "quick");
    assert.strictEqual(r.signal, 1.0);
  });
});

describe("Behavior Signals — Hızlı Geri Bildirim", () => {
  it("quick like → +0.75, kanıt, ratingSource: quick", () => {
    const r = computeBehaviorSignal({ type: "quick_feedback", value: "like" });
    assert.strictEqual(r.signal, BEHAVIOR_SIGNALS.quick_like);
    assert.strictEqual(r.isEvidence, true);
    assert.strictEqual(r.ratingSource, "quick");
    assert.strictEqual(r.category, "positive");
  });

  it("quick dislike → -0.55, kanıt", () => {
    const r = computeBehaviorSignal({ type: "quick_feedback", value: "dislike" });
    assert.strictEqual(r.signal, BEHAVIOR_SIGNALS.quick_dislike);
    assert.strictEqual(r.isEvidence, true);
    assert.strictEqual(r.category, "negative");
  });

  it("quick neutral → 0, kanıt ama nötr", () => {
    const r = computeBehaviorSignal({ type: "quick_feedback", value: "neutral" });
    assert.strictEqual(r.signal, 0);
    assert.strictEqual(r.isEvidence, true);
    assert.strictEqual(r.category, "neutral");
  });
});

describe("Behavior Signals — Niyet (kanıt sayacına girmez)", () => {
  it("watchlist → +0.25, isEvidence: false, category: intent", () => {
    const r = computeBehaviorSignal({ type: "intent", value: "watchlist" });
    assert.strictEqual(r.signal, BEHAVIOR_SIGNALS.watchlist);
    assert.strictEqual(r.isEvidence, false); // KRİTİK: kanıt değil
    assert.strictEqual(r.category, "intent");
  });

  it("watching → +0.10, isEvidence: false", () => {
    const r = computeBehaviorSignal({ type: "intent", value: "watching" });
    assert.strictEqual(r.signal, BEHAVIOR_SIGNALS.watching);
    assert.strictEqual(r.isEvidence, false);
  });
});

describe("Behavior Signals — İzlendi ama puan verilmedi", () => {
  it("watched_no_rating → zayıf pozitif kanıt", () => {
    const r = computeBehaviorSignal({ type: "watched_no_rating" });
    assert.strictEqual(r.signal, BEHAVIOR_SIGNALS.watched_no_rating);
    assert.ok(r.signal > 0);
    assert.strictEqual(r.isEvidence, true);
    assert.strictEqual(r.category, "positive");
  });
});

describe("Behavior Signals — Dışlama (sinyal üretmez)", () => {
  it("not_interested → 0, isEvidence: false, exclusion", () => {
    const r = computeBehaviorSignal({ type: "not_interested" });
    assert.strictEqual(r.signal, 0);
    assert.strictEqual(r.isEvidence, false);
    assert.strictEqual(r.category, "exclusion");
  });

  it("hidden → 0, isEvidence: false, exclusion", () => {
    const r = computeBehaviorSignal({ type: "hidden" });
    assert.strictEqual(r.signal, 0);
    assert.strictEqual(r.isEvidence, false);
    assert.strictEqual(r.category, "exclusion");
  });
});

describe("Behavior Signals — Bırakma", () => {
  it("abandoned disliked → -0.80, isEvidence: true (negatif kanıt)", () => {
    const r = computeBehaviorSignal({ type: "abandoned", reason: "disliked" });
    assert.strictEqual(r.signal, BEHAVIOR_SIGNALS.abandoned_disliked);
    assert.strictEqual(r.isEvidence, true); // yalnızca beğenmedim negatif kanıt
    assert.strictEqual(r.category, "negative");
  });

  it("abandoned time → 0, isEvidence: false", () => {
    const r = computeBehaviorSignal({ type: "abandoned", reason: "time" });
    assert.strictEqual(r.signal, 0);
    assert.strictEqual(r.isEvidence, false);
  });

  it("abandoned access → 0, isEvidence: false", () => {
    const r = computeBehaviorSignal({ type: "abandoned", reason: "access" });
    assert.strictEqual(r.signal, 0);
    assert.strictEqual(r.isEvidence, false);
  });

  it("abandoned paused → +0.10, isEvidence: false", () => {
    const r = computeBehaviorSignal({ type: "abandoned", reason: "paused" });
    assert.strictEqual(r.signal, BEHAVIOR_SIGNALS.abandoned_paused);
    assert.strictEqual(r.isEvidence, false);
  });

  it("abandoned varsayılan (reason yok) → disliked gibi davranır", () => {
    const r = computeBehaviorSignal({ type: "abandoned" });
    assert.strictEqual(r.signal, BEHAVIOR_SIGNALS.abandoned_disliked);
    assert.strictEqual(r.isEvidence, true);
  });
});

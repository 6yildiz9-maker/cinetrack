/**
 * Stok Arındırma + Gerçek Sayı Gösterimi (Sorun 1) ve
 * Olay Güdümlü Canlı Zevk Profili Hesaplaması (Sorun 2) Testleri
 * Referans ADR'ler: TP-001, TP-005, TP-015, TP-018, TP-021, TP-028, TP-029
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isCandidateEligibleForStock,
  getStockMovies,
  getStockSeries,
} from "../../src/services/stock-engine.ts";
import { aggregateProfiles } from "../../src/core/taste/profile-aggregator.ts";
import {
  notifyTasteProfileUpdated,
  subscribeTasteProfileUpdated,
} from "../../src/services/taste-api.ts";

const AS_OF = "2026-11-02T12:00:00.000Z";

describe("Sorun 1 — isCandidateEligibleForStock ve TP-018 Ayrımı", () => {
  const userItems = [
    { id: 101, media_type: "movie", status: "watching" },
    { id: 102, media_type: "movie", status: "watchlist" },
    { id: 103, media_type: "movie", status: "completed" },
    { id: 201, media_type: "tv", status: "watchlist" },
  ];

  const preferences = {
    disliked: ["movie:301", "tv:302"], // TP-018: negatif sinyal
    hidden: ["movie:401", "tv:402"],   // TP-018: nötr dışlama
  };

  it("watching, watchlist ve completed listelerindeki içerikler stoka giremez", () => {
    assert.strictEqual(
      isCandidateEligibleForStock({ id: 101, media_type: "movie" }, userItems, preferences),
      false
    );
    assert.strictEqual(
      isCandidateEligibleForStock({ id: 102, media_type: "movie" }, userItems, preferences),
      false
    );
    assert.strictEqual(
      isCandidateEligibleForStock({ id: 103, media_type: "movie" }, userItems, preferences),
      false
    );
    assert.strictEqual(
      isCandidateEligibleForStock({ id: 201, media_type: "tv" }, userItems, preferences),
      false
    );
  });

  it("preferences.disliked (negatif sinyal) ve preferences.hidden (nötr dışlama) ayrı ayrı elenir (TP-018)", () => {
    assert.strictEqual(
      isCandidateEligibleForStock({ id: 301, media_type: "movie" }, [], { disliked: ["movie:301"], hidden: [] }),
      false
    );
    assert.strictEqual(
      isCandidateEligibleForStock({ id: 401, media_type: "movie" }, [], { disliked: [], hidden: ["movie:401"] }),
      false
    );
    assert.strictEqual(
      isCandidateEligibleForStock({ id: 302, media_type: "tv" }, [], preferences),
      false
    );
    assert.strictEqual(
      isCandidateEligibleForStock({ id: 402, media_type: "tv" }, [], preferences),
      false
    );
  });

  it("zaten stokta bulunan içerikler çift kayıt önleme ile elenir", () => {
    const existingStock = new Set(["movie:555"]);
    assert.strictEqual(
      isCandidateEligibleForStock({ id: 555, media_type: "movie" }, userItems, preferences, existingStock),
      false
    );
  });

  it("listelerde, disliked, hidden ve mevcut stokta olmayan taze içerik kabul edilir", () => {
    const existingStock = new Set(["movie:555"]);
    assert.strictEqual(
      isCandidateEligibleForStock({ id: 999, media_type: "movie" }, userItems, preferences, existingStock),
      true
    );
    assert.strictEqual(
      isCandidateEligibleForStock({ id: 888, media_type: "tv" }, userItems, preferences, existingStock),
      true
    );
  });

  it("getStockMovies ve getStockSeries gerçek .length dizisi döndürür", () => {
    const movies = getStockMovies(userItems, preferences);
    const series = getStockSeries(userItems, preferences);
    assert.ok(Array.isArray(movies));
    assert.ok(Array.isArray(series));
  });
});

describe("Sorun 2 — Olay Güdümlü Canlı Profil Hesaplaması (TP-005 / TP-015 / TP-018 / TP-021)", () => {
  const sampleIndex = {
    "movie:550": {
      contentId: "movie:550",
      mediaType: "movie",
      extractedAt: AS_OF,
      metadataHash: "h1",
      completeness: 0.4,
      features: {
        "genre.drama": { strength: 90, confidence: 1.0, source: "tmdb", state: "present" },
        "mood.dark": { strength: 80, confidence: 0.85, source: "tmdb", state: "present" },
      },
    },
    "movie:600": {
      contentId: "movie:600",
      mediaType: "movie",
      extractedAt: AS_OF,
      metadataHash: "h2",
      completeness: 0.4,
      features: {
        "genre.drama": { strength: 85, confidence: 1.0, source: "tmdb", state: "present" },
      },
    },
  };

  it("tek yüksek puanlı film SHRINKAGE_K=2.5 ile pozitif ama +100 olmayan afinite üretir (TP-021)", () => {
    const events = [
      {
        eventId: "ev-1",
        contentId: "movie:550",
        eventType: "rating_changed",
        payload: { previousValue: null, newValue: 9, ratingSource: "numeric" },
        recordedAt: "2026-11-01T10:00:00.000Z",
        experiencedAt: "2026-11-01T10:00:00.000Z",
        timeSource: "actual",
        timePrecision: "exact",
      },
    ];

    const profiles = aggregateProfiles(events, AS_OF, sampleIndex);
    const drama = profiles.unified.metrics["genre.drama"];
    assert.ok(drama, "genre.drama metriği bulunmalı");
    assert.ok(drama.affinity > 0, "Pozitif afinite üretmeli");
    assert.ok(drama.affinity < 100, "Tek içerik +100 afiniteye fırlamamalı (SHRINKAGE_K=2.5)");
    assert.ok(drama.evidence.posMass > 0, "posMass > 0 olmalı");
  });

  it("aynı içerik yeniden puanlandığında eski katkı geri çekilir, çift sayılmaz (TP-005)", () => {
    const events = [
      {
        eventId: "ev-old",
        contentId: "movie:550",
        eventType: "rating_changed",
        payload: { previousValue: null, newValue: 10, ratingSource: "numeric" },
        recordedAt: "2026-11-01T10:00:00.000Z",
        experiencedAt: "2026-11-01T10:00:00.000Z",
        timeSource: "actual",
        timePrecision: "exact",
      },
      {
        eventId: "ev-new",
        contentId: "movie:550",
        eventType: "rating_changed",
        payload: { previousValue: 10, newValue: 2, ratingSource: "numeric" },
        recordedAt: "2026-11-02T10:00:00.000Z",
        experiencedAt: "2026-11-02T10:00:00.000Z",
        timeSource: "actual",
        timePrecision: "exact",
      },
    ];

    const profiles = aggregateProfiles(events, AS_OF, sampleIndex);
    const drama = profiles.unified.metrics["genre.drama"];
    assert.strictEqual(drama.evidence.posMass, 0, "Eski pozitif katkı tamamen geri çekilmeli");
    assert.ok(drama.evidence.negMass > 0, "Yeni negatif katkı aktif olmalı");
    assert.ok(drama.affinity < 0, "Afinite negatife dönmeli");
  });

  it("content_disliked negatif kanıt üretir, content_hidden nötr dışlama olarak sıfır kütle bırakır (TP-018)", () => {
    const dislikedProfiles = aggregateProfiles(
      [
        {
          eventId: "ev-dis",
          contentId: "movie:550",
          eventType: "content_disliked",
          payload: { newValue: true, reason: "disliked" },
          recordedAt: AS_OF,
          timeSource: "actual",
          timePrecision: "exact",
        },
      ],
      AS_OF,
      sampleIndex
    );
    assert.ok(dislikedProfiles.unified.metrics["genre.drama"].evidence.negMass > 0);
    assert.ok(dislikedProfiles.unified.metrics["genre.drama"].affinity < 0);

    const hiddenProfiles = aggregateProfiles(
      [
        {
          eventId: "ev-hid",
          contentId: "movie:600",
          eventType: "content_hidden",
          payload: { newValue: true },
          recordedAt: AS_OF,
          timeSource: "actual",
          timePrecision: "exact",
        },
      ],
      AS_OF,
      sampleIndex
    );
    assert.strictEqual(hiddenProfiles.unified.metrics["genre.drama"].evidence.negMass, 0);
    assert.strictEqual(hiddenProfiles.unified.metrics["genre.drama"].affinity, 0);
  });

  it("subscribeTasteProfileUpdated canlı bildirimleri anında iletir", () => {
    const received = [];
    const unsub = subscribeTasteProfileUpdated((sig) => {
      received.push(sig);
    });
    notifyTasteProfileUpdated({ generationId: "gen-42", reason: "rating_changed" });
    unsub();
    notifyTasteProfileUpdated({ generationId: "gen-43", reason: "ignored" });

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].generationId, "gen-42");
    assert.strictEqual(received[0].reason, "rating_changed");
  });
});

/**
 * Stok Arındırma + Gerçek Sayı Gösterimi (Sorun 1) ve
 * Olay Güdümlü Canlı Zevk Profili Hesaplaması (Sorun 2) Testleri
 * Referans ADR'ler: TP-001, TP-005, TP-015, TP-018, TP-021, TP-028, TP-029
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import {
  isCandidateEligibleForStock,
  getStockMovies,
  getStockSeries,
} from "../../src/services/stock-engine.ts";
import { aggregateProfiles } from "../../src/core/taste/profile-aggregator.ts";
import { TAXONOMY_V01 } from "../../src/core/taste/taxonomy.ts";
import {
  getCategoryDisplayLabel,
  getMetricDisplayTitle,
  getStatusLabelTr,
  resolveEffectiveMetricView,
} from "../../src/core/taste/metric-labels.ts";
import { createRecommendationAdapter } from "../../src/core/taste/recommendation-adapter.ts";
import { createTasteRouter } from "../../src/server/taste-routes.ts";
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

describe("Derin Sinema Kabuk, Exclude Override ve V1.5 Etiket İtirazı", () => {
  it("tüm 42 taksonomi metriği Türkçe başlığa sahiptir ve exclude/boost/suppress override efektif afiniteyi yönlendirir", () => {
    for (const def of TAXONOMY_V01) {
      const title = getMetricDisplayTitle(def.id);
      assert.ok(title && title !== def.id, `${def.id} için okunabilir Türkçe başlık üretilmeli`);
      assert.ok(getCategoryDisplayLabel(def.categoryId).length > 0);
    }
    assert.strictEqual(getStatusLabelTr("directional"), "Güçlü Eğilim");
    assert.strictEqual(getStatusLabelTr("excluded"), "İlgisiz");

    const baseMetric = {
      affinity: 50,
      confidence: 80,
      polarity: 10,
      stability: 80,
      status: "directional",
      evidence: {
        posMass: 4,
        negMass: 0.4,
        uncertainMass: 0,
        topPositiveContentIds: ["movie:27205"],
        topNegativeContentIds: [],
      },
      updatedAt: AS_OF,
    };

    const boosted = resolveEffectiveMetricView({
      ...baseMetric,
      manualOverride: { mode: "boost", value: 35 },
    });
    assert.strictEqual(boosted.effectiveAffinity, 85);
    assert.strictEqual(boosted.hasOverride, true);

    const excluded = resolveEffectiveMetricView({
      ...baseMetric,
      manualOverride: { mode: "exclude", value: 0 },
    });
    assert.strictEqual(excluded.isExcluded, true);
    assert.strictEqual(excluded.effectiveAffinity, 0);

    // Recommendation adapter excluded metriği tamamen atlar
    const profileWithExclude = {
      mediaType: "unified",
      algorithmVersion: "1.0.0",
      taxonomyVersion: "v0.1",
      asOf: AS_OF,
      metrics: {
        "genre.scifi": {
          metricId: "genre.scifi",
          affinity: 50,
          longTermAffinity: 50,
          recentAffinity: 50,
          status: "directional",
          evidence: baseMetric.evidence,
          manualOverride: { mode: "exclude", value: 0 },
        },
      },
    };
    const candidateEntry = {
      contentId: "movie:157336",
      mediaType: "movie",
      extractedAt: AS_OF,
      metadataHash: "h",
      completeness: 0.5,
      features: {
        "genre.scifi": { strength: 95, confidence: 1.0, source: "tmdb", state: "present" },
      },
    };
    const adapter = createRecommendationAdapter();
    const [adapted] = adapter.suggestFor(
      [{ contentId: "movie:157336", mediaType: "movie" }],
      "movie",
      profileWithExclude,
      { "movie:157336": candidateEntry }
    );
    assert.strictEqual(adapted.tasteFit, 0);
    assert.strictEqual(adapted.reasonIds.length, 0);
  });

  it("GET /api/taste/metric/:id kanıt başlıklarını zenginleştirir ve POST /api/taste/objection cinetrack-data.json'a dokunmadan etiketi düşürür", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-derin-sinema-"));
    try {
      const userDoc = {
        profiles: [
          {
            id: "profile-default",
            name: "Test",
            items: [
              {
                id: 27205,
                media_type: "movie",
                title: "Başlangıç",
                release_date: "2010-07-15",
                poster_path: "/inception.jpg",
                status: "completed",
                personal_rating: 9,
                genre_ids: [878, 53],
              },
            ],
            preferences: { disliked: [], hidden: [] },
          },
        ],
      };
      const userDataPath = path.join(tmpDir, "cinetrack-data.json");
      const rawUserJson = JSON.stringify(userDoc, null, 2);
      fs.writeFileSync(userDataPath, rawUserJson, "utf8");

      const tasteDir = path.join(tmpDir, "taste");
      fs.mkdirSync(tasteDir, { recursive: true });

      const app = express();
      app.use(express.json());
      app.use("/api/taste", createTasteRouter(tmpDir));

      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}/api/taste`;

      try {
        // 1. Puanlama olayı göndererek canlı profil oluştur
        const evRes = await fetch(`${baseUrl}/event`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: {
              eventId: "evt-inception-9",
              contentId: "movie:27205",
              eventType: "rating_changed",
              payload: { previousValue: null, newValue: 9, ratingSource: "numeric" },
              recordedAt: AS_OF,
              experiencedAt: AS_OF,
              timeSource: "actual",
              timePrecision: "exact",
            },
            metadata: {
              contentId: "movie:27205",
              mediaType: "movie",
              tmdbId: 27205,
              genreIds: [878, 53],
              releaseDate: "2010-07-15",
            },
          }),
        });
        assert.strictEqual(evRes.status, 200);

        // 2. Metrik detayında gerçek film başlığı, yıl, poster ve kişisel puan yer almalı
        const detailRes = await fetch(`${baseUrl}/metric/genre.scifi`);
        assert.strictEqual(detailRes.status, 200);
        const detailBody = await detailRes.json();
        assert.ok(detailBody.explanation.positiveEvidence.length >= 1);
        const evItem = detailBody.explanation.positiveEvidence[0];
        assert.strictEqual(evItem.contentId, "movie:27205");
        assert.strictEqual(evItem.title, "Başlangıç");
        assert.strictEqual(evItem.year, "2010");
        assert.strictEqual(evItem.posterPath, "/inception.jpg");
        assert.strictEqual(evItem.personalRating, 9);

        // 3. Exclude override modunu doğrula
        const ovRes = await fetch(`${baseUrl}/override`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ metricId: "genre.thriller", value: 0, mode: "exclude" }),
        });
        assert.strictEqual(ovRes.status, 200);
        const ovBody = await ovRes.json();
        assert.strictEqual(ovBody.metric.manualOverride.mode, "exclude");

        // 4. V1.5 "Bu yapımda yok" itirazını doğrula
        const objRes = await fetch(`${baseUrl}/objection`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentId: "movie:27205", metricId: "genre.scifi" }),
        });
        assert.strictEqual(objRes.status, 200);

        const afterObjRes = await fetch(`${baseUrl}/metric/genre.scifi`);
        const afterObjBody = await afterObjRes.json();
        assert.strictEqual(afterObjBody.explanation.positiveEvidence.length, 0);

        // cinetrack-data.json bayt-bayt dokunulmamış olmalı
        assert.strictEqual(fs.readFileSync(userDataPath, "utf8"), rawUserJson);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});


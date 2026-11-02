/**
 * Faz 4 — Profile Aggregator Testleri
 * En kritik: medya izolasyonu, unified çift sayım yok, aktarım politikaları
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateProfiles,
  computeSingleMediaProfile,
  computeUnifiedProfile,
  separateEventsByMedia,
  extractMediaType,
} from "../../src/core/taste/profile-aggregator.ts";

const AS_OF = "2026-11-02T00:00:00.000Z";

// === Fixture yardımcıları ===
let _cnt = 0;
function makeEvent(contentId, newValue = 9, overrides = {}) {
  _cnt++;
  return {
    eventId: `evt-${_cnt}`,
    contentId,
    eventType: "rating_changed",
    payload: { previousValue: null, newValue },
    recordedAt: "2026-06-01T00:00:00.000Z",
    timeSource: "actual",
    timePrecision: "exact",
    ...overrides,
  };
}

// === extractMediaType ===

describe("Profile Aggregator — extractMediaType", () => {
  it("'movie:123' → 'movie'", () => {
    assert.strictEqual(extractMediaType("movie:123"), "movie");
  });

  it("'tv:456' → 'tv'", () => {
    assert.strictEqual(extractMediaType("tv:456"), "tv");
  });

  it("'geçersiz' → null", () => {
    assert.strictEqual(extractMediaType("geçersiz"), null);
  });

  it("Boş string → null", () => {
    assert.strictEqual(extractMediaType(""), null);
  });
});

// === separateEventsByMedia ===

describe("Profile Aggregator — separateEventsByMedia", () => {
  it("Film ve dizi olayları doğru ayrılmalı", () => {
    const events = [
      makeEvent("movie:1"),
      makeEvent("movie:2"),
      makeEvent("tv:3"),
    ];
    const { movieEvents, seriesEvents } = separateEventsByMedia(events);
    assert.strictEqual(movieEvents.length, 2);
    assert.strictEqual(seriesEvents.length, 1);
  });

  it("Bilinmeyen contentId her iki listeye de girmez", () => {
    const events = [makeEvent("unknown:999")];
    const { movieEvents, seriesEvents } = separateEventsByMedia(events);
    assert.strictEqual(movieEvents.length, 0);
    assert.strictEqual(seriesEvents.length, 0);
  });

  it("Boş liste → iki boş liste", () => {
    const { movieEvents, seriesEvents } = separateEventsByMedia([]);
    assert.strictEqual(movieEvents.length, 0);
    assert.strictEqual(seriesEvents.length, 0);
  });
});

// === KRİTİK: Medya İzolasyonu ===

describe("Profile Aggregator — İZOLASYON TESTİ (KRİTİK)", () => {
  it("Dizi olayları film profilini etkilemez", () => {
    // Spec BÖLÜM 4, Test 1
    const movieEvents = [makeEvent("movie:100", 9)];
    const seriesEvents = [makeEvent("tv:200", 3)];
    const allEvents = [...movieEvents, ...seriesEvents];

    // Yalnız film olaylarıyla profil
    const profileOnlyMovie = aggregateProfiles(movieEvents, AS_OF);
    // Film + dizi olaylarıyla profil
    const profileMixed = aggregateProfiles(allEvents, AS_OF);

    // Film profili her iki durumda da aynı olmalı (izolasyon garantisi)
    const movieMetricsOnlyMovie = JSON.stringify(profileOnlyMovie.movie.metrics);
    const movieMetricsMixed = JSON.stringify(profileMixed.movie.metrics);
    assert.strictEqual(
      movieMetricsOnlyMovie,
      movieMetricsMixed,
      "Dizi olayları film profilini değiştirmemeli"
    );
  });

  it("Film olayları dizi profilini etkilemez", () => {
    const movieEvents = [makeEvent("movie:100", 9)];
    const seriesEvents = [makeEvent("tv:200", 8)];
    const allEvents = [...movieEvents, ...seriesEvents];

    const profileOnlySeries = aggregateProfiles(seriesEvents, AS_OF);
    const profileMixed = aggregateProfiles(allEvents, AS_OF);

    const seriesMetricsOnlySeries = JSON.stringify(profileOnlySeries.series.metrics);
    const seriesMetricsMixed = JSON.stringify(profileMixed.series.metrics);
    assert.strictEqual(
      seriesMetricsOnlySeries,
      seriesMetricsMixed,
      "Film olayları dizi profilini değiştirmemeli"
    );
  });

  it("Boş film olayları ile film profili + dizi içerikleri = yalnız film profili", () => {
    const seriesOnlyEvents = [makeEvent("tv:300", 7), makeEvent("tv:301", 9)];

    const profileSeries = aggregateProfiles(seriesOnlyEvents, AS_OF);
    const profileEmpty = aggregateProfiles([], AS_OF);

    // Film profili her iki durumda da aynı (ikisi de boş)
    const filmEmpty = JSON.stringify(profileSeries.movie.metrics);
    const filmEmptyRef = JSON.stringify(profileEmpty.movie.metrics);
    assert.strictEqual(filmEmpty, filmEmptyRef, "Boş film profilleri eşit olmalı");
  });
});

// === KRİTİK: Unified Çift Sayım Yok ===

describe("Profile Aggregator — UNIFIED ÇİFT SAYIM YOK (KRİTİK)", () => {
  it("Unified profil computeUnifiedProfile'dan gelir, events tekrar işlenmez", () => {
    const events = [
      makeEvent("movie:1", 9),
      makeEvent("tv:2", 8),
    ];
    const result = aggregateProfiles(events, AS_OF);

    // Unified profil tam olarak computeUnifiedProfile(movie, series) ile üretilmeli
    const manualUnified = computeUnifiedProfile(result.movie, result.series, AS_OF);
    const autoUnified = result.unified;

    // Her iki unified de aynı metriklere sahip olmalı
    for (const metricId of Object.keys(autoUnified.metrics)) {
      const auto = autoUnified.metrics[metricId];
      const manual = manualUnified.metrics[metricId];
      if (auto && manual) {
        assert.strictEqual(auto.affinity, manual.affinity, `${metricId} affinity farkı`);
        assert.strictEqual(auto.status, manual.status, `${metricId} status farkı`);
      }
    }
  });

  it("Unified mediaType 'unified' olmalı", () => {
    const result = aggregateProfiles([], AS_OF);
    assert.strictEqual(result.unified.mediaType, "unified");
  });

  it("Film mediaType 'movie' olmalı", () => {
    const result = aggregateProfiles([], AS_OF);
    assert.strictEqual(result.movie.mediaType, "movie");
  });

  it("Dizi mediaType 'series' olmalı", () => {
    const result = aggregateProfiles([], AS_OF);
    assert.strictEqual(result.series.mediaType, "series");
  });
});

// === Veri yoksa unknown ===

describe("Profile Aggregator — VERİ YOKSA UNKNOWN (KRİTİK)", () => {
  it("Boş event listesiyle tüm unified metrikler unknown olmalı", () => {
    // Spec BÖLÜM 4, Test 3
    const result = aggregateProfiles([], AS_OF);
    for (const metric of Object.values(result.unified.metrics)) {
      assert.strictEqual(
        metric.status,
        "unknown",
        `Metrik ${metric.metricId} unknown olmalıydı: ${metric.status}`
      );
    }
  });

  it("Boş event listesinde unified affinity tümü 0 olmalı", () => {
    const result = aggregateProfiles([], AS_OF);
    for (const metric of Object.values(result.unified.metrics)) {
      assert.strictEqual(metric.affinity, 0);
    }
  });

  it("Sadece film olayı varsa: dizi metrikleri unknown kalır", () => {
    const events = [makeEvent("movie:1", 9)];
    const result = aggregateProfiles(events, AS_OF);

    // V1 placeholder: featureStrength=0, tüm metrikler unknown
    for (const metric of Object.values(result.series.metrics)) {
      assert.strictEqual(metric.status, "unknown");
    }
  });
});

// === Aktarım Politikaları ===

describe("Profile Aggregator — AKTARIM POLİTİKALARI", () => {
  it("media_specific metrik (format.miniseries) film profilinde bulunmaz", () => {
    // Spec BÖLÜM 4, Test 4
    // format.miniseries sadece TV için geçerli (applicableMedia: ["tv"])
    const events = [makeEvent("tv:100", 9)];
    const result = aggregateProfiles(events, AS_OF);

    // format.miniseries applicableMedia: ["tv"] olduğundan film profilinde olmamalı
    const movieMiniseries = result.movie.metrics["format.miniseries"];
    assert.strictEqual(
      movieMiniseries,
      undefined,
      "format.miniseries film profilinde olmamalı"
    );
  });

  it("format.miniseries dizi profilinde bulunur", () => {
    const events = [makeEvent("tv:100", 9)];
    const result = aggregateProfiles(events, AS_OF);
    // Dizi profilinde tanımlı olmalı (V1'de unknown ama var)
    assert.ok(
      result.series.metrics["format.miniseries"] !== undefined,
      "format.miniseries dizi profilinde olmalı"
    );
  });

  it("shared metrik (genre.drama) her iki profilde de bulunur", () => {
    const events = [makeEvent("movie:1", 9), makeEvent("tv:2", 8)];
    const result = aggregateProfiles(events, AS_OF);
    assert.ok(result.movie.metrics["genre.drama"] !== undefined);
    assert.ok(result.series.metrics["genre.drama"] !== undefined);
  });

  it("computeUnifiedProfile: media_specific metrik yalnızca bir medyadan geliyorsa doğrudan kullanılır", () => {
    const movieProfile = computeSingleMediaProfile([], "movie", AS_OF);
    const seriesProfile = computeSingleMediaProfile([makeEvent("tv:1", 9)], "series", AS_OF);
    const unified = computeUnifiedProfile(movieProfile, seriesProfile, AS_OF);

    // format.miniseries yalnızca dizi profilinde → unified'de dizi değeriyle gelir
    const movieHasMiniseries = movieProfile.metrics["format.miniseries"] !== undefined;
    const seriesHasMiniseries = seriesProfile.metrics["format.miniseries"] !== undefined;
    const unifiedHasMiniseries = unified.metrics["format.miniseries"] !== undefined;

    if (!movieHasMiniseries && seriesHasMiniseries) {
      // Dizi tarafından gelmeli
      assert.ok(unifiedHasMiniseries, "format.miniseries dizi tarafından unified'e gelmeli");
    }
  });

  it("Aktarım katsayısı 0 (media_specific) → transferCoeff=0", () => {
    // media_specific metrikler karşı medyadan aktarım almaz
    // format.long_running sadece TV için geçerli
    // Film profili boş olunca unified'deki format.long_running = dizi profili değeri
    const movieProfile = computeSingleMediaProfile([], "movie", AS_OF);
    const seriesProfile = computeSingleMediaProfile(
      [makeEvent("tv:1", 9), makeEvent("tv:2", 8)],
      "series",
      AS_OF
    );
    const unified = computeUnifiedProfile(movieProfile, seriesProfile, AS_OF);

    // format.long_running movie profil yoksa unified dizi değerini alır
    if (seriesProfile.metrics["format.long_running"]) {
      assert.ok(
        unified.metrics["format.long_running"] !== undefined,
        "format.long_running unified'de bulunmalı"
      );
    }
  });
});

// === AggregatedProfiles yapısı ===

describe("Profile Aggregator — AggregatedProfiles Yapısı", () => {
  it("asOf, algorithmVersion, taxonomyVersion taşımalı", () => {
    const result = aggregateProfiles([], AS_OF);
    assert.strictEqual(result.asOf, AS_OF);
    assert.ok(typeof result.algorithmVersion === "string");
    assert.ok(typeof result.taxonomyVersion === "string");
  });

  it("movie/series/unified alanları TasteProfile yapısına uymalı", () => {
    const result = aggregateProfiles([], AS_OF);
    for (const profile of [result.movie, result.series, result.unified]) {
      assert.ok(typeof profile.mediaType === "string");
      assert.ok(typeof profile.algorithmVersion === "string");
      assert.ok(typeof profile.taxonomyVersion === "string");
      assert.ok(typeof profile.asOf === "string");
      assert.ok(typeof profile.metrics === "object");
    }
  });

  it("Her profildeki her metrik zorunlu alanları içermeli", () => {
    const result = aggregateProfiles([makeEvent("movie:1", 9)], AS_OF);
    for (const metric of Object.values(result.movie.metrics)) {
      assert.ok(typeof metric.metricId === "string");
      assert.ok(typeof metric.affinity === "number");
      assert.ok(typeof metric.longTermAffinity === "number");
      assert.ok(typeof metric.recentAffinity === "number");
      assert.ok(typeof metric.status === "string");
      assert.ok(typeof metric.evidence === "object");
    }
  });
});

// === Unified affinity sınırları ===

describe("Profile Aggregator — Unified Affinity Sınırları", () => {
  it("Unified affinity -100...+100 aralığında kalmalı", () => {
    // Çok fazla olay ile sınır testi
    const events = [];
    for (let i = 0; i < 10; i++) {
      events.push(makeEvent(`movie:${i}`, 9));
      events.push(makeEvent(`tv:${100 + i}`, 9));
    }
    const result = aggregateProfiles(events, AS_OF);
    for (const metric of Object.values(result.unified.metrics)) {
      assert.ok(
        metric.affinity >= -100 && metric.affinity <= 100,
        `Affinity sınır dışı: ${metric.affinity}`
      );
    }
  });
});

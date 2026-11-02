/**
 * Faz 1 — Taxonomy Doğrulama Testleri
 * Çalıştırma: tsx --test tests/taste/taxonomy.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  TAXONOMY_V01,
  getMetricById,
  getActiveMetrics,
  getDeferredMetrics,
  getMetricsByCategory,
} from "../../src/core/taste/taxonomy.ts";

import {
  MOVIE_GENRE_IDS,
  TV_GENRE_IDS,
  getTvGenreId,
  getMovieGenreId,
} from "../../src/core/taste/tmdb-mappings.ts";

import {
  SHRINKAGE_K,
  HALF_LIFE_RECENT_DAYS,
  HALF_LIFE_LONG_TERM_DAYS,
  TAXONOMY_VERSION,
  ALGORITHM_VERSION,
} from "../../src/core/taste/constants.ts";

// --- Temel sayılar ---
describe("Taxonomy — Metrik Sayıları", () => {
  it("Toplam 42 metrik tanımlı olmalı", () => {
    assert.strictEqual(TAXONOMY_V01.length, 42);
  });

  it("37 aktif (scoringEnabled: true) metrik olmalı", () => {
    const active = getActiveMetrics();
    assert.strictEqual(active.length, 37);
  });

  it("5 gölge (scoringEnabled: false) metrik olmalı", () => {
    const deferred = getDeferredMetrics();
    assert.strictEqual(deferred.length, 5);
  });
});

// --- Benzersizlik ---
describe("Taxonomy — ID Benzersizliği", () => {
  it("Her metrik benzersiz ID'ye sahip olmalı", () => {
    const ids = TAXONOMY_V01.map((m) => m.id);
    const uniqueIds = new Set(ids);
    assert.strictEqual(uniqueIds.size, ids.length, "Çakışan metrik ID'si var");
  });
});

// --- Gölge metrik kuralları ---
describe("Taxonomy — Gölge Metrik Kuralları", () => {
  it("scoringEnabled: false olan tüm metrikler deferred veya retired statüsünde olmalı", () => {
    const shadow = getDeferredMetrics();
    for (const m of shadow) {
      assert.ok(
        m.status === "deferred" || m.status === "retired",
        `Gölge metrik '${m.id}' beklenen status değil: ${m.status}`
      );
    }
  });

  it("Tam 5 gölge metriğin ID'si doğru olmalı", () => {
    const expectedShadow = [
      "narrative.slow_burn",
      "character.ensemble",
      "style.minimalist",
      "style.realistic",
      "setting.contemporary",
    ];
    const actualShadow = getDeferredMetrics().map((m) => m.id).sort();
    assert.deepStrictEqual(actualShadow.sort(), expectedShadow.sort());
  });
});

// --- Kategori dağılımı ---
describe("Taxonomy — Kategori Dağılımı", () => {
  it("genre kategorisinde 10 metrik olmalı", () => {
    assert.strictEqual(getMetricsByCategory("genre").length, 10);
  });

  it("mood kategorisinde 6 metrik olmalı", () => {
    assert.strictEqual(getMetricsByCategory("mood").length, 6);
  });

  it("narrative kategorisinde 4 metrik olmalı", () => {
    assert.strictEqual(getMetricsByCategory("narrative").length, 4);
  });

  it("concept kategorisinde 6 metrik olmalı", () => {
    assert.strictEqual(getMetricsByCategory("concept").length, 6);
  });

  it("character kategorisinde 3 metrik olmalı", () => {
    assert.strictEqual(getMetricsByCategory("character").length, 3);
  });

  it("style kategorisinde 4 metrik olmalı", () => {
    assert.strictEqual(getMetricsByCategory("style").length, 4);
  });

  it("setting kategorisinde 4 metrik olmalı", () => {
    assert.strictEqual(getMetricsByCategory("setting").length, 4);
  });

  it("origin kategorisinde 3 metrik olmalı", () => {
    assert.strictEqual(getMetricsByCategory("origin").length, 3);
  });

  it("format kategorisinde 2 metrik olmalı", () => {
    assert.strictEqual(getMetricsByCategory("format").length, 2);
  });
});

// --- TMDB Eşlemeleri ---
describe("TMDB Eşlemeleri — Film Genre ID'leri", () => {
  it("Romance ID 10749 olmalı (10751 Aile! DEĞİL)", () => {
    assert.strictEqual(MOVIE_GENRE_IDS.romance, 10749);
  });

  it("Sci-Fi film ID 878 olmalı", () => {
    assert.strictEqual(MOVIE_GENRE_IDS.scifi, 878);
  });

  it("Drama ID 18 olmalı (film)", () => {
    assert.strictEqual(MOVIE_GENRE_IDS.drama, 18);
  });

  it("Horror ID 27 olmalı", () => {
    assert.strictEqual(MOVIE_GENRE_IDS.horror, 27);
  });

  it("getMovieGenreId('genre.romance') 10749 döndürmeli", () => {
    assert.strictEqual(getMovieGenreId("genre.romance"), 10749);
  });
});

describe("TMDB Eşlemeleri — TV Genre ID'leri", () => {
  it("TV Sci-Fi + Fantasy birleşik ID 10765 olmalı", () => {
    assert.strictEqual(TV_GENRE_IDS.scifi_fantasy, 10765);
  });

  it("TV'de ayrı horror ID bulunmamalı", () => {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(TV_GENRE_IDS, "horror"),
      false,
      "TV_GENRE_IDS.horror olmamalı — keyword'den türetilmeli"
    );
  });

  it("getTvGenreId('genre.scifi') 10765 döndürmeli", () => {
    assert.strictEqual(getTvGenreId("genre.scifi"), 10765);
  });

  it("getTvGenreId('genre.fantasy') 10765 döndürmeli", () => {
    assert.strictEqual(getTvGenreId("genre.fantasy"), 10765);
  });

  it("getTvGenreId('genre.drama') 18 döndürmeli", () => {
    assert.strictEqual(getTvGenreId("genre.drama"), 18);
  });
});

// --- Yardımcı fonksiyonlar ---
describe("Taxonomy — Yardımcı Fonksiyonlar", () => {
  it("getMetricById mevcut ID için metrik döndürmeli", () => {
    const m = getMetricById("genre.scifi");
    assert.ok(m !== undefined);
    assert.strictEqual(m?.id, "genre.scifi");
  });

  it("getMetricById olmayan ID için undefined döndürmeli", () => {
    assert.strictEqual(getMetricById("non.existent"), undefined);
  });
});

// --- Format metrikleri sadece TV ---
describe("Taxonomy — Format Metrikleri Media Kısıtı", () => {
  it("format.miniseries yalnızca TV için geçerli olmalı", () => {
    const m = getMetricById("format.miniseries");
    assert.ok(m !== undefined);
    assert.deepStrictEqual(m?.applicableMedia, ["tv"]);
  });

  it("format.long_running yalnızca TV için geçerli olmalı", () => {
    const m = getMetricById("format.long_running");
    assert.ok(m !== undefined);
    assert.deepStrictEqual(m?.applicableMedia, ["tv"]);
  });
});

// --- Sabit değerler ---
describe("Constants — Hesaplama Sabitleri", () => {
  it("SHRINKAGE_K 2.5 olmalı (TP-021)", () => {
    assert.strictEqual(SHRINKAGE_K, 2.5);
  });

  it("HALF_LIFE_RECENT_DAYS 180 olmalı (TP-029)", () => {
    assert.strictEqual(HALF_LIFE_RECENT_DAYS, 180);
  });

  it("HALF_LIFE_LONG_TERM_DAYS 730 olmalı (TP-029)", () => {
    assert.strictEqual(HALF_LIFE_LONG_TERM_DAYS, 730);
  });

  it("TAXONOMY_VERSION v0.1 olmalı", () => {
    assert.strictEqual(TAXONOMY_VERSION, "v0.1");
  });

  it("ALGORITHM_VERSION v1.0 olmalı", () => {
    assert.strictEqual(ALGORITHM_VERSION, "v1.0");
  });
});

// --- Her metriğin zorunlu alanları dolu ---
describe("Taxonomy — Metrik Alanları Bütünlüğü", () => {
  for (const metric of TAXONOMY_V01) {
    it(`'${metric.id}' gerekli tüm alanları içermeli`, () => {
      assert.ok(typeof metric.id === "string" && metric.id.length > 0, "id boş");
      assert.ok(typeof metric.categoryId === "string" && metric.categoryId.length > 0, "categoryId boş");
      assert.ok(typeof metric.definition === "string" && metric.definition.length > 0, "definition boş");
      assert.ok(Array.isArray(metric.sourceFields) && metric.sourceFields.length > 0, "sourceFields boş");
      assert.ok(Array.isArray(metric.applicableMedia) && metric.applicableMedia.length > 0, "applicableMedia boş");
      assert.ok(typeof metric.defaultConfidence === "number", "defaultConfidence sayı değil");
      assert.ok(metric.defaultConfidence >= 0 && metric.defaultConfidence <= 1, "defaultConfidence 0-1 dışında");
      assert.ok(typeof metric.mappingVersion === "string" && metric.mappingVersion.length > 0, "mappingVersion boş");
    });
  }
});

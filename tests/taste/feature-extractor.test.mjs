/**
 * Faz 2 — Feature Extractor Testleri
 * Çalıştırma: tsx --test tests/taste/feature-extractor.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractContentTasteItem,
  buildMetadataHash,
  shouldReextract,
} from "../../src/core/taste/feature-extractor.ts";

// === Fixture yardımcıları ===

function makeMovieInput(overrides = {}) {
  return {
    contentId: "movie:550",
    mediaType: "movie",
    tmdbId: 550,
    genreIds: [],
    keywords: [],
    ...overrides,
  };
}

function makeTvInput(overrides = {}) {
  return {
    contentId: "tv:1396",
    mediaType: "tv",
    tmdbId: 1396,
    genreIds: [],
    keywords: [],
    ...overrides,
  };
}

// === Genre ID testleri ===

describe("Feature Extractor — Film Genre ID'leri", () => {
  it("Movie romance ID 10749 ile doğru çıkarılmalı", () => {
    const item = extractContentTasteItem(
      makeMovieInput({ genreIds: [10749] })
    );
    assert.ok(item.features["genre.romance"], "genre.romance feature yok");
    assert.strictEqual(item.features["genre.romance"].state, "present");
  });

  it("10751 (Family) romance olarak çıkarılmamalı", () => {
    const item = extractContentTasteItem(
      makeMovieInput({ genreIds: [10751] })
    );
    assert.ok(
      !item.features["genre.romance"],
      "10751 genre.romance olarak yanlış eşleşti"
    );
  });

  it("Movie sci-fi ID 878 doğru çıkarılmalı", () => {
    const item = extractContentTasteItem(
      makeMovieInput({ genreIds: [878] })
    );
    assert.ok(item.features["genre.scifi"], "genre.scifi feature yok");
    assert.strictEqual(item.features["genre.scifi"].state, "present");
    assert.strictEqual(item.features["genre.scifi"].confidence, 0.95);
  });

  it("Movie drama ID 18 doğru çıkarılmalı", () => {
    const item = extractContentTasteItem(
      makeMovieInput({ genreIds: [18] })
    );
    assert.ok(item.features["genre.drama"]);
    assert.strictEqual(item.features["genre.drama"].state, "present");
  });

  it("Movie horror ID 27 doğru çıkarılmalı", () => {
    const item = extractContentTasteItem(
      makeMovieInput({ genreIds: [27] })
    );
    assert.ok(item.features["genre.horror"]);
  });

  it("Movie thriller ID 53 doğru çıkarılmalı", () => {
    const item = extractContentTasteItem(
      makeMovieInput({ genreIds: [53] })
    );
    assert.ok(item.features["genre.thriller"]);
  });
});

describe("Feature Extractor — TV Genre ID'leri", () => {
  it("TV sci-fi/fantasy 10765 → her iki metriği de tvCombinedScifiFantasy confidence (0.75) ile işaretlemeli", () => {
    const item = extractContentTasteItem(
      makeTvInput({ genreIds: [10765] })
    );
    assert.ok(item.features["genre.scifi"], "genre.scifi yok");
    assert.ok(item.features["genre.fantasy"], "genre.fantasy yok");
    assert.strictEqual(item.features["genre.scifi"].confidence, 0.75);
    assert.strictEqual(item.features["genre.fantasy"].confidence, 0.75);
  });

  it("TV horror/thriller/romance → genre ID yoksa keyword ID olmadan üretilmemeli", () => {
    // TV'de horror, thriller, romance için ayrı genre ID yok → keyword ID olmadan üretilmez
    const item = extractContentTasteItem(
      makeTvInput({ genreIds: [18, 35] }) // drama + comedy
    );
    assert.ok(!item.features["genre.horror"], "TV horror keyword olmadan üretilmemeli");
    assert.ok(!item.features["genre.thriller"], "TV thriller keyword olmadan üretilmemeli");
    assert.ok(!item.features["genre.romance"], "TV romance keyword olmadan üretilmemeli");
  });

  it("TV drama ID 18 doğru çıkarılmalı", () => {
    const item = extractContentTasteItem(
      makeTvInput({ genreIds: [18] })
    );
    assert.ok(item.features["genre.drama"]);
    assert.strictEqual(item.features["genre.drama"].confidence, 0.95);
  });
});

// === Keyword mapping testi ===

describe("Feature Extractor — Keyword Mapping (Faz 6.5)", () => {
  it("Eşleşmeyen sayısal ID'lerde keyword.name metin eşleşmesi yapılmamalı", () => {
    // 99999991 ve 99999992 map'te yok → name "horror" / "melancholy" olsa da feature üretilmez
    const item = extractContentTasteItem(
      makeMovieInput({
        genreIds: [],
        keywords: [
          { id: 99999991, name: "horror" },
          { id: 99999992, name: "melancholy" },
        ],
      })
    );
    assert.ok(!item.features["mood.melancholic"], "Keyword name eşleştirmesi yapılmamalı");
    assert.ok(!item.features["genre.horror"], "Keyword name eşleştirmesi yapılmamalı");
  });

  it("Doğrulanmış sayısal keyword ID'leri mood/concept/narrative/character/style/setting üretmeli", () => {
    const item = extractContentTasteItem(
      makeMovieInput({
        genreIds: [878],
        keywords: [
          { id: 4232, name: "melancholy" },
          { id: 310, name: "artificial intelligence (a.i.)" },
          { id: 4379, name: "time travel" },
          { id: 2095, name: "anti hero" },
          { id: 3307, name: "surreal" },
          { id: 4565, name: "dystopia" },
        ],
      })
    );
    assert.strictEqual(item.features["mood.melancholic"]?.strength, 80);
    assert.strictEqual(item.features["concept.technology"]?.strength, 80);
    assert.strictEqual(item.features["narrative.non_linear"]?.strength, 80);
    assert.strictEqual(item.features["character.antihero"]?.strength, 80);
    assert.strictEqual(item.features["style.surreal"]?.strength, 80);
    assert.strictEqual(item.features["setting.dystopia"]?.strength, 80);
  });

  it("Filmde hem direct genre (27) hem keyword (12339 slasher) varsa direct genre gücü (100 / 0.95) korunmalı", () => {
    const item = extractContentTasteItem(
      makeMovieInput({
        genreIds: [27],
        keywords: [{ id: 12339, name: "slasher" }],
      })
    );
    assert.strictEqual(item.features["genre.horror"]?.strength, 100);
    assert.strictEqual(item.features["genre.horror"]?.confidence, 0.95);
    assert.deepStrictEqual(item.features["genre.horror"]?.evidence, ["27", "12339"]);
  });
});

// === Eksik metadata ===

describe("Feature Extractor — Eksik Metadata = unknown (absent değil)", () => {
  it("genreIds yoksa genre feature üretilmemeli (unknown kalır, absent yazılmaz)", () => {
    const item = extractContentTasteItem(
      makeMovieInput({ genreIds: undefined })
    );
    // Herhangi bir genre feature olmamalı
    for (const key of Object.keys(item.features)) {
      assert.ok(!key.startsWith("genre."), `Beklenmeyen genre feature: ${key}`);
    }
  });

  it("Boş genreIds listesinde genre feature üretilmemeli", () => {
    const item = extractContentTasteItem(makeMovieInput({ genreIds: [] }));
    const genreFeatures = Object.keys(item.features).filter((k) =>
      k.startsWith("genre.")
    );
    assert.strictEqual(genreFeatures.length, 0);
  });

  it("originalLanguage eksikse origin feature üretilmemeli (alan boşsa)", () => {
    const item = extractContentTasteItem(
      makeMovieInput({
        originalLanguage: undefined,
        productionCountries: undefined,
        originCountry: undefined,
      })
    );
    const originFeatures = Object.keys(item.features).filter((k) =>
      k.startsWith("origin.")
    );
    assert.strictEqual(originFeatures.length, 0);
  });
});

// === Origin metrikleri ===

describe("Feature Extractor — Origin Metrikleri", () => {
  it("original_language 'ko' → origin.asian_cinema üretilmeli", () => {
    const item = extractContentTasteItem(
      makeMovieInput({ originalLanguage: "ko" })
    );
    assert.ok(item.features["origin.asian_cinema"]);
    assert.strictEqual(item.features["origin.asian_cinema"].state, "present");
  });

  it("production_countries FR → origin.european üretilmeli", () => {
    const item = extractContentTasteItem(
      makeMovieInput({ productionCountries: ["FR"] })
    );
    assert.ok(item.features["origin.european"]);
  });

  it("original_language 'tr' → origin.turkish üretilmeli", () => {
    const item = extractContentTasteItem(
      makeMovieInput({ originalLanguage: "tr" })
    );
    assert.ok(item.features["origin.turkish"]);
  });

  it("origin_country alanı da dikkate alınmalı", () => {
    const item = extractContentTasteItem(
      makeTvInput({ originCountry: ["KR"] })
    );
    assert.ok(item.features["origin.asian_cinema"]);
  });
});

// === Format metrikleri ===

describe("Feature Extractor — Format Metrikleri (sadece TV)", () => {
  it("Film için format metriği üretilmemeli", () => {
    const item = extractContentTasteItem(
      makeMovieInput({ numberOfSeasons: 1 })
    );
    assert.ok(!item.features["format.miniseries"]);
    assert.ok(!item.features["format.long_running"]);
  });

  it("TV — 1 sezon + episode_run_time > 40 → format.miniseries", () => {
    const item = extractContentTasteItem(
      makeTvInput({ numberOfSeasons: 1, episodeRunTime: [50] })
    );
    assert.ok(item.features["format.miniseries"], "format.miniseries yok");
    assert.strictEqual(item.features["format.miniseries"].state, "present");
  });

  it("TV — 1 sezon + episode_run_time <= 40 → format.miniseries üretilmemeli", () => {
    const item = extractContentTasteItem(
      makeTvInput({ numberOfSeasons: 1, episodeRunTime: [30] })
    );
    assert.ok(!item.features["format.miniseries"]);
  });

  it("TV — 3 sezon → format.long_running", () => {
    const item = extractContentTasteItem(
      makeTvInput({ numberOfSeasons: 3 })
    );
    assert.ok(item.features["format.long_running"]);
  });

  it("TV — 2 sezon → format.long_running üretilmemeli", () => {
    const item = extractContentTasteItem(
      makeTvInput({ numberOfSeasons: 2 })
    );
    assert.ok(!item.features["format.long_running"]);
  });
});

// === Shadow metrikler ===

describe("Feature Extractor — Shadow Metrikler", () => {
  it("Shadow metrikler (scoringEnabled=false) feature map'te bulunmamalı", () => {
    // genre/keyword/origin/format extraction shadow metrik üretemez (heuristic shadow)
    const item = extractContentTasteItem(
      makeMovieInput({ genreIds: [878, 18, 27] })
    );
    // Bilinen shadow metrik ID'leri
    const shadowIds = [
      "narrative.slow_burn",
      "character.ensemble",
      "style.minimalist",
      "style.realistic",
      "setting.contemporary",
    ];
    for (const shadowId of shadowIds) {
      assert.ok(
        !item.features[shadowId],
        `Shadow metrik '${shadowId}' feature map'te bulunmamalı`
      );
    }
  });
});

// === ContentTasteItem yapısı ===

describe("Feature Extractor — ContentTasteItem Yapısı", () => {
  it("contentId, mediaType, extractedAt, metadataHash, completeness alanları bulunmalı", () => {
    const item = extractContentTasteItem(makeMovieInput({ genreIds: [18] }));
    assert.ok(typeof item.contentId === "string");
    assert.ok(typeof item.mediaType === "string");
    assert.ok(typeof item.extractedAt === "string");
    assert.ok(typeof item.metadataHash === "string" && item.metadataHash.length > 0);
    assert.ok(typeof item.completeness === "number");
    assert.ok(item.completeness >= 0 && item.completeness <= 1);
  });

  it("strength 0-100 tamsayı aralığında olmalı", () => {
    const item = extractContentTasteItem(
      makeMovieInput({ genreIds: [878, 18, 27] })
    );
    for (const [, feat] of Object.entries(item.features)) {
      assert.ok(feat.strength >= 0 && feat.strength <= 100, `strength sınır dışı: ${feat.strength}`);
      assert.strictEqual(feat.strength, Math.round(feat.strength), "strength tamsayı değil");
    }
  });

  it("confidence 0-1 aralığında olmalı", () => {
    const item = extractContentTasteItem(
      makeMovieInput({ genreIds: [878, 18] })
    );
    for (const [, feat] of Object.entries(item.features)) {
      assert.ok(
        feat.confidence >= 0 && feat.confidence <= 1,
        `confidence sınır dışı: ${feat.confidence}`
      );
    }
  });
});

// === Hash ve shouldReextract ===

describe("Feature Extractor — buildMetadataHash + shouldReextract", () => {
  it("Aynı input → aynı hash (deterministik)", () => {
    const input = makeMovieInput({ genreIds: [18, 878] });
    const h1 = buildMetadataHash(input);
    const h2 = buildMetadataHash(input);
    assert.strictEqual(h1, h2);
  });

  it("Farklı genreIds → farklı hash", () => {
    const h1 = buildMetadataHash(makeMovieInput({ genreIds: [18] }));
    const h2 = buildMetadataHash(makeMovieInput({ genreIds: [27] }));
    assert.notStrictEqual(h1, h2);
  });

  it("shouldReextract: mevcut yoksa true döner", () => {
    assert.strictEqual(shouldReextract(undefined, "abc"), true);
  });

  it("shouldReextract: hash aynıysa false döner", () => {
    const input = makeMovieInput({ genreIds: [18] });
    const hash = buildMetadataHash(input);
    const item = extractContentTasteItem(input);
    assert.strictEqual(shouldReextract(item, hash), false);
  });

  it("shouldReextract: hash farklıysa true döner", () => {
    const item = extractContentTasteItem(makeMovieInput({ genreIds: [18] }));
    assert.strictEqual(shouldReextract(item, "farkli-hash"), true);
  });
});

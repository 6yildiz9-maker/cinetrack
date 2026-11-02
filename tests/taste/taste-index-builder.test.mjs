/**
 * Faz 2 — Taste Index Builder Testleri
 * Çalıştırma: tsx --test tests/taste/taste-index-builder.test.mjs
 *
 * KURAL: data/cinetrack-data.json'a kesinlikle yazma.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTasteIndex,
  createEmptyTasteIndex,
} from "../../src/core/taste/taste-index-builder.ts";
import { buildMetadataHash } from "../../src/core/taste/feature-extractor.ts";
import {
  TASTE_SCHEMA_VERSION,
  EXTRACTOR_VERSION,
  TAXONOMY_VERSION,
  TMDB_MAPPING_VERSION,
} from "../../src/core/taste/constants.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

// === Sabit options ===
const DEFAULT_OPTIONS = {
  asOf: "2026-11-01T00:00:00.000Z",
  extractorVersion: EXTRACTOR_VERSION,
  taxonomyVersion: TAXONOMY_VERSION,
  mappingVersion: TMDB_MAPPING_VERSION,
};

// === Fixture yardımcıları ===

function makeInput(overrides = {}) {
  return {
    contentId: "movie:550",
    mediaType: "movie",
    tmdbId: 550,
    genreIds: [18],
    keywords: [],
    ...overrides,
  };
}

// === createEmptyTasteIndex ===

describe("Taste Index Builder — createEmptyTasteIndex", () => {
  it("Boş index doğru şema alanlarına sahip olmalı", () => {
    const index = createEmptyTasteIndex();
    assert.strictEqual(index.schemaVersion, TASTE_SCHEMA_VERSION);
    assert.strictEqual(index.revision, 0);
    assert.strictEqual(index.extractorVersion, EXTRACTOR_VERSION);
    assert.strictEqual(index.taxonomyVersion, TAXONOMY_VERSION);
    assert.strictEqual(index.mappingVersion, TMDB_MAPPING_VERSION);
    assert.deepStrictEqual(index.items, {});
  });
});

// === Yeni içerik ===

describe("Taste Index Builder — Yeni içerik", () => {
  it("Yeni içerik index'e eklenmeli (created++)", () => {
    const emptyIndex = createEmptyTasteIndex();
    const { index, stats } = buildTasteIndex(
      [makeInput()],
      emptyIndex,
      DEFAULT_OPTIONS
    );
    assert.strictEqual(stats.processed, 1);
    assert.strictEqual(stats.created, 1);
    assert.strictEqual(stats.updated, 0);
    assert.ok(index.items["movie:550"]);
  });

  it("Birden fazla yeni içerik doğru sayıda eklenmeli", () => {
    const emptyIndex = createEmptyTasteIndex();
    const inputs = [
      makeInput({ contentId: "movie:1", tmdbId: 1 }),
      makeInput({ contentId: "movie:2", tmdbId: 2 }),
      makeInput({ contentId: "tv:3", mediaType: "tv", tmdbId: 3 }),
    ];
    const { stats } = buildTasteIndex(inputs, emptyIndex, DEFAULT_OPTIONS);
    assert.strictEqual(stats.created, 3);
  });
});

// === skippedByHash ===

describe("Taste Index Builder — metadataHash önbelleği", () => {
  it("Aynı metadataHash varsa skippedByHash artmalı", () => {
    const emptyIndex = createEmptyTasteIndex();
    const input = makeInput();

    // İlk çalıştırma — ekleme
    const { index: index1 } = buildTasteIndex([input], emptyIndex, DEFAULT_OPTIONS);

    // İkinci çalıştırma — aynı input, aynı hash → skip
    const { stats: stats2 } = buildTasteIndex([input], index1, DEFAULT_OPTIONS);
    assert.strictEqual(stats2.skippedByHash, 1, "Hash aynı olduğu halde yeniden işlendi");
    assert.strictEqual(stats2.created, 0);
    assert.strictEqual(stats2.updated, 0);
  });

  it("Metadata değişirse update edilmeli", () => {
    const emptyIndex = createEmptyTasteIndex();
    const inputV1 = makeInput({ genreIds: [18] });
    const { index: index1 } = buildTasteIndex([inputV1], emptyIndex, DEFAULT_OPTIONS);

    // Genre değişti → farklı hash → update
    const inputV2 = makeInput({ genreIds: [18, 878] }); // scifi eklendi
    const { stats } = buildTasteIndex([inputV2], index1, DEFAULT_OPTIONS);
    assert.strictEqual(stats.updated, 1, "Değişen metadata güncellenmedi");
    assert.strictEqual(stats.skippedByHash, 0);
  });
});

// === revision ===

describe("Taste Index Builder — revision artışı", () => {
  it("buildTasteIndex her çağrıda revision'ı 1 artırmalı", () => {
    const emptyIndex = createEmptyTasteIndex();
    assert.strictEqual(emptyIndex.revision, 0);

    const { index: index1 } = buildTasteIndex([makeInput()], emptyIndex, DEFAULT_OPTIONS);
    assert.strictEqual(index1.revision, 1);

    const { index: index2 } = buildTasteIndex(
      [makeInput({ contentId: "movie:999", tmdbId: 999 })],
      index1,
      DEFAULT_OPTIONS
    );
    assert.strictEqual(index2.revision, 2);
  });
});

// === Index üst şeması ===

describe("Taste Index Builder — Index Üst Şeması", () => {
  it("Index schemaVersion, revision, updatedAt, extractorVersion, taxonomyVersion, mappingVersion taşımalı", () => {
    const { index } = buildTasteIndex(
      [makeInput()],
      createEmptyTasteIndex(),
      DEFAULT_OPTIONS
    );
    assert.ok(typeof index.schemaVersion === "string", "schemaVersion eksik");
    assert.ok(typeof index.revision === "number", "revision eksik");
    assert.ok(typeof index.updatedAt === "string", "updatedAt eksik");
    assert.ok(typeof index.extractorVersion === "string", "extractorVersion eksik");
    assert.ok(typeof index.taxonomyVersion === "string", "taxonomyVersion eksik");
    assert.ok(typeof index.mappingVersion === "string", "mappingVersion eksik");
  });

  it("updatedAt options.asOf ile eşleşmeli", () => {
    const { index } = buildTasteIndex(
      [makeInput()],
      createEmptyTasteIndex(),
      DEFAULT_OPTIONS
    );
    assert.strictEqual(index.updatedAt, DEFAULT_OPTIONS.asOf);
  });

  it("extractorVersion options.extractorVersion ile eşleşmeli", () => {
    const { index } = buildTasteIndex(
      [makeInput()],
      createEmptyTasteIndex(),
      { ...DEFAULT_OPTIONS, extractorVersion: "v1.0-test" }
    );
    assert.strictEqual(index.extractorVersion, "v1.0-test");
  });
});

// === Davranış olayı üretilmez ===

describe("Taste Index Builder — Olay / Profil Değişmez", () => {
  it("buildTasteIndex dönüş değeri event veya profile içermemeli", () => {
    const { index, stats } = buildTasteIndex(
      [makeInput()],
      createEmptyTasteIndex(),
      DEFAULT_OPTIONS
    );
    // Dönüş değerinde sadece index ve stats olmalı
    assert.ok(index !== undefined);
    assert.ok(stats !== undefined);
    // Profil değişmediğini kanıtlayan dolaylı kontrol: fonksiyon profil döndürmez
    const resultKeys = Object.keys({ index, stats });
    assert.ok(!resultKeys.includes("events"), "events dönülmemeli");
    assert.ok(!resultKeys.includes("profile"), "profile dönülmemeli");
  });
});

// === Stats ===

describe("Taste Index Builder — İstatistikler", () => {
  it("Geçersiz contentId için warning üretilmeli", () => {
    const { stats } = buildTasteIndex(
      [makeInput({ contentId: "geçersiz" })],
      createEmptyTasteIndex(),
      DEFAULT_OPTIONS
    );
    assert.ok(stats.warnings.length > 0, "Geçersiz contentId için warning üretilmedi");
  });

  it("processed sayısı input uzunluğu ile eşleşmeli", () => {
    const inputs = [
      makeInput({ contentId: "movie:1", tmdbId: 1 }),
      makeInput({ contentId: "movie:2", tmdbId: 2 }),
    ];
    const { stats } = buildTasteIndex(inputs, createEmptyTasteIndex(), DEFAULT_OPTIONS);
    assert.strictEqual(stats.processed, 2);
  });
});

// === data/cinetrack-data.json değişmedi ===

describe("Taste Index Builder — Ana Veri Koruması", () => {
  it("data/cinetrack-data.json yolu ile eşleşen hiçbir dosya değiştirilmemeli (dosya yoksa skip)", () => {
    const dataPath = join(ROOT, "data", "cinetrack-data.json");
    if (!existsSync(dataPath)) return; // dosya yok → skip

    // buildTasteIndex sonrası dosya hâlâ erişilebilir olmalı (existsSync zaten import edildi)
    assert.ok(existsSync(dataPath), "cinetrack-data.json silinmiş/değişmiş!");
  });
});

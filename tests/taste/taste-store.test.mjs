/**
 * Faz 5 — Taste Store Testleri
 * Atomik yazım, manifest, idempotency, bozuk dosya
 * Not: Bu testler gerçek disk yazımı yapar → geçici dizin kullanılır
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import {
  TASTE_PATHS,
  appendTasteEvent,
  readTasteEvents,
  writeTasteProfile,
  readTasteProfile,
  writeTasteIndex,
  readTasteIndex,
  readTasteManifest,
  writeTasteEvents,
} from "../../src/server/taste-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(tmpdir(), `ct-taste-store-test-${Date.now()}`);

// taste-store'u test diziniyle yeniden bağlamak için modül-level patch
// (TASTE_PATHS constants'ı değiştirip store fonksiyonlarını test ediyoruz)
// NOT: Doğrudan fonksiyon çağrıları TASTE_PATHS'i kullandığından,
// entegrasyon testi için gerçek data/taste/ dizini kullanılır ama sonra temizlenir.

const AS_OF = "2026-11-02T00:00:00.000Z";

// === Fixture ===
let _cnt = 0;
function makeEvent(overrides = {}) {
  _cnt++;
  return {
    eventId: `store-test-${_cnt}`,
    contentId: "movie:550",
    eventType: "rating_changed",
    payload: { previousValue: null, newValue: 8 },
    recordedAt: AS_OF,
    timeSource: "actual",
    timePrecision: "exact",
    ...overrides,
  };
}

function makeProfile() {
  return {
    mediaType: "movie",
    algorithmVersion: "v1.0",
    taxonomyVersion: "v0.1",
    asOf: AS_OF,
    metrics: {
      "genre.drama": {
        metricId: "genre.drama",
        affinity: 30,
        longTermAffinity: 30,
        recentAffinity: 30,
        status: "directional",
        evidence: {
          posMass: 2.0,
          negMass: 0,
          uncertainMass: 0,
          topPositiveContentIds: ["movie:1"],
          topNegativeContentIds: [],
        },
      },
    },
  };
}

function makeIndex() {
  return {
    schemaVersion: "1.0.0",
    revision: 1,
    updatedAt: AS_OF,
    extractorVersion: "v1.0",
    taxonomyVersion: "v0.1",
    mappingVersion: "tmdb-2026-11",
    items: {},
  };
}

// === Event Store ===

describe("Taste Store — appendTasteEvent", () => {
  it("Olay eklenmeli ve okunabilmeli", async () => {
    // data/taste/cinetrack-taste-events.json üzerinde çalışır
    // İlk önce boş başlat
    await writeTasteEvents([]);

    const event = makeEvent({ eventId: "unique-append-1" });
    await appendTasteEvent(event);

    const events = await readTasteEvents();
    const found = events.find((e) => e.eventId === "unique-append-1");
    assert.ok(found, "Olay bulunamadı");
    assert.strictEqual(found.contentId, "movie:550");
  });

  it("Idempotency: aynı eventId iki kez eklenmez", async () => {
    await writeTasteEvents([]);

    const event = makeEvent({ eventId: "idempotent-test-1" });
    await appendTasteEvent(event);
    await appendTasteEvent(event); // tekrar

    const events = await readTasteEvents();
    const found = events.filter((e) => e.eventId === "idempotent-test-1");
    assert.strictEqual(found.length, 1, "Aynı eventId iki kez eklendi!");
  });
});

// === Profile Store ===

describe("Taste Store — writeTasteProfile / readTasteProfile", () => {
  it("Profil yazılıp okunabilmeli", async () => {
    const profile = makeProfile();
    await writeTasteProfile(profile);

    const read = await readTasteProfile();
    assert.ok(read !== null, "Profil okunamadı");
    assert.strictEqual(read.mediaType, "movie");
    assert.strictEqual(read.metrics["genre.drama"]?.affinity, 30);
  });

  it("Profil dosyası atomik yazıldıktan sonra .tmp kalmamalı", async () => {
    await writeTasteProfile(makeProfile());
    const tmpExists = existsSync(`${TASTE_PATHS.profile}.tmp`);
    assert.strictEqual(tmpExists, false, ".tmp dosyası kaldı!");
  });
});

// === Index Store ===

describe("Taste Store — writeTasteIndex / readTasteIndex", () => {
  it("İndeks yazılıp okunabilmeli", async () => {
    const index = makeIndex();
    await writeTasteIndex(index);

    const read = await readTasteIndex();
    assert.ok(read !== null);
    assert.strictEqual(read.revision, 1);
    assert.strictEqual(read.extractorVersion, "v1.0");
  });
});

// === Manifest ===

describe("Taste Store — Manifest güncelleme (TP-027)", () => {
  it("Profil yazıldığında manifest otomatik güncellenmeli", async () => {
    await writeTasteProfile(makeProfile());

    const manifest = await readTasteManifest();
    assert.ok(manifest !== null, "Manifest null");
    assert.ok(typeof manifest.generationId === "string");
    assert.ok(typeof manifest.asOf === "string");
    assert.ok(typeof manifest.taxonomyVersion === "string");
    assert.ok(typeof manifest.algorithmVersion === "string");
    assert.ok(typeof manifest.files === "object");
    assert.ok(typeof manifest.files.profile === "string");
  });

  it("İndeks yazıldığında manifest otomatik güncellenmeli", async () => {
    const before = await readTasteManifest();
    await writeTasteIndex(makeIndex());
    const after = await readTasteManifest();

    assert.ok(after !== null);
    // generationId her çağrıda yeni UUID → farklı olmalı
    if (before) {
      assert.notStrictEqual(before.generationId, after.generationId);
    }
  });
});

// === Atomik yazım ===

describe("Taste Store — Atomik yazım", () => {
  it("Profil yazıldıktan sonra dosya okunabilir JSON içermeli", async () => {
    await writeTasteProfile(makeProfile());

    // Dosya var mı?
    assert.ok(existsSync(TASTE_PATHS.profile), "Profil dosyası yok");

    // Okunabilir mi?
    const read = await readTasteProfile();
    assert.ok(read !== null, "Profil okunamadı");
  });

  it("Bozuk events dosyasında readTasteEvents boş dizi döndürmeli", async () => {
    // Bilerek bozuk içerik yaz (doğrudan, atomik olmadan)
    writeFileSync(TASTE_PATHS.events, "{ bozuk json }", "utf8");

    const events = await readTasteEvents();
    assert.ok(Array.isArray(events), "Dizi dönmeli");
    // Bozuk dosya → boş dizi
    assert.strictEqual(events.length, 0);

    // Temizle
    await writeTasteEvents([]);
  });
});

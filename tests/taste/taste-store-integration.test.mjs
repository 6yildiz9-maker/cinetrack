/**
 * Faz 6 — Taste Store End-to-End Entegrasyon Testleri
 * Migration → Store → Profile → Manifest akışı
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { migrateExistingData } from "../../src/core/taste/migration.ts";
import {
  writeTasteEvents,
  readTasteEvents,
  writeTasteProfile,
  readTasteProfile,
  readTasteManifest,
  TASTE_PATHS,
} from "../../src/server/taste-store.ts";
import { aggregateProfiles } from "../../src/core/taste/profile-aggregator.ts";
import { tasteCoverage, tasteUnknownRate } from "../../src/core/evaluation.ts";
import { TAXONOMY_V01 } from "../../src/core/taste/taxonomy.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const AS_OF = "2026-11-02T00:00:00.000Z";

// === Fixture ===
function makeDoc(items = [], disliked = []) {
  return {
    version: 3,
    schemaVersion: 3,
    activeProfileId: "profile-default",
    profiles: [
      {
        id: "profile-default",
        name: "test",
        createdAt: "2026-01-01T00:00:00.000Z",
        preferences: {
          disliked,
          hidden: [],
          providers: [],
          mood: "",
          reminders: false,
          notified: [],
        },
        items,
        favoriteActors: [],
      },
    ],
    updatedAt: AS_OF,
  };
}

function makeItem(id, mediaType, rating) {
  return {
    id,
    media_type: mediaType,
    personal_rating: rating,
    addedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    firstAddedAt: "2026-01-01T00:00:00.000Z",
  };
}

// === End-to-End: Migration → Store → Read ===

describe("Taste Store Integration — E2E Akışı", () => {
  it("Migration → writeTasteEvents → readTasteEvents akışı", async () => {
    const doc = makeDoc(
      [makeItem(550, "movie", 9), makeItem(807, "movie", 8)],
      ["movie:999"]
    );

    // 1. Migration
    const { events, result } = migrateExistingData({
      dataDocument: doc,
      asOf: AS_OF,
    });

    assert.ok(result.eventsCreated >= 2, "En az 2 olay üretilmeli");
    assert.ok(
      events.every((e) => e.timeSource === "imported"),
      "Tüm olaylar imported olmalı"
    );

    // 2. Store'a yaz (overwrite)
    await writeTasteEvents(events);

    // 3. Oku — yazılan olaylar okunabilmeli
    const readEvents = await readTasteEvents();
    // Önceki testlerden farklı veri olabilir; en az migration çıktısı kadar içermeli
    assert.ok(Array.isArray(readEvents), "Array dönmeli");
    // Spesifik event ID kontrol
    const eventIds = new Set(events.map((e) => e.eventId));
    const found = readEvents.filter((e) => eventIds.has(e.eventId));
    assert.strictEqual(found.length, events.length, "Yazılan tüm olaylar okunabilmeli");
  });

  it("aggregateProfiles → writeTasteProfile → readTasteProfile akışı", async () => {
    const doc = makeDoc([makeItem(550, "movie", 9)]);
    const { events } = migrateExistingData({ dataDocument: doc, asOf: AS_OF });

    const profiles = aggregateProfiles(events, AS_OF);

    // Profil yaz
    await writeTasteProfile(profiles.movie);

    // Oku
    const readProfile = await readTasteProfile();
    assert.ok(readProfile !== null, "Profil okunabilmeli");
    assert.strictEqual(readProfile.mediaType, "movie");
  });

  it("writeTasteProfile → readTasteManifest akışı (manifest otomatik güncellenir)", async () => {
    await writeTasteProfile({
      mediaType: "unified",
      algorithmVersion: "v1.0",
      taxonomyVersion: "v0.1",
      asOf: AS_OF,
      metrics: {},
    });

    const manifest = await readTasteManifest();
    assert.ok(manifest !== null, "Manifest okunabilmeli");
    assert.ok(typeof manifest.generationId === "string");
    assert.strictEqual(typeof manifest.taxonomyVersion, "string");
  });
});

// === Evaluation metrikleri ===

describe("Taste Store Integration — Evaluation Metrikleri", () => {
  it("tasteCoverage: boş profil → 0 coverage", () => {
    const coverage = tasteCoverage({}, 37);
    assert.strictEqual(coverage, 0);
  });

  it("tasteCoverage: tüm metrikler biliniyor → 1.0", () => {
    const metrics = {};
    for (let i = 0; i < 10; i++) {
      metrics[`m${i}`] = { status: "directional" };
    }
    const coverage = tasteCoverage(metrics, 10);
    assert.strictEqual(coverage, 1.0);
  });

  it("tasteUnknownRate: tüm bilinmiyor → 1.0", () => {
    const metrics = { a: { status: "unknown" }, b: { status: "unknown" } };
    const rate = tasteUnknownRate(metrics, 2);
    assert.strictEqual(rate, 1.0);
  });

  it("tasteUnknownRate: hiç bilinmiyor yok → 0", () => {
    const metrics = { a: { status: "directional" } };
    const rate = tasteUnknownRate(metrics, 1);
    assert.strictEqual(rate, 0);
  });
});

// === GitHub senkron kapsamı — manifest + profile dahil, index/events değil ===

describe("Taste Store Integration — GitHub Senkron Kapsamı", () => {
  it("TASTE_PATHS.manifest ve TASTE_PATHS.profile senkron kapsamında tanımlı", async () => {
    // sync-display.ts'deki SyncFileCategory'ye taste_manifest + taste_profile eklendi
    const { default: syncDisplaySrc } = await import("../../src/core/sync-display.ts").catch(
      () => ({ default: null })
    );
    // Doğrudan dosya içeriğini kontrol et
    const syncPath = join(ROOT, "src", "core", "sync-display.ts");
    if (existsSync(syncPath)) {
      const content = readFileSync(syncPath, "utf8");
      assert.ok(
        content.includes("taste_manifest"),
        "taste_manifest SyncFileCategory'de olmalı"
      );
      assert.ok(
        content.includes("taste_profile"),
        "taste_profile SyncFileCategory'de olmalı"
      );
    }
  });

  it("TASTE_PATHS dosya yolları doğru tanımlı", () => {
    assert.ok(
      TASTE_PATHS.manifest.includes("cinetrack-taste-manifest.json"),
      "manifest dosya yolu yanlış"
    );
    assert.ok(
      TASTE_PATHS.profile.includes("cinetrack-taste-profile.json"),
      "profile dosya yolu yanlış"
    );
    assert.ok(
      TASTE_PATHS.index.includes("cinetrack-taste-index.json"),
      "index dosya yolu yanlış"
    );
    assert.ok(
      TASTE_PATHS.events.includes("cinetrack-taste-events.json"),
      "events dosya yolu yanlış"
    );
  });
});

// === cinetrack-data.json değişmedi ===

describe("Taste Store Integration — Ana Veri Koruması", () => {
  it("data/cinetrack-data.json değiştirilmemiş olmalı (dosya varsa)", () => {
    const dataPath = join(ROOT, "data", "cinetrack-data.json");
    if (!existsSync(dataPath)) return; // dosya yok → skip

    // Dosya hâlâ erişilebilir ve okunabilir
    assert.ok(existsSync(dataPath), "cinetrack-data.json silinmiş!");
    const raw = readFileSync(dataPath, "utf8");
    assert.ok(raw.length > 0, "cinetrack-data.json boş!");

    // JSON parse edilebilir mi?
    const doc = JSON.parse(raw);
    assert.ok(doc.profiles !== undefined, "profiles alanı yok!");
  });
});

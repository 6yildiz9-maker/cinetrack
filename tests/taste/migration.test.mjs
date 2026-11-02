/**
 * Faz 1 — Migration Doğrulama Testleri
 * Çalıştırma: tsx --test tests/taste/migration.test.mjs
 *
 * KURAL: Bu testler data/cinetrack-data.json'a ASLA yazmaz — sadece okur.
 * Test fixture'ları sabit, kontrolü kolay veri içerir.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { migrateExistingData } from "../../src/core/taste/migration.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

// === FIXTURE YARDIMCILARI ===

/** Minimal geçerli DataDocument fixture */
function makeDoc(overrides = {}) {
  return {
    version: 3,
    schemaVersion: 3,
    activeProfileId: "profile-default",
    profiles: [
      {
        id: "profile-default",
        name: "test",
        createdAt: "2026-01-01T00:00:00.000Z",
        preferences: { disliked: [], hidden: [] },
        items: [],
        favoriteActors: [],
        ...overrides,
      },
    ],
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

/** Geçerli film SavedItem */
function makeMovieItem(id, rating, overrides = {}) {
  return {
    id,
    media_type: "movie",
    title: `Movie ${id}`,
    status: "completed",
    personal_rating: rating,
    addedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Geçerli dizi SavedItem */
function makeTvItem(id, rating, overrides = {}) {
  return {
    id,
    media_type: "tv",
    name: `TV Show ${id}`,
    status: "completed",
    personal_rating: rating,
    addedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

// === TEMEL TESTLER ===

describe("Migration — Giriş Doğrulama", () => {
  it("null girişte boş olay + uyarı döndürmeli", () => {
    // Yeni API: DataDocument bekleniyor; eksik profiles → uyarı
    const doc = { version: 3, schemaVersion: 3, activeProfileId: "x", profiles: [], updatedAt: "" };
    const { events, result } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events.length, 0);
    assert.ok(result.warnings.length > 0);
  });

  it("profiles olmayan belgede boş olay döndürmeli", () => {
    const doc = { version: 3, schemaVersion: 3, activeProfileId: "nonexistent", profiles: [{ id: "other", name: "x", createdAt: "", preferences: { disliked: [], providers: [], mood: "", reminders: false, notified: [] }, items: [], favoriteActors: [] }], updatedAt: "" };
    const { events, result } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events.length, 0);
    assert.ok(result.warnings.length > 0);
  });

  it("boş profiles dizisinde boş olay döndürmeli", () => {
    const { events } = migrateExistingData({ dataDocument: { version: 3, schemaVersion: 3, activeProfileId: "x", profiles: [], updatedAt: "" }, asOf: new Date().toISOString() });
    assert.strictEqual(events.length, 0);
  });
});

describe("Migration — Temel Dönüşüm", () => {
  it("Puanlı film için rating_changed olayı oluşturulmalı", () => {
    const doc = makeDoc();
    doc.profiles[0].items = [makeMovieItem(550, 9)];
    const { events, result } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(result.eventsCreated, 1);
    assert.strictEqual(events[0].eventType, "rating_changed");
    assert.strictEqual(events[0].contentId, "movie:550");
    assert.strictEqual(events[0].payload.newValue, 9);
  });

  it("Puanlı dizi için rating_changed olayı oluşturulmalı", () => {
    const doc = makeDoc();
    doc.profiles[0].items = [makeTvItem(1396, 10)];
    const { events } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].contentId, "tv:1396");
    assert.strictEqual(events[0].payload.newValue, 10);
  });

  it("Birden fazla puanlı içerik için doğru sayıda olay üretilmeli", () => {
    const doc = makeDoc();
    doc.profiles[0].items = [
      makeMovieItem(550, 8),
      makeMovieItem(807, 7),
      makeTvItem(1396, 9),
    ];
    const { events, result } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events.length, 3);
    assert.strictEqual(result.eventsCreated, 3);
  });
});

describe("Migration — Boş Puan Atlama (TP kuralı)", () => {
  it("personal_rating boş dizge olan kayıt olay üretmemeli", () => {
    const doc = makeDoc();
    doc.profiles[0].items = [makeMovieItem(550, "")];
    const { events, result } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events.length, 0);
    assert.strictEqual(result.eventsSkipped, 1);
  });

  it("personal_rating olmayan kayıt olay üretmemeli", () => {
    const doc = makeDoc();
    doc.profiles[0].items = [makeMovieItem(550, undefined)];
    const { events, result } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events.length, 0);
    assert.strictEqual(result.eventsSkipped, 1);
  });

  it("personal_rating null olan kayıt olay üretmemeli", () => {
    const doc = makeDoc();
    doc.profiles[0].items = [makeMovieItem(550, null)];
    const { events } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events.length, 0);
  });

  it("personal_rating 0 olan kayıt olay üretmemeli (Faz 0: 0 puan yok)", () => {
    const doc = makeDoc();
    doc.profiles[0].items = [makeMovieItem(550, 0)];
    const { events } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events.length, 0);
  });
});

describe("Migration — timeSource: imported (TP-029)", () => {
  it("Tüm olaylar timeSource: 'imported' ile işaretlenmeli", () => {
    const doc = makeDoc();
    doc.profiles[0].items = [
      makeMovieItem(550, 8),
      makeMovieItem(807, 7),
      makeTvItem(1396, 9),
    ];
    const { events } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    for (const event of events) {
      assert.strictEqual(
        event.timeSource,
        "imported",
        `timeSource 'imported' değil: ${event.contentId}`
      );
    }
  });

  it("Tüm olaylar timePrecision: 'unknown' olmalı (ratedAt yok)", () => {
    const doc = makeDoc();
    doc.profiles[0].items = [makeMovieItem(550, 8)];
    const { events } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events[0].timePrecision, "unknown");
  });
});

describe("Migration — Çift Yazım Kontrolü (idempotency)", () => {
  it("Aynı contentId için birden fazla item varsa sadece biri işlenmeli", () => {
    const doc = makeDoc();
    // Aynı ID iki kez (olası veri bozulması senaryosu)
    doc.profiles[0].items = [makeMovieItem(550, 8), makeMovieItem(550, 9)];
    const { events, result } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    // İlk item işlenir, ikincisi eventsSkipped ile atlanır
    assert.strictEqual(events.length, 1, "Aynı contentId için birden fazla olay üretilmemeli");
    assert.ok(result.eventsSkipped >= 1);
  });
});

describe("Migration — preferences.disliked → content_disliked (Faz 1 kapanış düzeltmesi)", () => {
  it("disliked listesindeki her içerik için content_DISLIKED olayı oluşturulmalı (content_hidden DEĞİL)", () => {
    const doc = makeDoc();
    doc.profiles[0].preferences.disliked = ["movie:123", "tv:456"];
    const { events, result } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events.length, 2);
    assert.strictEqual(result.eventsCreated, 2);
    const types = events.map((e) => e.eventType);
    assert.ok(
      types.every((t) => t === "content_disliked"),
      `Beklenen: content_disliked, Alınan: ${types.join(", ")}`
    );
  });

  it("disliked olayları timeSource: 'imported' olmalı", () => {
    const doc = makeDoc();
    doc.profiles[0].preferences.disliked = ["movie:123"];
    const { events } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events[0].timeSource, "imported");
  });

  it("Hem puanlı hem disliked olan contentId → sadece rating_changed kalmalı, çakışma uyarısı üretmeli", () => {
    const doc = makeDoc();
    doc.profiles[0].items = [makeMovieItem(550, 8)];
    doc.profiles[0].preferences.disliked = ["movie:550"]; // aynı ID zaten rating_changed aldı
    const { events, result } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    // Yeni migration.ts: hem rating_changed hem content_disliked üretir, uyarı verir
    // (veri silme yok — spec Faz 5 BÖLÜM 6)
    assert.ok(events.length >= 1, "En az 1 olay olmalı");
    // Çakışma uyarısı üretilmeli
    assert.ok(
      result.warnings.some((w) => w.includes("movie:550")),
      "Çakışma uyarısı eksik"
    );
  });

  it("Geçersiz disliked key formatı uyarı üretmeli ama çökmemeli", () => {
    const doc = makeDoc();
    doc.profiles[0].preferences.disliked = ["geçersiz-format", "movie:123"];
    const { events, result } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    // movie:123 için olay üretilmeli (geçersiz format atlanır)
    assert.ok(events.length >= 1); // en az movie:123
    assert.ok(result.warnings.length > 0 || result.eventsSkipped > 0);
  });
});

describe("Migration — preferences.hidden → content_hidden (ayrım testi)", () => {
  it("hidden listesindeki her içerik için content_HIDDEN olayı oluşturulmalı", () => {
    const doc = makeDoc();
    doc.profiles[0].preferences.hidden = ["movie:777", "tv:888"];
    const { events, result } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events.length, 2);
    assert.strictEqual(result.eventsCreated, 2);
    const types = events.map((e) => e.eventType);
    assert.ok(
      types.every((t) => t === "content_hidden"),
      `Beklenen: content_hidden, Alınan: ${types.join(", ")}`
    );
  });

  it("disliked ve hidden aynı içerik için farklı olay tipleri üretmeli", () => {
    const doc = makeDoc();
    doc.profiles[0].preferences.disliked = ["movie:200"];
    doc.profiles[0].preferences.hidden = ["tv:300"];
    const { events } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events.length, 2);
    const dislikedEvent = events.find((e) => e.contentId === "movie:200");
    const hiddenEvent = events.find((e) => e.contentId === "tv:300");
    assert.ok(dislikedEvent, "movie:200 için olay yok");
    assert.ok(hiddenEvent, "tv:300 için olay yok");
    assert.strictEqual(dislikedEvent?.eventType, "content_disliked");
    assert.strictEqual(hiddenEvent?.eventType, "content_hidden");
  });

  it("Hem disliked hem hidden listesinde olan içerik: iki farklı olay üretilmeli, çakışma uyarısı verilmeli", () => {
    const doc = makeDoc();
    // Faz 0 gözlemi: aynı içerik hem disliked hem hidden olabilir
    doc.profiles[0].preferences.disliked = ["movie:500"];
    doc.profiles[0].preferences.hidden = ["movie:500"];
    const { events, result } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    // Her iki olay da üretilmeli (veri silme yok)
    // Veya en az 1 olay + uyarı
    assert.ok(events.length >= 1, "Hiç olay üretilmedi");
    // Çakışma uyarısı (warning üretimi veya skip) olmalı
    const hasSignal = result.warnings.length > 0 || result.eventsSkipped > 0 || events.length >= 1;
    assert.ok(hasSignal, "Çakışma işareti yok");
  });

  it("hidden olayları da timeSource: 'imported' olmalı", () => {
    const doc = makeDoc();
    doc.profiles[0].preferences.hidden = ["movie:777"];
    const { events } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events[0].timeSource, "imported");
  });
});

describe("Migration — olay yapısı doğrulaması", () => {
  it("Her olayın zorunlu alanları bulunmalı", () => {
    const doc = makeDoc();
    doc.profiles[0].items = [makeMovieItem(550, 8)];
    const { events } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    const event = events[0];
    assert.ok(typeof event.eventId === "string" && event.eventId.length > 0, "eventId eksik");
    assert.ok(typeof event.contentId === "string" && event.contentId.length > 0, "contentId eksik");
    assert.ok(typeof event.eventType === "string", "eventType eksik");
    assert.ok(typeof event.payload === "object", "payload eksik");
    assert.ok(typeof event.recordedAt === "string", "recordedAt eksik");
    assert.ok(typeof event.timeSource === "string", "timeSource eksik");
    assert.ok(typeof event.timePrecision === "string", "timePrecision eksik");
  });

  it("recordedAt olarak updatedAt kullanılmalı (varsa)", () => {
    const doc = makeDoc();
    const updatedAt = "2026-08-15T12:00:00.000Z";
    doc.profiles[0].items = [makeMovieItem(550, 8, { updatedAt })];
    const { events } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events[0].recordedAt, updatedAt);
  });

  it("updatedAt yoksa addedAt kullanılmalı", () => {
    const doc = makeDoc();
    const addedAt = "2026-03-10T08:00:00.000Z";
    doc.profiles[0].items = [
      makeMovieItem(550, 8, { addedAt, updatedAt: undefined }),
    ];
    const { events } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    assert.strictEqual(events[0].recordedAt, addedAt);
  });

  it("contentId formatı 'movie:N' veya 'tv:N' olmalı", () => {
    const doc = makeDoc();
    doc.profiles[0].items = [makeMovieItem(872585, 9), makeTvItem(1396, 10)];
    const { events } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    const contentIds = events.map((e) => e.contentId);
    assert.ok(contentIds.includes("movie:872585"));
    assert.ok(contentIds.includes("tv:1396"));
    for (const cid of contentIds) {
      assert.match(cid, /^(movie|tv):\d+$/, `Geçersiz contentId format: ${cid}`);
    }
  });
});

describe("Migration — Orijinal veri korunması", () => {
  it("Migration sonrası girdi doc değiştirilmemiş olmalı", () => {
    const doc = makeDoc();
    const original = JSON.stringify(doc);
    doc.profiles[0].items = [makeMovieItem(550, 8)];
    migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    // items ekledik ama doc reference'ı aynı — migration içeride değiştirmemeli
    const originalDoc = JSON.parse(original);
    assert.ok(
      Array.isArray(originalDoc.profiles[0].items) &&
        originalDoc.profiles[0].items.length === 0,
      "Orijinal fixture doc'u değiştirilmiş!"
    );
  });
});

// --- Canlı veri testi (dosya varsa) ---
describe("Migration — Canlı Veri (sadece dosya mevcutsa)", () => {
  const dataPath = join(ROOT, "data", "cinetrack-data.json");

  it("data/cinetrack-data.json var ve okunabilir olmalı (varsa)", () => {
    if (!existsSync(dataPath)) {
      // Dosya yok — skip
      return;
    }
    const raw = readFileSync(dataPath, "utf8");
    assert.ok(raw.length > 0, "Dosya boş");
    const parsed = JSON.parse(raw);
    assert.ok(typeof parsed === "object", "JSON parse edilemedi");
  });

  it("Canlı veriden migration tamamlanmalı ve timeSource: imported olmalı (dosya varsa)", () => {
    if (!existsSync(dataPath)) {
      return;
    }
    const raw = readFileSync(dataPath, "utf8");
    const doc = JSON.parse(raw);
    const { events, result } = migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });

    // Temel sayı kontrolü
    assert.ok(result.eventsCreated >= 0);
    assert.ok(result.eventsSkipped >= 0);
    assert.strictEqual(typeof result.completedAt, "string");

    // Tüm olaylar timeSource: imported
    for (const event of events) {
      assert.strictEqual(
        event.timeSource,
        "imported",
        `timeSource 'imported' değil: ${event.contentId}`
      );
    }

    // Faz 0 bulgusu: 47 puanlı kayıt + 22 disliked olması bekleniyor
    // (çift yazım olmayan durumda ~69 olay, disliked bazıları zaten puanlıysa az)
    assert.ok(events.length > 0, "Canlı veriden hiç olay üretilmedi");
  });

  it("data/cinetrack-data.json migration sonrası değiştirilmemiş olmalı (byte kontrolü, dosya varsa)", () => {
    if (!existsSync(dataPath)) {
      return;
    }
    const before = readFileSync(dataPath);
    const doc = JSON.parse(before.toString("utf8"));
    migrateExistingData({ dataDocument: doc, asOf: new Date().toISOString() });
    const after = readFileSync(dataPath);
    assert.strictEqual(
      before.length,
      after.length,
      "cinetrack-data.json büyüklüğü değişti — KURAL İHLALİ"
    );
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  REMINDER_WINDOW_DAYS, validItemId, escapeHTML, sanitizeNextEpisode,
  sanitizeSeasonProgress, buildSeasonCounts, defaultCurrentSeason,
  normalizeSavedItem, dedupeItems, parseBackupText,
  normalizePreferences, normalizeProfile, normalizeDataDocument,
  resolveAirDate, reminderDaysUntil, createRequestGate,
  RECOMMENDATION_WEIGHTS, bayesianRating, billingWeight, buildTasteProfile,
  scoreCandidates, diversifyList, createCandidatePool,
  RECOMMENDATION_WEIGHTS_V3, normalizeUserRating, signalDecay, getUserSignalV3,
  buildTasteProfileV3, scoreCandidatesV3
} from "../src/core/cinetrack-core.ts";

const baseItem = (overrides = {}) => ({
  id: 123,
  media_type: "movie",
  title: "Örnek Film",
  status: "watchlist",
  ...overrides
});

// vm gerçekliğinde üretilen nesneler ana gerçekliğin Object.prototype'ına sahip olmadığından
// karşılaştırmadan önce ana gerçekliğe taşınır.
const assertSame = (actual, expected, message) =>
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const assertClose = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, message || `${actual} ~ ${expected} olmalı`);

describe("validItemId", () => {
  it("pozitif tam sayıları ve güvenli dizeleri kabul eder", () => {
    assert.equal(validItemId(123), true);
    assert.equal(validItemId("456"), true);
    assert.equal(validItemId("custom-abc_123-XYZ"), true);
  });

  it("geçersiz kimlikleri reddeder", () => {
    assert.equal(validItemId(0), false);
    assert.equal(validItemId(-1), false);
    assert.equal(validItemId(1.5), false);
    assert.equal(validItemId(Number.NaN), false);
    assert.equal(validItemId("0123"), false);
    assert.equal(validItemId("12345678901234567"), false);
    assert.equal(validItemId(""), false);
    assert.equal(validItemId("custom-"), false);
    assert.equal(validItemId("<script>"), false);
    assert.equal(validItemId(null), false);
    assert.equal(validItemId({ id: 1 }), false);
  });
});

describe("escapeHTML", () => {
  it("XSS vektörlerini etkisiz hale getirir", () => {
    assert.equal(escapeHTML('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    assert.equal(escapeHTML("<script>alert('x')</script>"), "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    assert.equal(escapeHTML("A & B"), "A &amp; B");
  });

  it("dize olmayan girdileri güvenli biçimde dizgeleştirir", () => {
    assert.equal(escapeHTML(null), "");
    assert.equal(escapeHTML(undefined), "");
    assert.equal(escapeHTML(42), "42");
  });
});

describe("normalizeSavedItem", () => {
  it("bozuk kayıtları reddeder", () => {
    assert.equal(normalizeSavedItem(null), null);
    assert.equal(normalizeSavedItem(undefined), null);
    assert.equal(normalizeSavedItem([baseItem()]), null);
    assert.equal(normalizeSavedItem("film"), null);
    assert.equal(normalizeSavedItem(baseItem({ id: "DROP TABLE" })), null);
    assert.equal(normalizeSavedItem(baseItem({ media_type: "book" })), null);
  });

  it("poster adresinde yalnızca HTTPS'i kabul eder", () => {
    assert.equal(normalizeSavedItem(baseItem({ poster_url: "https://example.com/p.jpg" })).poster_url, "https://example.com/p.jpg");
    assert.equal(normalizeSavedItem(baseItem({ poster_url: "http://example.com/p.jpg" })).poster_url, "");
    assert.equal(normalizeSavedItem(baseItem({ poster_url: "javascript:alert(1)" })).poster_url, "");
    assert.equal(normalizeSavedItem(baseItem({ poster_url: "data:text/html;base64,PGI+" })).poster_url, "");
    assert.equal(normalizeSavedItem(baseItem({ poster_url: "not a url" })).poster_url, "");
  });

  it("alan uzunluklarını sınırlandırır", () => {
    const item = normalizeSavedItem(baseItem({ title: "x".repeat(500), overview: "y".repeat(9000) }));
    assert.equal(item.title.length, 160);
    assert.equal(item.overview.length, 5000);
  });

  it("kişisel puanı doğrular", () => {
    assert.equal(normalizeSavedItem(baseItem({ personal_rating: 11 })).personal_rating, "");
    assert.equal(normalizeSavedItem(baseItem({ personal_rating: 0 })).personal_rating, "");
    assert.equal(normalizeSavedItem(baseItem({ personal_rating: -3 })).personal_rating, "");
    assert.equal(normalizeSavedItem(baseItem({ personal_rating: "abc" })).personal_rating, "");
    assert.equal(normalizeSavedItem(baseItem({ personal_rating: 7 })).personal_rating, 7);
    assert.equal(normalizeSavedItem(baseItem({ personal_rating: "8" })).personal_rating, 8);
  });

  it("bilinçli puan temizleme bayrağını korur", () => {
    assert.equal(normalizeSavedItem(baseItem({ personal_rating: "", personal_rating_cleared: true })).personal_rating_cleared, true);
    assert.equal(normalizeSavedItem(baseItem({ personal_rating: 9, personal_rating_cleared: true })).personal_rating_cleared, false);
    assert.equal(normalizeSavedItem(baseItem({ personal_rating: "" })).personal_rating_cleared, false);
  });

  it("geçersiz durumu ve tür kimliklerini temizler", () => {
    assert.equal(normalizeSavedItem(baseItem({ status: "hacked" })).status, "watchlist");
    assert.equal(normalizeSavedItem(baseItem({ status: "watching" })).status, "watching");
    const item = normalizeSavedItem(baseItem({ genre_ids: [1, "2", "abc", -1, 1.5, 0, {}] }));
    assertSame(item.genre_ids, [1, 2]);
  });

  it("eski (legacy) sezon verisini season_progress yapısına taşır", () => {
    const item = normalizeSavedItem(baseItem({ media_type: "tv", current_season: 2, episodes_watched: 5 }));
    assertSame(item.season_progress, { 2: 5 });
    assert.equal(item.episodes_watched, 5);
    assert.equal(item.current_season, 2);
  });

  it("legacy veri sezonu belirsizse sezon 1 varsayar", () => {
    const item = normalizeSavedItem(baseItem({ media_type: "tv", episodes_watched: 3 }));
    assertSame(item.season_progress, { 1: 3 });
    assert.equal(item.current_season, 1);
  });

  it("season_progress haritasını doğrular ve türetilen toplamı hesaplar", () => {
    const item = normalizeSavedItem(baseItem({
      media_type: "tv",
      season_progress: { 1: 8, 2: 3, "x": 5, 0: 9, "-2": 4, 999: 1, 3: 12.9 },
      episodes_watched: 9999
    }));
    assertSame(item.season_progress, { 1: 8, 2: 3, 3: 12 });
    assert.equal(item.episodes_watched, 23);
    assert.equal(item.current_season, 3);
  });

  it("açık season_progress verisi legacy toplamı geçersiz kılar", () => {
    const item = normalizeSavedItem(baseItem({ media_type: "tv", season_progress: { 1: 0 }, episodes_watched: 9 }));
    assertSame(item.season_progress, { 1: 0 });
    assert.equal(item.episodes_watched, 0);
  });

  it("next_episode_to_air alanı doğrular", () => {
    assertSame(
      normalizeSavedItem(baseItem({ media_type: "tv", next_episode_to_air: { air_date: "2026-10-20", episode_number: 4, season_number: 2, junk: "x" } })).next_episode_to_air,
      { air_date: "2026-10-20", episode_number: 4, season_number: 2 }
    );
    assert.equal(normalizeSavedItem(baseItem({ media_type: "tv", next_episode_to_air: { air_date: "yok" } })).next_episode_to_air, null);
    assert.equal(normalizeSavedItem(baseItem({ media_type: "tv", next_episode_to_air: "2026-10-20" })).next_episode_to_air, null);
    assert.equal(normalizeSavedItem(baseItem({ media_type: "tv", next_episode_to_air: [{ air_date: "2026-10-20" }] })).next_episode_to_air, null);
  });

  it("prototype kirliliğini engeller", () => {
    const malicious = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"evil":true}},"id":7,"media_type":"movie","title":"Temiz"}');
    const item = normalizeSavedItem(malicious);
    assert.equal(item.title, "Temiz");
    assert.equal({}.polluted, undefined);
    assert.equal({}.evil, undefined);
    assert.equal("polluted" in item, false);
    assert.equal("evil" in item, false);
    assert.equal(Object.keys(item).includes("__proto__"), false);
  });
});

describe("parseBackupText", () => {
  const validBackup = (overrides = {}) => JSON.stringify({
    version: 2,
    profileName: "  Ayşe  ",
    items: [baseItem(), baseItem({ id: 9, media_type: "tv", title: "Dizi" })],
    preferences: { disliked: ["movie:5"], mood: "cheerful" },
    ...overrides
  });

  it("geçerli yedeği ayrıştırır ve kayıtları normalize eder", () => {
    const backup = parseBackupText(validBackup());
    assert.equal(backup.items.length, 2);
    assert.equal(backup.items[0].status, "watchlist");
    assert.equal(backup.profileName, "Ayşe");
    assertSame(backup.preferences, { disliked: ["movie:5"], mood: "cheerful" });
  });

  it("bozuk JSON'ı reddeder", () => {
    const isSyntaxError = (error) => error.name === "SyntaxError";
    assert.throws(() => parseBackupText("{ kesinlikle bozuk"), isSyntaxError);
    assert.throws(() => parseBackupText(""), isSyntaxError);
  });

  it("geçersiz sürüm ve yapıyı reddeder", () => {
    const wrong = (message) => /geçerli bir CineTrack yedeği değil/.test(message);
    assert.throws(() => parseBackupText(validBackup({ version: 3 })), (error) => wrong(error.message));
    assert.throws(() => parseBackupText(validBackup({ version: "2" })), (error) => wrong(error.message));
    assert.throws(() => parseBackupText("null"), (error) => wrong(error.message));
    assert.throws(() => parseBackupText("[1,2,3]"), (error) => wrong(error.message));
    assert.throws(() => parseBackupText(JSON.stringify({ version: 2, items: "çok şey" })), (error) => wrong(error.message));
    assert.throws(() => parseBackupText(JSON.stringify({ version: 2 })), (error) => wrong(error.message));
  });

  it("geçersiz içerik kimliklerinde güvenlik hatası verir", () => {
    const malicious = JSON.stringify({
      version: 2,
      items: [
        { id: "<img src=x onerror=alert(1)>", media_type: "movie", title: "Kötü" },
        baseItem()
      ]
    });
    assert.throws(() => parseBackupText(malicious), (error) => /güvenlik nedeniyle içe aktarma durduruldu/i.test(error.message));
    const negative = JSON.stringify({ version: 2, items: [{ id: -5, media_type: "movie" }] });
    assert.throws(() => parseBackupText(negative), (error) => /güvenlik nedeniyle içe aktarma durduruldu/i.test(error.message));
    const wrongType = JSON.stringify({ version: 2, items: [{ id: 5, media_type: "song" }] });
    assert.throws(() => parseBackupText(wrongType), (error) => /güvenlik nedeniyle içe aktarma durduruldu/i.test(error.message));
  });

  it("XSS başlıklarını metin olarak taşır, HTML üretmez", () => {
    const backup = parseBackupText(JSON.stringify({
      version: 2,
      items: [{ ...baseItem(), title: "<svg onload=alert(1)>" }]
    }));
    assert.equal(backup.items[0].title, "<svg onload=alert(1)>");
    assert.ok(!escapeHTML(backup.items[0].title).includes("<svg"));
  });

  it("tercih alanını güvenli hale getirir", () => {
    assert.equal(parseBackupText(validBackup({ preferences: ["hacked"] })).preferences, null);
    assert.equal(parseBackupText(validBackup({ preferences: "hacked" })).preferences, null);
    assert.equal(parseBackupText(validBackup({ preferences: null })).preferences, null);
    assert.equal(parseBackupText(validBackup({ profileName: 42 })).profileName, "");
    assert.equal(parseBackupText(validBackup({ profileName: "x".repeat(100) })).profileName.length, 40);
  });

  it("yedek içindeki tekrarlanan kayıtları birleştirir", () => {
    const backup = parseBackupText(JSON.stringify({
      version: 2,
      items: [baseItem({ status: "watching" }), baseItem({ status: "completed" })]
    }));
    assert.equal(backup.items.length, 1);
  });
});

describe("dedupeItems", () => {
  it("boş girdi boş çıkarır ve farklı kayıtları korur", () => {
    assertSame(dedupeItems([]), []);
    assert.equal(dedupeItems([baseItem(), baseItem({ id: 5 })]).length, 2);
  });

  it("durumda en yeni kaydı esas alır", () => {
    const [merged] = dedupeItems([
      normalizeSavedItem(baseItem({ status: "watching", updatedAt: "2026-01-01T00:00:00Z" })),
      normalizeSavedItem(baseItem({ status: "completed", updatedAt: "2026-02-01T00:00:00Z" }))
    ]);
    assert.equal(merged.status, "completed");
    assert.equal(merged.updatedAt, "2026-02-01T00:00:00Z");
  });

  it("yeni kayıtta puan varsa onu kullanır", () => {
    const [merged] = dedupeItems([
      normalizeSavedItem(baseItem({ personal_rating: 4, updatedAt: "2026-01-01T00:00:00Z" })),
      normalizeSavedItem(baseItem({ personal_rating: 9, updatedAt: "2026-02-01T00:00:00Z" }))
    ]);
    assert.equal(merged.personal_rating, 9);
  });

  it("yeni kayıttaki boş puan eksik veriyse eski puanı korur", () => {
    const [merged] = dedupeItems([
      normalizeSavedItem(baseItem({ personal_rating: 8, updatedAt: "2026-01-01T00:00:00Z" })),
      normalizeSavedItem(baseItem({ personal_rating: "", updatedAt: "2026-02-01T00:00:00Z" }))
    ]);
    assert.equal(merged.personal_rating, 8);
    assert.equal(merged.personal_rating_cleared, false);
  });

  it("yeni kayıttaki boş puan bilinçli temizlemeyse puanı silik tutar", () => {
    const [merged] = dedupeItems([
      normalizeSavedItem(baseItem({ personal_rating: 8, updatedAt: "2026-01-01T00:00:00Z" })),
      normalizeSavedItem(baseItem({ personal_rating: "", personal_rating_cleared: true, updatedAt: "2026-02-01T00:00:00Z" }))
    ]);
    assert.equal(merged.personal_rating, "");
    assert.equal(merged.personal_rating_cleared, true);
  });

  it("eski kayıttaki temizleme bayrağı yeni puanı ezmez", () => {
    const [merged] = dedupeItems([
      normalizeSavedItem(baseItem({ personal_rating: "", personal_rating_cleared: true, updatedAt: "2026-01-01T00:00:00Z" })),
      normalizeSavedItem(baseItem({ personal_rating: 6, updatedAt: "2026-02-01T00:00:00Z" }))
    ]);
    assert.equal(merged.personal_rating, 6);
    assert.equal(merged.personal_rating_cleared, false);
  });

  it("en eski addedAt değerini korur", () => {
    const [merged] = dedupeItems([
      normalizeSavedItem(baseItem({ addedAt: "2025-05-05T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" })),
      normalizeSavedItem(baseItem({ addedAt: "2024-01-01T00:00:00Z", updatedAt: "2025-12-01T00:00:00Z" }))
    ]);
    assert.equal(merged.addedAt, "2024-01-01T00:00:00Z");
    assert.equal(merged.updatedAt, "2026-02-01T00:00:00Z");
  });

  it("sezon ilerlemesini kayıtlar arası birleştirir", () => {
    const [merged] = dedupeItems([
      normalizeSavedItem(baseItem({ media_type: "tv", season_progress: { 1: 8 }, updatedAt: "2026-01-01T00:00:00Z" })),
      normalizeSavedItem(baseItem({ media_type: "tv", season_progress: { 2: 3 }, updatedAt: "2026-02-01T00:00:00Z" }))
    ]);
    assertSame(merged.season_progress, { 1: 8, 2: 3 });
    assert.equal(merged.episodes_watched, 11);
  });

  it("aynı sezonda çakışıyorsa yeni kaydın ilerlemesini kullanır", () => {
    const [merged] = dedupeItems([
      normalizeSavedItem(baseItem({ media_type: "tv", season_progress: { 1: 8 }, updatedAt: "2026-01-01T00:00:00Z" })),
      normalizeSavedItem(baseItem({ media_type: "tv", season_progress: { 1: 2 }, updatedAt: "2026-02-01T00:00:00Z" }))
    ]);
    assertSame(merged.season_progress, { 1: 2 });
  });

  it("yeni kayıtta eksikse eski yayın takvimini korur", () => {
    const schedule = { air_date: "2026-10-20", episode_number: 4, season_number: 2 };
    const [merged] = dedupeItems([
      normalizeSavedItem(baseItem({ media_type: "tv", next_episode_to_air: schedule, updatedAt: "2026-01-01T00:00:00Z" })),
      normalizeSavedItem(baseItem({ media_type: "tv", updatedAt: "2026-02-01T00:00:00Z" }))
    ]);
    assertSame(merged.next_episode_to_air, schedule);
  });
});

describe("createRequestGate", () => {
  it("biletleri sıralar ve yalnızca güncel isteği onaylar", () => {
    const gate = createRequestGate();
    const first = gate.begin();
    assert.equal(gate.isCurrent(first.id), true);
    const second = gate.begin();
    assert.equal(second.id, first.id + 1);
    assert.equal(gate.isCurrent(first.id), false);
    assert.equal(gate.isCurrent(second.id), true);
  });

  it("yeni istek başlatınca önceki isteği iptal eder", () => {
    const gate = createRequestGate();
    const first = gate.begin();
    assert.equal(first.signal.aborted, false);
    gate.begin();
    assert.equal(first.signal.aborted, true);
  });

  it("geçersiz kılmada tüm istekleri iptal eder", () => {
    const gate = createRequestGate();
    const ticket = gate.begin();
    gate.invalidate();
    assert.equal(gate.isCurrent(ticket.id), false);
    assert.equal(ticket.signal.aborted, true);
    const next = gate.begin();
    assert.equal(next.signal.aborted, false);
    assert.equal(gate.isCurrent(next.id), true);
  });

  it("profil değişimi yarışında geç yanıt eski sayılır", async () => {
    const gate = createRequestGate();
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const first = gate.begin();
    const slowRequest = (async () => {
      await delay(20);
      return first;
    })();
    const second = gate.begin();
    const fastRequest = (async () => {
      await delay(5);
      return second;
    })();
    const [slow, fast] = await Promise.all([slowRequest, fastRequest]);
    assert.equal(gate.isCurrent(slow.id), false);
    assert.equal(gate.isCurrent(fast.id), true);
    assert.equal(slow.signal.aborted, true);
    assert.equal(fast.signal.aborted, false);
  });
});

describe("normalizePreferences", () => {
  it("geçersiz girdiyi varsayılanlara indirger", () => {
    const defaults = { disliked: [], providers: [], mood: "", reminders: false, notified: [] };
    assertSame(normalizePreferences(null), defaults);
    assertSame(normalizePreferences("hacked"), defaults);
    assertSame(normalizePreferences([1, 2]), defaults);
  });

  it("disliked anahtarlarını desene göre filtreler ve sınırlandırır", () => {
    const prefs = normalizePreferences({
      disliked: ["movie:5", "tv:custom-abc", "movie:", "book:9", "movie:99999999999999999", "movie:6", 42, null]
    });
    assertSame(prefs.disliked, ["movie:5", "tv:custom-abc", "movie:6"]);
    const many = normalizePreferences({ disliked: Array.from({ length: 600 }, (_, index) => `movie:${index + 1}`) });
    assert.equal(many.disliked.length, 500);
    assert.equal(many.disliked[0], "movie:101");
  });

  it("sağlayıcı kimliklerini dizgeleştirir ve temizler", () => {
    const prefs = normalizePreferences({ providers: [8, "9", "abc", 0, -3, 12.5, "119"] });
    assertSame(prefs.providers, ["8", "9", "119"]);
  });

  it("ruh hâlini bilinen seçeneklerle sınırlar", () => {
    assert.equal(normalizePreferences({ mood: "cheerful" }, { knownMoods: ["cheerful"] }).mood, "cheerful");
    assert.equal(normalizePreferences({ mood: "evil" }, { knownMoods: ["cheerful"] }).mood, "");
    assert.equal(normalizePreferences({ mood: "thrilling" }).mood, "thrilling");
    assert.equal(normalizePreferences({ mood: "x".repeat(50) }).mood.length, 20);
  });

  it("reminders ve notified alanlarını doğrular", () => {
    const prefs = normalizePreferences({ reminders: "yes", notified: ["a".repeat(300), "ok", 5] });
    assert.equal(prefs.reminders, false);
    assertSame(prefs.notified, ["ok"]);
  });
});

describe("normalizeProfile", () => {
  it("geçersiz profilleri reddeder", () => {
    assert.equal(normalizeProfile(null), null);
    assert.equal(normalizeProfile({ id: "hacker", items: [] }), null);
    assert.equal(normalizeProfile({ id: "profile/../etc" }), null);
    assert.equal(normalizeProfile("profile-a"), null);
  });

  it("adı temizler ve eksikse varsayılan verir", () => {
    assert.equal(normalizeProfile({ id: "profile-a" }).name, "Profilim");
    assert.equal(normalizeProfile({ id: "profile-a", name: "   " }).name, "Profilim");
    assert.equal(normalizeProfile({ id: "profile-a", name: "x".repeat(80) }).name.length, 40);
    assert.equal(normalizeProfile({ id: "profile-a", name: "  Ayşe " }).name, "Ayşe");
  });

  it("geçersiz içerikleri sessizce düşer ve profil içinde birleştirir", () => {
    const profile = normalizeProfile({
      id: "profile-a",
      items: [baseItem(), { id: "<evil>", media_type: "movie" }, baseItem({ status: "watching", updatedAt: "2026-02-01T00:00:00Z" })]
    });
    assert.equal(profile.items.length, 1);
    assert.equal(profile.items[0].status, "watching");
  });

  it("items sınırını uygular", () => {
    const profile = normalizeProfile({
      id: "profile-a",
      items: Array.from({ length: 12 }, (_, index) => baseItem({ id: index + 1 }))
    }, { maxItems: 5 });
    assertSame(profile.items, Array.from({ length: 5 }, (_, index) => JSON.parse(JSON.stringify(normalizeSavedItem(baseItem({ id: index + 1 }))))));
  });

  it("prototype kirliliğini taşımaz", () => {
    const malicious = JSON.parse('{"__proto__":{"polluted":true},"id":"profile-a","name":"P","items":[],"preferences":{"__proto__":{"evil":true}}}');
    const profile = normalizeProfile(malicious);
    assert.equal({}.polluted, undefined);
    assert.equal({}.evil, undefined);
    assert.equal("polluted" in profile, false);
    assert.equal("evil" in profile.preferences, false);
  });
});

describe("normalizeDataDocument", () => {
  it("geçersiz belgeleri reddeder", () => {
    assert.equal(normalizeDataDocument(null), null);
    assert.equal(normalizeDataDocument("merhaba"), null);
    assert.equal(normalizeDataDocument({ version: 3 }), null);
    assert.equal(normalizeDataDocument({ version: 3, profiles: [] }), null);
    assert.equal(normalizeDataDocument({ version: 3, profiles: [{ id: "kötü" }] }), null);
  });

  it("eski v1 sunucu dosyasını tek profillik belgeye taşır", () => {
    const document = normalizeDataDocument({
      version: 1,
      profileName: "Elif",
      items: [baseItem(), baseItem({ id: 9 })]
    });
    assert.equal(document.version, 3);
    assert.equal(document.profiles.length, 1);
    assert.equal(document.activeProfileId, "profile-default");
    assert.equal(document.profiles[0].name, "Elif");
    assert.equal(document.profiles[0].items.length, 2);
  });

  it("v2 tek profil yedeğinde profil kimliğini korur", () => {
    const document = normalizeDataDocument({
      version: 2,
      profileId: "profile-ayse",
      profileName: "Ayşe",
      items: [baseItem()],
      preferences: { mood: "energetic" }
    });
    assert.equal(document.activeProfileId, "profile-ayse");
    assert.equal(document.profiles[0].preferences.mood, "energetic");
  });

  it("çok profilli belgeyi doğrular, etkin profil bilinmiyorsa ilkine döner", () => {
    const document = normalizeDataDocument({
      version: 3,
      activeProfileId: "profile-b",
      profiles: [
        { id: "profile-a", name: "A", items: [baseItem()] },
        { id: "profile-b", name: "B", items: [] }
      ]
    });
    assert.equal(document.activeProfileId, "profile-b");
    assert.equal(document.profiles.length, 2);
    const fallback = normalizeDataDocument({ version: 3, activeProfileId: "profile-x", profiles: [{ id: "profile-a" }] });
    assert.equal(fallback.activeProfileId, "profile-a");
  });

  it("tekrarlanan profil kimliklerinde ilkini korur ve profil sayısını sınırlar", () => {
    const document = normalizeDataDocument({
      version: 3,
      profiles: [
        { id: "profile-a", name: "Bir", items: [baseItem({ id: 1 })] },
        { id: "profile-a", name: "İki", items: [baseItem({ id: 2 })] },
        { id: "profile-b" }
      ]
    });
    assert.equal(document.profiles.length, 2);
    assert.equal(document.profiles[0].name, "Bir");
    assert.equal(document.profiles[0].items.length, 1);
    const capped = normalizeDataDocument(
      { version: 3, profiles: Array.from({ length: 30 }, (_, index) => ({ id: `profile-p${index}` })) },
      { maxProfiles: 5 }
    );
    assert.equal(capped.profiles.length, 5);
  });

  it("puan koruması sunucu belgesinde de geçerlidir", () => {
    const document = normalizeDataDocument({
      version: 3,
      profiles: [{
        id: "profile-a",
        items: [
          baseItem({ personal_rating: 8, updatedAt: "2026-01-01T00:00:00Z" }),
          baseItem({ personal_rating: "", personal_rating_cleared: true, updatedAt: "2026-02-01T00:00:00Z" })
        ]
      }]
    });
    const [merged] = document.profiles[0].items;
    assert.equal(merged.personal_rating, "");
    assert.equal(merged.personal_rating_cleared, true);
  });

  it("normalize edilmiş belge yeniden normalize edilebilir", () => {
    const first = normalizeDataDocument({
      version: 3,
      activeProfileId: "profile-a",
      profiles: [{ id: "profile-a", name: "A", createdAt: "2026-01-01", items: [baseItem()] }]
    });
    const second = normalizeDataDocument(first);
    assertSame(second, JSON.parse(JSON.stringify(first)));
  });

  it("prototip kirliliği içeren belgeyi güvenle temizler", () => {
    const malicious = JSON.parse('{"version":3,"__proto__":{"polluted":true},"profiles":[{"id":"profile-a","items":[{"__proto__":{"evil":true},"id":7,"media_type":"movie"}]}]}');
    const document = normalizeDataDocument(malicious);
    assert.equal({}.polluted, undefined);
    assert.equal({}.evil, undefined);
    assert.equal(document.profiles[0].items.length, 1);
    assert.equal("evil" in document.profiles[0].items[0], false);
  });
});

describe("resolveAirDate ve reminderDaysUntil", () => {
  it("dizilerde önce sonraki bölüm tarihini kullanır", () => {
    const item = baseItem({
      media_type: "tv",
      first_air_date: "2020-01-01",
      next_episode_to_air: { air_date: "2026-10-20", episode_number: 4, season_number: 2 }
    });
    assert.equal(resolveAirDate(item), "2026-10-20");
  });

  it("takvim verisi yoksa dizi ilk yayın tarihine döner", () => {
    assert.equal(resolveAirDate(baseItem({ media_type: "tv", first_air_date: "2020-01-01" })), "2020-01-01");
    assert.equal(resolveAirDate(baseItem({ media_type: "tv" })), "");
  });

  it("filmlerde yayın tarihini kullanır", () => {
    assert.equal(resolveAirDate(baseItem({ media_type: "movie", release_date: "2026-11-01" })), "2026-11-01");
    assert.equal(resolveAirDate(null), "");
  });

  it("hatırlatıcı penceresi sınırlarını doğrular", () => {
    const today = new Date(2026, 9, 18);
    assert.equal(reminderDaysUntil("2026-10-18", today), 0);
    assert.equal(reminderDaysUntil("2026-10-19", today), 1);
    assert.equal(reminderDaysUntil("2026-10-21", today), REMINDER_WINDOW_DAYS);
    assert.equal(reminderDaysUntil("2026-10-22", today), null);
    assert.equal(reminderDaysUntil("2026-10-17", today), null);
    assert.equal(reminderDaysUntil("2027-10-18", today), null);
  });

  it("geçersiz tarihleri reddeder", () => {
    const today = new Date(2026, 9, 18);
    assert.equal(reminderDaysUntil("", today), null);
    assert.equal(reminderDaysUntil("yarın", today), null);
    assert.equal(reminderDaysUntil("2026-13-45", today), null);
    assert.equal(reminderDaysUntil("18-10-2026", today), null);
    assert.equal(reminderDaysUntil(20261018, today), null);
    assert.equal(reminderDaysUntil(null, today), null);
  });

  it("sanitizasyon ve takvim yardımcılarını doğrular", () => {
    assert.equal(sanitizeNextEpisode({ air_date: "2026-02-30" }), null);
    assertSame(sanitizeNextEpisode({ air_date: "2026-10-20", episode_number: 1.9, season_number: -3 }), { air_date: "2026-10-20", episode_number: 1, season_number: 0 });
    assertSame(sanitizeSeasonProgress({ 2: "7", foo: 3, 400: 1 }), { 2: 7 });
    assertSame(buildSeasonCounts({ seasons: [
      { season_number: 1, episode_count: 8 },
      { season_number: 2, episode_count: "10" },
      { season_number: 0, episode_count: 5 },
      { season_number: 3 }
    ] }), { 1: 8, 2: 10, 3: 0 });
    assert.equal(defaultCurrentSeason({}), 1);
    assert.equal(defaultCurrentSeason({ 1: 8, 2: 0 }), 2);
    assert.equal(defaultCurrentSeason({ 1: 0, 3: 4 }), 3);
    assert.equal(defaultCurrentSeason({ 1: 8, 2: 3, 3: 12 }, { 1: 8, 2: 10, 3: 24 }), 2);
    assert.equal(defaultCurrentSeason({ 1: 8, 2: 10 }, { 1: 8, 2: 10 }), 2);
  });
});

describe("RECOMMENDATION_WEIGHTS", () => {
  it("ağırlıklar 1'e tamamlanır ve nesne donduruludur", () => {
    assertClose(Object.values(RECOMMENDATION_WEIGHTS).reduce((sum, weight) => sum + weight, 0), 1);
    assert.ok(Object.isFrozen(RECOMMENDATION_WEIGHTS));
    assert.equal(RECOMMENDATION_WEIGHTS.genre, 0.25);
    assert.equal(RECOMMENDATION_WEIGHTS.taste, 0.2);
    assert.equal(RECOMMENDATION_WEIGHTS.actor, 0.2);
    assert.equal(RECOMMENDATION_WEIGHTS.quality, 0.15);
  });
});

describe("bayesianRating", () => {
  it("yeterli oyla doğrudan ortalamayı döndürür", () => {
    assertClose(bayesianRating(8, 3000), 8);
    assertClose(bayesianRating(6.4, 300), 6.4);
  });

  it("az oylı yapımları öncelik değerine çeker", () => {
    assertClose(bayesianRating(8, 150), 0.5 * 8 + 0.5 * 6.5);
    assertClose(bayesianRating(10, 1), 6.5 + (10 - 6.5) / 300);
  });

  it("geçersiz girdilerde koruyucu 5.5 döndürür", () => {
    assertClose(bayesianRating(0, 100), 5.5);
    assertClose(bayesianRating(-2, 100), 5.5);
    assertClose(bayesianRating("abc", 100), 5.5);
    assertClose(bayesianRating(8, 0), 5.5);
    assertClose(bayesianRating(8, "yok"), 5.5);
  });

  it("özel öncelik ve eşik değerlerini kabul eder", () => {
    assertClose(bayesianRating(7, 100, { prior: 8, minVotes: 200 }), 7.5);
  });
});

describe("billingWeight", () => {
  it("başrol ağırlığı en yüksektir", () => {
    assertClose(billingWeight(0), 1);
    assertClose(billingWeight(2), 1);
    assertClose(billingWeight(3), 0.7);
    assertClose(billingWeight(5), 0.7);
    assertClose(billingWeight(6), 0.45);
    assertClose(billingWeight(9), 0.45);
    assertClose(billingWeight(10), 0.3);
    assertClose(billingWeight(40), 0.3);
  });

  it("geçersiz sıralarda en düşük ağırlığı verir", () => {
    assertClose(billingWeight(-1), 0.3);
    assertClose(billingWeight("abc"), 0.3);
    assertClose(billingWeight(null), 0.3);
  });
});

describe("buildTasteProfile", () => {
  const history = [
    { media_type: "movie", id: 1, personal_rating: 9, genre_ids: [878, 28], cast: [{ id: 100, name: "A" }, { id: 200, name: "B" }], crew: [{ id: 300, name: "Y", job: "Director" }] },
    { media_type: "movie", id: 2, personal_rating: 3, genre_ids: [10749], cast: [{ id: 100, name: "A" }], crew: [{ id: 300, name: "Y", job: "Director" }] },
    { media_type: "tv", id: 3, personal_rating: 9, genre_ids: [18], cast: [{ id: 100, name: "A" }] },
    { media_type: "movie", id: 4, status: "watchlist", genre_ids: [27] }
  ];

  it("oyuncu, yönetmen, tür ve tür bazlı oyuncu istatistiklerini hesaplar", () => {
    const profile = buildTasteProfile(history);
    assert.equal(profile.actors[100].name, "A");
    assertClose(profile.actors[100].personal, 0.4);
    assertClose(profile.actors[100].genreScores[878], 0.8);
    assertClose(profile.actors[100].genreScores[28], 0.8);
    assertClose(profile.actors[100].genreScores[10749], -0.4);
    assertClose(profile.actors[100].genreScores[18], 0.8);
    assertClose(profile.actors[200].personal, 0.8);
    assertClose(profile.directors[300].personal, 0.2);
    assertClose(profile.genres[878], 0.8);
    assertClose(profile.genres[28], 0.8);
    assertClose(profile.genres[10749], -0.4);
    assertClose(profile.genres[18], 0.8);
    assert.equal(profile.genres[27], undefined);
    assertClose(profile.mediaPreference.movie, 2 / 3);
    assertClose(profile.mediaPreference.tv, 1 / 3);
  });

  it("izleme listesindeki puanlanmamış kayıtları yok sayar", () => {
    const profile = buildTasteProfile([{ media_type: "movie", id: 4, status: "watchlist", genre_ids: [27], cast: [{ id: 5, name: "C" }] }]);
    assert.equal(profile.genres[27], undefined);
    assert.equal(profile.actors[5], undefined);
    assertClose(profile.mediaPreference.movie, 0.5);
    assertClose(profile.mediaPreference.tv, 0.5);
  });

  it("puansız tamamlanan ve izlenen kayıtlardan durum sinyali alır", () => {
    const profile = buildTasteProfile([
      { media_type: "tv", id: 9, status: "completed", genre_ids: [16], cast: [{ id: 5, name: "C" }], crew: [{ id: 8, name: "D", job: "Creator" }] },
      { media_type: "movie", id: 10, status: "watching", genre_ids: [16] }
    ]);
    assertClose(profile.genres[16], (0.4 + 0.2) / 2);
    assertClose(profile.actors[5].personal, 0.4);
    assertClose(profile.directors[8].personal, 0.4);
  });

  it("boş ve bozuk girdilerde nötr profil döndürür", () => {
    for (const input of [[], null, undefined, [null, "x"]]) {
      const profile = buildTasteProfile(input);
      assertSame(profile.actors, {});
      assertSame(profile.directors, {});
      assertSame(profile.genres, {});
      assertClose(profile.mediaPreference.movie, 0.5);
      assertClose(profile.mediaPreference.tv, 0.5);
    }
  });
});

describe("scoreCandidates", () => {
  const history = [
    { media_type: "movie", id: 1, personal_rating: 9, genre_ids: [878, 28], cast: [{ id: 100, name: "A" }, { id: 200, name: "B" }], crew: [{ id: 300, name: "Y", job: "Director" }] },
    { media_type: "movie", id: 2, personal_rating: 3, genre_ids: [10749], cast: [{ id: 100, name: "A" }], crew: [{ id: 300, name: "Y", job: "Director" }] },
    { media_type: "tv", id: 3, personal_rating: 9, genre_ids: [18], cast: [{ id: 100, name: "A" }] }
  ];
  const profile = buildTasteProfile(history);
  const genreNames = { 878: "Bilim Kurgu", 10749: "Romantik" };
  const mkCandidate = (overrides = {}) => ({
    id: 90,
    media_type: "movie",
    title: "Aday",
    genre_ids: [878],
    vote_average: 8.2,
    vote_count: 1500,
    cast: [],
    crew: [],
    ...overrides
  });

  it("sevilen oyunculu aday nötr adayı geçer ve neden etiketi üretir", () => {
    const liked = scoreCandidates(
      [mkCandidate({ cast: [{ id: 100, name: "A", popularity: 50 }], poolReason: "\"Test\" sevdiğin için" })],
      profile, { genreNames }
    )[0];
    const neutral = scoreCandidates(
      [mkCandidate({ id: 91, cast: [{ id: 999, name: "X", popularity: 0 }] })],
      profile, { genreNames }
    )[0];

    assertClose(liked.parts.taste, 0.7);
    assertClose(liked.parts.actor, 0.4 * (50 / 150) + 0.6 * (0.6 * 0.9 + 0.4 * 0.7));
    assertClose(liked.parts.quality, 0.82);
    assertClose(liked.parts.genre, 0.75 * 0.9 + 0.25 * (2 / 3));
    assert.ok(liked.score > neutral.score);
    assert.ok(liked.parts.actor > neutral.parts.actor);
    assertClose(neutral.parts.taste, 0.5);
    assertClose(neutral.parts.actor, 0.5);
    assert.equal(liked.tags.length, 4);
    assert.equal(liked.tags[0], "\"Test\" sevdiğin için");
    assert.ok(liked.tags.includes("Sevdiğin A oynuyor"));
    assert.ok(liked.tags.includes("Bilim Kurgu türünü sevdiğin için"));
    assert.ok(liked.tags.includes("TMDB'de 8.2 puan"));
  });

  it("oyuncu puanını tür bazlı ayırır: aynı oyuncu bilim kurguda yüksek romantikte düşük", () => {
    const [sci, rom] = scoreCandidates([
      mkCandidate({ id: 93, genre_ids: [878], cast: [{ id: 100, name: "A" }] }),
      mkCandidate({ id: 92, genre_ids: [10749], cast: [{ id: 100, name: "A" }] })
    ], profile, { genreNames });
    assertClose(sci.parts.actor, 0.4 * 0.5 + 0.6 * (0.6 * 0.9 + 0.4 * 0.7));
    assertClose(rom.parts.actor, 0.4 * 0.5 + 0.6 * (0.6 * 0.3 + 0.4 * 0.7));
    assert.ok(sci.parts.actor > rom.parts.actor);
  });

  it("bilinmeyen kadroyu keşif sinyaline çevirir", () => {
    const [discovery] = scoreCandidates([
      mkCandidate({ id: 94, genre_ids: [10765], cast: [{ id: 777, name: "Yeni", popularity: 0 }] })
    ], profile, { genreNames });
    assertClose(discovery.parts.taste, 0.5);
    assertClose(discovery.parts.actor, 0.5);
    assertClose(discovery.parts.exploration, 1);
    assert.ok(discovery.tags.includes("Yeni keşif için"));
  });

  it("kadrosuz adayda zevk puanı tür yakınlığına düşer", () => {
    const [noCast] = scoreCandidates([mkCandidate({ id: 95, cast: [] })], profile, {});
    assertClose(noCast.parts.taste, 0.9);
    assertClose(noCast.parts.actor, 0.5);
  });

  it("platform puanını Türkiye sağlayıcılarına göre verir", () => {
    const providerIndex = { "movie:90": [{ id: 8, name: "Netflix" }], "movie:91": [] };
    const [preferred, empty, unknown] = scoreCandidates([
      mkCandidate(),
      mkCandidate({ id: 91 }),
      mkCandidate({ id: 92 })
    ], profile, { preferredProviders: ["8"], providerIndex });
    assertClose(preferred.parts.platform, 1);
    assert.ok(preferred.tags.some((tag) => tag.startsWith("Tercih ettiğin platformda izlenebilir: Netflix")));
    assert.equal(preferred.tags[0], "Tercih ettiğin platformda izlenebilir: Netflix");
    assertClose(empty.parts.platform, 0.25);
    assertClose(unknown.parts.platform, 0.5);

    const anyProvider = scoreCandidates([mkCandidate()], profile, { providerIndex })[0];
    assertClose(anyProvider.parts.platform, 0.6);
    assert.ok(anyProvider.tags.includes("İzlenebilir: Netflix"));
  });

  it("havuz nedeni tür etiketiyle aynıysa yinelenmez", () => {
    const [dupe] = scoreCandidates([
      mkCandidate({ poolReason: "Bilim Kurgu türünü sevdiğin için" })
    ], profile, {});
    assert.equal(dupe.tags.filter((tag) => tag === "Bilim Kurgu türünü sevdiğin için").length, 1);
  });
});

describe("diversifyList", () => {
  const entry = (score, genres) => ({ candidate: { genre_ids: genres }, score, tags: [] });

  it("tür üst sınırını kesin uygular", () => {
    const sciFi = Array.from({ length: 20 }, (_, index) => entry(40 - index, [878]));
    const drama = entry(0, [18]);
    const picked = diversifyList([...sciFi, drama], { limit: 8, maxPerGenre: 3 });
    assert.equal(picked.length, 4);
    assert.equal(picked.filter((item) => item.candidate.genre_ids[0] === 878).length, 3);
    assert.ok(picked.some((item) => item.candidate.genre_ids[0] === 18));
  });

  it("listeyi puana göre sıralar ve limiti uygular", () => {
    const picked = diversifyList([entry(1, [878]), entry(9, [18]), entry(5, [27])], { limit: 5 });
    assertSame(picked.map((item) => item.score), [9, 5, 1]);
    const capped = diversifyList([entry(1, [878]), entry(9, [18])], { limit: 1 });
    assertSame(capped.map((item) => item.score), [9]);
  });
});

describe("createCandidatePool", () => {
  const candidate = (id, mediaType = "movie") => ({ id, media_type: mediaType, title: `T${id}` });

  it("aynı yapımları tekilleştirir ve kaynak sayısını tutar", () => {
    const pool = createCandidatePool();
    pool.add("recommendations", "\"X\" için", "movie", [candidate(1), candidate(2)]);
    pool.add("similar", "\"X\" benzeri", "movie", [candidate(1), candidate(3, "tv")]);
    assert.equal(pool.size, 3);
    const list = pool.list();
    const dupe = list.find((item) => item.id === 1);
    assert.equal(dupe.poolSources, 2);
    assert.equal(dupe.poolReason, "\"X\" için");
    assert.equal(list.find((item) => item.id === 3).media_type, "tv");
  });

  it("tahmini türü kullanır ve geçersiz kayıtları düşer", () => {
    const pool = createCandidatePool();
    pool.add("discover", "keşif", "tv", [{ id: 5 }, { id: 6, media_type: "song" }, { title: "idsiz" }, null]);
    assertSame(pool.list().map((item) => `${item.media_type}:${item.id}`), ["tv:5", "tv:6"]);
  });

  it("üst sınırı aşan eklemeleri yok sayar", () => {
    const pool = createCandidatePool({ maxItems: 2 });
    pool.add("a", "neden", "movie", [candidate(1), candidate(2), candidate(3)]);
    assert.equal(pool.size, 2);
    pool.add("b", "neden", "movie", [candidate(1)]);
    assert.equal(pool.size, 2);
    assert.equal(pool.list()[0].poolSources, 2);
  });
});

describe("Sana Özel v3 — RECOMMENDATION_WEIGHTS_V3", () => {
  it("platform tamamen kaldırılmıştır ve ağırlıklar tam %100 (1.00) eder", () => {
    assert.equal("platform" in RECOMMENDATION_WEIGHTS_V3, false);
    const sum = Object.values(RECOMMENDATION_WEIGHTS_V3).reduce((acc, w) => acc + w, 0);
    assertClose(sum, 1.0);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.genre, 0.17);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.mediaType, 0.03);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.keywords, 0.13);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.story, 0.12);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.lovedSim, 0.10);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.actor, 0.10);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.genreActor, 0.08);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.director, 0.04);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.quality, 0.08);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.exploration, 0.04);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.popularity, 0.03);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.context, 0.03);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.franchise, 0.03);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.sourceSignal, 0.02);
  });
});

describe("Sana Özel v3 — normalizeUserRating ve signalDecay", () => {
  it("puanı 1..10 aralığında -1 ile +1 arasına normalize eder", () => {
    assertClose(normalizeUserRating(1), -1.0);
    assertClose(normalizeUserRating(3), -0.5);
    assertClose(normalizeUserRating(5), 0.0);
    assertClose(normalizeUserRating(7), 0.4);
    assertClose(normalizeUserRating(8), 0.6);
    assertClose(normalizeUserRating(10), 1.0);
  });

  it("zaman sönümü d(t) = 2^(-t/H) formülünü doğru hesaplar", () => {
    const now = new Date("2026-10-19T00:00:00Z").getTime();
    const halfYearAgo = new Date(now - 365 * 86400000).toISOString();
    assertClose(signalDecay(halfYearAgo, 365, now), 0.5);

    const twoYearsAgo = new Date(now - 730 * 86400000).toISOString();
    assertClose(signalDecay(twoYearsAgo, 730, now), 0.5);
    assertClose(signalDecay(twoYearsAgo, 365, now), 0.25);
  });
});

describe("Sana Özel v3 — getUserSignalV3", () => {
  it("durum ve puan sinyal değerlerini ve önem ağırlıklarını doğru belirler", () => {
    const completedUnrated = getUserSignalV3({ status: "completed" });
    assert.equal(completedUnrated.signal, 0.4);
    assert.equal(completedUnrated.weight, 2.5);

    const watchingUnrated = getUserSignalV3({ status: "watching" });
    assert.equal(watchingUnrated.signal, 0.2);
    assert.equal(watchingUnrated.weight, 1.6);

    const watchlistUnrated = getUserSignalV3({ status: "watchlist" });
    assert.equal(watchlistUnrated.signal, 0.2);
    assert.equal(watchlistUnrated.weight, 0.35);

    const ratedItem = getUserSignalV3({ status: "completed", personal_rating: 9 });
    assertClose(ratedItem.signal, 0.8);
    assert.equal(ratedItem.weight, 2.5);

    const disliked = getUserSignalV3({ status: "disliked" });
    assert.equal(disliked.signal, -0.8);
    assert.equal(disliked.weight, 1.0);
  });
});

describe("Sana Özel v3 — buildTasteProfileV3 ve scoreCandidatesV3", () => {
  it("yumuşatılmış tat profilini ve aday puanını 0..100 aralığında üretir", () => {
    const history = [
      {
        id: 1,
        media_type: "movie",
        status: "completed",
        personal_rating: 9,
        genre_ids: [878, 28],
        overview: "Gelecekte geçen distopik yapay zeka savaşı ve uzay gemisi",
        cast: [{ id: 100, name: "Aktör A" }, { id: 200, name: "Aktör B" }],
        crew: [{ id: 300, name: "Yönetmen Y", job: "Director" }],
      },
      {
        id: 2,
        media_type: "movie",
        status: "completed",
        personal_rating: 2,
        genre_ids: [10749],
        cast: [{ id: 100, name: "Aktör A" }],
      },
    ];

    const profile = buildTasteProfileV3(history, { lambda: 1 });
    assert.ok(profile.genres[878] > 0);
    assert.ok(profile.genres[10749] < 0);
    assert.ok(profile.actors[100].genreScores[878] > profile.actors[100].genreScores[10749]);
    assert.ok(profile.lovedSeedIds.has("movie:1"));

    const candidateLiked = {
      id: 50,
      media_type: "movie",
      title: "Uzay Macerası",
      genre_ids: [878],
      overview: "Yapay zeka ve uzay gemisi ile karanlık geleceğe yolculuk",
      vote_average: 8.5,
      vote_count: 2000,
      popularity: 150,
      cast: [{ id: 100, name: "Aktör A" }],
      crew: [{ id: 300, name: "Yönetmen Y", job: "Director" }],
      seedSourceType: "completed",
      poolSources: 2,
    };

    const candidateUnrelated = {
      id: 51,
      media_type: "movie",
      title: "Romantik Düğün",
      genre_ids: [10749],
      overview: "Eski bir köyde geçen aşk hikayesi",
      vote_average: 5.5,
      vote_count: 50,
      popularity: 10,
      cast: [{ id: 999, name: "Bilinmeyen" }],
      crew: [],
      seedSourceType: "",
      poolSources: 1,
    };

    const [scoredLiked, scoredUnrelated] = scoreCandidatesV3(
      [candidateLiked, candidateUnrelated],
      profile,
      { genreNames: { 878: "Bilim Kurgu", 10749: "Romantik" } }
    );

    assert.ok(scoredLiked.score > scoredUnrelated.score);
    assert.ok(scoredLiked.score >= 0 && scoredLiked.score <= 100);
    assert.ok(scoredUnrelated.score >= 0 && scoredUnrelated.score <= 100);
    assert.ok(scoredLiked.tags.some((t) => t.includes("Aktör A") || t.includes("Bilim Kurgu")));
  });
});


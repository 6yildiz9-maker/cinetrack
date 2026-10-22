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
  buildTasteProfileV3, scoreCandidatesV3, actorFrequency, pairMatchScore, castHarmonyScore,
  findSavedItem, scoreActorRecommendations, calculateActorRoleBonus, diversifyActorRecommendations,
  makeMediaKey, parseMediaKey, normalizeFavoriteActor, normalizeFavoriteActors,
  isItemSaved, filterHistoryByType, filterDislikedByType, TARGET_RECOMMENDATION_COUNT,
  POOL_TARGET_CAPACITY, POOL_LOW_WATERMARK, POOL_REPLENISH_MIN_NEW,
  determineItemEra, determineItemPopularityTier, normalizePoolCandidate,
  isCandidateEligibleInPool, filterEligiblePoolItems, balanceCandidatePool,
  multiDimensionalDiversify, PoolReplenishmentLock, poolReplenishmentLock,
  loadPersistentPoolData, savePersistentPoolData, createDefaultPoolCursors, createDefaultPoolData,
  replenishCandidatePool, selectBalancedRecommendations,
  assignTasteRing, demoteTasteRing, getTasteRingLabel,
  loadPersistentTasteMap, savePersistentTasteMap, updateTasteMapWithBatch,
  markTasteMapItemStatus, syncPoolCandidatesWithTasteMap,
  createDefaultTasteMapData, getTasteMapStorageKey
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
    assert.throws(() => parseBackupText(validBackup({ version: 4 })), (error) => wrong(error.message));
    assert.throws(() => parseBackupText(validBackup({ version: 0 })), (error) => wrong(error.message));
    assert.throws(() => parseBackupText(validBackup({ version: "2" })), (error) => wrong(error.message));
    assert.throws(() => parseBackupText("null"), (error) => wrong(error.message));
    assert.throws(() => parseBackupText("[1,2,3]"), (error) => wrong(error.message));
    assert.throws(() => parseBackupText(JSON.stringify({ version: 2, items: "çok şey" })), (error) => wrong(error.message));
    assert.throws(() => parseBackupText(JSON.stringify({ version: 2 })), (error) => wrong(error.message));
  });

  it("eski ve yeni yedek sürümlerini (v1, v2, v3) geriye dönük uyumlu ayrıştırır", () => {
    // v1 veya v2 yedeği (favoriteActors alanı yok)
    const oldBackup = validBackup({ version: 2 });
    const parsedOld = parseBackupText(oldBackup);
    assert.equal(parsedOld.items.length, 2);
    assert.deepEqual(parsedOld.favoriteActors, []);

    // v3 yedeği (favoriteActors ile)
    const v3Backup = JSON.stringify({
      version: 3,
      items: [baseItem()],
      profileName: "Sinema Sever",
      preferences: { disliked: ["movie:550"], providers: ["8"], mood: "thoughtful", reminders: false, notified: [] },
      favoriteActors: [
        { id: 2037, name: "Cillian Murphy", profile_path: "/photo.jpg" },
        { id: 934, name: "Rebecca Ferguson" }
      ]
    });
    const parsedV3 = parseBackupText(v3Backup);
    assert.equal(parsedV3.items.length, 1);
    assert.equal(parsedV3.favoriteActors.length, 2);
    assert.equal(parsedV3.favoriteActors[0].name, "Cillian Murphy");
    assert.equal(parsedV3.favoriteActors[1].id, 934);
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
  it("yapım şirketi ve platform kaldırılmıştır, oyuncu bileşenleri %24'tür ve ağırlıklar tam %100 (1.00) eder", () => {
    assert.equal("platform" in RECOMMENDATION_WEIGHTS_V3, false);
    assert.equal("productionCompany" in RECOMMENDATION_WEIGHTS_V3, false);
    const sum = Object.values(RECOMMENDATION_WEIGHTS_V3).reduce((acc, w) => acc + w, 0);
    assertClose(sum, 1.0);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.genre, 0.16);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.mediaType, 0.03);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.keywords, 0.12);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.story, 0.11);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.lovedSim, 0.09);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.actor, 0.12);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.genreActor, 0.08);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.castHarmony, 0.04);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.director, 0.04);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.quality, 0.08);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.exploration, 0.04);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.popularity, 0.03);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.context, 0.03);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.franchise, 0.01);
    assert.equal(RECOMMENDATION_WEIGHTS_V3.sourceSignal, 0.02);

    // Üç oyuncu bileşeni toplam %24 olmalı
    const actorTotal =
      RECOMMENDATION_WEIGHTS_V3.actor +
      RECOMMENDATION_WEIGHTS_V3.genreActor +
      RECOMMENDATION_WEIGHTS_V3.castHarmony;
    assertClose(actorTotal, 0.24);
  });
});

describe("Sana Özel v3 — Oyuncu Sıklığı ve Kadro Uyumu Formülleri", () => {
  it("F(a) logaritmik sıklık formülünü hesaplar ve yaklaşık 6 görünmede doygunluğa ulaşır", () => {
    assert.equal(actorFrequency(0), 0);
    assert.equal(actorFrequency(-2), 0);
    // N_a = 2 -> ln(3)/ln(7) ~ 0.5645
    assertClose(actorFrequency(2), Math.log(3) / Math.log(7));
    // N_a = 5 -> ln(6)/ln(7) ~ 0.9207
    assertClose(actorFrequency(5), Math.log(6) / Math.log(7));
    // N_a = 6 -> ln(7)/ln(7) = 1.0
    assertClose(actorFrequency(6), 1.0);
    // N_a = 15 -> min(1, ...) = 1.0
    assert.equal(actorFrequency(15), 1.0);
  });

  it("E(a,b) iki oyuncu arasındaki eşleşme puanını pozitif skorlarla hesaplar", () => {
    assertClose(pairMatchScore(0.8, 0.5), Math.sqrt(0.4));
    assert.equal(pairMatchScore(-0.5, 0.8), 0);
    assert.equal(pairMatchScore(0.8, -0.2), 0);
    assert.equal(pairMatchScore(0, 0.8), 0);
  });

  it("S_kadro sinerji puanı eşleşme yoksa nötr 0.5, pozitif eşleşmelerde 1.0'a kadar artar", () => {
    assert.equal(castHarmonyScore(0), 0.5);
    const withOnePair = castHarmonyScore(0.6);
    assert.ok(withOnePair > 0.5 && withOnePair < 1.0);
    const withManyPairs = castHarmonyScore(3.0);
    assert.ok(withManyPairs > withOnePair && withManyPairs <= 1.0);
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

  it("birden fazla sevilen oyuncunun aynı yapımda buluşması kadro uyumunu artırır", () => {
    const history = [
      {
        id: 1,
        media_type: "movie",
        status: "completed",
        personal_rating: 10,
        genre_ids: [28],
        cast: [{ id: 101, name: "Oyuncu Bir" }, { id: 102, name: "Oyuncu İki" }],
      },
      {
        id: 2,
        media_type: "movie",
        status: "completed",
        personal_rating: 9,
        genre_ids: [28],
        cast: [{ id: 101, name: "Oyuncu Bir" }],
      },
      {
        id: 3,
        media_type: "movie",
        status: "completed",
        personal_rating: 9,
        genre_ids: [28],
        cast: [{ id: 102, name: "Oyuncu İki" }],
      },
    ];

    const profile = buildTasteProfileV3(history);
    assert.ok(profile.actors[101].personal > 0);
    assert.ok(profile.actors[102].personal > 0);
    assert.ok(profile.coOccurredPairs.has("101:102"));

    const candidateSingleActor = {
      id: 201,
      media_type: "movie",
      title: "Tek Oyunculu Film",
      genre_ids: [28],
      cast: [{ id: 101, name: "Oyuncu Bir" }, { id: 999, name: "Bilinmeyen" }],
    };

    const candidateDuoActors = {
      id: 202,
      media_type: "movie",
      title: "İkili Kadrolu Film",
      genre_ids: [28],
      cast: [{ id: 101, name: "Oyuncu Bir" }, { id: 102, name: "Oyuncu İki" }],
    };

    const [singleScored, duoScored] = scoreCandidatesV3(
      [candidateSingleActor, candidateDuoActors],
      profile
    );

    assert.equal(singleScored.parts.castHarmony, 0.5); // tek bilinen oyuncuda sinerji 0, nötr 0.5
    assert.ok(duoScored.parts.castHarmony > 0.5); // iki sevilen oyuncuda sinerji yükselir
    assert.ok(duoScored.score > singleScored.score);
    assert.ok(duoScored.tags.includes("Sevdiğin oyuncular bu kadroda buluşuyor"));
  });

  it("düşük puanlanan oyuncu negatif tercih yansıtır ve sinerji katkısı sağlamaz", () => {
    const history = [
      {
        id: 10,
        media_type: "movie",
        status: "completed",
        personal_rating: 1,
        cast: [{ id: 301, name: "Sevilmeyen Oyuncu" }],
      },
      {
        id: 11,
        media_type: "movie",
        status: "completed",
        personal_rating: 2,
        cast: [{ id: 301, name: "Sevilmeyen Oyuncu" }],
      },
      {
        id: 12,
        media_type: "movie",
        status: "completed",
        personal_rating: 10,
        cast: [{ id: 302, name: "Sevilen Oyuncu" }],
      },
    ];

    const profile = buildTasteProfileV3(history);
    assert.ok(profile.actors[301].personal < 0);
    assert.ok(profile.actors[302].personal > 0);

    const candidate = {
      id: 501,
      media_type: "movie",
      title: "Karışık Kadro",
      cast: [{ id: 301, name: "Sevilmeyen Oyuncu" }, { id: 302, name: "Sevilen Oyuncu" }],
    };

    const [scored] = scoreCandidatesV3([candidate], profile);
    // Negatif oyuncu max(0, A(a)) nedeniyle eşleşme sinerjisi üretmez
    assert.equal(scored.parts.castHarmony, 0.5);
  });

  it("yapım şirketi franchise puanından çıkarılmıştır ve yalnızca koleksiyon %1 etki eder", () => {
    const history = [
      {
        id: 1,
        media_type: "movie",
        status: "completed",
        personal_rating: 10,
        belongs_to_collection: { id: 9999, name: "Efsane Seri" },
        production_companies: [{ id: 777, name: "Eski Şirket" }],
      },
    ];

    const profile = buildTasteProfileV3(history);

    const candidateOnlyCompany = {
      id: 2,
      media_type: "movie",
      title: "Aynı Şirket Başka Film",
      production_companies: [{ id: 777, name: "Eski Şirket" }],
    };

    const candidateWithFranchise = {
      id: 3,
      media_type: "movie",
      title: "Serinin Devam Filmi",
      belongs_to_collection: { id: 9999, name: "Efsane Seri" },
    };

    const [scoredCompany, scoredFranchise] = scoreCandidatesV3(
      [candidateOnlyCompany, candidateWithFranchise],
      profile
    );

    assert.equal(scoredCompany.parts.franchise, 0.5); // yapım şirketi artık franchise'ı tetiklemez
    assert.equal(scoredFranchise.parts.franchise, 1.0); // yalnızca seri/koleksiyon tetikler
    assert.ok(scoredFranchise.tags.includes("Sevdiğin film serisinden"));
  });
});

describe("findSavedItem", () => {
  const saved = [
    baseItem({ id: 550, media_type: "movie", title: "Dövüş Kulübü", status: "completed" }),
    baseItem({ id: 1399, media_type: "tv", title: "Game of Thrones", status: "watching" }),
  ];

  it("tam eşleşmede kaydı doğru bulur", () => {
    const item = { id: 550, media_type: "movie", title: "Dövüş Kulübü" };
    const found = findSavedItem(saved, item);
    assert.ok(found);
    assert.equal(found.id, 550);
    assert.equal(found.status, "completed");
  });

  it("sayı ve dize kimlik uyumsuzluğunda bile bulur", () => {
    const item = { id: "1399", media_type: "tv" };
    const found = findSavedItem(saved, item);
    assert.ok(found);
    assert.equal(found.id, 1399);
    assert.equal(found.status, "watching");
  });

  it("media_type eksikse ve kimlik tekilse yine bulur", () => {
    const item = { id: 550 };
    const found = findSavedItem(saved, item);
    assert.ok(found);
    assert.equal(found.id, 550);
  });

  it("başlık eşleşmesiyle bulur", () => {
    const item = { id: 99999, title: "Dövüş Kulübü" };
    const found = findSavedItem(saved, item);
    assert.ok(found);
    assert.equal(found.id, 550);
  });

  it("listede yoksa undefined döner", () => {
    const item = { id: 404, title: "Bilinmeyen Film" };
    assert.equal(findSavedItem(saved, item), undefined);
    assert.equal(findSavedItem(null, item), undefined);
  });
});

describe("scoreActorRecommendations", () => {
  const favoriteActors = [
    { id: 2037, name: "Cillian Murphy" },
    { id: 934, name: "Rebecca Ferguson" },
  ];

  const actorCreditsMap = {
    2037: [
      {
        id: 872585,
        title: "Oppenheimer",
        media_type: "movie",
        genre_ids: [18, 36], // Drama, History
        vote_average: 8.1,
        vote_count: 9000,
        release_date: "2023-07-19",
        popularity: 120,
        order: 0,
      },
      {
        id: 1399,
        title: "Dunkirk",
        media_type: "movie",
        genre_ids: [18, 10752], // Drama, War
        vote_average: 7.5,
        vote_count: 14000,
        release_date: "2017-07-19",
        popularity: 80,
        order: 4,
      },
      {
        id: 693134,
        title: "Dune: Part Two",
        media_type: "movie",
        genre_ids: [878, 12], // Sci-Fi, Adventure
        vote_average: 8.2,
        vote_count: 5500,
        release_date: "2024-02-27",
        popularity: 150,
        order: 5,
      },
    ],
    934: [
      {
        id: 693134, // Dune: Part Two shares both Rebecca Ferguson and Cillian (for testing multi-actor)
        title: "Dune: Part Two",
        media_type: "movie",
        genre_ids: [878, 12],
        vote_average: 8.2,
        vote_count: 5500,
        release_date: "2024-02-27",
        popularity: 150,
        order: 3,
      },
      {
        id: 575264,
        title: "Mission: Impossible - Dead Reckoning",
        media_type: "movie",
        genre_ids: [28, 53],
        vote_average: 7.6,
        vote_count: 3500,
        release_date: "2023-07-08",
        popularity: 90,
        order: 2,
      },
    ],
  };

  const genresMap = {
    18: "Dram",
    36: "Tarih",
    878: "Bilim Kurgu",
    12: "Macera",
    28: "Aksiyon",
    53: "Gerilim",
  };

  it("kullanıcının zaten izlediği veya kaydettiği yapımları eler", () => {
    const savedItems = [
      { id: 1399, media_type: "movie", title: "Dunkirk", status: "completed" },
    ];
    const recs = scoreActorRecommendations({
      favoriteActors,
      actorCreditsMap,
      savedItems,
      genresMap,
    });
    const ids = recs.map((r) => r.id);
    assert.ok(!ids.includes(1399), "Dunkirk listeden elenmiş olmalı");
    assert.ok(ids.includes(872585), "Oppenheimer listede olmalı");
    assert.ok(ids.includes(693134), "Dune: Part Two listede olmalı");
  });

  it("aynı filmde birden fazla favori oyuncu varsa tek karta indirir ve +10 bonus verir", () => {
    const recs = scoreActorRecommendations({
      favoriteActors,
      actorCreditsMap,
      savedItems: [],
      genresMap,
    });
    const dune = recs.find((r) => r.id === 693134);
    assert.ok(dune, "Dune bulunmalı");
    assert.equal(dune.matchedActors.length, 2, "2 favori oyuncu eşleşmeli");
    assert.ok(
      dune.matchedActors.some((a) => a.name === "Cillian Murphy") &&
      dune.matchedActors.some((a) => a.name === "Rebecca Ferguson"),
      "Her iki oyuncu da matchedActors içinde olmalı"
    );
    assert.ok(dune.reason.includes("Cillian Murphy") && dune.reason.includes("Rebecca Ferguson"));
  });

  it("kullanıcının ilgilenmediği yapımları (disliked) eler", () => {
    const recs = scoreActorRecommendations({
      favoriteActors,
      actorCreditsMap,
      savedItems: [],
      dislikedKeys: ["movie-872585"],
      genresMap,
    });
    const ids = recs.map((r) => r.id);
    assert.ok(!ids.includes(872585), "Disliked olan Oppenheimer elenmeli");
  });

  it("sıralama modlarını (best_match ve newest) doğru uygular", () => {
    const recsBest = scoreActorRecommendations({
      favoriteActors,
      actorCreditsMap,
      savedItems: [],
      genresMap,
      sortMode: "best_match",
    });
    assert.ok(recsBest[0].matchScore >= recsBest[recsBest.length - 1].matchScore);

    const recsNewest = scoreActorRecommendations({
      favoriteActors,
      actorCreditsMap,
      savedItems: [],
      genresMap,
      sortMode: "newest",
    });
    assert.ok(recsNewest[0].release_date >= recsNewest[recsNewest.length - 1].release_date);
  });

  it("oyuncu listesi boşsa boş dizi döner", () => {
    const recs = scoreActorRecommendations({
      favoriteActors: [],
      actorCreditsMap,
    });
    assert.deepEqual(recs, []);
  });

  it("TMDB kadro sırasına (order) göre başrol ve yardımcı rolleri farklı puanlar", () => {
    assert.equal(calculateActorRoleBonus(0).bonus, 12);
    assert.equal(calculateActorRoleBonus(0).label, "1. Başrol (#1)");
    assert.equal(calculateActorRoleBonus(1).bonus, 10);
    assert.equal(calculateActorRoleBonus(4).bonus, 7);
    assert.equal(calculateActorRoleBonus(8).bonus, 4);
    assert.equal(calculateActorRoleBonus(20).bonus, 1);
    assert.equal(calculateActorRoleBonus(undefined).bonus, 3);

    const recs = scoreActorRecommendations({
      favoriteActors,
      actorCreditsMap,
      savedItems: [],
      genresMap,
      enableDiversity: false,
    });
    const oppenheimer = recs.find((r) => r.id === 872585); // order 0
    const deadReckoning = recs.find((r) => r.id === 575264); // order 2
    assert.equal(oppenheimer.signalBreakdown.actorPresence, 18 + 12); // 30
    assert.equal(oppenheimer.signalBreakdown.actorRoleText, "1. Başrol (#1)");
    assert.equal(deadReckoning.signalBreakdown.actorPresence, 18 + 10); // 28
  });

  it("platformScore sabitini kaldırır: doğrulanmışsa puan verir, bilinmiyorsa nötr (5) bırakır", () => {
    // 1) Bilinmeyen / doğrulanmamış platform -> nötr 5
    const recsUnknown = scoreActorRecommendations({
      favoriteActors,
      actorCreditsMap,
      savedItems: [],
      genresMap,
      providerIndex: {},
    });
    const oppUnk = recsUnknown.find((r) => r.id === 872585);
    assert.equal(oppUnk.signalBreakdown.platformScore, 5);
    assert.equal(oppUnk.signalBreakdown.platformVerified, false);

    // 2) Doğrulanmış platform verisi ve kullanıcının tercih ettiği sağlayıcı eşleşmesi -> 10
    const recsVerified = scoreActorRecommendations({
      favoriteActors,
      actorCreditsMap,
      savedItems: [],
      genresMap,
      preferredProviders: ["8"], // Netflix
      providerIndex: {
        "movie:872585": [{ id: "8", name: "Netflix" }],
        "movie:575264": [{ id: "337", name: "Disney+" }],
      },
    });
    const oppHit = recsVerified.find((r) => r.id === 872585);
    assert.equal(oppHit.signalBreakdown.platformScore, 10);
    assert.equal(oppHit.signalBreakdown.platformVerified, true);

    const drOther = recsVerified.find((r) => r.id === 575264);
    assert.equal(drOther.signalBreakdown.platformScore, 6); // Başka bir platformda izlenebilir
    assert.equal(drOther.signalBreakdown.platformVerified, true);
  });

  it("tasteScore'u kullanıcının gerçek 1-10 puanlarına ve tür/oyuncu benzerliğine bağlar", () => {
    // Kullanıcı dram ve Cillian Murphy'ye 10/10 puan vermiş
    const highUserSaved = [
      { id: 999, media_type: "movie", title: "Peaky Blinders", genre_ids: [18], personal_rating: 10, cast: [{ id: 2037 }] }
    ];
    const recsHigh = scoreActorRecommendations({
      favoriteActors,
      actorCreditsMap,
      savedItems: highUserSaved,
      genresMap,
    });
    const oppHigh = recsHigh.find((r) => r.id === 872585); // Dram (18) + Cillian (2037)
    assert.ok(oppHigh.signalBreakdown.tasteScore >= 13, "Yüksek puanlanan tür ve oyuncuda tasteScore yüksek olmalı");

    // Kullanıcı benzer türdeki yapımlara düşük (2/10) puan vermiş
    const lowUserSaved = [
      { id: 888, media_type: "movie", title: "Sıkıcı Dram", genre_ids: [18], personal_rating: 2 }
    ];
    const recsLow = scoreActorRecommendations({
      favoriteActors,
      actorCreditsMap,
      savedItems: lowUserSaved,
      genresMap,
    });
    const oppLow = recsLow.find((r) => r.id === 872585);
    assert.ok(oppLow.signalBreakdown.tasteScore <= 5, "Düşük puanlanan türde tasteScore düşük olmalı");
  });

  it("matchScore gerçek sinyallerden hesaplanır ve güven düzeyi ayrı üretilir", () => {
    const recs = scoreActorRecommendations({
      favoriteActors,
      actorCreditsMap,
      savedItems: [
        { id: 1, media_type: "movie", personal_rating: 9, genre_ids: [18] },
        { id: 2, media_type: "movie", personal_rating: 8, genre_ids: [36] },
      ],
      genresMap,
    });
    for (const item of recs) {
      assert.ok(item.matchScore >= 1 && item.matchScore <= 99);
      assert.ok(item.confidenceScore >= 0 && item.confidenceScore <= 100);
      assert.ok(["high", "medium", "low"].includes(item.confidenceLevel));
      assert.ok(item.signalBreakdown, "signalBreakdown alanı bulunmalı");
      assert.equal(typeof item.signalBreakdown.actorPresence, "number");
      assert.equal(typeof item.signalBreakdown.tasteScore, "number");
      assert.equal(typeof item.signalBreakdown.platformScore, "number");
    }
  });

  it("favori oyuncu sonuçlarında çeşitlilik (diversity) uygulayarak tek tür yığılmasını azaltır", () => {
    const items = [
      { id: 1, genre_ids: [18], matchScore: 95 },
      { id: 2, genre_ids: [18], matchScore: 94 },
      { id: 3, genre_ids: [18], matchScore: 93 },
      { id: 4, genre_ids: [18], matchScore: 92 },
      { id: 5, genre_ids: [878], matchScore: 90 },
      { id: 6, genre_ids: [28], matchScore: 89 },
    ];
    const diversified = diversifyActorRecommendations(items, { maxPerGenre: 2, limit: 10 });
    // İlk 3 eleman içinde 18 türünden en fazla 2 tane olmalı, 878 öne çekilmeli
    const top3Genres = diversified.slice(0, 3).map((it) => it.genre_ids[0]);
    assert.equal(top3Genres.filter((g) => g === 18).length, 2);
    assert.ok(top3Genres.includes(878), "Farklı tür (878) çeşitlilik sayesinde öne çıkmalı");
  });
});

describe("Sana Özel Aşama 1 — Tür Filtresi, makeMediaKey ve Güvenli Eşleşme", () => {
  it("hedef öneri sayısı TARGET_RECOMMENDATION_COUNT = 20'dir", () => {
    assert.equal(TARGET_RECOMMENDATION_COUNT, 20);
  });

  it("aynı sayısal kimlikli film ve diziyi makeMediaKey ile birbirinden ayırır", () => {
    const movieKey = makeMediaKey("movie", 1399);
    const tvKey = makeMediaKey("tv", 1399);
    assert.equal(movieKey, "movie:1399");
    assert.equal(tvKey, "tv:1399");
    assert.notEqual(movieKey, tvKey, "Film ve dizi anahtarları farklı olmalı");
  });

  it("findSavedItem aynı sayısal kimlikli film ve diziyi birbirine karıştırmaz", () => {
    const saved = [
      baseItem({ id: 1399, media_type: "tv", name: "Game of Thrones", status: "watching" }),
    ];

    // Dizi olan 1399 aranırsa bulunmalı
    const tvResult = findSavedItem(saved, { id: 1399, media_type: "tv" });
    assert.ok(tvResult);
    assert.equal(tvResult.name, "Game of Thrones");

    // Film olan 1399 aranırsa bulunmamalı (yanlışlıkla diziyi film olarak döndürmemeli)
    const movieResult = findSavedItem(saved, { id: 1399, media_type: "movie", title: "Dunkirk" });
    assert.equal(movieResult, undefined, "Dizi kaydı film aramasına eşleşmemeli");
  });

  it("isItemSaved tür güvenli karşılaştırma yapar", () => {
    const saved = [
      baseItem({ id: 872585, media_type: "movie", title: "Oppenheimer", status: "completed" }),
    ];

    assert.equal(isItemSaved(saved, { id: 872585, media_type: "movie" }), true);
    assert.equal(isItemSaved(saved, { id: 872585, media_type: "tv" }), false);
    assert.equal(isItemSaved(saved, { id: 99999, media_type: "movie" }), false);
  });

  it("filterHistoryByType film istendiğinde dizileri, dizi istendiğinde filmleri eler", () => {
    const items = [
      baseItem({ id: 1, media_type: "movie", title: "Film 1" }),
      baseItem({ id: 2, media_type: "tv", title: "Dizi 2" }),
      baseItem({ id: 3, media_type: "movie", title: "Film 3" }),
    ];

    const movieOnly = filterHistoryByType(items, "movie");
    assert.equal(movieOnly.length, 2);
    assert.ok(movieOnly.every((i) => i.media_type === "movie"));

    const tvOnly = filterHistoryByType(items, "tv");
    assert.equal(tvOnly.length, 1);
    assert.ok(tvOnly.every((i) => i.media_type === "tv"));

    const all = filterHistoryByType(items, "all");
    assert.equal(all.length, 3);
  });

  it("filterDislikedByType tür bazlı olumsuz sinyalleri filtreler", () => {
    const disliked = ["movie:100", "tv:200", "movie:300"];
    const movieDisliked = filterDislikedByType(disliked, "movie");
    assert.deepEqual(movieDisliked, ["movie:100", "movie:300"]);

    const tvDisliked = filterDislikedByType(disliked, "tv");
    assert.deepEqual(tvDisliked, ["tv:200"]);

    const allDisliked = filterDislikedByType(disliked, "all");
    assert.deepEqual(allDisliked, disliked);
  });

  it("createCandidatePool allowedMediaType filtresini aday kabulünde kesin uygular", () => {
    const pool = createCandidatePool({ allowedMediaType: "movie" });
    pool.add("test", "test reason", "movie", [
      { id: 1, media_type: "movie", title: "Movie 1" },
      { id: 2, media_type: "tv", name: "TV 2" },
      { id: 3, media_type: "movie", title: "Movie 3" },
    ]);
    assert.equal(pool.size, 2);
    const list = pool.list();
    assert.ok(list.every((item) => item.media_type === "movie"));
    assert.equal(list.some((item) => item.id === 2), false, "Dizi adayı havuzdan elenmiş olmalı");
  });
});

describe("Sana Özel Aşama 2 — 500 + 500 Yenilenebilir Aday Havuzu", () => {
  it("havuz kapasite sabitleri 500 hedef ve 250 alt eşik değerlerine sahiptir", () => {
    assert.equal(POOL_TARGET_CAPACITY, 500);
    assert.equal(POOL_LOW_WATERMARK, 250);
    assert.equal(POOL_REPLENISH_MIN_NEW, 250);
  });

  it("normalizePoolCandidate sınırlı veri modelini ve algoritma sinyallerini doğru oluşturur", () => {
    const rawMovie = {
      id: 550,
      title: "Fight Club",
      overview: "An insomniac office worker...",
      release_date: "1999-10-15",
      vote_average: 8.43,
      vote_count: 27000,
      popularity: 78.5,
      poster_path: "/bptfVGEQuv6vDTIMVCHjJ9Dz8PX.jpg",
      genre_ids: [18, 53],
    };

    const candidate = normalizePoolCandidate(rawMovie, "movie", "popular", "Popüler yapım", "completed");
    assert.ok(candidate);
    assert.equal(candidate.id, 550);
    assert.equal(candidate.media_type, "movie");
    assert.equal(candidate.title, "Fight Club");
    assert.equal(candidate.poolSource, "popular");
    assert.equal(candidate.poolSources, 1);
    assert.equal(candidate.seedSourceType, "completed");
    assert.equal(candidate.era, "classic"); // 1999 -> classic
    assert.equal(candidate.popularityTier, "high"); // pop 78.5 >= 50

    // Yanlış media_type adayı kabul edilmemeli
    const tvInMoviePool = normalizePoolCandidate({ id: 100, media_type: "tv", name: "Dizi" }, "movie", "popular");
    assert.equal(tvInMoviePool, null);
  });

  it("determineItemEra ve determineItemPopularityTier dönem ve popülerlik boyutlarını sınıflandırır", () => {
    assert.equal(determineItemEra("2024-05-01"), "new");
    assert.equal(determineItemEra("2018-07-20"), "modern");
    assert.equal(determineItemEra("2005-11-10"), "retro");
    assert.equal(determineItemEra("1994-09-22"), "classic");
    assert.equal(determineItemEra(""), "modern");

    assert.equal(determineItemPopularityTier(60, 7.5), "high");
    assert.equal(determineItemPopularityTier(25, 7.0), "medium");
    assert.equal(determineItemPopularityTier(5, 8.2), "indie"); // Düşük popülerlik + yüksek puan
    assert.equal(determineItemPopularityTier(5, 5.0), "low");
  });

  it("isCandidateEligibleInPool beş durumun tamamını (izledim, izleyeceğim, izliyorum, ilgilenmiyorum, gizle) denetler", () => {
    const saved = [
      baseItem({ id: 1, media_type: "movie", status: "completed" }),
      baseItem({ id: 2, media_type: "movie", status: "watchlist" }),
      baseItem({ id: 3, media_type: "movie", status: "watching" }),
    ];
    const prefs = {
      disliked: ["movie:4"],
      hidden: ["movie:5"],
    };

    // 1. Durum: izledim (completed) -> elenmeli
    assert.equal(isCandidateEligibleInPool({ id: 1, media_type: "movie" }, saved, prefs), false);

    // 2. Durum: izleyeceğim (watchlist) -> elenmeli
    assert.equal(isCandidateEligibleInPool({ id: 2, media_type: "movie" }, saved, prefs), false);

    // 3. Durum: izliyorum (watching) -> elenmeli
    assert.equal(isCandidateEligibleInPool({ id: 3, media_type: "movie" }, saved, prefs), false);

    // 4. Durum: ilgilenmiyorum (disliked) -> elenmeli
    assert.equal(isCandidateEligibleInPool({ id: 4, media_type: "movie" }, saved, prefs), false);

    // 5. Durum: gizle (hidden) -> elenmeli
    assert.equal(isCandidateEligibleInPool({ id: 5, media_type: "movie" }, saved, prefs), false);

    // Temiz aday -> uygun olmalı
    assert.equal(isCandidateEligibleInPool({ id: 99, media_type: "movie" }, saved, prefs), true);

    // Aynı sayısal kimlikli dizi, film kayıtlarından etkilenmemeli
    assert.equal(isCandidateEligibleInPool({ id: 1, media_type: "tv" }, saved, prefs), true);
  });

  it("filterEligiblePoolItems listeden tüm uygunsuz adayları ayıklar", () => {
    const items = [
      { id: 1, media_type: "movie" },
      { id: 2, media_type: "movie" },
      { id: 3, media_type: "movie" },
    ];
    const saved = [baseItem({ id: 1, media_type: "movie", status: "completed" })];
    const prefs = { disliked: ["movie:2"], hidden: [] };

    const eligible = filterEligiblePoolItems(items, saved, prefs);
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].id, 3);
  });

  it("balanceCandidatePool tür tavanlarını (%25) uygulayarak çok boyutlu denge kurar", () => {
    // 600 elemanlı havuz: 400 tanesi aynı türden (18 - dram)
    const items = [];
    for (let i = 1; i <= 400; i++) {
      items.push({
        id: i,
        media_type: "movie",
        genre_ids: [18],
        vote_average: 8.0,
        popularity: 50,
        era: "modern",
        popularityTier: "high",
        poolSources: 1,
      });
    }
    for (let i = 401; i <= 600; i++) {
      items.push({
        id: i,
        media_type: "movie",
        genre_ids: [28], // Aksiyon
        vote_average: 8.0,
        popularity: 50,
        era: "modern",
        popularityTier: "high",
        poolSources: 1,
      });
    }

    const balanced = balanceCandidatePool(items, 500);
    assert.equal(balanced.length, 500);

    // 500'lük havuzda 18 türü tavanı Math.ceil(500 * 0.25) = 125 olmalıdır (1. geçişte)
    // 2. geçişte kalan boşluklar tamamlanır fakat tek tür monopolisi kırılır
    const genre18Count = balanced.filter((it) => it.genre_ids[0] === 18).length;
    const genre28Count = balanced.filter((it) => it.genre_ids[0] === 28).length;
    assert.ok(genre28Count === 200, "Diğer türden (28) tüm uygun adaylar havuza alınmış olmalı");
    assert.ok(genre18Count === 300, "Kalan kontenjan 18 türüyle tamamlanmış olmalı");
  });

  it("PoolReplenishmentLock aynı anahtar için eşzamanlı yenilemeleri tekilleştirir", async () => {
    const lock = new PoolReplenishmentLock();
    let counter = 0;

    const task = async () => {
      await new Promise((res) => setTimeout(res, 20));
      counter += 1;
      return counter;
    };

    // Aynı profile ve türe 3 eşzamanlı çağrı
    const [r1, r2, r3] = await Promise.all([
      lock.acquire("profile-1:movie", task),
      lock.acquire("profile-1:movie", task),
      lock.acquire("profile-1:movie", task),
    ]);

    assert.equal(r1, 1);
    assert.equal(r2, 1);
    assert.equal(r3, 1);
    assert.equal(counter, 1, "Görev sadece 1 kere çalıştırılmalı ve promise paylaşılmalı");

    // Kilit serbest kalınca yeni çağrı çalışmalı
    assert.equal(lock.isLocked("profile-1:movie"), false);
    const r4 = await lock.acquire("profile-1:movie", task);
    assert.equal(r4, 2);
  });

  it("multiDimensionalDiversify tür, dönem ve popülerlik kotalarını gözeterek 20 adayı dengeli seçer", () => {
    const scored = [];
    // 50 aday üret
    for (let i = 1; i <= 50; i++) {
      scored.push({
        score: 100 - i,
        candidate: {
          id: i,
          media_type: "movie",
          genre_ids: [i <= 20 ? 18 : i <= 35 ? 28 : 878], // 20 Dram, 15 Aksiyon, 15 Bilimkurgu
          era: i <= 10 ? "classic" : i <= 25 ? "modern" : "new",
          popularityTier: i <= 15 ? "high" : "indie",
        },
      });
    }

    const picked = multiDimensionalDiversify(scored, {
      limit: 20,
      maxPerGenre: 5,
      maxPerEra: 8,
      maxPerTier: 10,
    });

    assert.equal(picked.length, 20, "Hedef 20 adayı seçmeli");
    const genreCounts = {};
    picked.forEach((p) => {
      const g = p.candidate.genre_ids[0];
      genreCounts[g] = (genreCounts[g] || 0) + 1;
    });

    // Tek bir tür 20 sonucun tamamını ele geçirememeli (çeşitlendirilmiş olmalı)
    assert.ok(genreCounts[18] <= 8, "Dram türü çeşitlilik kotalarıyla dengelenmeli");
    assert.ok(genreCounts[28] >= 1, "Aksiyon türü dahil edilmiş olmalı");
    assert.ok(genreCounts[878] >= 1, "Bilimkurgu türü dahil edilmiş olmalı");
  });

  it("replenishCandidatePool kaynakları sayfalar, imleçleri günceller ve havuzu tamamlar", async () => {
    const calledPaths = [];
    const mockFetch = async (path, params) => {
      calledPaths.push({ path, page: params?.page });
      return {
        results: [
          { id: Math.floor(Math.random() * 100000) + 1, title: `Mock Movie ${params?.page}`, vote_average: 7.5, popularity: 40 },
          { id: Math.floor(Math.random() * 100000) + 1, title: `Mock Movie ${params?.page} B`, vote_average: 8.0, popularity: 60 },
        ],
      };
    };

    const pool = await replenishCandidatePool({
      profileId: "test-profile-1",
      mediaType: "movie",
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
      favoriteActors: [{ id: 101, name: "Test Actor" }],
      fetchTmdbFn: mockFetch,
      force: true,
    });

    assert.equal(pool.mediaType, "movie");
    assert.ok(Array.isArray(pool.items));
    assert.ok(pool.cursors.popular > 1, "Popüler imleci ilerletilmiş olmalı");
    assert.ok(pool.cursors.top_rated > 1, "Top rated imleci ilerletilmiş olmalı");
    assert.ok(pool.cursors.recent > 1, "Recent imleci ilerletilmiş olmalı");
    assert.ok(calledPaths.some((p) => p.path === "/movie/popular"));
    assert.ok(calledPaths.some((p) => p.path === "/movie/top_rated"));
    assert.ok(calledPaths.some((p) => p.path === "/movie/now_playing"));
  });

  it("Sorun A düzeltmesi: havuz 250 adayın üzerindeyse (örn. 251) force=false iken istek atmadan erken döner", async () => {
    const memory = new Map();
    globalThis.localStorage = {
      getItem: (k) => memory.get(k) || null,
      setItem: (k, v) => memory.set(k, String(v)),
      removeItem: (k) => memory.delete(k),
      clear: () => memory.clear(),
    };

    // 251 adet geçerli aday içeren havuz hazırla
    const sampleItems = Array.from({ length: 251 }, (_, i) => ({
      id: 1000 + i,
      media_type: "movie",
      title: `Existing Movie ${i}`,
      genre_ids: [28],
      vote_average: 7.5,
      popularity: 30,
      era: "modern",
      popularityTier: "medium",
      poolSources: 1,
    }));

    savePersistentPoolData("profile-threshold-test", {
      mediaType: "movie",
      updatedAt: new Date().toISOString(),
      items: sampleItems,
      cursors: { popular: 3, top_rated: 2, recent: 2, exploration: 1, genre_discover: {}, similar: {}, person_credits: {} },
    });

    let fetchCalled = false;
    const mockFetch = async () => {
      fetchCalled = true;
      return { results: [] };
    };

    const result = await replenishCandidatePool({
      profileId: "profile-threshold-test",
      mediaType: "movie",
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
      fetchTmdbFn: mockFetch,
      force: false,
    });

    assert.equal(fetchCalled, false, "Havuz 250'nin üstündeyken TMDB isteği atılmamalı");
    assert.equal(result.items.length, 251);
  });

  it("Sorun A düzeltmesi: havuz 250 veya altındaysa yenileme tetiklenir ve 500 hedefine doğru doldurulur", async () => {
    const memory = new Map();
    globalThis.localStorage = {
      getItem: (k) => memory.get(k) || null,
      setItem: (k, v) => memory.set(k, String(v)),
      removeItem: (k) => memory.delete(k),
      clear: () => memory.clear(),
    };

    // 250 adet aday (alt eşik)
    const sampleItems = Array.from({ length: 250 }, (_, i) => ({
      id: 2000 + i,
      media_type: "movie",
      title: `Existing Movie ${i}`,
      genre_ids: [28],
      vote_average: 7.5,
      popularity: 30,
      era: "modern",
      popularityTier: "medium",
      poolSources: 1,
    }));

    savePersistentPoolData("profile-low-test", {
      mediaType: "movie",
      updatedAt: new Date().toISOString(),
      items: sampleItems,
      cursors: { popular: 1, top_rated: 1, recent: 1, exploration: 1, genre_discover: {}, similar: {}, person_credits: {} },
    });

    let fetchCallCount = 0;
    let nextId = 9000;
    const mockFetch = async (path, params) => {
      fetchCallCount++;
      return {
        results: Array.from({ length: 20 }, () => ({
          id: nextId++,
          title: `Fetched Movie ${nextId}`,
          vote_average: 7.8,
          popularity: 45,
          genre_ids: [18],
        })),
      };
    };

    const result = await replenishCandidatePool({
      profileId: "profile-low-test",
      mediaType: "movie",
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
      fetchTmdbFn: mockFetch,
      force: false,
    });

    assert.ok(fetchCallCount > 0, "Havuz <= 250 iken yenileme tetiklenmeli");
    assert.equal(result.items.length, 500, "Havuz 500 hedefine tamamlanmalı");
  });

  it("hatalı sayfaların imleci ilerletilmez ve sonraki çağrıda tekrar denenir", async () => {
    const memory = new Map();
    globalThis.localStorage = {
      getItem: (k) => memory.get(k) || null,
      setItem: (k, v) => memory.set(k, String(v)),
      removeItem: (k) => memory.delete(k),
      clear: () => memory.clear(),
    };

    savePersistentPoolData("profile-error-test", {
      mediaType: "movie",
      updatedAt: new Date().toISOString(),
      items: [],
      cursors: { popular: 5, top_rated: 1, recent: 1, exploration: 1, genre_discover: {}, similar: {}, person_credits: {} },
    });

    // /movie/popular isteği hata fırlatıyor
    const mockFetch = async (path, params) => {
      if (path === "/movie/popular") {
        throw new Error("TMDB network timeout");
      }
      return {
        results: [
          { id: Math.floor(Math.random() * 100000) + 1, title: "Test", vote_average: 7, popularity: 20, genre_ids: [28] }
        ],
      };
    };

    const result = await replenishCandidatePool({
      profileId: "profile-error-test",
      mediaType: "movie",
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
      fetchTmdbFn: mockFetch,
      force: true,
    });

    // popular başarısız olduğu için imleci 5 olarak kalmalı, 6'ya atlamamalı
    assert.equal(result.cursors.popular, 5, "Hatalı sayfanın imleci ilerletilmemeli, sonraki deneme için korunmalı");
    // Başarılı olan top_rated ilerletilmiş olmalı
    assert.ok(result.cursors.top_rated > 1, "Başarılı kaynağın imleci ilerletilmeli");
  });

  it("tekilleştirme (deduplication) aynı adayları birleştirir ve poolSources artırır", async () => {
    const memory = new Map();
    globalThis.localStorage = {
      getItem: (k) => memory.get(k) || null,
      setItem: (k, v) => memory.set(k, String(v)),
      removeItem: (k) => memory.delete(k),
      clear: () => memory.clear(),
    };

    const sharedId = 445566;
    const mockFetch = async (path) => ({
      results: [
        { id: sharedId, title: "Ortak Film", vote_average: 8.2, popularity: 50, genre_ids: [18] }
      ],
    });

    const result = await replenishCandidatePool({
      profileId: "profile-dedup-test",
      mediaType: "movie",
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
      fetchTmdbFn: mockFetch,
      force: true,
    });

    const matches = result.items.filter((it) => it.id === sharedId);
    assert.equal(matches.length, 1, "Aynı kimlikli aday havuza yalnızca bir kez eklenmeli");
    assert.ok(matches[0].poolSources > 1, "Birden fazla kaynaktan gelen adayın poolSources değeri artmalı");
  });
});

describe("Sorun B — Tüm İçerikler modunda 10 Film + 10 Dizi Garantisi ve Bağımsız Sıralama", () => {
  const makeCandidate = (id, media_type, score, genreId = 28, era = "modern", tier = "medium") => ({
    candidate: {
      id,
      media_type,
      title: media_type === "movie" ? `Film ${id}` : undefined,
      name: media_type === "tv" ? `Dizi ${id}` : undefined,
      genre_ids: [genreId],
      era,
      popularityTier: tier,
      vote_average: 7.5,
      popularity: 50,
    },
    score,
    tags: [`${media_type} etiketi`],
    parts: {},
  });

  it("'all' modunda dengeli havuzlarda tam olarak 10 film ve 10 dizi seçilir (20 toplam)", () => {
    // 25 film ve 25 dizi
    const movies = Array.from({ length: 25 }, (_, i) =>
      makeCandidate(100 + i, "movie", 95 - i, 28 + (i % 5))
    );
    const tvs = Array.from({ length: 25 }, (_, i) =>
      makeCandidate(200 + i, "tv", 90 - i, 18 + (i % 5))
    );

    const result = selectBalancedRecommendations({
      targetType: "all",
      scoredMovies: movies,
      scoredTv: tvs,
      targetTotal: 20,
      minPerTypeInAll: 10,
    });

    assert.equal(result.totalCount, 20);
    assert.equal(result.movieCount, 10, "Kesinlikle 10 film seçilmeli");
    assert.equal(result.tvCount, 10, "Kesinlikle 10 dizi seçilmeli");
    assert.equal(result.hasShortfall, false);

    const movieItems = result.items.filter((e) => (e.candidate || e).media_type === "movie");
    const tvItems = result.items.filter((e) => (e.candidate || e).media_type === "tv");
    assert.equal(movieItems.length, 10);
    assert.equal(tvItems.length, 10);
    assert.ok(result.explanation.includes("10 film ve 10 dizi olmak üzere toplam 20 içerik"));
  });

  it("diziler 10'un altındaysa (ör. 6 dizi), filmlerle sessizce doldurulmaz; gerçek sayı raporlanır", () => {
    const movies = Array.from({ length: 30 }, (_, i) =>
      makeCandidate(100 + i, "movie", 95 - i, 28)
    );
    // Yalnızca 6 dizi var
    const tvs = Array.from({ length: 6 }, (_, i) =>
      makeCandidate(200 + i, "tv", 85 - i, 18)
    );

    const result = selectBalancedRecommendations({
      targetType: "all",
      scoredMovies: movies,
      scoredTv: tvs,
      targetTotal: 20,
      minPerTypeInAll: 10,
    });

    // Kesin kural: 6 dizi varken eksik 4 dizi için 14 film alınmaz!
    assert.equal(result.movieCount, 10, "Film sayısı 10'u aşarak diğer türün yerini sessizce doldurmamalı");
    assert.equal(result.tvCount, 6, "Gerçek dizi sayısı korunmalı");
    assert.equal(result.totalCount, 16, "Toplam sonuç 16 olmalı (10 film + 6 dizi)");
    assert.equal(result.hasShortfall, true);
    assert.equal(result.shortfallType, "tv");
    assert.ok(result.explanation.includes("10 film ve 6 dizi olmak üzere toplam 16 içerik"));
    assert.ok(result.explanation.includes("dizi havuzunda uygun aday sayısı sınırlı kalmıştır"));
  });

  it("filmler 10'un altındaysa (ör. 4 film), dizilerle sessizce doldurulmaz; gerçek sayı raporlanır", () => {
    // Yalnızca 4 film var
    const movies = Array.from({ length: 4 }, (_, i) =>
      makeCandidate(100 + i, "movie", 90 - i, 28)
    );
    const tvs = Array.from({ length: 30 }, (_, i) =>
      makeCandidate(200 + i, "tv", 85 - i, 18)
    );

    const result = selectBalancedRecommendations({
      targetType: "all",
      scoredMovies: movies,
      scoredTv: tvs,
      targetTotal: 20,
      minPerTypeInAll: 10,
    });

    assert.equal(result.movieCount, 4, "Gerçek film sayısı korunmalı");
    assert.equal(result.tvCount, 10, "Dizi sayısı 10'u aşarak filmlerin yerini doldurmamalı");
    assert.equal(result.totalCount, 14, "Toplam sonuç 14 olmalı (4 film + 10 dizi)");
    assert.equal(result.hasShortfall, true);
    assert.equal(result.shortfallType, "movie");
    assert.ok(result.explanation.includes("4 film ve 10 dizi olmak üzere toplam 14 içerik"));
    assert.ok(result.explanation.includes("film havuzunda uygun aday sayısı sınırlı kalmıştır"));
  });

  it("'movie' modunda kesinlikle 20 film seçilir ve asla dizi dahil edilmez", () => {
    const movies = Array.from({ length: 25 }, (_, i) =>
      makeCandidate(100 + i, "movie", 90 - i, 28 + (i % 4))
    );
    const tvs = Array.from({ length: 15 }, (_, i) =>
      makeCandidate(200 + i, "tv", 99, 18)
    );

    const result = selectBalancedRecommendations({
      targetType: "movie",
      scoredMovies: movies,
      scoredTv: tvs,
      targetTotal: 20,
    });

    assert.equal(result.movieCount, 20);
    assert.equal(result.tvCount, 0);
    assert.equal(result.totalCount, 20);
    const tvItems = result.items.filter((e) => (e.candidate || e).media_type === "tv");
    assert.equal(tvItems.length, 0, "Film modunda dizi sonucu olamaz");
    assert.ok(result.explanation.includes("20 film önerisi"));
  });

  it("'tv' modunda kesinlikle 20 dizi seçilir ve asla film dahil edilmez", () => {
    const movies = Array.from({ length: 15 }, (_, i) =>
      makeCandidate(100 + i, "movie", 99, 28)
    );
    const tvs = Array.from({ length: 25 }, (_, i) =>
      makeCandidate(200 + i, "tv", 90 - i, 18 + (i % 4))
    );

    const result = selectBalancedRecommendations({
      targetType: "tv",
      scoredMovies: movies,
      scoredTv: tvs,
      targetTotal: 20,
    });

    assert.equal(result.tvCount, 20);
    assert.equal(result.movieCount, 0);
    assert.equal(result.totalCount, 20);
    const movieItems = result.items.filter((e) => (e.candidate || e).media_type === "movie");
    assert.equal(movieItems.length, 0, "Dizi modunda film sonucu olamaz");
    assert.ok(result.explanation.includes("20 dizi önerisi"));
  });

  it("kısa listede 10'dan az olan grup, havuzun kalan adaylarından 10'a tamamlanır", () => {
    // Kısa listede sadece 8 film var
    const shortMovies = Array.from({ length: 8 }, (_, i) =>
      makeCandidate(100 + i, "movie", 90 - i, 28)
    );
    // Havuzda kalan 5 film daha var
    const remainingMovies = Array.from({ length: 5 }, (_, i) =>
      makeCandidate(150 + i, "movie", 70 - i, 878)
    );
    const tvs = Array.from({ length: 20 }, (_, i) =>
      makeCandidate(200 + i, "tv", 85 - i, 18)
    );

    const result = selectBalancedRecommendations({
      targetType: "all",
      scoredMovies: shortMovies,
      scoredTv: tvs,
      remainingMovies: remainingMovies,
      targetTotal: 20,
      minPerTypeInAll: 10,
    });

    assert.equal(result.movieCount, 10, "Kalan havuz adayları kullanılarak 10'a tamamlanmalı");
    assert.equal(result.tvCount, 10);
    assert.equal(result.totalCount, 20);
    assert.equal(result.hasShortfall, false);
  });
});

describe("Sorun C — Havuz Yenileme İsteği Yönetimi, Sınırlı İş Kuyruğu ve Kilit/İptal Ayrımı", () => {
  it("yarış senaryosu: ilk çağrının iptal sinyali (abort) kilidi paylaşan sonraki çağrıyı etkilemez", async () => {
    const memory = new Map();
    globalThis.localStorage = {
      getItem: (k) => memory.get(k) || null,
      setItem: (k, v) => memory.set(k, String(v)),
      removeItem: (k) => memory.delete(k),
      clear: () => memory.clear(),
    };

    savePersistentPoolData("profile-race-test", {
      mediaType: "movie",
      updatedAt: new Date().toISOString(),
      items: [],
      cursors: { popular: 1, top_rated: 1, recent: 1, exploration: 1, genre_discover: {}, similar: {}, person_credits: {} },
    });

    let nextId = 50000;
    const mockFetch = async (path, params) => {
      // Yapay gecikme: iptal sinyalinin yarışta tetiklenebilmesi için
      await new Promise((r) => setTimeout(r, 25));
      return {
        results: Array.from({ length: 20 }, () => ({
          id: nextId++,
          title: `Movie ${nextId}`,
          vote_average: 7.7,
          popularity: 40,
          genre_ids: [28],
        })),
      };
    };

    const controller1 = new AbortController();
    const controller2 = new AbortController();

    // 1. Çağıran istek başlatır
    const promise1 = replenishCandidatePool({
      profileId: "profile-race-test",
      mediaType: "movie",
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
      fetchTmdbFn: mockFetch,
      signal: controller1.signal,
      force: true,
      concurrency: 2,
    });

    // 2. Çağıran hemen ardından aynı kilide bağlanır
    const promise2 = replenishCandidatePool({
      profileId: "profile-race-test",
      mediaType: "movie",
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
      fetchTmdbFn: mockFetch,
      signal: controller2.signal,
      force: true,
      concurrency: 2,
    });

    // 1. Çağıran 10ms sonra isteği iptal eder (ör. kullanıcı kategori değiştirdi veya sekmeyi kapattı)
    setTimeout(() => {
      controller1.abort();
    }, 10);

    // 1. Çağıranın promise'i AbortError fırlatmalı
    let p1Error = null;
    try {
      await promise1;
    } catch (err) {
      p1Error = err;
    }
    assert.ok(p1Error, "1. çağıran iptal hatası almalı");
    assert.equal(p1Error.name, "AbortError");

    // 2. Çağıran ise İPTAL HATASI ALMAMALI, arka planda güvenle tamamlanan havuz verisini devralmalı!
    const result2 = await promise2;
    assert.ok(result2, "2. çağıran geçerli havuz sonucunu almalı");
    assert.equal(result2.mediaType, "movie");
    assert.ok(result2.items.length > 0, "Havuz başarıyla doldurulmuş olmalı");
  });

  it("sınırlı iş kuyruğu (bounded queue) eşzamanlı TMDB istek limitini aşmaz", async () => {
    let activeInFlight = 0;
    let maxInFlight = 0;

    const mockFetch = async (path, params) => {
      activeInFlight++;
      maxInFlight = Math.max(maxInFlight, activeInFlight);
      await new Promise((r) => setTimeout(r, 15));
      activeInFlight--;
      return {
        results: [
          { id: Math.floor(Math.random() * 100000) + 1, title: "Test", vote_average: 7.5, popularity: 30, genre_ids: [18] }
        ],
      };
    };

    const result = await replenishCandidatePool({
      profileId: "profile-concurrency-test",
      mediaType: "movie",
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
      fetchTmdbFn: mockFetch,
      force: true,
      concurrency: 3,
      maxTotalRequests: 12,
    });

    assert.ok(maxInFlight > 0, "İstekler çalıştırılmış olmalı");
    assert.ok(maxInFlight <= 3, `Eşzamanlı istek sayısı 3'ü aşmamalı, ölçülen: ${maxInFlight}`);
  });

  it("hata alan kaynak tekrar denenebilir (retryable) olarak kuyruğa alınır ve başarılı olunca imleç kesinleştirilir", async () => {
    let popularAttempt = 0;
    const mockFetch = async (path, params) => {
      if (path === "/movie/popular") {
        popularAttempt++;
        if (popularAttempt === 1) {
          // İlk denemede geçici hata
          throw new Error("Temporary network glitch");
        }
      }
      return {
        results: [
          { id: Math.floor(Math.random() * 100000) + 1, title: "Success Movie", vote_average: 8, popularity: 50, genre_ids: [28] }
        ],
      };
    };

    const result = await replenishCandidatePool({
      profileId: "profile-retry-test",
      mediaType: "movie",
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
      fetchTmdbFn: mockFetch,
      force: true,
      concurrency: 1,
      maxTotalRequests: 10,
    });

    assert.ok(popularAttempt >= 2, "Hata alan kaynak kuyruktan tekrar denenmiş olmalı");
    assert.ok(result.cursors.popular > 1, "Başarılı tekrar denemeden sonra imleç kesinleştirilmiş olmalı");
  });

  it("tüm denemeleri başarısız olan kaynağın imleci ilerletilmez, sonraki yenileme için korunur", async () => {
    const memory = new Map();
    globalThis.localStorage = {
      getItem: (k) => memory.get(k) || null,
      setItem: (k, v) => memory.set(k, String(v)),
      removeItem: (k) => memory.delete(k),
      clear: () => memory.clear(),
    };

    savePersistentPoolData("profile-exhaust-test", {
      mediaType: "movie",
      updatedAt: new Date().toISOString(),
      items: [],
      cursors: { popular: 7, top_rated: 1, recent: 1, exploration: 1, genre_discover: {}, similar: {}, person_credits: {} },
    });

    const mockFetch = async (path, params) => {
      if (path === "/movie/popular") {
        throw new Error("Persistent 500 error");
      }
      return {
        results: [
          { id: Math.floor(Math.random() * 100000) + 1, title: "Other Movie", vote_average: 7, popularity: 30, genre_ids: [35] }
        ],
      };
    };

    const result = await replenishCandidatePool({
      profileId: "profile-exhaust-test",
      mediaType: "movie",
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
      fetchTmdbFn: mockFetch,
      force: true,
      concurrency: 2,
      maxTotalRequests: 10,
    });

    // popular kaynağı her denemede hata aldığı için imleç 7'de kalmalı, kesinlikle 8 veya daha fazlaya ilerletilmemeli!
    assert.equal(result.cursors.popular, 7, "Tüm denemeleri başarısız olan kaynağın imleci korunmalı");
    assert.ok(result.cursors.top_rated > 1, "Başarılı kaynağın imleci ise güncellenmeli");
  });

  it("yeni havuz 250 yeni adayla (veya 500 kapasiteye) tamamlanana kadar sayfalamaya devam eder", async () => {
    let nextId = 80000;
    let pageCounter = 0;
    const mockFetch = async (path, params) => {
      pageCounter++;
      // Her sayfa 20 benzersiz aday döndürsün
      return {
        total_pages: 50,
        results: Array.from({ length: 20 }, () => ({
          id: nextId++,
          title: `Movie ${nextId}`,
          vote_average: 7.5,
          popularity: 45,
          genre_ids: [18],
        })),
      };
    };

    const result = await replenishCandidatePool({
      profileId: "profile-target-complete-test",
      mediaType: "movie",
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
      fetchTmdbFn: mockFetch,
      force: true,
      concurrency: 3,
      maxTotalRequests: 50,
    });

    assert.equal(result.items.length, 500, "Havuz 500 hedefine tamamlanmalı");
    assert.ok(pageCounter >= 13, "En az 250-500 aday toplayabilmek için yeterli sayfa çekilmiş olmalı");
  });
});

describe("Sorun D — Öneri Puanları, Kalıcı Zevk Haritası ve Halka Geriletmesi (Ring Demotion)", () => {
  it("assignTasteRing ve demoteTasteRing puan aralıklarına göre doğru halka atar ve basamak basamak geriletir", () => {
    assert.equal(assignTasteRing(95), "core");
    assert.equal(assignTasteRing(85), "core");
    assert.equal(assignTasteRing(84), "inner");
    assert.equal(assignTasteRing(70), "inner");
    assert.equal(assignTasteRing(69), "outer");
    assert.equal(assignTasteRing(55), "outer");
    assert.equal(assignTasteRing(54), "orbit");
    assert.equal(assignTasteRing(20), "orbit");

    // Geriletme adımları
    assert.equal(demoteTasteRing("core", 1), "inner");
    assert.equal(demoteTasteRing("core", 2), "outer");
    assert.equal(demoteTasteRing("core", 3), "orbit");
    assert.equal(demoteTasteRing("inner", 1), "outer");
    assert.equal(demoteTasteRing("outer", 1), "orbit");
    assert.equal(demoteTasteRing("orbit", 1), "orbit"); // En dış halkada kalır

    // getTasteRingLabel Türkçe etiketleri
    assert.equal(getTasteRingLabel("core"), "Çekirdek Halka (1. Halka)");
    assert.equal(getTasteRingLabel("inner"), "Yakın Halka (2. Halka)");
    assert.equal(getTasteRingLabel("outer"), "Dış Halka (3. Halka)");
    assert.equal(getTasteRingLabel("orbit"), "Yörünge (4. Halka)");
  });

  it("loadPersistentTasteMap ve savePersistentTasteMap profil bazlı localStorage ile güvenle saklar ve okur", () => {
    const memory = new Map();
    globalThis.localStorage = {
      getItem: (k) => memory.get(k) || null,
      setItem: (k, v) => memory.set(k, String(v)),
      removeItem: (k) => memory.delete(k),
      clear: () => memory.clear(),
    };

    const profileId = "prof_taste_42";
    const initialMap = loadPersistentTasteMap(profileId);
    assert.equal(initialMap.profileId, profileId);
    assert.deepEqual(initialMap.entries, {});
    assert.deepEqual(initialMap.lastRecommendedKeys, []);

    // Veri kaydet
    initialMap.entries["movie:101"] = {
      mediaKey: "movie:101",
      mediaType: "movie",
      id: 101,
      title: "Interstellar",
      matchScore: 92,
      rawScore: 92,
      ring: "core",
      initialRing: "core",
      parts: { genre: 0.9, actor: 0.8 },
      tags: ["Bilimkurgu"],
      shownCount: 1,
      skippedCount: 0,
      ringDemotions: 0,
      demotionPenalty: 0,
      lastShownAt: "2026-10-22T10:00:00.000Z",
      lastScoredAt: "2026-10-22T10:00:00.000Z",
      status: "active",
    };
    initialMap.lastRecommendedKeys = ["movie:101"];
    savePersistentTasteMap(profileId, initialMap);

    const loaded = loadPersistentTasteMap(profileId);
    assert.equal(loaded.entries["movie:101"].title, "Interstellar");
    assert.equal(loaded.entries["movie:101"].ring, "core");
    assert.equal(loaded.lastRecommendedKeys[0], "movie:101");
  });

  it("updateTasteMapWithBatch: ilk gösterimde (shownCount: 1, skippedCount: 0) kaydı oluşturur", () => {
    const tasteMap = createDefaultTasteMapData("profile_test");
    const candidates = [
      {
        candidate: { id: 501, media_type: "movie", title: "Film 501" },
        score: 88,
        rawScore: 88,
        parts: { genre: 0.8 },
        tags: ["Aksiyon"],
      },
      {
        candidate: { id: 601, media_type: "tv", name: "Dizi 601" },
        score: 72,
        rawScore: 72,
        parts: { genre: 0.7 },
        tags: ["Dram"],
      },
    ];

    const updated = updateTasteMapWithBatch({
      tasteMap,
      newRecommendedItems: candidates,
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
      now: "2026-10-22T12:00:00.000Z",
    });

    const m501 = updated.entries["movie:501"];
    assert.ok(m501, "movie:501 haritada bulunmalı");
    assert.equal(m501.shownCount, 1);
    assert.equal(m501.skippedCount, 0);
    assert.equal(m501.ring, "core");
    assert.equal(m501.matchScore, 88);
    assert.equal(m501.demotionPenalty, 0);

    const t601 = updated.entries["tv:601"];
    assert.ok(t601, "tv:601 haritada bulunmalı");
    assert.equal(t601.shownCount, 1);
    assert.equal(t601.skippedCount, 0);
    assert.equal(t601.ring, "inner");
    assert.equal(t601.matchScore, 72);
  });

  it("updateTasteMapWithBatch: pas geçilen (kaydedilmeyen) yapımlarda skippedCount artar ve halka geriletmesi uygulanır", () => {
    let tasteMap = createDefaultTasteMapData("profile_demote_test");
    const itemA = {
      candidate: { id: 701, media_type: "movie", title: "Aday A" },
      score: 90,
      rawScore: 90,
      parts: { genre: 0.9 },
      tags: ["Harika"],
    };
    const itemB = {
      candidate: { id: 702, media_type: "movie", title: "Aday B" },
      score: 86,
      rawScore: 86,
      parts: { genre: 0.85 },
      tags: ["Güzel"],
    };

    // 1. Gösterim: itemA ve itemB gösterildi
    tasteMap = updateTasteMapWithBatch({
      tasteMap,
      newRecommendedItems: [itemA, itemB],
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
      now: "2026-10-22T12:00:00.000Z",
    });
    assert.equal(tasteMap.entries["movie:701"].ring, "core");
    assert.equal(tasteMap.entries["movie:701"].skippedCount, 0);

    // 2. Yenileme: Kullanıcı hiçbirini kaydetmedi, yeni adaylar (itemC, itemD) gösterildi
    const itemC = { candidate: { id: 703, media_type: "movie", title: "Aday C" }, score: 85 };
    const itemD = { candidate: { id: 704, media_type: "movie", title: "Aday D" }, score: 84 };

    tasteMap = updateTasteMapWithBatch({
      tasteMap,
      newRecommendedItems: [itemC, itemD],
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
      now: "2026-10-22T12:05:00.000Z",
    });

    // 1. Atlamada skippedCount=1 olur, hafif ceza uygulanır (5 puan)
    assert.equal(tasteMap.entries["movie:701"].skippedCount, 1);
    assert.equal(tasteMap.entries["movie:701"].demotionPenalty, 5);
    assert.equal(tasteMap.entries["movie:701"].matchScore, 85); // 90 - 5 = 85
    assert.equal(tasteMap.entries["movie:701"].ring, "core"); // 2. atlamaya kadar ring henüz düşmez

    // 3. Yenileme: itemE ve itemF gösterildi, itemA ve itemB hâlâ seçilmedi
    // 2. Atlamada (skippedCount=2) Halka Geriletmesi TETİKLENİR! ('core' -> 'inner')
    const itemE = { candidate: { id: 705, media_type: "movie", title: "Aday E" }, score: 82 };
    tasteMap.lastRecommendedKeys = ["movie:701", "movie:702"]; // Simüle edilmiş önceki vitrin

    tasteMap = updateTasteMapWithBatch({
      tasteMap,
      newRecommendedItems: [itemE],
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
      now: "2026-10-22T12:10:00.000Z",
    });

    const demotedEntry = tasteMap.entries["movie:701"];
    assert.equal(demotedEntry.skippedCount, 2);
    assert.equal(demotedEntry.ringDemotions, 1, "Halka geriletmesi 1 kez gerçekleşmiş olmalı");
    assert.equal(demotedEntry.ring, "inner", "Çekirdek halkadan yakın halkaya (core -> inner) geriletilmeli");
    // Demotion ceza puanı: 2 atlama * 5 + 1 geriletme * 5 = 15
    assert.equal(demotedEntry.demotionPenalty, 15);
    assert.equal(demotedEntry.matchScore, 75); // 90 - 15 = 75
  });

  it("updateTasteMapWithBatch: kaydedilen (saved) yapımlarda atlandı sayacı ve ceza artırılmaz", () => {
    let tasteMap = createDefaultTasteMapData("profile_save_test");
    const itemA = {
      candidate: { id: 801, media_type: "movie", title: "Kaydedilecek Film" },
      score: 95,
      rawScore: 95,
    };

    // İlk gösterim
    tasteMap = updateTasteMapWithBatch({
      tasteMap,
      newRecommendedItems: [itemA],
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
    });

    // Kullanıcı bu yapımı izleneceklere ekledi!
    const saved = [baseItem({ id: 801, media_type: "movie", status: "watchlist" })];

    // Yeni öneri partisi geldi
    const itemB = { candidate: { id: 802, media_type: "movie", title: "Yeni Film" }, score: 80 };
    tasteMap = updateTasteMapWithBatch({
      tasteMap,
      newRecommendedItems: [itemB],
      savedItems: saved,
      preferences: { disliked: [], hidden: [], mood: "balanced" },
    });

    const entry = tasteMap.entries["movie:801"];
    assert.equal(entry.status, "saved");
    assert.equal(entry.skippedCount, 0, "Kaydedilen yapımın skippedCount değeri artmamalı");
    assert.equal(entry.demotionPenalty, 0, "Kaydedilen yapıma ceza verilmemeli");
  });

  it("updateTasteMapWithBatch: ilgilenmiyorum veya gizle durumunda olan yapımlar 'disliked'/'hidden' olarak işaretlenir", () => {
    let tasteMap = createDefaultTasteMapData("profile_dislike_test");
    const itemA = {
      candidate: { id: 901, media_type: "movie", title: "Sevilmeyen Film" },
      score: 85,
      rawScore: 85,
    };

    tasteMap = updateTasteMapWithBatch({
      tasteMap,
      newRecommendedItems: [itemA],
      savedItems: [],
      preferences: { disliked: [], hidden: [], mood: "balanced" },
    });

    // Kullanıcı ilgilenmiyorum olarak işaretledi
    const nextItem = { candidate: { id: 902, media_type: "movie", title: "Başka Film" }, score: 80 };
    tasteMap = updateTasteMapWithBatch({
      tasteMap,
      newRecommendedItems: [nextItem],
      savedItems: [],
      preferences: { disliked: ["movie:901"], hidden: [], mood: "balanced" },
    });

    assert.equal(tasteMap.entries["movie:901"].status, "disliked");
    assert.equal(tasteMap.entries["movie:901"].skippedCount, 0, "İlgilenilmeyen yapım atlandı olarak cezalandırılmaz");
  });

  it("scoreCandidatesV3: tasteMap demotion cezasını ve halka durumunu aday nesnesi üzerine entegre eder", () => {
    const tasteProfile = {
      genres: { "28": 0.8 },
      actors: {},
      directors: {},
      keywords: {},
      mediaPreference: { movie: 0.8, tv: 0.2 },
      lovedSeedIds: new Set(),
      lovedFranchiseIds: new Set(),
      lovedProductionCompanyIds: new Set(),
      lovedOverviewTokens: new Set(),
      positiveGenres: ["28"],
      coOccurredPairs: new Set(),
    };

    const candidateFresh = {
      id: 1001,
      media_type: "movie",
      title: "Taze Aday",
      genre_ids: [28],
      vote_average: 8.0,
      vote_count: 500,
      popularity: 30,
    };

    const candidateDemoted = {
      id: 1002,
      media_type: "movie",
      title: "Daha Önce 3 Kez Atlanmış Aday",
      genre_ids: [28],
      vote_average: 8.0,
      vote_count: 500,
      popularity: 30,
    };

    // Kalıcı zevk haritası oluştur: 1002 daha önce gösterilmiş ve 3 kez atlanmış (1 halka geriletmesi, 20 ceza puanı)
    const tasteMap = createDefaultTasteMapData("profile_score_test");
    tasteMap.entries["movie:1002"] = {
      mediaKey: "movie:1002",
      mediaType: "movie",
      id: 1002,
      title: "Daha Önce 3 Kez Atlanmış Aday",
      matchScore: 65,
      rawScore: 85,
      ring: "inner",
      initialRing: "core",
      parts: { genre: 0.8 },
      tags: [],
      shownCount: 3,
      skippedCount: 3,
      ringDemotions: 1,
      demotionPenalty: 20,
      lastShownAt: "2026-10-22T08:00:00.000Z",
      lastScoredAt: "2026-10-22T08:00:00.000Z",
      status: "active",
    };

    const scored = scoreCandidatesV3([candidateDemoted, candidateFresh], tasteProfile, { tasteMap });

    const freshScored = scored.find((s) => s.candidate.id === 1001);
    const demotedScored = scored.find((s) => s.candidate.id === 1002);

    assert.ok(freshScored.score > demotedScored.score, "Taze adayın net puanı atlanan adaydan yüksek olmalı");
    assert.equal(demotedScored.demotionPenalty, 20, "Atlanan adaya 20 puanlık geriletme cezası yansıtılmalı");
    assert.equal(demotedScored.ring, "inner", "Geriletilmiş halka durumu ('inner') korunmalı");
    assert.equal(demotedScored.candidate.ring, "inner", "Aday nesnesi üzerine ring yazılmalı");
    assert.equal(demotedScored.candidate.matchScore, demotedScored.score, "Aday nesnesi üzerine nihai matchScore yazılmalı");
  });

  it("syncPoolCandidatesWithTasteMap: aday havuzundaki öğeleri kalıcı zevk haritası ile senkronize eder", () => {
    const poolItems = [
      {
        id: 2001,
        media_type: "movie",
        title: "Havuz Filmi",
        genre_ids: [18],
        vote_average: 7.8,
        vote_count: 300,
        popularity: 25,
        poolSource: "popular",
        poolSources: 1,
        era: "modern",
        popularityTier: "medium",
      },
    ];

    const tasteMap = createDefaultTasteMapData("profile_sync_test");
    tasteMap.entries["movie:2001"] = {
      mediaKey: "movie:2001",
      mediaType: "movie",
      id: 2001,
      title: "Havuz Filmi",
      matchScore: 82,
      rawScore: 87,
      ring: "inner",
      initialRing: "core",
      parts: { genre: 0.8, quality: 0.75 },
      tags: ["Dram"],
      shownCount: 2,
      skippedCount: 1,
      ringDemotions: 0,
      demotionPenalty: 5,
      lastShownAt: "2026-10-22T09:00:00.000Z",
      lastScoredAt: "2026-10-22T09:00:00.000Z",
      status: "active",
    };

    const synced = syncPoolCandidatesWithTasteMap(poolItems, tasteMap);
    assert.equal(synced[0].matchScore, 82);
    assert.equal(synced[0].ring, "inner");
    assert.equal(synced[0].demotionPenalty, 5);
    assert.equal(synced[0].shownCount, 2);
    assert.equal(synced[0].skippedCount, 1);
  });
});




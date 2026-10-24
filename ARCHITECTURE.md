# CineTrack Mimari Belgesi (`ARCHITECTURE.md`)

Bu belge CineTrack uygulamasının modül sınırlarını, veri akışını, kalıcı depolama şemasını, önbellek ayrımını, migrasyon kurallarını ve güvenlik katmanlarını açıklar.

---

## 1. Modül Yapısı ve Sorumluluk Sınırları

### Çekirdek Katman (`src/core/`)
Tarayıcı DOM'undan ve Express sunucusundan bağımsız, saf ve deterministik iş mantığı modülleridir; hem istemci (Vite/React) hem de sunucu (Node.js) tarafından doğrudan kullanılır:

- `src/core/keys.ts`: Medya anahtarlarının (`movie:123`, `tv:456`) kanonikleştirilmesi, eski anahtarların (`movie-123`) dönüştürülmesi ve çakışan `TasteMapEntry` kayıtlarının geçmiş kaybı olmadan idempotent birleştirilmesi (`migratePersistentTasteMapData`).
- `src/core/cinetrack-core.ts`: Veri şeması doğrulama (`normalizeDataDocument`), 15 sinyalli `TasteProfileV3` ve `scoreCandidatesV3` öneri motoru, `ring0` / `ring1` / `ring2` yaşam döngüsü yönetimi, `500 + 500` bağımsız film/dizi aday havuzu (`replenishCandidatePool`) ve oyuncu filmografisi kuyruk yöneticisi (`fetchActorCreditsBatch`).
- `src/core/relationship-explorer.ts`: `relationship-v3` deterministik ilişki keşif grafiği (`universe`, `person`, `semantic`, `atmosphere`, `contrast`), profil ve havuz imzaları (`computeRelationshipProfileSignature`, `computeRelationshipPoolSignature`).
- `src/core/evaluation.ts`: Öneri motorunun ardışık yenilemelerde `ring1RepeatRate`, `ring0Utilization`, `genreEntropy` ve `typeBalanceAccuracy` metriklerini ölçen çevrimdışı değerlendirme çatısı (`evaluateRecommendationEngine`).
- `src/core/exporters.ts`: Zevk DNA analizi (`buildTasteDnaProfile`), Letterboxd/IMDb uyumlu CSV içe/dışa aktarma (`importItemsFromCsv`, `exportItemsToCsv`), RFC 5545 `.ics` yayın takvimi (`generateIcsCalendar`), iki profil arası izleme listesi kesişimi (`computeProfileWatchlistIntersection`) ve kronolojik izleme yolculuğu (`buildMediaJourneyTimeline`).

### Sunucu Katmanı (`server.ts` & `src/server/`)
- `server.ts`: Yerel (`CINETRACK_HOST = '127.0.0.1'`, port `3000`), sıfır zorunlu ortam değişkenli giriş noktası; `maxDataBytes = 2_000_000` sabitini kullanır. Geliştirme (`--dev` ile dinamik `await import('vite')`) ve üretim (`dist/` statik sunumu, `--omit=dev` uyumlu) modlarını çalıştırır.
- `src/server/app.ts`: Express uygulama fabrikası (`createCineTrackApp`), `413 Payload Too Large` ve `400 Invalid JSON` hata yakalayıcıları, `ETag` / `If-Match` revizyon uçları ve yedekleme rotaları (`/api/data/backups`, `/api/data/restore`).
- `src/server/storage.ts`: Atomik `.tmp` + `renameSync` yazma, monotonik `revision` sayacı, ani veri kaybı koruması (`sudden_item_drop` -> `409`), `cinetrack-data.bak.json` ve `data/backups/` altında son 7 döner anlık görüntü (snapshot) saklama.
- `src/server/security.ts`: Çapraz kaynak (`Origin` -> `403`) koruması; programatik veya isteğe bağlı ortam değişkeni verilmediği sürece devre dışı (no-op) kalan opsiyonel token/hız sınırı dalları.
- `src/server/tmdb-proxy.ts`: Katı `ALLOWED_TMDB_PATH` (`/tv/{id}/season/{n}` dahil) ve parametre doğrulaması, 500 girdili sunucu LRU önbelleği, ağ kesintilerinde bayat önbellek (`stale-cache`) geri dönüşü ve yerleşik demo kataloğu.

### İstemci Servis, Hook ve Arayüz Katmanı (`src/services/`, `src/hooks/`, `src/components/`)
- `src/services/api.ts`: İstemci TMDB önbelleği, uçuş hâlindeki (in-flight) istek tekilleştirme, çalışma zamanı TMDB yanıt şeması doğrulaması (`validateTmdbResponseShape`) ve `If-Match` revizyon takipli sunucu senkronizasyonu (istemci paketinde hiçbir `VITE_` sırrı taşınmaz).
- `src/services/relationship-cache.ts`: İlişki grafiği anlık görüntülerini `IndexedDB` (`cinetrack-relationship-cache`) üzerinde saklar.
- `src/services/offline-queue.ts` & `src/hooks/useOfflineSync.ts`: Çevrimdışı yapılan yerel değişiklikleri kuyruğa alır; bağlantı geri geldiğinde taban revizyonla (`baseRevision`) sunucuya iletir ve olası `409 Conflict` durumunda kullanıcıya seçim sunar (`ConflictBanner`).

---

## 2. Önbellek Ayrımı ve Veri İzolasyonu

CineTrack'te üç farklı önbellek katmanı birbirinin verisini asla değiştirmeyecek şekilde ayrılmıştır:

1. **Kalıcı Kullanıcı Kütüphanesi (`data/cinetrack-data.json` + `localStorage` profil anahtarları)**:
   - Kullanıcının izleme listesini, kişisel puanlarını, tercihlerini ve favori oyuncularını tutar.
2. **Zevk Haritası ve Aday Havuzu (`localStorage`: `cinetrack_taste_map_<profileId>`, `cinetrack_pool_<profileId>_<type>`)**:
   - Yalnızca *Sana Özel* öneri motorunun aday puanlarını, `shownCount`/`skippedCount` sayaçlarını, son 30 gösterim geçmişini (`impressionHistory`) ve `ring0`/`ring1`/`ring2` yaşam döngüsü durumunu tutar.
   - `cachedBalancedItems` içinde seçildiği andaki halka (`selectionRing: 'ring0' | 'ring2'`) korunur; böylece önbellekten okuma sırasında `ring2` yedek adayları yanlışlıkla `ring0` olarak etiketlenmez.
3. **İlişki Keşif Önbelleği (`IndexedDB`: `cinetrack-relationship-cache`)**:
   - `profileId`, `mode`, `mediaFilter`, `sourceKey`, `relationshipFilter`, `profileSignature`, `poolSignature` ve `RELATIONSHIP_MODEL_VERSION` (`relationship-v3`) bileşenlerinden oluşan anahtarlarla saklanır.
   - İlişki grafiği oluşturma veya önbellekten okuma işlemleri `PersistentTasteMapData` sayaçlarına veya `lastRecommendedKeys` listesine hiçbir şekilde yazmaz.

---

## 3. Anahtar Migrasyonu ve Geriye Dönük Uyumluluk

Eski sürümlerden kalan `movie-123` / `tv-456` biçimindeki anahtarlar yükleme sırasında `migratePersistentTasteMapData` ile kanonik `movie:123` / `tv:456` biçimine dönüştürülür:

- Hem `movie-123` hem `movie:123` aynı anda mevcutsa kayıtlar silinmez; `mergeTasteMapEntriesOnCollision` ile birleştirilir.
- Gösterim geçmişleri (`impressionHistory`) `shownAt|targetType` anahtarıyla tekilleştirilerek kronolojik sıralanır ve en son 30 kayıt korunur (`MAX_IMPRESSION_HISTORY_PER_ENTRY = 30`); taşan kısım `archivedImpressionCount` alanında muhafaza edilir.
- Sayaçlar körlemesine toplanmaz; tekilleştirilmiş gerçek gösterim geçmişi ve maksimum sayaç sınırı esas alınır.
- Aktif (`entries`) ve arşiv (`archivedEntries`) arasında çakışma varsa aktif kayıt korunur ve arşivdeki tarihsel gösterimler aktif kayda aktarılır.
- Migrasyon **idempotent**tir: ikinci kez çalıştırıldığında `changed: false` döner ve veriyi değiştirmez.

---

## 4. Yazma Güvenliği, Yedekleme ve Geri Alma (Rollback)

1. **İyimser Eşzamanlılık (`ETag` & `If-Match`)**:
   - `GET /api/data` yanıtı güncel `revision` numarasını ve `ETag: "rev-<n>"` başlığını döner.
   - `PUT /api/data` isteği `If-Match: "rev-<n>"` başlığıyla gönderilir; sunucudaki revizyon ilerlemişse yazma reddedilir (`409 Conflict`, `code: 'revision_conflict'`) ve güncel sunucu belgesi istemciye bildirilir.
2. **Ani Veri Azalması Koruması (`sudden_item_drop`)**:
   - Sunucuda en az 6 kayıtlı yapım varken gelen yazma isteği toplam öğe sayısını %50'den fazla düşürüyorsa ve açık onay (`X-CineTrack-Confirm-Drop: 1`) taşımıyorsa `409 Conflict` (`code: 'sudden_item_drop'`) ile durdurulur.
3. **Atomik Yazma ve Döner Snapshot'lar**:
   - Her başarılı yazmadan önce mevcut `cinetrack-data.json`, hem `cinetrack-data.bak.json` dosyasına hem de `data/backups/` dizinine zaman damgalı ve revizyon numaralı snapshot olarak kopyalanır (en son 7 snapshot tutulur).
   - Yeni veri önce aynı dizindeki geçici `.tmp` dosyasına yazılır, ardından `renameSync` ile atomik olarak hedefe taşınır.
   - Profil > Ayarlar > *Sunucu Yedekleri ve Geri Yükleme* bölümünden veya `POST /api/data/restore` ucuyla herhangi bir snapshot'a tek adımda geri dönülebilir.

---

## 5. PWA, Çevrimdışı Çalışma ve TMDB Koşulları

- **Service Worker (`vite-plugin-pwa` / Workbox)**:
  - Uygulama kabuğu (`js`, `css`, `html`, `svg`, `png`), yazı tipleri (`CacheFirst`), TMDB afiş görselleri (`StaleWhileRevalidate`, en fazla 200 görsel / 14 gün) ve `/api/tmdb` katalog yanıtları (`NetworkFirst`, 4 sn ağ zaman aşımı, en fazla 150 yanıt / 24 saat) önbelleklenir.
- **TMDB Kullanım Koşulları**:
  - TMDB verileri ticari olmayan kişisel kataloglama amacıyla kullanılır; kalıcı bir genel katalog veritabanı olarak yeniden dağıtılmaz, yalnızca geçici performans/çevrimdışı önbellekte tutulur ve arayüz altbilgisinde resmi TMDB atfı yer alır.

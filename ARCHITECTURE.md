# CineTrack Mimari Belgesi (`ARCHITECTURE.md`)

Bu belge CineTrack uygulamasının modül sınırlarını, veri akışını, kalıcı depolama şemasını, önbellek ayrımını, migrasyon kurallarını ve veri bütünlüğü güvencelerini açıklar.

---

## 1. Modül Yapısı ve Sorumluluk Sınırları

### Çekirdek Katman (`src/core/`)
Tarayıcı DOM'undan ve Express sunucusundan bağımsız, saf ve deterministik iş mantığı modülleridir; hem istemci (Vite/React) hem de sunucu (Node.js) tarafından doğrudan kullanılır:

- `src/core/limits.ts`: Tek kaynaklı veri ve koleksiyon sınırları (`DEFAULT_MAX_DATA_BYTES = 25 * 1024 * 1024` = 25 MiB, `DEFAULT_MAX_PROFILES = 20`, `DEFAULT_MAX_ITEMS_PER_PROFILE = 25_000`, `DEFAULT_MAX_SNAPSHOTS = 7`) ve UTF-8 bayt ölçümü (`measureUtf8Bytes`).
- `src/core/keys.ts`: Medya anahtarlarının (`movie:123`, `tv:456`) kanonikleştirilmesi, eski anahtarların (`movie-123`) dönüştürülmesi ve çakışan `TasteMapEntry` kayıtlarının (`shownCount`, `skippedCount`, `ringDemotions`, `lastShownAt`, `lastRecommendedAt`, `impressionHistory`) kayıpsız ve idempotent biçimde birleştirilmesi (`migratePersistentTasteMapData`).
- `src/core/derived-profile-cache.ts`: Türetilmiş profil önbelleği şeması (`DERIVED_PROFILE_SCHEMA_VERSION = 2`), nesne anahtarı sırasından ve yazma zaman damgalarından (`generatedAt`, `calculatedAt`) bağımsız deterministik içerik özeti (`computeDerivedProfileContentHash`), kaynak katalog imzası (`computeSourceCatalogSignature`) ve önbellek geçerlilik denetimi (`validateDerivedProfileCache`).
- `src/core/recommendation-orchestrator.ts`: React bileşenlerinden bağımsız öneri akışı yardımcıları; kalıcı Zevk Haritasından doğru yaşam döngüsü halkası çözümleme (`resolveDisplayedLifecycleRing` — `ring1` değerinin `ring0` ile ezilmesini önler), katı film/dizi havuz ayrımı (`enforceStrictMediaTypePool`), doğrulanmış sunucu önbelleğini kaynak veriyi ezmeden Zevk Haritasına aktarma (`hydrateTasteMapWithDerivedCache`) ve şema-2 türetilmiş profil paketi üretimi (`buildDerivedProfilePayloadFromTasteMap`).
- `src/core/cinetrack-core.ts`: Veri şeması doğrulama (`normalizeDataDocument`, `parseBackupText`), 15 sinyalli `TasteProfileV3` ve `scoreCandidatesV3` öneri motoru, `ring0` / `ring1` / `ring2` yaşam döngüsü yönetimi, `500 + 500` bağımsız film/dizi aday havuzu (`replenishCandidatePool`) ve oyuncu filmografisi kuyruk yöneticisi (`fetchActorCreditsBatch`).
- `src/core/relationship-explorer.ts`: `relationship-v3` deterministik ilişki keşif grafiği (`universe`, `person`, `semantic`, `atmosphere`, `contrast`), profil ve havuz imzaları (`computeRelationshipProfileSignature`, `computeRelationshipPoolSignature`).
- `src/core/evaluation.ts`: Öneri motorunun ardışık yenilemelerde `ring1RepeatRate`, `ring0Utilization`, `genreEntropy` ve `typeBalanceAccuracy` metriklerini ölçen çevrimdışı değerlendirme çatısı (`evaluateRecommendationEngine`).
- `src/core/exporters.ts`: Zevk DNA analizi (`buildTasteDnaProfile`), Letterboxd/IMDb uyumlu CSV içe/dışa aktarma (`importItemsFromCsv`, `exportItemsToCsv`), RFC 5545 `.ics` yayın takvimi (`generateIcsCalendar`), iki profil arası izleme listesi kesişimi (`computeProfileWatchlistIntersection`) ve kronolojik izleme yolculuğu (`buildMediaJourneyTimeline`).

### Sunucu Katmanı (`server.ts` & `src/server/`)
- `server.ts`: Sıfır zorunlu ortam değişkenli sunucu giriş noktası; sınırları `src/core/limits.ts` üzerinden alır (`DEFAULT_MAX_DATA_BYTES = 25 MiB`). Geliştirme (`--dev` ile dinamik `await import('vite')`) ve üretim (`dist/` statik sunumu) modlarını çalıştırır.
- `src/server/atomic-json.ts`: Tüm kalıcı JSON dosyaları için ortak atomik yazma (`writeJsonFileAtomic`: aynı dizinde benzersiz `.tmp` dosyasına yazma, bayt boyutu doğrulaması, `fsyncSync`, hata anında `.tmp` temizliği ve `renameSync`), başlangıçta yarım kalmış `.tmp` temizliği (`cleanupStaleTempFiles`), bozuk JSON karantinası + yedekten kurtarma (`readJsonFileWithRecovery`, `CorruptJsonFileError`) ve dosya bazlı yazma serileştiricisi (`FileWriteSerializer`).
- `src/server/storage.ts`: Ana kullanıcı verisi (`data/cinetrack-data.json`), `.bak` yedeği (`data/cinetrack-data.bak.json`) ve `data/backups/` altında en son 7 geçerli döner anlık görüntü (snapshot) yönetimi; UTF-8 bayt sınırı kontrolü, monotonik `revision` sayacı ve ani veri kaybı koruması (`sudden_item_drop` -> `409`). Bozuk ana dosya hiçbir zaman sağlam `.bak` yedeğinin üzerine kopyalanmaz.
- `src/server/persistent-store.ts`: Ortak içerik kataloğu (`data/catalog/movies.json`, `data/catalog/tv.json`, `data/catalog/manifest.json`), profil bazlı türetilmiş önbellek (`data/profiles/<profileId>.json`) ve dosya bazlı durum takipli (`data/sync-state.json`) GitHub Contents API senkronizasyonu (`PersistentDataStore`).
- `src/server/app.ts`: Express uygulama fabrikası (`createCineTrackApp`), UTF-8 bayt doğrulamalı `413 Payload Too Large`, `400 Invalid JSON` ve `500 corrupt_json_file / corrupt_storage` hata yakalayıcıları, `ETag` / `If-Match` revizyon uçları, katalog/türetilmiş profil ve GitHub eşitleme rotaları.
- `src/server/security.ts`: Çapraz kaynak (`Origin` -> `403`) koruması ve isteğe bağlı token/hız sınırı katmanları.
- `src/server/tmdb-proxy.ts`: Katı `ALLOWED_TMDB_PATH` (`/tv/{id}/season/{n}` dahil) ve parametre doğrulaması, 500 girdili sunucu LRU önbelleği, ağ kesintilerinde bayat önbellek (`stale-cache`) geri dönüşü ve yerleşik demo kataloğu.

### İstemci Servis, Hook ve Arayüz Katmanı (`src/services/`, `src/hooks/`, `src/components/`)
- `src/services/api.ts`: İstemci TMDB önbelleği, uçuş hâlindeki (in-flight) istek tekilleştirme, TMDB yanıt şeması doğrulaması (`validateTmdbResponseShape`), `If-Match` revizyon takipli sunucu senkronizasyonu ve katalog / türetilmiş profil (`fetchDerivedProfileData`, `pushDerivedProfileData`) istemci çağrıları.
- `src/services/relationship-cache.ts`: İlişki grafiği anlık görüntülerini `IndexedDB` (`cinetrack-relationship-cache`) üzerinde saklar.
- `src/services/offline-queue.ts` & `src/hooks/useOfflineSync.ts`: Çevrimdışı yapılan yerel değişiklikleri kuyruğa alır; bağlantı geri geldiğinde taban revizyonla (`baseRevision`) sunucuya iletir ve olası `409 Conflict` durumunda kullanıcıya seçim sunar (`ConflictBanner`).

---

## 2. Kalıcı Veri Katmanları ve Önbellek İzolasyonu

CineTrack'te kalıcı veri ve önbellek katmanları görevlerine göre kesin sınırlarla ayrılmıştır:

1. **Kullanıcıya Özel Ana Durum (`data/cinetrack-data.json`, `schemaVersion: 3`)**:
   - Kullanıcının doğruluk kaynağıdır (source of truth): izleme listeleri (`watching`, `watchlist`, `completed`), kişisel puanlar, tercihler (`disliked`, `hidden`, `providers`, `mood`) ve favori oyuncular burada tutulur.
2. **Ortak İçerik Kataloğu (`data/catalog/movies.json`, `data/catalog/tv.json`, `data/catalog/manifest.json`)**:
   - Medya türü dahil kanonik kimlikle (`movie:123` ile `tv:123` ayrı kayıtlardır) tekilleştirilmiş TMDB metaverilerini tutar. Aynı içerik tekrar geldiğinde kopya üretilmez; zaman damgaları hariç anlamlı kaynak alanları değişmemişse disk yazımı (ve GitHub commit'i) yapılmaz.
3. **Profil Bazlı Türetilmiş Veri Önbelleği (`data/profiles/<profileId>.json`, `schemaVersion: 2`)**:
   - Her profil için hesaplanan `matchScore`, `tasteScore`, `priorityScore`, `lifecycleRing`, `signals`, `reasons`, `shownCount`, `skippedCount`, `demotionPenalty`, `status`, `scoreCoverage` ve `pillars` alanlarını tutar.
   - **Geçersizleştirme (Invalidation) ve Geri Dönüş**: Önbellek anahtarı ve doğrulaması `schemaVersion` (`2`), `algorithmVersion`, `profileFingerprint` ve `sourceCatalogHash` alanlarının tamamını denetler; ayrıca tüm anlamlı alanlar üzerinden deterministik `contentHash` (`computeDerivedProfileContentHash`) hesaplanır. Eski `schemaVersion: 1` dosyaları veya imzası/özeti uyuşmayan kayıtlar sessizce geçerli sayılmaz (`cache miss`); kaynak katalog ve kullanıcı profilinden yeniden hesaplanarak şema-2 biçiminde güncellenir. Türetilmiş önbellek hiçbir zaman kullanıcı listelerinin doğruluk kaynağı yerine geçmez.
4. **Tarayıcı Zevk Haritası, Aday Havuzu ve İlişki Önbelleği (`localStorage` & `IndexedDB`)**:
   - `cinetrack_taste_map_<profileId>` ve `cinetrack_pool_<type>_<profileId>` öneri motorunun yerel çalışma havuzunu tutar; `cinetrack-relationship-cache` (`IndexedDB`) ise ilişki grafiğini Zevk Haritası sayaçlarını etkilemeden saklar.

---

## 3. Anahtar Migrasyonu (`movie-123` -> `movie:123`) ve Yaşam Döngüsü Halkaları

- Eski `movie-123` / `tv-456` anahtarları `entries`, `archivedEntries`, kayıt içi `mediaKey` ve `lastRecommendedKeys` alanlarının tamamında `migratePersistentTasteMapData` ile kanonik `movie:123` / `tv:456` biçimine dönüştürülür.
- Hem eski hem yeni anahtar aynı anda varsa `mergeTasteMapEntriesOnCollision` kayıtları silmeden birleştirir: `impressionHistory` yinelenen olayları çoğaltmadan kronolojik birleştirilir (`MAX_IMPRESSION_HISTORY_PER_ENTRY = 30`, taşanlar `archivedImpressionCount` içinde korunur), `shownCount` tekilleştirilmiş geçmişle uyumlu hesaplanır, `skippedCount` toplanır, `ringDemotions` / `demotionPenalty` maksimum değeri korur, `lastShownAt` / `lastRecommendedAt` / `lastScoredAt` en yeni geçerli tarihi ve `firstShownAt` en eski tarihi korur; kullanıcı durum önceliği (`disliked > hidden > saved > active`) ezilmez. İkinci çalıştırma **idempotent**tir (`changed: false`).
- Öneri seçim sırası: önce `ring0` (hiç gösterilmemiş adaylar), `ring0` hedef sayıyı dolduramazsa `ring2` (daha önce gösterilip atlanmış yedek adaylar) seçilir; son gruptaki `ring1` öğeleri bir sonraki yenilemede kesinlikle dışlanır.

---

## 4. Atomik Yazma, Yedekleme, GitHub Eşitleme ve TMDB Sınırları

1. **Atomik Yazma ve Bozuk Dosya Koruması**:
   - Tüm kalıcı JSON yazımları hedef dizinde benzersiz `.tmp` dosyasına yazılıp `fsyncSync` ve boyut/JSON doğrulamasından geçtikten sonra `renameSync` ile hedefe taşınır; hata anında `.tmp` silinir ve önceki sağlam dosya korunur.
   - Açılışta veya okuma sırasında bozuk JSON saptanırsa dosya `*.corrupt.<timestamp>` olarak karantinaya kopyalanır ve önce `.bak`, ardından `data/backups/` içindeki en yeni sağlam snapshot üzerinden kurtarma denenir. Kurtarma mümkün değilse bozuk dosya boş veriyle ezilmez (`CorruptJsonFileError` / HTTP `500`).
2. **Tek Kaynaklı Boyut Sınırı (`25 MiB`)**:
   - `DEFAULT_MAX_DATA_BYTES = 26_214_400` bayt sınırı UTF-8 bayt uzunluğu üzerinden ölçülür; sınırı aşan istekler `413 Payload Too Large` ile reddedilir ve diskteki mevcut dosyalar değiştirilmez.
3. **Çift Yönlü GitHub Senkronizasyonu (`src/server/github-bidirectional-sync.ts`, `src/core/sync-display.ts` & `PersistentDataStore`)**:
   - **Ayrı Sunucu Uçları ve Eylemler**: `GET /api/sync/status`, `POST /api/sync/inspect` (salt okunur denetim), `POST /api/sync/pull` (çakışma korumalı güvenli indirme), `POST /api/sync/push` (doğrulamalı yükleme) ve `POST /api/sync/reconcile` (iki yönlü kayıpsız birleştirme ve eşitleme). Aynı depoya paralel senkronizasyon başlatılması serileştirilir ve `rejectIfBusy` ile korunur.
   - **Açık Kalıcı Veri Envanteri**: Ortak katalog (`data/catalog/movies.json`, `data/catalog/tv.json`, `data/catalog/manifest.json`) ve yalnızca özel (`private`) depolarda kişisel veriler (`data/cinetrack-data.json`, `data/profiles/*.json`). Geçici `.tmp`, `.bak`, `data/backups/*`, `data/sync-state.json`, `.corrupt.*`, `.env` ve derleme çıktıları envantere dahil edilmez.
   - **Varsayılan Silmesiz (No-Deletion) ve Kayıpsız Birleştirme**: `movie:<id>` ve `tv:<id>` kayıtları ayrı tutulur; dolu açıklamalar (`overview`), afiş yolları (`poster_path`, `backdrop_path`), tür kümeleri (`genre_ids`) ve yüksek oy sayıları korunur. Kullanıcı profilleri ve kayıtları kanonik kimlikle birleştirilir; yerel farklı kayıtlar varken `pull` sessizce ezmez, onay/birleştirme sunar ve işlem öncesi döner snapshot yedeği alır. Türetilmiş profiller yalnızca `generatedAt` tarihine bakılarak değil `schemaVersion`, `algorithmVersion`, `profileFingerprint` ve `sourceCatalogHash` doğrulamasıyla değerlendirilir; uyumsuz önbellekler kaynak veriden yeniden üretilir.
   - **Sayım, Ham/Semantik Hash ve İşlem Sonrası Uzak Doğrulama**: Yazma zaman damgalarından (`updatedAt`, `generatedAt`) bağımsız semantik içerik özeti ile ham UTF-8 dosya özeti ayrı raporlanır; `manifest.json` içindeki `movieCount`, `tvCount` ve `contentHash` gerçek katalogla çapraz doğrulanır. `push` ve `reconcile` sonrasında uzak dosyalar GitHub'dan yeniden okunur (`>1 MB` dosyalarda Git Blob API kullanılarak); tüm dosyalar doğrulanmadan `verifiedEqual: true` veya arayüzde *"Eşitlendi (Doğrulandı)"* durumu gösterilmez.
   - **Hata Sınıflandırması ve Gizlilik**: `404` yalnızca dosya yokluğu olarak değerlendirilir; `401/403` (`auth_error`), `429` (`rate_limit`), `409` (`conflict` — en fazla 3 yeniden deneme), ağ kesintisi (`network_error`), bozuk JSON ve boyut aşımı ayrı sınıflandırılır, tüm hata metinlerinde gizli anahtarlar `redactSecrets` ile temizlenir.
4. **TMDB Saklama Politikası Notu**:
   - Yerel katalog yalnızca uygulamanın kişisel öneri puanlaması ve çevrimdışı önbelleği için gerekli temel metaveri alanlarını saklar. TMDB API kullanım koşulları uyarınca TMDB verileri herkese açık bir katalog veya üçüncü taraf veri servisi olarak paylaşılmamalıdır.

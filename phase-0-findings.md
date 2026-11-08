# CineTrack — FAZ 0 Envanter ve Kod/Veri Denetim Raporu (`phase-0-findings.md`)

**Durum:** Tamamlandı (Salt Okunur Denetim — **Hiçbir kaynak kod veya veri dosyası değiştirilmemiştir**)  
**Denetim Tarihi:** `2026-11-01`  
**Denetlenen Şema / Motor Sürümü:** `schemaVersion: 3` · `version: 3` · `engineVersion: "v3.2.0"`

---

## 0. Yönetici Özeti ve Canlı Veri Anlık Görüntüsü

FAZ 0 kapsamında CineTrack kod tabanının istemci, çekirdek öneri motoru, yerel sunucu depolama katmanı, çift yönlü GitHub eşitleme motoru ve disk üzerindeki canlı `data/cinetrack-data.json` verisi salt okunur olarak denetlenmiştir.

### Canlı `data/cinetrack-data.json` Şema Doğrulaması
> Gizlilik gereği bu raporda kullanıcıya ait profil adı, kütüphane büyüklüğü, puan/tercih sayıları ve dosya boyutu gibi kişisel veriler **kaldırılmıştır**. Aşağıdaki bulgular yalnızca şema ve davranış doğrulaması içerir.

| Doğrulama | Sonuç | Kaynak |
| :--- | :--- | :--- |
| Kök belge şeması | `version: 3`, `schemaVersion: 3`, `engineVersion: "v3.2.0"` | `data/cinetrack-data.json` kök nesnesi |
| Profil yapısı | `profiles[]` + `activeProfileId` + `preferences` alanları mevcut | `ensureDataShape` |
| Kayıt üst sınırı | `DEFAULT_MAX_DATA_BYTES = 25 MiB` | `src/core/limits.ts` |
| Bölüm ilerleme modeli | Sezon bazlı bölüm sayacı (`season_progress`) | `src/core/tv-progress.ts` |

### Temel Bulguların Özeti
1. **Puan Ölçeği:** Kullanıcı puanı `SavedItem.personal_rating` alanında `number | ''` tipindedir; geçerli aralık **`1..10`** olup puansız durum `null` veya `0` değil **boş dizge (`""`)** ile temsil edilir. UI yalnızca `1..10` tam sayı girişine izin verir; CSV içe aktarmada `0.5–5.0` yıldızlı Letterboxd puanları `Math.round(p * 2)` ile `1..10` tam sayıya çevrilir. Öneri motoru bu puanı `normalizeUserRating` ile `[-1, +1]` aralığına (`5 -> 0` nötr) dönüştürür.
2. **Tarih Alanları:** `SavedItem` üzerinde `addedAt`, `firstAddedAt` ve `updatedAt` (ISO-8601 UTC) mevcuttur; ancak **`ratedAt`, `watchedAt` ve `completedAt` alanları kodda ve veride BULUNMAMAKTADIR**. Bu eksiklik nedeniyle sinyal sönümlemesi (`signalDecay`), CSV `WatchedDate` dışa aktarması ve Yıllık Özet (`wrapped-summary.ts`) hesaplamaları `updatedAt` alanına geri düşmektedir.
3. **"İlgilenmiyorum" vs "Gizle" Ayrımı:** Kodda üç farklı mekanizma vardır:
   - `preferences.disliked` (**"İlgilenmiyorum"**): Hem UI'da aktif butona sahiptir hem aday havuzundan dışlar **hem de** `buildTasteProfileV3` içinde `-0.8` ağırlıklı **negatif zevk sinyali** üretir.
   - `preferences.hidden` (**"Tekil İçerik Gizle"**): Şemada, GitHub birleştirmede ve aday havuzu filtrelerinde tanımlıdır; zevk profiline negatif ceza **uygulamaz** (nötr bastırma), **ancak UI'da bu diziye yazan hiçbir buton/işleyici yoktur**.
   - `hideListedItems` (**"Listemdekileri Gizle"**): `cinetrack-data.json` dışındaki tarayıcı görünüm filtresidir (`localStorage` + IndexedDB `ct:ui-prefs`); yalnızca Keşfet (`trending`, `top-rated`, `gems`) ve `stock` sekmelerinde kayıtlı 5 durumu gizler.
4. **Dizi Bölüm İlerleme Modeli:** Bölüm ID listesi **kullanılmaz**; `season_progress: Record<seasonNumber, watchedEpisodeCount>` şeklinde **1-indeksli sezon bazlı sayaç** modeli kullanılır (`Season 0 / Specials` kapsam dışıdır).
5. **GitHub Dosya Tanıma:** `SYNC_STATIC_INVENTORY` altındaki **4 statik JSON yolu** (`data/catalog/{movies,tv,manifest}.json` ve `data/cinetrack-data.json`) ile `data/profiles/*.json` altındaki **`/^[a-zA-Z0-9_-]+\.json$/` kalıbına uyan dinamik türetilmiş profil dosyaları** tanınır. `>1 MB` dosyalar GitHub Contents API sınırına takıldığında otomatik olarak **Git Blob API (`/git/blobs/{sha}`)** üzerinden okunur.

---

## 1. `cinetrack-data.json` Yapısı ve Puan Ölçeği

### 1.1. Kök Belge (`DataDocument`), Profil (`Profile`) ve Tercihler (`Preferences`)
Kaynak: `src/core/cinetrack-core.ts` (satır `46–128`, `598–769`) ve `src/server/storage.ts`.

```ts
interface DataDocument {
  version: number;          // Sabit: 3
  schemaVersion?: number;   // CURRENT_SCHEMA_VERSION = 3
  engineVersion?: string;   // ENGINE_VERSION = "v3.2.0"
  activeProfileId: string;  // Örn. "profile-default"
  profiles: Profile[];      // En az 1 profil garantili (ensureDataShape)
  revision?: number;        // İyimser eşzamanlılık sayacı (her kayıtta +1 artar)
  updatedAt: string;        // Belge yazım zamanı (ISO-8601 UTC)
}

interface Profile {
  id: string;
  name: string;
  createdAt: string;
  preferences: Preferences;
  items: SavedItem[];
  favoriteActors: FavoriteActor[];
  deleted_keys?: Record<string, string>; // { "movie:550": "2026-10-30T..." } (30 gün TTL, maks 2.000)
  isDemo?: boolean;
}

interface Preferences {
  disliked: string[];       // Kanonik anahtarlar ("movie:123", "tv:456"), son 500 kayıt
  hidden?: string[];        // İsteğe bağlı nötr gizlenen kanonik anahtarlar, son 500 kayıt
  providers: number[];      // Dijital platform ID'leri (son 40 kayıt)
  mood: string;             // Aktif ruh hali filtresi
  reminders: boolean;       // Yeni bölüm / yayın hatırlatıcı tercihi
  notified: string[];       // Bildirimi gönderilmiş anahtarlar (son 300 kayıt)
}
```

### 1.2. `SavedItem` Alan Envanteri (Canlı Veri + Tip Şeması)
Canlı `data/cinetrack-data.json` içindeki kayıtlar üzerinde **33 aktif alan** doğrulanmıştır (`src/core/cinetrack-core.ts:62–103`, `normalizeSavedItem` satır `329–463`):

| Alan | Tip | Açıklama ve Normalizasyon Kuralı |
| :--- | :--- | :--- |
| `id` | `number \| string` | TMDB sayısal ID'si veya özel içeriklerde `"custom-<timestamp>"` dizgesi |
| `media_type` | `'movie' \| 'tv'` | Kanonik anahtar üretimi (`mediaKeyOf` -> `movie:<id>` veya `tv:<id>`) |
| `title` / `name` | `string` | İçerik başlığı (`sanitizeText`, maks `240` karakter; boşsa `'İsimsiz İçerik'`) |
| `status` | `'watchlist' \| 'watching' \| 'completed'` | Geçersiz değerler `'watchlist'` olarak normalize edilir (`normalizeStatus`) |
| `personal_rating` | `number \| ''` | `1..10` arası sayı; puansızsa **boş dizge `''`** |
| `personal_rating_cleared` | `boolean` (ops.) | Kullanıcı puanı bilinçli sildiğinde `true`; birleştirmede eski puanın geri gelmesini önler |
| `custom` | `string` | Kullanıcı kişisel notu / incelemesi (`sanitizeText`, maks `500` karakter) |
| `addedAt` | `string` (ISO-8601) | Listeye ilk eklenme zamanı |
| `firstAddedAt` | `string` (ISO-8601) | İlk keşif/eklenme zamanı (`item.firstAddedAt \|\| item.addedAt`) |
| `updatedAt` | `string` (ISO-8601) | Kayıt üzerindeki son değişiklik zamanı |
| `release_date` / `first_air_date` / `last_air_date` | `string` | `YYYY-MM-DD` yayın tarihleri |
| `vote_average` / `vote_count` / `popularity` | `number` | TMDB topluluk puanı (`0..10`), oy sayısı ve popülerlik |
| `poster_url` / `poster_path` / `backdrop_path` | `string` | Görsel yolları (`sanitizePosterUrl`, yalnızca `http/https` veya `/path`) |
| `overview` | `string` | İçerik özeti (maks `2.500` karakter; `localStorage` kota aşımında `120` karaktere kırpılabilir) |
| `genre_ids` / `genres` | `number[]` / `{id,name}[]` | Tür kimlikleri ve adları (maks `20` tür) |
| `runtime` / `episode_run_time` | `number` / `number[]` | Film süresi (dk) / dizi bölüm süreleri (maks `10` eleman) |
| `number_of_seasons` / `number_of_episodes` | `number` | Toplam sezon (`0..500`) ve bölüm (`0..50.000`) sayısı |
| `season_progress` | `Record<number, number>` | Sezon bazlı izlenen bölüm sayısı (`1..300 -> 0..10.000`) |
| `season_episode_counts` | `Record<number, number>` | Sezon bazlı toplam bölüm sayısı (`Season 0` hariç) |
| `current_season` / `episodes_watched` / `next_episode` | `number` | Aktif sezon, toplam izlenen bölüm ve sıradaki bölüm numarası |
| `next_episode_to_air` | `NextEpisodeInfo \| null` | `{ air_date, episode_number, season_number, name }` |
| `cast` / `crew` / `production_companies` / `belongs_to_collection` | Dizi / Nesne (ops.) | Zevk DNA'sı ve seri/koleksiyon motoru için zenginleştirilmiş meta veri |
| `totalWatchTimeMinutes` / `isDemo` | `number` / `boolean` | Hesaplanan toplam izleme süresi / demo içerik bayrağı |

### 1.3. Çok Katmanlı Puan Ölçekleri

| Katman | Alan / Fonksiyon | Ölçek ve Tip | Boş / Nötr Değer | Kod Konumu ve Davranış Detayı |
| :--- | :--- | :--- | :--- | :--- |
| **1. Kullanıcı Kayıt Puanı** | `SavedItem.personal_rating` | **`1..10`** (`number \| ''`) | `''` (boş dizge) | `cinetrack-core.ts:331–332, 390–391`: `rating >= 1 && rating <= 10 ? rating : ''`. `0`, `null`, `NaN` veya aralık dışı sayılar `''` olur. |
| **2. Arayüz Puan Girişi** | `DetailModal` & `QuickSaveModal` | **`1..10` tam sayı** | Seçilmemiş yıldız (`''`) | `DetailModal.tsx:420`, `QuickSaveModal.tsx:173`: `[1,2,3,4,5,6,7,8,9,10]` butonları. Puan verildiğinde `status === 'watchlist'` ise otomatik `'completed'` yapılır (`App.tsx:2206–2208`). |
| **3. CSV / Letterboxd İçe Aktarma** | `parseCsvImport` | `0.5–5.0` veya `1–10` -> **`1..10` tam sayı** | `''` | `exporters.ts:355–367`: `Rating10` sütunu `Math.round(parsed10)` ile; `Rating` (`0.5..5.0`) sütunu `Math.round(parsed5 * 2)` ile `1..10` tam sayıya çevrilir (`3.5 -> 7`). |
| **4. Öneri Motoru İç Sinyali** | `normalizeUserRating` & `getUserSignalV3` | **`[-1.0, +1.0]`** float | `5` puan -> `0.0` | `cinetrack-core.ts:905–957`: `<5` için `(r - 5) / 4` (`1 -> -1.0`), `>=5` için `(r - 5) / 5` (`10 -> +1.0`). Puansız öğelerde: `disliked -> -0.8`, `completed -> +0.4`, `watching -> +0.2`, `watchlist -> +0.2`. |
| **5. TMDB Topluluk Puanı** | `vote_average` & `bayesianRating` | **`0.0..10.0`** float | Bayesyen önsel `6.5` | `cinetrack-core.ts:825–836`: `(v / (v + 300)) * R + (300 / (v + 300)) * 6.5` formülüyle düşük oylu içerik sapması dengelenir. |
| **6. Zevk Eşleşme / Öncelik Skoru** | `tasteScore` / `matchScore` / `priorityScore` | **`1..100`** tam sayı | Varsayılan taban `50` | `cinetrack-core.ts:4714–4835`: `tasteScore` saf zevk uyumudur; `priorityScore = clamp(1..100, tasteScore - demotionPenalty)` (her atlamada `-5`, maks `-35` ceza). |

---

## 2. Tarih Alanları Envanteri (`addedAt`, `ratedAt` vb.)

### 2.1. Katmanlara Göre Mevcut Tarih Alanları

| Veri Katmanı | Alan Adı | Format / Tip | Üretildiği / Güncellendiği Yer | Birleştirme (Merge) Davranışı |
| :--- | :--- | :--- | :--- | :--- |
| `DataDocument` | `updatedAt` | ISO-8601 `string` | `storage.ts` her kayıtta `new Date().toISOString()` yazar | Semantik hash hesabında **yok sayılır** (`stripUserDataVolatileFields`) |
| `Profile` | `createdAt` | ISO-8601 `string` | Profil oluşturulduğunda (`createProfile`, `cinetrack-core.ts:710`) | İlk oluşturma zamanı korunur |
| `Profile.deleted_keys` | `<mediaKey>: <deletedAt>` | ISO-8601 `string` | İçerik silindiğinde (`App.tsx:2412`, `recordDeletedKey`) | En yeni silme tarihi kazanır; `updatedAt > deletedAt` ise kayıt yeniden eklenmiş kabul edilir (`30` gün TTL) |
| `SavedItem` | `addedAt` | ISO-8601 `string` | Kayıt ilk eklendiğinde (`App.tsx:2216`: `existing ? existing.addedAt : now`) | `dedupeItems` ve GitHub birleştirmede **en erken** geçerli tarih korunur |
| `SavedItem` | `firstAddedAt` | ISO-8601 `string` | `normalizeSavedItem` (`cinetrack-core.ts:439`): `item.firstAddedAt \|\| item.addedAt` | İlk eklenme zamanını sabitler |
| `SavedItem` | `updatedAt` | ISO-8601 `string` | Kayıt ekleme, durum/not/puan değiştirme ve dizi `+1` bölüm ilerletmede `now` ile ezilir | `mergeTwoSavedItemsLossless` içinde hangi tarafın daha güncel olduğunu belirleyen birincil hakemdir (`github-bidirectional-sync.ts:496–528`) |
| `SavedItem` (TMDB) | `release_date`, `first_air_date`, `last_air_date`, `next_episode_to_air.air_date` | `YYYY-MM-DD` `string` | TMDB API yanıtlarından alınır | Dolu ve daha zengin olan meta veri korunur |
| `TasteMapEntry` (IDB) | `firstShownAt`, `lastShownAt`, `lastScoredAt`, `archivedAt`, `impressionHistory[].shownAt` | ISO-8601 `string` | `cinetrack-core.ts:4560–4920` (Keşfet gösterim/atlama takibi) | Yalnızca yerel `cinetrack-discovery-history-db` içinde yaşar |
| `CatalogRecord` | `firstStoredAt`, `lastUpdatedAt` | ISO-8601 `string` | `persistent-store.ts` katalog upsert sırasında güncellenir | `computeCatalogSemanticMapHash` içinde uçucu alan olarak filtrelenir |
| `DerivedProfileDocument` | `generatedAt`, `items[k].calculatedAt` | ISO-8601 `string` | `derived-profile-cache.ts` türetilmiş skor yazımında üretilir | `computeDerivedProfileContentHash` içinde dışlanır (`derived-profile-cache.ts:209`) |
| İstemci IDB Depoları | `surfacedAt`, `skippedAt`, `cachedAt`, `updatedAt` | `number` (epoch ms) / ISO `string` | `ct:surfaced`, `ct:skip-log`, `ct:actor-credits`, `ct:stock`, `ct:series-index`, `ct:ui-prefs` | Cihaz-yerel TTL / FIFO soğuma süresi kontrolünde kullanılır |

### 2.2. Kritik Eksik Alan Tespiti: `ratedAt`, `watchedAt` ve `completedAt` YOKTUR
Tüm kaynak dosyalar (`src/**/*.ts`, `src/**/*.tsx`, `server.ts`) ve canlı veri belgesi taranmıştır:
- `SavedItem` üzerinde **`ratedAt` alanı yoktur**.
- `SavedItem` üzerinde **`watchedAt` alanı yoktur**.
- `SavedItem` üzerinde **`completedAt` alanı yoktur**; `completedAt` ismi yalnızca `BidirectionalSyncReport` ve `idb-schema-version.ts` içinde işlem bitiş zamanı için kullanılmaktadır.

**Mevcut Kod Üzerindeki Somut Etkileri:**
1. **Zevk Sinyali Sönümlemesi (`cinetrack-core.ts:926, 935, 944`):** `getUserSignalV3` fonksiyonu `signalDecay(item.updatedAt || item.addedAt, halfLifeDays)` çağrısı yapar. Eski bir filme yıllar sonra yalnız metin notu eklenmesi `updatedAt` tarihini yenilediği için sinyalin yaşlanma ağırlığını sıfırlar.
2. **CSV Dışa / İçe Aktarma (`src/core/exporters.ts:262, 410–411`):** CSV dışa aktarmada `WatchedDate` sütunu `(item.updatedAt || item.addedAt || '').slice(0, 10)` değerinden üretilir; CSV içe aktarmada ise okunan `WatchedDate` hem `addedAt` hem `updatedAt` alanına yazılır.
3. **Yıllık Özet / Wrapped (`src/core/wrapped-summary.ts:116–131`):** `resolveItemTrackedDate` fonksiyonu sırasıyla `[item.updatedAt, item.addedAt, item.firstAddedAt]` alanlarına bakar. Önceki yılda izlenmiş bir kaydın puanı veya notu sonraki yılda düzenlenirse kayıt yeni yılın özet istatistiklerine kayar.

---

## 3. `"İlgilenmiyorum"` ve `"Gizle"` Ayrımının Kod Doğrulaması

Kod tabanında isim benzerliği taşıyan ancak veri konumu, UI erişimi ve öneri motoru matematiği açısından birbirinden tamamen farklı **3 ayrı yapı** doğrulanmıştır:

| Özellik | 1. `"İlgilenmiyorum"` (`preferences.disliked`) | 2. `"Tekil İçerik Gizle"` (`preferences.hidden`) | 3. `"Listemdekileri Gizle"` (`hideListedItems`) |
| :--- | :--- | :--- | :--- |
| **Veri Konumu** | `cinetrack-data.json` -> `Profile.preferences.disliked: string[]` (maks `500`) + `localStorage['cinetrack_disliked_cache']` | `cinetrack-data.json` -> `Profile.preferences.hidden?: string[]` (opsiyonel, maks `500`) | Yalnızca tarayıcıda: `localStorage['cinetrack_hide_listed_items']` + IDB Depo 10 (`ct:ui-prefs`) |
| **Canlı Verideki Durum** | **22** kayıt mevcut | Tanımlı değil (`0` kayıt) | Cihaz bazlı boolean (`true` / `false`) |
| **UI Tetikleyicisi** | **VAR:** `DetailModal.tsx:399–409` *"İlgilenmiyorum"* butonu -> `App.tsx:2453` `handleToggleDislike`; ayrıca Listem sekmesinde `'disliked'` görünümü ve Excel yedeğinde 5. sekme | **YOK:** Kod tabanında `preferences.hidden` dizisine ekleme/çıkarma yapan hiçbir UI butonu veya handler mevcut değildir | **VAR:** `Controls.tsx:312–319` *"Listemdekileri Gizle"* onay kutusu |
| **Aday Havuzu & Stoktan Dışlama** | **EVET:** `isCandidateEligibleInPool` (`cinetrack-core.ts:4283–4289`), `stock-engine.ts:525`, `App.tsx:971,1992` üzerinden tamamen elenir | **EVET:** `isCandidateEligibleInPool` (`cinetrack-core.ts:4291–4297`), `stock-engine.ts:525`, `App.tsx:971,1992` üzerinden tamamen elenir | Yalnızca `HIDE_LISTED_CATEGORIES = ['trending', 'top-rated', 'gems']` (`cinetrack-core.ts:4317`) ve `'stock'` (`App.tsx:980`) görünümlerinde `completed`, `watchlist`, `watching`, `disliked`, `hidden` öğelerini gizler |
| **Zevk Profiline (`buildTasteProfileV3`) Etkisi** | **NEGATİF CEZA UYGULAR:** `cinetrack-core.ts:1037–1056` ve `getUserSignalV3` (`satır 925–928`) ile `signal = -0.8, weight = 1.0, halfLife = 730 gün` olarak tür, oyuncu, yönetmen ve keyword vektörlerini aşağı çeker | **NÖTR (ETKİSİZ):** `buildTasteProfileV3` bu diziyi **okumaz**. İçerik öneri havuzundan sessizce kaldırılır fakat benzer tür/oyuncular cezalandırılmaz | **ETKİSİZ:** Salt görünüm filtresidir; puanlama veya zevk vektörüne dokunmaz |
| **GitHub Eşitleme Davranışı** | `mergePreferenceKeys` (`github-bidirectional-sync.ts:459, 784–789`) ile küme birleşimi yapılır (`deleted_keys` ve `items` ile çakışanlar elenir) | `mergePreferenceKeys` (`github-bidirectional-sync.ts:460, 791–796`) ile küme birleşimi yapılır | Senkronize edilmez (cihaz-yerel UI ayarı) |

> **Ek Not (Çift Durum / Dual-State Tespiti):** `handleToggleDislike` (`App.tsx:2453–2485`) bir içeriği `preferences.disliked` listesine eklerken `profile.items` içinde zaten kayıtlıysa oradan otomatik silmez (`saveItem` ise `items`'a eklerken `disliked`'dan çıkarır, `App.tsx:2235–2239`). Bu nedenle bir anahtar hem `items` hem `disliked` içinde bulunabilir; `excel-profile-backup.ts:183` bu durumu `dualStateKeys` olarak raporlayıp çift yazımı önler.

---

## 4. Dizi Bölüm İlerleme Modeli

Kaynaklar: `src/core/tv-progress.ts` (satır `1–200`), `src/core/cinetrack-core.ts` (satır `252–327`, `395–437`), `src/components/DetailModal.tsx` (satır `565–620`), `src/App.tsx` (satır `2362–2392`).

### 4.1. Veri Temsili: Sezon Bazlı Bölüm Sayacı
CineTrack, tekil bölüm kimliklerini (`episode_id`) veya boolean dizilerini **saklamaz**; bunun yerine her sezon için izlenen bölüm adedini tutan hafif bir sayaç haritası kullanır:

```ts
// SavedItem (media_type === 'tv')
season_progress: Record<number, number>;       // Örn. { 1: 10, 2: 4 } -> 1. sezon 10 bölüm, 2. sezon 4 bölüm izlendi
season_episode_counts: Record<number, number>; // Örn. { 1: 10, 2: 8, 3: 8 } -> TMDB seasons[] dizisinden (Season >= 1)
current_season: number;                        // Tamamlanmamış ilk sezon (örn. 2)
episodes_watched: number;                      // Object.values(season_progress) toplamı (örn. 14)
next_episode: number;                          // (season_progress[current_season] || 0) + 1 (örn. 5; tüm dizi bittiyse 0)
```

### 4.2. Normalizasyon, İlerletme ve Birleştirme Kuralları
1. **Özel Bölümlerin (`Season 0`) Dışlanması:** `sanitizeSeasonMap` (`cinetrack-core.ts:252–268`) ve `buildSeasonCounts` (`satır 270–284`) yalnızca `season >= 1 && season <= 300` aralığını kabul eder. TMDB'deki `season_number: 0` (*Specials*) bölümleri ilerleme hesabına dahil edilmez.
2. **Geriye Dönük Uyumluluk:** Eski kayıtlarda `season_progress` boş fakat `episodes_watched > 0` ise `normalizeSavedItem` otomatik olarak `{ [current_season || 1]: episodes_watched }` haritasını oluşturur (`cinetrack-core.ts:404–408`).
3. **`+1 Bölüm` Otomasyonu (`advanceTvEpisodeProgress`, `src/core/tv-progress.ts`):**
   - Kart üzerindeki veya detay penceresindeki `+1 Bölüm` tetiklendiğinde aktif sezonun sayacı `1` artırılır (`season_episode_counts[season]` tavanıyla sınırlandırılır).
   - Aktif sezonun tüm bölümleri tamamlandığında `current_season` otomatik olarak bir sonraki tamamlanmamış sezona geçer (`defaultCurrentSeason`).
   - Bilinen tüm sezonların toplam bölüm sayısına ulaşıldığında `status` otomatik olarak `'completed'` durumuna yükseltilir ve `updatedAt` güncellenir.
4. **Çatışma ve Kopya Birleştirme (`Math.max` Kuralı):**
   - Hem yerel `dedupeItems` (`cinetrack-core.ts:535–544`) hem de GitHub `mergeTwoSavedItemsLossless` (`github-bidirectional-sync.ts:574–579`), her sezon numarası için `Math.max(localCount, remoteCount)` değerini alır.
5. **Bilinen Model Kısıtları:**
   - Sırasız bölüm izleme (ör. 2. sezonu atlayıp 3. sezondan tek bölüm izleme veya B1 ve B3 izlenip B2'nin atlanması) bölüm bazında temsil edilemez.
   - Kullanıcının yanlışlıkla artırdığı bölüm sayacını düşürmesi durumunda, uzak depoda daha yüksek sayaç varsa çift yönlü eşitlemede `Math.max` nedeniyle yüksek değer geri gelebilir.
   - Bölüm bazlı izlenme tarihi veya bölüm puanı yoktur.

---

## 5. GitHub Senkronizasyon Dosya Tanıma ve Doğrulama Yöntemi

Kaynaklar: `src/server/github-bidirectional-sync.ts` (`SYNC_STATIC_INVENTORY` satır `202–233`, `discoverLocalProfilePaths` satır `2078–2088`, `listRemoteProfilePaths` satır `2449–2524`, `fetchRemoteFileRaw` satır `2243–2407`) ve `src/server/persistent-store.ts`.

### 5.1. Tanınan Dosya Envanteri (Hibrit: 4 Statik + 1 Dinamik Kategori)

| Kategori (`SyncFileCategory`) | Depo Yolu (`repoPath`) | Tanıma Yöntemi | Kişisel Veri (`personal`) | Açık Depo (`Public Repo`) Koruması |
| :--- | :--- | :--- | :--- | :--- |
| `catalog_movies` | `data/catalog/movies.json` | Statik sabit (`SYNC_STATIC_INVENTORY`) | `false` | Gerçek depo `public` ise `allowCatalogInPublicRepo` onayı gerekir |
| `catalog_tv` | `data/catalog/tv.json` | Statik sabit (`SYNC_STATIC_INVENTORY`) | `false` | Gerçek depo `public` ise `allowCatalogInPublicRepo` onayı gerekir |
| `catalog_manifest` | `data/catalog/manifest.json` | Statik sabit + bağlantı testi probu | `false` | Gerçek depo `public` ise `allowCatalogInPublicRepo` onayı gerekir |
| `user_data` | `data/cinetrack-data.json` | Statik sabit (`SYNC_STATIC_INVENTORY`) | **`true`** | Gerçek depo `public` ise `allowPersonalDataInPublicRepo` açık onayı zorunludur; aksi halde `filesBlockedPublic` |
| `derived_profile` | `data/profiles/<profileId>.json` | **Dinamik dizin keşfi:** Yerelde `fs.readdirSync('data/profiles')` (`.bak.json`, `.corrupt.`, `.tmp` hariç); uzakta `GET /contents/data/profiles?ref=<branch>` yanıtında `type === 'file'` ve **`/^[a-zA-Z0-9_-]+\.json$/`** regex doğrulaması | **`true`** | `user_data` ile aynı açık depo korumasına tabidir |
| *(Tek Yönlü Arşiv Yüklemesi)* | `data/exports/<zaman-damgasi>.xlsx` | `POST /api/backup/profile-export` (`uploadToGithub: true`) -> `uploadBinaryBackupToGitHub` | **`true`** | İkili (`.xlsx`) arşiv yüklemesidir; çift yönlü `inspect/pull/reconcile` döngüsü bu dizini **okumaz** |

### 5.2. Senkronizasyon Kapsamı Dışında Bırakılan Dosyalar
- `data/profile.json` ve `data/user-lists.json` (sunucu `storage.ts` tarafından yerel olarak türetilen yalıtılmış aynalar).
- `data/backups/cinetrack-*.json` (yerel 7 döner yedek) ve tüm `*.bak`, `*.tmp`, `*.corrupt.*` kurtarma dosyaları.
- `data/cache/posters/*` (Excel yedeği poster önbelleği).
- Tarayıcıdaki 13 IndexedDB deposu (`ct:*`) doğrudan GitHub'a yazılmaz; yalnızca kalıcı karşılıkları olan `cinetrack-data.json`, `data/catalog/*.json` ve `data/profiles/*.json` üzerinden senkronize edilir.

### 5.3. Büyük Dosya (`>1 MB`) Okuma, Semantik Özet ve Geri Okuma Doğrulaması
1. **`>1 MB` Git Blob API Yedek Yolu (`fetchRemoteFileRaw`):** GitHub Contents API `1 MB` üstü dosyalarda `403 too_large` veya `encoding: "none", content: ""` döndürür. Sistem bu durumu yakalayıp üst dizini (`GET /contents/data`) listeleyerek dosyanın Git `sha` değerini bulur ve `GET /repos/{owner}/{repo}/git/blobs/{sha}` (**Git Blob API**, `25 MiB` üst sınırına kadar) üzerinden base64 içeriği eksiksiz indirir.
2. **İki Katmanlı Hash (`rawFileHash` vs `semanticHash`):**
   - `rawFileHash`: Dosyanın ham UTF-8 baytlarının SHA-256 özetidir (yazma sonrası geri okuma doğrulaması için kullanılır).
   - `semanticHash`: Uçucu zaman damgaları (`DataDocument.updatedAt`, `CatalogRecord.firstStoredAt/lastUpdatedAt`, `CatalogManifest.updatedAt`, `DerivedProfile.generatedAt/calculatedAt`) soyulduktan sonra deterministik anahtar sıralı JSON üzerinden hesaplanan SHA-256 özetidir. Yerel ve uzak `semanticHash` eşitse gereksiz commit atılmaz (`skippedNoop`).
3. **Kayıpsız Birleştirme ve Mezar Taşı (`reconcile`):**
   - Katalog dosyaları kayıt bazında birleştirilir (daha zengin alan korunur).
   - `cinetrack-data.json` profil bazında `mergeDataDocumentsLossless` ile birleştirilir; silinen içerikler `Profile.deleted_keys` (`30` gün saklama) sayesinde uzak depodan yanlışlıkla geri diriltilmez, ancak `item.updatedAt > deletedAt` ise kullanıcının içeriği yeniden eklediği anlaşılır ve kayıt korunur.
   - Her GitHub `PUT` yazımından sonra dosya uzak depodan tekrar okunur (`verifiedReadBack`) ve SHA-256 özeti doğrulanmadan işlem başarılı sayılmaz.

---

## 6. Uçtan Uca Yazma Yolları (Write Paths) Haritası

### 6.1. İstemci (Tarayıcı) Depolama Yazma Yolları
1. **`localStorage` Senkron Önbellek Yazımları (`src/App.tsx:501–550`):**
   - `cinetrack.profiles.v1`, `cinetrack.activeProfile.v1`, `cinetrack.profile.v1`
   - `cinetrack.profile.<id>.preferences.v1`, `cinetrack.profile.<id>.watchlist.v1` (`QuotaExceededError` durumunda `overview` alanı `120` karaktere kısaltılarak yeniden denenir)
   - `cinetrack_fav_actors_<id>`, `cinetrack_deleted_keys_<id>`, `cinetrack.dirty.v2`, `cinetrack_hide_listed_items`, `cinetrack_disliked_cache`
2. **13 Yalıtılmış İstemci Deposu (IndexedDB + Cache Storage):**
   - Depo 1 `ct:profile` (`cinetrack-profile-db`) & Depo 2 `ct:user-lists` (`cinetrack-user-lists-db`) — `App.tsx:557` `syncIsolatedDepots`
   - Depo 3 `ct:stock` (`cinetrack-stock-db`) — `stock-engine.ts` (`500` film / `500` dizi otonom stok havuzu, `<250` eşiğinde arka plan dolumu)
   - Depo 4 `ct:surfaced` (`cinetrack-surfaced-db`) — FIFO `1.000` kayıt + `7` gün soğuma süresi
   - Depo 5 `ct:series-index` (`cinetrack-series-index-db`) — TMDB `belongs_to_collection` + Wikidata `P179` seri doğrulama önbelleği
   - Depo 6 `ct:offline-queue` (`cinetrack-offline-queue-db`) — `useOfflineSync.ts` çevrimdışı bekleyen `DataDocument` yazım kuyruğu
   - Depo 7 `cinetrack-discovery-history-db` (`PersistentTasteMapData`) & Depo 8 `cinetrack-candidate-pool-db` (`PersistentCandidatePoolData`)
   - Depo 9 `ct:skip-log` (`cinetrack-skip-log-db`, maks `500`, `7` gün) & Depo 10 `ct:ui-prefs` (`cinetrack-ui-prefs-db`)
   - Depo 11 `ct:graph-cache` (`relationship-explorer.ts`), Depo 12 `ct:actor-credits` (`7` gün TTL), Depo 13 `ct:encodings` (`48` boyutlu içerik vektörleri, `ENCODING_LAYOUT_VERSION = 2`)
   - Poster Önbelleği: Service Worker Cache Storage (`poster-cache-manager.ts`, maks `200 MiB` LRU temizleme).

### 6.2. Sunucu HTTP API -> Atomik Disk -> GitHub Yazma Yolları (`src/server/app.ts`)

| HTTP Uç Noktası | Tetikleyen İstemci Akışı | Sunucu İşleyicisi ve Koruma Katmanı | Yazılan Disk / Uzak Hedefler |
| :--- | :--- | :--- | :--- |
| `PUT /api/data` | Kayıt ekleme/silme, puanlama, durum ve dizi ilerletme (`useOfflineSync` / `pushServerDataDetailed`, `800ms` debounce) | `storage.saveDataSerialized` (`app.ts:436–548`): `If-Match: "rev-N"` iyimser kilit (`409` / `412` / `428`), `25 MiB` sınır ve ani toplu veri kaybı koruması (`sudden_item_drop`: `>=5` öğe varken `%50+` düşüşü `X-CineTrack-Confirm-Drop: true` olmadan reddeder) | 1. `data/backups/cinetrack-<ts>.json` (maks `7` döner yedek)<br>2. `data/cinetrack-data.json` (`.tmp` + `fsync` + `rename` atomik yazım + `.bak`)<br>3. `data/profile.json` & `data/user-lists.json` (best-effort ayna) |
| `POST /api/data/backup-now` | Ayarlar -> Manuel yerel yedek oluşturma | `storage.backupExistingDataAsync()` (`app.ts:550–573`) | `data/backups/cinetrack-<ts>.json` |
| `POST /api/data/restore` | Ayarlar -> Yerel yedekten geri yükleme | `storage.restoreBackupSerialized(backupId)` (`app.ts:575–627`): şema doğrulaması + mevcut durumun güvenlik yedeği | `data/cinetrack-data.json` + `revision` artışı |
| `POST /api/catalog/upsert` | TMDB'den zenginleştirilen film/dizi meta verilerinin sunucuya aktarımı (`pushCatalogItems`) | `persistentStore.upsertCatalogItemsSerialized` (`app.ts:750–784`): bozuk JSON üzerine yazmayı reddeden `CorruptJsonFileError` koruması | `data/catalog/movies.json`, `data/catalog/tv.json`, `data/catalog/manifest.json` (+ `.bak` dosyaları) |
| `POST /api/profiles/derived/upsert` | Hesaplanan zevk/öncelik skorlarının önbelleğe yazımı (`pushDerivedProfileData`) | `persistentStore.upsertDerivedProfileSerialized` (`app.ts:822–865`): `contentHash` değişmemişse diske dokunmaz | `data/profiles/<profileId>.json` (+ `.bak`) |
| `POST /api/sync/pull`<br>`POST /api/sync/push`<br>`POST /api/sync/reconcile`<br>`POST /api/sync/staged`<br>`POST /api/sync/trigger` | GitHub Eşitleme paneli (`inspect`, `pull`, `push`, iki yönlü `reconcile`, aşamalı `staged`) | `GitHubBidirectionalSyncManager` (`app.ts:867–1025`): açık depo gizlilik kilidi, semantik hash kontrolü, kayıpsız birleştirme, `storage.reloadFromDiskAsync()` | Yerel: `data/cinetrack-data.json`, `data/catalog/*.json`, `data/profiles/*.json`<br>Uzak: `PUT /repos/{owner}/{repo}/contents/{path}` + SHA-256 geri okuma doğrulaması |
| `POST /api/sync/test-connection` | GitHub bağlantı testi (`forceWriteProbe`) | `persistentStore.testSafeConnectionAndProbeManifest` (`app.ts:703–716`) | Uzak: `data/catalog/manifest.json` (yalnızca probe istenirse veya depo boşsa) |
| `POST /api/sync/public-consent`<br>`POST /api/sync/public-catalog-consent` | Açık GitHub deposuna yazma onayı | Sunucu bellek içi onay bayrağı (`app.ts:648–701`) | Disk yazımı yapmaz; çalışma zamanı belleğinde onay tutar |
| `POST /api/backup/profile-export`<br>`POST /api/backup/profile-export/stream` | Gömülü posterli Excel (`.xlsx`) + JSON profil yedeği indirme / GitHub'a arşivleme | `executeProfileBackupExport` (`excel-profile-backup.ts:3162–3421`): poster önbellekleme, ZIP/XLSX ve SHA-256 doğrulaması | Yerel: `data/exports/*.json`, `data/exports/*.xlsx`, `data/cache/posters/*` (+ yeni çekilen TMDB öğeleri için katalog upsert)<br>Uzak (opsiyonel): `data/exports/*.xlsx` |

---

## 7. Mimari Karar Kayıtları (ADR) Tablosu ve Onayı

FAZ 0 envanter bulguları doğrultusunda mevcut mimariyi güvence altına alan ve sonraki fazlara (FAZ 1+) girdi oluşturan Mimari Karar Kayıtları (ADR) aşağıda doğrulanarak onaylanmıştır:

| ADR Kodu | Başlık | Karar Özeti | Kanıt / Gerekçe | Durum |
| :--- | :--- | :--- | :--- | :--- |
| **ADR-01** | **Yerel-Öncelikli (Local-First) Tek Kaynak JSON + İsteğe Bağlı Özel GitHub Eşitlemesi** | Birincil doğruluk kaynağı yerel `data/cinetrack-data.json` dosyasıdır (`127.0.0.1` dinleme + uzaktan erişimde `CINETRACK_TOKEN`). Harici bulut veritabanı (Supabase, Firebase, PostgreSQL vb.) eklenmez; cihazlar arası eşitleme yalnızca kullanıcının kendi GitHub deposu üzerinden yapılır. | Çevrimdışı tam çalışabilirlik, sıfır üçüncü taraf hesap bağımlılığı, `25 MiB` atomik `.tmp + fsync + rename` ve `7` döner yedek güvencesi (`storage.ts`, `config.ts`). | **ONAYLANDI** |
| **ADR-02** | **Kanonik Medya Anahtarı (`movie:<id>` / `tv:<id>`)** | Tüm listeler, kataloglar, `disliked`, `hidden`, `deleted_keys`, türetilmiş profil skorları ve IndexedDB depoları içerikleri `<media_type>:<id>` kanonik anahtarıyla indeksler. | TMDB film ve dizi ID uzayları çakışabildiğinden (`movie:100` !== `tv:100`), yalın sayısal ID kullanımı veri ezilmesine yol açar (`mediaKeyOf`, `cinetrack-core.ts:242`). | **ONAYLANDI** |
| **ADR-03** | **Kişisel Puan Ölçeği (`1..10 \| ''`) ve `personal_rating_cleared` Koruması** | Kullanıcı puanı şemada `1..10` aralığında sayısal değer (UI ve CSV içe aktarmada `1..10` tam sayı), puansız durumda ise kesinlikle `''` (boş dizge) olarak tutulur; puan silindiğinde `personal_rating_cleared: true` işaretlenir. Öneri motoru iç dönüşümde `5` puanı `0.0` nötr kabul eden `[-1, +1]` ölçeğini kullanır. | Canlı verideki puanlı kayıtların tamamı `1..10` tam sayıdır; `personal_rating_cleared` bayrağı çift yönlü eşitlemede silinen puanın eski kopyadan geri gelmesini engeller (`github-bidirectional-sync.ts:540–571`). | **ONAYLANDI** |
| **ADR-04** | **Zaman Damgası Semantiği (`addedAt` / `updatedAt` Korunması ve İleriki Fazda `ratedAt` / `completedAt` Ayrımı)** | FAZ 0'da şemaya dokunulmaz; `addedAt` ilk eklenme tarihini, `updatedAt` son mutasyon tarihini temsil eder. Sonraki fazda geriye dönük uyumlu (opsiyonel) `ratedAt?: string` ve `completedAt?: string` alanları eklenerek sinyal sönümlemesi, CSV `WatchedDate` ve Wrapped hesaplamaları `updatedAt` yan etkisinden arındırılacaktır. | Mevcut şemada `ratedAt`/`watchedAt`/`completedAt` bulunmadığı için eski bir kayda not eklenmesi `updatedAt` üzerinden izlenme yılını ve sinyal yaşını değiştirmektedir (`wrapped-summary.ts:116`, `exporters.ts:262`). | **ONAYLANDI** |
| **ADR-05** | **Üçlü Görünürlük ve Negatif Sinyal Ayrımı (`disliked` vs `hidden` vs `hideListedItems`)** | `preferences.disliked` hem aday havuzundan dışlayan hem de zevk vektörüne `-0.8` ceza veren açık negatif sinyaldir. `preferences.hidden` zevk vektörünü etkilemeyen nötr bastırma alanıdır (ileriki fazda UI aksiyonu bağlanabilir). `hideListedItems` ise yalnızca tarayıcıda yaşayan görünüm filtresidir. | "Bu içeriği görmek istemiyorum ama türünü seviyorum" (`hidden`) ile "Bu tarz içerikleri sevmiyorum" (`disliked`) sinyallerinin öneri kalitesini bozmaması için matematiksel ayrım zorunludur (`cinetrack-core.ts:1037, 4283–4297`). | **ONAYLANDI** |
| **ADR-06** | **Sezon Bazlı Bölüm Sayacı (`season_progress`) İlerleme Modeli** | Dizilerde bölüm ilerlemesi `1..N` sezonları için `Record<seasonNumber, watchedCount>` haritasıyla tutulur (`Season 0` hariç); eşitlemede sezon bazında `Math.max` uygulanır ve son sezon tamamlandığında `status` otomatik `'completed'` olur. | Binlerce bölümlük dizilerde JSON boyutunu şişirmeden çevrimdışı `+1 Bölüm` akışını ve sezon geçişlerini deterministik olarak çözer (`tv-progress.ts`). Bilinçli sayaç düşürme durumu ileriki fazda `updatedAt` önceliğiyle iyileştirilebilir. | **ONAYLANDI** |
| **ADR-07** | **Sürüm İmzalı Türetilmiş Önbellekler ve 13 Yalıtılmış İstemci Deposu** | Büyük ve sık değişen keşif verileri (`ct:stock`, `ct:surfaced`, `ct:series-index`, `ct:encodings`, `cinetrack-discovery-history-db` vb.) `localStorage` yerine IndexedDB depolarında tutulur; `data/profiles/<profileId>.json` ve `ct:encodings` (`ENCODING_LAYOUT_VERSION`) parmak izi / şema sürümü uyuşmadığında otomatik geçersiz kılınır. | `5 MB` `localStorage` kotası aşımını engeller ve algoritma güncellemelerinde bayat (stale) skor/vektör kullanımını sıfırlar (`idb-schema-version.ts`, `derived-profile-cache.ts`). | **ONAYLANDI** |
| **ADR-08** | **Çok Dosyalı GitHub Eşitlemesinde Semantik Hash, Blob API (`>1 MB`) ve `deleted_keys` Mezar Taşı** | GitHub eşitlemesi 4 statik JSON + dinamik `data/profiles/*.json` envanterini kapsar; `>1 MB` dosyalarda Git Blob API devreye girer, uçucu zaman damgaları `semanticHash` dışına çıkarılır, silinen kayıtlar `30` günlük `deleted_keys` mezar taşıyla korunur ve her `PUT` sonrasında SHA-256 geri okuma doğrulaması yapılır. | Canlı `data/cinetrack-data.json` dosyası `1 MB` Contents API sınırını aşabildiği için Blob API + kayıpsız birleştirme veri bütünlüğünü garanti eder (`github-bidirectional-sync.ts:2243–2407`). | **ONAYLANDI** |

---

## 8. Salt Okunur Denetim Doğrulaması

- **Değiştirilen Kaynak / Veri Dosyası Sayısı:** `0`
- **Oluşturulan Tek Çıktı Dosyası:** `/phase-0-findings.md`

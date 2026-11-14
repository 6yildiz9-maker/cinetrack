## [Unreleased]

### Güvenlik ve veri bütünlüğü
- **SEC-01:** `/api` mutasyonları gövde ayrıştırılmadan önce origin + token doğrulamasından geçiyor; SQLite arşivi geri yüklemesi artık 256 MB gövdeyi belleğe almıyor, diske akıtılıyor (sınır 256 MB, tek eşzamanlı geri yükleme).
- **DATA-01:** Çevrimdışı kuyruk yazımı IndexedDB → localStorage (geri okuma doğrulamalı) → bellek sırasıyla yapılıyor; yazma tamamlanmadan `persisted: true` dönmüyor.
- **DATA-02:** SQLite geri yükleme aşamalı: sunucu tarafında profil/kayıt sayısı doğrulanıyor, istemcide zevk haritaları ve stok kalıcılığı kontrol ediliyor; kısmi başarı artık "tam geri yükleme" olarak gösterilmiyor.
- **SEC-04:** Offline kuyrukta 5 denemeli üstel geri çekilme (2 sn → 5 dk) ve `OfflineIndicator` üzerinde "Yeniden dene" düğmesi.
- **SEC-05:** `/api/tmdb-image` artık rate limiter'a dahil; görsel önbelleği 64 MB bayt bütçeli LRU.
- **SEC-02 / SEC-03:** `ApiError` + `apiFetch` (sessionStorage token, `cinetrack:auth-required`), LAN modu için erişim anahtarı istemi, yakalanmamış söz redlerinin bildirime dönüşmesi.
- Rate limiter tahliyesi LRU'ya çevrildi (IP rotasyonu meşru istemciyi atamaz).
- Graf: `no-empty` kuralı sıkılaştırıldı (66 boş catch gerekçelendirildi), zod `^4.6.6` override'ı ve Dependabot eklendi.

### Erişilebilirlik, UX ve performans
- **UX-01:** Toast kuyruğu: mesajlar birbirini ezmiyor, hatalar `role="alert"` ve elle kapatılabilir.
- **A11Y-01/02:** `label-has-associated-control`, `click-events-have-key-events`, `no-noninteractive-tabindex`, `heading-has-content`, `control-has-associated-label` kuralları açıldı; `prefers-reduced-motion` desteği eklendi.
- **PERF-01:** Kartlarda `content-visibility: auto` ile ekran dışı boyama erteleniyor.
- **ARCH-03:** Poster çözümü tek modülde (`src/core/media/poster.ts`).
- **OPS-01:** SIGTERM/SIGINT için güvenli kapanış (zamanlayıcı temizliği, eşitleme bitişi, 10 sn zorla çıkış).
- **CI-01:** Kalite (lint/test/build), E2E ve güvenlik denetimi ayrı işler olarak `.github/workflows/ci.yml` içinde.

# Changelog

Tüm önemli değişiklikler bu dosyada tutulur. Sürümleme [Semantic Versioning](https://semver.org/) esas alır.

## [Unreleased]

### Güvenlik
- `body-parser` 2.4.0'a yükseltildi (GHSA-27r3-jxmh-p828, high DoS); CI üretim audit adımı yeniden yeşil.

### Değişen
- Monolit bölme ikinci dilim: `cinetrack-core.ts` 5539 → 4691 satır; aktör öneri motoru `actor-recommendations.ts`, puan matematiği `rating-math.ts` ve tür eşleştirme `genre-matching.ts` modüllerine taşındı. Çekirdek, geriye dönük uyumluluk için yeniden dışa aktarır.

## [1.1.0] - 2026-11-09

### Güvenlik
- Üretim CSP'si sıkılaştırıldı: `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`; dev modunda Vite HMR için ayrı politika.
- Uzak (loopback dışı) bağlanmalarda kişisel GET uçları `CINETRACK_TOKEN` ile korunuyor.
- Faz 0 bulgularındaki kişisel veriler ve `.bolt/` yapılandırması kaldırıldı.

### Değişen
- Stil sistemi tek girişe toplandı: `src/index.css` + `src/styles/*`; kök `style.css` ve ölü `tailwind.config.js` kaldırıldı.
- Film greni ve font yüklemesi tekilleştirildi.
- `--text-3` kontrastı WCAG AA'ya yükseltildi (`#7b808b`); `jsx-a11y/alt-text` kuralı hata seviyesine alındı.
- Çekirdek, aday havuzu kalıcılığından port/adaptör ile ayrıldı; halka yaşam döngüsü `ring-lifecycle.ts` modülüne taşındı.
- Kompakt kullanıcı listesi artık başlık, poster ve çıkış tarihi taşıyor; profil değişimi sırasında async sonuçlar profil kimliğiyle doğrulanıyor.
- Marka adı tek kaynağa taşındı (`src/shared/brand.ts`): PWA manifesti, HTML başlıkları, dışa aktarma dosya adları ve sunucu User-Agent değerleri buradan türetiliyor.
- ≤480px üst çubukta profil adı, Ekle etiketi ve kaynak rozeti daraltılarak yatay taşma giderildi.

### Eklenen
- Çevrimdışı değerlendirme raporuna Save@K, NDCG@K, novelty ve diversity metrikleri; deterministik `now` parametresi.
- `npm run test:taste` CI hattına eklendi.
- Playwright E2E altyapısı: çevrimdışı yeniden yükleme, sunucu çakışması, hızlı profil değişimi ve 6 çözünürlüklü responsive testleri; CI'da ayrı `e2e` işi.
- Docker imajı (`Dockerfile`) ve `.dockerignore`.
- Öneri değerlendirme raporları için etiketli (ground truth) testler.

## [1.0.0] - 2026-11-09

### Eklenen
- Taste Engine v1.0: 37 metrikli taksonomi, kanıt defteri ve güven hesaplayıcıları.
- TMDB destekli keşif, kişisel kütüphane, GitHub yedekleme ve çoklu profil desteği.

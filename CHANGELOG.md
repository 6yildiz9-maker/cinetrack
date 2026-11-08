# Changelog

Tüm önemli değişiklikler bu dosyada tutulur. Sürümleme [Semantic Versioning](https://semver.org/) esas alır.

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
- ≤480px üst çubukta profil adı, Ekle etiketi ve TVDB rozeti daraltılarak yatay taşma giderildi.

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

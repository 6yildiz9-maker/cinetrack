# CineTrack (React 19 + TypeScript + Express + PWA)

TMDB metaverileriyle çalışan, tamamen deterministik (kural tabanlı) öneri ve ilişki keşif motoruna sahip, kişisel film/dizi takip uygulaması.

## Öne Çıkan Özellikler

- **Deterministik Sana Özel Öneri Motoru (v3) & Öneri Açıklaması**: Kişisel puanlar, tamamlanan/izlenen yapımlar, favori oyuncular, yönetmenler, türler, hikâye anahtar kelimeleri ve kadro uyumundan oluşan **15 ağırlıklı sinyali** Bayesyen düzeltme ve zaman aşımıyla birleştirir; detay penceresinde *"Neden Önerildi?"* sinyal dağılımını şeffaf biçimde gösterir.
- **Yaşam Döngüsü Halkaları (`ring0` / `ring1` / `ring2`)**:
  - `ring0`: Daha önce hiç önerilmemiş taze adaylar (her yenilemede önceliklidir).
  - `ring1`: Son öneri grubunda gösterilmiş dinlendirilen adaylar (ardışık yenilemede tekrar seçilmez; arayüzde `ring0` ile ezilmeden doğru halka etiketiyle gösterilir).
  - `ring2`: Daha önce gösterilmiş ancak listeye eklenmemiş adaylar (`priorityScore` cezası alır; saf `tasteScore` / `Uyum: X/100` bozulmaz, yalnızca yeterli `ring0` olmadığında yedek olarak seçilir).
- **500 + 500 Bağımsız Aday Havuzu ve Katı Tür Ayrımı**: Film ve dizi aday havuzları birbirinden bağımsız yönetilir; `Film` modunda yalnızca filmler, `Dizi` modunda yalnızca diziler ve `Tümü` modunda 10 film + 10 dizi dengesi korunur.
- **İlişki Keşif Motoru (`relationship-v3`)**: Evren/seri (`universe`), kişi (`person`), özet/tür benzerliği (`semantic`), atmosferik yakınlık (`atmosphere`) ve karşıt ton (`contrast`) kanıtlarını zevk haritası verisini kirletmeden IndexedDB üzerinde önbellekler.
- **Zevk DNA Özeti, Ortak İzleme Kesişimi ve Yolculuk Zaman Çizelgesi**: Profil istatistiklerinde baskın dönem/tür karakteri, iki yerel profil arasında *"Birlikte Ne İzlesek?"* kesişimi ve kronolojik izleme yolculuğu.
- **Sezon Yayın Takvimi ve `.ics` Takvim Dışa Aktarma**: İzlenen dizilerin yaklaşan bölüm ve vizyon tarihlerini listeler; RFC 5545 uyumlu `.ics` dosyası üretir.
- **Atomik JSON Depolama, 7 Döner Yedek ve Çift Yönlü GitHub Senkronizasyonu**: Tüm kalıcı JSON yazımları `.tmp` + `fsync` + `rename` ile atomik yapılır; bozuk dosyalar sessizce ezilmez, `.bak` ve son 7 döner snapshot (`data/backups/`) üzerinden kurtarılır. İsteğe bağlı özel GitHub deposu entegrasyonu **Durumu denetle** (`/api/sync/inspect`), **GitHub'dan indir** (`/api/sync/pull`), **GitHub'a yükle** (`/api/sync/push`) ve **İki yönlü eşitle** (`/api/sync/reconcile`) eylemlerini ayrı ayrı sunar; ortak katalog (`data/catalog/movies.json`, `tv.json`, `manifest.json`), kişisel kullanıcı durumu (`data/cinetrack-data.json`) ve türetilmiş profilleri (`data/profiles/*.json`) varsayılan silmesiz (no-deletion) politikayla kayıpsız birleştirir, `>1 MB` dosyaları Git Blob API üzerinden tam okur ve uzak dosyaları işlem sonrası yeniden okuyarak kayıt sayısı + semantik/ham hash eşitliğini (`verifiedEqual`) doğrular.
- **PWA ve Çevrimdışı Senkronizasyon Kuyruğu**: Kurulabilir Web App Manifest, Workbox çalışma zamanı önbelleği, çevrimdışı değişiklik kuyruğu ve `ETag` / `If-Match` tabanlı `409 Conflict` veri kaybı koruması.

## Kurulum ve Çalıştırma

> **Gereksinim:** Üretim modunda (`npm start` -> `node server.ts`) yerel TypeScript çalıştırma desteği için **Node.js `>= 22.18.0`** gereklidir. Arayüz yalnızca Türkçe (`tr`) dilinde sunulmaktadır.

1. Bağımlılıkları yükleyin:
   ```bash
   npm install
   ```
2. İsteğe bağlı `.env` veya `.env.local` dosyasını oluşturun (`process.env > .env.local > .env > varsayılan` öncelik sırası uygulanır; `TMDB_API_KEY` girilmezse uygulama yerleşik örnek katalogla, `CINETRACK_GITHUB_PAT` girilmezse güvenli yerel depolama modunda çalışır):
   ```bash
   cp .env.example .env
   ```
   Desteklenen ortam değişkenleri (`.env.example`):
   - `PORT`: HTTP dinleme portu (varsayılan `3000`).
   - `CINETRACK_HOST`: Bağlanılacak ağ arayüzü (varsayılan `127.0.0.1` — yalnızca yerel makine).
   - `CINETRACK_TOKEN`: LAN / uzaktan erişimde (`CINETRACK_HOST=0.0.0.0`) zorunlu kimlik doğrulama parolası (`Authorization: Bearer <token>` veya `X-CineTrack-Token`). Loopback dışı arayüzde token tanımlanmamışsa tüm yazma ve hassas durum uç noktaları güvenli biçimde `503 auth_required` döner.
   - `CINETRACK_TRUST_PROXY`: Yalnızca güvenilir bir ters vekil (Nginx/Caddy vb.) arkasında çalışırken `true` yapılmalıdır; `false` iken sahte `X-Forwarded-For` ve `X-Forwarded-Host` başlıkları yok sayılır.
   - `CINETRACK_TMDB_RATE_LIMIT`: Loopback dışı bağlantılarda dakikadaki maksimum `/api/tmdb` istek sınırı (varsayılan `60`).
   - `TMDB_API_KEY`: Sunucu tarafı TMDB vekil anahtarı.
   - `CINETRACK_GITHUB_PAT`: İsteğe bağlı GitHub Contents API kişisel erişim belirteci (birincil değişken; geriye dönük uyumluluk için `CINETRACK_GITHUB_TOKEN` yedek olarak desteklenir).
   - `CINETRACK_DATA_OWNER`, `CINETRACK_DATA_REPO`, `CINETRACK_DATA_BRANCH`: Uzak kalıcı veri deposu hedefi.
   - `CINETRACK_DATA_REPO_IS_PUBLIC` ve `CINETRACK_ALLOW_PUBLIC_CATALOG_SYNC`: Uzak depo gerçekte `public` ise hem kişisel profil verileri hem de TMDB katalog dosyaları varsayılan olarak engellenir; açık depoya aktarım yalnızca açık onay ve TMDB atıf koşulları kabulüyle etkinleşir.
3. Geliştirme sunucusunu başlatın:
   ```bash
   npm run dev
   ```
4. Üretim derlemesi ve başlatma:
   ```bash
   npm run build
   npm start
   ```

## Doğrulama ve Test Zinciri

```bash
npm run lint     # ESLint (src + server.ts + tests) + tsc --noEmit tip denetimi
npm test         # Çekirdek, atomik depolama, profil önbelleği, GitHub senkronizasyonu, Excel yedek ve güvenlik testleri
npm run build    # Vite + PWA üretim paketi oluşturma
```

## Veri Sınırları, Metrik Notları, Güvenlik ve TMDB Koşulları

- **Tahmini İzleme Süresi Hesabı**: TMDB liste yanıtları tekil süre bilgisini her zaman içermediğinden profil istatistiklerindeki *"İzlenen Süre (tahmini)"* metriği filmler için `110 dk`, diziler için bölüm başına `45 dk` (bölüm sayısı bilinmiyorsa `10` bölüm) varsayımıyla hesaplanır.
- **Tek Kaynaklı Veri Boyutu Sınırı (`25 MB` / `26.214.400` bayt)**: Hem Express sunucusu (`PUT /api/data`), hem depolama katmanı (`src/server/storage.ts`), hem de yedek içe aktarma doğrulaması (`src/core/limits.ts` -> `DEFAULT_MAX_DATA_BYTES = 25 * 1024 * 1024`) UTF-8 bayt uzunluğu üzerinden tek bir 25 MiB sınırı kullanır.
- **Sırların İzolasyonu ve Önkoşullu Yazma**: İstemci tarafında hiçbir `VITE_` önekli sır veya anahtar kullanılmaz; `TMDB_API_KEY`, `CINETRACK_GITHUB_PAT` ve `CINETRACK_TOKEN` yalnızca sunucu katmanında okunur ve hata mesajlarından maskelenir (`[REDACTED]`). Mevcut veri revizyonu `> 0` olduğunda `PUT /api/data` yazmaları `If-Match` başlığı zorunluluğu (`428 Precondition Required`) ile yarış koşulu kayıplarına karşı korunur; silinen içerikler 30 günlük mezar taşı (`deleted_keys`) kaydıyla çift yönlü senkronizasyonda geri dirilmez.
- **TMDB Kullanım Koşulları ve Saklama Sınırları**: Katalog verileri [The Movie Database (TMDB)](https://www.themoviedb.org/) tarafından sağlanır; bu ürün TMDB tarafından onaylanmamış veya sertifikalandırılmamıştır. TMDB API kullanım koşulları, TMDB içeriklerinin genel bir veri seti veya rakip servis olarak herkese açık yeniden dağıtımına izin vermez; bu nedenle uzak GitHub eşitlemesi varsayılan olarak yalnızca özel (`private`) depolarla çalışacak biçimde sınırlandırılmıştır.

## Lisans

Bu proje **MIT Lisansı** altında lisanslanmıştır. Üçüncü taraf içerik ve poster metaverileri TMDB kullanım koşullarına tabidir.

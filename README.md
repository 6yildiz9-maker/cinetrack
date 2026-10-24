# CineTrack (React 19 + TypeScript + Express + PWA)

TMDB metaverileriyle çalışan, tamamen deterministik (kural tabanlı) öneri ve ilişki keşif motoruna sahip, kişisel ve yerel (`127.0.0.1:3000`) film/dizi takip uygulaması.

## Öne Çıkan Özellikler

- **Deterministik Sana Özel Öneri Motoru (v3) & Öneri Açıklaması (Explain Recommendation)**: Kişisel puanlar, tamamlanan/izlenen yapımlar, favori oyuncular, yönetmenler, türler, hikâye anahtar kelimeleri ve kadro uyumundan oluşan **15 ağırlıklı sinyali** Bayesyen düzeltme ve zaman aşımıyla birleştirir; detay penceresinde *"Neden Önerildi?"* sinyal dağılımını şeffaf biçimde gösterir.
- **Yaşam Döngüsü Halkaları (`ring0` / `ring1` / `ring2`)**:
  - `ring0`: Daha önce hiç önerilmemiş taze adaylar (her yenilemede önceliklidir).
  - `ring1`: Son öneri grubunda gösterilmiş dinlendirilen adaylar (ardışık yenilemede tekrar seçilmez).
  - `ring2`: Daha önce gösterilmiş ancak listeye eklenmemiş adaylar (`priorityScore` cezası alır; saf `tasteScore` / `Uyum: X/100` bozulmaz, yalnızca yeterli `ring0` olmadığında yedek olarak seçilir).
- **500 + 500 Bağımsız Aday Havuzu**: Film ve dizi aday havuzları birbirinden bağımsız yönetilir; `Tümü` modunda 10 film + 10 dizi dengesi korunur.
- **İlişki Keşif Motoru (`relationship-v3`)**: Evren/seri (`universe`), kişi (`person`), özet/tür benzerliği (`semantic`), atmosferik yakınlık (`atmosphere`) ve karşıt ton (`contrast`) kanıtlarını zevk haritası verisini kirletmeden IndexedDB üzerinde önbellekler.
- **Zevk DNA Özeti, Ortak İzleme Kesişimi ve Yolculuk Zaman Çizelgesi**: Profil istatistiklerinde baskın dönem/tür karakteri, iki yerel profil arasında *"Birlikte Ne İzlesek?"* kesişimi ve kronolojik izleme yolculuğu.
- **Sezon Yayın Takvimi ve `.ics` Takvim Dışa Aktarma**: İzlenen dizilerin yaklaşan bölüm ve vizyon tarihlerini listeler; RFC 5545 uyumlu `.ics` dosyası üretir.
- **Letterboxd / IMDb CSV ve 7 Döner Sunucu Yedeği**: CSV içe/dışa aktarma, JSON yedekleme ve sunucu tarafında son 7 anlık görüntüyü (`data/backups/`) atomik geri yükleme + ani öğe düşüşü koruması (`sudden_item_drop`).
- **PWA ve Çevrimdışı Senkronizasyon Kuyruğu**: Kurulabilir Web App Manifest, Workbox çalışma zamanı önbelleği, çevrimdışı değişiklik kuyruğu ve `ETag` / `If-Match` tabanlı `409 Conflict` veri kaybı koruması.

## Kurulum ve Çalıştırma (Sıfır Zorunlu Ortam Değişkeni)

1. Bağımlılıkları yükleyin:
   ```bash
   npm install
   ```
2. Canlı TMDB kataloğu için isteğe bağlı `.env` dosyasını oluşturup yalnızca `TMDB_API_KEY` değerini ekleyin (`TMDB_API_KEY` girilmezse uygulama yerleşik örnek katalogla çalışır):
   ```bash
   cp .env.example .env
   ```
3. Geliştirme sunucusunu başlatın (`http://127.0.0.1:3000`):
   ```bash
   npm run dev
   ```
4. Üretim derlemesi ve başlatma (`--omit=dev` uyumlu, Node.js yerel TypeScript desteğiyle):
   ```bash
   npm run build
   npm start
   ```

## Doğrulama ve Test Zinciri

```bash
npm run lint     # ESLint + tsc --noEmit tip denetimi
npm test         # Çekirdek, golden skorlama, ilişki grafiği ve entegrasyon testleri
npm run build    # Vite + PWA üretim paketi oluşturma
```

## Mimari ve Yerel Güvenlik Notları

- Uygulama varsayılan olarak yalnızca yerel geri döngü arayüzünde (`CINETRACK_HOST = '127.0.0.1'`, port `3000`) çalışır.
- İstemci tarafında hiçbir `VITE_` önekli sır veya anahtar kullanılmaz; `TMDB_API_KEY` yalnızca sunucu tarafındaki `/api/tmdb` vekil katmanında okunur ve istemci paketine (`dist/`) asla gömülmez.
- Yazma uçları (`PUT /api/data`, `POST /api/data/restore`) 2 MB sabit JSON boyut sınırından (`maxDataBytes = 2_000_000`), çapraz kaynak (`Origin`) kontrolünden, `If-Match` revizyon denetiminden ve ani öğe düşüşü korumasından geçer.
- Katalog verileri [The Movie Database (TMDB)](https://www.themoviedb.org/) tarafından sağlanır; bu ürün TMDB tarafından onaylanmamış veya sertifikalandırılmamıştır.

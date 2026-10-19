# CineTrack (React + TypeScript)

TMDB destekli modern ve kişisel film ve dizi takip uygulaması. React 19, TypeScript, Express ve Vite ile yeniden yazılmıştır.

## Özellikler

- **Canlı TMDB Kataloğu**: Güncel trendler, popüler filmler ve diziler, yüksek puanlı yapımlar, yakında ve yayında olan içerikler.
- **Canlı Arama & Typeahead**: Arama kutusuna yazıldıkça anlık eşleşmeler, afişler ve izleme durumu rozetleriyle gösterilir.
- **Sana Özel Öneri Motoru**: Kişisel puanlarınız, tamamlanan/izlenen içerikler, sevilen oyuncular ve yönetmenler, türler, hikâye anahtar kelimeleri ve kadro uyumu gibi 15 sinyali birleştiren kişiselleştirilmiş öneriler.
- **Çoklu Profil Yönetimi**: Yerel profiller oluşturabilir, profiller arasında geçiş yapabilir, her profil için ayrı izleme listesi ve öneri tercihleri tutabilirsiniz.
- **Bölüm ve Sezon Takibi**: Dizilerde sezon ve bölüm bazlı izleme ilerlemesi, tamamlanma yüzdesi ve sıradaki bölüm göstergesi.
- **Türkiye Yayın Platformları**: Netflix, Prime Video, Disney+, BluTV gibi platform filtreleri ve içerik detaylarında nerede izlenebileceği bilgisi.
- **Kişisel Puanlama & Durumlar**: 10 üzerinden kişisel puanlama, "İzliyorum", "İzlenecek", "Tamamlandı" durumları.
- **Yayın Hatırlatıcıları**: Takip ettiğiniz yapımların yeni bölüm veya çıkış tarihine 3 gün veya daha az kaldığında bildirim gönderme.
- **Yedek Alma ve İçe Aktarma**: JSON biçiminde dışa aktarma, mevcut listeyle birleştirme veya üzerine yazma seçenekleriyle içe aktarma.
- **Özel İçerik Ekleme**: TMDB'de yer almayan yapımları özel afiş, yıl ve puanla listenize ekleyebilme.

## Geliştirme ve Çalıştırma

1. Node.js kurulu olduğundan emin olun. Windows'ta uygulamayı başlatmak için proje klasöründeki `start.bat` dosyasına çift tıklayın; eksik npm paketleri otomatik yüklenir. Sonra tarayıcıda `http://127.0.0.1:3000` adresini açın. Mac/Linux için:
   ```bash
   npm install
   npm run dev
   ```
2. İsteğe bağlı: TMDB_API_KEY olmadan uygulama demo modunda çalışır. Canlı TMDB verileri için ortam değişkenlerini ayarlayın:
   ```bash
   cp .env.example .env
   ```
   Uygulama varsayılan olarak yalnızca bu bilgisayardan `http://127.0.0.1:3000` adresinde erişilebilir.
   Yerel ağ üzerinden erişimi özellikle etkinleştirmek için `CINETRACK_HOST=0.0.0.0` ayarlayın; bu durumda profil verilerinize ağdaki cihazlar erişebilir.
3. Derleme:
   ```bash
   npm run build
   ```
4. Testleri çalıştırma:
   ```bash
   npm test
   ```
5. Tip kontrolü (lint):
   ```bash
   npm run lint
   ```

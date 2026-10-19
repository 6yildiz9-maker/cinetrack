# CineTrack (React + TypeScript)

TMDB destekli modern ve kişisel film ve dizi takip uygulaması. React 19, TypeScript, Express ve Vite ile yeniden yazılmıştır.

## Özellikler

- **Canlı TMDB Kataloğu**: Güncel trendler, popüler filmler ve diziler, yüksek puanlı yapımlar, yakında ve yayında olan içerikler.
- **Canlı Arama & Typeahead**: Arama kutusuna yazıldıkça anlık eşleşmeler, afişler ve izleme durumu rozetleriyle gösterilir.
- **Sana Özel Öneri Motoru**: Kişisel puanlarınız, tamamlanan içerikler, sevilen oyuncular ve yönetmenler baz alınarak hesaplanan 7 bileşenli Bayes ve zevk profili önerileri.
- **Çoklu Profil Yönetimi**: Yerel profiller oluşturabilir, profiller arasında geçiş yapabilir, her profil için ayrı izleme listesi ve öneri tercihleri tutabilirsiniz.
- **Bölüm ve Sezon Takibi**: Dizilerde sezon ve bölüm bazlı izleme ilerlemesi, tamamlanma yüzdesi ve sıradaki bölüm göstergesi.
- **Türkiye Yayın Platformları**: Netflix, Prime Video, Disney+, BluTV gibi platform filtreleri ve içerik detaylarında nerede izlenebileceği bilgisi.
- **Kişisel Puanlama & Durumlar**: 10 üzerinden kişisel puanlama, "İzliyorum", "İzlenecek", "Tamamlandı" durumları.
- **Yayın Hatırlatıcıları**: Takip ettiğiniz yapımların yeni bölüm veya çıkış tarihine 3 gün veya daha az kaldığında bildirim gönderme.
- **Yedek Alma ve İçe Aktarma**: JSON biçiminde dışa aktarma, mevcut listeyle birleştirme veya üzerine yazma seçenekleriyle içe aktarma.
- **Özel İçerik Ekleme**: TMDB'de yer almayan yapımları özel afiş, yıl ve puanla listenize ekleyebilme.

## Geliştirme ve Çalıştırma

1. Ortam değişkenlerini ayarlayın (isteğe bağlı, TMDB_API_KEY olmadan demo modunda çalışır):
   ```bash
   cp .env.example .env
   ```
2. Geliştirme sunucusunu başlatın:
   ```bash
   npm run dev
   ```
   Uygulama `http://0.0.0.0:3000` adresinde çalışacaktır.
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

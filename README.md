# CineTrack

## Yerel çalıştırma

1. Proje klasöründeki `.env.example` dosyasını `.env.local` adıyla kopyalayın.
2. `.env.local` dosyasını açıp `TMDB_API_KEY=` satırının sonuna kendi TMDB anahtarınızı yazın. Anahtarı HTML dosyasına eklemeyin.
3. `start.bat` dosyasını çalıştırın. Açılan `http://127.0.0.1:4173` adresinde canlı katalog görünür.

Node.js 18 veya üstü gerekir. Yerel sunucu TMDB anahtarını tarayıcıya göndermeden onaylı TMDB isteklerini iletir. `.env.local` dosyasını veya yerel sunucuyu internette yayımlamayın. Farklı bir bağlantı noktası gerekirse `CINETRACK_PORT` ortam değişkeniyle sunucuyu başka bir portta çalıştırabilirsiniz; varsayılan 4173'tür.

## Testler

Paylaşılan çekirdek mantık (`cinetrack-core.js`); yedek doğrulama, birleştirme çakışmaları, profil değişiminde istek iptali (yarış durumu), hatırlatıcı tarih doğrulaması, sunucu veri dosyası normalizasyonu (çok profilli belge, eski biçim taşıma, prototip kirliliği) ve öneri puanlama motoru (aday havuzu, Bayes puanı, zevk profili, çok bileşenli skor, tür çeşitlendirmesi) için birim testleriyle korunur:

```
npm test
```

## Profil hafızası ve kayıt yeri

Profiller, izleme listeleri ve öneri tercihleri proje klasöründeki `data/cinetrack-data.json` dosyasına kaydedilir; tarayıcı depolaması yalnızca önbellek olarak kullanılır.

- Her değişiklikte sunucu, önceki dolu dosyayı `data/cinetrack-data.bak.json` olarak yedekler; yazma işlemi önce geçici dosyaya yapılıp sonra adlandırılarak tamamlanır (dosya yarıda bozulmaz). Ana dosya okunamazsa sunucu yedeği dener.
- Sunucu kapalıyken yapılan değişiklikler tarayıcıda tutulur; sayfa yenilendiğinde veya sunucu bir sonraki açılışta değişiklikler dosyaya aktarılır. Yazma başarısız olursa sayfa sağ üstteki uyarı ve Profil penceresindeki durum satırıyla bildirir.
- Eski tek profilli `version: 1` sunucu dosyası ilk okumada çok profilli `version: 3` biçimine taşınır; `data/` klasörü `.gitignore`dadır, kişisel listeniz depoya girmez.
- Kayıt yeri bu bilgisayardır: profil verisi sunucuya yüklenmez, cihazlar arası eşitleme yapılmaz. Aynı dosyaya aynı anda iki tarayıcıdan yazmak son yazanın geçerli olmasıyla sonuçlanır.

Eski `file://` kopyasındaki veriyi taşımak için eski sayfada Profil > Yerel yedeği indir, yeni sunucudaki sayfada Profil > Yedekten içe aktar adımlarını kullanabilirsiniz.

Birden fazla profil Profil penceresinden oluşturulabilir ve değiştirilebilir; her profilin listesi ve öneri tercihleri ayrı saklanır ve `data/cinetrack-data.json` içinde birlikte tutulur. Yedek dosyası etkin profilin listesini ve öneri ayarlarını taşır; içe aktarırken mevcut listenin üzerine yazma veya birleştirme seçilebilir. Birleştirmede daha yeni kayıtta kişisel puan boşsa bu yalnızca kayıtta bilinçli temizleme işareti (`personal_rating_cleared`) varsa eski puanı siler; aksi hâlde eksik veri sayılır ve eski puan korunur. Bu koruma sunucu dosyasına yazılan kayıtlar için de geçerlidir.

## Keşif ve öneriler

- **Sana özel** hibrit bir öneri motoru kullanır: tüm kataloğu indirmek yerine TMDB'den 500–2000 adaylık bir havuz toplar (sevdiğiniz yapımların önerileri ve benzerleri, sık izlediğiniz oyuncuların film/dizileri, sevdiğiniz türler; havuz dolmazsa popüler ve trend yapımlarla desteklenir) ve üç katmanda işler: harici TMDB API'si, 30 dakikalık küçük yerel önbellek ve izleme geçmişinizden kurulan kişisel zevk profili.
- Adaylar yedi bileşenle puanlanır: tür ve hikâye uyumu (%25), kişisel zevk tahmini (%20), oyuncu uyumu (%20), genel içerik kalitesi (%15), yönetmen/ekip (%8), Türkiye'de platformda izlenebilirlik (%7) ve keşif/çeşitlilik (%5).
- Oyuncu puanlaması üç katmanlıdır: genel popülarite, izleme geçmişinizden hesaplanan kişisel oyuncu puanı (tür bazlı ayrımlıdır; örn. bilim kurguda sevdiğiniz oyuncu romantik komedide aynı avantajı kazanmaz) ve rol önemi (başrol ağırlığı daha yüksektir). Sonuç listesi tek türde yoğunlaşmasın diye tür üst sınırıyla çeşitlendirilir.
- Her kartta neden önerildiğini anlatan etiketler görünür ("... sevdiğin için", "Sevdiğin X oynuyor", "Tercih ettiğin platformda izlenebilir" gibi); Türkiye bölgesindeki yayın platformları TMDB Watch Providers verisinden kontrol edilir. Sonuç, profil veya liste değişmedikçe önbellekten anında gösterilir.
- Öneri ayarlarından tercih edilen platformları ve ruh hâlini seçebilir, karttaki **İlgilenmiyorum** eylemiyle içerikleri gelecekteki keşif ve önerilerden gizleyebilirsiniz.
- **Keşfedilmemiş mücevherler**, son 15 yıl içinden en az 7 puanlı, 200–3000 oy aralığındaki yapımları öne çıkarır.
- **Yakında**, yaklaşan filmleri ve yayındaki dizileri gösterir. Detaylardaki oyuncu kartlarından biyografi ve en çok öne çıkan film/dizi kredilerine ulaşabilirsiniz.
- Dizi detaylarında sezon bazlı bölüm takibi yapılır: her sezon için izlenen bölüm sayısı ayrı ayrı kaydedilir; “İzliyorum” durumundaki yapım ana ekrandaki devam kartında görünür. Türkiye yayın sağlayıcıları TMDB Watch Providers verisinden listelenir.
- Keşfet, arama ve kategori ekranları ilk sayfayla sınırlı değildir; listenin sonundaki **Daha fazla yükle** düğmesi TMDB'nin sonraki sayfalarını getirir.
- Yayın hatırlatıcıları tarayıcı bildirimi izni ister ve uygulama açıkken takip edilen dizilerde TMDB'nin `next_episode_to_air` verisine göre yeni bölüme üç gün veya daha az kaldığında (filmlerde çıkış tarihine göre) bildirim gösterebilir. Takvim verisi uygulama açıkken aralıklarla tazelenir. Tarayıcı kapalıyken arka plan bildirimi veya cihazlar arası eşitleme yapılmaz.

Bu katalog istekleri, kişi bilgileri ve öneri/benzer içerik uç noktaları anahtarı tarayıcıya vermeyen yerel TMDB proxy'sinden geçirilir. Öneri tercihleri için oyuncu kredileri istek sırasında alınır; krediler ve fragman verileri yerel izleme listesine kaydedilmez.

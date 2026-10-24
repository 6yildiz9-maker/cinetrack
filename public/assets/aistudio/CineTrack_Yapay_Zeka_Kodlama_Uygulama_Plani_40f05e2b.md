# CineTrack --- Yapay Zekâ Kodlama Ajanı İçin Uygulama Planı

## Amaç

Bu plan, CineTrack kodunu küçük, test edilebilir ve geri alınabilir
adımlarla iyileştirmek içindir. Bütün maddeleri tek seferde uygulama.
Her fazın kabul kriterlerini doğrula ve raporla.

**Önemli:** Bu belgede geçen mevcut durum iddialarını güncel depoda
yeniden kontrol et. Dosya boyutu, satır sayısı, paket sürümü veya
geçmişte doğrulanmış bir sorun artık farklı olabilir. Kod incelemesi
yapmadan değişiklik uygulama.

## Genel çalışma kuralları

1.  Başlamadan önce dalı, çalışma ağacını, son commit'i, `package.json`,
    lockfile, CI workflow'ları ve ilgili kaynak/test dosyalarını incele.
2.  Kullanıcının mevcut değişikliklerini ezme. Çalışma ağacı temiz
    değilse ilgili dosyalardaki değişiklikleri koru.
3.  Önce mevcut davranışı testle sabitle; sonra değiştir; ardından
    hedefli testleri ve regresyon testlerini çalıştır.
4.  Başarısız testleri silme veya kapsamını daraltarak yeşile çevirme.
    Önceden var olan hatalarla yeni hataları ayır.
5.  Testler çalıştırılmadıysa başarılı olduklarını söyleme. Her raporda
    komutu ve gerçek sonucu belirt.
6.  Veri migrasyonu, kalıcı veri biçimi veya kimlik doğrulama
    değişikliklerinde yedekleme ve geriye dönük uyumluluğu ele al.
7.  Her fazda yalnızca ilgili kapsamı değiştir. Büyük refaktörleri hata
    düzeltmeleriyle aynı değişiklik grubuna katma.
8.  Yeni bağımlılık eklemeden önce mevcut araçlarla çözüm olup
    olmadığını değerlendir; paket sürümlerini kanıtsız değiştirme.
9.  Gereksinim belirsizse varsayımı açıkla. Veri kaybı, güvenlik ve
    öneri davranışına ilişkin belirsizlikleri sessizce karara bağlama.
10. Her faz sonunda dosya bazında değişiklikleri, test sonuçlarını,
    kabul kriterlerini, riskleri ve kalan işleri raporla.

## Faz 0 --- Depoyu ve başlangıç durumunu doğrula

**Amaç:** Planı güncel kodla karşılaştırıp gerçek başlangıç durumunu
belirlemek.

-   Dalı, son commit'i, çalışma ağacını ve paket yöneticisini belirle.
-   `package.json`, lockfile, CI, `server.ts`,
    `src/core/cinetrack-core.ts`, `src/App.tsx`,
    `src/core/relationship-explorer.ts`,
    `src/services/relationship-cache.ts` ve ilgili testleri incele.
-   Mevcut komutları belirle ve uygunsa çalıştır: kurulum,
    lint/typecheck, test, build, start ve smoke test.
-   Plandaki her iddiayı `Doğrulandı`, `Kısmen mevcut`, `Doğrulanmadı`,
    `Artık gerekli değil` veya `Karar gerekiyor` olarak sınıflandır.
-   Dosya/konum ve kanıt olmadan bir iddiayı doğrulanmış sayma.

**Kabul kriterleri:** Başlangıç test sonuçları, doğrulanmış sorunlar,
ilgili dosyalar ve ortam kısıtları raporlanmış olmalı. Bu fazda zorunlu
olmadıkça ürün kodunu değiştirme.

## Faz 1 --- CI ve üretim başlatma zinciri

**Amaç:** Kurulum, test ve üretim başlatma adımlarını güvenilir kılmak.

-   ESLint ve `@eslint/js` sürümlerini yapılandırmayla uyumluluk
    açısından incele. Sürüm düşürme/yükseltme yalnızca kanıtlanmış
    uyumsuzluğu çözecekse yap.
-   `package.json` ile kullanılan lockfile uyumunu doğrula; paket
    yöneticisini değiştirme.
-   CI zincirini şu sırayla doğrula: temiz kurulum → lint/typecheck →
    test → build → smoke test.
-   `npm start` ve `start.bat` komutlarını kontrol et. Üretim başlatma
    akışı geliştirme sunucusuna dayanmamalı.
-   `vite` gibi geliştirme bağımlılıklarının üretim başlangıcında statik
    yüklenip yüklenmediğini incele; destekleniyorsa `--omit=dev`
    senaryosunu test et.
-   `npm audit` bulgularını raporla; audit'i CI'ı bloklayan kapıya
    dönüştürmeyi ayrıca gerekçelendir.

**Kabul kriterleri:** Gerçek kurulum/CI zinciri geçiyor veya engeller
belgeleniyor; üretim başlangıcı test ediliyor.

## Faz 2 --- Zevk haritası anahtar migrasyonu

**Amaç:** Eski anahtarları (`movie-123`) standart biçime (`movie:123`)
dönüştürürken geçmiş veriyi korumak.

İncelenecek alanlar: - `entries` - `archivedEntries` - her kaydın
`mediaKey` alanı - `lastRecommendedKeys` - ilgili cache ve kalıcı veri
yükleme/kaydetme yolları

Uygulama: 1. `parseMediaKey` ve `makeMediaKey` davranışlarını doğrula.
2. Tüm geçerli anahtarları tek kanonik biçime dönüştür. 3. Aynı kanonik
anahtara dönüşen kayıtları, geçmişi kaybetmeden birleştir. 4.
`shownCount`, `skippedCount`, `ringDemotions`, `demotionPenalty`,
`lastShownAt`, `impressionHistory` ve kullanıcı durumlarının her biri
için birleştirme kuralı tanımla. Sayaçları körlemesine toplama;
yinelenen olayların iki kez sayılmasını önle. 5. `entries` ile
`archivedEntries` çakışmalarını mevcut semantiğe göre ele al; birini
otomatik silme. 6. `lastRecommendedKeys` listesini de kanonikleştir;
geçersiz anahtarları güvenli ele al. 7. Migrasyonun tekrar
çalıştırıldığında veri değiştirmediğini (idempotence) doğrula.

Testler: eski/yeni/karışık anahtarlar, yinelenen kayıt, bozuk anahtar,
geçmişli kayıt, arşiv çakışması ve migrasyonun ikinci çalıştırılması.

**Kabul kriterleri:** Eski kayıtlar doğru bulunuyor; sayaç ve geçmiş
kaybolmuyor; çakışmalar tanımlı kuralla çözülüyor; migrasyon tekrar
çalıştırılabiliyor.

## Faz 3 --- Öneri havuzu ve ring davranışı

**Amaç:** Yeni adaylara öncelik vermek ve son gösterilen öğelerin
yanlışlıkla tekrar seçilmesini önlemek.

İş kuralları: - `ring0`: Daha önce gösterilmemiş aday. - `ring1`: Son
öneri grubunda gösterilmiş aday; sonraki yenilemede seçilmemeli. -
`ring2`: Daha önce gösterilmiş, ancak kullanıcı tarafından listeye
alınmamış veya açıkça olumsuz işaretlenmemiş aday; yalnızca yeterli
`ring0` yoksa yedek olabilir. - Kullanıcı durumlarıyla dışlanan
içerikler öneri havuzuna geri dönmemeli. - Film-only ve TV-only modları
yalnızca seçili türden aday üretmeli. - Ring durumu yalnızca skordan
türetilmemeli; gösterim geçmişi ve son öneri anahtarları esas
alınmalı. - Cache veya UI eşlemesi `ring1`/`ring2` değerlerini
yanlışlıkla `ring0` yapmamalı. - `forceRefresh` gerçekten öneri
cache'ini atlıyor mu test et. - Ceza ağırlıklarını ürün kuralı ve test
olmadan değiştirme.

Zorunlu uçtan uca senaryo: 1. Öneri grubu gösterilir. 2. Kullanıcı
öğeleri hiçbir listeye eklemez. 3. Yenileme yapılır. 4. Yeterli `ring0`
varsa yeni adaylar önce gelir. 5. Önceki grubun `ring1` öğeleri sonraki
gruba girmez. 6. `ring0` yetersizse yalnızca eksik kısmı `ring2` ile
tamamlanabilir. 7. İkinci/üçüncü yenilemede de davranış doğrulanır. 8.
Film-only, TV-only, favori oyuncu değişimi ve profil izolasyonu test
edilir.

**Kabul kriterleri:** Yeterli `ring0` varken `ring2` seçilmiyor; `ring1`
bir sonraki gruba girmiyor; UI, kalıcı veri ve seçim motoru aynı ring
durumunu görüyor.

## Faz 4 --- API yazma güvenliği ve veri kaybı önlemleri

**Amaç:** Çakışan yazmaları, bozuk payload'ları ve yanlışlıkla veri
silinmesini güvenli ele almak.

### Revizyon/çakışma

-   Sunucuya revizyon veya sürüm kontrolü ekle; istemci son okuduğu
    sürümü yazma isteğiyle iletsin (`If-Match` veya belgelenmiş
    eşdeğer).
-   Çakışmada `409 Conflict` veya API sözleşmesinde seçilen eşdeğer
    yanıt dön.
-   İstemci yeni sunucu verisini sessizce ezmemeli.
-   Birleştirme stratejisini veri alanlarının semantiğine göre belirle;
    JSON nesnelerini körlemesine birleştirme.

### Ani veri azalması ve yedekler

-   Beklenmedik öğe sayısı düşüşünü saptayan doğrulama ekle; geçerli
    toplu silme/içe aktarmayı yanlışlıkla engelleme.
-   Şüpheli yazmayı reddet veya açık onay gerektiren akışa yönlendir.
-   Tek `.bak` yerine sınırlı saklama süresine sahip döner snapshot
    tasarla; örneğin 7 günlük saklamayı disk kullanımıyla doğrula.
-   Snapshot alma zamanını, atomik yazmayı ve geri yükleme yolunu
    belirle.

### Boyut ve veri doğrulama

-   `maxDataBytes` gerçek Express body parser limitine bağlanmalı.
-   Limit aşımında `413 Payload Too Large` dönmeli ve istemci anlaşılır
    hata göstermeli.
-   İstek boyutu kontrolüyle JSON şema/alan doğrulamasını ayrı tut.
-   Bilinmeyen alanları mevcut veri sözleşmesine göre ele al.

### Güvenlik

-   `CINETRACK_TOKEN`, `Host`, CORS, origin/CSRF, kimlik doğrulama ve
    proxy yapılandırmasını gerçek dağıtım modeline göre incele.
-   `Host` kontrolünü kimlik doğrulama yerine kullanma.
-   Sırları istemci bundle'ına veya loglara yazma.
-   Dağıtım öncesi güvenlik gereksinimlerini ve ortam değişkenlerini
    belgelemeyi tamamla.

**Kabul kriterleri:** Eski revizyon yeni veriyi sessizce ezmiyor; limit
ve doğrulamalar test ediliyor; yedek/geri yükleme çalışıyor; yazma
uçlarının güvenlik modeli belgeli.

## Faz 5 --- Sunucu ve TMDB HTTP sağlamlığı

-   `normalizeDataDocument`, parametre doğrulama, allowlist, boyut
    limitleri ve hata yanıtlarına birim testleri ekle.
-   TMDB proxy'ye uygun rate limit uygula. Dakikada 60 istek başlangıç
    varsayımıdır; gerçek kullanım ve servis koşullarıyla doğrula.
-   `api.ts` sınırında TMDB yanıtlarını runtime şema doğrulamasından
    geçir. Projede Zod varsa kullan; yeni bağımlılığı gerekçelendir.
-   Mock-fetch ile `429`, `500`, timeout, bozuk JSON ve beklenmeyen alan
    senaryolarını test et.
-   `/tv/{id}/season/{n}` allowlist desteğini yalnızca sezon/bölüm
    özelliği gerçekten kapsamdaysa ekle.
-   TMDB kimlik doğrulamasını tek ve tutarlı yerde uygula; sırları
    istemciye sızdırma.
-   Favori oyuncu, `DIRTY_KEY`, içe/dışa aktarma ve profil izolasyonu
    için regresyon testleri ekle.

**Kabul kriterleri:** HTTP hata durumları kontrollü; geçersiz yanıt
çökme yaratmıyor; rate limit/allowlist testli; favori oyuncu verisi
içe/dışa aktarmada korunuyor.

## Faz 6 --- İlişki Keşif Motoru ve cache ayrımı

**Amaç:** İlişki grafiği cache'inin zevk haritasını veya öneri havuzunu
değiştirmediğini garanti etmek.

-   `relationship-explorer.ts`, `RelationshipExplorer.tsx` ve
    `relationship-cache.ts` akışını incele.
-   Cache anahtarlarının profil, kaynak medya, filtre ve gerekiyorsa
    algoritma sürümünü doğru ayırdığını test et.
-   İlişki cache'i ile zevk haritasının kalıcı verisinin ayrı yazma
    yollarında olduğunu doğrula.
-   Kaynak/filtre değişince eski sonuçların ve seçili düğümün
    temizlenmesini test et.
-   `relationshipDetails` içindeki birden fazla ilişki türünün cache/UI
    boyunca korunduğunu doğrula.
-   Mevcut semantik eşleştirmenin kelime ve tür/genre örtüşmesine
    dayanıyorsa bunu doğru belgeleyip embedding/LLM gibi sunma.
-   Atmosfer, kavramsal bağ ve karşıt fikir türlerini eklemeden önce her
    tür için tanım, kanıt kaynağı, güven düzeyi ve açıklama modeli
    belirle.
-   Kademeli TMDB çekme ve görsel grafik değişikliklerini veri
    doğruluğundan ayrı ele al.

**Kabul kriterleri:** İlişki cache'i zevk haritasını değiştirmiyor;
profil/kaynak/filtre değişimi eski grafiği göstermiyor; ilişki türleri
kaybolmuyor.

## Faz 7 --- UX ve erişilebilirlik

-   Kart ve detay panelinde puanı tutarlı göster: `Uyum: X/100` (gerçek
    puan aralığını doğrula).
-   Havuz yenilemesinde görünür durum/ilerleme göster; gerçek ölçüm
    yoksa sahte yüzde üretme.
-   `ring2` ve "İlgilenmiyorum" geri bildirimlerinin ceza puanlarına
    etkisini mevcut skor modeli üzerinden tanımla ve sabit girdili
    testle doğrula.
-   Oyuncu verisini seçici yenilemeyi yalnızca cache geçersizleştirme
    kuralları netse uygula.
-   Türkçe özet boşsa İngilizceye düşme davranışını doğrula; boş yanıt,
    hata ve bulunmayan içeriği ayır.
-   Klavye kısayolları varsa input/textarea/düzenlenebilir alanlar
    odaktayken devre dışı bırak.
-   Modal, arama, filtre ve grafik akışlarını klavye/ekran okuyucuyla
    kontrol et.
-   `prefers-reduced-motion` desteğini doğrula; gerekirse ekle.
-   Hover kartlarındaki bilgilere klavye ve dokunmatik kullanımda da
    erişim sağla.

**Kabul kriterleri:** Puan gösterimi tutarlı; yenileme durumu anlaşılır;
temel işlevler yalnızca hover/fareye bağlı değil; azaltılmış hareket ve
klavye erişimi testli.

## Faz 8 --- Mimari parçalama ve performans

Bu faza yalnızca çekirdek davranış testleri güvenilir çalışıyorsa geç.
Her refaktörü ayrı ve küçük değişiklik olarak yap.

Önerilen sıra: 1. `cinetrack-core.ts` içindeki `engine`, `taste`,
`relationship`, `persist` sorumluluklarını ayır. 2. `server.ts`
dosyasını routes/services/config ve mock veri sorumluluklarına böl. 3.
`App.tsx` içindeki state sahipliği netleşince `useWatchlist`,
`useDiscover`, `useTasteProfile` gibi hook'lar çıkar. 4.
`tests/core.test.mjs` dosyasını alanlarına göre böl. 5. `style.css`
dosyasını bileşen bazlı stillere ayır. 6. `MediaGrid` sanallaştırmasını
gerçek performans ölçümü gerektiriyorsa ekle. 7. Öneri hesabını Web
Worker'a yalnızca profil ölçümü darboğaz gösteriyorsa taşı.

**Kabul kriterleri:** Her küçük adımın ardından test/build geçiyor;
kullanıcı davranışı ve dış API korunuyor veya değişiklik belgeleniyor;
performans iyileştirmesi ölçümle destekleniyor.

## Faz 9 --- PWA, offline ve i18n

-   PWA eklemeden önce IndexedDB ve cache yaşam döngüsünü incele.
-   Çevrimdışı görüntüleme ile çevrimdışı düzenleme/senkronizasyonu
    ayır. Çakışma politikası olmadan offline yazma açma.
-   `vite-plugin-pwa` eklenirse hangi ekranların offline çalışacağını
    açıkça tanımla.
-   Afiş cache/proxy kararını depolama, güncellik ve TMDB koşulları
    açısından incele.
-   i18n altyapısı ile emoji ikonlarını SVG sprite'a taşıma işini ayrı
    değişikliklerde yap.

**Kabul kriterleri:** Offline davranış belgeli ve testli; veri
çakışmaları sessizce kaybolmuyor; cache saklama/temizleme kuralları
tanımlı.

## Faz 10 --- Ölçüm ve ürün özellikleri

Ölçüm altyapısı: - Gösterim/etkileşim olaylarını ring sayaçlarıyla
ilişkilendir; gizlilik ve saklama kurallarını tanımla. - Sabit
değerlendirme kümesiyle öneri sürümlerini karşılaştır. -
`computeWeightsSignature` ve ağırlık kalibrasyonunu yeterli veri varsa
kullan. - Cache hit/miss ölçümü ekle. - Embedding/öğrenilmiş sıralama
için yeterli veri, offline değerlendirme ve geri dönüş planı olmadan
model ekleme.

Ürün özelliklerini ayrı işlere böl: - Taste DNA paneli ve her öneri için
2--3 güçlü sinyalin açıklaması. - İstatistik Paneli v2 / yıl sonu
özeti. - Sezon takvimi ve `.ics` dışa aktarma. - Letterboxd/IMDb CSV içe
aktarma. - İki profilin izlenecek listelerinin kesişimi. -
`impressionHistory` tabanlı Movie Journey Timeline. - Yerel mod
korunarak çok cihaz senkronu (ör. Supabase Auth + RLS). - Celebrity
Impact Score ve Taste Twin: veri politikası ve ürün kararı netleşmeden
başlama.

**Kabul kriterleri:** Her ürün özelliği için ayrı kapsam, veri ihtiyacı,
test ve kabul kriteri var. Gerçek ölçüm olmadan istatistikler veya model
başarısı uydurulmuyor.

## Faz 11 --- Dokümantasyon ve yayına hazırlık

-   README'ye kurulum ve öneri motorunun çalışma mantığını ekle.
-   `ARCHITECTURE.md` içinde modülleri, veri akışını, cache'leri, kalıcı
    veri modelini ve migrasyon kurallarını açıkla.
-   TMDB saklama/ticari kullanım kararlarını resmi koşullara göre
    doğrula ve belgeleyip kaydet.
-   Deploy hedefini, ortam değişkenlerini, sır yönetimini, HTTPS,
    loglama, yedekleme ve anahtar rotasyonunu belgeleyip test et.
-   Hero GIF/ekran görüntülerinin çalışan sürümü temsil ettiğini
    doğrula.

**Kabul kriterleri:** Yeni geliştirici projeyi kurup çalıştırabiliyor;
sırlar repoda yok; dağıtım ve geri alma adımları belgeli.

## Her fazın sonunda zorunlu rapor

1.  **İncelenen durum:** Hangi dosyalar ve davranış doğrulandı?
2.  **Değişiklikler:** Dosya bazında ne değişti ve neden?
3.  **Testler:** Komut, sonuç ve kapsanan senaryo.
4.  **Kabul kriterleri:** Geçti / kaldı / bekliyor.
5.  **Riskler:** Veri migrasyonu, geriye dönük uyumluluk, güvenlik veya
    performans.
6.  **Açık işler:** Tamamlanmayan maddeler ve nedenleri.
7.  **Sonraki adım:** Yalnızca bir sonraki fazın önerisi.

## Blokaj kuralları

-   Faz 0 tüm diğer fazlardan önce gelir.
-   Faz 1 test ve üretim başlatma temelini kurar.
-   Faz 2--3 öneri verisi ve ring davranışını güvenceye alır.
-   Faz 4--5 sunucu ve HTTP güvenliğini ele alır.
-   Faz 6 ilişki grafiği ile zevk haritasını ayırır.
-   Faz 7 UX; Faz 8 refaktör/perf; Faz 9--11 daha ileri ürün ve yayın
    işidir.
-   Kritik kabul kriteri başarısızsa sonraki faza geçme. Kritik veri
    kaybı veya güvenlik riski açıkken yeni özellik geliştirme.

## Kodlama ajanının ilk görevi

İlk yanıtta kodu değiştirmeden: 1. Depo ve çalışma ağacını incele. 2.
Plan maddelerini güncel kodla karşılaştır. 3. Maddeleri `Doğrulandı`,
`Kısmen mevcut`, `Doğrulanmadı`, `Artık gerekli değil`,
`Karar gerekiyor` olarak sınıflandır. 4. En riskli beş bulguyu dosya ve
kod konumlarıyla raporla. 5. Önerilen ilk fazı, değişecek dosyaları ve
test komutlarını açıkla. 6. Ardından yalnızca ilk küçük fazı uygula; tüm
yol haritasını tek seferde kodlama.

## Son uyarılar

-   Dosya boyutu/satır sayısı ve paket sürümü gibi değerleri güncel
    depoda doğrula.
-   ESLint sürüm değişimi, Zod, Web Worker, PWA, Supabase veya yeni
    grafik kütüphanesi otomatik karar değildir; kanıt ve gerekçe
    gerektirir.
-   Sezon endpoint'ini yalnızca sezon/bölüm/takvim özelliği kapsamdaysa
    ekle.
-   Daha çok öneri göstermek tek başına daha iyi öneri demek değildir;
    tür filtresi, kullanıcı durumları, profil izolasyonu, ring kuralları
    ve açıklanabilirlik korunmalı.
-   İlişki keşif grafiği, zevk haritası ve öneri havuzu ayrı
    sorumluluklardır. Birinin cache'i diğerinin kullanıcı verisini
    değiştirmemeli.
-   Amaç çok sayıda değişiklik yapmak değil, davranışı koruyarak
    doğrulanmış ve geri alınabilir iyileştirmeler çıkarmaktır.

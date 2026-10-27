# CineTrack — Veri Bütünlüğü, Kalıcı Depolama ve Öneri Motoru Düzeltme Spec'i

## 0. Görev ve çalışma ilkesi

Bu spec'i güncel CineTrack deposunda uygula. Amaç, aşağıdaki doğrulanabilir veri bütünlüğü, kalıcı depolama, önbellek ve öneri motoru sorunlarını gidermek; gerektiğinde kodu daha modüler ve test edilebilir hâle getirmektir.

**Önemli kullanım bağlamı:** Uygulamayı şu anda yalnızca sahibi kullanıyor. Bu görev kapsamında ağ erişimi varsayılanlarını, `0.0.0.0` / `127.0.0.1` davranışını veya kimlik doğrulama politikasını değiştirme. Bu konuları bu düzeltme paketinin kapsamı dışında tut. Yalnızca başka bir düzeltme için zorunluysa, davranışı değiştirmeden risk ve bağımlılığı raporla. Bu kapsam dışı bırakma; veri bütünlüğü, dosya güvenliği, hata yönetimi veya GitHub token'ının gizli tutulması gerekliliklerini kaldırmaz.

**Çalışma yöntemi:** Önce depodaki güncel kodu incele ve her bulgunun hâlâ geçerli olup olmadığını doğrula. Bir madde güncel kodda zaten doğru biçimde çözülmüşse yeniden uygulama; ilgili dosya ve test kanıtını raporla. Kodda bulunmayan bir davranışın var olduğunu varsayma. Değişiklikleri küçük, birbirinden bağımsız fazlara böl; her fazın sonunda testleri çalıştır ve sonuçları bildir.

## 1. Başlangıç denetimi — kod yazmadan önce

1. Güncel branch, commit ve çalışma ağacını belirle. Kullanıcının yerel değişikliklerini silme veya üzerine yazma.
2. `package.json` scriptlerini, veri akışını ve aşağıdaki alanları incele:
   - `src/server/persistent-store.ts`
   - `src/server/app.ts`
   - `server.ts`
   - `src/services/api.ts`
   - `src/core/keys.ts`
   - `src/core/cinetrack-core.ts`
   - `src/App.tsx`
   - `src/core/relationship-explorer.ts`
   - ilgili test dosyaları ve kalıcı veri şemaları.
3. Aşağıdaki her bulgu için `doğrulandı / zaten çözüldü / geçersiz` kararı ver. Güncel kodda kanıt olmadan varsayım üzerinden değişiklik yapma.
4. Önce mevcut testleri çalıştırmayı dene. Çalıştırılamıyorsa nedenini açıkça yaz; başarılıymış gibi raporlama.
5. Uygulamadan önce kısa bir plan ve değişecek dosyaların listesini çıkar; sonra aynı görev içinde uygulamaya devam et. Kullanıcıdan yalnızca gerçekten bloke eden bir belirsizlik varsa soru sor.

## 2. Faz A — Kalıcı JSON verilerinin güvenilir yazılması

### Sorun
Katalog ve profil bazlı türetilmiş veri yazımlarında doğrudan `writeFileSync` kullanılması, işlem yarıda kalırsa JSON dosyasının eksik veya bozuk kalması riskini oluşturabilir.

### Gereksinimler
1. Katalog ve türetilmiş profil verileri için atomik yazma mekanizması uygula:
   - Aynı dizinde benzersiz/geçici bir dosyaya yaz.
   - Yazılan içeriğin tamamlandığını doğrula.
   - Uygun olduğunda flush/senkronizasyon desteğini kullan.
   - Ardından geçici dosyayı hedef dosyanın yerine atomik olarak taşı.
   - Hata oluşursa geçici dosyayı temizle; önceki geçerli hedef dosyayı mümkün olduğunca koru.
2. Bu mantığı güvenli ve yeniden kullanılabilir bir yardımcıda topla; ama küçük ve anlaşılır bir işlem için gereksiz soyutlama oluşturma.
3. Ana zevk haritası/veri dosyaları için zaten atomik yazma yardımcısı varsa kopyasını üretme; aynı yardımcıyı güvenli biçimde yeniden kullan.
4. Başlangıçta JSON parse hatası görülürse:
   - Hatalı dosyanın sessizce boş veriyle üzerine yazılmasını engelle.
   - Hata kaydı üret.
   - Varsa geçerli yedek/kurtarma yolunu dene.
   - Kurtarma mümkün değilse uygulamanın mevcut veriyi yok etmeden anlaşılır hata vermesini sağla.
5. Birden fazla yazma işlemi aynı dosyaya eşzamanlı ulaşabiliyorsa, mevcut çalışma modeline uygun kilitleme/serileştirme uygula. Gereksiz bir genel kilit sistemi kurma.

### Kabul kriterleri
- Yazma başarısız olduğunda önceki geçerli JSON korunur.
- Başarılı yazma sonrasında hedef dosya geçerli JSON'dur.
- Yarım kalmış geçici dosyalar sonraki açılışta kontrollü biçimde ele alınır.
- Hatalı JSON, sessizce boş veri olarak kabul edilip eski verinin üzerine yazılmaz.
- Atomik yazma ve hata senaryoları test edilir.

## 3. Faz B — Veri boyutu sınırını tek kaynaktan yönetme

### Sorun
Kodda `maxDataBytes` için yaklaşık 100 MB varsayılanı bulunurken README/mimari belgelerinde 2 MB sınırı belirtilmiş. Gerçek amaçlanan sınır belirsiz ve uygulama ile dokümantasyon tutarsız.

### Gereksinimler
1. Önce mevcut payload'ların gerçek boyutunu ve 2 MB / 100 MB tercihinin etkisini incele.
2. Uygulamanın veri modeline ve kullanımına uygun tek bir sınır seç; gerekçesini kısa bir notla açıkla. Kullanıcı tarafından belirtilmemiş bir sayıyı gelişigüzel seçme.
3. Sınırı tek bir yapılandırma/konstant üzerinden hem ana sunucu girişinde hem uygulama katmanında kullan. Aynı sayıyı birden çok dosyada kopyalama.
4. Bayt cinsinden ölçüm yap; karakter sayısını bayt sayısı gibi kullanma.
5. Limit aşımında kontrollü ve anlaşılır hata döndür; mevcut dosyayı değiştirme.
6. README, mimari belgeler, örnek `.env` veya dağıtım dokümanları ve testleri seçilen sınırla tutarlı hâle getir.
7. Büyük payload'ların bellek ve performans etkisini göz önünde bulundur. Sınırı yükseltmek tek başına performans çözümü değildir.

### Kabul kriterleri
- Sınırın hemen altındaki istek kabul edilir.
- Sınırın üstündeki istek reddedilir.
- Reddedilen istek hiçbir kalıcı dosyayı değiştirmez.
- Uygulama, sunucu ve belgeler aynı etkin sınırı kullanır.

## 4. Faz C — Profil bazlı işlenmiş veri ve cache invalidation

### Sorun
`upsertDerivedProfile` içindeki değişiklik kontrolü yalnızca bazı alanlara (ör. `matchScore`, `lifecycleRing`) bakıyorsa, `signals` veya `reasons` değiştiği hâlde yeni veri kaydedilmeyebilir. Ayrıca önceden işlenmiş profil verisinin uygulama açılışında gerçekten yüklenip kullanılmadığı uçtan uca kanıtlanmalıdır.

### Gereksinimler
1. `upsertDerivedProfile` için değişiklik karşılaştırmasını kalıcı olarak saklanan bütün anlamlı alanları kapsayacak şekilde düzelt:
   - `matchScore`
   - `lifecycleRing`
   - `signals`
   - `reasons`
   - varsa profil imzası, kaynak içerik imzası, algoritma/şema sürümü ve diğer kalıcı alanlar.
2. Karşılaştırma deterministik olmalı. Nesne anahtarlarının sırası gibi anlamsız farklar gereksiz güncellemeye neden olmamalı.
3. `updatedAt` gibi yalnızca yazma nedeniyle değişen alanları karşılaştırma girdisine dahil ederek her seferinde sahte değişiklik yaratma.
4. Tercih edilen yöntem: normalize edilmiş anlamlı alanlar üzerinden içerik imzası/hash üretmek. Hash kullanılırsa hangi alanları kapsadığı ve sürüm değişiminde nasıl invalidation yapılacağı açık olsun.
5. Cache anahtarı en azından aşağıdakilerin değişimini yakalamalı:
   - profil/tercih imzası,
   - kaynak içerik verisinin imzası veya sürümü,
   - eşleşme algoritması sürümü,
   - türetilmiş veri şema sürümü.
6. Profil verisi yüklenirken profil ve algoritma sürümü eşleşmiyorsa eski veriyi sessizce geçerli kabul etme; yeniden hesapla veya kontrollü biçimde cache miss olarak ele al.
7. `src/services/api.ts` içindeki katalog/profil okuma fonksiyonlarının `App.tsx` ve gerçek öneri akışında çağrıldığını doğrula. Sadece fonksiyonun mevcut olması yeterli değil.
8. Cache hit, cache miss, profil değişikliği ve algoritma sürümü değişikliği için entegrasyon testleri ekle.
9. Bir veri alanının hesaplanması pahalıysa ve yeniden kullanım uygunsa, işlenmiş veriyi gerçekten kullan; ancak cache'in doğruluk kaynağı olmasına izin verme. Cache bozuk veya eskiyse kaynak veriden yeniden üretilebilmeli.

### Kabul kriterleri
- Yalnızca `reasons` veya `signals` değiştiğinde yeni değerler kalıcı kayda geçer.
- Aynı anlamlı veri yeniden yazıldığında gereksiz dosya değişimi/commit oluşmaz.
- Profil imzası değişince eski profil cache'i kullanılmaz.
- Algoritma veya şema sürümü değişince eski cache geçersiz sayılır.
- İlk hesaplamadan sonraki aynı koşullu çalışmada cache'in gerçekten okunduğu testle kanıtlanır.
- Cache kullanımı öneri sonuçlarını güncel olmayan hâle getirmez.

## 5. Faz D — GitHub kalıcı veri deposu ve senkronizasyon

### Kapsam
Uygulama tek kullanıcı tarafından kullanılıyor. Bu spec ağ erişimi/kimlik doğrulama politikasını değiştirmez; ancak GitHub token'ının istemci bundle'ına veya public dosyalara sızmaması zorunludur.

### Gereksinimler
1. Kalıcı veri katmanlarının görevlerini açıkça ayır:
   - ortak içerik kataloğu: film/dizi metaverileri, tekilleştirilmiş içerik kayıtları;
   - kullanıcıya özel ana durum: izleme listeleri, tercih ve gösterim geçmişi;
   - profil bazlı türetilmiş veri: eşleşme puanları, sinyaller, gerekçeler, yaşam döngüsü halkası ve hesaplama sürümü.
2. İçerik kimliği türü de kapsamalı: `movie:123` ve `tv:123` farklı kayıtlardır.
3. Aynı içerik tekrar indirildiğinde yeni kopya üretme. Yalnızca anlamlı kaynak alanları değiştiyse güncelle.
4. Profil bazlı türetilmiş kayıtlarda profil imzası ve algoritma/şema sürümünü sakla.
5. GitHub'a yazma işlemi değişmemiş içerik için commit üretmemeli.
6. GitHub API `409` çakışması ve `sha` yenileme mekanizmasını koru; sonsuz tekrar döngüsünü önle ve sınırlı yeniden deneme kullan.
7. Çok dosyalı senkronizasyonun atomik olmadığını kabul et. Her dosya için durum kaydı tut:
   - bekliyor,
   - gönderiliyor,
   - başarılı,
   - başarısız.
8. Katalog güncellenip profil dosyası başarısız olduğunda, tüm senkronizasyonu başarılı gösterme. Hangi dosyanın başarısız olduğunu bildir ve bir sonraki denemede kaldığı yerden devam et.
9. Ağ hatası, GitHub rate limit'i, yetki hatası, conflict ve bozuk yanıtları ayırt et. Token veya gizli başlıkları loglara yazma.
10. Yedi döner yedek mevcutsa davranışını doğrula: yedek sayısı sınırlı kalmalı, en yeni geçerli yedekler korunmalı ve yedek oluşturma başarısız olduğunda önceki sağlam yedekler silinmemeli.
11. Geri yükleme akışında dosya şemasını doğrula; bozuk veya beklenmeyen veri mevcut geçerli dosyanın üzerine yazılmamalı.
12. GitHub deposunun `private/public` ayarıyla `CINETRACK_DATA_REPO_IS_PUBLIC` değişkeninin tutarlılığını kontrol et. Bu spec ağ/kimlik doğrulama tasarımını değiştirmeyi istemez; yalnızca yanlış yapılandırmayı anlaşılır biçimde raporla.
13. TMDB verilerini kalıcı depolama koşulları bakımından mevcut uygulama politikasını ve TMDB'nin geçerli kullanım koşullarını doğrula. Belirsizse hukuki kesinlik iddia etme; saklanan alanları ve olası saklama sınırlarını raporla.

### Kabul kriterleri
- Aynı içerik tekrar içeri alındığında katalogda kopya oluşmaz.
- Değişmeyen dosya için gereksiz GitHub commit'i oluşturulmaz.
- Tek dosyanın senkronizasyon hatası diğer dosyaların durumunu gizlemez.
- Başarısız senkronizasyon açıkça gösterilir ve tekrar denenebilir.
- Geri yükleme bozuk veriyi mevcut sağlam verinin üzerine yazmaz.
- Token istemci bundle'ında, loglarda veya public dosyalarda bulunmaz.

## 6. Faz E — Zevk Haritası anahtar migrasyonu ve öneri halkaları

### Gereksinimler
1. `movie-123` ve `tv-123` gibi eski biçimleri `movie:123` ve `tv:123` kanonik biçimine dönüştüren migrasyonu doğrula.
2. Migrasyon `entries`, `archivedEntries`, entry içindeki `mediaKey` ve `lastRecommendedKeys` alanlarının tamamını kapsamalı.
3. Aynı içeriğin hem eski hem yeni anahtarla kaydı varsa kayıtları kaybetmeden birleştir:
   - `shownCount`, `skippedCount`, `ringDemotions` gibi sayaçlar için uygun ve belgelenmiş bir birleştirme kuralı kullan;
   - `impressionHistory` kayıtlarını yinelenen olayları çoğaltmadan birleştir;
   - `lastShownAt`, `lastRecommendedAt` ve diğer tarih alanlarında geçerli en yeni değeri koru;
   - kullanıcı tercihlerini veya saklanmış içeriği ezme.
4. Migrasyon idempotent olmalı: ikinci çalıştırma yeni değişiklik üretmemeli.
5. UI'da bir öğenin `ring1` durumunu yanlışlıkla `ring0` olarak göstermediğini doğrula. Gösterim halkası, kalıcı taste map verisinden veya doğru lifecycle çıkarımından gelmeli; `ring1` değerini varsayılan `ring0` ile değiştirme.
6. Öneri seçim kuralları:
   - `ring0`: daha önce gösterilmemiş adaylar; ilk tercih.
   - `ring1`: son gösterilen öneri grubu; sonraki yenilemede dışlanmalı.
   - `ring2`: daha önce gösterilmiş ancak kullanıcı tarafından kaydedilmemiş/olumsuz işaretlenmemiş eski adaylar; yalnızca yeterli `ring0` aday yoksa fallback.
7. Kaydedilmiş, izlenmiş, izleme listesine eklenmiş, izleniyor durumundaki, beğenilmeyen veya gizlenen içerikleri mevcut ürün kurallarına göre öneri havuzundan çıkar.
8. Film ve dizi havuzlarını birbirinden bağımsız tut; film-only seçeneğinde diziler, TV-only seçeneğinde filmler kesinlikle görünmesin.
9. Force refresh yolunun öneri cache'ini gerçekten bypass ettiğini doğrula; yalnızca düğmenin parametre göndermesi yeterli değil.
10. Skor, gösterim durumu ve yaşam döngüsü halkasını birbirinden ayrı kavramlar olarak tut. Skorun düşük olması tek başına `ring0/ring1/ring2` belirlememeli.

### Kabul kriterleri
- Eski ve yeni anahtar biçimleri kayıpsız tekilleştirilir.
- Migrasyon ikinci kez çalıştırıldığında değişiklik yapmaz.
- Yeterli ring0 adayları varken ring2 adayları gösterilmez.
- Son batch içindeki ring1 öğeleri sonraki batch'te tekrar önerilmez.
- Ring0 yetersiz olduğunda ring2 fallback davranışı test edilir.
- Film-only ve TV-only filtreleri katı biçimde uygulanır.
- Kullanıcı listelerindeki öğeler öneri olarak geri dönmez.

## 7. Faz F — İlişki grafiği ve modülerleştirme

### Amaç
Kodun modülerliği, yalnızca dosyaları küçültmek için değil; iş kurallarını izole etmek, test edilebilirliği artırmak ve gelecekteki değişikliklerin regresyon riskini düşürmek için yapılmalı.

### Gereksinimler
1. Önce `App.tsx` ve `relationship-explorer.ts` içindeki sorumlulukları haritala. Her fonksiyonun iş alanını ve bağımlılıklarını belirle.
2. Büyük dosyaları tek hamlede yeniden yazma. Çalışan davranışı testlerle sabitle ve ardından küçük adımlarla çıkar.
3. Uygun sınırlar örnek olarak:
   - UI sunumu ve bileşenler,
   - öneri akışı/orchestrator,
   - öneri skorlama ve seçim,
   - kalıcı depolama/senkronizasyon,
   - profil imzası ve cache invalidation,
   - ilişki grafiği hesaplama,
   - şema doğrulama ve migrasyon.
4. Mevcut mimariye uymayan bir soyutlamayı sırf bu listede olduğu için ekleme. Her yeni modülün tek ve anlaşılır bir sorumluluğu olmalı.
5. Dışarıya sunulan fonksiyon imzalarını koru veya değişiklik gerekiyorsa çağrı noktalarının tamamını güncelle ve test et.
6. Modülerleştirme sırasında öneri puanlarını, seçim sırasını, API sözleşmelerini veya kullanıcı davranışını istemeden değiştirme.
7. İlişki grafiğinin mevcut düğüm/kenar sınırlarını ve cache davranışını koru; performans optimizasyonu yaparken ilişki sonuçlarını sessizce azaltma veya farklılaştırma.
8. Her küçük refaktör sonrası ilgili birim testlerini ve tam doğrulama komutlarını çalıştır.

### Kabul kriterleri
- Modülerleştirme davranış değişikliği yaratmaz; bu, regresyon testleriyle gösterilir.
- UI bileşenleri kalıcı depolama ayrıntılarını doğrudan yönetmez.
- İş mantığı mümkün olduğunca React bileşenlerinden bağımsız test edilebilir.
- Tek bir dev dosyayı çok sayıda anlamsız küçük dosyaya bölmekten kaçınılır.
- Değişiklikler küçük ve incelenebilir commit/PR sınırlarında tutulur.

## 8. Faz G — Test matrisi

En az aşağıdaki testleri ekle veya mevcut olanları güçlendir.

### Kalıcı depolama
- atomik yazma başarı durumu;
- yazma sırasında hata;
- bozuk JSON ve kurtarma;
- aynı kaydın yeniden eklenmesi;
- değişmeyen kaydın gereksiz yazılmaması;
- payload boyut sınırının altı/üstü;
- katalog ve profil dosyasının ayrı ayrı başarısız olması.

### GitHub senkronizasyonu
- ilk senkronizasyon;
- değişmemiş içerik;
- içerik güncellemesi;
- `409` conflict ve sınırlı retry;
- rate limit ve ağ hatası;
- kısmi başarısızlık;
- yeniden denemede başarı;
- yedek döngüsü;
- geri yükleme ve bozuk yedek.

### Profil cache'i
- aynı profil imzasında cache hit;
- profil tercihi değişiminde cache miss;
- kaynak veri imzası değişiminde cache miss;
- algoritma/şema sürümü değişiminde cache miss;
- yalnızca `signals` veya `reasons` değiştiğinde kayıt güncellemesi;
- aynı içerikte gereksiz güncelleme olmaması.

### Zevk haritası ve öneriler
- eski anahtar migrasyonu;
- çakışan kayıtların kayıpsız birleştirilmesi;
- idempotent migrasyon;
- art arda 3 kez yenileme;
- yeterli ring0 aday varken ring2 kullanılmaması;
- ring0 yetersizken ring2 fallback;
- ring1 tekrarının engellenmesi;
- film-only/TV-only katı filtreleri;
- listelenmiş/gizlenmiş öğelerin dışlanması;
- UI'da ring değerinin doğru gösterilmesi.

### Çalıştırılacak kontroller
`package.json` içindeki gerçek scriptleri doğrula ve mevcutsa:
- `npm test`
- `npm run lint`
- `npm run build`

Script isimleri farklıysa tahmin ederek komut çalıştırma; gerçek scriptleri kullan ve raporla. Başarısız testleri sebepleriyle bildir. Test çalıştırılamadıysa bunu açıkça belirt.

## 9. Faz H — Dokümantasyon ve teslim raporu

1. Kod ile README/mimari dokümanı arasındaki boyut sınırı, veri dosyası yolları, yedekleme davranışı, profil cache'i ve ortam değişkeni açıklamalarını eşitle.
2. Yeni bir veri şeması eklenmişse sürüm numarası, migrasyon ve geri dönüş davranışını belgeleyin.
3. `.env` örneklerinde gerçek token veya sır bulunmadığını doğrula.
4. Teslim raporunda şu başlıklar olsun:
   - doğrulanan bulgular;
   - zaten çözülmüş veya geçersiz bulunan maddeler;
   - değiştirilen dosyalar ve nedenleri;
   - eklenen testler;
   - çalıştırılan komutlar ve gerçek sonuçları;
   - kalan riskler;
   - manuel olarak doğrulanması gereken adımlar.
5. Yapılmayan işi tamamlanmış gibi sunma. GitHub'a push yapılmadıysa push yapılmış izlenimi verme.

## 10. Uygulama sırası

Önerilen sıra:
1. Başlangıç denetimi ve mevcut testlerin durumu.
2. Atomik JSON yazma ve bozuk dosya koruması.
3. Veri boyutu sınırının tekilleştirilmesi.
4. Profil cache'i doğruluğu ve invalidation.
5. GitHub senkronizasyonunun kısmi hata/yeniden deneme davranışı.
6. Zevk haritası migrasyonu ve ring davranışı.
7. İlişki grafiği ve öneri akışında kontrollü modülerleştirme.
8. Tam regresyon testleri ve dokümantasyon.

**Ağ erişimi ve kimlik doğrulama politikası bu görevde değiştirilmemelidir.** Bu başlıklar yalnızca teslim raporunda mevcut durum olarak not edilebilir; uygulama kapsamına eklenmemelidir.

## Son talimat

Bu spec'i bir yapılacaklar listesi gibi yalnızca yorumlama. Güncel kodu doğrula, gerekli değişiklikleri uygula, testleri çalıştır ve sonuçları kanıtlarıyla raporla. Kapsam dışı işleri ekleme. Var olan çalışan özellikleri koru. Öncelik yeni kod miktarı değil; veri kaybını önlemek, cache doğruluğunu sağlamak, öneri davranışını deterministik hâle getirmek ve kodu kontrollü biçimde sürdürülebilir kılmaktır.

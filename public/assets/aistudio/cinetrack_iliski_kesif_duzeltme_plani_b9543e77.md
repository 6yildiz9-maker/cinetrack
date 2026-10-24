# CineTrack — İlişki Keşfi ve Zevk Haritası: Kodlu Düzeltme Planı

**Hazırlanma tarihi:** 24 Ekim 2026  
**Depo:** https://github.com/6yildiz9-maker/cinetrack  
**Amaç:** Mevcut `Sana Özel` öneri algoritmasını bozmadan İlişki Keşfi/Zevk Haritası katmanını daha tutarlı, kalıcı, açıklanabilir ve test edilebilir hâle getirmek.

> **Önemli:** Bu belge bir uygulama rehberi ve kod yamasıdır; GitHub deposuna otomatik olarak commit edilmemiştir. Örnekler mevcut `master` dosyaları dikkate alınarak hazırlanmıştır. Büyük bölümleri mevcut dosyaların tamamının yerine koymayın; belirtilen import, type, fonksiyon ve JSX bölümlerine uyarlayın. Önce bir Git dalı açın ve her aşamadan sonra test/derleme çalıştırın.

## İçindekiler

1. [Mevcut durum ve hedef](#1-mevcut-durum-ve-hedef)
2. [Güvenli çalışma başlangıcı](#2-güvenli-çalışma-başlangıcı)
3. [P0: Kaynak yapım, seçili düğüm ve boş grafik davranışı](#3-p0-kaynak-yapım-seçili-düğüm-ve-boş-grafik-davranışı)
4. [P1: Güvenilir profil ve aday havuzu imzaları](#4-p1-güvenilir-profil-ve-aday-havuzu-imzaları)
5. [P1: IndexedDB ilişki önbelleği](#5-p1-indexeddb-ilişki-önbelleği)
6. [P1: RelationshipExplorer önbellek entegrasyonu](#6-p1-relationshipexplorer-önbellek-entegrasyonu)
7. [P1: İlişki türlerini ve kanıtları doğru gösterme](#7-p1-ilişki-türlerini-ve-kanıtları-doğru-gösterme)
8. [P1: Metaveri kapsamı ve ilişki güveni](#8-p1-metaveri-kapsamı-ve-ilişki-güveni)
9. [P1: Zevk Haritasında durum sinyalini kişisel uyumdan ayırma](#9-p1-zevk-haritasında-durum-sinyalini-kişisel-uyumdan-ayırma)
10. [P2: Harita performansı ve kademeli genişletme](#10-p2-harita-performansı-ve-kademeli-genişletme)
11. [Test planı ve örnek testler](#11-test-planı-ve-örnek-testler)
12. [Uygulama sırası ve kabul ölçütleri](#12-uygulama-sırası-ve-kabul-ölçütleri)
13. [Kaynak dosyalar](#13-kaynak-dosyalar)

---

## 1. Mevcut durum ve hedef

İncelenen temel dosyalar:

- [`src/core/relationship-explorer.ts`](https://github.com/6yildiz9-maker/cinetrack/blob/master/src/core/relationship-explorer.ts)
- [`src/components/RelationshipExplorer.tsx`](https://github.com/6yildiz9-maker/cinetrack/blob/master/src/components/RelationshipExplorer.tsx)
- [`src/App.tsx`](https://github.com/6yildiz9-maker/cinetrack/blob/master/src/App.tsx)
- [`src/components/Controls.tsx`](https://github.com/6yildiz9-maker/cinetrack/blob/master/src/components/Controls.tsx)
- [`tests/relationship-explorer.test.mjs`](https://github.com/6yildiz9-maker/cinetrack/blob/master/tests/relationship-explorer.test.mjs)
- [`package.json`](https://github.com/6yildiz9-maker/cinetrack/blob/master/package.json)
- [`style.css`](https://github.com/6yildiz9-maker/cinetrack/blob/master/style.css)

### Mevcut olanlar

- `react-force-graph-2d` ile Canvas tabanlı node/edge grafiği.
- `RelationshipExplorer` bileşeni hem `relationships` hem `taste-map` modlarında kullanılıyor.
- `favoriteActors` verisi `App.tsx` içinde mevcut ve havuz yenilemesine veriliyor; ilişki grafiği bileşenine ayrıca geçirilmesi, önbellek imzasında izlenmesi gerekiyor.
- `relationship-explorer.ts` içinde `buildRelationshipGraph`, `pairRelationships`, `strongestRelationship`, `scoreCandidatesForGraph` ve `personalScoreFor` bulunuyor.
- Mevcut CineTrack çekirdeğinin `makeMediaKey`, `buildTasteProfileV3`, `scoreCandidatesV3` ve `isCandidateEligibleInPool` fonksiyonları yeniden kullanılıyor.
- Film ve dizi adayları ayrı kalıcı havuzlardan `handleLoadRelationshipCandidates` üzerinden yükleniyor.
- Kaynak filtresi geçersiz olduğunda kaynak seçimini düzeltmeye çalışan bir `useEffect` zaten var; kaynak seçilince seçili düğüm de temizleniyor.
- Grafik sınırları şu an en fazla 90 düğüm ve 160 bağlantı.

### Düzeltilmesi gerekenler

1. Filtre değişince seçili düğüm grafikte kalmayabilir; ayrıntı paneli önceki seçimde kalmamalı.
2. İlişki grafiği bir kaynak düğümünden ibaret olduğunda boş ilişki grafiği olarak ele alınmalı.
3. `profileSignature` şu an `${profileId}:${mediaFilter}:v1` türünde basit bir değer. Liste, puan, durum, tercih ve algoritma sürümü değişimlerini ayırt etmiyor.
4. Hesaplanmış graph/relationship kayıtları kalıcı olarak saklanmıyor; grafik yalnızca React state'inde duruyor.
5. Bir çift için birden fazla ilişki tespit edilse de çizgide tek bir `type` gösteriliyor; tüm kanıtlar bu tek tür altında sunulabiliyor.
6. Anlamsal ilişki şimdilik başlık/özet token'ları ve tür örtüşmesine dayanıyor. Embedding veya gerçek kavramsal model değil; arayüz bunu açık söylemeli.
7. Ortak tür kanıtları sayısal TMDB kimlikleriyle gösterilebiliyor.
8. Kayıtlı ama puanlanmamış içeriğin kişisel puanı nötr 50. Bu doğru bir temkinli varsayım; fakat izlenmiş olma durumu ile olumlu zevk sinyali görsel olarak ayrı tutulmalı.
9. Grafik düğümlerinin sınırlandırılmış bir alt küme olduğu kullanıcıya açıkça anlatılmalı.

### Korunacak mimari kural

- `scoreCandidatesV3` mevcut kişiselleştirilmiş öneri motorudur; ilişki puanlaması bunun içine eklenmeyecek.
- İlişki puanı iki yapım arasındaki bağı, kişisel uyum puanı ise hedef içeriğin kullanıcıya uygunluğunu temsil eder.
- `hidden` ve `disliked` içerikler keşif önerisi olarak tekrar sunulmayacak. `disliked` içeriklerinden kontrollü negatif özellik sinyali üretmek daha sonraki aşamada yapılabilir; gizlemek otomatik olarak beğenmeme demek değildir.
- “Haritayı Güncelle” kullanıcı eylemidir. Profil veya havuz verisi değiştiğinde harita **eski** olarak işaretlenebilir; arka planda her render'da tekrar hesaplanmamalı.

---

## 2. Güvenli çalışma başlangıcı

Değişikliklere başlamadan önce:

```bash
git checkout -b feat/relationship-cache-and-quality
git status --short
npm install
npm test
npm run build
```

Başlangıç komutlarından biri başarısızsa önce mevcut hataları kaydet; yeni kodun oluşturduğu hatalarla karıştırma.

Her aşamadan sonra:

```bash
npm test
npm run lint
npm run build
```

`package.json` içinde `lint` hâlen `tsc --noEmit` çalıştırıyor. Şimdilik bunu gerçek ESLint gibi değerlendirme. İstersen ayrı bir düzenlemede script'i `typecheck` olarak yeniden adlandırabilir veya ESLint yapılandırması ekleyebilirsin; bu ilişki motoru düzeltmelerinin ön koşulu değil.

---

## 3. P0: Kaynak yapım, seçili düğüm ve boş grafik davranışı

### 3.1 Filtre değişince eski düğümü temizle

`RelationshipExplorer.tsx` içinde kaynak geçersizliği için bir `useEffect` var ve kaynak dropdown'unda `setSelectedNode(null)` çağrılıyor. Ancak `mediaFilter` veya `relationFilter` değiştiğinde mevcut seçili düğüm yeni grafikte bulunmayabilir.

`selectedNode` tanımından sonra şu etkiyi ekle:

```tsx
useEffect(() => {
  if (!selectedNode) return;

  const currentIds = new Set((graphData?.nodes ?? []).map((node) => node.id));
  if (!currentIds.has(selectedNode.id)) {
    setSelectedNode(null);
  }
}, [graphData, selectedNode?.id]);
```

Filtre değişikliğiyle yeni grafik kuran mevcut effect'i de şu şekilde düzenle. Var olan `setGraphData(createGraph(snapshotCandidates))` satırının yanına seçimi temizleme ekle:

```tsx
useEffect(() => {
  if (!graphData) return;

  const nextGraph = createGraph(snapshotCandidates);
  setGraphData(nextGraph);
  setSelectedNode(null);
  // Bu efekt yalnızca yerel filtre değişiminde çalışır; TMDB isteği yapmaz.
  // İleride bu hesap useMemo/explicit event modeline taşınırsa bağımlılıkları yeniden düzenle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [mediaFilter, relationFilter, sourceKey]);
```

> Not: Bu mevcut efektin bilinçli olarak sınırlı bağımlılık kullanmasını koruyan küçük bir düzeltmedir. Daha sonra yeniden hesaplama ve cache akışı tek bir `rebuildGraph` işlevinde birleştirilirse lint istisnasını kaldırıp bağımlılıkları yeniden düzenle.

### 3.2 Kaynak yapımı sessizce değiştirmeyi önle

`sourceOptions` şu anda kayıtlı içeriklerle mevcut snapshot adaylarını birleştiriyor ve medya filtresine göre süzüyor. Bu yaklaşım doğru. Filtre değiştiğinde kaynak geçersizse mevcut effect ilk geçerli kaynağı seçiyor.

Ek olarak, `handleRefresh` içinde source seçimi `loadedCandidates + savedItems` üzerinden belirlenmeli; `setSnapshotCandidates` çağrısından sonra React state'i aynı satırda hemen güncellendiğini varsayma. Mevcut kodun `effectiveSourceKey` için doğrudan `loadedCandidates` kullanması doğru yaklaşımdır; bunu koru.

Kaynak yapımı değişince seçimi temizlemek için dropdown'daki mevcut kod kalsın:

```tsx
onChange={(event) => {
  setSourceKey(event.target.value);
  setSelectedNode(null);
}}
```

### 3.3 Grafiği göstermek için yalnızca `graphData` varlığına güvenme

İlişki modu kaynak düğümü var olsa bile hiç bağlantı bulamayabilir. Bu durumda yalnızca kaynak düğümünü kuvvet grafiğinde çizmek, “boş sonuç” durumunu gizler.

`RelationshipExplorer.tsx` içinde JSX'den önce hesapla:

```tsx
const hasUsefulGraph = Boolean(
  graphData &&
  graphData.nodes.length > 1 &&
  (mode === 'taste-map' || graphData.links.some((link) => link.type !== 'personal'))
);
```

Mevcut JSX koşulunu:

```tsx
{graphData && graphData.nodes.length > 0 ? (
```

şununla değiştir:

```tsx
{hasUsefulGraph ? (
```

Boş durum başlığını ve açıklamasını ayır:

```tsx
<h3>
  {mode === 'relationships' && !sourceKey
    ? 'Kaynak yapım seçilmedi'
    : graphData && graphData.nodes.length <= 1
      ? 'Bu yapım için yeterli ilişki bulunamadı'
      : graphData
        ? 'Bu filtrede gösterilecek ilişki yok'
        : 'Harita henüz oluşturulmadı'}
</h3>
<p>
  {graphData
    ? 'Daha geniş bir ilişki filtresi deneyebilir veya farklı bir kaynak yapım seçebilirsin.'
    : 'Yerel aday havuzunu kullanmak için “Haritayı Güncelle” düğmesine bas.'}
</p>
```

`handleRefresh` içindeki mevcut `nextGraph.nodes.length` hata kontrolünü de gerçek ilişki bağlantısına göre düzenle:

```tsx
const hasUsefulResult =
  nextGraph.nodes.length > 1 &&
  (mode === 'taste-map' || nextGraph.links.some((link) => link.type !== 'personal'));

if (!hasUsefulResult) {
  setError(
    mode === 'relationships' && !effectiveSourceKey
      ? 'İlişkileri keşfetmek için lütfen bir kaynak yapım seç.'
      : 'Bu filtre için yeterli ilişki verisi bulunamadı.'
  );
}
```

### 3.4 Eski isteklerin yeni profili güncellemesini engelle

`App.tsx` profil değişiminde bileşeni `key` ile yeniden kuruyor. Yine de bekleyen `onRefresh` Promise'i eski bileşenin state'ini güncellemeye çalışabilir. `RelationshipExplorer.tsx` içine bir sayaç ekle:

```tsx
const refreshSequenceRef = useRef(0);

useEffect(() => {
  return () => {
    // Devam eden asenkron sonuçlar artık bu bileşene ait değildir.
    refreshSequenceRef.current += 1;
  };
}, []);
```

`handleRefresh` işlevinin başında bir sıra numarası al; await sonrasında state'i yalnızca sıra numarası hâlâ güncelse değiştir:

```tsx
const handleRefresh = async () => {
  const requestId = ++refreshSequenceRef.current;
  setLoading(true);
  setError('');

  try {
    const loadedCandidates = await onRefresh(mediaFilter);
    if (requestId !== refreshSequenceRef.current) return;

    // Mevcut sourceKey seçimi ve buildRelationshipGraph kodu burada kalır.
    // setSnapshotCandidates, setGraphData ve setSelectedNode çağrılarını yap.
  } catch (err) {
    if (requestId !== refreshSequenceRef.current) return;
    setError(err instanceof Error ? err.message : 'İlişki haritası oluşturulamadı.');
  } finally {
    if (requestId === refreshSequenceRef.current) setLoading(false);
  }
};
```

Bu parça mevcut `handleRefresh` gövdesinin tamamına doğrudan yapıştırılacak bir ikame değil; `loadedCandidates` sonrasındaki mevcut kodu koruyarak ekle.

---

## 4. P1: Güvenilir profil ve aday havuzu imzaları

Şu an `buildRelationshipGraph` sonucunda şu tarz bir imza üretiliyor:

```ts
profileSignature: `${profileId}:${mediaFilter}:v1`
```

Bu imza aynı profilin listesi, kişisel puanları, durumları veya tercihleri değiştiğinde değişmez. Önbellek ve eski harita kontrolü için gerçek bir imza gerekiyor.

### 4.1 `relationship-explorer.ts` içine imza yardımcılarını ekle

Dosyanın dışa açık type ve interface tanımlarından sonra ekle:

```ts
export const RELATIONSHIP_MODEL_VERSION = 'relationship-v2';
export const RELATIONSHIP_GRAPH_SCHEMA_VERSION = 1;

function stableHash(input: unknown): string {
  const text = JSON.stringify(input);
  let hash = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

function sortedStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map(String).sort((a, b) => a.localeCompare(b));
}

export function computeRelationshipProfileSignature(args: {
  profileId: string;
  mediaFilter: MediaFilter;
  savedItems: SavedItem[];
  preferences: Preferences;
  favoriteActorIds?: number[];
}): string {
  const { profileId, mediaFilter, savedItems, preferences, favoriteActorIds = [] } = args;

  const history = savedItems
    .filter((item) => mediaFilter === 'all' || item.media_type === mediaFilter)
    .map((item) => ({
      key: makeMediaKey(item),
      status: item.status || '',
      rating: item.personal_rating === '' || item.personal_rating == null
        ? null
        : Number(item.personal_rating),
      updatedAt: item.updatedAt || item.addedAt || '',
      title: String(item.title || item.name || ''),
      overview: String(item.overview || '').trim(),
      genres: [...(item.genre_ids || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b),
      castIds: (item.cast || []).map((person) => Number(person.id)).filter(Number.isFinite).sort((a, b) => a - b),
      crewIds: (item.crew || []).map((person) => Number(person.id)).filter(Number.isFinite).sort((a, b) => a - b),
      collectionId: (item as any).belongs_to_collection?.id == null
        ? null
        : String((item as any).belongs_to_collection.id),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const signatureSource = {
    profileId,
    mediaFilter,
    relationshipModelVersion: RELATIONSHIP_MODEL_VERSION,
    history,
    preferences: {
      disliked: sortedStrings(preferences.disliked).filter((key) =>
        mediaFilter === 'all' || key.startsWith(`${mediaFilter}:`)
      ),
      hidden: sortedStrings(preferences.hidden).filter((key) =>
        mediaFilter === 'all' || key.startsWith(`${mediaFilter}:`)
      ),
      providers: sortedStrings(preferences.providers),
      mood: preferences.mood || '',
      favoriteActorIds: [...favoriteActorIds].map(Number).filter(Number.isFinite).sort((a, b) => a - b),
    },
  };

  return `${profileId}:${mediaFilter}:${stableHash(signatureSource)}`;
}

export function computeRelationshipPoolSignature(candidates: PoolCandidateItem[]): string {
  const features = candidates
    .map((item) => ({
      key: makeMediaKey(item),
      title: String(item.title || item.name || ''),
      overview: String(item.overview || '').trim(),
      genres: [...(item.genre_ids || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b),
      releaseDate: item.release_date || item.first_air_date || '',
      voteAverage: Number(item.vote_average || 0),
      voteCount: Number(item.vote_count || 0),
      updatedAt: item.addedToPoolAt || '',
      castIds: (item.cast || []).map((person) => Number(person.id)).filter(Number.isFinite).sort((a, b) => a - b),
      crewIds: (item.crew || []).map((person) => Number(person.id)).filter(Number.isFinite).sort((a, b) => a - b),
      collectionId: item.belongs_to_collection?.id == null
        ? null
        : String(item.belongs_to_collection.id),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return stableHash(features);
}
```

Bu imza fonksiyonları **kişisel uyum puanı üretmez**; sadece girdilerin değişip değişmediğini anlamak içindir. Büyük metin alanları JSON içine alındığı için bu işlemi her render'da değil, kullanıcı haritayı güncellerken veya kayıtlı haritayı doğrularken çalıştır.

> TypeScript'te `SavedItem` üzerinde `addedAt`, `media_type`, `personal_rating`, `status` ve `updatedAt` alanları farklı tiplerdeyse mevcut tip tanımına göre alanları uyarlamalısın. `makeMediaKey(item)` mevcut çekirdekte kullanılan standart anahtar biçimidir.

### 4.2 `buildRelationshipGraph` dönüşlerinde imzayı kullan

`BuildRelationshipGraphOptions` interface'ine şu opsiyonel alanları ekle: `favoriteActorIds?: number[]` ve `genreNames?: Record<number, string>`. `buildRelationshipGraph` başındaki destructuring'e `favoriteActorIds = [], genreNames = {}` ekle. `RelationshipExplorerProps` içine `favoriteActors: FavoriteActorInfo[]` ve `genreNames: Record<number, string>` ekle; `App.tsx` içindeki iki `RelationshipExplorer` çağrısına `favoriteActors={favoriteActors}` ve `genreNames={genresMap}` ver. Bileşendeki **iki** `buildRelationshipGraph` çağrısına `favoriteActorIds: favoriteActors.map((actor) => actor.id)` ve `genreNames` geçir. Böylece favori oyuncu değişikliği profil imzasını geçersiz kılar.

`App.tsx` içindeki iki `RelationshipExplorer` kullanımında props şu şekilde olmalı (mevcut props'ları silmeden ekle):

```tsx
<RelationshipExplorer
  /* mevcut props'lar korunur */
  favoriteActors={favoriteActors}
  genreNames={genresMap}
  /* diğer mevcut props'lar */
/>
```

`RelationshipExplorer.tsx` içindeki `createGraph` ve `handleRefresh` fonksiyonlarında `buildRelationshipGraph` çağrılarının ikisine de `favoriteActorIds: favoriteActors.map((actor) => actor.id)` ve `genreNames` ver. `buildRelationshipGraph` dönüşlerindeki gerçek imza, aynı girdi için aynı sonucu üretmelidir.

`buildRelationshipGraph` içindeki bütün dönüşlerde:

```ts
profileSignature: `${profileId}:${mediaFilter}:v1`,
```

yerine:

```ts
profileSignature: computeRelationshipProfileSignature({
  profileId,
  mediaFilter,
  savedItems,
  preferences,
  favoriteActorIds,
}),
```

yaz. Bu değişiklik hem `taste-map` dalındaki hem kaynak bulunamadığı durumdaki hem de `relationships` dalındaki dönüşlerde yapılmalı.

### 4.3 Algoritma sürümü her zaman imzaya girmeli

`RELATIONSHIP_MODEL_VERSION` puanlama veya ilişki çıkarma mantığı değiştiğinde artırılmalı. Örneğin `relationship-v2` -> `relationship-v3`. Böylece eski puanlar yeni modelin sonucuymuş gibi kullanılmaz.

---

## 5. P1: IndexedDB ilişki önbelleği

İlişki grafiği 90 düğüm ve 160 kenara kadar çıkabiliyor. İlişki kayıtları ve kanıtları büyüdüğünde hepsini tek büyük `localStorage` JSON alanında tutmak yerine IndexedDB kullanmak daha uygun. Aşağıdaki depo, üç tip kayıt için yer sağlar:

- `graphs`: son grafik anlık görüntüleri.
- `features`: içerik özellik profilleri.
- `edges`: iki yapım arasındaki ilişki kayıtları.

İlk entegrasyonda grafiğin tamamını ve ekranda kullanılan öğe alt kümesini saklayacağız. `features` ve `edges` store'ları sonraki adımda çift bazlı incremental hesaplama için kullanılabilir.

### 5.1 Yeni dosya: `src/services/relationship-cache.ts`

```ts
import type { PoolCandidateItem, SavedItem } from '../core/cinetrack-core';
import type {
  MediaFilter,
  RelationshipGraphData,
  RelationshipMode,
  RelationshipType,
} from '../core/relationship-explorer';

const DB_NAME = 'cinetrack-relationship-cache';
const DB_VERSION = 1;
const STORE_NAMES = ['graphs', 'features', 'edges'] as const;
export type RelationshipCacheStore = (typeof STORE_NAMES)[number];

export interface CacheRecord<T> {
  key: string;
  savedAt: number;
  value: T;
}

export interface RelationshipGraphSnapshot {
  schemaVersion: number;
  profileId: string;
  mode: RelationshipMode;
  mediaFilter: MediaFilter;
  sourceKey: string;
  relationshipFilter: RelationshipType | 'all';
  profileSignature: string;
  poolSignature: string;
  modelVersion: string;
  savedAt: number;
  graph: RelationshipGraphData;
  // Sadece grafikte bulunan içerikler saklanır; 1000 adayın tümü kopyalanmaz.
  visibleItems: Array<PoolCandidateItem | SavedItem>;
}

function openRelationshipDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB bu ortamda kullanılamıyor.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const storeName of STORE_NAMES) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'key' });
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('İlişki önbelleği açılamadı.'));
    request.onblocked = () => reject(new Error('İlişki önbelleği güncellemesi başka bir sekme tarafından engellendi.'));
  });
}

export async function readRelationshipCache<T>(
  storeName: RelationshipCacheStore,
  key: string,
): Promise<CacheRecord<T> | null> {
  const db = await openRelationshipDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve((request.result as CacheRecord<T> | undefined) || null);
      request.onerror = () => reject(request.error || new Error('Önbellek kaydı okunamadı.'));
      tx.onabort = () => reject(tx.error || new Error('Önbellek okuma işlemi iptal edildi.'));
    });
  } finally {
    db.close();
  }
}

export async function writeRelationshipCache<T>(
  storeName: RelationshipCacheStore,
  key: string,
  value: T,
): Promise<void> {
  const db = await openRelationshipDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put({ key, savedAt: Date.now(), value } satisfies CacheRecord<T>);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Önbellek yazılamadı.'));
      tx.onabort = () => reject(tx.error || new Error('Önbellek yazma işlemi iptal edildi.'));
    });
  } finally {
    db.close();
  }
}

export async function deleteRelationshipCache(
  storeName: RelationshipCacheStore,
  key: string,
): Promise<void> {
  const db = await openRelationshipDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Önbellek kaydı silinemedi.'));
      tx.onabort = () => reject(tx.error || new Error('Önbellek silme işlemi iptal edildi.'));
    });
  } finally {
    db.close();
  }
}

export function latestGraphCacheKey(profileId: string, mode: RelationshipMode): string {
  return `latest:${profileId}:${mode}`;
}

export function graphCacheKey(args: {
  profileId: string;
  mode: RelationshipMode;
  mediaFilter: MediaFilter;
  sourceKey: string;
  relationshipFilter: RelationshipType | 'all';
  profileSignature: string;
  poolSignature: string;
  modelVersion: string;
}): string {
  // Anahtar kısa tutulur; ayrıntılı imzalar kayıt içinde doğrulanmaya devam eder.
  return [
    'graph', args.profileId, args.mode, args.mediaFilter,
    args.sourceKey || 'no-source', args.relationshipFilter,
    args.profileSignature.split(':').pop() || '0', args.poolSignature,
    args.modelVersion,
  ].join(':');
}

export function relationshipEdgeCacheKey(args: {
  sourceKey: string;
  targetKey: string;
  sourceFeatureHash: string;
  targetFeatureHash: string;
  modelVersion: string;
}): string {
  // Şimdiki semantic/person/universe ilişkileri yönsüzdür; çift kimliklerini kanonik sıraya koy.
  const pair = [
    { key: args.sourceKey, hash: args.sourceFeatureHash },
    { key: args.targetKey, hash: args.targetFeatureHash },
  ].sort((a, b) => a.key.localeCompare(b.key));
  return [
    'edge', args.modelVersion,
    encodeURIComponent(pair[0].key), pair[0].hash,
    encodeURIComponent(pair[1].key), pair[1].hash,
  ].join(':');
}
```

### 5.2 Önbellek politikası

- Grafik anlık görüntüsü profil ve mod başına bir `latest` kaydıyla saklanır.
- Kaydın içinde `profileSignature`, `poolSignature`, `modelVersion` ve `schemaVersion` bulunur.
- Profil imzası değişmişse kayıt eski sayılır; harita otomatik olarak arka planda yeniden hesaplanmaz, kullanıcıya güncelleme gerektiği belirtilir.
- Aday havuzu yalnızca kullanıcı “Haritayı Güncelle” dediğinde yenilenir. Aynı havuz ve aynı imza için grafiğin daha önce hesaplanmış ilişkileri sonraki aşamada yeniden kullanılabilir.
- `localStorage`/IndexedDB arızası uygulamanın geri kalanını bozmamalı. Cache yazma başarısızlığı loglanabilir; yeni grafik yine gösterilebilir.

> `relationshipEdgeCacheKey` kenar önbelleği için kanonik anahtar üretir. Bu ilk snapshot entegrasyonu tek başına çift hesaplamasını ortadan kaldırmaz; kenar cache'inin hesaplamadan önce okunması için `pairRelationships` çıktısının cache-aware bir `buildRelationshipGraph` yoluna bağlanması sonraki optimizasyon adımıdır. Bu ayrımı koru: snapshot cache ekranı tekrar açarken hız kazandırır; edge cache ise aynı ilişki çiftini farklı grafiklerde tekrar hesaplamamak içindir.

---

## 6. P1: RelationshipExplorer önbellek entegrasyonu

Bu bölüm mevcut bileşenle dikkatli biçimde birleştirilmeli. Aşağıdaki örnekler yeni cache dosyasını kullanmak için gereken entegrasyon adımlarını verir.

### 6.1 Import'ları ekle

`RelationshipExplorer.tsx` importlarına ekle. Mevcut `import type` satırını aşağıdaki şekilde düzenleyerek runtime `loadPersistentPoolData` işlevini de al:

```tsx
import {
  loadPersistentPoolData,
  type FavoriteActorInfo,
  type PoolCandidateItem,
  type Preferences,
  type SavedItem,
} from '../core/cinetrack-core';
import {
  latestGraphCacheKey,
  readRelationshipCache,
  writeRelationshipCache,
  type RelationshipGraphSnapshot,
} from '../services/relationship-cache';
import {
  computeRelationshipPoolSignature,
  computeRelationshipProfileSignature,
  RELATIONSHIP_GRAPH_SCHEMA_VERSION,
  RELATIONSHIP_MODEL_VERSION,
} from '../core/relationship-explorer';
```

### 6.2 Cache restore durumunu ekle

Bileşen state'lerine şunları ekle:

```tsx
const [cacheNotice, setCacheNotice] = useState('');
const [isRestoringCache, setIsRestoringCache] = useState(true);
const [hasGeneratedGraph, setHasGeneratedGraph] = useState(false);
```

Profil imzasını mevcut girdilerle hesapla:

```tsx
const currentProfileSignature = useMemo(
  () => computeRelationshipProfileSignature({
    profileId,
    mediaFilter,
    savedItems,
    preferences,
  }),
  [profileId, mediaFilter, savedItems, preferences],
);
```

`RelationshipGraphData.profileSignature` alanı da aynı fonksiyonla üretildiğinde doğrudan karşılaştırılabilir.

### 6.3 Son kaydedilmiş grafiği yükle

`RelationshipExplorer` bileşenine aşağıdaki effect'i ekle. Bu, son kayıtlı grafik görünümünü yükler; TMDB isteği yapmaz.

```tsx
useEffect(() => {
  let cancelled = false;
  setIsRestoringCache(true);

  void (async () => {
    try {
      const record = await readRelationshipCache<RelationshipGraphSnapshot>(
        'graphs',
        latestGraphCacheKey(profileId, mode),
      );
      if (cancelled || !record) return;

      const snapshot = record.value;
      if (snapshot.schemaVersion !== RELATIONSHIP_GRAPH_SCHEMA_VERSION) {
        setCacheNotice('Kayıtlı harita eski şema sürümünde. Güncelleme gerekiyor.');
        return;
      }
      if (snapshot.modelVersion !== RELATIONSHIP_MODEL_VERSION) {
        setCacheNotice('İlişki algoritması değişti. Haritayı güncelle.');
        return;
      }

      const currentSignatureForSnapshot = computeRelationshipProfileSignature({
        profileId,
        mediaFilter: snapshot.mediaFilter,
        savedItems,
        preferences,
        favoriteActorIds: favoriteActors.map((actor) => actor.id),
      });
      if (snapshot.profileId !== profileId || snapshot.mode !== mode) return;
      if (snapshot.profileSignature !== currentSignatureForSnapshot) {
        setCacheNotice('Kullanıcı listesi, puanları, favori oyuncuları veya tercihleri değişmiş. Haritayı güncelle.');
        return;
      }

      // Havuz localStorage üzerinden salt okunur biçimde kontrol edilir; bu adım TMDB isteği yapmaz.
      const livePool = snapshot.mediaFilter === 'all'
        ? [
            ...loadPersistentPoolData(profileId, 'movie').items,
            ...loadPersistentPoolData(profileId, 'tv').items,
          ]
        : loadPersistentPoolData(profileId, snapshot.mediaFilter).items;
      const livePoolSignature = computeRelationshipPoolSignature(livePool);
      if (snapshot.poolSignature !== livePoolSignature) {
        setCacheNotice('Yerel aday havuzu değişmiş. Haritayı güncelle.');
        return;
      }

      // Sadece haritada görünen adaylar geri yüklenir; tamamı havuz tekrarına kopyalanmaz.
      const visiblePoolItems = snapshot.visibleItems.filter(
        (item): item is PoolCandidateItem => typeof (item as PoolCandidateItem).poolSource === 'string',
      );
      setMediaFilter(snapshot.mediaFilter);
      setRelationFilter(snapshot.relationshipFilter);
      setSourceKey(snapshot.sourceKey);
      setSnapshotCandidates(visiblePoolItems);
      setGraphData(snapshot.graph);
      setHasGeneratedGraph(true);
      setCacheNotice(`Kayıtlı harita yüklendi · ${new Date(snapshot.savedAt).toLocaleString('tr-TR')}`);
    } catch (error) {
      // Önbellek kullanılamaması uygulamanın çalışmasını engellemez.
      console.warn('İlişki haritası önbelleği okunamadı:', error);
    } finally {
      if (!cancelled) setIsRestoringCache(false);
    }
  })();

  return () => {
    cancelled = true;
  };
  // Bu effect yalnızca profil/mod değişiminde son snapshot'ı yükler.
  // İçerik/tercih değişimleri imza kontrolüyle ayrı işlenir.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [profileId, mode]);
```

### 6.4 `handleRefresh` içinde grafiği kaydetmeye hazırla

Mevcut `handleRefresh` sonunda `setGraphData(nextGraph)` ve `setSelectedNode(null)` var. Ayrıca:

```tsx
setHasGeneratedGraph(true);
setCacheNotice('Harita güncellendi.');
```

ekle. `setSnapshotCandidates(loadedCandidates)` ile `nextGraph` oluşturma işlemini koru.

### 6.5 Güncel grafiği kaydet

Aşağıdaki effect, grafik yenilendiğinde veya filtrelerin yerel olarak değiştirilmesiyle yeni grafik oluştuğunda son snapshot'ı yazar. Profil imzası eski grafiğe göre farklıysa eski grafiği yeni profilmiş gibi kaydetmez.

```tsx
useEffect(() => {
  if (!graphData || !hasGeneratedGraph) return;

  const currentSignature = computeRelationshipProfileSignature({
    profileId,
    mediaFilter,
    savedItems,
    preferences,
    favoriteActorIds: favoriteActors.map((actor) => actor.id),
  });
  if (graphData.profileSignature !== currentSignature) {
    setCacheNotice('Profil değişti; kaydedilmiş grafik eskidi. Haritayı güncelle.');
    return;
  }

  const graphNodeIds = new Set(
    graphData.nodes.filter((node) => node.mediaType !== 'profile').map((node) => node.id),
  );
  const visibleByKey = new Map<string, PoolCandidateItem | SavedItem>();
  // Önce adayları ekle, sonra kayıtlı öğeleri ekleyerek kullanıcı durumunu koru.
  for (const item of [...snapshotCandidates, ...savedItems]) {
    const key = relationshipNodeKey(item);
    if (graphNodeIds.has(key)) visibleByKey.set(key, item);
  }

  const snapshot: RelationshipGraphSnapshot = {
    schemaVersion: RELATIONSHIP_GRAPH_SCHEMA_VERSION,
    profileId,
    mode,
    mediaFilter,
    sourceKey,
    relationshipFilter: relationFilter,
    profileSignature: currentSignature,
    poolSignature: computeRelationshipPoolSignature(snapshotCandidates),
    modelVersion: RELATIONSHIP_MODEL_VERSION,
    savedAt: Date.now(),
    graph: graphData,
    visibleItems: [...visibleByKey.values()],
  };

  void writeRelationshipCache(
    'graphs',
    latestGraphCacheKey(profileId, mode),
    snapshot,
  ).catch((error) => {
    console.warn('İlişki haritası önbelleğe yazılamadı:', error);
  });
}, [
  graphData,
  hasGeneratedGraph,
  profileId,
  mode,
  mediaFilter,
  sourceKey,
  relationFilter,
  savedItems,
  preferences,
  favoriteActors,
  snapshotCandidates,
]);
```

**Bu entegrasyon için dikkat:**

- `SavedItem` içindeki `media_type` alanı ve `PoolCandidateItem` içindeki `poolSource` alanı mevcut tipe göre kontrol edilmeli.
- `buildRelationshipGraph` içinde profil imzası yukarıda önerilen fonksiyonla güncellenmiş olmalı; aksi hâlde kaydetme effect'i imza uyuşmazlığı nedeniyle sürekli eski grafik uyarısı verir.
- `visibleItems` yalnızca grafiğin düğümlerini detay paneline bağlamak için gereken içerik alt kümesidir. Yeni kaynak seçimi için tam havuz isteniyorsa kullanıcı “Haritayı Güncelle” demeli.
- Cache kaydı başarıyla yüklenmişse ekranda “Kayıtlı harita” notunu göster. Kullanıcıya bunun canlı TMDB taraması olmadığını açıkça anlat.

### 6.6 Grafik eski mi bilgisini göster

`RelationshipExplorer.tsx` toolbar alanına ekle:

```tsx
{cacheNotice && (
  <p className="relationship-cache-notice" role="status">
    {cacheNotice}
  </p>
)}
{isRestoringCache && (
  <p className="relationship-muted" role="status">Kayıtlı harita kontrol ediliyor…</p>
)}
```

`style.css` içine:

```css
.relationship-cache-notice {
  margin: 0.5rem 0;
  padding: 0.55rem 0.75rem;
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 0.65rem;
  color: #cbd5e1;
  background: rgba(15, 23, 42, 0.62);
  font-size: 0.86rem;
}
```

---

## 7. P1: İlişki türlerini ve kanıtları doğru gösterme

### 7.1 Birden fazla ilişkiyi tek çizgide sakla ama ayrı ayrı göster

Mevcut `strongestRelationship` bir çift için en yüksek puanlı ilişkiyi `type` olarak seçiyor; diğer ilişkilerin kanıtlarını da `evidence` içinde birleştirebiliyor. Bu durum, çizgi “Seri / evren” olarak etiketlense bile kanıt listesinde ortak oyuncu bilgisi görünmesine neden olabilir.

`relationship-explorer.ts` içinde şu modeli ekle:

```ts
export interface RelationshipEvidenceDetail {
  type: Exclude<RelationshipType, 'personal'>;
  score: number;
  confidence: number;
  evidence: string[];
}
```

`RelationshipGraphLink` interface'ine şu alanı ekle:

```ts
relationshipDetails?: RelationshipEvidenceDetail[];
```

`strongestRelationship` içinde dönüş nesnesini şöyle genişlet:

```ts
return {
  source: relationshipNodeKey(a),
  target: relationshipNodeKey(b),
  type: best.type,
  alsoRelatedBy: allTypes,
  score: best.score,
  confidence: best.confidence,
  evidence: [...new Set(relations.flatMap((relationship) => relationship.evidence))],
  relationshipDetails: relations.map((relationship) => ({
    type: relationship.type,
    score: relationship.score,
    confidence: relationship.confidence,
    evidence: relationship.evidence,
  })),
  distance: 175 - best.score * 0.85,
};
```

Böylece grafikte bir çizgi kalır, fakat ayrıntı panelinde her ilişki kendi puanı ve kanıtıyla sunulur.

`RelationshipExplorer.tsx` içindeki `selectedLinks.map` bölümünde tek bir tür/kanıt satırı yerine şu yaklaşımla ayrıntıları çiz:

```tsx
{selectedLinks.map((link, linkIndex) => {
  const details = link.relationshipDetails?.length
    ? link.relationshipDetails
    : [{
        type: link.type as Exclude<RelationshipType, 'personal'>,
        score: link.score,
        confidence: link.confidence,
        evidence: link.evidence,
      }];

  return details.map((detail, detailIndex) => (
    <div
      className="relationship-evidence"
      key={`${linkIndex}-${detail.type}-${detailIndex}`}
    >
      <strong>{getRelationshipTypeLabel(detail.type)} · {detail.score}/100</strong>
      <span>Kanıt güveni: {detail.confidence}/100</span>
      <ul>
        {detail.evidence.map((evidence) => (
          <li key={evidence}>{evidence}</li>
        ))}
      </ul>
    </div>
  ));
})}
```

> Buradaki `confidence`, istatistiksel olarak kalibre edilmiş bir olasılık değil; mevcut kanıtların kapsamını temsil eden sezgisel bir güven puanıdır. Arayüzde bunu “Kanıt güveni” diye adlandırmak, “bu ilişkinin doğru olma olasılığı %92” şeklinde yanlış yorumlanmasını önler.

### 7.2 Tür kimliklerini kullanıcı dostu adlara dönüştür

Mevcut `pairRelationships` ortak türleri kanıt metnine sayısal kimlikle yazabiliyor. Kullanıcıya `878`, `18` gibi kimlikler göstermek yerine `Bilim Kurgu`, `Dram` gibi adlar gösterilmelidir.

`BuildRelationshipGraphOptions` interface'ine opsiyonel alan ekle:

```ts
genreNames?: Record<number, string>;
```

`RelationshipExplorerProps` interface'ine ekle:

```tsx
genreNames: Record<number, string>;
```

`App.tsx` içindeki iki `RelationshipExplorer` çağrısına:

```tsx
genreNames={genresMap}
```

ekle. Bu ad, mevcut `genresMap` tipiyle uyuşmuyorsa `Record<number, string>` yerine mevcut tipin gerçek tipini kullan.

`RelationshipExplorer.tsx` içindeki `buildRelationshipGraph` çağrılarına:

```tsx
genreNames,
```

ekle ve fonksiyon parametresini taşı:

```ts
function pairRelationships(
  a: RelationshipContent,
  b: RelationshipContent,
  genreNames: Record<number, string> = {},
): PairRelationship[] {
```

`commonGenres` kanıtını şöyle oluştur:

```ts
const genreEvidence = commonGenres.map((id) =>
  genreNames[Number(id)] || `Bilinmeyen tür (${id})`
);
```

Ve kanıt listesinde:

```ts
...(genreEvidence.length
  ? [`Ortak türler: ${genreEvidence.join(', ')}.`]
  : []),
```

`strongestRelationship` fonksiyonuna da `genreNames` parametresi verip `pairRelationships(a, b, genreNames)` olarak çağır. `buildRelationshipGraph` içindeki bütün `strongestRelationship` çağrıları aynı `genreNames` değerini almalı.

### 7.3 Semantik kanıtları temkinli sun

Mevcut yöntem başlık ve özet kelimelerinin kesişimini, ayrıca ortak türleri kullanıyor. Bu yöntemi geliştirmek için `STOP_WORDS` listesine film tanıtımlarında çok sık çıkan ama konu ayrımı yapmayan kelimeleri kontrollü biçimde ekle. Örnek başlangıç listesi:

```ts
const GENERIC_PLOT_WORDS = new Set([
  'hikaye', 'hikâye', 'konu', 'film', 'dizi', 'hayat', 'zaman',
  'birlikte', 'karşısında', 'mücadele', 'yolculuk', 'gerçek',
  'başlar', 'başlayan', 'olaylar', 'yaşanan', 'yaşayan',
  'dünyada', 'dünyanın', 'insanlar', 'kişiler', 'karakter',
]);
```

`tokenize` filtresinde:

```ts
.filter((word) =>
  word.length >= 4 &&
  !STOP_WORDS.has(word) &&
  !GENERIC_PLOT_WORDS.has(word) &&
  !/^\d+$/.test(word)
)
```

Bu liste başlangıçtır; test örnekleriyle genişletilmeli. Kelime kökü/ek normalleştirmesi olmadan “gerçeklik” ile “gerçekliği” eşleşmeyebilir. Bu nedenle sonuçları **“özet ve tür verisine dayalı benzerlik”** şeklinde tarif et; gerçek anlamsal embedding sistemi olduğunu iddia etme.

---

## 8. P1: Metaveri kapsamı ve ilişki güveni

`PoolCandidateItem` içinde `cast`, `crew` ve `belongs_to_collection` bulunabilir; fakat her adayda dolu olmaları garanti değil. Alan boşsa bunun gerçekten ilişki olmadığı anlamına gelmediğini ayırt etmeliyiz.

### 8.1 Özellik kapsamını modelle

`RelationshipContent` interface'ine ekle:

```ts
metadataCoverage?: {
  overview: boolean;
  genres: boolean;
  cast: 'unknown' | 'partial' | 'complete';
  crew: 'unknown' | 'partial' | 'complete';
  collection: 'unknown' | 'present' | 'not-applicable' | 'not-found';
};
```

Bu alanları `mergeContent` içinde mevcut TMDB verisinden çıkar. Örnek:

```ts
metadataCoverage: {
  overview: Boolean(item.overview?.trim()),
  genres: Boolean(item.genre_ids?.length),
  cast: item.cast?.length ? 'partial' : 'unknown',
  crew: item.crew?.length ? 'partial' : 'unknown',
  collection: item.belongs_to_collection?.id != null
    ? 'present'
    : 'unknown',
},
```

Bu kodda `cast`/`crew` için “complete” demiyoruz; sadece alanın dolu olmasının tüm kadronun getirildiğini kanıtlamadığını hatırlıyoruz. Eğer API isteği, kredilerin tam listesini döndürdüğünü güvenilir şekilde kaydediyorsa o noktada `complete` kullan.

### 8.2 Kişi ilişkisi güvenini veri kapsamına göre ver

Mevcut kod ortak oyuncu veya yaratıcı bulduğunda güven puanı veriyor; ancak kredi verisinin tam olup olmadığını değerlendirmiyor. İlk düzeltme:

```ts
function personEvidenceConfidence(a: RelationshipContent, b: RelationshipContent): number {
  const aKnown = Boolean(a.cast?.length || a.crew?.length);
  const bKnown = Boolean(b.cast?.length || b.crew?.length);
  if (!aKnown || !bKnown) return 45;

  const aComplete = a.metadataCoverage?.cast === 'complete'
    && a.metadataCoverage?.crew === 'complete';
  const bComplete = b.metadataCoverage?.cast === 'complete'
    && b.metadataCoverage?.crew === 'complete';

  return aComplete && bComplete ? 96 : 72;
}
```

`pairRelationships` içindeki kişi ilişkisinin `confidence` alanını bu fonksiyonla oluştur. Gerçekten ortak kişi kimliği bulunduğunda ilişkinin kendisi güçlü kanıttır; güven puanındaki azaltım, daha başka ortak kişilerin bulunup bulunmadığına ilişkin veri kapsamı belirsizliğini ifade eder.

### 8.3 Koleksiyon bulunmaması ile koleksiyon verisinin eksik olmasını ayır

Aynı `belongs_to_collection.id` bulunması güçlü, doğrudan kanıttır. Ancak koleksiyon alanının boş olması, iki yapımın aynı evrende olmadığını kanıtlamaz. Bu durumda “ilişki yok” değil, “bu veriyle ilişki saptanmadı” denmeli.

Dizi evreni/bağlantısı için film koleksiyon kimliğini zorla kullanma. İleride TV ilişkili içerikleri için TMDB'den doğrulanabilir alan eklenirse ayrı bir ilişki kanıt türüyle kullan.

---

## 9. P1: Zevk Haritasında durum sinyalini kişisel uyumdan ayırma

Mevcut `personalScoreFor` şu anda adaylar için `scoreCandidatesV3`, kayıtlı ve puanlanmış öğeler için kullanıcının puanı, puanlanmamış öğeler için nötr 50 kullanıyor. Bu temkinli yaklaşımı tamamen bozmayalım: **izlenmiş olmak tek başına beğeni kanıtı değildir**.

Bunun yerine durum sinyalini düğümün ayrı bir görsel/bağlam alanı olarak ekle.

### 9.1 Node modeline durum etkisi ekle

`RelationshipGraphNode` interface'ine:

```ts
statusWeight?: number;
statusSignal?: 'completed-history' | 'interest' | 'neutral' | 'disliked' | 'hidden';
```

ekle. Sonra küçük bir yardımcı yaz:

```ts
function getStatusVisualSignal(
  item: RelationshipContent,
  preferences: Preferences,
): { weight: number; signal: RelationshipGraphNode['statusSignal'] } {
  const key = relationshipNodeKey(item);
  const disliked = new Set((preferences.disliked || []).map(String));
  const hidden = new Set((preferences.hidden || []).map(String));

  if (hidden.has(key)) return { weight: 0, signal: 'hidden' };
  if (disliked.has(key)) return { weight: -0.5, signal: 'disliked' };
  if (item.status === 'completed') return { weight: 1, signal: 'completed-history' };
  if (item.status === 'watchlist' || item.status === 'watching') {
    return { weight: 0.5, signal: 'interest' };
  }
  return { weight: 0, signal: 'neutral' };
}
```

**Önemli semantik kural:** `completed-history` yalnızca geçmiş/merkezî önem anlamına gelsin; kişisel beğeni anlamına gelmesin. `completed` olup puan verilmemiş öğenin `personalScore` değeri nötr 50 kalabilir.

`toGraphNode` fonksiyonuna `preferences` parametresi geçir ve düğümü oluştururken:

```ts
const status = getStatusVisualSignal(item, preferences);
return {
  // mevcut alanlar
  statusWeight: status.weight,
  statusSignal: status.signal,
};
```

Çağrıldığı iki yeri (`taste-map` ve `relationships`) yeni parametreye göre güncelle.

### 9.2 Görsel durumu kişisel uyumdan ayrı göster

`nodeCanvasObject` içinde yarıçapı sadece `personalScore` ile belirleme. Örneğin:

```tsx
const radius =
  (node.kind === 'profile' || node.kind === 'source' ? 10 : 6 + node.personalScore / 35)
  + Math.max(0, node.statusWeight || 0) * 1.5;
```

`statusSignal` için bir dış halka çizilebilir; örneğin tamamlanmış geçmiş içeriğinde ince mavi çerçeve, izlenecek/izliyor öğesinde kesikli çerçeve. Bu yalnızca görsel örnektir; negatif etkiyi kişisel uyum puanına gizlice ekleme.

### 9.3 İlgilenilmeyen içeriği normal adaydan ayrı tut

Mevcut `isCandidateEligibleInPool` filtresi `disliked` ve `hidden` içerikleri normal aday listesinden çıkarmaya devam etmeli. İlk sürümde bunları öneri düğümü olarak çizme.

İlgilenilmeyen içeriklerin benzer özelliklerine kontrollü negatif etki vermek daha sonra yapılabilir. Bunu yaparken reddedilen içeriği grafiğe ayrı bir “negatif kanıt” katmanı olarak al; kendisini keşif sonucu olarak sunma. Tek bir olumsuz film, aynı türdeki bütün filmlere büyük bir ceza vermemeli. Negatif etki, ilişki kanıtı ve ortak özelliklerin gücüne göre sınırlandırılmalı.

---

## 10. P2: Harita performansı ve kademeli genişletme

Şu an `buildRelationshipGraph` çiftler arasında döngü kurarak ilişkileri hesaplıyor. Düğüm sayısı 90'la sınırlandığından her grafikte 90 × 89 / 2 = 4.005 adede kadar aday çifti değerlendirilebilir. Bu MVP için makul olabilir; ama her yenilemede tüm havuz çiftlerini değerlendirmek doğru değildir.

### 10.1 İlk aşamada 90/160 sınırlarını koru

Mevcut sınırları hemen kaldırma:

```ts
maxNodes: 90,
maxLinks: 160,
```

Arayüze gerçek kapsamı göster:

```tsx
<p className="relationship-muted">
  {graphData
    ? `${graphData.nodes.filter((node) => node.mediaType !== 'profile').length} düğüm ve ${graphData.links.length} bağlantı gösteriliyor. Bu görünüm aday havuzunun seçilmiş bir bölümüdür.`
    : 'Harita henüz oluşturulmadı.'}
</p>
```

Bu sayılar bütün havuzun toplamını değil, ekranda gösterilen grafiği temsil eder.

### 10.2 Kademeli komşu genişletme

İlk etkileşimde 90 düğüm ve 160 bağlantıyla başla. Sonraki sürümde bir düğüme tıklandığında o düğümün daha önce grafikte olmayan komşularını açan `expandNode(nodeId)` işlevi ekle. Bu işlem yeni düğümleri havuzdan seçmeli; tüm havuzun tekrar eşleşmesini yapmamalı.

Kademeli genişletme gelmeden önce kaynak yapım için başlığa göre aranan bir dropdown eklemek faydalı olur. 500 film + 500 dizi olduğunda bütün başlıkları tek uzun select'te bulmak zorlaşır.

### 10.3 Fizik motorunu durdurma

Mevcut kodda `cooldownTicks={100}` ve `onEngineStop` ile animasyonu durdurma kullanılıyor. Bunları koru. Kütüphane sürümünün `pauseAnimation`/`resumeAnimation` API'sini gerçekten desteklediğini TypeScript kontrolüyle doğrula; gerekli değilse `any` cast'leri çoğaltma.

`zoomToFit` yalnızca grafik verisi değiştiğinde çağrılmalı; her düğüm seçimi ve panel açılışında bütün yerleşimi yeniden başlatmamalı.

---

## 11. Test planı ve örnek testler

Mevcut `tests/relationship-explorer.test.mjs` üç temel senaryoyu kapsıyor: aynı koleksiyon ilişkisi, film filtresinde dizi bulunmaması ve kaynak düğümünün merkezde olması. Bu iyi bir başlangıç; aşağıdaki senaryolar eklenmeli.

### 11.1 Profil imzası testleri

`tests/relationship-explorer.test.mjs` importlarına ekle:

```js
import {
  buildRelationshipGraph,
  computeRelationshipProfileSignature,
  computeRelationshipPoolSignature,
} from '../src/core/relationship-explorer.ts';
```

Testler:

```js
test('profil durumu değişince ilişki profili imzası değişir', () => {
  const base = {
    profileId: 'test',
    mediaFilter: 'movie',
    savedItems: [
      { id: 1, media_type: 'movie', status: 'completed', personal_rating: 8, updatedAt: '2026-01-01' },
    ],
    preferences,
  };
  const original = computeRelationshipProfileSignature(base);
  const changed = computeRelationshipProfileSignature({
    ...base,
    savedItems: [{ ...base.savedItems[0], status: 'watchlist' }],
  });
  assert.notEqual(original, changed);
});

test('tercihler değişince ilişki profili imzası değişir', () => {
  const base = {
    profileId: 'test',
    mediaFilter: 'movie',
    savedItems: [],
    preferences,
  };
  const original = computeRelationshipProfileSignature(base);
  const changed = computeRelationshipProfileSignature({
    ...base,
    preferences: { ...preferences, disliked: ['movie:9'] },
  });
  assert.notEqual(original, changed);
});

test('favori oyuncu listesi değişince ilişki profili imzası değişir', () => {
  const base = {
    profileId: 'test',
    mediaFilter: 'movie',
    savedItems: [],
    preferences,
    favoriteActorIds: [11],
  };
  assert.notEqual(
    computeRelationshipProfileSignature(base),
    computeRelationshipProfileSignature({ ...base, favoriteActorIds: [12] }),
  );
});

test('havuz metaverisi değişince havuz imzası değişir', () => {
  const first = candidate(1, { overview: 'Bilinç ve teknoloji.' });
  const second = candidate(1, { overview: 'Bilinç ve insanlık.' });
  assert.notEqual(
    computeRelationshipPoolSignature([first]),
    computeRelationshipPoolSignature([second]),
  );
});
```

> Testlerde `SavedItem` normalizasyonu zorunlu alanlar istiyorsa fixture'ı `tests/core.test.mjs` içindeki mevcut factory veya `normalizeSavedItem` çıktısıyla oluştur. Buradaki alanlar sadece test fikrini gösterir.

### 11.2 Seçili düğüm ve boş grafik senaryoları

Bu UI davranışları `node:test` çekirdek testleriyle tek başına tam doğrulanamaz. Bileşen test altyapısı henüz yoksa ilk aşamada aşağıdaki manuel kontrol listesini uygula:

- İlişki modu: film kaynağı seç, sonra “Sadece dizi” filtresine geç. Kaynak alanı ve grafik kaynağı aynı yapımı göstermeli.
- Kaynak yapım değiştir: sağ panelde önceki düğümün açıklaması kalmamalı.
- İlişki türünü bir türe daralt ve sonuç çıkmayan bir kaynak seç: boş durum doğru mesaj göstermeli, kaynak düğümü tek başına grafikmiş gibi sunulmamalı.
- Sekmeden çıkıp yeniden gir: cache uygunsa kayıtlı grafik yüklenmeli; kullanıcı listesi değişmişse eski grafik açıkça “güncelleme gerekiyor” olarak işaretlenmeli.
- Profil değiştir: diğer profile ait düğümler veya snapshot gösterilmemeli.

### 11.3 Bir çiftte birden fazla ilişkinin gösterimi

Aynı iki yapım hem aynı koleksiyonda olup hem ortak oyuncu paylaşıyorsa:

- Grafikte tek çizgi olması kabul edilebilir.
- Ayrıntı panelinde “Seri / evren” ve “Kişi bağlantısı” ayrı satırlarda, her birinin kendi puanı ve kanıtıyla görünmeli.
- Bir ilişki filtresi seçildiğinde yalnızca o ilişki türü gösterilmeli.

### 11.4 Komutları çalıştır

```bash
npm run lint
npm test
npm run build
```

`npm run lint` şu an gerçek ESLint değil, `tsc --noEmit` çalıştırır. Komut başarılı olsa bile grafik bileşeninin kullanıcı akışı ve IndexedDB davranışı ayrıca manuel test edilmelidir.

---

## 12. Uygulama sırası ve kabul ölçütleri

### P0 — Davranış doğruluğu

1. Filtre değişince geçersiz `selectedNode` temizlenir.
2. Kaynak, medya filtresiyle tutarlı kalır; sessizce başka bir yapımın grafiğiymiş gibi gösterilmez.
3. İlişki sonucu yoksa boş durum bileşeni görünür; tek kaynak düğümü sonuç grafiği sayılmaz.
4. Profil/sekme değişiminden dönen eski Promise'ler yeni görünümü değiştiremez.

**Kabul:** Bu dört durum manuel olarak test edilir; TypeScript ve mevcut testler geçer.

### P1 — İmza ve önbellek

1. Profil imzası liste kimliği, durum, kişisel puan, ilgili tercihler ve model sürümünü içerir.
2. Havuz imzası başlık, özet, tür, tarih, kişi ve koleksiyon metaverisi değişince farklılaşır.
3. Grafik snapshot'ı IndexedDB'de saklanır.
4. Profil veya model sürümü değiştiğinde eski kayıt geçerli sayılmaz.
5. Cache okunamaz/yazılamazsa uygulama çökmek yerine grafiği hesaplamaya devam eder.
6. Cache mesajı, kayıtlı görünüm ile güncel TMDB havuzunu birbirinden ayırır.

**Kabul:** Aynı profil ve kayıtla ikinci açılışta saklanan grafik geri yüklenir; profil değişiminde eski grafik geçersiz olarak işaretlenir.

### P1 — Kanıtların doğruluğu

1. Birden fazla ilişki türü olan çiftte detaylar ayrı satırlarda gösterilir.
2. Ortak tür kimlikleri isim olarak gösterilir.
3. Eksik kadro verisi “ilişki yok” şeklinde kesin bir sonuç üretmez.
4. `confidence` alanı açıklanabilir kanıt güveni olarak adlandırılır; kalibre edilmiş beğenilme olasılığı gibi gösterilmez.
5. Kişisel uyum puanı ile ilişki puanı ayrı kalır.

**Kabul:** En az 10–20 elle kontrol edilmiş içerik çifti için ilişki gerekçeleri veri alanlarıyla doğrulanır.

### P2 — Performans ve ileri ilişki türleri

1. 90 düğüm / 160 bağlantı sınırları korunur.
2. Kullanıcıya görünümün seçilmiş bir alt grafik olduğu belirtilir.
3. Cache/edge katmanı olgunlaştıktan sonra kademeli komşu genişletme eklenir.
4. Atmosfer, kavramsal ilişki ve karşıt fikir ancak ayrı kanıt kuralları ve test örnekleriyle eklenir.

**Kabul:** Filtre değişikliği gereksiz TMDB isteği üretmez; grafik yerleşimi durduktan sonra animasyon sürekli yeniden başlamaz.

---

## 13. Kaynak dosyalar

- [Güncel `relationship-explorer.ts`](https://raw.githubusercontent.com/6yildiz9-maker/cinetrack/master/src/core/relationship-explorer.ts)
- [Güncel `RelationshipExplorer.tsx`](https://raw.githubusercontent.com/6yildiz9-maker/cinetrack/master/src/components/RelationshipExplorer.tsx)
- [Güncel `App.tsx`](https://raw.githubusercontent.com/6yildiz9-maker/cinetrack/master/src/App.tsx)
- [Güncel `Controls.tsx`](https://raw.githubusercontent.com/6yildiz9-maker/cinetrack/master/src/components/Controls.tsx)
- [Güncel `relationship-explorer.test.mjs`](https://raw.githubusercontent.com/6yildiz9-maker/cinetrack/master/tests/relationship-explorer.test.mjs)
- [Güncel `package.json`](https://raw.githubusercontent.com/6yildiz9-maker/cinetrack/master/package.json)

## Son karar

Önce P0 davranış düzeltmelerini, sonra gerçek imza ve IndexedDB snapshot cache'ini, ardından kanıt/ilişki sunumunu uygula. Mevcut `Sana Özel` puanlama algoritmasını değiştirme. Atmosfer, kavramsal ilişki ve karşıt fikir özelliklerini, ilk üç ilişki türü için küçük bir doğrulama kümesi oluşturulduktan sonra ekle.

Bu belge kod yamalarını ve entegrasyon noktalarını içerir; değişiklikler tamamlanınca `npm test`, `npm run lint` ve `npm run build` sonuçlarına göre gerekli type uyarlamaları yapılmalıdır.

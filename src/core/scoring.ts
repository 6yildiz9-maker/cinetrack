/**
 * Profil benzerliği skorlamasının tek kaynağı.
 * Eskiden App.tsx (iki kez), RelationshipExplorer.tsx ve relationship-explorer.ts içinde
 * aynı centroid + kosinüs hesabı elle tekrarlanıyordu; burada birleşti.
 * Saf modül: encoding erişimi çağıran tarafından enjekte edilir, böylece core katmanı
 * servis katmanına bağlanmış olmaz.
 */

import { computeProfileCentroid, cosineSimilarity, type ItemFeatureEncoding } from './encoding.ts';

export type ProfileScoringItem = {
  id?: string | number;
  media_type?: string;
  popularity?: number | string;
};

export type ProfileScodingSavedItem = {
  personal_rating?: number | '';
};

export type EncodingResolver = (item: unknown) => ItemFeatureEncoding | null | undefined;

/** Kart ile aday arasındaki eşleştirme anahtarı; tüm motorların aynı biçimi üretmesi için tek yer. */
export function profileScoreKey(item: ProfileScoringItem): string {
  return `${item.media_type ?? 'movie'}:${item.id ?? ''}`;
}

function vectorOf(encoding: ItemFeatureEncoding | null | undefined): number[] {
  if (!encoding) return [];
  const dense = (encoding as { denseVector?: number[] }).denseVector;
  return Array.isArray(dense) ? dense : encoding.vector || [];
}

/** Kaydedilmiş listelerden ağırlıklı zevk merkezi vektörü üretir. */
export function buildProfileCentroid(
  savedItems: ReadonlyArray<ProfileScodingSavedItem>,
  resolveEncoding: EncodingResolver
): number[] {
  if (!savedItems?.length) return [];
  return computeProfileCentroid(
    savedItems.map((item) => ({
      encoding: resolveEncoding(item) ?? null,
      personal_rating: item?.personal_rating,
    }))
  );
}

/** Tek bir adayın zevk merkezine kosinüs benzerliği (0..1). Encoding yoksa 0. */
export function profileSimilarityScore(
  candidate: unknown,
  centroid: ReadonlyArray<number>,
  resolveEncoding: EncodingResolver
): number {
  if (!centroid?.length) return 0;
  return cosineSimilarity(Array.from(centroid), vectorOf(resolveEncoding(candidate)));
}

export function profileSimilarityScores(
  candidates: ReadonlyArray<ProfileScoringItem>,
  centroid: ReadonlyArray<number>,
  resolveEncoding: EncodingResolver
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const candidate of candidates) {
    scores.set(profileScoreKey(candidate), profileSimilarityScore(candidate, centroid, resolveEncoding));
  }
  return scores;
}

/**
 * Adayları zevk merkezine göre azalan sıralar.
 * Merkez üretilemiyorsa (kullanıcının listesi boş/encoding'leri eksik) `fallback` uygulanır;
 * kepek yoksa sıralamaya dokunulmaz.
 */
export function sortByProfileSimilarity<T extends ProfileScoringItem>(
  candidates: ReadonlyArray<T>,
  savedItems: ReadonlyArray<ProfileScodingSavedItem>,
  resolveEncoding: EncodingResolver,
  options: { fallback?: 'popularity' | 'none' } = {}
): { items: T[]; scores: Map<string, number>; centroid: number[] } {
  const centroid = buildProfileCentroid(savedItems, resolveEncoding);
  if (!centroid.length) {
    const items = [...candidates];
    if (options.fallback === 'popularity') {
      items.sort((a, b) => (Number(b.popularity) || 0) - (Number(a.popularity) || 0));
    }
    return { items, scores: new Map(), centroid };
  }
  const scores = profileSimilarityScores(candidates, centroid, resolveEncoding);
  const items = [...candidates].sort(
    (a, b) => (scores.get(profileScoreKey(b)) ?? 0) - (scores.get(profileScoreKey(a)) ?? 0)
  );
  return { items, scores, centroid };
}

/** Zevk haritasındaki tek kayıt damgası (yalnızca ihtiyaç duyulan alanlar). */
export type TasteMapEntryLike = {
  tasteScore?: number;
  tags?: string[];
  confidenceLevel?: 'standard' | 'high';
  lastScoredAt?: string;
};

export type TasteStamp = {
  tasteFit: number;
  tasteReason: string;
  tasteTags: string[];
  tasteConfidence: 'standard' | 'high';
  tasteComputedAt: string;
};

export type StampableItem = ProfileScoringItem & {
  title?: string;
  name?: string;
  genres?: string[] | { name?: string }[];
  tasteFit?: number;
  tasteReason?: string;
  tasteTags?: string[];
  tasteConfidence?: 'standard' | 'high';
  tasteComputedAt?: string;
};

function genreNamesOf(item: StampableItem): string[] {
  if (!Array.isArray(item.genres)) return [];
  return item.genres
    .map((g) => (typeof g === 'string' ? g : g?.name))
    .filter((n): n is string => typeof n === 'string' && Boolean(n.trim()));
}

function sameTasteStamp(item: StampableItem, stamp: TasteStamp): boolean {
  return (
    item.tasteFit === stamp.tasteFit &&
    (item.tasteTags || []).join('|') === stamp.tasteTags.join('|') &&
    item.tasteReason === stamp.tasteReason &&
    item.tasteConfidence === stamp.tasteConfidence &&
    item.tasteComputedAt === stamp.tasteComputedAt
  );
}

/**
 * "Sana Özel" hesabını liste kayıtlarının üzerine kalıcı olarak yazar.
 * Öncelik sırası: zevk haritasındaki entry (motorun kendi puanı) → profil merkezine kosinüs
 * benzerliği → damgasız. Değişmeyen kayıtlar aynen döner, böylece çağıran yalnızca
 * `changedCount > 0` olduğunda diske yazar.
 */
export function stampSavedItemsWithTaste<T extends StampableItem>(
  savedItems: ReadonlyArray<T>,
  options: {
    tasteEntries?: Record<string, TasteMapEntryLike> | Map<string, TasteMapEntryLike> | null;
    centroid?: ReadonlyArray<number> | null;
    resolveEncoding?: EncodingResolver | null;
    topGenres?: ReadonlyArray<string | { name?: string }>;
    computedAt?: string;
  }
): { items: T[]; changedCount: number } {
  const nowIso = options.computedAt || new Date().toISOString();
  const topGenres = (options.topGenres || [])
    .map((g) => (typeof g === 'string' ? g : g?.name || ''))
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
  const entryOf = (key: string): TasteMapEntryLike | undefined => {
    const map = options.tasteEntries;
    if (!map) return undefined;
    return map instanceof Map ? map.get(key) : map[key];
  };

  let changedCount = 0;
  const items = savedItems.map((item) => {
    const key = profileScoreKey(item);
    const entry = entryOf(key);
    const genreNames = genreNamesOf(item);
    const shared = genreNames.filter((g) => topGenres.includes(g.trim().toLowerCase()));

    let tasteFit: number;
    let tasteConfidence: 'standard' | 'high';
    let tasteComputedAt: string;
    if (entry && Number.isFinite(Number(entry.tasteScore))) {
      tasteFit = Math.max(0, Math.min(100, Math.round(Number(entry.tasteScore))));
      tasteConfidence = entry.confidenceLevel === 'high' ? 'high' : 'standard';
      tasteComputedAt = entry.lastScoredAt || nowIso;
    } else {
      const centroid = options.centroid || [];
      const resolver = options.resolveEncoding;
      if (!centroid.length || !resolver) return item;
      tasteFit = Math.round(profileSimilarityScore(item, centroid, resolver) * 100);
      // Ölçülebilir bir yakınlık yoksa gerekçesi de uydurma olur; kayda dokunulmaz.
      if (tasteFit <= 0) return item;
      tasteConfidence = 'standard';
      tasteComputedAt = nowIso;
    }

    const tasteTags = (entry?.tags || []).filter((t) => typeof t === 'string' && t.trim()).slice(0, 6);
    const tasteReason = shared.length
      ? `${shared.slice(0, 2).join(' · ')} zevkinle örtüşüyor`
      : tasteTags.length
      ? tasteTags.slice(0, 2).join(' · ')
      : 'Genel zevk profiline yakınlık';

    const stamp: TasteStamp = { tasteFit, tasteReason, tasteTags, tasteConfidence, tasteComputedAt };
    if (sameTasteStamp(item, stamp)) return item;
    changedCount++;
    return { ...item, ...stamp };
  });

  return { items, changedCount };
}

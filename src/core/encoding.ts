import { canonicalJsonStringify, hashDeterministic } from './derived-profile-cache.ts';

export const STANDARD_GENRE_IDS: readonly number[] = Object.freeze([
  12, 14, 16, 18, 27, 28, 35, 36, 37, 53, 80, 878, 9648, 99, 10402, 10749, 10751, 10752,
  10759, 10762, 10763, 10764, 10765, 10766, 10767, 10768, 10770,
]);

export const ENCODING_TONE_WORDS = new Set<string>([
  'karanlık', 'distopya', 'gizem', 'psikolojik', 'sürreal', 'izolasyon',
  'rüya', 'gerilim', 'sır', 'kabus', 'yalnızlık', 'melankoli', 'noir', 'atmosfer',
  'klostrofobik', 'tekinsiz', 'kıyamet', 'simülasyon', 'zihin', 'hafıza',
  'dark', 'dystopia', 'mystery', 'psychological', 'dream', 'isolation', 'tension', 'noir',
]);

const STOP_WORDS = new Set([
  'bir', 've', 'ile', 'için', 'olan', 'olarak', 'gibi', 'bu', 'şu', 'o',
  'kendi', 'daha', 'çok', 'en', 'kadar', 'sonra', 'önce', 'ancak', 'fakat',
  'the', 'and', 'with', 'for', 'that', 'from', 'into', 'after', 'about',
]);

const GENERIC_PLOT_WORDS = new Set([
  'film', 'dizi', 'hikaye', 'konu', 'anlatır', 'yaşar', 'başlar', 'karakter',
  'movie', 'series', 'story', 'about', 'follows', 'lives', 'begins', 'character',
]);

export interface ItemFeatureEncoding {
  id: string | number;
  media_type: 'movie' | 'tv';
  signature: string;
  genreVector: number[];
  eraBucket: number;
  ratingTier: number;
  popularityTier: number;
  keywordIds: number[];
  castIds: number[];
  crewIds: number[];
  toneVector: number[];
  denseVector: number[];
  vector: number[];
  tokens: string[];
  encodedAt: string;
}

export function tokenizeText(text: string): Set<string> {
  const normalized = String(text || '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');

  return new Set(
    normalized
      .split(/\s+/u)
      .map((word) => word.trim())
      .filter(
        (word) =>
          word.length >= 4 &&
          !STOP_WORDS.has(word) &&
          !GENERIC_PLOT_WORDS.has(word) &&
          !/^\d+$/.test(word)
      )
  );
}

export function computeItemContentSignature(item: any): string {
  if (!item || typeof item !== 'object') return '';
  const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
  const id = String(item.id ?? '');
  const title = String(item.title || item.name || '').trim();
  const overview = String(item.overview || '').trim();
  const genreIds = Array.isArray(item.genre_ids)
    ? [...item.genre_ids].map(Number).filter(Number.isFinite).sort((a, b) => a - b)
    : [];

  const rawKeywords: number[] = Array.isArray(item.keywords)
    ? item.keywords.map((k: any) => (typeof k === 'object' && k ? Number(k.id) : Number(k))).filter(Number.isFinite)
    : Array.isArray(item.keyword_ids)
      ? item.keyword_ids.map(Number).filter(Number.isFinite)
      : [];
  const keywordIds: number[] = [...new Set(rawKeywords)].sort((a: number, b: number) => a - b);

  const rawCast: number[] = Array.isArray(item.cast)
    ? item.cast.map((c: any) => (typeof c === 'object' && c ? Number(c.id) : Number(c))).filter(Number.isFinite)
    : Array.isArray(item.topCastIds)
      ? item.topCastIds.map(Number).filter(Number.isFinite)
      : [];
  const castIds: number[] = [...new Set(rawCast)].slice(0, 10).sort((a: number, b: number) => a - b);

  const rawCrew: number[] = Array.isArray(item.crew)
    ? item.crew.map((c: any) => (typeof c === 'object' && c ? Number(c.id) : Number(c))).filter(Number.isFinite)
    : [];
  const crewIds: number[] = [...new Set(rawCrew)].slice(0, 5).sort((a: number, b: number) => a - b);

  const payload = {
    id,
    mediaType,
    title,
    overview,
    genreIds,
    keywordIds,
    castIds,
    crewIds,
  };

  return hashDeterministic(canonicalJsonStringify(payload));
}

export function encodeItemContent(item: any): ItemFeatureEncoding {
  const mediaType: 'movie' | 'tv' = item.media_type === 'tv' || (!item.media_type && Boolean(item.name) && !item.title)
    ? 'tv'
    : 'movie';
  const id = item.id != null ? item.id : 0;
  const signature = computeItemContentSignature(item);

  // 1. Genre multi-hot (27 dims)
  const itemGenres = new Set(Array.isArray(item.genre_ids) ? item.genre_ids.map(Number) : []);
  const genreVector: number[] = STANDARD_GENRE_IDS.map((gid) => (itemGenres.has(gid) ? 1.0 : 0.0));

  // 2. Era bucket (5-year steps)
  const dateStr = String(item.release_date || item.first_air_date || '');
  const year = Number(dateStr.slice(0, 4));
  const validYear = Number.isFinite(year) && year >= 1900 && year <= 2040 ? year : 2010;
  const eraBucket = Math.floor(validYear / 5) * 5;
  const normalizedEra = Math.max(0, Math.min(1, (validYear - 1940) / 90));

  // 3. Rating & Popularity tier
  const voteAvg = Number(item.vote_average ?? 6.5);
  const normalizedVote = Math.max(0, Math.min(1, (voteAvg - 3) / 7));
  const ratingTier = Math.max(0, Math.min(9, Math.floor(voteAvg)));

  const pop = Number(item.popularity ?? item.vote_count ?? 100);
  const popularityTier = pop > 5000 ? 4 : pop > 1000 ? 3 : pop > 200 ? 2 : pop > 50 ? 1 : 0;
  const normalizedPop = popularityTier / 4;

  // 4. Keyword IDs
  const rawItemKeywords: number[] = Array.isArray(item.keywords)
    ? item.keywords.map((k: any) => (typeof k === 'object' && k ? Number(k.id) : Number(k))).filter(Number.isFinite)
    : Array.isArray(item.keyword_ids)
      ? item.keyword_ids.map(Number).filter(Number.isFinite)
      : [];
  const keywordIds: number[] = [...new Set(rawItemKeywords)].slice(0, 15).sort((a: number, b: number) => a - b);

  // 5. Cast and Crew IDs
  const rawItemCast: number[] = Array.isArray(item.cast)
    ? item.cast.map((c: any) => (typeof c === 'object' && c ? Number(c.id) : Number(c))).filter(Number.isFinite)
    : Array.isArray(item.topCastIds)
      ? item.topCastIds.map(Number).filter(Number.isFinite)
      : [];
  const castIds: number[] = [...new Set(rawItemCast)].slice(0, 10).sort((a: number, b: number) => a - b);

  const rawItemCrew: number[] = Array.isArray(item.crew)
    ? item.crew.map((c: any) => (typeof c === 'object' && c ? Number(c.id) : Number(c))).filter(Number.isFinite)
    : [];
  const crewIds: number[] = [...new Set(rawItemCrew)].slice(0, 5).sort((a: number, b: number) => a - b);

  // 6. Tokenize & Tone vector
  const textTokens = tokenizeText(`${item.title || item.name || ''} ${item.overview || ''}`);
  const toneList = Array.from(ENCODING_TONE_WORDS).slice(0, 16);
  const toneVector = toneList.map((w) => (textTokens.has(w) ? 1.0 : 0.0));

  // 7. Dense continuous vector (48 dimensions)
  // [0..26: genreVector (norm), 27: isMovie, 28: era, 29: vote, 30: pop, 31..46: toneVector, 47: isTv]
  const denseVector: number[] = [
    ...genreVector,
    mediaType === 'movie' ? 1.0 : 0.0,
    normalizedEra,
    normalizedVote,
    normalizedPop,
    ...toneVector,
    mediaType === 'tv' ? 1.0 : 0.0,
  ];

  return {
    id,
    media_type: mediaType,
    signature,
    genreVector,
    eraBucket,
    ratingTier,
    popularityTier,
    keywordIds,
    castIds,
    crewIds,
    toneVector,
    denseVector,
    vector: denseVector,
    tokens: Array.from(textTokens),
    encodedAt: new Date().toISOString(),
  };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const valA = a[i];
    const valB = b[i];
    dot += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }
  if (normA <= 0 || normB <= 0) return 0;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(0, Math.min(1, sim));
}

/**
 * Computes profile centroid vector as the status-weighted average of saved item dense vectors.
 * completed: weight +1.0, interest: +0.5, disliked: -0.5, scaled by personal rating if available.
 */
export function computeProfileCentroid(
  items: Array<ItemFeatureEncoding | { encoding?: ItemFeatureEncoding | null; personal_rating?: number | '' }>,
  statusWeights: Record<string, number> = {}
): number[] {
  if (!items || items.length === 0) return [];
  const normalizedEncodings: Array<{ enc: ItemFeatureEncoding; weight: number }> = [];

  for (const item of items) {
    if (!item) continue;
    let enc: ItemFeatureEncoding | null = null;
    let weight = 1.0;
    if ('denseVector' in item) {
      enc = item;
      const key = `${enc.media_type}:${enc.id}`;
      weight = statusWeights[key] ?? 1.0;
    } else if (item.encoding && 'denseVector' in item.encoding) {
      enc = item.encoding;
      const key = `${enc.media_type}:${enc.id}`;
      const baseWeight = statusWeights[key] ?? 1.0;
      const rating = item.personal_rating !== '' && item.personal_rating != null ? Number(item.personal_rating) : 7;
      weight = baseWeight * (rating / 10);
    }
    if (enc && weight !== 0) {
      normalizedEncodings.push({ enc, weight });
    }
  }

  if (normalizedEncodings.length === 0) return [];
  const dim = normalizedEncodings[0].enc.denseVector.length;
  const centroid = new Array<number>(dim).fill(0);
  let totalWeight = 0;

  for (const { enc, weight } of normalizedEncodings) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += enc.denseVector[i] * weight;
    }
    totalWeight += Math.abs(weight);
  }

  if (totalWeight <= 0) return centroid;
  for (let i = 0; i < dim; i++) {
    centroid[i] /= totalWeight;
  }
  return centroid;
}

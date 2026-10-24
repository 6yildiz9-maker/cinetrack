import {
  RECOMMENDATION_WEIGHTS_V3,
  buildTasteProfileV3,
  filterHistoryByType,
  isCandidateEligibleInPool,
  makeMediaKey,
  scoreCandidatesV3,
  type PoolCandidateItem,
  type Preferences,
  type SavedItem,
} from './cinetrack-core';

export type RelationshipMode = 'taste-map' | 'relationships';
export type MediaFilter = 'all' | 'movie' | 'tv';
export type RelationshipType = 'semantic' | 'person' | 'universe' | 'personal';

export interface RelationshipContent {
  id: string | number;
  media_type: 'movie' | 'tv';
  title?: string;
  name?: string;
  overview?: string;
  genre_ids?: number[];
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  status?: 'watching' | 'watchlist' | 'completed';
  personal_rating?: number | '';
  updatedAt?: string;
  cast?: Array<{ id: number; name: string; character?: string }>;
  crew?: Array<{ id: number; name: string; job?: string; department?: string }>;
  belongs_to_collection?: { id?: number; name?: string } | null;
}

export interface RelationshipGraphNode {
  id: string;
  label: string;
  title: string;
  mediaType: 'profile' | 'movie' | 'tv';
  kind: 'profile' | 'saved' | 'candidate' | 'source';
  status?: string;
  personalScore: number;
  posterPath?: string | null;
  fx?: number;
  fy?: number;
  x?: number;
  y?: number;
}

export interface RelationshipGraphLink {
  source: string | RelationshipGraphNode;
  target: string | RelationshipGraphNode;
  type: RelationshipType;
  alsoRelatedBy: RelationshipType[];
  score: number;
  confidence: number;
  evidence: string[];
  distance: number;
}

export interface RelationshipGraphData {
  nodes: RelationshipGraphNode[];
  links: RelationshipGraphLink[];
  profileSignature: string;
  createdAt: string;
}

export interface BuildRelationshipGraphOptions {
  mode: RelationshipMode;
  profileId: string;
  candidates: PoolCandidateItem[];
  savedItems: SavedItem[];
  preferences: Preferences;
  mediaFilter: MediaFilter;
  sourceKey?: string;
  maxNodes?: number;
  maxLinks?: number;
  relationshipFilter?: RelationshipType | 'all';
}

interface PairRelationship {
  type: Exclude<RelationshipType, 'personal'>;
  score: number;
  confidence: number;
  evidence: string[];
}

const STOP_WORDS = new Set([
  'acaba', 'ama', 'ancak', 'artık', 'aslında', 'bile', 'bir', 'birçok', 'bu',
  'bunun', 'daha', 'dahi', 'de', 'defa', 'diye', 'çok', 'en', 'gibi', 'hem',
  'hep', 'her', 'herhangi', 'için', 'ile', 'ise', 'kadar', 'karşı', 'kez',
  'ki', 'kim', 'mı', 'mi', 'mu', 'mü', 'nasıl', 'ne', 'neden', 'nerede',
  'neredeyse', 'niçin', 'o', 'olan', 'olarak', 'oldu', 'olduğu', 'olur',
  'onun', 've', 'veya', 'ya', 'yani', 'yeni', 'yine', 'yok', 'sonra',
  'önce', 'the', 'and', 'for', 'from', 'with', 'that', 'this', 'their',
  'they', 'then', 'when', 'where', 'who', 'what', 'into', 'about', 'have',
  'has', 'his', 'her', 'its', 'are', 'was', 'were', 'will', 'would',
]);

const TYPE_LABELS: Record<RelationshipType, string> = {
  semantic: 'Anlamsal benzerlik',
  person: 'Kişi bağlantısı',
  universe: 'Seri / evren bağlantısı',
  personal: 'Kişisel uyum',
};

export function getRelationshipTypeLabel(type: RelationshipType): string {
  return TYPE_LABELS[type];
}

export function relationshipNodeKey(item: Pick<RelationshipContent, 'id' | 'media_type'>): string {
  return makeMediaKey(item.media_type, item.id);
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : min)));
}

function titleOf(item: RelationshipContent): string {
  return String(item.title || item.name || 'Başlıksız yapım');
}

function tokenize(text: string): Set<string> {
  const normalized = String(text || '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');

  return new Set(
    normalized
      .split(/\s+/u)
      .map((word) => word.trim())
      .filter((word) => word.length >= 4 && !STOP_WORDS.has(word) && !/^\d+$/.test(word)),
  );
}

function overlap<T>(a: Set<T>, b: Set<T>): T[] {
  return [...a].filter((value) => b.has(value));
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  const common = overlap(a, b).length;
  return common / (a.size + b.size - common);
}

function getCollectionId(item: RelationshipContent): string | null {
  const collection = item.belongs_to_collection;
  if (!collection || typeof collection !== 'object' || collection.id == null) return null;
  return String(collection.id);
}

function pairRelationships(a: RelationshipContent, b: RelationshipContent): PairRelationship[] {
  const relationships: PairRelationship[] = [];

  // 1) Resmî koleksiyon kimliği en doğrudan seri/evren kanıtıdır.
  const collectionA = getCollectionId(a);
  const collectionB = getCollectionId(b);
  if (collectionA && collectionB && collectionA === collectionB) {
    const collectionName = a.belongs_to_collection?.name || b.belongs_to_collection?.name;
    relationships.push({
      type: 'universe',
      score: 96,
      confidence: 98,
      evidence: [`Aynı TMDB koleksiyon kimliği${collectionName ? `: ${collectionName}` : ''}.`],
    });
  }

  // 2) Ortak oyuncular ve yaratıcı ekip üyeleri.
  const castA = new Map((a.cast || []).filter((person) => person?.id != null).map((person) => [person.id, person]));
  const castB = new Map((b.cast || []).filter((person) => person?.id != null).map((person) => [person.id, person]));
  const commonActors = [...castA.keys()]
    .filter((id) => castB.has(id))
    .map((id) => castA.get(id)!.name)
    .filter(Boolean);

  const crewA = new Map((a.crew || []).filter((person) => person?.id != null).map((person) => [person.id, person]));
  const crewB = new Map((b.crew || []).filter((person) => person?.id != null).map((person) => [person.id, person]));
  const commonCrew = [...crewA.keys()]
    .filter((id) => crewB.has(id))
    .map((id) => {
      const left = crewA.get(id)!;
      const right = crewB.get(id)!;
      return `${left.name}${left.job && right.job && left.job !== right.job ? ` (${left.job} / ${right.job})` : ''}`;
    })
    .filter(Boolean);

  if (commonActors.length || commonCrew.length) {
    const score = clamp(65 + Math.min(25, Math.max(0, commonActors.length - 1) * 5 + Math.max(0, commonCrew.length - 1) * 7));
    relationships.push({
      type: 'person',
      score,
      confidence: (a.cast?.length || a.crew?.length) && (b.cast?.length || b.crew?.length) ? 92 : 65,
      evidence: [
        ...(commonActors.length ? [`Ortak oyuncular: ${commonActors.slice(0, 5).join(', ')}.`] : []),
        ...(commonCrew.length ? [`Ortak yaratıcı ekip: ${commonCrew.slice(0, 5).join(', ')}.`] : []),
      ],
    });
  }

  // 3) Açıklama ve türlerden temkinli anlamsal eşleşme.
  // Bu sürüm LLM/embedding kullanmaz; yalnızca gerçek metaverideki ortak kanıtları gösterir.
  const tokensA = tokenize(`${titleOf(a)} ${a.overview || ''}`);
  const tokensB = tokenize(`${titleOf(b)} ${b.overview || ''}`);
  const commonTokens = overlap(tokensA, tokensB);
  const genresA = new Set((a.genre_ids || []).map(Number).filter(Number.isFinite));
  const genresB = new Set((b.genre_ids || []).map(Number).filter(Number.isFinite));
  const commonGenres = overlap(genresA, genresB);
  const tokenSimilarity = tokensA.size && tokensB.size
    ? commonTokens.length / Math.sqrt(tokensA.size * tokensB.size)
    : 0;
  const genreSimilarity = jaccard(genresA, genresB);
  const semanticScore = clamp(65 * tokenSimilarity + 35 * genreSimilarity);

  if ((commonTokens.length >= 2 || commonGenres.length >= 2) && semanticScore >= 18) {
    relationships.push({
      type: 'semantic',
      score: semanticScore,
      confidence: commonTokens.length >= 4 && commonGenres.length >= 2 ? 82 : 58,
      evidence: [
        ...(commonTokens.length ? [`Ortak özet/başlık terimleri: ${commonTokens.slice(0, 6).join(', ')}.`] : []),
        ...(commonGenres.length ? [`Ortak tür kimlikleri: ${commonGenres.join(', ')}.`] : []),
      ],
    });
  }

  return relationships.sort((left, right) => right.score - left.score);
}

function strongestRelationship(
  a: RelationshipContent,
  b: RelationshipContent,
  relationshipFilter: RelationshipType | 'all' = 'all',
): RelationshipGraphLink | null {
  const relations = pairRelationships(a, b).filter(
    (relationship) => relationshipFilter === 'all' || relationship.type === relationshipFilter,
  );
  if (!relations.length) return null;

  const best = relations[0];
  const allTypes = relations.map((relationship) => relationship.type);
  return {
    source: relationshipNodeKey(a),
    target: relationshipNodeKey(b),
    type: best.type,
    alsoRelatedBy: allTypes,
    score: best.score,
    confidence: best.confidence,
    evidence: [...new Set(relations.flatMap((relationship) => relationship.evidence))],
    distance: 175 - best.score * 0.85,
  };
}

function matchesMediaFilter(item: RelationshipContent, mediaFilter: MediaFilter): boolean {
  return mediaFilter === 'all' || item.media_type === mediaFilter;
}

function mergeContent(
  candidates: PoolCandidateItem[],
  savedItems: SavedItem[],
): RelationshipContent[] {
  const byKey = new Map<string, RelationshipContent>();

  for (const candidate of candidates) {
    byKey.set(relationshipNodeKey(candidate), { ...candidate });
  }

  for (const saved of savedItems) {
    const key = relationshipNodeKey(saved);
    const candidate = byKey.get(key);
    // Havuzdaki daha dolu TMDB verisini koru; kullanıcı durumu ve kişisel puan saved kaydından gelir.
    byKey.set(key, {
      ...(candidate || {}),
      ...saved,
      overview: candidate?.overview || saved.overview || '',
      genre_ids: candidate?.genre_ids?.length ? candidate.genre_ids : saved.genre_ids || [],
      cast: candidate?.cast?.length ? candidate.cast : saved.cast,
      crew: candidate?.crew?.length ? candidate.crew : saved.crew,
      belongs_to_collection: candidate?.belongs_to_collection || (saved as any).belongs_to_collection || null,
      poster_path: candidate?.poster_path || saved.poster_path || null,
      status: saved.status,
      personal_rating: saved.personal_rating,
    });
  }

  return [...byKey.values()];
}

function toGraphNode(
  item: RelationshipContent,
  kind: 'saved' | 'candidate' | 'source',
  personalScore: number,
): RelationshipGraphNode {
  const title = titleOf(item);
  return {
    id: relationshipNodeKey(item),
    label: title.length > 26 ? `${title.slice(0, 24)}…` : title,
    title,
    mediaType: item.media_type,
    kind,
    status: item.status,
    personalScore: clamp(personalScore),
    posterPath: item.poster_path,
  };
}

function scoreCandidatesForGraph(
  candidates: PoolCandidateItem[],
  savedItems: SavedItem[],
  preferences: Preferences,
  mediaFilter: MediaFilter,
): Map<string, number> {
  const history = filterHistoryByType(savedItems, mediaFilter);
  const tasteProfile = buildTasteProfileV3(history);
  const eligible = candidates.filter((candidate) =>
    matchesMediaFilter(candidate, mediaFilter)
      && isCandidateEligibleInPool(candidate, savedItems, preferences)
  );

  const scored = scoreCandidatesV3(eligible, tasteProfile, {
    weights: RECOMMENDATION_WEIGHTS_V3,
    mood: preferences.mood,
  });

  const scores = new Map<string, number>();
  for (const entry of scored) {
    const candidate = entry.candidate as PoolCandidateItem;
    const value = Number(entry.rawScore ?? entry.score ?? 50);
    scores.set(makeMediaKey(candidate), clamp(value));
  }
  return scores;
}

function personalScoreFor(
  item: RelationshipContent,
  scores: Map<string, number>,
): number {
  const key = relationshipNodeKey(item);
  const calculated = scores.get(key);
  if (calculated != null) return calculated;
  const rating = Number(item.personal_rating);
  if (Number.isFinite(rating) && rating > 0) return clamp(rating * 10);
  // Puanlanmamış geçmiş içerik nötr kalır; izlenmiş olması tek başına beğeni sayılmaz.
  return 50;
}

export function buildRelationshipGraph(
  options: BuildRelationshipGraphOptions,
): RelationshipGraphData {
  const {
    mode,
    profileId,
    candidates,
    savedItems,
    preferences,
    mediaFilter,
    sourceKey = '',
    maxNodes = 90,
    maxLinks = 160,
    relationshipFilter = 'all',
  } = options;

  const mediaCandidates = candidates.filter((item) => matchesMediaFilter(item, mediaFilter));
  const scores = scoreCandidatesForGraph(mediaCandidates, savedItems, preferences, mediaFilter);
  const mergedItems = mergeContent(mediaCandidates, savedItems)
    .filter((item) => matchesMediaFilter(item, mediaFilter));

  const candidateMap = new Map(mediaCandidates.map((item) => [relationshipNodeKey(item), item]));
  const savedKeys = new Set(savedItems.map((item) => relationshipNodeKey(item)));

  if (mode === 'taste-map') {
    const savedHistory = mergedItems
      .filter((item) => savedKeys.has(relationshipNodeKey(item)))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, 24);

    const eligibleCandidates = mediaCandidates
      .filter((item) => isCandidateEligibleInPool(item, savedItems, preferences))
      .sort((a, b) => (scores.get(makeMediaKey(b)) ?? 50) - (scores.get(makeMediaKey(a)) ?? 50));

    const nodesContent: RelationshipContent[] = [];
    const seen = new Set<string>();

    for (const item of [...savedHistory, ...eligibleCandidates]) {
      const key = relationshipNodeKey(item);
      if (seen.has(key) || nodesContent.length >= maxNodes - 1) continue;
      seen.add(key);
      nodesContent.push(item);
    }

    const nodes: RelationshipGraphNode[] = [
      {
        id: `profile:${profileId}`,
        label: 'Senin zevkin',
        title: 'Kişisel zevk profili',
        mediaType: 'profile',
        kind: 'profile',
        personalScore: 100,
        fx: 0,
        fy: 0,
      },
      ...nodesContent.map((item) => toGraphNode(
        item,
        savedKeys.has(relationshipNodeKey(item)) ? 'saved' : 'candidate',
        personalScoreFor(item, scores),
      )),
    ];

    const links: RelationshipGraphLink[] = nodesContent.map((item) => {
      const score = personalScoreFor(item, scores);
      return {
        source: `profile:${profileId}`,
        target: relationshipNodeKey(item),
        type: 'personal',
        alsoRelatedBy: ['personal'],
        score,
        confidence: scores.has(relationshipNodeKey(item)) ? 82 : (item.personal_rating ? 70 : 45),
        evidence: [
          scores.has(relationshipNodeKey(item))
            ? 'Mevcut CineTrack kişisel puanlama sinyalleri kullanıldı.'
            : item.personal_rating
              ? `Kullanıcının kişisel puanı: ${item.personal_rating}/10.`
              : 'Kişisel puan bulunmadığı için nötr konum kullanıldı.',
        ],
        distance: 60 + (100 - score) * 1.15,
      };
    });

    // Yalnızca ekranda görünen, sınırlandırılmış düğüm kümesi üzerinde ilişki hesaplanır.
    const relatedLinks: RelationshipGraphLink[] = [];
    for (let i = 0; i < nodesContent.length; i += 1) {
      for (let j = i + 1; j < nodesContent.length; j += 1) {
        const link = strongestRelationship(nodesContent[i], nodesContent[j], relationshipFilter);
        if (link && link.score >= 24) relatedLinks.push(link);
      }
    }
    relatedLinks.sort((a, b) => b.score - a.score);
    links.push(...relatedLinks.slice(0, Math.max(0, maxLinks - links.length)));

    return {
      nodes,
      links,
      profileSignature: `${profileId}:${mediaFilter}:v1`,
      createdAt: new Date().toISOString(),
    };
  }

  const sources = mergedItems;
  const source = sources.find((item) => relationshipNodeKey(item) === sourceKey)
    || sources.find((item) => candidateMap.has(relationshipNodeKey(item)))
    || sources[0];

  if (!source) {
    return {
      nodes: [],
      links: [],
      profileSignature: `${profileId}:${mediaFilter}:v1`,
      createdAt: new Date().toISOString(),
    };
  }

  const sourceId = relationshipNodeKey(source);
  const eligibleTargets = mediaCandidates
    .filter((item) =>
      relationshipNodeKey(item) !== sourceId
      && isCandidateEligibleInPool(item, savedItems, preferences)
    )
    .map((item) => {
      const link = strongestRelationship(source, item, relationshipFilter);
      const personalScore = personalScoreFor(item, scores);
      return { item, link, personalScore };
    })
    .filter((entry): entry is { item: PoolCandidateItem; link: RelationshipGraphLink; personalScore: number } => Boolean(entry.link))
    .sort((a, b) =>
      ((b.link?.score ?? 0) * 0.75 + b.personalScore * 0.25)
      - ((a.link?.score ?? 0) * 0.75 + a.personalScore * 0.25)
    )
    .slice(0, Math.max(1, maxNodes - 1));

  const nodes: RelationshipGraphNode[] = [
    {
      ...toGraphNode(source, 'source', personalScoreFor(source, scores)),
      fx: 0,
      fy: 0,
    },
    ...eligibleTargets.map(({ item, personalScore }) =>
      toGraphNode(item, 'candidate', personalScore)
    ),
  ];

  const links = eligibleTargets
    .filter((entry) => entry.link)
    .map((entry) => entry.link!);

  // Komşu düğümler arasındaki güçlü bağlar, kaynağın çevresindeki kümeleri görünür kılar.
  const targetItems = eligibleTargets.map((entry) => entry.item);
  const secondaryLinks: RelationshipGraphLink[] = [];
  for (let i = 0; i < targetItems.length; i += 1) {
    for (let j = i + 1; j < targetItems.length; j += 1) {
      const link = strongestRelationship(targetItems[i], targetItems[j], relationshipFilter);
      if (link && link.score >= 35) secondaryLinks.push(link);
    }
  }
  secondaryLinks.sort((a, b) => b.score - a.score);
  links.push(...secondaryLinks.slice(0, Math.max(0, maxLinks - links.length)));

  return {
    nodes,
    links,
    profileSignature: `${profileId}:${mediaFilter}:v1`,
    createdAt: new Date().toISOString(),
  };
}

export function getRelationshipNodeColor(node: RelationshipGraphNode): string {
  if (node.kind === 'profile') return '#5eead4';
  if (node.kind === 'source') return '#ec4899';
  if (node.kind === 'saved') return '#38bdf8';
  if (node.personalScore >= 80) return '#4ade80';
  if (node.personalScore >= 60) return '#a78bfa';
  return '#94a3b8';
}

export function getRelationshipLinkColor(type: RelationshipType): string {
  switch (type) {
    case 'semantic': return '#38bdf8';
    case 'person': return '#a78bfa';
    case 'universe': return '#4ade80';
    case 'personal': return '#64748b';
  }
}

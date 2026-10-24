# CineTrack — İlişki Keşif Motoru uygulama rehberi

Bu rehber, `6yildiz9-maker/cinetrack` deposunun mevcut React + TypeScript mimarisine göre hazırlanmış bir **uygulama taslağıdır**. Depoya doğrudan commit yapılmamıştır; kod parçalarını uygulayıp ardından test/build çalıştırılmalıdır.

## Mevcut mimaride temas edilecek dosyalar

- `src/core/cinetrack-core.ts`: Mevcut öneri algoritması ve kalıcı aday havuzu. İlk sürümde bu dosyanın mevcut puanlama fonksiyonlarını yeniden yazmayın.
- `src/components/Controls.tsx`: Üst sekmelere `relationships` sekmesi eklenir.
- `src/components/RelationshipExplorer.tsx`: Yeni ortak grafik arayüzü.
- `src/core/relationship-explorer.ts`: İlişki özellikleri, puanlama ve graf veri üretimi.
- `src/App.tsx`: Mevcut havuzları ilişki ekranına bağlama ve sekme koşulları.
- `style.css`: Grafik, filtreler ve ayrıntı paneli stilleri.
- `tests/relationship-explorer.test.mjs`: Saf ilişki fonksiyonları için testler.

## 1. Bağımlılığı ekle

Proje kökünde:

```bash
npm install react-force-graph-2d
```

## 2. Yeni çekirdek dosyasını oluştur

Yeni dosya: `src/core/relationship-explorer.ts`

```ts
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
  [key: string]: unknown;
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
      belongs_to_collection: candidate?.belongs_to_collection || saved.belongs_to_collection || null,
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
```

### Puanlama hakkındaki notlar

- Bu ilk sürüm yalnızca gerçekten mevcut olan özet, tür, oyuncu/yaratıcı ve koleksiyon verilerini kullanır.
- Atmosfer, karşıt fikir veya felsefi kavram ilişkisi üretmez; bu ilişki türleri için kanıta dayalı etiketleme daha sonra eklenmelidir.
- `personalScore` mevcut `buildTasteProfileV3` + `scoreCandidatesV3` fonksiyonlarıyla hesaplanır. İlişki puanı ve kişisel uyum puanı ayrı kalır.
- İlk sürümde ilişki grafiği hesaplanırken en fazla yaklaşık 90 düğüm seçilir; tüm 1.000 adayın çiftli karşılaştırması yapılmaz.
- Bu kod, mevcut havuz nesnelerinde `cast`, `crew`, `belongs_to_collection` bulunabileceğini varsayar ama bulunmasını zorunlu tutmaz.

## 3. Grafik bileşenini oluştur

Yeni dosya: `src/components/RelationshipExplorer.tsx`

```tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import {
  buildRelationshipGraph,
  getRelationshipLinkColor,
  getRelationshipNodeColor,
  getRelationshipTypeLabel,
  relationshipNodeKey,
  type MediaFilter,
  type RelationshipGraphData,
  type RelationshipGraphLink,
  type RelationshipGraphNode,
  type RelationshipMode,
  type RelationshipType,
} from '../core/relationship-explorer';
import type { PoolCandidateItem, Preferences, SavedItem } from '../core/cinetrack-core';

interface RelationshipExplorerProps {
  mode: RelationshipMode;
  profileId: string;
  savedItems: SavedItem[];
  preferences: Preferences;
  candidates: PoolCandidateItem[];
  onRefresh: (mediaFilter: MediaFilter) => Promise<PoolCandidateItem[]>;
  onOpenDetails?: (item: PoolCandidateItem | SavedItem) => void;
  onQuickSave?: (item: PoolCandidateItem | SavedItem) => void;
}

type RelationFilter = RelationshipType | 'all';

function linkEndpointId(endpoint: string | RelationshipGraphNode): string {
  return typeof endpoint === 'string' ? endpoint : endpoint.id;
}

export const RelationshipExplorer: React.FC<RelationshipExplorerProps> = ({
  mode,
  profileId,
  savedItems,
  preferences,
  candidates,
  onRefresh,
  onOpenDetails,
  onQuickSave,
}) => {
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all');
  const [relationFilter, setRelationFilter] = useState<RelationFilter>('all');
  const [sourceKey, setSourceKey] = useState('');
  const [snapshotCandidates, setSnapshotCandidates] = useState<PoolCandidateItem[]>(candidates);
  const [graphData, setGraphData] = useState<RelationshipGraphData | null>(null);
  const [selectedNode, setSelectedNode] = useState<RelationshipGraphNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [size, setSize] = useState({ width: 800, height: 560 });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const element = containerRef.current;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setSize({
        width: Math.max(320, Math.floor(rect.width)),
        height: Math.max(420, Math.floor(rect.height)),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setGraphData(null);
    setSnapshotCandidates([]);
    setSelectedNode(null);
    setSourceKey('');
    setError('');
  }, [profileId, mode]);

  const sourceOptions = useMemo(() => {
    const byKey = new Map<string, PoolCandidateItem | SavedItem>();
    for (const item of [...savedItems, ...snapshotCandidates]) {
      if (mediaFilter !== 'all' && item.media_type !== mediaFilter) continue;
      byKey.set(relationshipNodeKey(item), item);
    }
    return [...byKey.values()].sort((a, b) =>
      String(a.title || a.name || '').localeCompare(String(b.title || b.name || ''), 'tr')
    );
  }, [savedItems, snapshotCandidates, mediaFilter]);

  const createGraph = (
    candidateSnapshot: PoolCandidateItem[],
    requestedSourceKey = sourceKey,
  ) => buildRelationshipGraph({
    mode,
    profileId,
    candidates: candidateSnapshot,
    savedItems,
    preferences,
    mediaFilter,
    sourceKey: requestedSourceKey,
    relationshipFilter: relationFilter,
    maxNodes: 90,
    maxLinks: 160,
  });

  const handleRefresh = async () => {
    setLoading(true);
    setError('');
    try {
      // TMDB/havuz yükleme yalnızca bu kullanıcı eyleminde çalışır.
      const loadedCandidates = await onRefresh(mediaFilter);
      setSnapshotCandidates(loadedCandidates);

      let effectiveSourceKey = sourceKey;
      if (
        mode === 'relationships'
        && !loadedCandidates.some((item) => relationshipNodeKey(item) === effectiveSourceKey)
        && !savedItems.some((item) => relationshipNodeKey(item) === effectiveSourceKey)
      ) {
        const first = [...savedItems, ...loadedCandidates].find(
          (item) => mediaFilter === 'all' || item.media_type === mediaFilter
        );
        effectiveSourceKey = first ? relationshipNodeKey(first) : '';
        setSourceKey(effectiveSourceKey);
      }

      const nextGraph = buildRelationshipGraph({
        mode,
        profileId,
        candidates: loadedCandidates,
        savedItems,
        preferences,
        mediaFilter,
        sourceKey: effectiveSourceKey,
        relationshipFilter: relationFilter,
        maxNodes: 90,
        maxLinks: 160,
      });

      setGraphData(nextGraph);
      setSelectedNode(null);
      if (!nextGraph.nodes.length) {
        setError('Bu filtre için yeterli ilişki verisi bulunamadı.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'İlişki haritası oluşturulamadı.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!graphData) return;
    // Filtreler değiştiğinde sadece önbellekteki adaylarla yerel puanlama yapılır; TMDB isteği yapılmaz.
    setGraphData(createGraph(snapshotCandidates));
    // Bilerek graphData bağımlılığı eklenmiyor; aksi durumda efekt döngüye girer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaFilter, relationFilter, sourceKey]);

  useEffect(() => {
    if (graphData && graphRef.current?.zoomToFit) {
      const timer = window.setTimeout(() => graphRef.current?.zoomToFit(350, 48), 60);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [graphData]);

  const selectedItem = selectedNode
    ? [...snapshotCandidates, ...savedItems].find(
        (item) => relationshipNodeKey(item) === selectedNode.id
      )
    : undefined;

  const selectedLinks: RelationshipGraphLink[] = graphData?.links.filter((link) =>
    linkEndpointId(link.source) === selectedNode?.id
    || linkEndpointId(link.target) === selectedNode?.id
  ) || [];

  const nodeCanvasObject = (rawNode: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const node = rawNode as RelationshipGraphNode & { x?: number; y?: number };
    const x = node.x || 0;
    const y = node.y || 0;
    const radius = node.kind === 'profile' || node.kind === 'source' ? 10 : 6 + node.personalScore / 35;

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
    ctx.fillStyle = getRelationshipNodeColor(node);
    ctx.globalAlpha = node.id === selectedNode?.id ? 1 : 0.88;
    ctx.fill();
    ctx.globalAlpha = 1;

    if (globalScale > 0.7 || node.id === selectedNode?.id) {
      const fontSize = Math.max(4, Math.min(12, 10 / globalScale));
      ctx.font = `${node.id === selectedNode?.id ? '600 ' : ''}${fontSize}px Inter, Arial, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#dbeafe';
      ctx.fillText(node.label, x + radius + 3, y);
    }
  };

  return (
    <section className="relationship-explorer">
      <div className="relationship-toolbar">
        <div>
          <h2>{mode === 'taste-map' ? 'Zevk Haritası' : 'İlişki Keşfi'}</h2>
          <p>
            {mode === 'taste-map'
              ? 'Merkezden uzaklık kişisel uyumu, çizgiler içerikler arasındaki ilişkileri gösterir.'
              : 'Bir kaynak yapım seç; bağlantı türü, kanıtı ve kişisel uyumunu ayrı incele.'}
          </p>
        </div>
        <button className="btn btn-primary" type="button" onClick={handleRefresh} disabled={loading}>
          {loading ? 'Harita hazırlanıyor…' : 'Haritayı Güncelle'}
        </button>
      </div>

      <div className="relationship-filters">
        <label>
          İçerik türü
          <select value={mediaFilter} onChange={(event) => setMediaFilter(event.target.value as MediaFilter)}>
            <option value="all">Film + dizi</option>
            <option value="movie">Sadece film</option>
            <option value="tv">Sadece dizi</option>
          </select>
        </label>

        {mode === 'relationships' && (
          <label>
            Kaynak yapım
            <select value={sourceKey} onChange={(event) => setSourceKey(event.target.value)}>
              <option value="">Kaynak seç…</option>
              {sourceOptions.map((item) => (
                <option key={relationshipNodeKey(item)} value={relationshipNodeKey(item)}>
                  {item.title || item.name || 'Başlıksız'}
                </option>
              ))}
            </select>
          </label>
        )}

        <label>
          İlişki türü
          <select value={relationFilter} onChange={(event) => setRelationFilter(event.target.value as RelationFilter)}>
            <option value="all">Tüm ilişkiler</option>
            <option value="semantic">Anlamsal benzerlik</option>
            <option value="person">Kişi bağlantısı</option>
            <option value="universe">Seri / evren</option>
            {mode === 'taste-map' && <option value="personal">Kişisel uyum</option>}
          </select>
        </label>
      </div>

      {error && <div className="relationship-message" role="status">{error}</div>}

      <div className="relationship-layout">
        <div className="relationship-graph" ref={containerRef}>
          {graphData ? (
            <ForceGraph2D
              ref={graphRef}
              graphData={graphData as any}
              width={size.width}
              height={size.height}
              backgroundColor="#071321"
              nodeRelSize={6}
              nodeCanvasObject={nodeCanvasObject}
              nodeLabel={(rawNode: any) => {
                const node = rawNode as RelationshipGraphNode;
                return `${node.title}\nKişisel uyum: ${node.personalScore}/100`;
              }}
              onNodeClick={(rawNode: any) => setSelectedNode(rawNode as RelationshipGraphNode)}
              linkColor={(link: any) => getRelationshipLinkColor(link.type)}
              linkWidth={(link: any) => Math.max(1, Number(link.score || 0) / 42)}
              linkLabel={(rawLink: any) => {
                const link = rawLink as RelationshipGraphLink;
                return `${getRelationshipTypeLabel(link.type)} · ${link.score}/100 · Güven ${link.confidence}/100\n${link.evidence.join('\n')}`;
              }}
              linkDirectionalParticles={1}
              linkDirectionalParticleWidth={1.5}
              linkDistance={(link: any) => Number(link.distance || 110)}
              cooldownTicks={100}
              d3VelocityDecay={0.3}
              onEngineStop={() => graphRef.current?.pauseAnimation?.()}
            />
          ) : (
            <div className="relationship-empty">
              <div className="relationship-empty-icon">◎</div>
              <h3>Harita henüz oluşturulmadı</h3>
              <p>Mevcut yerel aday havuzunu ve kişisel profilini kullanmak için “Haritayı Güncelle” düğmesine bas.</p>
            </div>
          )}
        </div>

        <aside className="relationship-details">
          <h3>{selectedNode?.title || 'Düğüm ayrıntıları'}</h3>
          {selectedNode ? (
            <>
              <p className="relationship-score">Kişisel uyum: <strong>{selectedNode.personalScore}/100</strong></p>
              <p className="relationship-muted">
                {selectedNode.kind === 'saved' ? `Listendeki durum: ${selectedNode.status || 'kayıtlı'}` :
                  selectedNode.kind === 'profile' ? 'Kullanıcı profili' :
                  selectedNode.kind === 'source' ? 'Seçilmiş kaynak yapım' : 'Keşif adayı'}
              </p>
              {selectedLinks.map((link, index) => (
                <div className="relationship-evidence" key={`${link.type}-${index}`}>
                  <strong>{getRelationshipTypeLabel(link.type)} · {link.score}/100</strong>
                  <span>Güven: {link.confidence}/100</span>
                  <ul>{link.evidence.map((evidence) => <li key={evidence}>{evidence}</li>)}</ul>
                </div>
              ))}
              {selectedItem && onOpenDetails && selectedNode.mediaType !== 'profile' && (
                <button className="btn" type="button" onClick={() => onOpenDetails(selectedItem)}>
                  İçerik ayrıntısını aç
                </button>
              )}
              {selectedItem && onQuickSave && selectedNode.kind === 'candidate' && (
                <button className="btn btn-primary" type="button" onClick={() => onQuickSave(selectedItem)}>
                  Listeye ekle
                </button>
              )}
            </>
          ) : (
            <p className="relationship-muted">Haritadaki bir düğüme tıklayarak puanını ve bağlantı kanıtlarını incele.</p>
          )}
          <div className="relationship-legend">
            <span><i className="legend-dot" style={{ background: '#5eead4' }} /> Kullanıcı profili</span>
            <span><i className="legend-dot" style={{ background: '#38bdf8' }} /> Kayıtlı yapım</span>
            <span><i className="legend-dot" style={{ background: '#4ade80' }} /> Yüksek kişisel uyum</span>
            <span><i className="legend-line" style={{ background: '#38bdf8' }} /> Anlamsal</span>
            <span><i className="legend-line" style={{ background: '#a78bfa' }} /> Kişi</span>
            <span><i className="legend-line" style={{ background: '#4ade80' }} /> Seri / evren</span>
          </div>
        </aside>
      </div>
    </section>
  );
};
```

## 4. `Controls.tsx` içine sekmeyi ekle

`ControlsProps` içindeki sekme tipini ve callback tipini şu şekilde değiştirin:

```tsx
tab: 'discover' | 'list' | 'taste-map' | 'relationships';
onTabChange: (tab: 'discover' | 'list' | 'taste-map' | 'relationships') => void;
```

Sekme grubuna Zevk Haritası düğmesinin yanına ekleyin:

```tsx
<button
  className={`tab ${tab === 'relationships' ? 'active' : ''}`}
  type="button"
  aria-pressed={tab === 'relationships'}
  onClick={() => onTabChange('relationships')}
>
  ◉ İlişki Keşfi
</button>
```

Global içerik filtresinin ilişki modunda ikinci kez görünmesini istemiyorsanız koşulu değiştirin:

```tsx
{tab !== 'taste-map' && tab !== 'relationships' && (
  <div className="filters">
    {/* Mevcut filtre içeriğini aynen koruyun. */}
  </div>
)}
```

Bu değişiklik `Controls.tsx` dosyasındaki mevcut sekme tipini genişletir; diğer filtreleri yeniden yazmayın.

## 5. `App.tsx` bağlantıları

### A. Import ekleyin

`App.tsx` başındaki bileşen importlarına ekleyin:

```tsx
import { RelationshipExplorer } from './components/RelationshipExplorer';
```

Mevcut `cinetrack-core` import listesine `PoolCandidateItem` tipini ekleyin:

```tsx
PoolCandidateItem,
```

`fetchTmdbCached`, `replenishCandidatePool` ve `loadPersistentPoolData` mevcut importlarda bulunuyorsa ikinci kez eklemeyin.

### B. Sekme tipini genişletin

Şunu:

```tsx
const [tab, setTab] = useState<'discover' | 'list' | 'taste-map'>('discover');
```

şuna dönüştürün:

```tsx
const [tab, setTab] = useState<
  'discover' | 'list' | 'taste-map' | 'relationships'
>('discover');
```

### C. Yerel havuzları manuel yükleme işlevi

`App()` içindeki diğer callback'lerin yakınına ekleyin:

```tsx
const handleLoadRelationshipCandidates = useCallback(
  async (mediaFilter: 'all' | 'movie' | 'tv'): Promise<PoolCandidateItem[]> => {
    const mediaTypes: Array<'movie' | 'tv'> =
      mediaFilter === 'all' ? ['movie', 'tv'] : [mediaFilter];

    const result: PoolCandidateItem[] = [];

    // İki havuzu sırayla kontrol ederek gereksiz eşzamanlı yenileme yükünü azalt.
    for (const mediaType of mediaTypes) {
      const pool = await replenishCandidatePool({
        profileId: activeProfileId,
        mediaType,
        savedItems,
        preferences,
        favoriteActors,
        fetchTmdbFn: fetchTmdbCached,
        force: false,
      });

      result.push(...pool.items);
    }

    return result;
  },
  [activeProfileId, savedItems, preferences, favoriteActors],
);
```

`replenishCandidatePool` mevcut yerel havuzu yükler ve yenileme eşiği gerekiyorsa mevcut aday toplama mekanizmasını çalıştırır. Böylece ilişki ekranı ayrı bir TMDB toplu indirme sistemi kurmaz.

### D. Render koşulunu değiştirin

`App.tsx` içinde şu anda `tab === 'taste-map' ? <TasteMapView ... /> : <MediaGrid ... />` biçiminde bir koşul var. Bunu aşağıdaki yapıya dönüştürün; mevcut `TasteMapView` ve `MediaGrid` prop listelerini koruyun.

```tsx
{tab === 'relationships' ? (
  <RelationshipExplorer
    key={`${activeProfileId}-relationships`}
    mode="relationships"
    profileId={activeProfileId}
    savedItems={savedItems}
    preferences={preferences}
    candidates={[]}
    onRefresh={handleLoadRelationshipCandidates}
    onOpenDetails={(item) => setDetailItem(item as SavedItem)}
    onQuickSave={(item) => setQuickSaveItem(item as SavedItem)}
  />
) : tab === 'taste-map' ? (
  <div className="taste-map-page">
    <div className="taste-map-view-toggle">
      <button
        className="btn btn-primary"
        type="button"
        onClick={() => setTasteMapDisplayMode('graph')}
        aria-pressed={tasteMapDisplayMode === 'graph'}
      >
        Ağ haritası
      </button>
      <button
        className="btn"
        type="button"
        onClick={() => setTasteMapDisplayMode('list')}
        aria-pressed={tasteMapDisplayMode === 'list'}
      >
        Liste
      </button>
    </div>

    {tasteMapDisplayMode === 'graph' ? (
      <RelationshipExplorer
        key={`${activeProfileId}-taste-map`}
        mode="taste-map"
        profileId={activeProfileId}
        savedItems={savedItems}
        preferences={preferences}
        candidates={[]}
        onRefresh={handleLoadRelationshipCandidates}
        onOpenDetails={(item) => setDetailItem(item as SavedItem)}
        onQuickSave={(item) => setQuickSaveItem(item as SavedItem)}
      />
    ) : (
      <TasteMapView
        tasteMap={tasteMap}
        summary={tasteSummary}
        genresMap={genresMap}
        onOpenDetails={(item) => setDetailItem(item)}
        onQuickSave={(item) => setQuickSaveItem(item)}
        onSetStatus={(item, status) => handleSetStatus(item, status)}
        onToggleDislike={(key) => handleToggleDislike(key)}
        onRefreshTasteMap={handleRefreshTasteMap}
        isLoading={isLoading}
        isDemo={Boolean(activeProfile?.isDemo)}
        tmdbSource={tmdbSourceMeta.source}
        tmdbStaleReason={tmdbSourceMeta.staleReason}
      />
    )}
  </div>
) : (
  <MediaGrid
    {/* Mevcut MediaGrid prop listesini hiçbir alanı kaybetmeden aynen koruyun. */}
  />
)}
```

Yukarıdaki `MediaGrid` kısmı bir yer tutucudur. Mevcut `MediaGrid` prop listesini tamamen kaldırıp bu yorumu koymayın; yalnızca dıştaki koşulu değiştirin ve mevcut `MediaGrid` çağrınızı olduğu gibi bırakın.

Ayrıca `App()` içindeki state tanımlarına ekleyin:

```tsx
const [tasteMapDisplayMode, setTasteMapDisplayMode] =
  useState<'graph' | 'list'>('graph');
```

**Önemli düzeltme:** `RelationshipExplorer` props içindeki `candidates` alanına `[]` geçilebilir; bileşen her manuel güncellemede `onRefresh` üzerinden yerel havuzları alır. Eğer bir önceki ekrandan zaten yüklenmiş adayları ilk açılışta göstermek istiyorsanız `candidates` propunu gerçek bir state ile besleyin; grafik yine yalnızca kullanıcı güncelleyince kurulacaktır.

### E. Doğrudan kopyalamadan önce kontrol edin

`App.tsx` içinde `setDetailItem`, `setQuickSaveItem`, `handleSetStatus`, `handleToggleDislike`, `handleRefreshTasteMap` ve `tasteMapDisplayMode` isimlerinin mevcut uygulamanızdaki adlarla birebir aynı olduğunu doğrulayın. `setDetailItem` ve `setQuickSaveItem` öğe tipi daha dar ise callback'e cast vermek yerine modalın kabul ettiği ortak item tipine uygun dönüşüm kullanın.

## 6. `style.css` içine ekleyin

```css
.relationship-explorer {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  color: var(--text, #e5edf7);
}

.relationship-toolbar {
  display: flex;
  gap: 16px;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
}

.relationship-toolbar h2 {
  margin: 0 0 4px;
}

.relationship-toolbar p,
.relationship-muted {
  color: var(--muted, #94a3b8);
  font-size: 0.88rem;
  margin: 0;
}

.relationship-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: end;
}

.relationship-filters label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 0.82rem;
  color: var(--muted, #94a3b8);
}

.relationship-filters select {
  min-width: 170px;
  max-width: 300px;
}

.relationship-message {
  border: 1px solid rgba(248, 113, 113, 0.35);
  border-radius: 10px;
  padding: 10px 12px;
  color: #fecaca;
  background: rgba(127, 29, 29, 0.16);
}

.relationship-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 290px;
  gap: 12px;
  min-width: 0;
}

.relationship-graph {
  width: 100%;
  height: min(70vh, 720px);
  min-height: 420px;
  overflow: hidden;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 14px;
  background: #071321;
}

.relationship-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
  color: #cbd5e1;
}

.relationship-empty h3 {
  margin: 10px 0 6px;
}

.relationship-empty p {
  max-width: 430px;
  color: #94a3b8;
}

.relationship-empty-icon {
  color: #5eead4;
  font-size: 3rem;
}

.relationship-details {
  min-width: 0;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 14px;
  padding: 14px;
  background: rgba(15, 23, 42, 0.6);
  overflow: auto;
  max-height: min(70vh, 720px);
}

.relationship-details h3 {
  font-size: 1rem;
  overflow-wrap: anywhere;
  margin-top: 0;
}

.relationship-score {
  border-radius: 8px;
  background: rgba(45, 212, 191, 0.08);
  border: 1px solid rgba(45, 212, 191, 0.2);
  padding: 8px;
}

.relationship-evidence {
  border-top: 1px solid rgba(148, 163, 184, 0.18);
  padding: 10px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.85rem;
}

.relationship-evidence span {
  color: #94a3b8;
}

.relationship-evidence ul {
  margin: 0;
  padding-left: 18px;
  color: #cbd5e1;
}

.relationship-evidence li + li {
  margin-top: 4px;
}

.relationship-legend {
  display: grid;
  gap: 8px;
  border-top: 1px solid rgba(148, 163, 184, 0.18);
  margin-top: 12px;
  padding-top: 12px;
  font-size: 0.8rem;
  color: #cbd5e1;
}

.relationship-legend span {
  display: flex;
  align-items: center;
  gap: 8px;
}

.legend-dot {
  width: 9px;
  height: 9px;
  flex: 0 0 auto;
  border-radius: 50%;
}

.legend-line {
  width: 20px;
  height: 3px;
  flex: 0 0 auto;
  border-radius: 2px;
}

.taste-map-view-toggle {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

@media (max-width: 920px) {
  .relationship-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .relationship-details {
    max-height: none;
  }

  .relationship-graph {
    height: 60vh;
    min-height: 360px;
  }
}
```

## 7. Test ekleyin

Yeni dosya: `tests/relationship-explorer.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelationshipGraph } from '../src/core/relationship-explorer.ts';

const preferences = {
  disliked: [],
  hidden: [],
  providers: [],
  mood: '',
  reminders: false,
  notified: [],
};

function candidate(id, overrides = {}) {
  return {
    id,
    media_type: 'movie',
    title: `Film ${id}`,
    overview: 'Bilinç ve insanlık teknoloji karşısında değişir.',
    genre_ids: [878, 18],
    vote_average: 7,
    vote_count: 100,
    popularity: 10,
    poolSource: 'exploration',
    poolSources: 1,
    era: 'modern',
    popularityTier: 'medium',
    ...overrides,
  };
}

test('aynı koleksiyon ilişki bağlantısı üretir', () => {
  const data = buildRelationshipGraph({
    mode: 'relationships',
    profileId: 'test',
    candidates: [
      candidate(1, { title: 'Kaynak', belongs_to_collection: { id: 10, name: 'Seri A' } }),
      candidate(2, { title: 'Devam', belongs_to_collection: { id: 10, name: 'Seri A' } }),
      candidate(3, { title: 'Başka', belongs_to_collection: { id: 99, name: 'Seri B' } }),
    ],
    savedItems: [],
    preferences,
    mediaFilter: 'movie',
    sourceKey: 'movie:1',
    relationshipFilter: 'universe',
  });

  assert.ok(data.links.some((link) => link.type === 'universe' && link.score >= 90));
  assert.ok(data.nodes.every((node) => node.mediaType === 'movie' || node.mediaType === 'profile'));
});

test('film filtresinde diziler grafiğe girmez', () => {
  const data = buildRelationshipGraph({
    mode: 'taste-map',
    profileId: 'test',
    candidates: [
      candidate(1),
      candidate(2, { id: 2, media_type: 'tv', title: 'Dizi 2' }),
    ],
    savedItems: [],
    preferences,
    mediaFilter: 'movie',
  });

  assert.ok(data.nodes.every((node) => node.mediaType !== 'tv'));
});

test('ilişki modu kaynak düğümü merkezde tutar', () => {
  const data = buildRelationshipGraph({
    mode: 'relationships',
    profileId: 'test',
    candidates: [
      candidate(1),
      candidate(2, { belongs_to_collection: { id: 10, name: 'Seri A' } }),
    ],
    savedItems: [],
    preferences,
    mediaFilter: 'movie',
    sourceKey: 'movie:1',
    relationshipFilter: 'all',
  });

  assert.equal(data.nodes[0]?.id, 'movie:1');
  assert.equal(data.nodes[0]?.fx, 0);
  assert.equal(data.nodes[0]?.fy, 0);
});
```

`package.json` test betiği şu an sadece `tests/core.test.mjs` dosyasını çalıştırıyorsa, yeni dosyayı da dahil edin:

```json
{
  "scripts": {
    "test": "tsx --test tests/core.test.mjs tests/relationship-explorer.test.mjs"
  }
}
```

Mevcut `scripts` içindeki diğer komutları silmeden yalnızca `test` değerini değiştirin.

## 8. Çalıştırma ve kontrol

Kod değişikliklerinden sonra proje kökünde:

```bash
npm run lint
npm test
npm run build
```

Şu senaryoları elle de doğrulayın:

1. `İlişki Keşfi` sekmesi açılıyor; ilk açılışta otomatik TMDB istekleri başlamıyor.
2. “Haritayı Güncelle” düğmesi mevcut yerel havuzları yüklüyor.
3. “Sadece film” seçiliyken hiçbir dizi düğümü görünmüyor; aynı kural dizi filtresinde de geçerli.
4. Kaynak yapım seçildiğinde ilişki modu o yapım etrafında oluşuyor.
5. Karttaki kişisel uyum puanı ile çizginin ilişki puanı birbirinden farklı gösteriliyor.
6. Gizlenen/ilgilenilmeyen veya zaten listede bulunan içerikler yeni keşif hedefleri olarak geri gelmiyor.
7. Profil değiştirildiğinde önceki profilin grafik verisi ekranda kalmıyor.
8. Grafik durduktan sonra pan/zoom ve düğüm seçimi yeni puanlama veya TMDB isteği başlatmıyor.

## 9. Bilinen ilk sürüm sınırları

- Atmosfer, kavramsal ilişki ve karşıt fikir henüz uygulanmıyor. Bunlar için ayrı ve kanıta dayalı etiket üretimi gerekir.
- Seri/evren bağlantısı bu sürümde yalnızca `belongs_to_collection` gibi doğrudan veriler üzerinden kuruluyor.
- Anlamsal ilişki ilk aşamada kontrollü token örtüşmesi ve tür benzerliğine dayanıyor; embedding veya LLM tabanlı bir semantik model değildir.
- `personalScore` ayrı bir kişisel ölçümdür; kullanıcı beğeni olasılığı olarak yorumlanmamalıdır.
- Bu rehber deposuna uygulanmış ve test edilmiş bir commit değildir. Mevcut fonksiyon tiplerini gerçek yerel checkout üzerinde doğrulayarak kodu ekleyin; özellikle `scoreCandidatesV3` dönüş tipi ve uygulamadaki modal prop tiplerini TypeScript kontrolüyle teyit edin.

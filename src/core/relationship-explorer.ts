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
} from './cinetrack-core.ts';
import {
  cosineSimilarity,
  ENCODING_LAYOUT_VERSION,
  type ItemFeatureEncoding,
} from './encoding.ts';
import { buildProfileCentroid, profileSimilarityScore } from './scoring.ts';
import { getItemEncodingSync } from '../services/encoding-service.ts';
import {
  getSeriesForMediaSync,
  getSeriesCollectionByKeySync,
} from '../services/storage-idb.ts';
import {
  KNOWN_TV_FRANCHISES,
  buildKnownTvFranchiseCollection,
} from '../services/series-tv-seeds.ts';
import {
  STOP_WORDS,
  GENERIC_PLOT_WORDS,
  ATMOSPHERIC_TONE_WORDS,
  DARK_ATMOSPHERE_GENRES,
  IMAGINATIVE_ATMOSPHERE_GENRES,
  LIGHT_TONE_GENRES,
  getRelationshipTypeLabel,
  getRelationshipNodeColor,
  getRelationshipLinkColor,
} from './relationship-wordlists.ts';

export { getRelationshipTypeLabel, getRelationshipNodeColor, getRelationshipLinkColor };

export type RelationshipMode = 'taste-map' | 'relationships';
export type MediaFilter = 'all' | 'movie' | 'tv';
export type RelationshipType = 'semantic' | 'person' | 'universe' | 'atmosphere' | 'contrast' | 'personal';
export type RelationshipStatusSignal = 'completed-history' | 'interest' | 'neutral' | 'disliked' | 'hidden';

export interface RelationshipMetadataCoverage {
  overview: boolean;
  genres: boolean;
  cast: 'unknown' | 'partial' | 'complete';
  crew: 'unknown' | 'partial' | 'complete';
  collection: 'unknown' | 'present' | 'not-applicable' | 'not-found';
}

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
  addedAt?: string;
  updatedAt?: string;
  cast?: Array<{ id: number; name: string; character?: string }>;
  crew?: Array<{ id: number; name: string; job?: string; department?: string }>;
  belongs_to_collection?: { id?: number; name?: string } | null;
  metadataCoverage?: RelationshipMetadataCoverage;
}

export interface RelationshipGraphNode {
  id: string;
  label: string;
  title: string;
  mediaType: 'profile' | 'movie' | 'tv';
  kind: 'profile' | 'saved' | 'candidate' | 'source';
  status?: string;
  statusWeight?: number;
  statusSignal?: RelationshipStatusSignal;
  personalScore: number;
  posterPath?: string | null;
  fx?: number;
  fy?: number;
  x?: number;
  y?: number;
}

export interface RelationshipEvidenceDetail {
  type: Exclude<RelationshipType, 'personal'>;
  score: number;
  confidence: number;
  evidence: string[];
  breakdown?: {
    vectorContribution?: number;
    genreContribution?: number;
    personContribution?: number;
    toneContribution?: number;
    seriesContribution?: number;
    contrastContribution?: number;
  };
}

export interface RelationshipGraphLink {
  source: string | RelationshipGraphNode;
  target: string | RelationshipGraphNode;
  type: RelationshipType;
  alsoRelatedBy: RelationshipType[];
  score: number;
  confidence: number;
  evidence: string[];
  relationshipDetails?: RelationshipEvidenceDetail[];
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
  favoriteActorIds?: number[];
  genreNames?: Record<number, string>;
}

export const RELATIONSHIP_MODEL_VERSION = 'relationship-v3';
export const RELATIONSHIP_GRAPH_SCHEMA_VERSION = 2;

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
      rating:
        item.personal_rating === '' || item.personal_rating == null
          ? null
          : Number(item.personal_rating),
      updatedAt: item.updatedAt || item.addedAt || '',
      title: String(item.title || item.name || ''),
      overview: String(item.overview || '').trim(),
      genres: [...(item.genre_ids || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b),
      castIds: (item.cast || []).map((person) => Number(person.id)).filter(Number.isFinite).sort((a, b) => a - b),
      crewIds: (item.crew || []).map((person) => Number(person.id)).filter(Number.isFinite).sort((a, b) => a - b),
      collectionId:
        (item as any).belongs_to_collection?.id == null
          ? null
          : String((item as any).belongs_to_collection.id),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const signatureSource = {
    profileId,
    mediaFilter,
    relationshipModelVersion: RELATIONSHIP_MODEL_VERSION,
    graphSchemaVersion: RELATIONSHIP_GRAPH_SCHEMA_VERSION,
    encodingLayoutVersion: ENCODING_LAYOUT_VERSION,
    history,
    preferences: {
      disliked: sortedStrings(preferences.disliked).filter(
        (key) => mediaFilter === 'all' || key.startsWith(`${mediaFilter}:`),
      ),
      hidden: sortedStrings(preferences.hidden).filter(
        (key) => mediaFilter === 'all' || key.startsWith(`${mediaFilter}:`),
      ),
      providers: sortedStrings(preferences.providers),
      mood: preferences.mood || '',
      favoriteActorIds: [...favoriteActorIds]
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b),
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
      collectionId:
        item.belongs_to_collection?.id == null
          ? null
          : String(item.belongs_to_collection.id),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return stableHash(features);
}

interface PairRelationship {
  type: Exclude<RelationshipType, 'personal'>;
  score: number;
  confidence: number;
  evidence: string[];
}

export function relationshipNodeKey(item: any): string {
  if (!item) return '';
  const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
  return makeMediaKey(mediaType, item.id);
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : min)));
}

function titleOf(item: RelationshipContent): string {
  return String(item.title || item.name || 'Başlıksız yapım');
}

export function tokenize(text: string): Set<string> {
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
          !/^\d+$/.test(word),
      ),
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

export interface RelationshipContentPrecomputed {
  item: RelationshipContent;
  key: string;
  tokens: Set<string>;
  genres: Set<number>;
  castMap: Map<number, { id: number; name: string; character?: string }>;
  crewMap: Map<number, { id: number; name: string; job?: string }>;
  collectionId: string | null;
  seriesKey: string | null;
  keywordIds: Set<number>;
  year: number;
  encoding: ItemFeatureEncoding;
}

export function precomputeRelationshipContent(item: RelationshipContent): RelationshipContentPrecomputed {
  const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
  const key = makeMediaKey(mediaType, item.id);
  const text = `${titleOf(item)} ${item.overview || ''}`;
  const tokens = tokenize(text);
  const genres = new Set((item.genre_ids || []).map(Number).filter(Number.isFinite));
  const castMap = new Map((item.cast || []).filter((p) => p?.id != null).map((p) => [p.id, p]));
  const crewMap = new Map((item.crew || []).filter((p) => p?.id != null).map((p) => [p.id, p]));
  const collectionId = getCollectionId(item);

  // ct:series-index entegrasyonu (W3)
  let seriesCol = getSeriesForMediaSync(key);
  if (!seriesCol && mediaType === 'tv') {
    const tvId = Number(item.id);
    for (const franchise of Object.values(KNOWN_TV_FRANCHISES)) {
      if (franchise.parts.some((p) => p.id === tvId)) {
        seriesCol = buildKnownTvFranchiseCollection(franchise, tvId, item, null);
        break;
      }
    }
  }
  const seriesKey = seriesCol ? `collection:${seriesCol.media_type}:${seriesCol.id}` : null;

  const rawKw = (item as any).keywords || (item as any).keyword_ids || [];
  const kwList = Array.isArray(rawKw)
    ? rawKw.map((k: any) => (typeof k === 'object' && k ? Number(k.id) : Number(k))).filter(Number.isFinite)
    : [];
  const keywordIds = new Set<number>(kwList);

  const dateStr = item.release_date || item.first_air_date || '';
  const year = Number(dateStr.slice(0, 4));

  const encoding = getItemEncodingSync(item);

  return {
    item,
    key,
    tokens,
    genres,
    castMap,
    crewMap,
    collectionId,
    seriesKey,
    keywordIds,
    year: Number.isFinite(year) ? year : 0,
    encoding,
  };
}

function deriveMetadataCoverage(
  item: RelationshipContent,
  existing?: RelationshipMetadataCoverage,
): RelationshipMetadataCoverage {
  return {
    overview: Boolean(item.overview?.trim()),
    genres: Boolean(item.genre_ids?.length),
    cast: existing?.cast === 'complete' ? 'complete' : item.cast?.length ? 'partial' : 'unknown',
    crew: existing?.crew === 'complete' ? 'complete' : item.crew?.length ? 'partial' : 'unknown',
    collection:
      item.belongs_to_collection?.id != null
        ? 'present'
        : existing?.collection === 'not-applicable' || existing?.collection === 'not-found'
          ? existing.collection
          : item.media_type === 'tv'
            ? 'not-applicable'
            : 'unknown',
  };
}

export function personEvidenceConfidence(a: RelationshipContent, b: RelationshipContent): number {
  const aKnown = Boolean(a.cast?.length || a.crew?.length);
  const bKnown = Boolean(b.cast?.length || b.crew?.length);
  if (!aKnown || !bKnown) return 45;

  const aCoverage = a.metadataCoverage ?? deriveMetadataCoverage(a);
  const bCoverage = b.metadataCoverage ?? deriveMetadataCoverage(b);
  const aComplete = aCoverage.cast === 'complete' && aCoverage.crew === 'complete';
  const bComplete = bCoverage.cast === 'complete' && bCoverage.crew === 'complete';
  if (aComplete && bComplete) return 96;

  // Sürekli kapsama oranı (coverage ratio ∈ [0, 1]) ile [72..94] bandında ölçekleme (Bölüm 2.2 W5)
  const castRatioA = aCoverage.cast === 'complete' ? 1 : Math.min(1, Math.max(0, ((a.cast?.length || 0) - 1) / 9));
  const castRatioB = bCoverage.cast === 'complete' ? 1 : Math.min(1, Math.max(0, ((b.cast?.length || 0) - 1) / 9));
  const crewRatioA = aCoverage.crew === 'complete' ? 1 : Math.min(1, Math.max(0, (a.crew?.length || 0) / 4));
  const crewRatioB = bCoverage.crew === 'complete' ? 1 : Math.min(1, Math.max(0, (b.crew?.length || 0) / 4));
  const coverageRatio = castRatioA * 0.3 + castRatioB * 0.3 + crewRatioA * 0.2 + crewRatioB * 0.2;

  return clamp(Math.round(72 + coverageRatio * 22), 72, 94);
}

export function pairRelationships(
  a: RelationshipContent | RelationshipContentPrecomputed,
  b: RelationshipContent | RelationshipContentPrecomputed,
  genreNames: Record<number, string> = {},
): PairRelationship[] {
  const aPre: RelationshipContentPrecomputed =
    'tokens' in a && (a as any).tokens instanceof Set
      ? (a as RelationshipContentPrecomputed)
      : precomputeRelationshipContent(a as RelationshipContent);
  const bPre: RelationshipContentPrecomputed =
    'tokens' in b && (b as any).tokens instanceof Set
      ? (b as RelationshipContentPrecomputed)
      : precomputeRelationshipContent(b as RelationshipContent);

  const relationships: PairRelationship[] = [];

  // 1) Seri / Evren bağlantısı: Hem TMDB koleksiyonu hem de ct:series-index (W3)
  const colA = aPre.collectionId;
  const colB = bPre.collectionId;
  const serA = aPre.seriesKey;
  const serB = bPre.seriesKey;

  if ((colA && colB && colA === colB) || (serA && serB && serA === serB)) {
    const seriesCol = serA ? getSeriesCollectionByKeySync(serA) : null;
    const collectionName =
      seriesCol?.name || aPre.item.belongs_to_collection?.name || bPre.item.belongs_to_collection?.name;
    relationships.push({
      type: 'universe',
      score: 96,
      confidence: 98,
      evidence: [`Aynı seri / evren bağlantısı${collectionName ? `: ${collectionName}` : ''}.`],
    });
  }

  // 2) Ortak oyuncular ve yaratıcı ekip üyeleri
  const commonActors = [...aPre.castMap.keys()]
    .filter((id) => bPre.castMap.has(id))
    .map((id) => aPre.castMap.get(id)!.name)
    .filter(Boolean);

  const commonCrew = [...aPre.crewMap.keys()]
    .filter((id) => bPre.crewMap.has(id))
    .map((id) => {
      const left = aPre.crewMap.get(id)!;
      const right = bPre.crewMap.get(id)!;
      return `${left.name}${left.job && right.job && left.job !== right.job ? ` (${left.job} / ${right.job})` : ''}`;
    })
    .filter(Boolean);

  if (commonActors.length || commonCrew.length) {
    const score = clamp(
      86 + Math.min(10, Math.max(0, commonActors.length - 1) * 4 + Math.max(0, commonCrew.length - 1) * 5),
      75,
      96
    );
    relationships.push({
      type: 'person',
      score,
      confidence: personEvidenceConfidence(aPre.item, bPre.item),
      evidence: [
        ...(commonActors.length ? [`Ortak oyuncular: ${commonActors.slice(0, 5).join(', ')}.`] : []),
        ...(commonCrew.length ? [`Ortak yaratıcı ekip: ${commonCrew.slice(0, 5).join(', ')}.`] : []),
      ],
    });
  }

  // 3) Anlamsal benzerlik: Ön-hesaplı tokenlar + tür jaccard + keyword-ID overlap + vektör benzerliği (W1 & W2)
  const commonTokens = overlap(aPre.tokens, bPre.tokens);
  const commonGenres = overlap(aPre.genres, bPre.genres);
  const commonKeywords = overlap(aPre.keywordIds, bPre.keywordIds);
  const genreEvidence = commonGenres.map(
    (id) => genreNames[Number(id)] || `Bilinmeyen tür (${id})`,
  );
  const tokenSimilarity =
    aPre.tokens.size && bPre.tokens.size
      ? commonTokens.length / Math.sqrt(aPre.tokens.size * bPre.tokens.size)
      : 0;
  const genreSimilarity = jaccard(aPre.genres, bPre.genres);
  const vecSim =
    aPre.encoding && bPre.encoding
      ? cosineSimilarity(aPre.encoding.denseVector, bPre.encoding.denseVector)
      : 0;

  const semanticScore = clamp(
    Math.round(55 * tokenSimilarity + 30 * genreSimilarity + 15 * vecSim)
  );

  if ((commonTokens.length >= 2 || commonGenres.length >= 2 || commonKeywords.length >= 1 || vecSim >= 0.38) && semanticScore >= 18) {
    relationships.push({
      type: 'semantic',
      score: semanticScore,
      confidence: commonTokens.length >= 4 && commonGenres.length >= 2 ? 82 : commonKeywords.length >= 2 ? 76 : 58,
      evidence: [
        ...(commonTokens.length
          ? [`Ortak özet/başlık terimleri: ${commonTokens.slice(0, 6).join(', ')}.`]
          : []),
        ...(commonKeywords.length
          ? [`Ortak anahtar kelimeler: ${commonKeywords.length} eşleşme.`]
          : []),
        ...(genreEvidence.length
          ? [`Ortak türler: ${genreEvidence.join(', ')}.`]
          : []),
      ],
    });
  }

  // 4) Atmosferik / duygusal yakınlık: ortak atmosferik tür kümesi + ortak ton kelimeleri / yakın dönem
  const sharedDarkGenres = commonGenres.filter((gid) => DARK_ATMOSPHERE_GENRES.has(Number(gid)));
  const sharedImaginativeGenres = commonGenres.filter((gid) => IMAGINATIVE_ATMOSPHERE_GENRES.has(Number(gid)));
  const toneTokens = commonTokens.filter((tok) => ATMOSPHERIC_TONE_WORDS.has(tok));
  const yearA = aPre.year;
  const yearB = bPre.year;
  const yearDelta = yearA >= 1900 && yearB >= 1900 ? Math.abs(yearA - yearB) : null;

  const hasAtmosphereCluster =
    sharedDarkGenres.length >= 2 ||
    sharedImaginativeGenres.length >= 2 ||
    ((sharedDarkGenres.length >= 1 || sharedImaginativeGenres.length >= 1) && toneTokens.length >= 1);

  if (hasAtmosphereCluster) {
    const clusterGenres = sharedDarkGenres.length >= sharedImaginativeGenres.length ? sharedDarkGenres : sharedImaginativeGenres;
    const clusterNames = clusterGenres.map((gid) => genreNames[Number(gid)] || `Tür (${gid})`);
    const eraBonus = yearDelta !== null && yearDelta <= 6 ? 8 : 0;
    const atmosphereScore = clamp(
      Math.min(82, 46 + clusterGenres.length * 10 + Math.min(16, toneTokens.length * 8) + eraBonus),
    );
    const evidenceLines: string[] = [
      `Ortak atmosfer kümesi: ${clusterNames.join(', ')}.`,
    ];
    if (toneTokens.length > 0) {
      evidenceLines.push(`Ortak ton ve duygu izleri: ${toneTokens.slice(0, 4).join(', ')}.`);
    }
    if (yearDelta !== null && yearDelta <= 6) {
      evidenceLines.push(`Yakın dönem sinematografisi (${yearA} – ${yearB}).`);
    }
    relationships.push({
      type: 'atmosphere',
      score: atmosphereScore,
      confidence: toneTokens.length >= 1 && clusterGenres.length >= 2 ? 84 : 68,
      evidence: evidenceLines,
    });
  }

  // 5) Karşıt ton / tamamlayıcı deneyim
  const hasSharedAnchor = commonActors.length > 0 || commonCrew.length > 0 || commonTokens.length >= 2;
  if (hasSharedAnchor) {
    const aHasDark = [...aPre.genres].some((gid) => DARK_ATMOSPHERE_GENRES.has(gid));
    const bHasDark = [...bPre.genres].some((gid) => DARK_ATMOSPHERE_GENRES.has(gid));
    const aHasLight = [...aPre.genres].some((gid) => LIGHT_TONE_GENRES.has(gid));
    const bHasLight = [...bPre.genres].some((gid) => LIGHT_TONE_GENRES.has(gid));
    const tonalContrast = (aHasDark && bHasLight && !aHasLight) || (bHasDark && aHasLight && !bHasLight);
    const formatContrast = aPre.item.media_type !== bPre.item.media_type && (commonCrew.length > 0 || commonActors.length > 0 || commonGenres.length >= 1);

    if (tonalContrast || formatContrast) {
      const contrastEvidence: string[] = [];
      if (tonalContrast) {
        contrastEvidence.push('Ortak bağ korunurken karanlık/gerilimli ve sıcak/hafif tonlar birbirini dengeler.');
      }
      if (formatContrast) {
        contrastEvidence.push(
          `Farklı anlatı temposu (${aPre.item.media_type === 'tv' ? 'Dizi' : 'Film'} ↔ ${bPre.item.media_type === 'tv' ? 'Dizi' : 'Film'}).`,
        );
      }
      if (commonCrew.length > 0) {
        contrastEvidence.push(`Ortak yaratıcı imza: ${commonCrew.slice(0, 2).join(', ')}.`);
      } else if (commonActors.length > 0) {
        contrastEvidence.push(`Ortak oyuncu köprüsü: ${commonActors.slice(0, 2).join(', ')}.`);
      } else if (commonTokens.length >= 2) {
        contrastEvidence.push(`Ortak tema köprüsü: ${commonTokens.slice(0, 3).join(', ')}.`);
      }

      const contrastScore = clamp(
        Math.min(76, 44 + (tonalContrast ? 14 : 0) + (formatContrast ? 10 : 0) + Math.min(8, commonTokens.length * 3)),
      );
      relationships.push({
        type: 'contrast',
        score: contrastScore,
        confidence: commonCrew.length > 0 || commonActors.length > 0 ? 80 : 64,
        evidence: contrastEvidence,
      });
    }
  }

  return relationships.sort((left, right) => right.score - left.score);
}

function computeRelationshipBreakdown(type: Exclude<RelationshipType, 'personal'>): RelationshipEvidenceDetail['breakdown'] {
  switch (type) {
    case 'semantic':
      return { vectorContribution: 45, genreContribution: 35, toneContribution: 20 };
    case 'person':
      return { personContribution: 75, genreContribution: 25 };
    case 'universe':
      return { seriesContribution: 85, genreContribution: 15 };
    case 'atmosphere':
      return { toneContribution: 50, genreContribution: 35, vectorContribution: 15 };
    case 'contrast':
      return { contrastContribution: 60, personContribution: 25, genreContribution: 15 };
    default:
      return { vectorContribution: 50, genreContribution: 50 };
  }
}

export function strongestRelationship(
  a: RelationshipContent | RelationshipContentPrecomputed,
  b: RelationshipContent | RelationshipContentPrecomputed,
  relationshipFilter: RelationshipType | 'all' = 'all',
  genreNames: Record<number, string> = {},
): RelationshipGraphLink | null {
  const aItem = 'tokens' in a ? a.item : a;
  const bItem = 'tokens' in b ? b.item : b;
  const relations = pairRelationships(a, b, genreNames).filter(
    (relationship) => relationshipFilter === 'all' || relationship.type === relationshipFilter,
  );
  if (!relations.length) return null;

  const best = relations[0];
  const allTypes = relations.map((relationship) => relationship.type);
  return {
    source: relationshipNodeKey(aItem),
    target: relationshipNodeKey(bItem),
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
      breakdown: computeRelationshipBreakdown(relationship.type),
    })),
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
    const rawCandidate = candidate as PoolCandidateItem & {
      metadataCoverage?: RelationshipMetadataCoverage;
    };
    const content: RelationshipContent = {
      ...candidate,
    };
    content.metadataCoverage = deriveMetadataCoverage(content, rawCandidate.metadataCoverage);
    byKey.set(relationshipNodeKey(candidate), content);
  }

  for (const saved of savedItems) {
    const key = relationshipNodeKey(saved);
    const candidate = byKey.get(key);
    const savedCoverage = (saved as SavedItem & { metadataCoverage?: RelationshipMetadataCoverage })
      .metadataCoverage;
    // Havuzdaki daha dolu TMDB verisini koru; kullanıcı durumu ve kişisel puan saved kaydından gelir.
    const merged: RelationshipContent = {
      ...(candidate || {}),
      ...saved,
      overview: candidate?.overview || saved.overview || '',
      genre_ids: candidate?.genre_ids?.length ? candidate.genre_ids : saved.genre_ids || [],
      cast: candidate?.cast?.length ? candidate.cast : saved.cast,
      crew: candidate?.crew?.length ? candidate.crew : saved.crew,
      belongs_to_collection:
        candidate?.belongs_to_collection || (saved as any).belongs_to_collection || null,
      poster_path: candidate?.poster_path || saved.poster_path || null,
      status: saved.status,
      personal_rating: saved.personal_rating,
    };
    merged.metadataCoverage = deriveMetadataCoverage(merged, {
      overview: Boolean(merged.overview?.trim()),
      genres: Boolean(merged.genre_ids?.length),
      cast:
        candidate?.metadataCoverage?.cast === 'complete' || savedCoverage?.cast === 'complete'
          ? 'complete'
          : merged.cast?.length
            ? 'partial'
            : 'unknown',
      crew:
        candidate?.metadataCoverage?.crew === 'complete' || savedCoverage?.crew === 'complete'
          ? 'complete'
          : merged.crew?.length
            ? 'partial'
            : 'unknown',
      collection:
        merged.belongs_to_collection?.id != null
          ? 'present'
          : candidate?.metadataCoverage?.collection || savedCoverage?.collection || 'unknown',
    });
    byKey.set(key, merged);
  }

  return [...byKey.values()];
}

function getStatusVisualSignal(
  item: RelationshipContent,
  preferences: Preferences,
): { weight: number; signal: RelationshipStatusSignal } {
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

function toGraphNode(
  item: RelationshipContent,
  kind: 'saved' | 'candidate' | 'source',
  personalScore: number,
  preferences: Preferences,
): RelationshipGraphNode {
  const title = titleOf(item);
  const status = getStatusVisualSignal(item, preferences);
  return {
    id: relationshipNodeKey(item),
    label: title.length > 26 ? `${title.slice(0, 24)}…` : title,
    title,
    mediaType: item.media_type,
    kind,
    status: item.status,
    statusWeight: status.weight,
    statusSignal: status.signal,
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
  const eligible = candidates.filter(
    (candidate) =>
      matchesMediaFilter(candidate, mediaFilter) &&
      isCandidateEligibleInPool(candidate, savedItems, preferences),
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
    favoriteActorIds = [],
    genreNames = {},
  } = options;

  const computedProfileSignature = computeRelationshipProfileSignature({
    profileId,
    mediaFilter,
    savedItems,
    preferences,
    favoriteActorIds,
  });

  const mediaCandidates = candidates.filter((item) => matchesMediaFilter(item, mediaFilter));
  const scores = scoreCandidatesForGraph(mediaCandidates, savedItems, preferences, mediaFilter);
  const mergedItems = mergeContent(mediaCandidates, savedItems).filter((item) =>
    matchesMediaFilter(item, mediaFilter),
  );
  const mergedByKey = new Map(mergedItems.map((item) => [relationshipNodeKey(item), item]));
  const savedKeys = new Set(savedItems.map((item) => relationshipNodeKey(item)));

  if (mode === 'taste-map') {
    const savedHistory = mergedItems
      .filter((item) => savedKeys.has(relationshipNodeKey(item)))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, 24);

    const eligibleCandidates = mediaCandidates
      .filter((item) => isCandidateEligibleInPool(item, savedItems, preferences))
      .sort((a, b) => (scores.get(makeMediaKey(b)) ?? 50) - (scores.get(makeMediaKey(a)) ?? 50))
      .map((item) => mergedByKey.get(relationshipNodeKey(item)) || item);

    const nodesContent: RelationshipContent[] = [];
    const seen = new Set<string>();

    for (const item of [...savedHistory, ...eligibleCandidates]) {
      const key = relationshipNodeKey(item);
      if (seen.has(key) || nodesContent.length >= maxNodes - 1) continue;
      seen.add(key);
      nodesContent.push(item);
    }

    const profileCentroid = buildProfileCentroid(savedItems, getItemEncodingSync);

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
        x: 0,
        y: 0,
      },
      ...nodesContent.map((item, idx) => {
        const base = toGraphNode(
          item,
          savedKeys.has(relationshipNodeKey(item)) ? 'saved' : 'candidate',
          personalScoreFor(item, scores),
          preferences,
        );
        const sim =
          profileCentroid.length > 0
            ? profileSimilarityScore(item, profileCentroid, getItemEncodingSync)
            : base.personalScore / 100;
        const angle = (idx / Math.max(1, nodesContent.length)) * 2 * Math.PI;
        const r = 80 + (1 - Math.max(0, Math.min(1, sim))) * 220;
        base.x = Math.round(Math.cos(angle) * r);
        base.y = Math.round(Math.sin(angle) * r);
        return base;
      }),
    ];

    const links: RelationshipGraphLink[] = nodesContent.map((item) => {
      const score = personalScoreFor(item, scores);
      return {
        source: `profile:${profileId}`,
        target: relationshipNodeKey(item),
        type: 'personal',
        alsoRelatedBy: ['personal'],
        score,
        confidence: scores.has(relationshipNodeKey(item)) ? 82 : item.personal_rating ? 70 : 45,
        evidence: [
          scores.has(relationshipNodeKey(item))
            ? 'Mevcut Cinethos kişisel puanlama sinyalleri kullanıldı.'
            : item.personal_rating
              ? `Kullanıcının kişisel puanı: ${item.personal_rating}/10.`
              : 'Kişisel puan bulunmadığı için nötr konum kullanıldı.',
        ],
        distance: 60 + (100 - score) * 1.15,
      };
    });

    // Yalnızca ekranda görünen, sınırlandırılmış düğüm kümesi üzerinde ilişki hesaplanır.
    const precomputedNodes = nodesContent.map(precomputeRelationshipContent);
    const relatedLinks: RelationshipGraphLink[] = [];
    for (let i = 0; i < precomputedNodes.length; i += 1) {
      for (let j = i + 1; j < precomputedNodes.length; j += 1) {
        const link = strongestRelationship(
          precomputedNodes[i],
          precomputedNodes[j],
          relationshipFilter,
          genreNames,
        );
        if (link && link.score >= 24) relatedLinks.push(link);
      }
    }
    relatedLinks.sort((a, b) => b.score - a.score);
    links.push(...relatedLinks.slice(0, Math.max(0, maxLinks - links.length)));

    return {
      nodes,
      links,
      profileSignature: computedProfileSignature,
      createdAt: new Date().toISOString(),
    };
  }

  const source = sourceKey ? mergedItems.find((item) => relationshipNodeKey(item) === sourceKey) : null;
  if (!source) {
    return { nodes: [], links: [], profileSignature: computedProfileSignature, createdAt: new Date().toISOString() };
  }

  const sourceId = relationshipNodeKey(source);
  const preSource = precomputeRelationshipContent(source);
  const eligibleTargets = mediaCandidates
    .filter(
      (item) =>
        relationshipNodeKey(item) !== sourceId &&
        isCandidateEligibleInPool(item, savedItems, preferences),
    )
    .map((item) => {
      const content = mergedByKey.get(relationshipNodeKey(item)) || item;
      const preTarget = precomputeRelationshipContent(content);
      const link = strongestRelationship(preSource, preTarget, relationshipFilter, genreNames);
      const personalScore = personalScoreFor(content, scores);
      return { item: content, link, personalScore, preTarget };
    })
    .filter(
      (
        entry,
      ): entry is { item: RelationshipContent; link: RelationshipGraphLink; personalScore: number; preTarget: RelationshipContentPrecomputed } =>
        Boolean(entry.link),
    )
    .sort(
      (a, b) =>
        (b.link.score * 0.75 + b.personalScore * 0.25) -
        (a.link.score * 0.75 + a.personalScore * 0.25),
    )
    .slice(0, Math.max(1, maxNodes - 1));

  const nodes: RelationshipGraphNode[] = [
    {
      ...toGraphNode(source, 'source', personalScoreFor(source, scores), preferences),
      fx: 0,
      fy: 0,
      x: 0,
      y: 0,
    },
    ...eligibleTargets.map(({ item, personalScore, link }, idx) => {
      const base = toGraphNode(item, 'candidate', personalScore, preferences);
      const angle = (idx / Math.max(1, eligibleTargets.length)) * 2 * Math.PI;
      const r = 70 + (100 - (link?.score || personalScore)) * 1.8;
      base.x = Math.round(Math.cos(angle) * r);
      base.y = Math.round(Math.sin(angle) * r);
      return base;
    }),
  ];

  const links = eligibleTargets.map((entry) => entry.link);

  // Komşu düğümler arasındaki güçlü bağlar, kaynağın çevresindeki kümeleri görünür kılar.
  const secondaryLinks: RelationshipGraphLink[] = [];
  for (let i = 0; i < eligibleTargets.length; i += 1) {
    for (let j = i + 1; j < eligibleTargets.length; j += 1) {
      const link = strongestRelationship(
        eligibleTargets[i].preTarget,
        eligibleTargets[j].preTarget,
        relationshipFilter,
        genreNames,
      );
      if (link && link.score >= 35) secondaryLinks.push(link);
    }
  }
  secondaryLinks.sort((a, b) => b.score - a.score);
  links.push(...secondaryLinks.slice(0, Math.max(0, maxLinks - links.length)));

  return { nodes, links, profileSignature: computedProfileSignature, createdAt: new Date().toISOString() };
}

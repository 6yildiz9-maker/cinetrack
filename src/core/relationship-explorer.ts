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
import {
  RELATIONSHIP_MODEL_VERSION,
  RELATIONSHIP_GRAPH_SCHEMA_VERSION,
  computeRelationshipProfileSignature,
  computeRelationshipPoolSignature,
  deriveMetadataCoverage,
  personEvidenceConfidence,
  tokenize,
  overlap,
  jaccard,
  getCollectionId,
  extractKeywordData,
  extractSemanticConcepts,
  classifyCrewAndCast,
  evaluateAtmosphereCoOccurrence,
  type MediaFilter,
  type RelationshipStatusSignal,
  type RelationshipMetadataCoverage,
  type RelationshipContent,
  type ClassifiedCrewCast,
  type KeywordData,
  type RelationshipMode,
  type RelationshipType,
  type RelationshipGraphNode,
  type RelationshipEvidenceDetail,
  type RelationshipGraphLink,
  type RelationshipGraphData,
  type BuildRelationshipGraphOptions,
} from './relationship-semantics.ts';

export {
  RELATIONSHIP_MODEL_VERSION,
  RELATIONSHIP_GRAPH_SCHEMA_VERSION,
  computeRelationshipProfileSignature,
  computeRelationshipPoolSignature,
  deriveMetadataCoverage,
  personEvidenceConfidence,
  tokenize,
  getRelationshipTypeLabel,
  getRelationshipNodeColor,
  getRelationshipLinkColor,
  type MediaFilter,
  type RelationshipStatusSignal,
  type RelationshipMetadataCoverage,
  type RelationshipContent,
  type RelationshipMode,
  type RelationshipType,
  type RelationshipGraphNode,
  type RelationshipEvidenceDetail,
  type RelationshipGraphLink,
  type RelationshipGraphData,
  type BuildRelationshipGraphOptions,
};



interface PairRelationship {
  type: Exclude<RelationshipType, 'personal'>;
  score: number;
  confidence: number;
  confidenceScore?: number;
  evidence: string[];
  evidenceTypes?: string[];
  features?: RelationshipEvidenceDetail['features'];
  breakdown?: RelationshipEvidenceDetail['breakdown'];
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
  keywordNames: Set<string>;
  displayKeywords: string[];
  concepts: Set<string>;
  conceptLabels: string[];
  classifiedCrew: ClassifiedCrewCast;
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

  const kwData = extractKeywordData(item);
  const conceptData = extractSemanticConcepts(text, kwData);
  const classifiedCrew = classifyCrewAndCast(item.cast, item.crew);

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
    keywordIds: kwData.ids,
    keywordNames: kwData.names,
    displayKeywords: kwData.displayKeywords,
    concepts: conceptData.conceptIds,
    conceptLabels: conceptData.matchedLabels,
    classifiedCrew,
    year: Number.isFinite(year) ? year : 0,
    encoding,
  };
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
      seriesCol?.name || aPre.item.belongs_to_collection?.name || bPre.item.belongs_to_collection?.name || 'Aynı Evren';
    relationships.push({
      type: 'universe',
      score: 96,
      confidence: 98,
      confidenceScore: 0.98,
      evidence: [`Aynı seri / evren bağlantısı: ${collectionName}.`],
      evidenceTypes: ['universe'],
      features: { universeName: collectionName },
      breakdown: { universeContribution: 85, seriesContribution: 85, genreContribution: 15 },
    });
  }

  // 2) Ortak yönetmen, senarist ve oyuncu kadrosu (ayrı kanıt türleri)
  const commonDirectors = aPre.classifiedCrew.directors
    .filter((d) => bPre.classifiedCrew.directors.some((bd) => bd.id === d.id))
    .map((d) => d.name);

  const commonWriters = aPre.classifiedCrew.writers
    .filter((w) => bPre.classifiedCrew.writers.some((bw) => bw.id === w.id))
    .map((w) => w.name);

  const commonActors = [...aPre.castMap.keys()]
    .filter((id) => bPre.castMap.has(id))
    .map((id) => aPre.castMap.get(id)!.name)
    .filter(Boolean);

  const commonCrewAll = [...aPre.crewMap.keys()]
    .filter((id) => bPre.crewMap.has(id))
    .map((id) => aPre.crewMap.get(id)!.name)
    .filter(Boolean);

  if (commonDirectors.length || commonWriters.length || commonActors.length || commonCrewAll.length) {
    const evidenceLines: string[] = [];
    const evidenceTypes: string[] = [];

    if (commonDirectors.length > 0) {
      evidenceLines.push(`Ortak yönetmen: ${commonDirectors.join(', ')}.`);
      evidenceTypes.push('director');
    }
    if (commonWriters.length > 0) {
      evidenceLines.push(`Ortak senarist / yazar: ${commonWriters.join(', ')}.`);
      evidenceTypes.push('writer');
    }
    if (commonActors.length > 0) {
      evidenceLines.push(`Ortak oyuncular: ${commonActors.slice(0, 5).join(', ')}.`);
      evidenceTypes.push('actor');
    }
    const otherCrew = commonCrewAll.filter(
      (name) => !commonDirectors.includes(name) && !commonWriters.includes(name)
    );
    if (otherCrew.length > 0 && commonDirectors.length === 0 && commonWriters.length === 0) {
      evidenceLines.push(`Ortak yaratıcı ekip: ${otherCrew.slice(0, 5).join(', ')}.`);
      evidenceTypes.push('crew');
    }

    let baseScore = 86;
    if (commonDirectors.length > 0) baseScore += 6;
    if (commonWriters.length > 0) baseScore += 4;
    if (commonActors.length > 1) baseScore += Math.min(4, (commonActors.length - 1) * 2);
    const score = clamp(baseScore, 75, 98);
    const confidence = personEvidenceConfidence(aPre.item, bPre.item);

    relationships.push({
      type: 'person',
      score,
      confidence,
      confidenceScore: Math.round((confidence / 100) * 100) / 100,
      evidence: evidenceLines,
      evidenceTypes,
      features: {
        matchedDirectors: commonDirectors,
        matchedWriters: commonWriters,
        matchedActors: commonActors,
      },
      breakdown: {
        personContribution: 75,
        directorContribution: commonDirectors.length ? 45 : 0,
        writerContribution: commonWriters.length ? 30 : 0,
        actorContribution: commonActors.length ? 25 : 0,
        genreContribution: 25,
      },
    });
  }

  // 3) Anlamsal benzerlik: Kavramlar + TMDB Anahtar Kelimeleri + Özet Terimleri + Vektör Benzerliği
  // KRİTİK: Tür benzerliği tek başına anlamsal benzerlik kabul edilmez!
  const commonConcepts = [...aPre.concepts].filter((c) => bPre.concepts.has(c));
  const commonKeywordIds = [...aPre.keywordIds].filter((k) => bPre.keywordIds.has(k));
  const commonKeywordNames = [...aPre.keywordNames].filter((k) => bPre.keywordNames.has(k));
  const commonTokens = overlap(aPre.tokens, bPre.tokens);
  const commonGenres = overlap(aPre.genres, bPre.genres);
  const genreEvidence = commonGenres.map((id) => genreNames[Number(id)] || `Bilinmeyen tür (${id})`);

  const vecSim =
    aPre.encoding && bPre.encoding
      ? cosineSimilarity(aPre.encoding.denseVector, bPre.encoding.denseVector)
      : 0;

  const conceptSimilarity =
    aPre.concepts.size && bPre.concepts.size
      ? commonConcepts.length / Math.sqrt(aPre.concepts.size * bPre.concepts.size)
      : 0;

  const keywordSimilarity =
    (aPre.keywordIds.size || aPre.keywordNames.size) && (bPre.keywordIds.size || bPre.keywordNames.size)
      ? (commonKeywordIds.length * 2 + commonKeywordNames.length) /
        Math.max(1, aPre.keywordIds.size + bPre.keywordIds.size + aPre.keywordNames.size + bPre.keywordNames.size)
      : 0;

  const tokenSimilarity =
    aPre.tokens.size && bPre.tokens.size
      ? commonTokens.length / Math.sqrt(aPre.tokens.size * bPre.tokens.size)
      : 0;

  const genreSimilarity = jaccard(aPre.genres, bPre.genres);

  // Anlamsal çapa: Tür tek başına asla yetmez! Ortak kavram, anahtar kelime, token veya yüksek vektör uyumu şarttır.
  const hasSemanticAnchor =
    commonConcepts.length >= 1 ||
    commonKeywordIds.length >= 1 ||
    commonKeywordNames.length >= 1 ||
    commonTokens.length >= 2 ||
    (vecSim >= 0.50 && (commonTokens.length >= 1 || commonConcepts.length >= 1 || commonKeywordIds.length >= 1));

  // Ağırlıklar: Kavramlar %35 + Anahtar Kelimeler %25 + Tokenlar %20 + Vektör %15 + Tür %5
  const semanticScore = clamp(
    Math.round(
      35 * conceptSimilarity +
      25 * keywordSimilarity +
      20 * tokenSimilarity +
      15 * Math.max(0, vecSim) +
      5 * genreSimilarity
    )
  );

  if (hasSemanticAnchor && semanticScore >= 18) {
    const evidenceLines: string[] = [];
    const evidenceTypes: string[] = [];

    const matchedConceptLabels = commonConcepts.map((c) => {
      const match = aPre.conceptLabels.find((_, idx) => [...aPre.concepts][idx] === c) || c;
      return match;
    });

    if (matchedConceptLabels.length > 0) {
      evidenceLines.push(`Ortak tematik kavramlar: ${matchedConceptLabels.slice(0, 4).join(', ')}.`);
      evidenceTypes.push('concept', 'concept_affinity');
    }

    if (commonKeywordNames.length > 0) {
      evidenceLines.push(`Ortak anahtar kelimeler: ${commonKeywordNames.slice(0, 5).join(', ')}.`);
      evidenceTypes.push('keyword', 'keyword_overlap');
    } else if (commonKeywordIds.length > 0) {
      evidenceLines.push(`Ortak anahtar kelimeler: ${commonKeywordIds.length} eşleşme.`);
      evidenceTypes.push('keyword', 'keyword_overlap');
    }

    if (commonTokens.length > 0) {
      evidenceLines.push(`Ortak özet/başlık terimleri: ${commonTokens.slice(0, 6).join(', ')}.`);
    }

    if (genreEvidence.length > 0) {
      evidenceLines.push(`Ortak türler: ${genreEvidence.join(', ')}.`);
    }

    const confidence = clamp(
      Math.round(
        55 +
        (commonConcepts.length >= 2 ? 25 : commonConcepts.length >= 1 ? 16 : 0) +
        (commonKeywordIds.length >= 2 || commonKeywordNames.length >= 2 ? 14 : commonKeywordIds.length >= 1 ? 8 : 0) +
        (commonTokens.length >= 4 ? 10 : commonTokens.length >= 2 ? 5 : 0)
      ),
      55,
      95
    );

    relationships.push({
      type: 'semantic',
      score: semanticScore,
      confidence,
      confidenceScore: Math.round((confidence / 100) * 100) / 100,
      evidence: evidenceLines,
      evidenceTypes,
      features: {
        matchedConcepts: matchedConceptLabels,
        matchedKeywords: commonKeywordNames.length ? commonKeywordNames : commonKeywordIds.map(String),
        matchedGenres: genreEvidence,
      },
      breakdown: {
        conceptContribution: commonConcepts.length ? 40 : 10,
        keywordContribution: (commonKeywordIds.length || commonKeywordNames.length) ? 30 : 10,
        tokenContribution: commonTokens.length ? 20 : 10,
        vectorContribution: Math.round(Math.max(0, vecSim) * 15),
        genreContribution: Math.round(genreSimilarity * 10),
      },
    });
  }

  // 4) Atmosferik / duygusal yakınlık: Bağlam ve kavram birlikteliği (Co-occurrence)
  const atmosphereEval = evaluateAtmosphereCoOccurrence(
    aPre.genres,
    bPre.genres,
    aPre.tokens,
    bPre.tokens,
    aPre.concepts,
    bPre.concepts,
    genreNames
  );

  if (atmosphereEval.hasCoherentAtmosphere) {
    const yearA = aPre.year;
    const yearB = bPre.year;
    const yearDelta = yearA >= 1900 && yearB >= 1900 ? Math.abs(yearA - yearB) : null;
    const eraBonus = yearDelta !== null && yearDelta <= 6 ? 6 : 0;
    const score = clamp(atmosphereEval.score + eraBonus, 50, 92);
    const evidenceLines = [...atmosphereEval.evidence];
    if (yearDelta !== null && yearDelta <= 6) {
      evidenceLines.push(`Yakın dönem sinematografisi (${yearA} – ${yearB}).`);
    }

    relationships.push({
      type: 'atmosphere',
      score,
      confidence: atmosphereEval.confidence,
      confidenceScore: Math.round((atmosphereEval.confidence / 100) * 100) / 100,
      evidence: evidenceLines,
      evidenceTypes: ['atmosphere_cluster'],
      features: {
        atmosphereCluster: atmosphereEval.clusterLabel,
        matchedGenres: atmosphereEval.clusterGenres.map((g) => genreNames[g] || `Tür #${g}`),
        matchedConcepts: atmosphereEval.sharedConcepts,
      },
      breakdown: {
        toneContribution: 45,
        conceptContribution: 30,
        genreContribution: 15,
        vectorContribution: 10,
      },
    });
  }

  // 5) Karşıt ton / tamamlayıcı deneyim
  const hasSharedAnchor =
    commonDirectors.length > 0 ||
    commonWriters.length > 0 ||
    commonActors.length > 0 ||
    commonCrewAll.length > 0 ||
    commonTokens.length >= 2 ||
    commonConcepts.length >= 1;

  if (hasSharedAnchor) {
    const aHasDark = [...aPre.genres].some((gid) => DARK_ATMOSPHERE_GENRES.has(gid));
    const bHasDark = [...bPre.genres].some((gid) => DARK_ATMOSPHERE_GENRES.has(gid));
    const aHasLight = [...aPre.genres].some((gid) => LIGHT_TONE_GENRES.has(gid));
    const bHasLight = [...bPre.genres].some((gid) => LIGHT_TONE_GENRES.has(gid));
    const tonalContrast = (aHasDark && bHasLight && !aHasLight) || (bHasDark && aHasLight && !bHasLight);
    const formatContrast = aPre.item.media_type !== bPre.item.media_type && (commonCrewAll.length > 0 || commonActors.length > 0 || commonGenres.length >= 1);

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
      if (commonDirectors.length > 0) {
        contrastEvidence.push(`Ortak yönetmen imzası: ${commonDirectors.slice(0, 2).join(', ')}.`);
      } else if (commonWriters.length > 0) {
        contrastEvidence.push(`Ortak senarist imzası: ${commonWriters.slice(0, 2).join(', ')}.`);
      } else if (commonActors.length > 0) {
        contrastEvidence.push(`Ortak oyuncu köprüsü: ${commonActors.slice(0, 2).join(', ')}.`);
      } else if (commonTokens.length >= 2) {
        contrastEvidence.push(`Ortak tema köprüsü: ${commonTokens.slice(0, 3).join(', ')}.`);
      }

      const contrastScore = clamp(
        Math.min(78, 44 + (tonalContrast ? 14 : 0) + (formatContrast ? 10 : 0) + Math.min(8, commonTokens.length * 3)),
      );
      relationships.push({
        type: 'contrast',
        score: contrastScore,
        confidence: commonCrewAll.length > 0 || commonActors.length > 0 ? 80 : 64,
        confidenceScore: commonCrewAll.length > 0 || commonActors.length > 0 ? 0.8 : 0.64,
        evidence: contrastEvidence,
        evidenceTypes: ['tonal_contrast'],
        breakdown: {
          contrastContribution: 60,
          personContribution: 25,
          genreContribution: 15,
        },
      });
    }
  }

  return relationships.sort((left, right) => right.score - left.score);
}

function computeRelationshipBreakdown(
  type: Exclude<RelationshipType, 'personal'>,
  pair?: PairRelationship
): RelationshipEvidenceDetail['breakdown'] {
  if (pair?.breakdown) return pair.breakdown;
  switch (type) {
    case 'semantic':
      return { conceptContribution: 35, keywordContribution: 25, vectorContribution: 20, toneContribution: 15, genreContribution: 5 };
    case 'person':
      return { personContribution: 75, directorContribution: 40, writerContribution: 30, actorContribution: 30, genreContribution: 25 };
    case 'universe':
      return { universeContribution: 85, seriesContribution: 85, genreContribution: 15 };
    case 'atmosphere':
      return { toneContribution: 45, conceptContribution: 30, genreContribution: 15, vectorContribution: 10 };
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
  const confidenceScore = Math.round((best.confidence / 100) * 100) / 100;

  return {
    source: relationshipNodeKey(aItem),
    target: relationshipNodeKey(bItem),
    type: best.type,
    alsoRelatedBy: allTypes,
    score: best.score,
    confidence: best.confidence,
    confidenceScore,
    evidence: [...new Set(relations.flatMap((relationship) => relationship.evidence))],
    evidenceTypes: [...new Set(relations.flatMap((relationship) => relationship.evidenceTypes || []))],
    features: best.features,
    breakdown: computeRelationshipBreakdown(best.type, best),
    relationshipDetails: relations.map((relationship) => ({
      type: relationship.type,
      score: relationship.score,
      confidence: relationship.confidence,
      confidenceScore: Math.round((relationship.confidence / 100) * 100) / 100,
      evidence: relationship.evidence,
      evidenceTypes: relationship.evidenceTypes,
      features: relationship.features,
      breakdown: computeRelationshipBreakdown(relationship.type, relationship),
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

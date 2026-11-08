import {
  type PoolCandidateItem,
  type Preferences,
  type SavedItem,
  makeMediaKey,
} from './cinetrack-core.ts';
import { ENCODING_LAYOUT_VERSION } from './encoding.ts';
import { STOP_WORDS, GENERIC_PLOT_WORDS } from './relationship-wordlists.ts';

export type MediaFilter = 'all' | 'movie' | 'tv';
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

export type RelationshipMode = 'taste-map' | 'relationships';
export type RelationshipType = 'semantic' | 'person' | 'universe' | 'atmosphere' | 'contrast' | 'personal';

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
  confidenceScore?: number;
  evidence: string[];
  evidenceTypes?: string[];
  features?: {
    matchedDirectors?: string[];
    matchedWriters?: string[];
    matchedActors?: string[];
    matchedKeywords?: string[];
    matchedConcepts?: string[];
    matchedGenres?: string[];
    universeName?: string;
    atmosphereCluster?: string;
  };
  breakdown?: {
    vectorContribution?: number;
    genreContribution?: number;
    personContribution?: number;
    toneContribution?: number;
    seriesContribution?: number;
    contrastContribution?: number;
    keywordContribution?: number;
    conceptContribution?: number;
    tokenContribution?: number;
    directorContribution?: number;
    writerContribution?: number;
    actorContribution?: number;
    universeContribution?: number;
  };
}

export interface RelationshipGraphLink {
  source: string | RelationshipGraphNode;
  target: string | RelationshipGraphNode;
  type: RelationshipType;
  alsoRelatedBy: RelationshipType[];
  score: number;
  confidence: number;
  confidenceScore?: number;
  evidence: string[];
  evidenceTypes?: string[];
  features?: RelationshipEvidenceDetail['features'];
  breakdown?: RelationshipEvidenceDetail['breakdown'];
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

export function stableHash(input: unknown): string {
  const text = JSON.stringify(input);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function sortedStrings(values: unknown): string[] {
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

export function overlap<T>(a: Set<T>, b: Set<T>): T[] {
  return [...a].filter((value) => b.has(value));
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  const common = overlap(a, b).length;
  return common / (a.size + b.size - common);
}

export function getCollectionId(item: RelationshipContent): string | null {
  const collection = item.belongs_to_collection;
  if (!collection || typeof collection !== 'object' || collection.id == null) return null;
  return String(collection.id);
}

export function deriveMetadataCoverage(
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

  const castRatioA = aCoverage.cast === 'complete' ? 1 : Math.min(1, Math.max(0, ((a.cast?.length || 0) - 1) / 9));
  const castRatioB = bCoverage.cast === 'complete' ? 1 : Math.min(1, Math.max(0, ((b.cast?.length || 0) - 1) / 9));
  const crewRatioA = aCoverage.crew === 'complete' ? 1 : Math.min(1, Math.max(0, (a.crew?.length || 0) / 4));
  const crewRatioB = bCoverage.crew === 'complete' ? 1 : Math.min(1, Math.max(0, (b.crew?.length || 0) / 4));
  const coverageRatio = castRatioA * 0.3 + castRatioB * 0.3 + crewRatioA * 0.2 + crewRatioB * 0.2;

  return Math.max(0, Math.min(100, Math.round(72 + coverageRatio * 22)));
}

export interface SemanticConceptMatch {
  id: string;
  label: string;
  matchedTerms: string[];
}

export interface ClassifiedCrewCast {
  directors: Array<{ id: number; name: string }>;
  writers: Array<{ id: number; name: string; job: string }>;
  actors: Array<{ id: number; name: string; character?: string }>;
}

export interface KeywordData {
  ids: Set<number>;
  names: Set<string>;
  displayKeywords: string[];
}

export interface AtmosphereContextEvaluation {
  hasCoherentAtmosphere: boolean;
  clusterId?: string;
  clusterLabel?: string;
  score: number;
  confidence: number;
  sharedTones: string[];
  sharedConcepts: string[];
  clusterGenres: number[];
  evidence: string[];
}

// ============================================================================
// 1. TMDB KEYWORD EXTRACTION & TAXONOMY
// ============================================================================

export function extractKeywordData(item: any): KeywordData {
  const ids = new Set<number>();
  const names = new Set<string>();
  const displayKeywords: string[] = [];

  if (!item || typeof item !== 'object') {
    return { ids, names, displayKeywords };
  }

  let rawList: any[] = [];
  if (Array.isArray(item.keywords)) {
    rawList = item.keywords;
  } else if (item.keywords && typeof item.keywords === 'object') {
    if (Array.isArray(item.keywords.keywords)) {
      rawList = item.keywords.keywords;
    } else if (Array.isArray(item.keywords.results)) {
      rawList = item.keywords.results;
    }
  } else if (Array.isArray(item.keyword_ids)) {
    rawList = item.keyword_ids;
  }

  for (const entry of rawList) {
    if (entry == null) continue;
    if (typeof entry === 'object') {
      if (entry.id != null) {
        const num = Number(entry.id);
        if (Number.isFinite(num)) ids.add(num);
      }
      if (typeof entry.name === 'string' && entry.name.trim()) {
        const clean = entry.name.trim().toLowerCase();
        names.add(clean);
        displayKeywords.push(entry.name.trim());
      }
    } else {
      const num = Number(entry);
      if (Number.isFinite(num)) ids.add(num);
      if (typeof entry === 'string' && entry.trim()) {
        names.add(entry.trim().toLowerCase());
        displayKeywords.push(entry.trim());
      }
    }
  }

  return { ids, names, displayKeywords: displayKeywords.slice(0, 12) };
}

// ============================================================================
// 2. BILINGUAL (TR & EN) CONCEPT LEXICON & NORMALIZATION
// ============================================================================

interface ConceptDefinition {
  id: string;
  labelTr: string;
  phrases: string[]; // multi-word or single-word indicators (TR and EN)
}

const BILINGUAL_CONCEPTS: ConceptDefinition[] = [
  {
    id: 'concept:time_travel',
    labelTr: 'Zaman Yolculuğu ve Döngüler',
    phrases: [
      'zaman yolculuğu', 'zaman döngüsü', 'zaman kırılması', 'zaman sıçraması', 'zamanda yolculuk',
      'zamanda sıkışma', 'zamanda geriye', 'zamanda ileriye', 'zaman makinesi',
      'time travel', 'time loop', 'temporal loop', 'time paradox', 'time machine',
    ],
  },
  {
    id: 'concept:artificial_intelligence',
    labelTr: 'Yapay Zeka ve Sibernetik',
    phrases: [
      'yapay zeka', 'yapay zekâ', 'sibernetik', 'robot', 'android', 'cyborg', 'siborg',
      'siber şehir', 'bilinç kazanan', 'sentient machine', 'artificial intelligence', 'sentient ai',
    ],
  },
  {
    id: 'concept:space_exploration',
    labelTr: 'Uzay Keşfi ve Gezegenlerarası',
    phrases: [
      'uzay', 'uzayda', 'galaksi', 'galakside', 'uzay yolculuğu', 'solucan deliği', 'uzay istasyonu',
      'derin uzay', 'uzay gemisi', 'gezegen', 'yıldızlararası', 'astronot',
      'space', 'galaxy', 'space travel', 'space station', 'wormhole', 'interstellar', 'deep space', 'astronaut',
    ],
  },
  {
    id: 'concept:serial_killer',
    labelTr: 'Seri Katil ve Kriminoloji',
    phrases: [
      'seri katil', 'psikopat katil', 'cinayet masası', 'cinayet soruşturması', 'kurbanlar',
      'katil', 'cinayet', 'cinayetler', 'serial killer', 'homicide', 'murder investigation', 'murderer',
    ],
  },
  {
    id: 'concept:dystopia_totalitarian',
    labelTr: 'Distopya ve Otoriter Sistemler',
    phrases: [
      'distopya', 'distopik', 'totaliter', 'baskıcı rejim', 'gözetim devleti', 'polis devleti',
      'dystopia', 'dystopian', 'totalitarian', 'oppressive regime', 'surveillance state',
    ],
  },
  {
    id: 'concept:simulation_virtual_reality',
    labelTr: 'Simülasyon ve Sanal Gerçeklik',
    phrases: [
      'simülasyon', 'sanal gerçeklik', 'yapay gerçeklik', 'illüzyon', 'zihin manipülasyonu',
      'simulation', 'virtual reality', 'simulated reality', 'matrix', 'illusion',
    ],
  },
  {
    id: 'concept:multiverse_parallel_dimension',
    labelTr: 'Paralel Evren ve Çoklu Boyut',
    phrases: [
      'paralel evren', 'çoklu evren', 'paralel boyut', 'alternatif gerçeklik', 'paralel dünya',
      'parallel universe', 'multiverse', 'alternate reality', 'alternate timeline', 'parallel dimension',
    ],
  },
  {
    id: 'concept:memory_and_identity',
    labelTr: 'Hafıza, Bilinçaltı ve Kimlik Kaybı',
    phrases: [
      'hafıza kaybı', 'kimlik arayışı', 'amnezi', 'bilinçaltı', 'hatıralar', 'hafıza silme', 'rüya katmanları',
      'memory loss', 'identity crisis', 'amnesia', 'subconscious', 'erasing memories', 'dream layers',
    ],
  },
  {
    id: 'concept:revenge_and_vendetta',
    labelTr: 'İntikam ve Hesaplaşma',
    phrases: [
      'intikam', 'hesaplaşma', 'kan davası', 'öç alma', 'geçmişle yüzleşme',
      'revenge', 'vendetta', 'retribution', 'settling scores', 'avenge',
    ],
  },
  {
    id: 'concept:heist_and_conspiracy',
    labelTr: 'Soygun ve Gizli Komplo',
    phrases: [
      'büyük soygun', 'banka soygunu', 'soygun planı', 'komplo', 'gizli örgüt', 'derin devlet',
      'heist', 'bank robbery', 'conspiracy', 'secret society', 'covert operation',
    ],
  },
  {
    id: 'concept:post_apocalyptic_survival',
    labelTr: 'Kıyamet Sonrası Hayatta Kalma',
    phrases: [
      'kıyamet sonrası', 'kıyamet', 'dünyanın sonu', 'nükleer savaş', 'çorak topraklar', 'salgın sonrası',
      'post-apocalyptic', 'post apocalyptic', 'end of the world', 'nuclear fallout', 'wasteland', 'aftermath',
    ],
  },
  {
    id: 'concept:alien_and_first_contact',
    labelTr: 'Dünya Dışı Yaşam ve İlk Temas',
    phrases: [
      'uzaylı', 'uzaylılar', 'dünya dışı', 'uzaylı istilası', 'ilk temas', 'bilinmeyen tür',
      'alien', 'extraterrestrial', 'alien invasion', 'first contact',
    ],
  },
  {
    id: 'concept:detective_and_noir',
    labelTr: 'Dedektiflik ve Kara Film (Noir)',
    phrases: [
      'dedektif', 'özel dedektif', 'kara film', 'noir', 'tekinsiz cinayet', 'gizemli olay',
      'detective', 'private investigator', 'film noir', 'neo-noir', 'hard-boiled',
    ],
  },
  {
    id: 'concept:philosophical_existential',
    labelTr: 'Varoluşsal Sorgulama ve Felsefe',
    phrases: [
      'varoluş', 'varoluşsal', 'felsefi', 'insanlığın geleceği', 'ahlaki ikilem', 'hakikat arayışı',
      'existential', 'philosophical', 'human condition', 'moral dilemma', 'meaning of life',
    ],
  },
  {
    id: 'concept:magic_and_mythology',
    labelTr: 'Büyü, Mitoloji ve Kadim Güçler',
    phrases: [
      'büyü', 'kadim güç', 'mitoloji', 'efsanevi', 'cadı', 'büyücü', 'lanet',
      'magic', 'ancient power', 'mythology', 'legendary', 'wizard', 'curse', 'sorcery',
    ],
  },
];

export function extractSemanticConcepts(
  text: string,
  keywords?: KeywordData | Set<string>,
): { conceptIds: Set<string>; matchedLabels: string[]; matchedPhrases: string[] } {
  const normText = ` ${String(text || '').toLocaleLowerCase('tr-TR').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const conceptIds = new Set<string>();
  const matchedLabels: string[] = [];
  const matchedPhrases: string[] = [];

  // Check keyword names if provided
  const keywordStrings: string[] = [];
  if (keywords) {
    if (keywords instanceof Set) {
      keywordStrings.push(...keywords);
    } else if (keywords.names instanceof Set) {
      keywordStrings.push(...keywords.names);
    }
  }
  const normKeywords = ` ${keywordStrings.join(' ').toLocaleLowerCase('tr-TR')} `;

  for (const def of BILINGUAL_CONCEPTS) {
    for (const phrase of def.phrases) {
      const phrasePat = ` ${phrase.toLocaleLowerCase('tr-TR')} `;
      if (normText.includes(phrasePat) || normKeywords.includes(phrasePat)) {
        if (!conceptIds.has(def.id)) {
          conceptIds.add(def.id);
          matchedLabels.push(def.labelTr);
          matchedPhrases.push(phrase);
        }
        break;
      }
    }
  }

  return { conceptIds, matchedLabels, matchedPhrases };
}

// ============================================================================
// 3. SEPARATED CREW & CAST CLASSIFICATION (Director, Writer, Actor, Universe)
// ============================================================================

const WRITER_JOB_PATTERNS = [
  /writer/i,
  /screenplay/i,
  /story/i,
  /author/i,
  /creator/i,
  /teleplay/i,
  /senaryo/i,
  /yazar/i,
  /co-writer/i,
];

export function classifyCrewAndCast(cast: any[] = [], crew: any[] = []): ClassifiedCrewCast {
  const directors: Array<{ id: number; name: string }> = [];
  const writers: Array<{ id: number; name: string; job: string }> = [];
  const actors: Array<{ id: number; name: string; character?: string }> = [];

  const seenDirectors = new Set<number>();
  const seenWriters = new Set<number>();
  const seenActors = new Set<number>();

  for (const person of Array.isArray(crew) ? crew : []) {
    if (!person || person.id == null || !person.name) continue;
    const pid = Number(person.id);
    if (!Number.isFinite(pid)) continue;

    const job = String(person.job || person.department || '');
    if (/director/i.test(job) && !seenDirectors.has(pid)) {
      directors.push({ id: pid, name: person.name });
      seenDirectors.add(pid);
    } else if (WRITER_JOB_PATTERNS.some((pat) => pat.test(job)) && !seenWriters.has(pid)) {
      writers.push({ id: pid, name: person.name, job: job || 'Senaryo' });
      seenWriters.add(pid);
    }
  }

  for (const person of Array.isArray(cast) ? cast : []) {
    if (!person || person.id == null || !person.name) continue;
    const pid = Number(person.id);
    if (!Number.isFinite(pid) || seenActors.has(pid)) continue;
    actors.push({ id: pid, name: person.name, character: person.character });
    seenActors.add(pid);
  }

  return { directors, writers, actors };
}

// ============================================================================
// 4. ATMOSPHERE CONTEXT CO-OCCURRENCE ENGINE
// ============================================================================

interface AtmosphereCluster {
  id: string;
  label: string;
  positiveGenres: number[];
  negativeGenres: number[];
  coherentTokens: Set<string>;
  opposingTokens: Set<string>;
  concepts: Set<string>;
}

const ATMOSPHERE_CLUSTERS: Record<string, AtmosphereCluster> = {
  dark_psychological: {
    id: 'dark_psychological',
    label: 'Karanlık & Psikolojik Gerilim',
    positiveGenres: [53, 27, 80, 9648],
    negativeGenres: [10751, 10762, 35, 10402],
    coherentTokens: new Set([
      'karanlık', 'distopya', 'distopik', 'gizem', 'gizemli', 'psikolojik', 'cinayet', 'noir',
      'tekinsiz', 'ölüm', 'katil', 'kabus', 'korku', 'paranoya', 'klostrofobik', 'kıyamet',
      'dark', 'dystopian', 'murder', 'killer', 'horror', 'crime', 'creepy', 'unsettling', 'paranoia', 'bleak',
    ]),
    opposingTokens: new Set([
      'neşeli', 'komik', 'kahkaha', 'eğlence', 'eğlenceli', 'çocuk', 'şaka', 'sıcak',
      'funny', 'cheerful', 'wholesome', 'comedy', 'family', 'sweet',
    ]),
    concepts: new Set([
      'concept:serial_killer', 'concept:detective_and_noir', 'concept:dystopia_totalitarian',
      'concept:post_apocalyptic_survival', 'concept:revenge_and_vendetta',
    ]),
  },
  thoughtful_philosophical: {
    id: 'thoughtful_philosophical',
    label: 'Felsefi & Varoluşsal Derinlik',
    positiveGenres: [18, 878, 99, 36],
    negativeGenres: [10762],
    coherentTokens: new Set([
      'felsefe', 'felsefi', 'zihin', 'hafıza', 'varoluş', 'varoluşsal', 'bilinç', 'sorgulama',
      'hakikat', 'paradoks', 'derin', 'etik', 'insanlık',
      'philosophical', 'existential', 'consciousness', 'humanity', 'simulation', 'identity',
    ]),
    opposingTokens: new Set(['slapstick', 'silly', 'mindless']),
    concepts: new Set([
      'concept:philosophical_existential', 'concept:memory_and_identity',
      'concept:simulation_virtual_reality', 'concept:artificial_intelligence',
    ]),
  },
  feel_good_warm: {
    id: 'feel_good_warm',
    label: 'Sıcak & Rahatlatıcı Atmosfer',
    positiveGenres: [35, 10751, 16, 10749, 10402, 12],
    negativeGenres: [27, 53, 80, 10752],
    coherentTokens: new Set([
      'huzur', 'sıcak', 'tatlı', 'dostluk', 'umut', 'mutluluk', 'arkadaşlık', 'samimi', 'şefkat',
      'cozy', 'warm', 'heartwarming', 'friendship', 'wholesome', 'uplifting', 'peaceful',
    ]),
    opposingTokens: new Set([
      'korku', 'vahşet', 'cinayet', 'kan', 'işkence', 'dehşet', 'kabus',
      'horror', 'brutal', 'murder', 'gore', 'torture',
    ]),
    concepts: new Set(['concept:magic_and_mythology']),
  },
  mind_bending_puzzle: {
    id: 'mind_bending_puzzle',
    label: 'Zihin Bükücü & Labirent Anlatı',
    positiveGenres: [878, 9648, 53, 14],
    negativeGenres: [10751, 10762],
    coherentTokens: new Set([
      'paradoks', 'zaman', 'yolculuğu', 'twist', 'rüya', 'simülasyon', 'labirent', 'yanılsama',
      'paralel', 'illüzyon', 'şok', 'akıl', 'ters', 'köşe',
      'mind', 'bending', 'loop', 'illusion', 'puzzle', 'reality', 'multiverse',
    ]),
    opposingTokens: new Set(['predictable', 'simple']),
    concepts: new Set([
      'concept:time_travel', 'concept:multiverse_parallel_dimension',
      'concept:simulation_virtual_reality',
    ]),
  },
};

export function evaluateAtmosphereCoOccurrence(
  genresA: Set<number>,
  genresB: Set<number>,
  tokensA: Set<string>,
  tokensB: Set<string>,
  conceptsA: Set<string>,
  conceptsB: Set<string>,
  genreNames: Record<number, string> = {},
): AtmosphereContextEvaluation {
  // Check co-occurrence against all clusters
  for (const cluster of Object.values(ATMOSPHERE_CLUSTERS)) {
    // 1. Conflicting opposing check: if either item has opposing tokens or opposing genres to this cluster, abort
    const hasOpposingA = [...tokensA].some((t) => cluster.opposingTokens.has(t)) ||
      [...genresA].some((g) => cluster.negativeGenres.includes(g));
    const hasOpposingB = [...tokensB].some((t) => cluster.opposingTokens.has(t)) ||
      [...genresB].some((g) => cluster.negativeGenres.includes(g));

    if (hasOpposingA || hasOpposingB) {
      continue;
    }

    // 2. Shared coherent tokens
    const sharedTones = [...tokensA].filter((t) => tokensB.has(t) && cluster.coherentTokens.has(t));

    // 3. Shared coherent concepts
    const sharedConcepts = [...conceptsA].filter((c) => conceptsB.has(c) && cluster.concepts.has(c));

    // 4. Shared positive genres
    const sharedClusterGenres = [...genresA].filter((g) => genresB.has(g) && cluster.positiveGenres.includes(g));

    // CO-OCCURRENCE REQUIREMENT:
    // Requires either:
    // - At least 1 shared concept AND at least 1 shared cluster genre
    // - OR at least 2 shared coherent atmospheric tokens
    // - OR 1 shared atmospheric token + at least 1 shared cluster genre
    // - OR at least 2 shared cluster genres with coherent tokens on both sides
    const hasSufficientCoOccurrence =
      (sharedConcepts.length >= 1 && (sharedClusterGenres.length >= 1 || sharedTones.length >= 1)) ||
      sharedTones.length >= 2 ||
      (sharedTones.length >= 1 && sharedClusterGenres.length >= 1) ||
      (sharedClusterGenres.length >= 2 && [...tokensA].some((t) => cluster.coherentTokens.has(t)) && [...tokensB].some((t) => cluster.coherentTokens.has(t)));

    if (hasSufficientCoOccurrence) {
      const clusterGenreLabels = sharedClusterGenres.map((g) => genreNames[g] || `Tür #${g}`);
      const evidence: string[] = [
        `Ortak atmosfer bağlamı: ${cluster.label}${clusterGenreLabels.length ? ` (${clusterGenreLabels.join(', ')})` : ''}.`,
      ];

      if (sharedTones.length > 0) {
        evidence.push(`Birlikte geçen ton belirteçleri: ${sharedTones.slice(0, 4).join(', ')}.`);
      }
      if (sharedConcepts.length > 0) {
        const conceptLabels = sharedConcepts.map((c) => {
          const match = BILINGUAL_CONCEPTS.find((def) => def.id === c);
          return match ? match.labelTr : c;
        });
        evidence.push(`Ortak tematik atmosfer kavramları: ${conceptLabels.join(', ')}.`);
      }

      const score = Math.max(50, Math.min(88,
        48 +
        sharedClusterGenres.length * 8 +
        sharedTones.length * 8 +
        sharedConcepts.length * 10
      ));

      const confidence = Math.max(65, Math.min(94,
        60 +
        (sharedConcepts.length >= 1 ? 15 : 0) +
        (sharedTones.length >= 2 ? 12 : sharedTones.length >= 1 ? 8 : 0) +
        (sharedClusterGenres.length >= 2 ? 10 : 0)
      ));

      return {
        hasCoherentAtmosphere: true,
        clusterId: cluster.id,
        clusterLabel: cluster.label,
        score,
        confidence,
        sharedTones,
        sharedConcepts,
        clusterGenres: sharedClusterGenres,
        evidence,
      };
    }
  }

  return {
    hasCoherentAtmosphere: false,
    score: 0,
    confidence: 0,
    sharedTones: [],
    sharedConcepts: [],
    clusterGenres: [],
    evidence: [],
  };
}

import { canonicalizeMediaKey, parseMediaKey } from './keys.ts';

/**
 * Türetilmiş profil verisi şema sürümü.
 * Sürüm 2 kapsamı:
 * - matchScore, tasteScore, priorityScore, lifecycleRing
 * - signals (deterministik sıralı sinyal ağırlıkları)
 * - reasons (öneri gerekçe etiketleri)
 * - shownCount, skippedCount, demotionPenalty, status, scoreCoverage, pillars
 * - profileFingerprint, sourceCatalogHash, algorithmVersion, schemaVersion ve contentHash
 */
export const DERIVED_PROFILE_SCHEMA_VERSION = 2;

export interface DerivedPillarsRecord {
  genreStoryScore: number;
  castCreatorsScore: number;
  discoveryQualityScore: number;
}

export interface DerivedProfileItemRecord {
  mediaKey: string;
  matchScore: number;
  tasteScore?: number;
  priorityScore?: number;
  lifecycleRing: 'ring0' | 'ring1' | 'ring2';
  signals?: Record<string, number>;
  reasons?: string[];
  shownCount?: number;
  skippedCount?: number;
  demotionPenalty?: number;
  status?: 'active' | 'saved' | 'disliked' | 'hidden';
  scoreCoverage?: 'basic' | 'enriched';
  pillars?: DerivedPillarsRecord;
  calculatedAt: string;
}

export interface DerivedProfileCacheDocument {
  schemaVersion: number;
  profileId: string;
  algorithmVersion: string;
  profileFingerprint: string;
  sourceCatalogHash: string;
  contentHash: string;
  generatedAt: string;
  items: Record<string, DerivedProfileItemRecord>;
}

export type DerivedCacheInvalidReason =
  | 'missing_document'
  | 'invalid_structure'
  | 'profile_id_mismatch'
  | 'schema_version_mismatch'
  | 'algorithm_version_mismatch'
  | 'profile_fingerprint_mismatch'
  | 'source_catalog_mismatch'
  | 'corrupt_content_hash';

export type DerivedProfileValidationResult =
  | { valid: true; document: DerivedProfileCacheDocument }
  | { valid: false; reason: DerivedCacheInvalidReason };

/**
 * Nesne anahtarlarını alfabetik sıralayarak deterministik JSON dizgesi üretir.
 */
export function canonicalJsonStringify(value: unknown): string {
  const normalize = (input: any): any => {
    if (input === null || typeof input !== 'object') {
      return input;
    }
    if (Array.isArray(input)) {
      return input.map(normalize);
    }
    const sortedKeys = Object.keys(input)
      .filter((k) => input[k] !== undefined)
      .sort((a, b) => a.localeCompare(b));
    const result: Record<string, any> = {};
    for (const k of sortedKeys) {
      result[k] = normalize(input[k]);
    }
    return result;
  };
  return JSON.stringify(normalize(value));
}

/**
 * Hem tarayıcıda hem Node.js ortamında birebir aynı sonucu üreten çift-32-bit FNV-1a özeti (16 hex karakter).
 */
export function hashDeterministic(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code ^ (i & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0')
  );
}

function normalizeSignalsMap(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const keys = Object.keys(raw as Record<string, unknown>).sort((a, b) => a.localeCompare(b));
  const out: Record<string, number> = {};
  let count = 0;
  for (const key of keys) {
    const num = Number((raw as Record<string, unknown>)[key]);
    if (Number.isFinite(num)) {
      out[key] = Math.round(num * 1_000_000) / 1_000_000;
      count++;
    }
  }
  return count > 0 ? out : undefined;
}

function normalizeReasonsList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned = raw
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

function normalizePillars(raw: unknown): DerivedPillarsRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const genreStoryScore = Number(obj.genreStoryScore ?? obj.content);
  const castCreatorsScore = Number(obj.castCreatorsScore ?? obj.cast);
  const discoveryQualityScore = Number(obj.discoveryQualityScore ?? obj.quality);
  if (
    !Number.isFinite(genreStoryScore) &&
    !Number.isFinite(castCreatorsScore) &&
    !Number.isFinite(discoveryQualityScore)
  ) {
    return undefined;
  }
  return {
    genreStoryScore: Number.isFinite(genreStoryScore) ? Math.round(genreStoryScore) : 50,
    castCreatorsScore: Number.isFinite(castCreatorsScore) ? Math.round(castCreatorsScore) : 50,
    discoveryQualityScore: Number.isFinite(discoveryQualityScore)
      ? Math.round(discoveryQualityScore)
      : 50,
  };
}

export function normalizeDerivedProfileItem(
  rawKey: string,
  rawItem: any
): DerivedProfileItemRecord | null {
  if (!rawItem || typeof rawItem !== 'object') return null;
  const canonicalKey = canonicalizeMediaKey(rawItem.mediaKey || rawKey);
  if (!parseMediaKey(canonicalKey)) return null;

  const rawMatch = Number(rawItem.matchScore ?? rawItem.tasteScore ?? 75);
  const matchScore = Math.max(1, Math.min(100, Math.round(Number.isFinite(rawMatch) ? rawMatch : 75)));
  const rawTaste = Number(rawItem.tasteScore ?? matchScore);
  const tasteScore = Math.max(1, Math.min(100, Math.round(Number.isFinite(rawTaste) ? rawTaste : matchScore)));
  const rawPriority = Number(rawItem.priorityScore ?? tasteScore);
  const priorityScore = Math.max(1, Math.min(100, Math.round(Number.isFinite(rawPriority) ? rawPriority : tasteScore)));

  const ringCandidate = rawItem.lifecycleRing ?? rawItem.ring;
  const lifecycleRing: 'ring0' | 'ring1' | 'ring2' =
    ringCandidate === 'ring1' || ringCandidate === 'ring2' ? ringCandidate : 'ring0';

  const signals = normalizeSignalsMap(rawItem.signals ?? rawItem.parts);
  const reasons = normalizeReasonsList(rawItem.reasons ?? rawItem.tags);
  const pillars = normalizePillars(rawItem.pillars);

  const statusCandidate = rawItem.status;
  const status: 'active' | 'saved' | 'disliked' | 'hidden' | undefined =
    statusCandidate === 'active' ||
    statusCandidate === 'saved' ||
    statusCandidate === 'disliked' ||
    statusCandidate === 'hidden'
      ? statusCandidate
      : undefined;

  const scoreCoverage: 'basic' | 'enriched' | undefined =
    rawItem.scoreCoverage === 'enriched' || rawItem.scoreCoverage === 'basic'
      ? rawItem.scoreCoverage
      : undefined;

  return {
    mediaKey: canonicalKey,
    matchScore,
    tasteScore,
    priorityScore,
    lifecycleRing,
    ...(signals ? { signals } : {}),
    ...(reasons ? { reasons } : {}),
    ...(Number.isFinite(Number(rawItem.shownCount)) ? { shownCount: Math.max(0, Math.round(Number(rawItem.shownCount))) } : {}),
    ...(Number.isFinite(Number(rawItem.skippedCount)) ? { skippedCount: Math.max(0, Math.round(Number(rawItem.skippedCount))) } : {}),
    ...(Number.isFinite(Number(rawItem.demotionPenalty)) ? { demotionPenalty: Math.max(0, Math.round(Number(rawItem.demotionPenalty))) } : {}),
    ...(status ? { status } : {}),
    ...(scoreCoverage ? { scoreCoverage } : {}),
    ...(pillars ? { pillars } : {}),
    calculatedAt:
      typeof rawItem.calculatedAt === 'string' && rawItem.calculatedAt
        ? rawItem.calculatedAt
        : new Date().toISOString(),
  };
}

/**
 * Yazma zaman damgalarını (`generatedAt`, `calculatedAt`) dışarıda bırakarak
 * kalıcı anlamlı alanların tamamı üzerinden deterministik içerik özeti hesaplar.
 */
export function computeDerivedProfileContentHash(input: {
  schemaVersion: number;
  profileId: string;
  algorithmVersion: string;
  profileFingerprint: string;
  sourceCatalogHash?: string;
  items: Record<string, any>;
}): string {
  const normalizedItemsForHash: Record<string, any> = {};
  const sortedKeys = Object.keys(input.items || {}).sort((a, b) => a.localeCompare(b));

  for (const key of sortedKeys) {
    const item = normalizeDerivedProfileItem(key, input.items[key]);
    if (!item) continue;
    const { calculatedAt: _ignoredTimestamp, ...meaningfulFields } = item;
    normalizedItemsForHash[item.mediaKey] = meaningfulFields;
  }

  const canonicalPayload = canonicalJsonStringify({
    schemaVersion: Number(input.schemaVersion) || DERIVED_PROFILE_SCHEMA_VERSION,
    profileId: String(input.profileId || ''),
    algorithmVersion: String(input.algorithmVersion || ''),
    profileFingerprint: String(input.profileFingerprint || ''),
    sourceCatalogHash: String(input.sourceCatalogHash || ''),
    items: normalizedItemsForHash,
  });

  return hashDeterministic(canonicalPayload);
}

/**
 * Katalog veya aday havuzu içeriklerinin anlamlı kaynak alanları üzerinden deterministik imza üretir.
 * Sıralamadan ve geçici zaman damgalarından bağımsızdır.
 */
export function computeSourceCatalogSignature(
  catalogOrPool: Array<Record<string, any>> | Record<string, any> | null | undefined
): string {
  if (!catalogOrPool) return '';
  const list = Array.isArray(catalogOrPool)
    ? catalogOrPool
    : typeof catalogOrPool === 'object'
    ? Object.values(catalogOrPool)
    : [];

  if (list.length === 0) return '';

  const compactRecords = list
    .map((item) => {
      if (!item || typeof item !== 'object' || item.id == null) return null;
      const type = item.media_type === 'tv' ? 'tv' : 'movie';
      const key = `${type}:${item.id}`;
      const genres = Array.isArray(item.genre_ids)
        ? [...item.genre_ids].map(Number).filter(Number.isFinite).sort((a, b) => a - b)
        : [];
      return {
        k: key,
        t: String(item.title || item.name || '').trim(),
        g: genres,
        v: Math.round((Number(item.vote_average) || 0) * 10),
        o: typeof item.overview === 'string' ? item.overview.trim().length : 0,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => a.k.localeCompare(b.k));

  // Aynı anahtar birden fazla kez varsa tekilleştir
  const deduped: typeof compactRecords = [];
  for (const rec of compactRecords) {
    if (deduped.length === 0 || deduped[deduped.length - 1].k !== rec.k) {
      deduped.push(rec);
    }
  }

  return hashDeterministic(JSON.stringify(deduped));
}

/**
 * Yüklenen türetilmiş profil verisinin şema, algoritma, profil imzası, kaynak katalog imzası
 * ve içerik bütünlüğü bakımından geçerli olup olmadığını denetler.
 * Eşleşmeyen veya bozuk veriyi sessizce geçerli kabul etmez.
 */
export function validateDerivedProfileCache(
  rawDoc: any,
  expected: {
    profileId: string;
    profileFingerprint: string;
    algorithmVersion: string;
    sourceCatalogHash?: string;
    expectedSchemaVersion?: number;
  }
): DerivedProfileValidationResult {
  if (!rawDoc || typeof rawDoc !== 'object' || Array.isArray(rawDoc)) {
    return { valid: false, reason: 'missing_document' };
  }

  if (!rawDoc.items || typeof rawDoc.items !== 'object' || Array.isArray(rawDoc.items)) {
    return { valid: false, reason: 'invalid_structure' };
  }

  if (String(rawDoc.profileId || '') !== expected.profileId) {
    return { valid: false, reason: 'profile_id_mismatch' };
  }

  const requiredSchema = expected.expectedSchemaVersion ?? DERIVED_PROFILE_SCHEMA_VERSION;
  if (Number(rawDoc.schemaVersion) !== requiredSchema) {
    return { valid: false, reason: 'schema_version_mismatch' };
  }

  if (String(rawDoc.algorithmVersion || '') !== expected.algorithmVersion) {
    return { valid: false, reason: 'algorithm_version_mismatch' };
  }

  if (String(rawDoc.profileFingerprint || '') !== expected.profileFingerprint) {
    return { valid: false, reason: 'profile_fingerprint_mismatch' };
  }

  if (
    expected.sourceCatalogHash &&
    rawDoc.sourceCatalogHash &&
    String(rawDoc.sourceCatalogHash) !== String(expected.sourceCatalogHash)
  ) {
    return { valid: false, reason: 'source_catalog_mismatch' };
  }

  const normalizedItems: Record<string, DerivedProfileItemRecord> = {};
  for (const [k, v] of Object.entries(rawDoc.items)) {
    const norm = normalizeDerivedProfileItem(k, v);
    if (norm) {
      normalizedItems[norm.mediaKey] = norm;
    }
  }

  const recomputedHash = computeDerivedProfileContentHash({
    schemaVersion: requiredSchema,
    profileId: expected.profileId,
    algorithmVersion: expected.algorithmVersion,
    profileFingerprint: expected.profileFingerprint,
    sourceCatalogHash: String(rawDoc.sourceCatalogHash || ''),
    items: normalizedItems,
  });

  if (typeof rawDoc.contentHash === 'string' && rawDoc.contentHash && rawDoc.contentHash !== recomputedHash) {
    return { valid: false, reason: 'corrupt_content_hash' };
  }

  return {
    valid: true,
    document: {
      schemaVersion: requiredSchema,
      profileId: expected.profileId,
      algorithmVersion: expected.algorithmVersion,
      profileFingerprint: expected.profileFingerprint,
      sourceCatalogHash: String(rawDoc.sourceCatalogHash || ''),
      contentHash: recomputedHash,
      generatedAt: typeof rawDoc.generatedAt === 'string' ? rawDoc.generatedAt : new Date().toISOString(),
      items: normalizedItems,
    },
  };
}

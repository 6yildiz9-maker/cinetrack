export type CanonicalMediaType = 'movie' | 'tv';

/**
 * Standart film/dizi kimlik anahtarı üretir.
 * Örn: makeMediaKey('movie', 872585) -> "movie:872585"
 * Örn: makeMediaKey('tv', '1396') -> "tv:1396"
 * Örn: makeMediaKey(item) -> "movie:872585"
 */
export function makeMediaKey(typeOrItem: any, id?: any): string {
  if (typeOrItem && typeof typeOrItem === 'object') {
    const mediaType: CanonicalMediaType = typeOrItem.media_type === 'tv' ? 'tv' : 'movie';
    const itemId = typeOrItem.id != null ? String(typeOrItem.id).trim() : '';
    return `${mediaType}:${itemId}`;
  }
  const mediaType: CanonicalMediaType = String(typeOrItem) === 'tv' ? 'tv' : 'movie';
  const itemId = id != null ? String(id).trim() : '';
  return `${mediaType}:${itemId}`;
}

/**
 * Hem iki nokta üst üste ("movie:872585") hem de eski tire ayracını ("movie-872585")
 * güvenli bir şekilde ayrıştırır ve standart yapıya dönüştürür.
 */
export function parseMediaKey(key: unknown): { type: CanonicalMediaType; id: string } | null {
  if (typeof key !== 'string' || !key.trim()) return null;
  const trimmed = key.trim();
  const colonMatch = trimmed.match(/^(movie|tv):([A-Za-z0-9_-]+)$/);
  if (colonMatch) {
    return { type: colonMatch[1] as CanonicalMediaType, id: colonMatch[2] };
  }
  const hyphenMatch = trimmed.match(/^(movie|tv)-([A-Za-z0-9_-]+)$/);
  if (hyphenMatch) {
    return { type: hyphenMatch[1] as CanonicalMediaType, id: hyphenMatch[2] };
  }
  return null;
}

/**
 * Herhangi bir eski veya yeni anahtarı kanonik "type:id" biçimine dönüştürür.
 * Geçersiz ise kırpılmış dizgeyi döndürür.
 */
export function canonicalizeMediaKey(rawKey: unknown, fallbackType?: CanonicalMediaType): string {
  if (rawKey && typeof rawKey === 'object') {
    return makeMediaKey(rawKey);
  }
  const parsed = parseMediaKey(rawKey);
  if (parsed) {
    return `${parsed.type}:${parsed.id}`;
  }
  if ((typeof rawKey === 'number' || typeof rawKey === 'string') && fallbackType) {
    const clean = String(rawKey).trim();
    if (clean) return `${fallbackType}:${clean}`;
  }
  return typeof rawKey === 'string' ? rawKey.trim() : '';
}

export function canonicalizeMediaKeyList(rawKeys: unknown, fallbackType?: CanonicalMediaType): string[] {
  if (!Array.isArray(rawKeys)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawKeys) {
    const candidate = canonicalizeMediaKey(raw, fallbackType);
    const parsed = parseMediaKey(candidate);
    if (!parsed) continue;
    const canonical = `${parsed.type}:${parsed.id}`;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
  }
  return result;
}

const STATUS_PRIORITY: Record<string, number> = {
  active: 1,
  saved: 2,
  hidden: 3,
  disliked: 4,
};

function pickEarliestIso(a?: string | null, b?: string | null): string | null {
  if (!a) return b || null;
  if (!b) return a || null;
  return a <= b ? a : b;
}

function pickLatestIso(a?: string | null, b?: string | null): string | null {
  if (!a) return b || null;
  if (!b) return a || null;
  return a >= b ? a : b;
}

export function mergeTasteMapEntriesOnCollision<T extends Record<string, any>>(
  first: T,
  second: T,
  canonicalKey: string,
  maxImpressionLimit = 30
): T {
  const firstScored = String(first.lastScoredAt || first.lastShownAt || '');
  const secondScored = String(second.lastScoredAt || second.lastShownAt || '');
  const primary = secondScored >= firstScored ? second : first;
  const secondary = primary === second ? first : second;

  const rawImpressions = [
    ...(Array.isArray(first.impressionHistory) ? first.impressionHistory : []),
    ...(Array.isArray(second.impressionHistory) ? second.impressionHistory : []),
  ];

  // Deduplicate impressions by timestamp/shownAt + batchSignature if available
  const seenImpressions = new Set<string>();
  const uniqueImpressions: any[] = [];
  for (const imp of rawImpressions) {
    if (!imp || typeof imp !== 'object') continue;
    const stamp = String(imp.shownAt || imp.timestamp || '');
    const sig = `${stamp}|${imp.ring || ''}|${imp.matchScore ?? ''}`;
    if (stamp && seenImpressions.has(sig)) continue;
    if (stamp) seenImpressions.add(sig);
    uniqueImpressions.push(imp);
  }

  uniqueImpressions.sort((a, b) => {
    const ta = String(a.shownAt || a.timestamp || '');
    const tb = String(b.shownAt || b.timestamp || '');
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  let archivedImpressionCount =
    (Number(first.archivedImpressionCount) || 0) + (Number(second.archivedImpressionCount) || 0);
  let boundedHistory = uniqueImpressions;
  if (uniqueImpressions.length > maxImpressionLimit) {
    archivedImpressionCount += uniqueImpressions.length - maxImpressionLimit;
    boundedHistory = uniqueImpressions.slice(-maxImpressionLimit);
  }

  const deduplicatedOverlapCount = Math.max(0, rawImpressions.length - uniqueImpressions.length);
  const combinedShown = Math.max(
    0,
    (Number(first.shownCount) || 0) + (Number(second.shownCount) || 0) - deduplicatedOverlapCount
  );
  const shownCount = Math.max(combinedShown, boundedHistory.length + archivedImpressionCount);
  const skippedCount = (Number(first.skippedCount) || 0) + (Number(second.skippedCount) || 0);

  const pStatus = String(primary.status || 'active');
  const sStatus = String(secondary.status || 'active');
  const resolvedStatus =
    (STATUS_PRIORITY[pStatus] || 0) >= (STATUS_PRIORITY[sStatus] || 0) ? pStatus : sStatus;

  const parsed = parseMediaKey(canonicalKey);

  const latestRecommendedAt = pickLatestIso(first.lastRecommendedAt, second.lastRecommendedAt);

  return {
    ...secondary,
    ...primary,
    mediaKey: canonicalKey,
    mediaType: parsed?.type || primary.mediaType || secondary.mediaType || 'movie',
    shownCount,
    skippedCount,
    ringDemotions: Math.max(Number(first.ringDemotions) || 0, Number(second.ringDemotions) || 0),
    demotionPenalty: Math.max(Number(first.demotionPenalty) || 0, Number(second.demotionPenalty) || 0),
    firstShownAt: pickEarliestIso(first.firstShownAt, second.firstShownAt),
    lastShownAt: pickLatestIso(first.lastShownAt, second.lastShownAt),
    ...(latestRecommendedAt ? { lastRecommendedAt: latestRecommendedAt } : {}),
    lastScoredAt: pickLatestIso(first.lastScoredAt, second.lastScoredAt) || new Date().toISOString(),
    archivedImpressionCount,
    impressionHistory: boundedHistory,
    status: resolvedStatus,
  } as T;
}

export interface MigrateTasteMapResult<T> {
  data: T;
  changed: boolean;
}

/**
 * Faz 2: PersistentTasteMapData içindeki tüm eski tireli ("movie-123") anahtarları
 * kanonik ("movie:123") biçimine dönüştürür, çakışmaları deterministik olarak birleştirir,
 * aktif ve arşiv arasındaki çift kayıtları çözer. İkinci çalıştırmada idempotenttir (changed = false).
 */
export function migratePersistentTasteMapData<T extends Record<string, any>>(
  rawMap: T,
  maxImpressionLimit = 30
): MigrateTasteMapResult<T> {
  if (!rawMap || typeof rawMap !== 'object') {
    return { data: rawMap, changed: false };
  }

  let changed = false;

  const rawLastKeys: unknown[] = Array.isArray(rawMap.lastRecommendedKeys) ? rawMap.lastRecommendedKeys : [];
  const canonicalLastKeys = canonicalizeMediaKeyList(rawLastKeys);
  if (
    canonicalLastKeys.length !== rawLastKeys.length ||
    canonicalLastKeys.some((k, idx) => k !== rawLastKeys[idx])
  ) {
    changed = true;
  }

  const migrateBucket = (
    bucket: Record<string, any> | undefined,
    isArchivedBucket: boolean
  ): Record<string, any> => {
    const out: Record<string, any> = {};
    if (!bucket || typeof bucket !== 'object') return out;

    for (const [rawKey, rawEntry] of Object.entries(bucket)) {
      if (!rawEntry || typeof rawEntry !== 'object') {
        changed = true;
        continue;
      }
      const entryFallbackType: CanonicalMediaType | undefined =
        rawEntry.mediaType === 'tv' || rawEntry.media_type === 'tv'
          ? 'tv'
          : rawEntry.mediaType === 'movie' || rawEntry.media_type === 'movie'
          ? 'movie'
          : undefined;
      const canonical = canonicalizeMediaKey(rawEntry.mediaKey || rawKey, entryFallbackType);
      if (!canonical) {
        changed = true;
        continue;
      }

      if (canonical !== rawKey || rawEntry.mediaKey !== canonical) {
        changed = true;
      }

      const history = Array.isArray(rawEntry.impressionHistory) ? rawEntry.impressionHistory : [];
      let archivedImpCount = Number(rawEntry.archivedImpressionCount) || 0;
      let trimmedHistory = history;
      if (history.length > maxImpressionLimit) {
        archivedImpCount += history.length - maxImpressionLimit;
        trimmedHistory = history.slice(-maxImpressionLimit);
        changed = true;
      }

      const normalizedEntry = {
        ...rawEntry,
        mediaKey: canonical,
        archivedImpressionCount: archivedImpCount,
        impressionHistory: trimmedHistory,
        isArchived: isArchivedBucket ? true : Boolean(rawEntry.isArchived && false),
      };
      if (!isArchivedBucket && rawEntry.isArchived) {
        changed = true;
      }
      if (isArchivedBucket && !rawEntry.isArchived) {
        changed = true;
      }

      if (out[canonical]) {
        changed = true;
        out[canonical] = mergeTasteMapEntriesOnCollision(
          out[canonical],
          normalizedEntry,
          canonical,
          maxImpressionLimit
        );
      } else {
        out[canonical] = normalizedEntry;
      }
    }

    return out;
  };

  const migratedEntries = migrateBucket(rawMap.entries, false);
  const migratedArchived = migrateBucket(rawMap.archivedEntries, true);

  // Active vs Archived cross-bucket collision resolution: active entry absorbs archived impressions
  for (const key of Object.keys(migratedArchived)) {
    if (migratedEntries[key]) {
      changed = true;
      const merged = mergeTasteMapEntriesOnCollision(
        migratedArchived[key],
        migratedEntries[key],
        key,
        maxImpressionLimit
      );
      migratedEntries[key] = {
        ...merged,
        isArchived: false,
        archivedAt: null,
        archiveReason: undefined,
      };
      delete migratedArchived[key];
    }
  }

  let migratedCachedBalanced = rawMap.cachedBalancedItems;
  if (Array.isArray(rawMap.cachedBalancedItems)) {
    const seenBalanced = new Set<string>();
    const nextBalanced: any[] = [];
    for (const item of rawMap.cachedBalancedItems) {
      if (!item || typeof item !== 'object') {
        changed = true;
        continue;
      }
      const target = item.candidate && typeof item.candidate === 'object' ? item.candidate : item;
      const canonical = makeMediaKey(target);
      if (!parseMediaKey(canonical)) {
        changed = true;
        continue;
      }
      if (seenBalanced.has(canonical)) {
        changed = true;
        continue;
      }
      seenBalanced.add(canonical);
      if (item.mediaKey && item.mediaKey !== canonical) {
        changed = true;
        nextBalanced.push({ ...item, mediaKey: canonical });
      } else {
        nextBalanced.push(item);
      }
    }
    migratedCachedBalanced = nextBalanced;
  }

  if (!changed) {
    return { data: rawMap, changed: false };
  }

  return {
    changed: true,
    data: {
      ...rawMap,
      entries: migratedEntries,
      archivedEntries: migratedArchived,
      lastRecommendedKeys: canonicalLastKeys,
      ...(migratedCachedBalanced !== undefined ? { cachedBalancedItems: migratedCachedBalanced } : {}),
    },
  };
}

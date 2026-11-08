import {
  hashContent,
  stringifyDeterministic,
  type CatalogRecord,
} from './persistent-store.ts';

export function isPlainObject(val: unknown): val is Record<string, any> {
  return Boolean(val && typeof val === 'object' && !Array.isArray(val));
}

export function normalizeCatalogRecordStrict(
  rawKey: string,
  rawVal: any,
  expectedType: 'movie' | 'tv'
): CatalogRecord | null {
  if (!isPlainObject(rawVal)) return null;
  const parsedKeyMatch = /^((?:movie|tv)):(\d+)$/.exec(String(rawKey || '').trim());
  const rawId = Number(rawVal.id ?? (parsedKeyMatch ? parsedKeyMatch[2] : NaN));
  if (!Number.isSafeInteger(rawId) || rawId <= 0) return null;

  const itemType =
    rawVal.media_type === 'tv' || rawVal.media_type === 'movie'
      ? rawVal.media_type
      : parsedKeyMatch
      ? (parsedKeyMatch[1] as 'movie' | 'tv')
      : expectedType;

  if (itemType !== expectedType) return null;

  const key = `${expectedType}:${rawId}`;
  const title = String(rawVal.title || rawVal.name || '').trim();
  if (!title) return null;

  const originalTitle = String(rawVal.original_title || rawVal.original_name || '').trim();
  const overview = typeof rawVal.overview === 'string' ? rawVal.overview.trim() : '';
  const genreSet = new Set<number>();
  if (Array.isArray(rawVal.genre_ids)) {
    for (const g of rawVal.genre_ids) {
      if (Number.isSafeInteger(g) && g > 0) genreSet.add(g);
    }
  }

  const voteAverage = Number.isFinite(Number(rawVal.vote_average)) ? Number(rawVal.vote_average) : 0;
  const voteCount =
    Number.isSafeInteger(Number(rawVal.vote_count)) && Number(rawVal.vote_count) > 0
      ? Number(rawVal.vote_count)
      : undefined;
  const popularity = Number.isFinite(Number(rawVal.popularity))
    ? Number(rawVal.popularity)
    : undefined;

  const releaseDate =
    typeof rawVal.release_date === 'string' && rawVal.release_date.trim()
      ? rawVal.release_date.trim()
      : undefined;
  const firstAirDate =
    expectedType === 'tv' && typeof rawVal.first_air_date === 'string' && rawVal.first_air_date.trim()
      ? rawVal.first_air_date.trim()
      : undefined;

  const firstStoredAt =
    typeof rawVal.firstStoredAt === 'string' && rawVal.firstStoredAt.trim()
      ? rawVal.firstStoredAt.trim()
      : '1970-01-01T00:00:00.000Z';
  const lastUpdatedAt =
    typeof rawVal.lastUpdatedAt === 'string' && rawVal.lastUpdatedAt.trim()
      ? rawVal.lastUpdatedAt.trim()
      : firstStoredAt;

  return {
    key,
    id: rawId,
    media_type: expectedType,
    title,
    original_title: originalTitle || undefined,
    overview: overview || undefined,
    poster_path: rawVal.poster_path ?? null,
    backdrop_path: rawVal.backdrop_path ?? null,
    genre_ids: Array.from(genreSet).sort((a, b) => a - b),
    vote_average: voteAverage,
    vote_count: voteCount,
    release_date: releaseDate,
    first_air_date: firstAirDate,
    popularity,
    firstStoredAt,
    lastUpdatedAt,
    source: rawVal.source === 'demo' ? 'demo' : 'tmdb',
  };
}

/**
 * İki katalog kaydını hiçbir dolu alanı (poster, özet, türler, oy sayısı) kaybetmeden
 * deterministik biçimde birleştirir.
 */
export function mergeCatalogRecordsLossless(
  localRec: CatalogRecord,
  remoteRec: CatalogRecord
): CatalogRecord {
  const localTs = localRec.lastUpdatedAt || localRec.firstStoredAt || '';
  const remoteTs = remoteRec.lastUpdatedAt || remoteRec.firstStoredAt || '';
  const remoteIsNewer = remoteTs > localTs;

  const pickString = (a?: string, b?: string): string => {
    const sa = (a || '').trim();
    const sb = (b || '').trim();
    if (sa && !sb) return sa;
    if (sb && !sa) return sb;
    if (!sa && !sb) return '';
    if (sa === sb) return sa;
    return remoteIsNewer ? sb : sa;
  };

  // Özet alanında daha zengin (boş olmayan ve daha kapsamlı) açıklamayı koru
  const pickRicherOverview = (a?: string, b?: string): string | undefined => {
    const sa = (a || '').trim();
    const sb = (b || '').trim();
    if (sa && !sb) return sa;
    if (sb && !sa) return sb;
    if (!sa && !sb) return undefined;
    if (sb.length > sa.length) return sb;
    if (sa.length > sb.length) return sa;
    return remoteIsNewer ? sb : sa;
  };

  const pickNullablePath = (a?: string | null, b?: string | null): string | null => {
    const sa = typeof a === 'string' && a.trim() ? a.trim() : null;
    const sb = typeof b === 'string' && b.trim() ? b.trim() : null;
    if (sa && !sb) return sa;
    if (sb && !sa) return sb;
    if (!sa && !sb) return null;
    return remoteIsNewer ? sb : sa;
  };

  const genreSet = new Set<number>([...(localRec.genre_ids || []), ...(remoteRec.genre_ids || [])]);
  const genreIds = Array.from(genreSet)
    .filter((g) => Number.isSafeInteger(g) && g > 0)
    .sort((a, b) => a - b);

  const localVotes = localRec.vote_count || 0;
  const remoteVotes = remoteRec.vote_count || 0;
  const voteCount = Math.max(localVotes, remoteVotes) || undefined;

  let voteAverage = 0;
  if ((localRec.vote_average || 0) > 0 && !(remoteRec.vote_average > 0)) {
    voteAverage = localRec.vote_average;
  } else if ((remoteRec.vote_average || 0) > 0 && !(localRec.vote_average > 0)) {
    voteAverage = remoteRec.vote_average;
  } else if (remoteVotes > localVotes) {
    voteAverage = remoteRec.vote_average;
  } else if (localVotes > remoteVotes) {
    voteAverage = localRec.vote_average;
  } else {
    voteAverage = remoteIsNewer ? remoteRec.vote_average : localRec.vote_average;
  }

  let popularity: number | undefined;
  const popA = localRec.popularity;
  const popB = remoteRec.popularity;
  if (Number.isFinite(popA) && Number.isFinite(popB)) {
    popularity = remoteIsNewer ? popB : popA;
  } else if (Number.isFinite(popA)) {
    popularity = popA;
  } else if (Number.isFinite(popB)) {
    popularity = popB;
  }

  const validFirstDates = [localRec.firstStoredAt, remoteRec.firstStoredAt]
    .filter((d): d is string => Boolean(d && d !== '1970-01-01T00:00:00.000Z'))
    .sort();
  const firstStoredAt =
    validFirstDates[0] || localRec.firstStoredAt || remoteRec.firstStoredAt || '1970-01-01T00:00:00.000Z';

  const validLastDates = [localRec.lastUpdatedAt, remoteRec.lastUpdatedAt]
    .filter((d): d is string => Boolean(d))
    .sort();
  const lastUpdatedAt =
    validLastDates[validLastDates.length - 1] || firstStoredAt;

  const originalTitle = pickString(localRec.original_title, remoteRec.original_title);
  const releaseDate = pickString(localRec.release_date, remoteRec.release_date);
  const firstAirDate =
    localRec.media_type === 'tv'
      ? pickString(localRec.first_air_date, remoteRec.first_air_date) || releaseDate || undefined
      : undefined;

  return {
    key: localRec.key,
    id: localRec.id,
    media_type: localRec.media_type,
    title: pickString(localRec.title, remoteRec.title),
    original_title: originalTitle || undefined,
    overview: pickRicherOverview(localRec.overview, remoteRec.overview),
    poster_path: pickNullablePath(localRec.poster_path, remoteRec.poster_path),
    backdrop_path: pickNullablePath(localRec.backdrop_path, remoteRec.backdrop_path),
    genre_ids: genreIds,
    vote_average: voteAverage,
    vote_count: voteCount,
    release_date: releaseDate || undefined,
    first_air_date: firstAirDate,
    popularity,
    firstStoredAt,
    lastUpdatedAt,
    source: localRec.source === 'tmdb' || remoteRec.source === 'tmdb' ? 'tmdb' : 'demo',
  };
}

export function stripCatalogVolatileFields(map: Record<string, CatalogRecord>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of Object.keys(map).sort((a, b) => a.localeCompare(b))) {
    const rec = map[key];
    if (!rec) continue;
    out[key] = {
      ...rec,
      firstStoredAt: '',
      lastUpdatedAt: '',
    };
  }
  return out;
}

export function computeCatalogSemanticMapHash(map: Record<string, CatalogRecord>): string {
  return hashContent(stringifyDeterministic(stripCatalogVolatileFields(map)));
}

export function computeCatalogManifestContentHash(
  movies: Record<string, CatalogRecord>,
  tv: Record<string, CatalogRecord>
): string {
  return hashContent(stringifyDeterministic(movies) + stringifyDeterministic(tv));
}

export function mergeCatalogMapsLossless(
  localMap: Record<string, CatalogRecord>,
  remoteMap: Record<string, CatalogRecord>,
  expectedType: 'movie' | 'tv'
): {
  merged: Record<string, CatalogRecord>;
  addedToLocal: number;
  addedToRemote: number;
  updatedLocal: number;
  updatedRemote: number;
  unchanged: number;
} {
  const merged: Record<string, CatalogRecord> = {};
  const allKeys = new Set<string>([...Object.keys(localMap), ...Object.keys(remoteMap)]);
  const sortedKeys = Array.from(allKeys).sort((a, b) => a.localeCompare(b));

  let addedToLocal = 0;
  let addedToRemote = 0;
  let updatedLocal = 0;
  let updatedRemote = 0;
  let unchanged = 0;

  for (const rawKey of sortedKeys) {
    const localRec = localMap[rawKey]
      ? normalizeCatalogRecordStrict(rawKey, localMap[rawKey], expectedType)
      : null;
    const remoteRec = remoteMap[rawKey]
      ? normalizeCatalogRecordStrict(rawKey, remoteMap[rawKey], expectedType)
      : null;

    if (localRec && !remoteRec) {
      merged[localRec.key] = localRec;
      addedToRemote++;
      continue;
    }
    if (remoteRec && !localRec) {
      merged[remoteRec.key] = remoteRec;
      addedToLocal++;
      continue;
    }
    if (!localRec || !remoteRec) continue;

    const combined = mergeCatalogRecordsLossless(localRec, remoteRec);
    merged[combined.key] = combined;

    const localSem = stringifyDeterministic({ ...localRec, firstStoredAt: '', lastUpdatedAt: '' });
    const remoteSem = stringifyDeterministic({ ...remoteRec, firstStoredAt: '', lastUpdatedAt: '' });
    const combSem = stringifyDeterministic({ ...combined, firstStoredAt: '', lastUpdatedAt: '' });

    const localDiff = localSem !== combSem;
    const remoteDiff = remoteSem !== combSem;
    if (!localDiff && !remoteDiff) {
      unchanged++;
    } else {
      if (localDiff) updatedLocal++;
      if (remoteDiff) updatedRemote++;
    }
  }

  return { merged, addedToLocal, addedToRemote, updatedLocal, updatedRemote, unchanged };
}

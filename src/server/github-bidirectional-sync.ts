import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ALGORITHM_VERSION,
  buildTasteProfileV3,
  computeTasteProfileSignature,
  CURRENT_SCHEMA_VERSION,
  dedupeItems,
  ENGINE_VERSION,
  inferLifecycleRing,
  isItemSaved,
  makeMediaKey,
  normalizeDataDocument,
  normalizeFavoriteActors,
  normalizePreferences,
  RECOMMENDATION_WEIGHTS_V3,
  scoreCandidatesV3,
  validItemId,
  type DataDocument,
  type FavoriteActorInfo,
  type Preferences,
  type Profile,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import { canonicalizeMediaKey, canonicalizeMediaKeyList } from '../core/keys.ts';
import { DEFAULT_MAX_DATA_BYTES, formatMaxDataLimitMb, measureUtf8Bytes } from '../core/limits.ts';
import {
  computeDerivedProfileContentHash,
  DERIVED_PROFILE_SCHEMA_VERSION,
  normalizeDerivedProfileItem,
} from '../core/derived-profile-cache.ts';
import type {
  BidirectionalSyncReport,
  PullConflictSummary,
  SyncComparisonSummary,
  SyncErrorCategory,
  SyncErrorRecord,
  SyncFileCategory,
  SyncFileDiffDetail,
  SyncFileInspection,
  SyncOperationKind,
  SyncSideSummary,
  UserDataConflictItem,
} from '../core/sync-display.ts';
import { tryParseValidJson, writeJsonFileAtomic } from './atomic-json.ts';
import {
  hashContent,
  redactSecrets,
  sanitizeProfileId,
  stringifyDeterministic,
  toCanonicalKey,
  type CatalogManifest,
  type CatalogRecord,
  type DerivedProfileDocument,
  type DerivedProfileItem,
  type PersistentDataStore,
} from './persistent-store.ts';
import type { createDataStorage } from './storage.ts';

/**
 * Senkronize edilen kalıcı veri envanteri:
 * 1. data/catalog/movies.json   -> Ortak film metaverileri (`movie:<id>`), açık ve özel depoda senkronize edilir.
 * 2. data/catalog/tv.json       -> Ortak dizi metaverileri (`tv:<id>`), açık ve özel depoda senkronize edilir.
 * 3. data/catalog/manifest.json -> Katalog sayım ve içerik hash özeti, açık ve özel depoda senkronize edilir.
 * 4. data/cinetrack-data.json   -> Kullanıcı profilleri, izleme listeleri, puanlar ve tercihler (yalnızca özel depoda).
 * 5. data/profiles/*.json       -> Profil bazlı türetilmiş öneri puanları ve halkaları (yalnızca özel depoda).
 *
 * Geçici önbellekler, `.bak`, `data/backups/*`, `data/sync-state.json`, `.tmp`, `.corrupt.*`,
 * `.env` ve derleme çıktıları envantere kesinlikle dahil edilmez.
 */
export const SYNC_STATIC_INVENTORY: ReadonlyArray<{
  repoPath: string;
  category: SyncFileCategory;
  personal: boolean;
  description: string;
}> = Object.freeze([
  {
    repoPath: 'data/catalog/movies.json',
    category: 'catalog_movies',
    personal: false,
    description: 'Ortak film kataloğu metaverileri (movie:<id>)',
  },
  {
    repoPath: 'data/catalog/tv.json',
    category: 'catalog_tv',
    personal: false,
    description: 'Ortak dizi kataloğu metaverileri (tv:<id>)',
  },
  {
    repoPath: 'data/catalog/manifest.json',
    category: 'catalog_manifest',
    personal: false,
    description: 'Katalog film/dizi sayıları ve içerik özeti doğrulaması',
  },
  {
    repoPath: 'data/cinetrack-data.json',
    category: 'user_data',
    personal: true,
    description: 'Kullanıcı profilleri, izleme listeleri, puanlar, tercihler ve favori oyuncular',
  },
]);

function isPlainObject(val: unknown): val is Record<string, any> {
  return Boolean(val && typeof val === 'object' && !Array.isArray(val));
}

export function computeRawUtf8Hash(rawContent: string): string {
  return hashContent(rawContent);
}

function classifyGitHubHttpStatus(
  status: number,
  headers: Headers,
  bodyMessage: string
): SyncErrorCategory {
  const remaining = headers.get('x-ratelimit-remaining');
  const lower = (bodyMessage || '').toLowerCase();
  if (
    status === 429 ||
    (status === 403 && (remaining === '0' || lower.includes('rate limit') || lower.includes('secondary rate')))
  ) {
    return 'rate_limit';
  }
  if (status === 401 || status === 403) {
    return 'auth_error';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status === 409) {
    return 'conflict';
  }
  return 'http_error';
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

function stripUserDataVolatileFields(doc: DataDocument): Record<string, any> {
  const profiles = [...(doc.profiles || [])]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => {
      const items = [...(p.items || [])]
        .map((it) => {
          const key = makeMediaKey(it);
          return {
            key,
            id: it.id,
            media_type: it.media_type,
            title: it.title,
            status: it.status,
            personal_rating: it.personal_rating === '' ? '' : Number(it.personal_rating),
            personal_rating_cleared: Boolean(it.personal_rating_cleared),
            season_progress: it.season_progress || {},
            season_episode_counts: it.season_episode_counts || {},
            genre_ids: [...(it.genre_ids || [])].sort((a, b) => a - b),
            overview: it.overview || '',
            poster_path: it.poster_path || '',
            backdrop_path: it.backdrop_path || '',
            isDemo: Boolean(it.isDemo),
          };
        })
        .sort((a, b) => a.key.localeCompare(b.key));

      const prefs = p.preferences || {
        disliked: [],
        providers: [],
        mood: '',
        reminders: false,
        notified: [],
      };
      return {
        id: p.id,
        name: p.name,
        isDemo: Boolean(p.isDemo),
        preferences: {
          disliked: canonicalizeMediaKeyList(prefs.disliked || []).sort(),
          hidden: canonicalizeMediaKeyList(prefs.hidden || []).sort(),
          providers: [...(prefs.providers || [])].map(String).sort(),
          mood: prefs.mood || '',
          reminders: Boolean(prefs.reminders),
        },
        favoriteActors: [...(p.favoriteActors || [])]
          .map((a) => ({ id: a.id, name: a.name, profile_path: a.profile_path ?? null }))
          .sort((a, b) => a.id - b.id),
        items,
      };
    });

  return {
    version: 3,
    schemaVersion: doc.schemaVersion || CURRENT_SCHEMA_VERSION,
    activeProfileId: doc.activeProfileId,
    profiles,
  };
}

export function computeUserDataSemanticHash(doc: DataDocument): string {
  return hashContent(stringifyDeterministic(stripUserDataVolatileFields(doc)));
}

function statusProgressionRank(status?: string): number {
  if (status === 'completed') return 3;
  if (status === 'watching') return 2;
  return 1;
}

function mergeTwoSavedItemsLossless(
  profileId: string,
  localItem: SavedItem,
  remoteItem: SavedItem
): {
  merged: SavedItem;
  conflict?: UserDataConflictItem;
  changedLocal: boolean;
  changedRemote: boolean;
} {
  const key = makeMediaKey(localItem);
  const localTime = localItem.updatedAt || localItem.addedAt || '';
  const remoteTime = remoteItem.updatedAt || remoteItem.addedAt || '';

  const statusDiffers = localItem.status !== remoteItem.status;
  const localRatingStr =
    localItem.personal_rating !== '' && localItem.personal_rating != null
      ? String(localItem.personal_rating)
      : '';
  const remoteRatingStr =
    remoteItem.personal_rating !== '' && remoteItem.personal_rating != null
      ? String(remoteItem.personal_rating)
      : '';
  const bothHaveDifferentRatings =
    Boolean(localRatingStr) && Boolean(remoteRatingStr) && localRatingStr !== remoteRatingStr;

  let chosenStatus: SavedItem['status'] = localItem.status;
  let resolutionNote = '';

  if (statusDiffers) {
    if (remoteTime && localTime && remoteTime !== localTime) {
      if (remoteTime > localTime) {
        chosenStatus = remoteItem.status;
        resolutionNote = `Daha güncel zaman damgalı GitHub durumu (${remoteItem.status}) seçildi`;
      } else {
        chosenStatus = localItem.status;
        resolutionNote = `Daha güncel zaman damgalı yerel durum (${localItem.status}) korundu`;
      }
    } else {
      chosenStatus =
        statusProgressionRank(remoteItem.status) > statusProgressionRank(localItem.status)
          ? remoteItem.status
          : localItem.status;
      resolutionNote = `İzleme ilerlemesi daha ileri olan durum (${chosenStatus}) seçildi`;
    }
  }

  let chosenRating: number | '' = localItem.personal_rating;
  let chosenRatingCleared = Boolean(localItem.personal_rating_cleared);

  if (localRatingStr !== remoteRatingStr) {
    if (localRatingStr && !remoteRatingStr) {
      if (remoteItem.personal_rating_cleared && remoteTime > localTime) {
        chosenRating = '';
        chosenRatingCleared = true;
      } else {
        chosenRating = localItem.personal_rating;
        chosenRatingCleared = false;
      }
    } else if (remoteRatingStr && !localRatingStr) {
      if (localItem.personal_rating_cleared && localTime > remoteTime) {
        chosenRating = '';
        chosenRatingCleared = true;
      } else {
        chosenRating = remoteItem.personal_rating;
        chosenRatingCleared = false;
      }
    } else if (bothHaveDifferentRatings) {
      if (remoteTime > localTime) {
        chosenRating = remoteItem.personal_rating;
      } else {
        chosenRating = localItem.personal_rating;
      }
      chosenRatingCleared = false;
      resolutionNote = resolutionNote
        ? `${resolutionNote}; puan olarak güncel kayıt (${chosenRating}) seçildi`
        : `Farklı kişisel puanlar arasından güncel olan (${chosenRating}) seçildi`;
    }
  }

  // Sezon ilerlemelerini kayıpsız birleştir (her sezon için daha yüksek izlenen bölüm sayısını koru)
  const mergedSeasonProgress: Record<number, number> = { ...(localItem.season_progress || {}) };
  for (const [seasonKey, epCount] of Object.entries(remoteItem.season_progress || {})) {
    const sNum = Number(seasonKey);
    const prev = mergedSeasonProgress[sNum] || 0;
    mergedSeasonProgress[sNum] = Math.max(prev, Number(epCount) || 0);
  }
  const mergedSeasonTotals: Record<number, number> = {
    ...(localItem.season_episode_counts || {}),
    ...(remoteItem.season_episode_counts || {}),
  };

  const genreSet = new Set<number>([
    ...(localItem.genre_ids || []),
    ...(remoteItem.genre_ids || []),
  ]);
  const richerOverview =
    (remoteItem.overview || '').trim().length > (localItem.overview || '').trim().length
      ? remoteItem.overview
      : localItem.overview || remoteItem.overview;

  const earliestAdded = [localItem.addedAt, remoteItem.addedAt].filter(Boolean).sort()[0];
  const latestUpdated = [localTime, remoteTime].filter(Boolean).sort().slice(-1)[0];

  const baseWinner = remoteTime > localTime ? remoteItem : localItem;
  const fallbackOther = baseWinner === remoteItem ? localItem : remoteItem;

  const merged: SavedItem = {
    ...fallbackOther,
    ...baseWinner,
    id: localItem.id,
    media_type: localItem.media_type,
    title: baseWinner.title || fallbackOther.title,
    overview: richerOverview,
    poster_path: baseWinner.poster_path || fallbackOther.poster_path,
    poster_url: baseWinner.poster_url || fallbackOther.poster_url,
    backdrop_path: baseWinner.backdrop_path || fallbackOther.backdrop_path,
    genre_ids: Array.from(genreSet).sort((a, b) => a - b),
    status: chosenStatus,
    personal_rating: chosenRating,
    personal_rating_cleared: chosenRatingCleared,
    ...(Object.keys(mergedSeasonProgress).length > 0
      ? { season_progress: mergedSeasonProgress }
      : {}),
    ...(Object.keys(mergedSeasonTotals).length > 0
      ? { season_episode_counts: mergedSeasonTotals }
      : {}),
    addedAt: earliestAdded || localItem.addedAt || remoteItem.addedAt,
    updatedAt: latestUpdated || localItem.updatedAt || remoteItem.updatedAt,
    isDemo: Boolean(localItem.isDemo && remoteItem.isDemo),
  };

  const itemSem = (it: SavedItem) =>
    stringifyDeterministic({
      status: it.status,
      rating: it.personal_rating === '' ? '' : Number(it.personal_rating),
      cleared: Boolean(it.personal_rating_cleared),
      progress: it.season_progress || {},
      overview: it.overview || '',
      poster: it.poster_path || '',
      genres: [...(it.genre_ids || [])].sort((a, b) => a - b),
    });

  const mergedSem = itemSem(merged);
  const changedLocal = itemSem(localItem) !== mergedSem;
  const changedRemote = itemSem(remoteItem) !== mergedSem;

  const conflict: UserDataConflictItem | undefined =
    statusDiffers || bothHaveDifferentRatings
      ? {
          profileId,
          mediaKey: key,
          title: merged.title,
          localStatus: localItem.status,
          remoteStatus: remoteItem.status,
          localRating: localItem.personal_rating,
          remoteRating: remoteItem.personal_rating,
          resolution: resolutionNote || 'Alan düzeyinde kayıpsız birleştirildi',
        }
      : undefined;

  return { merged, conflict, changedLocal, changedRemote };
}

/**
 * Kullanıcı verisini (`cinetrack-data.json`) varsayılan silmesiz (no-deletion) politikayla
 * iki yönlü ve kayıpsız biçimde birleştirir.
 */
export function reconcileUserDataDocumentsLossless(
  localDoc: DataDocument,
  remoteDoc: DataDocument
): {
  mergedDoc: DataDocument;
  addedToLocal: number;
  addedToRemote: number;
  updatedItems: number;
  conflicts: UserDataConflictItem[];
} {
  const localById = new Map<string, Profile>();
  for (const p of localDoc.profiles || []) localById.set(p.id, p);

  const remoteById = new Map<string, Profile>();
  for (const p of remoteDoc.profiles || []) remoteById.set(p.id, p);

  const allProfileIds = Array.from(
    new Set<string>([...localById.keys(), ...remoteById.keys()])
  );

  const mergedProfiles: Profile[] = [];
  const conflicts: UserDataConflictItem[] = [];
  let addedToLocal = 0;
  let addedToRemote = 0;
  let updatedItems = 0;

  for (const profileId of allProfileIds) {
    const lp = localById.get(profileId);
    const rp = remoteById.get(profileId);

    // Eğer bir taraf yalnızca başlangıç demo profili ve diğer taraf gerçek kullanıcı kaydı içeriyorsa demo bayrağını kaldır
    if (lp && !rp) {
      mergedProfiles.push(lp);
      addedToRemote += (lp.items || []).length;
      continue;
    }
    if (rp && !lp) {
      mergedProfiles.push(rp);
      addedToLocal += (rp.items || []).length;
      continue;
    }
    if (!lp || !rp) continue;

    const lpLiveItems = lp.isDemo && !rp.isDemo ? [] : lp.items || [];
    const rpLiveItems = rp.isDemo && !lp.isDemo ? [] : rp.items || [];

    const localItemsMap = new Map<string, SavedItem>();
    for (const it of dedupeItems(lpLiveItems)) {
      localItemsMap.set(makeMediaKey(it), it);
    }
    const remoteItemsMap = new Map<string, SavedItem>();
    for (const it of dedupeItems(rpLiveItems)) {
      remoteItemsMap.set(makeMediaKey(it), it);
    }

    const allItemKeys = Array.from(
      new Set<string>([...localItemsMap.keys(), ...remoteItemsMap.keys()])
    );

    const combinedItems: SavedItem[] = [];
    for (const key of allItemKeys) {
      const li = localItemsMap.get(key);
      const ri = remoteItemsMap.get(key);
      if (li && !ri) {
        combinedItems.push(li);
        addedToRemote++;
      } else if (ri && !li) {
        combinedItems.push(ri);
        addedToLocal++;
      } else if (li && ri) {
        const res = mergeTwoSavedItemsLossless(profileId, li, ri);
        combinedItems.push(res.merged);
        if (res.conflict) conflicts.push(res.conflict);
        if (res.changedLocal || res.changedRemote) updatedItems++;
      }
    }

    const mergedDisliked = Array.from(
      new Set<string>([
        ...canonicalizeMediaKeyList(lp.preferences?.disliked || []),
        ...canonicalizeMediaKeyList(rp.preferences?.disliked || []),
      ])
    );
    const mergedHidden = Array.from(
      new Set<string>([
        ...canonicalizeMediaKeyList(lp.preferences?.hidden || []),
        ...canonicalizeMediaKeyList(rp.preferences?.hidden || []),
      ])
    );
    const mergedProviders = Array.from(
      new Set<string>([
        ...(lp.preferences?.providers || []).map(String),
        ...(rp.preferences?.providers || []).map(String),
      ])
    ).sort();
    const mergedNotified = Array.from(
      new Set<string>([
        ...(lp.preferences?.notified || []),
        ...(rp.preferences?.notified || []),
      ])
    ).slice(-200);

    const mergedPrefs: Preferences = normalizePreferences({
      disliked: mergedDisliked,
      ...(mergedHidden.length > 0 ? { hidden: mergedHidden } : {}),
      providers: mergedProviders,
      mood: lp.preferences?.mood || rp.preferences?.mood || '',
      reminders: Boolean(lp.preferences?.reminders || rp.preferences?.reminders),
      notified: mergedNotified,
    });

    const actorMap = new Map<number, FavoriteActorInfo>();
    for (const actor of normalizeFavoriteActors([
      ...(lp.favoriteActors || []),
      ...(rp.favoriteActors || []),
    ])) {
      const prev = actorMap.get(actor.id);
      if (!prev) {
        actorMap.set(actor.id, actor);
      } else {
        actorMap.set(actor.id, {
          id: actor.id,
          name: prev.name || actor.name,
          profile_path: prev.profile_path || actor.profile_path || null,
          character: prev.character || actor.character,
        });
      }
    }

    const earliestCreated = [lp.createdAt, rp.createdAt].filter(Boolean).sort()[0] || '';
    const profileName =
      lp.name && lp.name !== 'Profilim'
        ? lp.name
        : rp.name && rp.name !== 'Profilim'
        ? rp.name
        : lp.name || rp.name || 'Profilim';

    mergedProfiles.push({
      id: profileId,
      name: profileName,
      createdAt: earliestCreated,
      preferences: mergedPrefs,
      items: dedupeItems(combinedItems),
      favoriteActors: Array.from(actorMap.values()),
      isDemo: Boolean(lp.isDemo && rp.isDemo),
    });
  }

  const preferredActive =
    mergedProfiles.find((p) => p.id === localDoc.activeProfileId)?.id ||
    mergedProfiles.find((p) => p.id === remoteDoc.activeProfileId)?.id ||
    mergedProfiles[0]?.id ||
    'profile-default';

  const maxRev = Math.max(localDoc.revision ?? 0, remoteDoc.revision ?? 0);

  return {
    mergedDoc: {
      version: 3,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      activeProfileId: preferredActive,
      profiles: mergedProfiles,
      revision: maxRev + 1,
      updatedAt: new Date().toISOString(),
    },
    addedToLocal,
    addedToRemote,
    updatedItems,
    conflicts,
  };
}

/**
 * Kaynak profil ve katalogdan sunucu tarafında güncel türetilmiş profil belgesi üretir.
 * Eski/geçersiz profil önbellekleri yenilendiğinde kullanılır.
 */
export function buildFreshDerivedProfileDocumentOnServer(
  profile: Profile,
  movies: Record<string, CatalogRecord>,
  tv: Record<string, CatalogRecord>,
  sourceCatalogHash: string
): DerivedProfileDocument {
  const savedItems = profile.items || [];
  const preferences = profile.preferences || {
    disliked: [],
    providers: [],
    mood: '',
    reminders: false,
    notified: [],
  };
  const favoriteActors = profile.favoriteActors || [];
  const fingerprint = computeTasteProfileSignature(savedItems, preferences, favoriteActors, {
    targetType: 'all',
    algorithmVersion: ALGORITHM_VERSION,
  });

  const candidates: CatalogRecord[] = [...Object.values(movies), ...Object.values(tv)];
  const tasteProfile = buildTasteProfileV3(savedItems, {
    dislikedKeys: preferences.disliked || [],
  });
  const scored = scoreCandidatesV3(candidates, tasteProfile, {
    weights: RECOMMENDATION_WEIGHTS_V3,
    mood: preferences.mood || '',
  });

  const nowIso = new Date().toISOString();
  const items: Record<string, DerivedProfileItem> = {};

  for (const s of scored) {
    const cand = s.candidate || s;
    const key = toCanonicalKey(cand);
    if (!key) continue;
    const tasteScore = Math.max(
      1,
      Math.min(100, Math.round(Number(s.tasteScore ?? s.score ?? 50)))
    );
    const saved = isItemSaved(savedItems, cand, cand.media_type);
    const disliked = Boolean(
      preferences.disliked?.some((k) => canonicalizeMediaKey(k) === key)
    );
    const hidden = Boolean(
      preferences.hidden?.some((k) => canonicalizeMediaKey(k) === key)
    );
    const status: DerivedProfileItem['status'] = saved
      ? 'saved'
      : disliked
      ? 'disliked'
      : hidden
      ? 'hidden'
      : 'active';

    const normalized = normalizeDerivedProfileItem(key, {
      mediaKey: key,
      matchScore: tasteScore,
      tasteScore,
      priorityScore: tasteScore,
      lifecycleRing: inferLifecycleRing(key, { shownCount: 0, skippedCount: 0 }, []),
      signals: s.parts && Object.keys(s.parts).length > 0 ? s.parts : undefined,
      reasons: Array.isArray(s.tags) && s.tags.length > 0 ? s.tags : undefined,
      shownCount: 0,
      skippedCount: 0,
      demotionPenalty: 0,
      status,
      scoreCoverage: 'basic',
      calculatedAt: nowIso,
    });
    if (normalized) {
      items[key] = normalized;
    }
  }

  const contentHash = computeDerivedProfileContentHash({
    schemaVersion: DERIVED_PROFILE_SCHEMA_VERSION,
    profileId: profile.id,
    algorithmVersion: ALGORITHM_VERSION,
    profileFingerprint: fingerprint,
    sourceCatalogHash,
    items,
  });

  return {
    schemaVersion: DERIVED_PROFILE_SCHEMA_VERSION,
    profileId: profile.id,
    algorithmVersion: ALGORITHM_VERSION,
    profileFingerprint: fingerprint,
    sourceCatalogHash,
    contentHash,
    generatedAt: nowIso,
    items,
  };
}

function inspectCatalogRawContent(
  repoPath: string,
  rawText: string,
  expectedType: 'movie' | 'tv',
  maxBytes: number,
  sha?: string
): {
  inspection: SyncFileInspection;
  parsedMap?: Record<string, CatalogRecord>;
} {
  const category: SyncFileCategory =
    expectedType === 'movie' ? 'catalog_movies' : 'catalog_tv';
  const sizeBytes = measureUtf8Bytes(rawText);
  if (sizeBytes > maxBytes) {
    return {
      inspection: {
        repoPath,
        category,
        personal: false,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Dosya boyutu izin verilen sınırı (${formatMaxDataLimitMb(maxBytes)}) aşıyor.`,
        errorCategory: 'payload_too_large',
      },
    };
  }

  let rawParsed: any;
  try {
    rawParsed = JSON.parse(rawText);
  } catch (err: any) {
    return {
      inspection: {
        repoPath,
        category,
        personal: false,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Geçersiz JSON: ${err?.message || 'ayrıştırılamadı'}`,
        errorCategory: 'corrupt_remote_json',
      },
    };
  }

  if (!isPlainObject(rawParsed)) {
    return {
      inspection: {
        repoPath,
        category,
        personal: false,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: 'Katalog dosyası nesne (key-value map) şemasında değil.',
        errorCategory: 'schema_mismatch',
      },
    };
  }

  const entries = Object.entries(rawParsed);
  const normalizedMap: Record<string, CatalogRecord> = {};
  for (const [k, v] of entries) {
    const rec = normalizeCatalogRecordStrict(k, v, expectedType);
    if (!rec) {
      return {
        inspection: {
          repoPath,
          category,
          personal: false,
          exists: true,
          valid: false,
          sizeBytes,
          rawFileHash: computeRawUtf8Hash(rawText),
          semanticHash: null,
          recordCount: entries.length,
          uniqueKeyCount: 0,
          sha,
          error: `Katalogda geçersiz veya farklı medya tipinde kayıt bulundu (${k}).`,
          errorCategory: 'schema_mismatch',
        },
      };
    }
    normalizedMap[rec.key] = rec;
  }

  const semanticHash = computeCatalogSemanticMapHash(normalizedMap);
  return {
    inspection: {
      repoPath,
      category,
      personal: false,
      exists: true,
      valid: true,
      sizeBytes,
      rawFileHash: computeRawUtf8Hash(rawText),
      semanticHash,
      recordCount: entries.length,
      uniqueKeyCount: Object.keys(normalizedMap).length,
      sha,
    },
    parsedMap: normalizedMap,
  };
}

function inspectManifestRawContent(
  rawText: string,
  actualMovies: Record<string, CatalogRecord>,
  actualTv: Record<string, CatalogRecord>,
  maxBytes: number,
  sha?: string
): {
  inspection: SyncFileInspection;
  manifest?: CatalogManifest;
  manifestConsistent: boolean;
  mismatchReason?: string;
} {
  const repoPath = 'data/catalog/manifest.json';
  const sizeBytes = measureUtf8Bytes(rawText);
  if (sizeBytes > maxBytes) {
    return {
      manifestConsistent: false,
      mismatchReason: 'Boyut sınırı aşıldı',
      inspection: {
        repoPath,
        category: 'catalog_manifest',
        personal: false,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: 'Manifest boyutu sınırı aşıyor.',
        errorCategory: 'payload_too_large',
      },
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (err: any) {
    return {
      manifestConsistent: false,
      mismatchReason: 'Manifest JSON bozuk',
      inspection: {
        repoPath,
        category: 'catalog_manifest',
        personal: false,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Manifest geçersiz JSON: ${err?.message || 'ayrıştırılamadı'}`,
        errorCategory: 'corrupt_remote_json',
      },
    };
  }

  if (
    !isPlainObject(parsed) ||
    !Number.isSafeInteger(Number(parsed.movieCount)) ||
    !Number.isSafeInteger(Number(parsed.tvCount)) ||
    typeof parsed.contentHash !== 'string' ||
    !parsed.contentHash.trim()
  ) {
    return {
      manifestConsistent: false,
      mismatchReason: 'Manifest şeması eksik',
      inspection: {
        repoPath,
        category: 'catalog_manifest',
        personal: false,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: 'Manifest şeması beklenen alanları (movieCount, tvCount, contentHash) içermiyor.',
        errorCategory: 'schema_mismatch',
      },
    };
  }

  const expectedMovieCount = Object.keys(actualMovies).length;
  const expectedTvCount = Object.keys(actualTv).length;
  const expectedHash = computeCatalogManifestContentHash(actualMovies, actualTv);

  const reasons: string[] = [];
  if (Number(parsed.movieCount) !== expectedMovieCount) {
    reasons.push(`manifest movieCount (${parsed.movieCount}) != gerçek (${expectedMovieCount})`);
  }
  if (Number(parsed.tvCount) !== expectedTvCount) {
    reasons.push(`manifest tvCount (${parsed.tvCount}) != gerçek (${expectedTvCount})`);
  }
  if (parsed.contentHash !== expectedHash) {
    reasons.push('manifest contentHash gerçek katalog özetiyle uyuşmuyor');
  }

  const consistent = reasons.length === 0;
  const mismatchReason = consistent ? undefined : reasons.join('; ');
  const semanticHash = hashContent(
    stringifyDeterministic({
      version: 1,
      movieCount: Number(parsed.movieCount),
      tvCount: Number(parsed.tvCount),
      contentHash: parsed.contentHash,
    })
  );

  return {
    manifest: parsed as CatalogManifest,
    manifestConsistent: consistent,
    mismatchReason,
    inspection: {
      repoPath,
      category: 'catalog_manifest',
      personal: false,
      exists: true,
      valid: consistent,
      sizeBytes,
      rawFileHash: computeRawUtf8Hash(rawText),
      semanticHash,
      recordCount: 1,
      uniqueKeyCount: 1,
      sha,
      ...(consistent
        ? {}
        : {
            error: `Manifest tutarsızlığı: ${mismatchReason}`,
            errorCategory: 'schema_mismatch' as const,
          }),
    },
  };
}

function inspectUserDataRawContent(
  rawText: string,
  maxBytes: number,
  sha?: string
): {
  inspection: SyncFileInspection;
  doc?: DataDocument;
  rawItemsCount: number;
  uniqueItemsCount: number;
} {
  const repoPath = 'data/cinetrack-data.json';
  const sizeBytes = measureUtf8Bytes(rawText);
  if (sizeBytes > maxBytes) {
    return {
      rawItemsCount: 0,
      uniqueItemsCount: 0,
      inspection: {
        repoPath,
        category: 'user_data',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Kullanıcı veri dosyası sınırı (${formatMaxDataLimitMb(maxBytes)}) aşıyor.`,
        errorCategory: 'payload_too_large',
      },
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (err: any) {
    return {
      rawItemsCount: 0,
      uniqueItemsCount: 0,
      inspection: {
        repoPath,
        category: 'user_data',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Kullanıcı verisi geçersiz JSON: ${err?.message || 'ayrıştırılamadı'}`,
        errorCategory: 'corrupt_remote_json',
      },
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      rawItemsCount: 0,
      uniqueItemsCount: 0,
      inspection: {
        repoPath,
        category: 'user_data',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: 'cinetrack-data.json kök düzeyi geçerli bir nesne değil.',
        errorCategory: 'schema_mismatch',
      },
    };
  }

  if (Array.isArray(parsed.profiles)) {
    for (const p of parsed.profiles) {
      if (!isPlainObject(p) || !Array.isArray(p.items)) continue;
      for (const item of p.items) {
        if (
          !isPlainObject(item) ||
          !validItemId(item.id) ||
          (item.media_type !== 'movie' && item.media_type !== 'tv')
        ) {
          return {
            rawItemsCount: 0,
            uniqueItemsCount: 0,
            inspection: {
              repoPath,
              category: 'user_data',
              personal: true,
              exists: true,
              valid: false,
              sizeBytes,
              rawFileHash: computeRawUtf8Hash(rawText),
              semanticHash: null,
              recordCount: 0,
              uniqueKeyCount: 0,
              sha,
              error: 'Kullanıcı listesinde geçersiz kimlikli veya bozuk içerik kaydı tespit edildi.',
              errorCategory: 'schema_mismatch',
            },
          };
        }
      }
    }
  }

  // Boş başlangıç dokümanı (`profiles: []`) sunucuda geçerli boş durumdur
  if (Array.isArray(parsed.profiles) && parsed.profiles.length === 0) {
    const emptyDoc: DataDocument = {
      version: 3,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      activeProfileId: '',
      profiles: [],
      revision: Number(parsed.revision) || 0,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
    return {
      doc: emptyDoc,
      rawItemsCount: 0,
      uniqueItemsCount: 0,
      inspection: {
        repoPath,
        category: 'user_data',
        personal: true,
        exists: true,
        valid: true,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: computeUserDataSemanticHash(emptyDoc),
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
      },
    };
  }

  const normalized = normalizeDataDocument(parsed);
  if (!normalized) {
    return {
      rawItemsCount: 0,
      uniqueItemsCount: 0,
      inspection: {
        repoPath,
        category: 'user_data',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: 'cinetrack-data.json beklenen CineTrack veri şemasına uymuyor.',
        errorCategory: 'schema_mismatch',
      },
    };
  }

  let rawItemsCount = 0;
  if (Array.isArray(parsed.profiles)) {
    for (const p of parsed.profiles) {
      if (Array.isArray(p?.items)) rawItemsCount += p.items.length;
    }
  }
  const uniqueKeys = new Set<string>();
  let normalizedItemsTotal = 0;
  for (const p of normalized.profiles) {
    normalizedItemsTotal += p.items.length;
    for (const it of p.items) {
      uniqueKeys.add(`${p.id}::${makeMediaKey(it)}`);
    }
  }

  return {
    doc: normalized,
    rawItemsCount: rawItemsCount || normalizedItemsTotal,
    uniqueItemsCount: uniqueKeys.size,
    inspection: {
      repoPath,
      category: 'user_data',
      personal: true,
      exists: true,
      valid: true,
      sizeBytes,
      rawFileHash: computeRawUtf8Hash(rawText),
      semanticHash: computeUserDataSemanticHash(normalized),
      recordCount: rawItemsCount || normalizedItemsTotal,
      uniqueKeyCount: uniqueKeys.size,
      sha,
    },
  };
}

function inspectDerivedProfileRawContent(
  repoPath: string,
  rawText: string,
  maxBytes: number,
  sha?: string
): {
  inspection: SyncFileInspection;
  doc?: DerivedProfileDocument;
} {
  const sizeBytes = measureUtf8Bytes(rawText);
  if (sizeBytes > maxBytes) {
    return {
      inspection: {
        repoPath,
        category: 'derived_profile',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Profil önbellek dosyası sınırı (${formatMaxDataLimitMb(maxBytes)}) aşıyor.`,
        errorCategory: 'payload_too_large',
      },
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (err: any) {
    return {
      inspection: {
        repoPath,
        category: 'derived_profile',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Türetilmiş profil geçersiz JSON: ${err?.message || 'ayrıştırılamadı'}`,
        errorCategory: 'corrupt_remote_json',
      },
    };
  }

  if (
    !isPlainObject(parsed) ||
    typeof parsed.profileId !== 'string' ||
    !parsed.profileId.trim() ||
    typeof parsed.algorithmVersion !== 'string' ||
    typeof parsed.profileFingerprint !== 'string' ||
    !isPlainObject(parsed.items)
  ) {
    return {
      inspection: {
        repoPath,
        category: 'derived_profile',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: 'Türetilmiş profil dosyası şeması geçersiz.',
        errorCategory: 'schema_mismatch',
      },
    };
  }

  const rawEntries = Object.entries(parsed.items);
  const normalizedItems: Record<string, DerivedProfileItem> = {};
  for (const [k, val] of rawEntries) {
    const norm = normalizeDerivedProfileItem(k, val);
    if (!norm) {
      return {
        inspection: {
          repoPath,
          category: 'derived_profile',
          personal: true,
          exists: true,
          valid: false,
          sizeBytes,
          rawFileHash: computeRawUtf8Hash(rawText),
          semanticHash: null,
          recordCount: rawEntries.length,
          uniqueKeyCount: 0,
          sha,
          error: `Türetilmiş profil içinde bozuk öğe (${k}).`,
          errorCategory: 'schema_mismatch',
        },
      };
    }
    normalizedItems[norm.mediaKey] = norm;
  }

  const computedHash = computeDerivedProfileContentHash({
    schemaVersion: Number(parsed.schemaVersion) || 1,
    profileId: parsed.profileId,
    algorithmVersion: parsed.algorithmVersion,
    profileFingerprint: parsed.profileFingerprint,
    sourceCatalogHash: String(parsed.sourceCatalogHash || ''),
    items: normalizedItems,
  });

  if (typeof parsed.contentHash === 'string' && parsed.contentHash && parsed.contentHash !== computedHash) {
    return {
      inspection: {
        repoPath,
        category: 'derived_profile',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: rawEntries.length,
        uniqueKeyCount: Object.keys(normalizedItems).length,
        sha,
        error: 'Türetilmiş profil contentHash doğrulaması başarısız (veri bütünlüğü bozuk).',
        errorCategory: 'schema_mismatch',
      },
    };
  }

  const doc: DerivedProfileDocument = {
    schemaVersion: Number(parsed.schemaVersion) || 1,
    profileId: parsed.profileId,
    algorithmVersion: parsed.algorithmVersion,
    profileFingerprint: parsed.profileFingerprint,
    sourceCatalogHash: String(parsed.sourceCatalogHash || ''),
    contentHash: computedHash,
    generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
    items: normalizedItems,
  };

  return {
    doc,
    inspection: {
      repoPath,
      category: 'derived_profile',
      personal: true,
      exists: true,
      valid: true,
      sizeBytes,
      rawFileHash: computeRawUtf8Hash(rawText),
      semanticHash: computedHash,
      recordCount: rawEntries.length,
      uniqueKeyCount: Object.keys(normalizedItems).length,
      sha,
    },
  };
}

interface ParsedSideBundle {
  summary: SyncSideSummary;
  movies: Record<string, CatalogRecord>;
  tv: Record<string, CatalogRecord>;
  manifest: CatalogManifest | null;
  userData: DataDocument | null;
  derivedProfiles: Record<string, DerivedProfileDocument>;
  errors: SyncErrorRecord[];
}

export function compareSyncSides(
  localBundle: ParsedSideBundle,
  remoteBundle: ParsedSideBundle,
  options: { includePersonalFiles: boolean }
): SyncComparisonSummary {
  const allPaths = new Set<string>([
    ...Object.keys(localBundle.summary.files),
    ...Object.keys(remoteBundle.summary.files),
  ]);

  const differingFiles: SyncFileDiffDetail[] = [];
  const reasons: string[] = [];
  let rawFilesEqual = true;
  let semanticEqual = true;
  let comparedFilesCount = 0;
  let differentRecordsCount = 0;

  const sortedPaths = Array.from(allPaths).sort((a, b) => a.localeCompare(b));
  for (const repoPath of sortedPaths) {
    const lf = localBundle.summary.files[repoPath];
    const rf = remoteBundle.summary.files[repoPath];
    const personal = Boolean(lf?.personal ?? rf?.personal);
    if (personal && !options.includePersonalFiles) continue;

    const lExists = Boolean(lf?.exists);
    const rExists = Boolean(rf?.exists);
    if (!lExists && !rExists) continue;

    comparedFilesCount++;
    const category: SyncFileCategory = lf?.category || rf?.category || 'catalog_movies';
    const lValid = lExists ? Boolean(lf?.valid) : true;
    const rValid = rExists ? Boolean(rf?.valid) : true;
    const lRecords = lf?.uniqueKeyCount ?? 0;
    const rRecords = rf?.uniqueKeyCount ?? 0;

    const fileRawEqual = Boolean(
      lExists && rExists && lValid && rValid && lf?.rawFileHash && lf.rawFileHash === rf?.rawFileHash
    );
    const fileSemanticEqual = Boolean(
      lExists &&
        rExists &&
        lValid &&
        rValid &&
        lf?.semanticHash &&
        lf.semanticHash === rf?.semanticHash
    );

    if (!fileRawEqual) rawFilesEqual = false;
    if (!fileSemanticEqual) {
      semanticEqual = false;
      let reason = '';
      if (!lValid && lf?.error) {
        reason = `Yerel dosya geçersiz (${lf.error})`;
      } else if (!rValid && rf?.error) {
        reason = `GitHub dosyası geçersiz (${rf.error})`;
      } else if (lExists && !rExists) {
        reason = "Yalnızca yerelde mevcut (GitHub'da henüz yok)";
      } else if (rExists && !lExists) {
        reason = "Yalnızca GitHub'da mevcut (yerelde henüz yok)";
      } else if (lRecords !== rRecords) {
        reason = `Kayıt sayısı farklı (Yerel: ${lRecords}, GitHub: ${rRecords})`;
      } else {
        reason = 'Kayıt içerikleri veya özetleri farklı';
      }

      differingFiles.push({
        repoPath,
        category,
        localExists: lExists,
        remoteExists: rExists,
        localValid: lValid,
        remoteValid: rValid,
        localRecords: lRecords,
        remoteRecords: rRecords,
        rawEqual: fileRawEqual,
        semanticEqual: fileSemanticEqual,
        reason,
      });
      reasons.push(`${repoPath}: ${reason}`);
    }
  }

  // Katalog bazında farklı kayıt sayısını doğrudan anahtar farkından hesapla
  const allMovieKeys = new Set([
    ...Object.keys(localBundle.movies),
    ...Object.keys(remoteBundle.movies),
  ]);
  for (const k of allMovieKeys) {
    const lm = localBundle.movies[k];
    const rm = remoteBundle.movies[k];
    if (!lm || !rm) {
      differentRecordsCount++;
    } else {
      const ls = stringifyDeterministic({ ...lm, firstStoredAt: '', lastUpdatedAt: '' });
      const rs = stringifyDeterministic({ ...rm, firstStoredAt: '', lastUpdatedAt: '' });
      if (ls !== rs) differentRecordsCount++;
    }
  }

  const allTvKeys = new Set([
    ...Object.keys(localBundle.tv),
    ...Object.keys(remoteBundle.tv),
  ]);
  for (const k of allTvKeys) {
    const lt = localBundle.tv[k];
    const rt = remoteBundle.tv[k];
    if (!lt || !rt) {
      differentRecordsCount++;
    } else {
      const ls = stringifyDeterministic({ ...lt, firstStoredAt: '', lastUpdatedAt: '' });
      const rs = stringifyDeterministic({ ...rt, firstStoredAt: '', lastUpdatedAt: '' });
      if (ls !== rs) differentRecordsCount++;
    }
  }

  let localOnlyUserItemsCount = 0;
  let remoteOnlyUserItemsCount = 0;
  let conflictingUserItemsCount = 0;
  let userDataConflicts: UserDataConflictItem[] = [];

  if (options.includePersonalFiles) {
    if (localBundle.userData && remoteBundle.userData) {
      const mergePreview = reconcileUserDataDocumentsLossless(
        localBundle.userData,
        remoteBundle.userData
      );
      localOnlyUserItemsCount = mergePreview.addedToRemote;
      remoteOnlyUserItemsCount = mergePreview.addedToLocal;
      userDataConflicts = mergePreview.conflicts;
      conflictingUserItemsCount = mergePreview.conflicts.length;
      differentRecordsCount +=
        localOnlyUserItemsCount + remoteOnlyUserItemsCount + mergePreview.updatedItems;
    } else if (localBundle.userData && !remoteBundle.userData) {
      localOnlyUserItemsCount = localBundle.summary.userUniqueSavedItemsCount;
      differentRecordsCount += localOnlyUserItemsCount;
    } else if (remoteBundle.userData && !localBundle.userData) {
      remoteOnlyUserItemsCount = remoteBundle.summary.userUniqueSavedItemsCount;
      differentRecordsCount += remoteOnlyUserItemsCount;
    }

    const allProfilePaths = new Set([
      ...Object.keys(localBundle.derivedProfiles),
      ...Object.keys(remoteBundle.derivedProfiles),
    ]);
    for (const pPath of allProfilePaths) {
      const ld = localBundle.derivedProfiles[pPath];
      const rd = remoteBundle.derivedProfiles[pPath];
      if (!ld && rd) {
        differentRecordsCount += Object.keys(rd.items || {}).length || 1;
      } else if (ld && !rd) {
        differentRecordsCount += Object.keys(ld.items || {}).length || 1;
      } else if (ld && rd && ld.contentHash !== rd.contentHash) {
        const pKeys = new Set([
          ...Object.keys(ld.items || {}),
          ...Object.keys(rd.items || {}),
        ]);
        let pDiff = 0;
        for (const pk of pKeys) {
          if (stringifyDeterministic(ld.items[pk]) !== stringifyDeterministic(rd.items[pk])) {
            pDiff++;
          }
        }
        differentRecordsCount += Math.max(1, pDiff);
      }
    }
  }

  if (differentRecordsCount === 0 && differingFiles.length > 0) {
    differentRecordsCount = differingFiles.length;
  }

  return {
    semanticEqual,
    rawFilesEqual,
    comparedFilesCount,
    differentFilesCount: differingFiles.length,
    differentRecordsCount,
    differingFiles,
    hasUserDataConflict: localOnlyUserItemsCount > 0 || conflictingUserItemsCount > 0,
    localOnlyUserItemsCount,
    remoteOnlyUserItemsCount,
    conflictingUserItemsCount,
    userDataConflicts,
    reasons,
  };
}

export interface BidirectionalSyncDependencies {
  dataDir: string;
  maxDataBytes?: number;
  store: PersistentDataStore;
  storage?: ReturnType<typeof createDataStorage>;
  getGitHubConfig: () => {
    token?: string;
    owner?: string;
    repo?: string;
    branch: string;
    isPublicRepo: boolean;
  };
  onSyncCompleted?: (info: {
    report: BidirectionalSyncReport;
    lastRemoteSummary: SyncSideSummary | null;
    lastComparison: SyncComparisonSummary | null;
  }) => void;
}

export class GitHubBidirectionalSyncManager {
  private deps: BidirectionalSyncDependencies;
  private activeOperationPromise: Promise<any> | null = null;
  private syncInProgress = false;
  private initialReconcileCompleted = false;

  constructor(deps: BidirectionalSyncDependencies) {
    this.deps = deps;
  }

  public isBusy(): boolean {
    return this.syncInProgress;
  }

  public hasCompletedInitialReconcile(): boolean {
    return this.initialReconcileCompleted;
  }

  private async runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.activeOperationPromise ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        this.syncInProgress = true;
        try {
          return await fn();
        } finally {
          this.syncInProgress = false;
        }
      });
    this.activeOperationPromise = next;
    return next;
  }

  private get maxBytes(): number {
    return this.deps.maxDataBytes ?? DEFAULT_MAX_DATA_BYTES;
  }

  public inspectLocalSide(): ParsedSideBundle {
    const inspectedAt = new Date().toISOString();
    const files: Record<string, SyncFileInspection> = {};
    const errors: SyncErrorRecord[] = [];

    const moviesPath = path.join(this.deps.dataDir, 'catalog', 'movies.json');
    const tvPath = path.join(this.deps.dataDir, 'catalog', 'tv.json');
    const manifestPath = path.join(this.deps.dataDir, 'catalog', 'manifest.json');
    const userDataPath = path.join(this.deps.dataDir, 'cinetrack-data.json');
    const profilesDir = path.join(this.deps.dataDir, 'profiles');

    let movies: Record<string, CatalogRecord> = {};
    let tv: Record<string, CatalogRecord> = {};
    let manifest: CatalogManifest | null = null;
    let userData: DataDocument | null = null;
    const derivedProfiles: Record<string, DerivedProfileDocument> = {};

    if (existsSync(moviesPath)) {
      const raw = readFileSync(moviesPath, 'utf8');
      const res = inspectCatalogRawContent(
        'data/catalog/movies.json',
        raw,
        'movie',
        this.maxBytes
      );
      if (!res.inspection.valid && res.inspection.errorCategory === 'corrupt_remote_json') {
        res.inspection.errorCategory = 'corrupt_local_file';
      }
      files['data/catalog/movies.json'] = res.inspection;
      if (res.parsedMap) movies = res.parsedMap;
      if (!res.inspection.valid && res.inspection.error) {
        errors.push({
          repoPath: 'data/catalog/movies.json',
          category: res.inspection.errorCategory || 'corrupt_local_file',
          message: res.inspection.error,
        });
      }
    } else {
      files['data/catalog/movies.json'] = {
        repoPath: 'data/catalog/movies.json',
        category: 'catalog_movies',
        personal: false,
        exists: false,
        valid: true,
        sizeBytes: 0,
        rawFileHash: null,
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
      };
    }

    if (existsSync(tvPath)) {
      const raw = readFileSync(tvPath, 'utf8');
      const res = inspectCatalogRawContent('data/catalog/tv.json', raw, 'tv', this.maxBytes);
      if (!res.inspection.valid && res.inspection.errorCategory === 'corrupt_remote_json') {
        res.inspection.errorCategory = 'corrupt_local_file';
      }
      files['data/catalog/tv.json'] = res.inspection;
      if (res.parsedMap) tv = res.parsedMap;
      if (!res.inspection.valid && res.inspection.error) {
        errors.push({
          repoPath: 'data/catalog/tv.json',
          category: res.inspection.errorCategory || 'corrupt_local_file',
          message: res.inspection.error,
        });
      }
    } else {
      files['data/catalog/tv.json'] = {
        repoPath: 'data/catalog/tv.json',
        category: 'catalog_tv',
        personal: false,
        exists: false,
        valid: true,
        sizeBytes: 0,
        rawFileHash: null,
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
      };
    }

    let manifestValid = true;
    let manifestMismatchReason: string | undefined;
    if (existsSync(manifestPath)) {
      const raw = readFileSync(manifestPath, 'utf8');
      const res = inspectManifestRawContent(raw, movies, tv, this.maxBytes);
      if (!res.inspection.valid && res.inspection.errorCategory === 'corrupt_remote_json') {
        res.inspection.errorCategory = 'corrupt_local_file';
      }
      files['data/catalog/manifest.json'] = res.inspection;
      manifest = res.manifest || null;
      manifestValid = res.manifestConsistent;
      manifestMismatchReason = res.mismatchReason;
    } else {
      const hasCatalogRecords = Object.keys(movies).length > 0 || Object.keys(tv).length > 0;
      manifestValid = !hasCatalogRecords;
      manifestMismatchReason = hasCatalogRecords
        ? 'Katalog kayıtları var ancak manifest.json eksik'
        : undefined;
      files['data/catalog/manifest.json'] = {
        repoPath: 'data/catalog/manifest.json',
        category: 'catalog_manifest',
        personal: false,
        exists: false,
        valid: !hasCatalogRecords,
        sizeBytes: 0,
        rawFileHash: null,
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        ...(hasCatalogRecords
          ? {
              error: manifestMismatchReason,
              errorCategory: 'schema_mismatch' as const,
            }
          : {}),
      };
    }

    let userRawItems = 0;
    let userUniqueItems = 0;
    if (existsSync(userDataPath)) {
      const raw = readFileSync(userDataPath, 'utf8');
      const res = inspectUserDataRawContent(raw, this.maxBytes);
      if (!res.inspection.valid && res.inspection.errorCategory === 'corrupt_remote_json') {
        res.inspection.errorCategory = 'corrupt_local_file';
      }
      files['data/cinetrack-data.json'] = res.inspection;
      if (res.doc) userData = res.doc;
      userRawItems = res.rawItemsCount;
      userUniqueItems = res.uniqueItemsCount;
      if (!res.inspection.valid && res.inspection.error) {
        errors.push({
          repoPath: 'data/cinetrack-data.json',
          category: res.inspection.errorCategory || 'corrupt_local_file',
          message: res.inspection.error,
        });
      }
    } else {
      files['data/cinetrack-data.json'] = {
        repoPath: 'data/cinetrack-data.json',
        category: 'user_data',
        personal: true,
        exists: false,
        valid: true,
        sizeBytes: 0,
        rawFileHash: null,
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
      };
    }

    let derivedRecordsTotal = 0;
    if (existsSync(profilesDir)) {
      const dirFiles = readdirSync(profilesDir)
        .filter(
          (f) =>
            f.endsWith('.json') &&
            !f.endsWith('.bak.json') &&
            !f.includes('.corrupt.') &&
            !f.endsWith('.tmp')
        )
        .sort((a, b) => a.localeCompare(b));

      for (const fileName of dirFiles) {
        const repoPath = `data/profiles/${fileName}`;
        const fullPath = path.join(profilesDir, fileName);
        const raw = readFileSync(fullPath, 'utf8');
        const res = inspectDerivedProfileRawContent(repoPath, raw, this.maxBytes);
        if (!res.inspection.valid && res.inspection.errorCategory === 'corrupt_remote_json') {
          res.inspection.errorCategory = 'corrupt_local_file';
        }
        files[repoPath] = res.inspection;
        if (res.doc) {
          derivedProfiles[repoPath] = res.doc;
          derivedRecordsTotal += res.inspection.uniqueKeyCount;
        } else if (res.inspection.error) {
          errors.push({
            repoPath,
            category: res.inspection.errorCategory || 'corrupt_local_file',
            message: res.inspection.error,
          });
        }
      }
    }

    const catalogContentHash = computeCatalogManifestContentHash(movies, tv);
    const catalogSemanticHash = hashContent(
      computeCatalogSemanticMapHash(movies) + computeCatalogSemanticMapHash(tv)
    );

    const summary: SyncSideSummary = {
      inspectedAt,
      catalogMovieCount: Object.keys(movies).length,
      catalogTvCount: Object.keys(tv).length,
      catalogRawMovieRecords: files['data/catalog/movies.json']?.recordCount ?? 0,
      catalogRawTvRecords: files['data/catalog/tv.json']?.recordCount ?? 0,
      catalogContentHash,
      catalogSemanticHash,
      manifestPresent: Boolean(files['data/catalog/manifest.json']?.exists),
      manifestValid,
      manifestMovieCount: manifest ? Number(manifest.movieCount) : null,
      manifestTvCount: manifest ? Number(manifest.tvCount) : null,
      manifestContentHash: manifest?.contentHash || null,
      ...(manifestMismatchReason ? { manifestMismatchReason } : {}),
      userDataPresent: Boolean(files['data/cinetrack-data.json']?.exists),
      userProfilesCount: userData?.profiles?.length ?? 0,
      userTotalSavedItemsCount: userRawItems,
      userUniqueSavedItemsCount: userUniqueItems,
      userDataSemanticHash: files['data/cinetrack-data.json']?.semanticHash ?? null,
      userDataRawHash: files['data/cinetrack-data.json']?.rawFileHash ?? null,
      derivedProfileFilesCount: Object.keys(derivedProfiles).length,
      derivedProfileTotalRecordsCount: derivedRecordsTotal,
      files,
    };

    return { summary, movies, tv, manifest, userData, derivedProfiles, errors };
  }

  private async fetchGitBlobBySha(
    sha: string,
    owner: string,
    repo: string,
    token: string
  ): Promise<{ ok: true; content: string } | { ok: false; error: SyncErrorRecord }> {
    const blobUrl = `https://api.github.com/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(sha)}`;
    try {
      const res = await fetch(blobUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'CineTrack-Sync-Agent',
        },
      });
      if (res.status !== 200) {
        const errBody = await res.json().catch(() => ({}));
        const msg = String(errBody?.message || '');
        const category = classifyGitHubHttpStatus(res.status, res.headers, msg);
        return {
          ok: false,
          error: {
            category,
            status: res.status,
            message: redactSecrets(
              `GitHub Git Blob okuma hatası (${category}): HTTP ${res.status}${msg ? ` - ${msg}` : ''}`,
              [token]
            ),
          },
        };
      }
      const blobJson: any = await res.json().catch(() => null);
      if (!isPlainObject(blobJson) || typeof blobJson.content !== 'string') {
        return {
          ok: false,
          error: {
            category: 'malformed_response',
            message: 'GitHub Git Blob yanıtında geçerli base64 içerik bulunamadı.',
          },
        };
      }
      if (typeof blobJson.size === 'number' && blobJson.size > this.maxBytes) {
        return {
          ok: false,
          error: {
            category: 'payload_too_large',
            message: `Uzak dosya boyutu sınırı (${formatMaxDataLimitMb(this.maxBytes)}) aşıyor.`,
          },
        };
      }
      const decoded = Buffer.from(blobJson.content.replace(/\s+/g, ''), 'base64').toString('utf8');
      if (measureUtf8Bytes(decoded) > this.maxBytes) {
        return {
          ok: false,
          error: {
            category: 'payload_too_large',
            message: `Uzak dosya UTF-8 bayt boyutu sınırı (${formatMaxDataLimitMb(this.maxBytes)}) aşıyor.`,
          },
        };
      }
      return { ok: true, content: decoded };
    } catch (err: any) {
      return {
        ok: false,
        error: {
          category: 'network_error',
          message: redactSecrets(
            `GitHub Git Blob ağ hatası: ${err?.message || 'bağlantı kurulamadı'}`,
            [token]
          ),
        },
      };
    }
  }

  private async fetchRemoteFileRaw(
    repoPath: string,
    cfg: { token: string; owner: string; repo: string; branch: string }
  ): Promise<
    | { ok: true; exists: false }
    | { ok: true; exists: true; content: string; sha: string }
    | { ok: false; error: SyncErrorRecord }
  > {
    const apiUrl = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${repoPath}?ref=${encodeURIComponent(
      cfg.branch
    )}`;
    const headers = {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'CineTrack-Sync-Agent',
    };

    try {
      const res = await fetch(apiUrl, { headers });
      if (res.status === 404) {
        // Yalnızca HTTP 404 dosya mevcut değil anlamına gelir
        return { ok: true, exists: false };
      }

      if (res.status === 403) {
        const errBody: any = await res.json().catch(() => ({}));
        const rawMsg = String(errBody?.message || '');
        const isTooLarge =
          Array.isArray(errBody?.errors) &&
          errBody.errors.some((e: any) => e?.code === 'too_large');

        if (isTooLarge) {
          // >1 MB dosyalarda Contents API too_large döndürürse üst dizinden SHA bulup Git Blob API ile indir
          const parentDir = path.posix.dirname(repoPath);
          const baseName = path.posix.basename(repoPath);
          const dirUrl = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${parentDir}?ref=${encodeURIComponent(
            cfg.branch
          )}`;
          const dirRes = await fetch(dirUrl, { headers });
          if (dirRes.status === 200) {
            const list = await dirRes.json().catch(() => null);
            if (Array.isArray(list)) {
              const entry = list.find((it: any) => it && it.name === baseName && typeof it.sha === 'string');
              if (entry) {
                if (typeof entry.size === 'number' && entry.size > this.maxBytes) {
                  return {
                    ok: false,
                    error: {
                      repoPath,
                      category: 'payload_too_large',
                      message: `${repoPath}: Uzak dosya boyutu izin verilen sınırı (${formatMaxDataLimitMb(
                        this.maxBytes
                      )}) aşıyor.`,
                    },
                  };
                }
                const blobRes = await this.fetchGitBlobBySha(
                  entry.sha,
                  cfg.owner,
                  cfg.repo,
                  cfg.token
                );
                if (!blobRes.ok) {
                  return {
                    ok: false,
                    error: { ...blobRes.error, repoPath },
                  };
                }
                return { ok: true, exists: true, content: blobRes.content, sha: entry.sha };
              }
            }
          }
        }

        const category = classifyGitHubHttpStatus(res.status, res.headers, rawMsg);
        return {
          ok: false,
          error: {
            repoPath,
            category,
            status: res.status,
            message: redactSecrets(
              `${repoPath}: GitHub okuma reddedildi (${category}, HTTP 403)${
                rawMsg ? ` - ${rawMsg}` : ''
              }`,
              [cfg.token]
            ),
          },
        };
      }

      if (res.status !== 200) {
        const errBody: any = await res.json().catch(() => ({}));
        const rawMsg = String(errBody?.message || '');
        const category = classifyGitHubHttpStatus(res.status, res.headers, rawMsg);
        return {
          ok: false,
          error: {
            repoPath,
            category,
            status: res.status,
            message: redactSecrets(
              `${repoPath}: GitHub okuma hatası (${category}, HTTP ${res.status})${
                rawMsg ? ` - ${rawMsg}` : ''
              }`,
              [cfg.token]
            ),
          },
        };
      }

      let fileData: any = null;
      try {
        fileData = await res.json();
      } catch {
        return {
          ok: false,
          error: {
            repoPath,
            category: 'malformed_response',
            message: `${repoPath}: GitHub API yanıt zarfı geçerli JSON değil.`,
          },
        };
      }

      if (!isPlainObject(fileData) || typeof fileData.sha !== 'string') {
        return {
          ok: false,
          error: {
            repoPath,
            category: 'malformed_response',
            message: `${repoPath}: GitHub yanıtında geçerli SHA alanı eksik.`,
          },
        };
      }

      if (typeof fileData.size === 'number' && fileData.size > this.maxBytes) {
        return {
          ok: false,
          error: {
            repoPath,
            category: 'payload_too_large',
            message: `${repoPath}: Uzak dosya boyutu (${fileData.size} bayt) izin verilen sınırı (${formatMaxDataLimitMb(
              this.maxBytes
            )}) aşıyor.`,
          },
        };
      }

      let decodedContent: string | undefined;
      if (
        typeof fileData.content === 'string' &&
        fileData.content.length > 0 &&
        fileData.encoding !== 'none'
      ) {
        decodedContent = Buffer.from(fileData.content.replace(/\s+/g, ''), 'base64').toString(
          'utf8'
        );
      } else if (fileData.size === 0 && fileData.content === '') {
        decodedContent = '';
      } else {
        // >1 MB dosyalarda Contents API content="" ve encoding="none" döndürür; Git Blob API ile indir
        const blobRes = await this.fetchGitBlobBySha(
          fileData.sha,
          cfg.owner,
          cfg.repo,
          cfg.token
        );
        if (blobRes.ok) {
          decodedContent = blobRes.content;
        } else if (
          typeof fileData.download_url === 'string' &&
          fileData.download_url.startsWith('https://')
        ) {
          const dlRes = await fetch(fileData.download_url, {
            headers: {
              Authorization: `Bearer ${cfg.token}`,
              'User-Agent': 'CineTrack-Sync-Agent',
            },
          });
          if (dlRes.status === 200) {
            decodedContent = await dlRes.text();
          } else {
            return { ok: false, error: { ...blobRes.error, repoPath } };
          }
        } else {
          return { ok: false, error: { ...blobRes.error, repoPath } };
        }
      }

      if (decodedContent === undefined || (fileData.size > 0 && decodedContent.length === 0)) {
        return {
          ok: false,
          error: {
            repoPath,
            category: 'malformed_response',
            message: `${repoPath}: Uzak dosya içeriği eksik veya kesilmiş döndü.`,
          },
        };
      }

      if (measureUtf8Bytes(decodedContent) > this.maxBytes) {
        return {
          ok: false,
          error: {
            repoPath,
            category: 'payload_too_large',
            message: `${repoPath}: İndirilen UTF-8 boyutu sınırı (${formatMaxDataLimitMb(
              this.maxBytes
            )}) aşıyor.`,
          },
        };
      }

      return { ok: true, exists: true, content: decodedContent, sha: fileData.sha };
    } catch (err: any) {
      return {
        ok: false,
        error: {
          repoPath,
          category: 'network_error',
          message: redactSecrets(
            `${repoPath}: GitHub ağ bağlantı hatası - ${err?.message || 'bağlantı kurulamadı'}`,
            [cfg.token]
          ),
        },
      };
    }
  }

  private async listRemoteProfilePaths(
    cfg: { token: string; owner: string; repo: string; branch: string },
    localHintPaths: string[]
  ): Promise<{ ok: true; paths: string[] } | { ok: false; error: SyncErrorRecord }> {
    const dirUrl = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/data/profiles?ref=${encodeURIComponent(
      cfg.branch
    )}`;
    try {
      const res = await fetch(dirUrl, {
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'CineTrack-Sync-Agent',
        },
      });

      if (res.status === 404) {
        // Dizin listesi yoksa veya mock ortamında yalnızca tekil dosya uçları tanımlıysa yerel ipuçlarını da yokla
        return { ok: true, paths: [...localHintPaths] };
      }

      if (res.status !== 200) {
        const errBody: any = await res.json().catch(() => ({}));
        const rawMsg = String(errBody?.message || '');
        const category = classifyGitHubHttpStatus(res.status, res.headers, rawMsg);
        return {
          ok: false,
          error: {
            repoPath: 'data/profiles',
            category,
            status: res.status,
            message: redactSecrets(
              `data/profiles dizini okunamadı (${category}, HTTP ${res.status})${
                rawMsg ? ` - ${rawMsg}` : ''
              }`,
              [cfg.token]
            ),
          },
        };
      }

      const data = await res.json().catch(() => null);
      if (!Array.isArray(data)) {
        return { ok: true, paths: [...localHintPaths] };
      }

      const discovered = new Set<string>(localHintPaths);
      for (const item of data) {
        if (
          isPlainObject(item) &&
          (item.type === 'file' || !item.type) &&
          typeof item.name === 'string' &&
          /^[a-zA-Z0-9_-]+\.json$/.test(item.name)
        ) {
          discovered.add(`data/profiles/${item.name}`);
        }
      }

      return {
        ok: true,
        paths: Array.from(discovered).sort((a, b) => a.localeCompare(b)),
      };
    } catch (err: any) {
      return {
        ok: false,
        error: {
          repoPath: 'data/profiles',
          category: 'network_error',
          message: redactSecrets(
            `data/profiles ağ hatası: ${err?.message || 'bağlantı kurulamadı'}`,
            [cfg.token]
          ),
        },
      };
    }
  }

  private async inspectRemoteSide(
    cfg: { token: string; owner: string; repo: string; branch: string },
    options: { includePersonalFiles: boolean; localProfilePaths: string[] }
  ): Promise<{
    bundle: ParsedSideBundle;
    rawRemoteContents: Record<string, { content: string; sha: string }>;
    transportFailed: boolean;
  }> {
    const inspectedAt = new Date().toISOString();
    const files: Record<string, SyncFileInspection> = {};
    const errors: SyncErrorRecord[] = [];
    const rawRemoteContents: Record<string, { content: string; sha: string }> = {};
    let transportFailed = false;

    let movies: Record<string, CatalogRecord> = {};
    let tv: Record<string, CatalogRecord> = {};
    let manifest: CatalogManifest | null = null;
    let userData: DataDocument | null = null;
    const derivedProfiles: Record<string, DerivedProfileDocument> = {};

    // 1. movies.json
    const moviesRes = await this.fetchRemoteFileRaw('data/catalog/movies.json', cfg);
    if (!moviesRes.ok) {
      transportFailed = true;
      errors.push(moviesRes.error);
      files['data/catalog/movies.json'] = {
        repoPath: 'data/catalog/movies.json',
        category: 'catalog_movies',
        personal: false,
        exists: false,
        valid: false,
        sizeBytes: 0,
        rawFileHash: null,
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        error: moviesRes.error.message,
        errorCategory: moviesRes.error.category,
      };
    } else if (!moviesRes.exists) {
      files['data/catalog/movies.json'] = {
        repoPath: 'data/catalog/movies.json',
        category: 'catalog_movies',
        personal: false,
        exists: false,
        valid: true,
        sizeBytes: 0,
        rawFileHash: null,
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
      };
    } else {
      rawRemoteContents['data/catalog/movies.json'] = {
        content: moviesRes.content,
        sha: moviesRes.sha,
      };
      const inspected = inspectCatalogRawContent(
        'data/catalog/movies.json',
        moviesRes.content,
        'movie',
        this.maxBytes,
        moviesRes.sha
      );
      files['data/catalog/movies.json'] = inspected.inspection;
      if (inspected.parsedMap) movies = inspected.parsedMap;
      if (!inspected.inspection.valid && inspected.inspection.error) {
        errors.push({
          repoPath: 'data/catalog/movies.json',
          category: inspected.inspection.errorCategory || 'corrupt_remote_json',
          message: `data/catalog/movies.json: ${inspected.inspection.error}`,
        });
      }
    }

    // 2. tv.json
    const tvRes = await this.fetchRemoteFileRaw('data/catalog/tv.json', cfg);
    if (!tvRes.ok) {
      transportFailed = true;
      errors.push(tvRes.error);
      files['data/catalog/tv.json'] = {
        repoPath: 'data/catalog/tv.json',
        category: 'catalog_tv',
        personal: false,
        exists: false,
        valid: false,
        sizeBytes: 0,
        rawFileHash: null,
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        error: tvRes.error.message,
        errorCategory: tvRes.error.category,
      };
    } else if (!tvRes.exists) {
      files['data/catalog/tv.json'] = {
        repoPath: 'data/catalog/tv.json',
        category: 'catalog_tv',
        personal: false,
        exists: false,
        valid: true,
        sizeBytes: 0,
        rawFileHash: null,
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
      };
    } else {
      rawRemoteContents['data/catalog/tv.json'] = { content: tvRes.content, sha: tvRes.sha };
      const inspected = inspectCatalogRawContent(
        'data/catalog/tv.json',
        tvRes.content,
        'tv',
        this.maxBytes,
        tvRes.sha
      );
      files['data/catalog/tv.json'] = inspected.inspection;
      if (inspected.parsedMap) tv = inspected.parsedMap;
      if (!inspected.inspection.valid && inspected.inspection.error) {
        errors.push({
          repoPath: 'data/catalog/tv.json',
          category: inspected.inspection.errorCategory || 'corrupt_remote_json',
          message: `data/catalog/tv.json: ${inspected.inspection.error}`,
        });
      }
    }

    // 3. manifest.json
    let manifestValid = true;
    let manifestMismatchReason: string | undefined;
    const manifestRes = await this.fetchRemoteFileRaw('data/catalog/manifest.json', cfg);
    if (!manifestRes.ok) {
      transportFailed = true;
      errors.push(manifestRes.error);
      manifestValid = false;
      files['data/catalog/manifest.json'] = {
        repoPath: 'data/catalog/manifest.json',
        category: 'catalog_manifest',
        personal: false,
        exists: false,
        valid: false,
        sizeBytes: 0,
        rawFileHash: null,
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        error: manifestRes.error.message,
        errorCategory: manifestRes.error.category,
      };
    } else if (!manifestRes.exists) {
      const hasRemoteCatalog = Object.keys(movies).length > 0 || Object.keys(tv).length > 0;
      manifestValid = !hasRemoteCatalog;
      manifestMismatchReason = hasRemoteCatalog
        ? "GitHub'da katalog dosyaları mevcut ancak manifest.json eksik"
        : undefined;
      files['data/catalog/manifest.json'] = {
        repoPath: 'data/catalog/manifest.json',
        category: 'catalog_manifest',
        personal: false,
        exists: false,
        valid: !hasRemoteCatalog,
        sizeBytes: 0,
        rawFileHash: null,
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        ...(hasRemoteCatalog
          ? {
              error: manifestMismatchReason,
              errorCategory: 'schema_mismatch' as const,
            }
          : {}),
      };
    } else {
      rawRemoteContents['data/catalog/manifest.json'] = {
        content: manifestRes.content,
        sha: manifestRes.sha,
      };
      const inspected = inspectManifestRawContent(
        manifestRes.content,
        movies,
        tv,
        this.maxBytes,
        manifestRes.sha
      );
      files['data/catalog/manifest.json'] = inspected.inspection;
      manifest = inspected.manifest || null;
      manifestValid = inspected.manifestConsistent;
      manifestMismatchReason = inspected.mismatchReason;
    }

    // 4. Kişisel veriler (yalnızca özel depoda okunur/yazılır)
    let userRawItems = 0;
    let userUniqueItems = 0;
    let derivedRecordsTotal = 0;

    if (options.includePersonalFiles) {
      const userRes = await this.fetchRemoteFileRaw('data/cinetrack-data.json', cfg);
      if (!userRes.ok) {
        transportFailed = true;
        errors.push(userRes.error);
        files['data/cinetrack-data.json'] = {
          repoPath: 'data/cinetrack-data.json',
          category: 'user_data',
          personal: true,
          exists: false,
          valid: false,
          sizeBytes: 0,
          rawFileHash: null,
          semanticHash: null,
          recordCount: 0,
          uniqueKeyCount: 0,
          error: userRes.error.message,
          errorCategory: userRes.error.category,
        };
      } else if (!userRes.exists) {
        files['data/cinetrack-data.json'] = {
          repoPath: 'data/cinetrack-data.json',
          category: 'user_data',
          personal: true,
          exists: false,
          valid: true,
          sizeBytes: 0,
          rawFileHash: null,
          semanticHash: null,
          recordCount: 0,
          uniqueKeyCount: 0,
        };
      } else {
        rawRemoteContents['data/cinetrack-data.json'] = {
          content: userRes.content,
          sha: userRes.sha,
        };
        const inspected = inspectUserDataRawContent(
          userRes.content,
          this.maxBytes,
          userRes.sha
        );
        files['data/cinetrack-data.json'] = inspected.inspection;
        if (inspected.doc) userData = inspected.doc;
        userRawItems = inspected.rawItemsCount;
        userUniqueItems = inspected.uniqueItemsCount;
        if (!inspected.inspection.valid && inspected.inspection.error) {
          errors.push({
            repoPath: 'data/cinetrack-data.json',
            category: inspected.inspection.errorCategory || 'corrupt_remote_json',
            message: `data/cinetrack-data.json: ${inspected.inspection.error}`,
          });
        }
      }

      const dirListRes = await this.listRemoteProfilePaths(cfg, options.localProfilePaths);
      if (!dirListRes.ok) {
        transportFailed = true;
        errors.push(dirListRes.error);
      } else {
        for (const repoPath of dirListRes.paths) {
          const profRes = await this.fetchRemoteFileRaw(repoPath, cfg);
          if (!profRes.ok) {
            transportFailed = true;
            errors.push(profRes.error);
            files[repoPath] = {
              repoPath,
              category: 'derived_profile',
              personal: true,
              exists: false,
              valid: false,
              sizeBytes: 0,
              rawFileHash: null,
              semanticHash: null,
              recordCount: 0,
              uniqueKeyCount: 0,
              error: profRes.error.message,
              errorCategory: profRes.error.category,
            };
          } else if (profRes.exists) {
            rawRemoteContents[repoPath] = { content: profRes.content, sha: profRes.sha };
            const inspected = inspectDerivedProfileRawContent(
              repoPath,
              profRes.content,
              this.maxBytes,
              profRes.sha
            );
            files[repoPath] = inspected.inspection;
            if (inspected.doc) {
              derivedProfiles[repoPath] = inspected.doc;
              derivedRecordsTotal += inspected.inspection.uniqueKeyCount;
            } else if (inspected.inspection.error) {
              errors.push({
                repoPath,
                category: inspected.inspection.errorCategory || 'corrupt_remote_json',
                message: `${repoPath}: ${inspected.inspection.error}`,
              });
            }
          }
        }
      }
    }

    const catalogContentHash = computeCatalogManifestContentHash(movies, tv);
    const catalogSemanticHash = hashContent(
      computeCatalogSemanticMapHash(movies) + computeCatalogSemanticMapHash(tv)
    );

    const summary: SyncSideSummary = {
      inspectedAt,
      catalogMovieCount: Object.keys(movies).length,
      catalogTvCount: Object.keys(tv).length,
      catalogRawMovieRecords: files['data/catalog/movies.json']?.recordCount ?? 0,
      catalogRawTvRecords: files['data/catalog/tv.json']?.recordCount ?? 0,
      catalogContentHash,
      catalogSemanticHash,
      manifestPresent: Boolean(files['data/catalog/manifest.json']?.exists),
      manifestValid,
      manifestMovieCount: manifest ? Number(manifest.movieCount) : null,
      manifestTvCount: manifest ? Number(manifest.tvCount) : null,
      manifestContentHash: manifest?.contentHash || null,
      ...(manifestMismatchReason ? { manifestMismatchReason } : {}),
      userDataPresent: Boolean(files['data/cinetrack-data.json']?.exists),
      userProfilesCount: userData?.profiles?.length ?? 0,
      userTotalSavedItemsCount: userRawItems,
      userUniqueSavedItemsCount: userUniqueItems,
      userDataSemanticHash: files['data/cinetrack-data.json']?.semanticHash ?? null,
      userDataRawHash: files['data/cinetrack-data.json']?.rawFileHash ?? null,
      derivedProfileFilesCount: Object.keys(derivedProfiles).length,
      derivedProfileTotalRecordsCount: derivedRecordsTotal,
      files,
    };

    return {
      bundle: { summary, movies, tv, manifest, userData, derivedProfiles, errors },
      rawRemoteContents,
      transportFailed,
    };
  }

  private createUnconfiguredReport(
    operation: SyncOperationKind,
    startedAt: string,
    localBefore: SyncSideSummary,
    isPublicRepo: boolean,
    remoteTarget?: { owner: string; repo: string; branch: string }
  ): BidirectionalSyncReport {
    return {
      ok: false,
      partialFailure: false,
      operation,
      startedAt,
      completedAt: new Date().toISOString(),
      remoteTarget,
      isPublicRepo,
      localBefore,
      remoteBefore: null,
      localAfter: localBefore,
      remoteAfter: null,
      comparison: null,
      filesDownloaded: [],
      filesUploaded: [],
      filesUnchanged: [],
      filesMerged: [],
      filesFailed: [],
      filesPending: [],
      filesBlockedPublic: [],
      recordsAdded: 0,
      recordsUpdated: 0,
      recordsConflicted: 0,
      conflicts: [],
      warnings: [],
      errors: [
        {
          category: 'config_error',
          message: 'GitHub senkronizasyonu için token, sahip (owner) ve depo (repo) ayarları eksik.',
        },
      ],
      verifiedEqual: false,
    };
  }

  private isDerivedDocFreshForContext(
    doc: DerivedProfileDocument,
    expectedCatalogHash: string,
    matchingProfile?: Profile
  ): { valid: boolean; reason?: string } {
    if (Number(doc.schemaVersion) !== DERIVED_PROFILE_SCHEMA_VERSION) {
      return {
        valid: false,
        reason: `Şema sürümü eski (${doc.schemaVersion} != ${DERIVED_PROFILE_SCHEMA_VERSION})`,
      };
    }
    if (doc.algorithmVersion !== ALGORITHM_VERSION) {
      return {
        valid: false,
        reason: `Algoritma sürümü farklı (${doc.algorithmVersion} != ${ALGORITHM_VERSION})`,
      };
    }
    if (doc.sourceCatalogHash && expectedCatalogHash && doc.sourceCatalogHash !== expectedCatalogHash) {
      return {
        valid: false,
        reason: 'Kaynak katalog içerik özeti güncel katalogla uyuşmuyor',
      };
    }
    if (matchingProfile) {
      const expectedFp = computeTasteProfileSignature(
        matchingProfile.items || [],
        matchingProfile.preferences,
        matchingProfile.favoriteActors || [],
        { targetType: 'all', algorithmVersion: ALGORITHM_VERSION }
      );
      if (doc.profileFingerprint !== expectedFp) {
        return {
          valid: false,
          reason: 'Profil imzası (profileFingerprint) güncel kullanıcı tercihleriyle uyuşmuyor',
        };
      }
    }
    return { valid: true };
  }

  /**
   * 1. INSPECT: Hiçbir yerel veya uzak veriyi değiştirmeden GitHub dosyalarını inceler,
   * kayıt sayılarını, ham dosya ve semantik içerik hash'lerini karşılaştırır.
   */
  public async inspect(): Promise<BidirectionalSyncReport> {
    return this.runSerialized(async () => {
      const startedAt = new Date().toISOString();
      const cfg = this.deps.getGitHubConfig();
      const localBefore = this.inspectLocalSide();
      const remoteTarget =
        cfg.owner && cfg.repo
          ? { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch }
          : undefined;

      if (!cfg.token || !cfg.owner || !cfg.repo) {
        return this.createUnconfiguredReport(
          'inspect',
          startedAt,
          localBefore.summary,
          cfg.isPublicRepo,
          remoteTarget
        );
      }

      const visibility = await this.deps.store.verifyRemoteRepoVisibility();
      const includePersonal = !visibility.effectiveIsPublicRepo;
      const localProfilePaths = Object.keys(localBefore.derivedProfiles);

      const remoteInspect = await this.inspectRemoteSide(
        { token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch },
        { includePersonalFiles: includePersonal, localProfilePaths }
      );

      const warnings: string[] = [];
      if (visibility.warning) warnings.push(visibility.warning);
      if (localBefore.summary.manifestMismatchReason) {
        warnings.push(`Yerel manifest: ${localBefore.summary.manifestMismatchReason}`);
      }
      if (remoteInspect.bundle.summary.manifestMismatchReason) {
        warnings.push(`GitHub manifest: ${remoteInspect.bundle.summary.manifestMismatchReason}`);
      }

      const allErrors: SyncErrorRecord[] = [
        ...localBefore.errors,
        ...remoteInspect.bundle.errors,
      ];

      const comparison = compareSyncSides(localBefore, remoteInspect.bundle, {
        includePersonalFiles: includePersonal,
      });

      const ok = !remoteInspect.transportFailed && allErrors.length === 0;
      const verifiedEqual = ok && comparison.semanticEqual;

      const report: BidirectionalSyncReport = {
        ok,
        partialFailure: false,
        operation: 'inspect',
        startedAt,
        completedAt: new Date().toISOString(),
        remoteTarget,
        isPublicRepo: visibility.effectiveIsPublicRepo,
        ...(visibility.warning ? { repoVisibilityWarning: visibility.warning } : {}),
        localBefore: localBefore.summary,
        remoteBefore: remoteInspect.bundle.summary,
        localAfter: localBefore.summary,
        remoteAfter: remoteInspect.bundle.summary,
        comparison,
        filesDownloaded: [],
        filesUploaded: [],
        filesUnchanged: comparison.differingFiles.length === 0
          ? Object.keys(localBefore.summary.files).filter(
              (p) => localBefore.summary.files[p]?.exists
            )
          : [],
        filesMerged: [],
        filesFailed: allErrors.map((e) => e.repoPath).filter(Boolean) as string[],
        filesPending: comparison.differingFiles.map((d) => d.repoPath),
        filesBlockedPublic: includePersonal ? [] : ['data/cinetrack-data.json', 'data/profiles/*'],
        recordsAdded: 0,
        recordsUpdated: 0,
        recordsConflicted: comparison.conflictingUserItemsCount,
        conflicts: comparison.userDataConflicts,
        warnings,
        errors: allErrors,
        verifiedEqual,
      };

      this.deps.onSyncCompleted?.({
        report,
        lastRemoteSummary: remoteInspect.bundle.summary,
        lastComparison: comparison,
      });

      return report;
    });
  }

  /**
   * 2. PULL: GitHub'daki dosyaları şema ve boyut kontrolünden geçirerek güvenli biçimde yerel depoya indirir.
   * Yerelde farklı kullanıcı verisi varsa sessizce ezmez; varsayılan olarak onay ister veya kayıpsız birleştirir.
   */
  public async pull(
    options: { conflictStrategy?: 'ask' | 'merge' | 'overwrite_with_remote' } = {}
  ): Promise<BidirectionalSyncReport> {
    return this.runSerialized(async () => {
      const conflictStrategy = options.conflictStrategy || 'ask';
      const startedAt = new Date().toISOString();
      const cfg = this.deps.getGitHubConfig();
      const localBefore = this.inspectLocalSide();
      const remoteTarget =
        cfg.owner && cfg.repo
          ? { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch }
          : undefined;

      if (!cfg.token || !cfg.owner || !cfg.repo) {
        return this.createUnconfiguredReport(
          'pull',
          startedAt,
          localBefore.summary,
          cfg.isPublicRepo,
          remoteTarget
        );
      }

      const visibility = await this.deps.store.verifyRemoteRepoVisibility();
      const includePersonal = !visibility.effectiveIsPublicRepo;
      const localProfilePaths = Object.keys(localBefore.derivedProfiles);

      const remoteInspect = await this.inspectRemoteSide(
        { token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch },
        { includePersonalFiles: includePersonal, localProfilePaths }
      );

      if (remoteInspect.transportFailed) {
        const report: BidirectionalSyncReport = {
          ok: false,
          partialFailure: false,
          operation: 'pull',
          startedAt,
          completedAt: new Date().toISOString(),
          remoteTarget,
          isPublicRepo: visibility.effectiveIsPublicRepo,
          ...(visibility.warning ? { repoVisibilityWarning: visibility.warning } : {}),
          localBefore: localBefore.summary,
          remoteBefore: remoteInspect.bundle.summary,
          localAfter: localBefore.summary,
          remoteAfter: remoteInspect.bundle.summary,
          comparison: null,
          filesDownloaded: [],
          filesUploaded: [],
          filesUnchanged: [],
          filesMerged: [],
          filesFailed: remoteInspect.bundle.errors
            .map((e) => e.repoPath)
            .filter(Boolean) as string[],
          filesPending: [],
          filesBlockedPublic: includePersonal ? [] : ['data/cinetrack-data.json', 'data/profiles/*'],
          recordsAdded: 0,
          recordsUpdated: 0,
          recordsConflicted: 0,
          conflicts: [],
          warnings: visibility.warning ? [visibility.warning] : [],
          errors: remoteInspect.bundle.errors,
          verifiedEqual: false,
        };
        this.deps.onSyncCompleted?.({
          report,
          lastRemoteSummary: remoteInspect.bundle.summary,
          lastComparison: null,
        });
        return report;
      }

      const initialComparison = compareSyncSides(localBefore, remoteInspect.bundle, {
        includePersonalFiles: includePersonal,
      });

      // Yerel kullanıcı verisini sessizce ezme koruması (Spec Bölüm 4.8)
      const localHasLiveUserItems = Boolean(
        localBefore.userData &&
          localBefore.userData.profiles.some(
            (p) => !p.isDemo && Array.isArray(p.items) && p.items.length > 0
          )
      );
      const remoteHasValidUserData = Boolean(
        includePersonal &&
          remoteInspect.bundle.summary.files['data/cinetrack-data.json']?.exists &&
          remoteInspect.bundle.summary.files['data/cinetrack-data.json']?.valid &&
          remoteInspect.bundle.userData
      );

      if (
        conflictStrategy === 'ask' &&
        localHasLiveUserItems &&
        remoteHasValidUserData &&
        localBefore.summary.userDataSemanticHash !==
          remoteInspect.bundle.summary.userDataSemanticHash &&
        (initialComparison.localOnlyUserItemsCount > 0 ||
          initialComparison.conflictingUserItemsCount > 0)
      ) {
        const conflictSummary: PullConflictSummary = {
          localProfilesCount: localBefore.summary.userProfilesCount,
          remoteProfilesCount: remoteInspect.bundle.summary.userProfilesCount,
          localItemsCount: localBefore.summary.userUniqueSavedItemsCount,
          remoteItemsCount: remoteInspect.bundle.summary.userUniqueSavedItemsCount,
          localOnlyItemsCount: initialComparison.localOnlyUserItemsCount,
          conflictingItemsCount: initialComparison.conflictingUserItemsCount,
          message: `Yerelde GitHub'da bulunmayan ${initialComparison.localOnlyUserItemsCount} kayıt ve ${initialComparison.conflictingUserItemsCount} farklı düzenlenmiş kayıt tespit edildi. Yerel verinizin ezilmemesi için "Kayıpsız Birleştir" seçeneğini kullanın veya yedek alarak üzerine yazmayı onaylayın.`,
        };

        const askReport: BidirectionalSyncReport = {
          ok: false,
          partialFailure: false,
          requiresConfirmation: true,
          conflictSummary,
          operation: 'pull',
          startedAt,
          completedAt: new Date().toISOString(),
          remoteTarget,
          isPublicRepo: visibility.effectiveIsPublicRepo,
          ...(visibility.warning ? { repoVisibilityWarning: visibility.warning } : {}),
          localBefore: localBefore.summary,
          remoteBefore: remoteInspect.bundle.summary,
          localAfter: localBefore.summary,
          remoteAfter: remoteInspect.bundle.summary,
          comparison: initialComparison,
          filesDownloaded: [],
          filesUploaded: [],
          filesUnchanged: [],
          filesMerged: [],
          filesFailed: [],
          filesPending: initialComparison.differingFiles.map((d) => d.repoPath),
          filesBlockedPublic: includePersonal ? [] : ['data/cinetrack-data.json', 'data/profiles/*'],
          recordsAdded: 0,
          recordsUpdated: 0,
          recordsConflicted: initialComparison.conflictingUserItemsCount,
          conflicts: initialComparison.userDataConflicts,
          warnings: [conflictSummary.message],
          errors: [],
          verifiedEqual: false,
        };
        return askReport;
      }

      // İşlemden önce yerel verinin döner yedeğini al (Spec Bölüm 4.7)
      if (this.deps.storage) {
        await this.deps.storage.createSafetySnapshotSerialized();
      }

      const filesDownloaded: string[] = [];
      const filesUnchanged: string[] = [];
      const filesMerged: string[] = [];
      const filesFailed: string[] = [];
      const warnings: string[] = [];
      const errors: SyncErrorRecord[] = [];
      const conflicts: UserDataConflictItem[] = [];
      let recordsAdded = 0;
      let recordsUpdated = 0;
      let updatedDataDocument: DataDocument | undefined;
      let serverRevision: number | undefined;

      if (visibility.warning) warnings.push(visibility.warning);

      // Katalog dosyalarını uygula (sağlam olanları atomik yaz, bozuk uzak dosyada yereli koru!)
      let finalMovies = localBefore.movies;
      const rMoviesInfo = remoteInspect.bundle.summary.files['data/catalog/movies.json'];
      if (rMoviesInfo?.exists) {
        if (!rMoviesInfo.valid) {
          filesFailed.push('data/catalog/movies.json');
          errors.push({
            repoPath: 'data/catalog/movies.json',
            category: rMoviesInfo.errorCategory || 'corrupt_remote_json',
            message: `data/catalog/movies.json bozuk olduğu için yerel sağlam dosya korundu (${rMoviesInfo.error}).`,
          });
        } else {
          const remoteMovies = remoteInspect.bundle.movies;
          if (
            localBefore.summary.files['data/catalog/movies.json']?.exists &&
            localBefore.summary.files['data/catalog/movies.json']?.semanticHash ===
              rMoviesInfo.semanticHash
          ) {
            filesUnchanged.push('data/catalog/movies.json');
          } else {
            // Varsayılan silmesiz politika: yereldeki kayıtları da silmeden uzak kayıtlarla birleştir veya uygula
            const mergedMovies =
              conflictStrategy === 'overwrite_with_remote'
                ? {
                    merged: remoteMovies,
                    addedToLocal: Math.max(
                      0,
                      Object.keys(remoteMovies).length - Object.keys(localBefore.movies).length
                    ),
                    updatedLocal: 0,
                  }
                : mergeCatalogMapsLossless(localBefore.movies, remoteMovies, 'movie');
            finalMovies = mergedMovies.merged;
            const moviesPath = path.join(this.deps.dataDir, 'catalog', 'movies.json');
            writeJsonFileAtomic(moviesPath, stringifyDeterministic(finalMovies), {
              backupPath: `${moviesPath}.bak`,
              validateParsed: isPlainObject,
            });
            filesDownloaded.push('data/catalog/movies.json');
            recordsAdded += mergedMovies.addedToLocal;
            recordsUpdated += mergedMovies.updatedLocal;
          }
        }
      }

      let finalTv = localBefore.tv;
      const rTvInfo = remoteInspect.bundle.summary.files['data/catalog/tv.json'];
      if (rTvInfo?.exists) {
        if (!rTvInfo.valid) {
          filesFailed.push('data/catalog/tv.json');
          errors.push({
            repoPath: 'data/catalog/tv.json',
            category: rTvInfo.errorCategory || 'corrupt_remote_json',
            message: `data/catalog/tv.json bozuk olduğu için yerel sağlam dosya korundu (${rTvInfo.error}).`,
          });
        } else {
          const remoteTv = remoteInspect.bundle.tv;
          if (
            localBefore.summary.files['data/catalog/tv.json']?.exists &&
            localBefore.summary.files['data/catalog/tv.json']?.semanticHash === rTvInfo.semanticHash
          ) {
            filesUnchanged.push('data/catalog/tv.json');
          } else {
            const mergedTv =
              conflictStrategy === 'overwrite_with_remote'
                ? {
                    merged: remoteTv,
                    addedToLocal: Math.max(
                      0,
                      Object.keys(remoteTv).length - Object.keys(localBefore.tv).length
                    ),
                    updatedLocal: 0,
                  }
                : mergeCatalogMapsLossless(localBefore.tv, remoteTv, 'tv');
            finalTv = mergedTv.merged;
            const tvPath = path.join(this.deps.dataDir, 'catalog', 'tv.json');
            writeJsonFileAtomic(tvPath, stringifyDeterministic(finalTv), {
              backupPath: `${tvPath}.bak`,
              validateParsed: isPlainObject,
            });
            filesDownloaded.push('data/catalog/tv.json');
            recordsAdded += mergedTv.addedToLocal;
            recordsUpdated += mergedTv.updatedLocal;
          }
        }
      }

      // Manifest doğrulaması ve yerel manifest güncellemesi
      const rManifestInfo = remoteInspect.bundle.summary.files['data/catalog/manifest.json'];
      if (rManifestInfo?.exists && !rManifestInfo.valid) {
        warnings.push(
          `GitHub manifest.json tutarsız bulundu (${rManifestInfo.error}); yerel manifest gerçek katalog sayılarıyla doğrulandı.`
        );
      }
      const computedCatalogHash = computeCatalogManifestContentHash(finalMovies, finalTv);
      const manifestPath = path.join(this.deps.dataDir, 'catalog', 'manifest.json');
      const existingLocalManifest = localBefore.manifest;
      if (
        existingLocalManifest &&
        existingLocalManifest.movieCount === Object.keys(finalMovies).length &&
        existingLocalManifest.tvCount === Object.keys(finalTv).length &&
        existingLocalManifest.contentHash === computedCatalogHash
      ) {
        if (rManifestInfo?.exists && rManifestInfo.valid) {
          filesUnchanged.push('data/catalog/manifest.json');
        }
      } else if (Object.keys(finalMovies).length > 0 || Object.keys(finalTv).length > 0 || rManifestInfo?.exists) {
        const nextManifest: CatalogManifest = {
          version: 1,
          updatedAt:
            remoteInspect.bundle.manifest?.contentHash === computedCatalogHash &&
            remoteInspect.bundle.manifest?.updatedAt
              ? remoteInspect.bundle.manifest.updatedAt
              : new Date().toISOString(),
          movieCount: Object.keys(finalMovies).length,
          tvCount: Object.keys(finalTv).length,
          contentHash: computedCatalogHash,
        };
        writeJsonFileAtomic(manifestPath, stringifyDeterministic(nextManifest), {
          backupPath: `${manifestPath}.bak`,
          validateParsed: isPlainObject,
        });
        if (rManifestInfo?.exists && rManifestInfo.valid) {
          filesDownloaded.push('data/catalog/manifest.json');
        }
      }

      // Kişisel dosyalar (cinetrack-data.json ve data/profiles/*.json)
      let finalUserData = localBefore.userData;
      if (includePersonal) {
        const rUserInfo = remoteInspect.bundle.summary.files['data/cinetrack-data.json'];
        if (rUserInfo?.exists) {
          if (!rUserInfo.valid || !remoteInspect.bundle.userData) {
            filesFailed.push('data/cinetrack-data.json');
            errors.push({
              repoPath: 'data/cinetrack-data.json',
              category: rUserInfo.errorCategory || 'corrupt_remote_json',
              message: `data/cinetrack-data.json bozuk olduğu için yerel kullanıcı verisi korundu (${rUserInfo.error}).`,
            });
          } else if (
            localBefore.summary.userDataPresent &&
            localBefore.summary.userDataSemanticHash === rUserInfo.semanticHash
          ) {
            filesUnchanged.push('data/cinetrack-data.json');
          } else {
            let docToWrite: DataDocument;
            if (
              conflictStrategy === 'merge' &&
              localBefore.userData &&
              localBefore.userData.profiles.length > 0
            ) {
              const mergedUser = reconcileUserDataDocumentsLossless(
                localBefore.userData,
                remoteInspect.bundle.userData
              );
              docToWrite = mergedUser.mergedDoc;
              recordsAdded += mergedUser.addedToLocal;
              recordsUpdated += mergedUser.updatedItems;
              conflicts.push(...mergedUser.conflicts);
              filesMerged.push('data/cinetrack-data.json');
            } else {
              docToWrite = remoteInspect.bundle.userData;
              recordsAdded += remoteInspect.bundle.summary.userUniqueSavedItemsCount;
            }

            if (this.deps.storage) {
              const saveRes = await this.deps.storage.applySyncedDocumentSerialized(docToWrite);
              if (saveRes.ok) {
                finalUserData = saveRes.document;
                updatedDataDocument = saveRes.document;
                serverRevision = saveRes.document.revision;
                filesDownloaded.push('data/cinetrack-data.json');
              } else {
                filesFailed.push('data/cinetrack-data.json');
                errors.push({
                  repoPath: 'data/cinetrack-data.json',
                  category: 'corrupt_local_file',
                  message: saveRes.message,
                });
              }
            } else {
              const userDataPath = path.join(this.deps.dataDir, 'cinetrack-data.json');
              writeJsonFileAtomic(userDataPath, JSON.stringify(docToWrite, null, 2), {
                backupPath: `${this.deps.dataDir}/cinetrack-data.bak.json`,
                validateParsed: isPlainObject,
              });
              finalUserData = docToWrite;
              updatedDataDocument = docToWrite;
              filesDownloaded.push('data/cinetrack-data.json');
            }
          }
        }

        // data/profiles/*.json indirme ve doğrulama
        for (const [repoPath, rFileInfo] of Object.entries(remoteInspect.bundle.summary.files)) {
          if (rFileInfo.category !== 'derived_profile' || !rFileInfo.exists) continue;
          if (!rFileInfo.valid) {
            filesFailed.push(repoPath);
            errors.push({
              repoPath,
              category: rFileInfo.errorCategory || 'corrupt_remote_json',
              message: `${repoPath} bozuk olduğu için yerel dosya korundu (${rFileInfo.error}).`,
            });
            continue;
          }
          const remoteProfDoc = remoteInspect.bundle.derivedProfiles[repoPath];
          if (!remoteProfDoc) continue;

          const matchingProfile = finalUserData?.profiles?.find(
            (p) => p.id === remoteProfDoc.profileId
          );
          const freshness = this.isDerivedDocFreshForContext(
            remoteProfDoc,
            computedCatalogHash,
            matchingProfile
          );
          if (!freshness.valid) {
            warnings.push(
              `${repoPath}: Uzak türetilmiş profil eski/uyumsuz olduğu için geçerli sayılmadı (${freshness.reason}).`
            );
            if (matchingProfile) {
              const regenerated = buildFreshDerivedProfileDocumentOnServer(
                matchingProfile,
                finalMovies,
                finalTv,
                computedCatalogHash
              );
              const targetFile = this.deps.store.getProfileFilePath(matchingProfile.id);
              writeJsonFileAtomic(targetFile, stringifyDeterministic(regenerated), {
                backupPath: `${targetFile}.bak`,
                validateParsed: isPlainObject,
              });
            }
            continue;
          }

          const localProfInfo = localBefore.summary.files[repoPath];
          if (localProfInfo?.exists && localProfInfo.semanticHash === rFileInfo.semanticHash) {
            filesUnchanged.push(repoPath);
            continue;
          }

          const safeFileName = `${sanitizeProfileId(remoteProfDoc.profileId)}.json`;
          const targetPath = path.join(this.deps.dataDir, 'profiles', safeFileName);
          mkdirSync(path.dirname(targetPath), { recursive: true });
          writeJsonFileAtomic(targetPath, stringifyDeterministic(remoteProfDoc), {
            backupPath: `${targetPath}.bak`,
            validateParsed: isPlainObject,
          });
          filesDownloaded.push(repoPath);
          recordsAdded += Object.keys(remoteProfDoc.items || {}).length;
        }
      }

      // Yeniden yerel durumu oku ve gerçek uzak durumla karşılaştır (Spec Bölüm 4.9 & Bölüm 7)
      const localAfter = this.inspectLocalSide();
      const postComparison = compareSyncSides(localAfter, remoteInspect.bundle, {
        includePersonalFiles: includePersonal,
      });

      const ok = errors.length === 0 && localAfter.errors.length === 0;
      const partialFailure =
        !ok && (filesDownloaded.length > 0 || filesUnchanged.length > 0) && filesFailed.length > 0;
      const verifiedEqual = ok && postComparison.semanticEqual;

      const report: BidirectionalSyncReport = {
        ok,
        partialFailure,
        operation: 'pull',
        startedAt,
        completedAt: new Date().toISOString(),
        remoteTarget,
        isPublicRepo: visibility.effectiveIsPublicRepo,
        ...(visibility.warning ? { repoVisibilityWarning: visibility.warning } : {}),
        localBefore: localBefore.summary,
        remoteBefore: remoteInspect.bundle.summary,
        localAfter: localAfter.summary,
        remoteAfter: remoteInspect.bundle.summary,
        comparison: postComparison,
        filesDownloaded,
        filesUploaded: [],
        filesUnchanged,
        filesMerged,
        filesFailed,
        filesPending: postComparison.differingFiles.map((d) => d.repoPath),
        filesBlockedPublic: includePersonal ? [] : ['data/cinetrack-data.json', 'data/profiles/*'],
        recordsAdded,
        recordsUpdated,
        recordsConflicted: conflicts.length,
        conflicts,
        warnings,
        errors: [...errors, ...localAfter.errors],
        verifiedEqual,
        ...(updatedDataDocument ? { updatedDataDocument } : {}),
        ...(serverRevision !== undefined ? { serverRevision } : {}),
      };

      this.deps.onSyncCompleted?.({
        report,
        lastRemoteSummary: remoteInspect.bundle.summary,
        lastComparison: postComparison,
      });

      return report;
    });
  }

  /**
   * 3. PUSH: Yerel dosyaların geçerliliğini doğrulayıp GitHub'a yükler,
   * ardından uzak dosyaları yeniden okuyarak hash ve kayıt sayılarını doğrular (`verifiedEqual`).
   */
  public async push(): Promise<BidirectionalSyncReport> {
    return this.runSerialized(async () => {
      const startedAt = new Date().toISOString();
      const cfg = this.deps.getGitHubConfig();
      const localBefore = this.inspectLocalSide();
      const remoteTarget =
        cfg.owner && cfg.repo
          ? { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch }
          : undefined;

      if (!cfg.token || !cfg.owner || !cfg.repo) {
        return this.createUnconfiguredReport(
          'push',
          startedAt,
          localBefore.summary,
          cfg.isPublicRepo,
          remoteTarget
        );
      }

      const visibility = await this.deps.store.verifyRemoteRepoVisibility();
      const includePersonal = !visibility.effectiveIsPublicRepo;
      const warnings: string[] = [];
      if (visibility.warning) warnings.push(visibility.warning);

      // Yerel manifest tutarsızsa ve katalog dosyaları sağlamsa önce yerel manifest'i onar
      const moviesValid = localBefore.summary.files['data/catalog/movies.json']?.valid !== false;
      const tvValid = localBefore.summary.files['data/catalog/tv.json']?.valid !== false;
      if (moviesValid && tvValid && !localBefore.summary.manifestValid) {
        const manifestPath = path.join(this.deps.dataDir, 'catalog', 'manifest.json');
        const repairedManifest: CatalogManifest = {
          version: 1,
          updatedAt: new Date().toISOString(),
          movieCount: Object.keys(localBefore.movies).length,
          tvCount: Object.keys(localBefore.tv).length,
          contentHash: computeCatalogManifestContentHash(localBefore.movies, localBefore.tv),
        };
        writeJsonFileAtomic(manifestPath, stringifyDeterministic(repairedManifest), {
          backupPath: `${manifestPath}.bak`,
          validateParsed: isPlainObject,
        });
        warnings.push(
          `Yerel manifest.json sayım/hash uyumsuzluğu gönderim öncesinde düzeltildi (${
            localBefore.summary.manifestMismatchReason || 'yeniden üretildi'
          }).`
        );
      }

      const localReady = this.inspectLocalSide();
      const localProfilePaths = Object.keys(localReady.derivedProfiles);

      const remoteBeforeInspect = await this.inspectRemoteSide(
        { token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch },
        { includePersonalFiles: includePersonal, localProfilePaths }
      );

      const verifiedRemoteHashes: Record<string, string | null> = {};
      for (const [repoPath, rawObj] of Object.entries(remoteBeforeInspect.rawRemoteContents)) {
        const rFile = remoteBeforeInspect.bundle.summary.files[repoPath];
        if (rFile?.exists && rFile.valid) {
          verifiedRemoteHashes[repoPath] = hashContent(rawObj.content.trim());
        } else {
          verifiedRemoteHashes[repoPath] = null;
        }
      }

      // Gönderim öncesi yerel bozuk dosyalar dışındaki dosyaları GitHub'a gönder (uzakta zaten doğrulanmış eşit dosyaları yeniden yazmaz)
      const syncRes = await this.deps.store.syncToGitHub({ verifiedRemoteHashes });
      const pushErrors: SyncErrorRecord[] = [...localReady.errors];
      for (const failedPath of syncRes.filesFailed) {
        const st = syncRes.fileStates[failedPath];
        if (!pushErrors.some((e) => e.repoPath === failedPath)) {
          pushErrors.push({
            repoPath: failedPath,
            category: (st?.errorCategory as SyncErrorCategory) || 'http_error',
            message: st?.error || `${failedPath} yüklenemedi.`,
          });
        }
      }
      if (!syncRes.ok && pushErrors.length === 0 && syncRes.errors.length > 0) {
        for (const msg of syncRes.errors) {
          pushErrors.push({ category: 'http_error', message: msg });
        }
      }

      // Push tamamlandıktan sonra uzak dosyaları YENİDEN oku ve doğrula (Spec Bölüm 2 & 5.6)
      const remoteAfterInspect = await this.inspectRemoteSide(
        { token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch },
        { includePersonalFiles: includePersonal, localProfilePaths }
      );

      for (const reErr of remoteAfterInspect.bundle.errors) {
        if (!pushErrors.some((e) => e.repoPath === reErr.repoPath && e.message === reErr.message)) {
          pushErrors.push(reErr);
        }
      }

      const postComparison = compareSyncSides(localReady, remoteAfterInspect.bundle, {
        includePersonalFiles: includePersonal,
      });

      const ok =
        syncRes.ok &&
        !remoteAfterInspect.transportFailed &&
        pushErrors.length === 0;
      const verifiedEqual = ok && postComparison.semanticEqual;

      const addedMovies = Math.max(
        0,
        remoteAfterInspect.bundle.summary.catalogMovieCount -
          remoteBeforeInspect.bundle.summary.catalogMovieCount
      );
      const addedTv = Math.max(
        0,
        remoteAfterInspect.bundle.summary.catalogTvCount -
          remoteBeforeInspect.bundle.summary.catalogTvCount
      );
      const addedUser = Math.max(
        0,
        remoteAfterInspect.bundle.summary.userUniqueSavedItemsCount -
          remoteBeforeInspect.bundle.summary.userUniqueSavedItemsCount
      );

      const report: BidirectionalSyncReport = {
        ok,
        partialFailure: syncRes.partialFailure,
        operation: 'push',
        startedAt,
        completedAt: new Date().toISOString(),
        remoteTarget,
        isPublicRepo: visibility.effectiveIsPublicRepo,
        ...(visibility.warning ? { repoVisibilityWarning: visibility.warning } : {}),
        localBefore: localBefore.summary,
        remoteBefore: remoteBeforeInspect.transportFailed ? null : remoteBeforeInspect.bundle.summary,
        localAfter: localReady.summary,
        remoteAfter: remoteAfterInspect.transportFailed ? null : remoteAfterInspect.bundle.summary,
        comparison: remoteAfterInspect.transportFailed ? null : postComparison,
        filesDownloaded: [],
        filesUploaded: syncRes.filesCommitted,
        filesUnchanged: syncRes.filesSkipped,
        filesMerged: [],
        filesFailed: syncRes.filesFailed,
        filesPending: remoteAfterInspect.transportFailed
          ? []
          : postComparison.differingFiles.map((d) => d.repoPath),
        filesBlockedPublic: syncRes.filesBlockedPublic,
        recordsAdded: addedMovies + addedTv + addedUser,
        recordsUpdated: 0,
        recordsConflicted: 0,
        conflicts: [],
        warnings,
        errors: pushErrors,
        verifiedEqual,
      };

      this.deps.onSyncCompleted?.({
        report,
        lastRemoteSummary: remoteAfterInspect.transportFailed
          ? null
          : remoteAfterInspect.bundle.summary,
        lastComparison: remoteAfterInspect.transportFailed ? null : postComparison,
      });

      return report;
    });
  }

  /**
   * 4. RECONCILE (İki Yönlü Eşitleme):
   * Yerel ve GitHub verilerini inceler, katalog + kullanıcı verisi + türetilmiş profilleri
   * varsayılan silmesiz (no-deletion) kuralla kayıpsız birleştirir, her iki tarafa uygular
   * ve uzak dosyaları yeniden okuyarak tam eşitliği doğrular.
   */
  public async reconcile(): Promise<BidirectionalSyncReport> {
    return this.runSerialized(async () => {
      const startedAt = new Date().toISOString();
      const cfg = this.deps.getGitHubConfig();
      const localBefore = this.inspectLocalSide();
      const remoteTarget =
        cfg.owner && cfg.repo
          ? { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch }
          : undefined;

      if (!cfg.token || !cfg.owner || !cfg.repo) {
        return this.createUnconfiguredReport(
          'reconcile',
          startedAt,
          localBefore.summary,
          cfg.isPublicRepo,
          remoteTarget
        );
      }

      const visibility = await this.deps.store.verifyRemoteRepoVisibility();
      const includePersonal = !visibility.effectiveIsPublicRepo;
      const localProfilePaths = Object.keys(localBefore.derivedProfiles);

      const remoteBeforeInspect = await this.inspectRemoteSide(
        { token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch },
        { includePersonalFiles: includePersonal, localProfilePaths }
      );

      const warnings: string[] = [];
      if (visibility.warning) warnings.push(visibility.warning);

      // Ağ/yetki/rate-limit hatası varsa hiçbir veriyi değiştirmeden durdur
      if (remoteBeforeInspect.transportFailed) {
        const report: BidirectionalSyncReport = {
          ok: false,
          partialFailure: false,
          operation: 'reconcile',
          startedAt,
          completedAt: new Date().toISOString(),
          remoteTarget,
          isPublicRepo: visibility.effectiveIsPublicRepo,
          ...(visibility.warning ? { repoVisibilityWarning: visibility.warning } : {}),
          localBefore: localBefore.summary,
          remoteBefore: remoteBeforeInspect.bundle.summary,
          localAfter: localBefore.summary,
          remoteAfter: remoteBeforeInspect.bundle.summary,
          comparison: null,
          filesDownloaded: [],
          filesUploaded: [],
          filesUnchanged: [],
          filesMerged: [],
          filesFailed: remoteBeforeInspect.bundle.errors
            .map((e) => e.repoPath)
            .filter(Boolean) as string[],
          filesPending: [],
          filesBlockedPublic: includePersonal ? [] : ['data/cinetrack-data.json', 'data/profiles/*'],
          recordsAdded: 0,
          recordsUpdated: 0,
          recordsConflicted: 0,
          conflicts: [],
          warnings,
          errors: remoteBeforeInspect.bundle.errors,
          verifiedEqual: false,
        };
        this.deps.onSyncCompleted?.({
          report,
          lastRemoteSummary: remoteBeforeInspect.bundle.summary,
          lastComparison: null,
        });
        return report;
      }

      // Yerel güvenlik yedeği al
      if (this.deps.storage) {
        await this.deps.storage.createSafetySnapshotSerialized();
      }

      const filesDownloaded: string[] = [];
      const filesUploaded: string[] = [];
      const filesUnchanged: string[] = [];
      const filesMerged: string[] = [];
      const filesFailed: string[] = [];
      const errors: SyncErrorRecord[] = [];
      const conflicts: UserDataConflictItem[] = [];
      let recordsAdded = 0;
      let recordsUpdated = 0;
      let updatedDataDocument: DataDocument | undefined;
      let serverRevision: number | undefined;

      const pathsBlockedFromPush = new Set<string>();

      // --- A. KATALOG İKİ YÖNLÜ BİRLEŞTİRME ---
      const lMoviesInfo = localBefore.summary.files['data/catalog/movies.json'];
      const rMoviesInfo = remoteBeforeInspect.bundle.summary.files['data/catalog/movies.json'];
      let reconciledMovies = localBefore.movies;

      if (!lMoviesInfo.valid) {
        filesFailed.push('data/catalog/movies.json');
        pathsBlockedFromPush.add('data/catalog/movies.json');
        errors.push({
          repoPath: 'data/catalog/movies.json',
          category: 'corrupt_local_file',
          message: `Yerel movies.json bozuk olduğu için birleştirilmedi (${lMoviesInfo.error}).`,
        });
      } else if (rMoviesInfo?.exists && !rMoviesInfo.valid) {
        filesFailed.push('data/catalog/movies.json');
        pathsBlockedFromPush.add('data/catalog/movies.json');
        errors.push({
          repoPath: 'data/catalog/movies.json',
          category: rMoviesInfo.errorCategory || 'corrupt_remote_json',
          message: `GitHub movies.json bozuk olduğu için yerel sağlam dosya korundu (${rMoviesInfo.error}).`,
        });
      } else {
        const movieMerge = mergeCatalogMapsLossless(
          localBefore.movies,
          remoteBeforeInspect.bundle.movies,
          'movie'
        );
        reconciledMovies = movieMerge.merged;
        recordsAdded += movieMerge.addedToLocal + movieMerge.addedToRemote;
        recordsUpdated += Math.max(movieMerge.updatedLocal, movieMerge.updatedRemote);

        const serializedMergedMovies = stringifyDeterministic(reconciledMovies);
        const moviesPath = path.join(this.deps.dataDir, 'catalog', 'movies.json');
        const localRawMatches =
          lMoviesInfo.exists &&
          lMoviesInfo.rawFileHash === computeRawUtf8Hash(serializedMergedMovies);

        if (
          !localRawMatches &&
          (Object.keys(reconciledMovies).length > 0 ||
            lMoviesInfo.exists ||
            Boolean(rMoviesInfo?.exists))
        ) {
          writeJsonFileAtomic(moviesPath, serializedMergedMovies, {
            backupPath: `${moviesPath}.bak`,
            validateParsed: isPlainObject,
          });
          if (movieMerge.addedToLocal > 0 && movieMerge.addedToRemote > 0) {
            filesMerged.push('data/catalog/movies.json');
          } else if (
            movieMerge.addedToLocal > 0 ||
            movieMerge.updatedLocal > 0 ||
            (!lMoviesInfo.exists && rMoviesInfo?.exists)
          ) {
            filesDownloaded.push('data/catalog/movies.json');
          }
        }
      }

      const lTvInfo = localBefore.summary.files['data/catalog/tv.json'];
      const rTvInfo = remoteBeforeInspect.bundle.summary.files['data/catalog/tv.json'];
      let reconciledTv = localBefore.tv;

      if (!lTvInfo.valid) {
        filesFailed.push('data/catalog/tv.json');
        pathsBlockedFromPush.add('data/catalog/tv.json');
        errors.push({
          repoPath: 'data/catalog/tv.json',
          category: 'corrupt_local_file',
          message: `Yerel tv.json bozuk olduğu için birleştirilmedi (${lTvInfo.error}).`,
        });
      } else if (rTvInfo?.exists && !rTvInfo.valid) {
        filesFailed.push('data/catalog/tv.json');
        pathsBlockedFromPush.add('data/catalog/tv.json');
        errors.push({
          repoPath: 'data/catalog/tv.json',
          category: rTvInfo.errorCategory || 'corrupt_remote_json',
          message: `GitHub tv.json bozuk olduğu için yerel sağlam dosya korundu (${rTvInfo.error}).`,
        });
      } else {
        const tvMerge = mergeCatalogMapsLossless(
          localBefore.tv,
          remoteBeforeInspect.bundle.tv,
          'tv'
        );
        reconciledTv = tvMerge.merged;
        recordsAdded += tvMerge.addedToLocal + tvMerge.addedToRemote;
        recordsUpdated += Math.max(tvMerge.updatedLocal, tvMerge.updatedRemote);

        const serializedMergedTv = stringifyDeterministic(reconciledTv);
        const tvPath = path.join(this.deps.dataDir, 'catalog', 'tv.json');
        const localTvRawMatches =
          lTvInfo.exists && lTvInfo.rawFileHash === computeRawUtf8Hash(serializedMergedTv);

        if (
          !localTvRawMatches &&
          (Object.keys(reconciledTv).length > 0 || lTvInfo.exists || Boolean(rTvInfo?.exists))
        ) {
          writeJsonFileAtomic(tvPath, serializedMergedTv, {
            backupPath: `${tvPath}.bak`,
            validateParsed: isPlainObject,
          });
          if (tvMerge.addedToLocal > 0 && tvMerge.addedToRemote > 0) {
            filesMerged.push('data/catalog/tv.json');
          } else if (
            tvMerge.addedToLocal > 0 ||
            tvMerge.updatedLocal > 0 ||
            (!lTvInfo.exists && rTvInfo?.exists)
          ) {
            filesDownloaded.push('data/catalog/tv.json');
          }
        }
      }

      // Manifest yeniden üretimi (eğer katalog dosyalarından biri bozuk değilse)
      const reconciledCatalogHash = computeCatalogManifestContentHash(
        reconciledMovies,
        reconciledTv
      );
      if (
        !pathsBlockedFromPush.has('data/catalog/movies.json') &&
        !pathsBlockedFromPush.has('data/catalog/tv.json')
      ) {
        if (localBefore.summary.manifestMismatchReason) {
          warnings.push(
            `Yerel manifest.json tutarsızlığı düzeltildi: ${localBefore.summary.manifestMismatchReason}`
          );
        }
        if (remoteBeforeInspect.bundle.summary.manifestMismatchReason) {
          warnings.push(
            `GitHub manifest.json tutarsızlığı düzeltildi: ${remoteBeforeInspect.bundle.summary.manifestMismatchReason}`
          );
        }

        const movieCount = Object.keys(reconciledMovies).length;
        const tvCount = Object.keys(reconciledTv).length;
        const hasAnyCatalog =
          movieCount > 0 ||
          tvCount > 0 ||
          localBefore.summary.manifestPresent ||
          remoteBeforeInspect.bundle.summary.manifestPresent;

        if (hasAnyCatalog) {
          // Idempotent zaman damgası: sayılar ve contentHash aynıysa mevcut updatedAt'i koru
          const reusableUpdatedAt =
            localBefore.manifest &&
            localBefore.manifest.movieCount === movieCount &&
            localBefore.manifest.tvCount === tvCount &&
            localBefore.manifest.contentHash === reconciledCatalogHash
              ? localBefore.manifest.updatedAt
              : remoteBeforeInspect.bundle.manifest &&
                remoteBeforeInspect.bundle.manifest.movieCount === movieCount &&
                remoteBeforeInspect.bundle.manifest.tvCount === tvCount &&
                remoteBeforeInspect.bundle.manifest.contentHash === reconciledCatalogHash
              ? remoteBeforeInspect.bundle.manifest.updatedAt
              : new Date().toISOString();

          const manifestObj: CatalogManifest = {
            version: 1,
            updatedAt: reusableUpdatedAt,
            movieCount,
            tvCount,
            contentHash: reconciledCatalogHash,
          };
          const serializedManifest = stringifyDeterministic(manifestObj);
          const manifestPath = path.join(this.deps.dataDir, 'catalog', 'manifest.json');
          if (
            !localBefore.summary.manifestPresent ||
            localBefore.summary.files['data/catalog/manifest.json']?.rawFileHash !==
              computeRawUtf8Hash(serializedManifest)
          ) {
            writeJsonFileAtomic(manifestPath, serializedManifest, {
              backupPath: `${manifestPath}.bak`,
              validateParsed: isPlainObject,
            });
          }
        }
      } else {
        pathsBlockedFromPush.add('data/catalog/manifest.json');
      }

      // --- B. KULLANICI VERİSİ (`data/cinetrack-data.json`) İKİ YÖNLÜ BİRLEŞTİRME ---
      let reconciledUserData: DataDocument | null = localBefore.userData;
      if (includePersonal) {
        const lUserInfo = localBefore.summary.files['data/cinetrack-data.json'];
        const rUserInfo = remoteBeforeInspect.bundle.summary.files['data/cinetrack-data.json'];

        if (!lUserInfo.valid) {
          filesFailed.push('data/cinetrack-data.json');
          pathsBlockedFromPush.add('data/cinetrack-data.json');
          errors.push({
            repoPath: 'data/cinetrack-data.json',
            category: 'corrupt_local_file',
            message: `Yerel cinetrack-data.json bozuk olduğu için birleştirilmedi (${lUserInfo.error}).`,
          });
        } else if (rUserInfo?.exists && !rUserInfo.valid) {
          filesFailed.push('data/cinetrack-data.json');
          pathsBlockedFromPush.add('data/cinetrack-data.json');
          errors.push({
            repoPath: 'data/cinetrack-data.json',
            category: rUserInfo.errorCategory || 'corrupt_remote_json',
            message: `GitHub cinetrack-data.json bozuk olduğu için yerel sağlam dosya korundu (${rUserInfo.error}).`,
          });
        } else if (localBefore.userData && remoteBeforeInspect.bundle.userData) {
          if (lUserInfo.semanticHash !== rUserInfo?.semanticHash) {
            const mergedUser = reconcileUserDataDocumentsLossless(
              localBefore.userData,
              remoteBeforeInspect.bundle.userData
            );
            recordsAdded += mergedUser.addedToLocal + mergedUser.addedToRemote;
            recordsUpdated += mergedUser.updatedItems;
            conflicts.push(...mergedUser.conflicts);

            if (this.deps.storage) {
              const saveRes = await this.deps.storage.applySyncedDocumentSerialized(
                mergedUser.mergedDoc
              );
              if (saveRes.ok) {
                reconciledUserData = saveRes.document;
                updatedDataDocument = saveRes.document;
                serverRevision = saveRes.document.revision;
                filesMerged.push('data/cinetrack-data.json');
              } else {
                filesFailed.push('data/cinetrack-data.json');
                pathsBlockedFromPush.add('data/cinetrack-data.json');
                errors.push({
                  repoPath: 'data/cinetrack-data.json',
                  category: 'corrupt_local_file',
                  message: saveRes.message,
                });
              }
            } else {
              const userDataPath = path.join(this.deps.dataDir, 'cinetrack-data.json');
              writeJsonFileAtomic(userDataPath, JSON.stringify(mergedUser.mergedDoc, null, 2), {
                backupPath: `${this.deps.dataDir}/cinetrack-data.bak.json`,
                validateParsed: isPlainObject,
              });
              reconciledUserData = mergedUser.mergedDoc;
              updatedDataDocument = mergedUser.mergedDoc;
              filesMerged.push('data/cinetrack-data.json');
            }
          }
        } else if (!localBefore.userData && remoteBeforeInspect.bundle.userData) {
          const remoteDoc = remoteBeforeInspect.bundle.userData;
          recordsAdded += remoteBeforeInspect.bundle.summary.userUniqueSavedItemsCount;
          if (this.deps.storage) {
            const saveRes = await this.deps.storage.applySyncedDocumentSerialized(remoteDoc);
            if (saveRes.ok) {
              reconciledUserData = saveRes.document;
              updatedDataDocument = saveRes.document;
              serverRevision = saveRes.document.revision;
              filesDownloaded.push('data/cinetrack-data.json');
            }
          } else {
            const userDataPath = path.join(this.deps.dataDir, 'cinetrack-data.json');
            writeJsonFileAtomic(userDataPath, JSON.stringify(remoteDoc, null, 2), {
              backupPath: `${this.deps.dataDir}/cinetrack-data.bak.json`,
              validateParsed: isPlainObject,
            });
            reconciledUserData = remoteDoc;
            updatedDataDocument = remoteDoc;
            filesDownloaded.push('data/cinetrack-data.json');
          }
        }

        // --- C. PROFİL BAZLI TÜRETİLMİŞ VERİLER (`data/profiles/*.json`) ---
        const allDerivedPaths = new Set<string>([
          ...Object.keys(localBefore.summary.files).filter(
            (p) => localBefore.summary.files[p]?.category === 'derived_profile'
          ),
          ...Object.keys(remoteBeforeInspect.bundle.summary.files).filter(
            (p) => remoteBeforeInspect.bundle.summary.files[p]?.category === 'derived_profile'
          ),
        ]);

        for (const repoPath of Array.from(allDerivedPaths).sort()) {
          const lInfo = localBefore.summary.files[repoPath];
          const rInfo = remoteBeforeInspect.bundle.summary.files[repoPath];

          if (lInfo?.exists && !lInfo.valid) {
            filesFailed.push(repoPath);
            pathsBlockedFromPush.add(repoPath);
            errors.push({
              repoPath,
              category: 'corrupt_local_file',
              message: `Yerel ${repoPath} bozuk (${lInfo.error}).`,
            });
            continue;
          }
          if (rInfo?.exists && !rInfo.valid) {
            filesFailed.push(repoPath);
            pathsBlockedFromPush.add(repoPath);
            errors.push({
              repoPath,
              category: rInfo.errorCategory || 'corrupt_remote_json',
              message: `GitHub ${repoPath} bozuk olduğu için yerel dosya korundu (${rInfo.error}).`,
            });
            continue;
          }

          const localProf = localBefore.derivedProfiles[repoPath];
          const remoteProf = remoteBeforeInspect.bundle.derivedProfiles[repoPath];
          const profileId =
            localProf?.profileId ||
            remoteProf?.profileId ||
            path.posix.basename(repoPath, '.json');
          const matchingUserProfile = reconciledUserData?.profiles?.find(
            (p) => p.id === profileId
          );

          const localFresh = localProf
            ? this.isDerivedDocFreshForContext(
                localProf,
                reconciledCatalogHash,
                matchingUserProfile
              )
            : { valid: false, reason: 'yok' };
          const remoteFresh = remoteProf
            ? this.isDerivedDocFreshForContext(
                remoteProf,
                reconciledCatalogHash,
                matchingUserProfile
              )
            : { valid: false, reason: 'yok' };

          // İkisi de geçerli ve içerik özeti aynıysa hiçbir işlem yapma
          if (localProf && remoteProf && localFresh.valid && remoteFresh.valid) {
            if (localProf.contentHash === remoteProf.contentHash) {
              continue;
            }
            // Aynı imza/sürüm altında içerikler farklıysa öğeleri deterministik birleştir
            const combinedItems: Record<string, DerivedProfileItem> = {
              ...remoteProf.items,
              ...localProf.items,
            };
            const nextHash = computeDerivedProfileContentHash({
              schemaVersion: DERIVED_PROFILE_SCHEMA_VERSION,
              profileId,
              algorithmVersion: localProf.algorithmVersion,
              profileFingerprint: localProf.profileFingerprint,
              sourceCatalogHash: reconciledCatalogHash,
              items: combinedItems,
            });
            const mergedDerived: DerivedProfileDocument = {
              schemaVersion: DERIVED_PROFILE_SCHEMA_VERSION,
              profileId,
              algorithmVersion: localProf.algorithmVersion,
              profileFingerprint: localProf.profileFingerprint,
              sourceCatalogHash: reconciledCatalogHash,
              contentHash: nextHash,
              generatedAt:
                localProf.generatedAt > remoteProf.generatedAt
                  ? localProf.generatedAt
                  : remoteProf.generatedAt,
              items: combinedItems,
            };
            const targetFile = this.deps.store.getProfileFilePath(profileId);
            writeJsonFileAtomic(targetFile, stringifyDeterministic(mergedDerived), {
              backupPath: `${targetFile}.bak`,
              validateParsed: isPlainObject,
            });
            filesMerged.push(repoPath);
            continue;
          }

          if (!localFresh.valid && remoteProf && remoteFresh.valid) {
            if (localProf) {
              warnings.push(
                `${repoPath}: Yerel türetilmiş profil eski/uyumsuz bulundu (${localFresh.reason}); geçerli uzak önbellek alındı.`
              );
            }
            const targetFile = this.deps.store.getProfileFilePath(profileId);
            writeJsonFileAtomic(targetFile, stringifyDeterministic(remoteProf), {
              backupPath: `${targetFile}.bak`,
              validateParsed: isPlainObject,
            });
            filesDownloaded.push(repoPath);
            continue;
          }

          if (localProf && localFresh.valid && !remoteFresh.valid) {
            if (remoteProf) {
              warnings.push(
                `${repoPath}: GitHub'daki türetilmiş profil eski/uyumsuz bulundu (${remoteFresh.reason}); geçerli yerel sürüm korunup yüklenecek.`
              );
            }
            continue;
          }

          // Her iki taraf da güncel profil/algoritma/şema ile uyumsuzsa kaynak veriden yeniden üret!
          if (!localFresh.valid && !remoteFresh.valid) {
            if (matchingUserProfile) {
              warnings.push(
                `${repoPath}: Türetilmiş profil önbelleği güncel profil/algoritma sürümüyle eşleşmediği için kaynak veriden yeniden üretildi.`
              );
              const regenerated = buildFreshDerivedProfileDocumentOnServer(
                matchingUserProfile,
                reconciledMovies,
                reconciledTv,
                reconciledCatalogHash
              );
              const targetFile = this.deps.store.getProfileFilePath(profileId);
              writeJsonFileAtomic(targetFile, stringifyDeterministic(regenerated), {
                backupPath: `${targetFile}.bak`,
                validateParsed: isPlainObject,
              });
              filesMerged.push(repoPath);
            } else {
              // Kaynak profil cinetrack-data.json içinde yoksa eski türetilmiş veriyi geçerli kabul etme!
              warnings.push(
                `${repoPath}: Algoritma/şema sürümü güncel olmayan türetilmiş profil geçersiz sayıldı ve üzerine yazılmadı.`
              );
              pathsBlockedFromPush.add(repoPath);
            }
          }
        }
      }

      // --- D. BİRLEŞTİRİLMİŞ GÜNCEL YEREL DOSYALARI GITHUB'A YÜKLE ---
      const localPrepared = this.inspectLocalSide();
      const uploadCandidates: Array<{ repoPath: string; localPath: string; commitMsg: string }> = [
        {
          repoPath: 'data/catalog/movies.json',
          localPath: path.join(this.deps.dataDir, 'catalog', 'movies.json'),
          commitMsg: 'chore(sync): reconcile movies.json [skip ci]',
        },
        {
          repoPath: 'data/catalog/tv.json',
          localPath: path.join(this.deps.dataDir, 'catalog', 'tv.json'),
          commitMsg: 'chore(sync): reconcile tv.json [skip ci]',
        },
        {
          repoPath: 'data/catalog/manifest.json',
          localPath: path.join(this.deps.dataDir, 'catalog', 'manifest.json'),
          commitMsg: 'chore(sync): reconcile manifest.json [skip ci]',
        },
      ];

      if (includePersonal) {
        uploadCandidates.push({
          repoPath: 'data/cinetrack-data.json',
          localPath: path.join(this.deps.dataDir, 'cinetrack-data.json'),
          commitMsg: 'chore(sync): reconcile cinetrack-data.json [skip ci]',
        });
        for (const repoPath of Object.keys(localPrepared.derivedProfiles).sort()) {
          uploadCandidates.push({
            repoPath,
            localPath: path.join(this.deps.dataDir, repoPath.replace(/^data\//, '')),
            commitMsg: `chore(sync): reconcile ${path.posix.basename(repoPath)} [skip ci]`,
          });
        }
      }

      for (const candidate of uploadCandidates) {
        if (pathsBlockedFromPush.has(candidate.repoPath)) continue;
        if (!existsSync(candidate.localPath)) continue;

        const validCheck = tryParseValidJson(candidate.localPath);
        if (!validCheck.ok) {
          filesFailed.push(candidate.repoPath);
          errors.push({
            repoPath: candidate.repoPath,
            category: 'corrupt_local_file',
            message: `${candidate.repoPath}: Yerel dosya geçerli JSON değil (${validCheck.error}).`,
          });
          continue;
        }

        const localContent = readFileSync(candidate.localPath, 'utf8');
        const localInspection = localPrepared.summary.files[candidate.repoPath];
        const remoteBeforeFile = remoteBeforeInspect.bundle.summary.files[candidate.repoPath];

        // Uzak tarafla semantik (ve katalog manifest tutarlılığı için ham) özet zaten birebir aynıysa gereksiz GitHub isteği/commit üretme
        const isCatalogDataFile =
          candidate.repoPath === 'data/catalog/movies.json' ||
          candidate.repoPath === 'data/catalog/tv.json';
        const rawMatchesWhenRequired =
          !isCatalogDataFile || remoteBeforeFile?.rawFileHash === localInspection?.rawFileHash;
        if (
          remoteBeforeFile?.exists &&
          remoteBeforeFile.valid &&
          localInspection?.semanticHash &&
          remoteBeforeFile.semanticHash === localInspection.semanticHash &&
          rawMatchesWhenRequired
        ) {
          if (
            !filesDownloaded.includes(candidate.repoPath) &&
            !filesMerged.includes(candidate.repoPath)
          ) {
            filesUnchanged.push(candidate.repoPath);
          }
          continue;
        }

        const commitRes = await this.deps.store.commitFileToGitHub(
          candidate.repoPath,
          localContent,
          candidate.commitMsg
        );
        if (commitRes.ok) {
          if (commitRes.skippedNoop) {
            if (
              !filesDownloaded.includes(candidate.repoPath) &&
              !filesMerged.includes(candidate.repoPath) &&
              !filesUnchanged.includes(candidate.repoPath)
            ) {
              filesUnchanged.push(candidate.repoPath);
            }
          } else {
            filesUploaded.push(candidate.repoPath);
          }
        } else {
          filesFailed.push(candidate.repoPath);
          errors.push({
            repoPath: candidate.repoPath,
            category: (commitRes.errorCategory as SyncErrorCategory) || 'http_error',
            message: `${candidate.repoPath}: ${commitRes.error || 'GitHub yükleme hatası'}`,
          });
        }
      }

      // --- E. İŞLEM SONRASI GERÇEK UZAK DOSYALARI YENİDEN OKU VE DOĞRULA ---
      const localAfter = this.inspectLocalSide();
      const remoteAfterInspect = await this.inspectRemoteSide(
        { token: cfg.token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch },
        {
          includePersonalFiles: includePersonal,
          localProfilePaths: Object.keys(localAfter.derivedProfiles),
        }
      );

      for (const reErr of remoteAfterInspect.bundle.errors) {
        if (!errors.some((e) => e.repoPath === reErr.repoPath && e.message === reErr.message)) {
          errors.push(reErr);
        }
      }

      const postComparison = compareSyncSides(localAfter, remoteAfterInspect.bundle, {
        includePersonalFiles: includePersonal,
      });

      const uniqueFailed = Array.from(new Set(filesFailed));
      const ok =
        !remoteAfterInspect.transportFailed &&
        uniqueFailed.length === 0 &&
        errors.length === 0;
      const anyProcessed =
        filesDownloaded.length > 0 ||
        filesUploaded.length > 0 ||
        filesMerged.length > 0 ||
        filesUnchanged.length > 0;
      const partialFailure = !ok && anyProcessed && uniqueFailed.length > 0;
      const verifiedEqual = ok && postComparison.semanticEqual;

      if (verifiedEqual) {
        this.initialReconcileCompleted = true;
      }

      const report: BidirectionalSyncReport = {
        ok,
        partialFailure,
        operation: 'reconcile',
        startedAt,
        completedAt: new Date().toISOString(),
        remoteTarget,
        isPublicRepo: visibility.effectiveIsPublicRepo,
        ...(visibility.warning ? { repoVisibilityWarning: visibility.warning } : {}),
        localBefore: localBefore.summary,
        remoteBefore: remoteBeforeInspect.bundle.summary,
        localAfter: localAfter.summary,
        remoteAfter: remoteAfterInspect.transportFailed ? null : remoteAfterInspect.bundle.summary,
        comparison: remoteAfterInspect.transportFailed ? null : postComparison,
        filesDownloaded: Array.from(new Set(filesDownloaded)),
        filesUploaded: Array.from(new Set(filesUploaded)),
        filesUnchanged: Array.from(new Set(filesUnchanged)),
        filesMerged: Array.from(new Set(filesMerged)),
        filesFailed: uniqueFailed,
        filesPending: remoteAfterInspect.transportFailed
          ? []
          : postComparison.differingFiles.map((d) => d.repoPath),
        filesBlockedPublic: includePersonal ? [] : ['data/cinetrack-data.json', 'data/profiles/*'],
        recordsAdded,
        recordsUpdated,
        recordsConflicted: conflicts.length,
        conflicts,
        warnings,
        errors,
        verifiedEqual,
        ...(updatedDataDocument ? { updatedDataDocument } : {}),
        ...(serverRevision !== undefined ? { serverRevision } : {}),
      };

      this.deps.onSyncCompleted?.({
        report,
        lastRemoteSummary: remoteAfterInspect.transportFailed
          ? null
          : remoteAfterInspect.bundle.summary,
        lastComparison: remoteAfterInspect.transportFailed ? null : postComparison,
      });

      return report;
    });
  }
}

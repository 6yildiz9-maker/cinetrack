export const REMINDER_WINDOW_DAYS = 3;

export interface NextEpisode {
  air_date: string;
  episode_number: number;
  season_number: number;
}

export interface SavedItem {
  id: number | string;
  media_type: 'movie' | 'tv';
  title: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  last_air_date?: string;
  vote_average: number;
  vote_count: number;
  popularity: number;
  poster_url?: string;
  poster_path?: string;
  backdrop_path?: string;
  overview?: string;
  genre_ids: number[];
  genres?: string[] | { id: number; name: string }[];
  runtime?: number;
  episode_run_time?: number[];
  number_of_seasons?: number;
  number_of_episodes?: number;
  season_progress?: Record<number, number>;
  season_episode_counts?: Record<number, number>;
  next_episode_to_air?: NextEpisode | null;
  current_season?: number;
  episodes_watched?: number;
  next_episode?: number;
  status: 'watching' | 'watchlist' | 'completed';
  personal_rating: number | '';
  personal_rating_cleared?: boolean;
  addedAt?: string;
  firstAddedAt?: string;
  totalWatchTimeMinutes?: number;
  updatedAt?: string;
  custom?: boolean;
  cast?: { id: number; name: string; popularity?: number; profile_path?: string; character?: string }[];
  crew?: { id: number; name: string; job: string; department?: string }[];
  poolSource?: string;
  poolReason?: string;
  poolSources?: number;
  isDemo?: boolean;
}

export interface Preferences {
  disliked: string[];
  hidden?: string[];
  providers: string[];
  mood: string;
  reminders: boolean;
  notified: string[];
}

export interface FavoriteActorInfo {
  id: number;
  name: string;
  profile_path?: string | null;
  character?: string;
  [key: string]: any;
}

export interface Profile {
  id: string;
  name: string;
  createdAt: string;
  preferences: Preferences;
  items: SavedItem[];
  favoriteActors?: FavoriteActorInfo[];
  isDemo?: boolean;
}

export const CURRENT_SCHEMA_VERSION = 3;
export const ENGINE_VERSION = 'v3.2.0';

export interface DataDocument {
  version: 3;
  schemaVersion: number;
  engineVersion?: string;
  activeProfileId: string;
  profiles: Profile[];
  revision?: number;
  updatedAt?: string;
}

import {
  makeMediaKey,
  parseMediaKey,
  canonicalizeMediaKey,
  canonicalizeMediaKeyList,
  mergeTasteMapEntriesOnCollision,
  migratePersistentTasteMapData,
} from './keys.ts';

export {
  makeMediaKey,
  parseMediaKey,
  canonicalizeMediaKey,
  canonicalizeMediaKeyList,
  mergeTasteMapEntriesOnCollision,
  migratePersistentTasteMapData,
};

export function normalizeFavoriteActor(raw: any): FavoriteActorInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = Number(raw.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const name = String(raw.name || '').trim();
  if (!name) return null;
  return {
    id,
    name: name.slice(0, 100),
    profile_path: typeof raw.profile_path === 'string' ? raw.profile_path : null,
    character: typeof raw.character === 'string' ? raw.character.slice(0, 100) : undefined,
  };
}

export function normalizeFavoriteActors(raw: any, maxActors = 100): FavoriteActorInfo[] {
  if (!Array.isArray(raw)) return [];
  const list: FavoriteActorInfo[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (list.length >= maxActors) break;
    const actor = normalizeFavoriteActor(item);
    if (!actor || seen.has(actor.id)) continue;
    seen.add(actor.id);
    list.push(actor);
  }
  return list;
}

export function validItemId(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  return (
    typeof value === 'string' &&
    (/^[1-9]\d{0,11}$/.test(value) || /^custom-[A-Za-z0-9_-]{1,80}$/.test(value))
  );
}

export function escapeHTML(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char] || char
  );
}

export function safeHttpsUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

export function isValidCalendarDate(airDate: string): boolean {
  const parsed = new Date(`${airDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return false;
  return (
    `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(
      parsed.getDate()
    ).padStart(2, '0')}` === airDate
  );
}

export function sanitizeNextEpisode(value: any): NextEpisode | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const airDate =
    typeof value.air_date === 'string' && isValidCalendarDate(value.air_date) ? value.air_date : '';
  if (!airDate) return null;
  const integerAtLeastZero = (input: any) => {
    const numeric = Number(input);
    return Number.isFinite(numeric) && numeric >= 0 ? Math.min(10000, Math.floor(numeric)) : 0;
  };
  return {
    air_date: airDate,
    episode_number: integerAtLeastZero(value.episode_number),
    season_number: integerAtLeastZero(value.season_number),
  };
}

export function sanitizeSeasonMap(
  value: any,
  { maxSeason = 300, maxValue = 10000, allowZero = true } = {}
): Record<number, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output: Record<number, number> = {};
  for (const [key, rawCount] of Object.entries(value)) {
    const season = Number(key);
    if (!Number.isSafeInteger(season) || season < 1 || season > maxSeason) continue;
    const count = Number(rawCount);
    if (!Number.isFinite(count) || count < 0 || (!allowZero && count < 1)) continue;
    output[season] = Math.min(maxValue, Math.floor(count));
  }
  return output;
}

export function sanitizeSeasonProgress(value: any): Record<number, number> {
  return sanitizeSeasonMap(value, { maxSeason: 300, maxValue: 10000, allowZero: true }) || {};
}

export function sanitizeSeasonCounts(value: any): Record<number, number> {
  return sanitizeSeasonMap(value, { maxSeason: 300, maxValue: 10000, allowZero: true }) || {};
}

export function buildSeasonCounts(details: any): Record<number, number> {
  const seasons = Array.isArray(details?.seasons) ? details.seasons : [];
  const counts: Record<number, number> = {};
  for (const season of seasons) {
    const number = Number(season?.season_number);
    if (!Number.isSafeInteger(number) || number < 1 || number > 300) continue;
    const count = Number(season?.episode_count);
    counts[number] = Number.isSafeInteger(count) && count > 0 ? Math.min(count, 10000) : 0;
  }
  return counts;
}

export function defaultCurrentSeason(
  progress: Record<number, number> = {},
  counts: Record<number, number> = {}
): number {
  const seasons = [
    ...new Set([
      ...Object.keys(progress || {}).map(Number),
      ...Object.keys(counts || {}).map(Number),
    ]),
  ]
    .filter((season) => Number.isSafeInteger(season) && season >= 1)
    .sort((a, b) => a - b);
  if (!seasons.length) return 1;
  const watched = (season: number) => (progress || {})[season] || 0;
  const totalOf = (season: number) => {
    const value = Number((counts || {})[season]);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  const partiallyWatched = seasons.find((season) => {
    const total = totalOf(season);
    return total !== null && watched(season) > 0 && watched(season) < total;
  });
  if (partiallyWatched) return partiallyWatched;
  const queuedZero = [...seasons]
    .reverse()
    .find(
      (season) =>
        watched(season) === 0 &&
        seasons.some((previous) => previous < season && watched(previous) > 0)
    );
  if (queuedZero) return queuedZero;
  const started = [...seasons].reverse().find((season) => watched(season) > 0);
  return started || seasons[0];
}

export function normalizeSavedItem(item: any): SavedItem | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (!validItemId(item.id) || !['movie', 'tv'].includes(item.media_type)) return null;
  const rating = Number(item.personal_rating);
  const validRating = Number.isFinite(rating) && rating >= 1 && rating <= 10 ? rating : 0;
  const numeric = (value: any, min: number, max: number) =>
    Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.floor(Number(value)))) : 0;
  let seasonProgress = sanitizeSeasonProgress(item.season_progress);
  if (!Object.keys(seasonProgress).length) {
    const legacySeason = numeric(item.current_season, 0, 300) || 1;
    const legacyWatched = numeric(item.episodes_watched, 0, 10000);
    seasonProgress = legacyWatched > 0 ? { [legacySeason]: legacyWatched } : {};
  }
  const totalWatched = Object.values(seasonProgress).reduce((sum, count) => sum + count, 0);
  const seasonCounts = sanitizeSeasonCounts(item.season_episode_counts);
  return {
    id: typeof item.id === 'string' && /^\d+$/.test(item.id) ? Number(item.id) : item.id,
    media_type: item.media_type,
    title: String(item.title || item.name || 'Başlıksız içerik').slice(0, 160),
    release_date:
      typeof (item.release_date || item.releaseDate) === 'string'
        ? (item.release_date || item.releaseDate).slice(0, 10)
        : '',
    first_air_date: typeof item.first_air_date === 'string' ? item.first_air_date.slice(0, 10) : '',
    last_air_date: typeof item.last_air_date === 'string' ? item.last_air_date.slice(0, 10) : '',
    vote_average: Number(item.vote_average ?? (Number.parseFloat(item.rating) || 0)) || 0,
    vote_count: Number(item.vote_count) || 0,
    popularity: Number(item.popularity) || 0,
    poster_url: safeHttpsUrl(item.poster_url || item.poster),
    poster_path: typeof item.poster_path === 'string' ? item.poster_path : '',
    backdrop_path: typeof item.backdrop_path === 'string' ? item.backdrop_path : '',
    overview: typeof item.overview === 'string' ? item.overview.slice(0, 5000) : '',
    genre_ids:
      Array.isArray(item.genre_ids) && item.genre_ids.length
        ? item.genre_ids
            .filter((id: any) => Number.isSafeInteger(Number(id)) && Number(id) > 0)
            .map(Number)
        : Array.isArray(item.genres)
        ? item.genres
            .map((g: any) => (typeof g === 'object' && g ? g.id : g))
            .filter((id: any) => Number.isSafeInteger(Number(id)) && Number(id) > 0)
            .map(Number)
        : [],
    genres: Array.isArray(item.genres)
      ? item.genres
          .map((genre: any) => (typeof genre === 'string' ? genre : genre?.name))
          .filter((name: any) => typeof name === 'string')
          .slice(0, 12)
      : [],
    runtime: Number(item.runtime) || 0,
    episode_run_time: Array.isArray(item.episode_run_time)
      ? item.episode_run_time.filter((value: any) => Number.isFinite(Number(value))).map(Number).slice(0, 5)
      : [],
    number_of_seasons: numeric(item.number_of_seasons, 0, 300),
    number_of_episodes: numeric(item.number_of_episodes, 0, 10000),
    season_progress: seasonProgress,
    season_episode_counts: seasonCounts,
    next_episode_to_air: sanitizeNextEpisode(item.next_episode_to_air),
    current_season: numeric(item.current_season, 0, 300) || defaultCurrentSeason(seasonProgress, seasonCounts),
    episodes_watched: totalWatched,
    next_episode: numeric(item.next_episode, 0, 10000),
    status: ['watching', 'watchlist', 'completed'].includes(item.status) ? item.status : 'watchlist',
    personal_rating: validRating || '',
    personal_rating_cleared: validRating ? false : item.personal_rating_cleared === true,
    addedAt: typeof item.addedAt === 'string' ? item.addedAt : '',
    firstAddedAt:
      typeof item.firstAddedAt === 'string'
        ? item.firstAddedAt
        : typeof item.addedAt === 'string'
        ? item.addedAt
        : '',
    totalWatchTimeMinutes:
      Number.isFinite(Number(item.totalWatchTimeMinutes)) && Number(item.totalWatchTimeMinutes) >= 0
        ? Math.floor(Number(item.totalWatchTimeMinutes))
        : undefined,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    custom: Boolean(item.custom || String(item.id).startsWith('custom-')),
    isDemo: item.isDemo === true,
  };
}

/**
 * Robust item lookup in the user's saved list.
 * Matches by ID and media_type, avoiding cross-matching between movies and tv shows with the same numeric ID.
 */
export function findSavedItem(
  savedItems: SavedItem[] | undefined | null,
  item: any
): SavedItem | undefined {
  if (!Array.isArray(savedItems) || !item || item.id == null) return undefined;
  const targetId = String(item.id);
  const targetType =
    item.media_type || (item.title ? 'movie' : (item.name ? 'tv' : undefined));

  // 1. Exact match by ID and media_type if type is known
  if (targetType) {
    const exact = savedItems.find(
      (entry) => String(entry.id) === targetId && entry.media_type === targetType
    );
    if (exact) return exact;
  }

  // 2. Fallback: match by ID alone ONLY when targetType was not specified at all
  if (!targetType) {
    const byId = savedItems.filter((entry) => String(entry.id) === targetId);
    if (byId.length > 0) return byId[0];
  }

  // 3. Fallback: match by title/name if available, respecting media_type if specified
  const rawTitle = (item.title || item.name || '').trim().toLowerCase();
  if (rawTitle) {
    const byTitle = savedItems.filter(
      (entry) =>
        (entry.title || '').trim().toLowerCase() === rawTitle &&
        (!targetType || entry.media_type === targetType)
    );
    if (byTitle.length > 0) {
      return byTitle[0];
    }
  }

  return undefined;
}

/**
 * Checks if an item is already in the user's saved list using standardized makeMediaKey.
 */
export function isItemSaved(
  savedItems: SavedItem[] | undefined | null,
  item: any,
  defaultType?: string
): boolean {
  if (!Array.isArray(savedItems) || !item || item.id == null) return false;
  const itemType = defaultType || item.media_type || (item.title ? 'movie' : (item.name ? 'tv' : 'movie'));
  const itemKey = makeMediaKey(itemType, item.id);
  if (savedItems.some((s) => makeMediaKey(s) === itemKey)) return true;
  const found = findSavedItem(savedItems, { ...item, media_type: itemType });
  return found != null;
}

export function filterHistoryByType(
  savedItems: SavedItem[] | undefined | null,
  mediaType: string = 'all'
): SavedItem[] {
  if (!Array.isArray(savedItems)) return [];
  if (mediaType !== 'movie' && mediaType !== 'tv') return [...savedItems];
  return savedItems.filter((item) => item.media_type === mediaType);
}

export function filterDislikedByType(
  dislikedKeys: string[] | undefined | null,
  mediaType: string = 'all'
): string[] {
  if (!Array.isArray(dislikedKeys)) return [];
  const canonical = canonicalizeMediaKeyList(dislikedKeys);
  if (mediaType !== 'movie' && mediaType !== 'tv') return canonical;
  return canonical.filter((key) => key.startsWith(`${mediaType}:`));
}

export const TARGET_RECOMMENDATION_COUNT = 20;


export function dedupeItems(items: SavedItem[]): SavedItem[] {
  const unique = new Map<string, SavedItem>();
  for (const item of items) {
    const key = makeMediaKey(item);
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, item);
      continue;
    }
    const existingTime = existing.updatedAt || existing.addedAt || '';
    const incomingTime = item.updatedAt || item.addedAt || '';
    const newest = incomingTime > existingTime ? item : existing;
    const older = newest === item ? existing : item;

    let rating = newest.personal_rating;
    let ratingCleared = newest.personal_rating_cleared === true;
    if (!rating && !ratingCleared && older.personal_rating !== '' && Number(older.personal_rating) > 0) {
      rating = older.personal_rating;
    }
    if (rating) ratingCleared = false;
    const isDemo = newest.isDemo === true && older.isDemo === true;
    const normalized = normalizeSavedItem({
      ...newest,
      isDemo,
      status: newest.status,
      personal_rating: rating || '',
      personal_rating_cleared: ratingCleared,
      season_progress: { ...older.season_progress, ...newest.season_progress },
      season_episode_counts: { ...older.season_episode_counts, ...newest.season_episode_counts },
      next_episode_to_air:
        sanitizeNextEpisode(newest.next_episode_to_air) || sanitizeNextEpisode(older.next_episode_to_air),
      addedAt: [existing.addedAt, item.addedAt].filter(Boolean).sort()[0] || '',
      updatedAt: newest.updatedAt || newest.addedAt || '',
    });
    if (normalized) {
      unique.set(key, normalized);
    }
  }
  return [...unique.values()];
}

export function parseBackupText(text: string): {
  items: SavedItem[];
  profileName: string;
  preferences: any;
  favoriteActors: FavoriteActorInfo[];
  isDemo?: boolean;
  schemaVersion: number;
} {
  const backup = JSON.parse(text);
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    throw new Error('Bu dosya geçerli bir CineTrack yedeği değil.');
  }
  if (![1, 2, 3].includes(backup.version)) {
    throw new Error('Bu dosya geçerli bir CineTrack yedeği değil.');
  }

  let rawItems: any[] = [];
  let rawProfileName = '';
  let rawPreferences: any = null;
  let rawFavoriteActors: any[] = [];
  let isDemo = false;

  if (Array.isArray(backup.profiles) && backup.profiles.length > 0) {
    const active =
      backup.profiles.find((p: any) => p && p.id === backup.activeProfileId) || backup.profiles[0];
    if (active) {
      rawItems = Array.isArray(active.items) ? active.items : [];
      rawProfileName = typeof active.name === 'string' ? active.name : '';
      rawPreferences = active.preferences || null;
      rawFavoriteActors = Array.isArray(active.favoriteActors) ? active.favoriteActors : [];
      isDemo = active.isDemo === true;
    }
  } else if (Array.isArray(backup.items)) {
    rawItems = backup.items;
    rawProfileName = typeof backup.profileName === 'string' ? backup.profileName : '';
    rawPreferences = backup.preferences || null;
    rawFavoriteActors = Array.isArray(backup.favoriteActors) ? backup.favoriteActors : [];
    isDemo = backup.isDemo === true;
  } else {
    throw new Error('Bu dosya geçerli bir CineTrack yedeği değil.');
  }

  if (
    rawItems.some(
      (item: any) =>
        !item ||
        typeof item !== 'object' ||
        !validItemId(item.id) ||
        !['movie', 'tv'].includes(item.media_type)
    )
  ) {
    throw new Error('Yedekte geçersiz içerik kimliği veya türü var. Güvenlik nedeniyle içe aktarma durduruldu.');
  }

  const rawSchemaVer = Number(backup.schemaVersion || backup.version);
  const schemaVersion =
    Number.isSafeInteger(rawSchemaVer) && rawSchemaVer > 0 ? rawSchemaVer : CURRENT_SCHEMA_VERSION;
  return {
    items: dedupeItems(rawItems.map(normalizeSavedItem).filter(Boolean) as SavedItem[]),
    profileName: rawProfileName.trim().slice(0, 40),
    preferences:
      rawPreferences && typeof rawPreferences === 'object' && !Array.isArray(rawPreferences)
        ? rawPreferences
        : null,
    favoriteActors: normalizeFavoriteActors(rawFavoriteActors),
    isDemo,
    schemaVersion,
  };
}

export const PROFILE_ID_PATTERN = /^profile-[A-Za-z0-9_-]{1,60}$/;
export const DISLIKED_KEY_PATTERN = /^(?:movie|tv)[:-](?:[1-9]\d{0,11}|custom-[A-Za-z0-9_-]{1,80})$/;

export function normalizePreferences(
  raw: any,
  { knownMoods = null }: { knownMoods?: string[] | null } = {}
): Preferences {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    disliked: Array.isArray(source.disliked)
      ? source.disliked
          .filter((key: any) => typeof key === 'string' && DISLIKED_KEY_PATTERN.test(key))
          .map((key: string) => {
            const parsed = parseMediaKey(key);
            return parsed ? makeMediaKey(parsed.type, parsed.id) : key;
          })
          .slice(-500)
      : [],
    ...(Array.isArray(source.hidden)
      ? {
          hidden: source.hidden
            .filter((key: any) => typeof key === 'string' && DISLIKED_KEY_PATTERN.test(key))
            .map((key: string) => {
              const parsed = parseMediaKey(key);
              return parsed ? makeMediaKey(parsed.type, parsed.id) : key;
            })
            .slice(-500),
        }
      : {}),
    providers: Array.isArray(source.providers)
      ? source.providers
          .filter(
            (id: any) =>
              (typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= 999_999) ||
              (typeof id === 'string' && /^\d{1,6}$/.test(id))
          )
          .map(String)
          .slice(-20)
      : [],
    mood:
      typeof source.mood === 'string'
        ? knownMoods
          ? knownMoods.includes(source.mood)
            ? source.mood
            : ''
          : source.mood.slice(0, 20)
        : '',
    reminders: source.reminders === true,
    notified: Array.isArray(source.notified)
      ? source.notified.filter((key: any) => typeof key === 'string' && key.length <= 200).slice(-200)
      : [],
  };
}

export function normalizeProfile(
  raw: any,
  { maxItems = 100_000, knownMoods = null }: { maxItems?: number; knownMoods?: string[] | null } = {}
): Profile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || !PROFILE_ID_PATTERN.test(raw.id)) return null;
  const items = Array.isArray(raw.items)
    ? (raw.items.map(normalizeSavedItem).filter(Boolean) as SavedItem[])
    : [];
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : 'Profilim',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt.slice(0, 40) : '',
    preferences: normalizePreferences(raw.preferences, { knownMoods }),
    items: dedupeItems(items).slice(0, maxItems),
    favoriteActors: normalizeFavoriteActors(raw.favoriteActors),
    isDemo: raw.isDemo === true,
  };
}

export function normalizeDataDocument(
  raw: any,
  { maxProfiles = 20, maxItems = 100_000 }: { maxProfiles?: number; maxItems?: number } = {}
): DataDocument | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let candidates: any[];
  let activeCandidate = '';
  if (Array.isArray(raw.profiles)) {
    candidates = raw.profiles;
    activeCandidate = typeof raw.activeProfileId === 'string' ? raw.activeProfileId : '';
  } else if (Array.isArray(raw.items)) {
    candidates = [
      {
        id:
          typeof raw.profileId === 'string' && PROFILE_ID_PATTERN.test(raw.profileId)
            ? raw.profileId
            : 'profile-default',
        name: typeof raw.profileName === 'string' ? raw.profileName : 'Profilim',
        createdAt: '',
        preferences: raw.preferences,
        items: raw.items,
        favoriteActors: raw.favoriteActors,
        isDemo: raw.isDemo === true,
      },
    ];
    activeCandidate = candidates[0].id;
  } else {
    return null;
  }
  const profiles: Profile[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (profiles.length >= maxProfiles) break;
    const profile = normalizeProfile(candidate, { maxItems });
    if (!profile || seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push(profile);
  }
  if (!profiles.length) return null;
  const rawRev = Number(raw.revision);
  const rawSchemaVer = Number(raw.schemaVersion || raw.version);
  const schemaVersion =
    Number.isSafeInteger(rawSchemaVer) && rawSchemaVer > 0 ? rawSchemaVer : CURRENT_SCHEMA_VERSION;
  return {
    version: 3,
    schemaVersion,
    engineVersion: ENGINE_VERSION,
    activeProfileId: seen.has(activeCandidate) ? activeCandidate : profiles[0].id,
    profiles,
    revision: Number.isSafeInteger(rawRev) && rawRev > 0 ? rawRev : 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

export function resolveAirDate(item: SavedItem | any): string {
  if (!item || typeof item !== 'object') return '';
  if (item.media_type === 'tv') {
    const next = item.next_episode_to_air;
    if (next?.air_date) return next.air_date;
    return typeof item.first_air_date === 'string' ? item.first_air_date : '';
  }
  return typeof item.release_date === 'string' ? item.release_date : '';
}

export function reminderDaysUntil(airDate: string, today: Date = new Date()): number | null {
  if (typeof airDate !== 'string' || !isValidCalendarDate(airDate)) return null;
  const release = new Date(`${airDate}T00:00:00`);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.ceil((release.getTime() - startOfToday.getTime()) / 86_400_000);
  return days >= 0 && days <= REMINDER_WINDOW_DAYS ? days : null;
}

export function createRequestGate() {
  let current = 0;
  let controller: AbortController | null = null;
  return {
    begin() {
      current += 1;
      controller?.abort();
      controller = new AbortController();
      return { id: current, signal: controller.signal };
    },
    isCurrent(id: number) {
      return id === current;
    },
    invalidate() {
      current += 1;
      controller?.abort();
      controller = null;
    },
  };
}

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
export const clamp11 = (value: number) => Math.min(1, Math.max(-1, value));

export function bayesianRating(
  voteAverage: number | unknown,
  voteCount: number | unknown,
  { prior = 6.5, minVotes = 300 } = {}
): number {
  const average = Number(voteAverage);
  const count = Number(voteCount);
  if (!Number.isFinite(average) || average <= 0) return 5.5;
  if (!Number.isFinite(count) || count <= 0) return 5.5;
  const credibility = Math.min(1, count / minVotes);
  return credibility * average + (1 - credibility) * prior;
}

export function billingWeight(order: number | unknown): number {
  const index = Number(order);
  if (order == null || !Number.isFinite(index) || index < 0) return 0.3;
  if (index <= 2) return 1;
  if (index <= 5) return 0.7;
  if (index <= 9) return 0.45;
  return 0.3;
}

// ---------------------------------------------------------
// Sana Özel v3 — Personalized Recommendation Engine
// ---------------------------------------------------------

export const RECOMMENDATION_WEIGHTS_V3 = Object.freeze({
  genre: 0.16,
  mediaType: 0.03,
  keywords: 0.12,
  story: 0.11,
  lovedSim: 0.09,
  actor: 0.12,
  genreActor: 0.08,
  castHarmony: 0.04,
  director: 0.04,
  quality: 0.08,
  exploration: 0.04,
  popularity: 0.03,
  context: 0.03,
  franchise: 0.01,
  sourceSignal: 0.02,
});

export type RecommendationWeightsV3 = Record<string, number>;

export function actorFrequency(na: number): number {
  const n = Number(na);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // F(a) = min(1, ln(1 + N_a) / ln(1 + 6))
  return Math.min(1, Math.log(1 + n) / Math.log(7));
}

export function pairMatchScore(aScore: number, bScore: number): number {
  const a = Math.max(0, Number(aScore) || 0);
  const b = Math.max(0, Number(bScore) || 0);
  return Math.sqrt(a * b);
}

export function castHarmonyScore(pairScoresSum: number): number {
  const sum = Math.max(0, Number(pairScoresSum) || 0);
  // S_kadro = 0.5 + 0.5 * (1 - e^(-sum))
  return clamp01(0.5 + 0.5 * (1 - Math.exp(-sum)));
}

const COMMON_STOP_WORDS = new Set([
  'bir', 've', 'ile', 'için', 'olan', 'olarak', 'gibi', 'kadar', 'sonra', 'önce', 'daha', 'çok', 'en', 'bu', 'şu', 'o',
  'de', 'da', 'ki', 'ama', 'fakat', 'ancak', 'veya', 'ise', 'her', 'tüm', 'biri', 'the', 'and', 'with', 'from', 'this',
  'that', 'for', 'about', 'after', 'before', 'into', 'over', 'their', 'when', 'which', 'while', 'where'
]);

export function extractOverviewTokens(text: unknown): string[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !COMMON_STOP_WORDS.has(w));
}

export function normalizeUserRating(rating: unknown): number {
  const r = Number(rating);
  if (!Number.isFinite(r)) return 0;
  if (r < 1) return -1;
  if (r > 10) return 1;
  if (r < 5) return (r - 5) / 4;
  return (r - 5) / 5;
}

export function signalDecay(dateStr?: string, halfLifeDays = 365, now = Date.now()): number {
  if (!dateStr || typeof dateStr !== 'string') return 1;
  const time = new Date(dateStr).getTime();
  if (Number.isNaN(time) || time > now) return 1;
  const days = Math.max(0, (now - time) / 86_400_000);
  return Math.pow(2, -days / halfLifeDays);
}

export function getUserSignalV3(item: any, now = Date.now()): { signal: number; weight: number; decay: number } | null {
  if (!item || typeof item !== 'object') return null;

  if (item.status === 'disliked' || item.isDisliked) {
    const decay = signalDecay(item.updatedAt || item.addedAt, 730, now);
    return { signal: -0.8, weight: 1.0, decay };
  }

  const ratingNum = Number(item.personal_rating);
  const hasRating = item.personal_rating !== '' && Number.isFinite(ratingNum) && ratingNum >= 1;

  if (hasRating) {
    const signal = normalizeUserRating(ratingNum);
    const decay = signalDecay(item.updatedAt || item.addedAt, 730, now);
    let weight = 1.0;
    if (item.status === 'completed') weight = 2.5;
    else if (item.status === 'watching') weight = 1.6;
    else if (item.status === 'watchlist') weight = 0.35;
    return { signal, weight, decay };
  }

  if (item.status === 'completed') {
    const decay = signalDecay(item.updatedAt || item.addedAt, 365, now);
    return { signal: 0.4, weight: 2.5, decay };
  }
  if (item.status === 'watching') {
    const decay = signalDecay(item.updatedAt || item.addedAt, 365, now);
    return { signal: 0.2, weight: 1.6, decay };
  }
  if (item.status === 'watchlist') {
    const decay = signalDecay(item.updatedAt || item.addedAt, 365, now);
    return { signal: 0.2, weight: 0.35, decay };
  }

  return null;
}

export interface TasteProfileV3 {
  genres: Record<string, number>;
  actors: Record<string, {
    name: string;
    personal: number;
    rawP: number;
    freq: number;
    nAppearances: number;
    genreScores: Record<string, number>;
  }>;
  directors: Record<string, { name: string; personal: number }>;
  keywords: Record<string, number>;
  mediaPreference: { movie: number; tv: number };
  lovedSeedIds: Set<string>;
  lovedFranchiseIds: Set<number>;
  lovedProductionCompanyIds: Set<number>;
  lovedOverviewTokens: Set<string>;
  positiveGenres: string[];
  coOccurredPairs: Set<string>;
}

export function buildTasteProfileV3(
  items: any[],
  {
    lambda = 1,
    now = Date.now(),
    dislikedKeys = [] as string[],
    filterDemoIfLiveExists = true,
  }: {
    lambda?: number;
    now?: number;
    dislikedKeys?: string[];
    filterDemoIfLiveExists?: boolean;
  } = {}
): TasteProfileV3 {
  const genresAcc: Record<string, { num: number; den: number }> = {};
  const actorsAcc: Record<
    string,
    {
      name: string;
      num: number;
      den: number;
      posAppearances: number;
      negAppearances: number;
      genreAcc: Record<
        string,
        {
          num: number;
          den: number;
          posAppearances: number;
          negAppearances: number;
        }
      >;
    }
  > = {};
  const directorsAcc: Record<string, { name: string; num: number; den: number }> = {};
  const keywordsAcc: Record<string, { num: number; den: number }> = {};
  const typeCounts: Record<string, number> = { movie: 0, tv: 0 };

  const lovedSeedIds = new Set<string>();
  const lovedFranchiseIds = new Set<number>();
  const lovedProductionCompanyIds = new Set<number>();
  const lovedOverviewTokens = new Set<string>();
  const coOccurredPairs = new Set<string>();

  let rawItems: any[] = [...(Array.isArray(items) ? items : [])];

  // Demo vs live ayrımı: Kullanıcı gerçek (canlı) kayıtlı içeriklere sahip olduğunda
  // demo seed içeriklerini profil zevk hesabından tamamen filtrele.
  if (filterDemoIfLiveExists) {
    const hasLiveItems = rawItems.some(
      (it) => it && it.isDemo !== true && !it.isDisliked && (it.personal_rating || it.status)
    );
    if (hasLiveItems) {
      rawItems = rawItems.filter((it) => it && it.isDemo !== true);
    }
  }

  // Incorporate explicit disliked signals if provided as keys
  for (const key of dislikedKeys) {
    if (!key || typeof key !== 'string') continue;
    const parsed = parseMediaKey(key);
    if (!parsed) continue;
    const { type: mediaType, id: idStr } = parsed;
    const id = /^\d+$/.test(idStr) ? Number(idStr) : idStr;
    const existingIndex = rawItems.findIndex(
      (item) => String(item.id) === idStr && item.media_type === mediaType
    );
    const dislikedItem = existingIndex >= 0 ? rawItems[existingIndex] : { id, media_type: mediaType };
    const normalizedDislikedItem = {
      ...dislikedItem,
      status: 'disliked',
      isDisliked: true,
      personal_rating: '',
    };
    if (existingIndex >= 0) rawItems[existingIndex] = normalizedDislikedItem;
    else rawItems.push(normalizedDislikedItem);
  }

  // Deduplicate items so the same production is not counted multiple times
  const seenItemKeys = new Set<string>();
  const allItems: any[] = [];
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const mediaType = item.media_type;
    const id = item.id;
    if (mediaType && id != null) {
      const uKey = makeMediaKey(mediaType, id);
      if (seenItemKeys.has(uKey)) {
        const existingIndex = allItems.findIndex(
          (entry) => makeMediaKey(entry) === uKey
        );
        if ((item.status === 'disliked' || item.isDisliked) && existingIndex >= 0) {
          allItems[existingIndex] = item;
        }
        continue;
      }
      seenItemKeys.add(uKey);
    }
    allItems.push(item);
  }

  for (const item of allItems) {
    const sig = getUserSignalV3(item, now);
    if (!sig) continue;
    const { signal: u, weight: w, decay: d } = sig;
    const effContribution = u * w * d;
    const effWeight = w * d;

    if (item.media_type === 'movie' || item.media_type === 'tv') {
      typeCounts[item.media_type] = (typeCounts[item.media_type] || 0) + (u >= 0 ? effWeight : 0);
    }

    const isLoved = u >= 0.4;
    if (isLoved && item.id != null) {
      lovedSeedIds.add(makeMediaKey(item));
      if (item.belongs_to_collection?.id) {
        lovedFranchiseIds.add(Number(item.belongs_to_collection.id));
      }
      if (Array.isArray(item.production_companies)) {
        for (const company of item.production_companies) {
          if (company?.id) lovedProductionCompanyIds.add(Number(company.id));
        }
      }
      for (const token of extractOverviewTokens(item.overview)) {
        lovedOverviewTokens.add(token);
      }
    }

    // Genres
    const genreIds = Array.isArray(item.genre_ids)
      ? item.genre_ids
      : Array.isArray(item.genres)
      ? item.genres.map((g: any) => (typeof g === 'object' ? g.id : g)).filter(Boolean)
      : [];
    for (const gid of genreIds) {
      const key = String(gid);
      const acc = genresAcc[key] || (genresAcc[key] = { num: 0, den: 0 });
      acc.num += effContribution;
      acc.den += effWeight;
    }

    // Cast
    const cast = Array.isArray(item.cast) ? item.cast : [];

    // Track co-occurred actor pairs in loved/positive items (u >= 0.3)
    if (u >= 0.3 && cast.length >= 2) {
      const topCast = cast.slice(0, 8);
      for (let i = 0; i < topCast.length; i++) {
        const idA = topCast[i]?.id;
        if (idA == null) continue;
        for (let j = i + 1; j < topCast.length; j++) {
          const idB = topCast[j]?.id;
          if (idB == null || idA === idB) continue;
          const minId = Math.min(Number(idA), Number(idB));
          const maxId = Math.max(Number(idA), Number(idB));
          coOccurredPairs.add(`${minId}:${maxId}`);
        }
      }
    }

    cast.forEach((person: any, order: number) => {
      const pid = person?.id;
      if (pid == null || !person.name) return;
      const r = billingWeight(order);
      const bWeight = r * effWeight;
      const bContribution = r * effContribution;
      const appearanceWeight = Math.min(1.5, w / 2.0) * d * r;
      const pKey = String(pid);
      const acc =
        actorsAcc[pKey] ||
        (actorsAcc[pKey] = {
          name: person.name,
          num: 0,
          den: 0,
          posAppearances: 0,
          negAppearances: 0,
          genreAcc: {},
        });
      acc.num += bContribution;
      acc.den += bWeight;
      if (u >= 0) {
        acc.posAppearances += appearanceWeight;
      } else {
        acc.negAppearances += appearanceWeight;
      }

      for (const gid of genreIds) {
        const gKey = String(gid);
        const gAcc =
          acc.genreAcc[gKey] ||
          (acc.genreAcc[gKey] = {
            num: 0,
            den: 0,
            posAppearances: 0,
            negAppearances: 0,
          });
        gAcc.num += bContribution;
        gAcc.den += bWeight;
        if (u >= 0) {
          gAcc.posAppearances += appearanceWeight;
        } else {
          gAcc.negAppearances += appearanceWeight;
        }
      }
    });

    // Directors & Creators
    const crew = Array.isArray(item.crew) ? item.crew : [];
    for (const member of crew) {
      if (member?.id == null || !member.name) continue;
      if (member.job !== 'Director' && member.job !== 'Creator') continue;
      const dKey = String(member.id);
      const acc = directorsAcc[dKey] || (directorsAcc[dKey] = { name: member.name, num: 0, den: 0 });
      acc.num += effContribution;
      acc.den += effWeight;
    }

    // Keywords / Overview tokens
    const tokens = extractOverviewTokens(item.overview);
    for (const token of tokens) {
      const acc = keywordsAcc[token] || (keywordsAcc[token] = { num: 0, den: 0 });
      acc.num += effContribution * 0.5;
      acc.den += effWeight * 0.5;
    }
  }

  // Smooth score formula: P_f = num / (lambda + den)
  const genres: Record<string, number> = {};
  for (const [key, acc] of Object.entries(genresAcc)) {
    genres[key] = Math.min(1, Math.max(-1, acc.num / (lambda + acc.den)));
  }

  // Actor profiles: P_a = sum(w*d*u*r) / sum(w*d*r), F(a) = min(1, ln(1+N_a)/ln(7)), A(a) = P_a * F(a)
  const actors: Record<
    string,
    {
      name: string;
      personal: number;
      rawP: number;
      freq: number;
      nAppearances: number;
      genreScores: Record<string, number>;
    }
  > = {};
  for (const [key, acc] of Object.entries(actorsAcc)) {
    const rawP = acc.den > 0 ? clamp11(acc.num / acc.den) : 0;
    const nAppearances = rawP >= 0 ? acc.posAppearances : acc.negAppearances;
    const freq = actorFrequency(nAppearances);
    const personal = clamp11(rawP * freq);

    const genreScores: Record<string, number> = {};
    for (const [gKey, gAcc] of Object.entries(acc.genreAcc)) {
      const gRawP = gAcc.den > 0 ? clamp11(gAcc.num / gAcc.den) : 0;
      const gN = gRawP >= 0 ? gAcc.posAppearances : gAcc.negAppearances;
      const gFreq = actorFrequency(gN);
      genreScores[gKey] = clamp11(gRawP * gFreq);
    }

    actors[key] = {
      name: acc.name,
      personal,
      rawP,
      freq,
      nAppearances,
      genreScores,
    };
  }

  const directors: Record<string, { name: string; personal: number }> = {};
  for (const [key, acc] of Object.entries(directorsAcc)) {
    directors[key] = {
      name: acc.name,
      personal: Math.min(1, Math.max(-1, acc.num / (lambda + acc.den))),
    };
  }

  const keywords: Record<string, number> = {};
  for (const [key, acc] of Object.entries(keywordsAcc)) {
    if (acc.den >= 0.5) {
      keywords[key] = Math.min(1, Math.max(-1, acc.num / (lambda + acc.den)));
    }
  }

  const totalTypes = typeCounts.movie + typeCounts.tv;
  const positiveGenres = Object.entries(genres)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  return {
    genres,
    actors,
    directors,
    keywords,
    mediaPreference: totalTypes
      ? { movie: typeCounts.movie / totalTypes, tv: typeCounts.tv / totalTypes }
      : { movie: 0.5, tv: 0.5 },
    lovedSeedIds,
    lovedFranchiseIds,
    lovedProductionCompanyIds,
    lovedOverviewTokens,
    positiveGenres,
    coOccurredPairs,
  };
}

/* ============================================================================
 * Aşama 3: Kalıcı Zevk Haritası (Taste Map) ve Konsantrik Halka Takibi (Sorun D & Zevk Haritası)
 * ============================================================================ */

export type LifecycleRing = 'ring0' | 'ring1' | 'ring2';
export type TasteRing = LifecycleRing | 'core' | 'inner' | 'outer' | 'orbit';

export interface TastePillarsSummary {
  genreStoryScore: number;       // 0-100 (Tür ve hikâye: tür, anahtar kelime, özet)
  castCreatorsScore: number;     // 0-100 (Kadro ve yaratıcılar: oyuncu, yönetmen, kadro uyumu)
  discoveryQualityScore: number; // 0-100 (Keşif ve kalite: kalite, popülerlik, yenilik)
}

export function calculateTastePillars(parts: Record<string, number> = {}): TastePillarsSummary {
  // 1. Tür ve hikâye (Tür: genre; Anahtar kelime: keywords; Özet: story, lovedSim)
  const genreVal = parts.genre ?? 0.5;
  const keywordsVal = parts.keywords ?? 0.5;
  const storyVal = parts.story ?? 0.5;
  const lovedSimVal = parts.lovedSim ?? 0.5;
  const genreStoryScore = Math.round(
    (genreVal * 0.35 + keywordsVal * 0.25 + storyVal * 0.25 + lovedSimVal * 0.15) * 100
  );

  // 2. Kadro ve yaratıcılar (Oyuncu: actor; Oyuncu x Tür: genreActor; Yönetmen: director; Kadro uyumu: castHarmony)
  const actorVal = parts.actor ?? 0.5;
  const genreActorVal = parts.genreActor ?? 0.5;
  const directorVal = parts.director ?? 0.5;
  const castHarmonyVal = parts.castHarmony ?? 0.5;
  const castCreatorsScore = Math.round(
    (actorVal * 0.4 + genreActorVal * 0.15 + directorVal * 0.25 + castHarmonyVal * 0.2) * 100
  );

  // 3. Keşif ve kalite (Kalite: quality; Popülerlik: popularity; Yenilik/Bağlam: context, exploration, sourceSignal)
  const qualityVal = parts.quality ?? 0.5;
  const popularityVal = parts.popularity ?? 0.5;
  const contextVal = parts.context ?? 0.5;
  const explorationVal = parts.exploration ?? 0.5;
  const sourceVal = parts.sourceSignal ?? 0.5;
  const discoveryQualityScore = Math.round(
    (qualityVal * 0.4 + popularityVal * 0.2 + contextVal * 0.2 + explorationVal * 0.1 + sourceVal * 0.1) * 100
  );

  return {
    genreStoryScore: Math.max(1, Math.min(100, genreStoryScore)),
    castCreatorsScore: Math.max(1, Math.min(100, castCreatorsScore)),
    discoveryQualityScore: Math.max(1, Math.min(100, discoveryQualityScore)),
  };
}

export const ALGORITHM_VERSION = ENGINE_VERSION;

export function computeWeightsSignature(weights: RecommendationWeightsV3 = RECOMMENDATION_WEIGHTS_V3): string {
  const sortedPairs = Object.entries(weights || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${Number(v).toFixed(2)}`);

  let h = 0x811c9dc5;
  const str = sortedPairs.join(';');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface TasteProfileSignatureOptions {
  targetType?: string;
  algorithmVersion?: string;
  weights?: RecommendationWeightsV3;
}

export function computeTasteProfileSignature(
  savedItems: SavedItem[] = [],
  preferences: Preferences = { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
  favoriteActors: FavoriteActorInfo[] = [],
  options?: TasteProfileSignatureOptions
): string {
  const targetType = options?.targetType || 'all';
  const algorithmVersion = options?.algorithmVersion || ALGORITHM_VERSION;
  const weightsSig = computeWeightsSignature(options?.weights);

  // Demo / Live ayrımı: Kullanıcı gerçek (canlı) içeriklere sahipse, imza canlı içeriklere göre üretilir
  const hasLiveItems = (savedItems || []).some(
    (it) => it && it.isDemo !== true && (it.personal_rating || it.status)
  );
  let effectiveItems = hasLiveItems
    ? (savedItems || []).filter((it) => it && it.isDemo !== true)
    : (savedItems || []);

  // P1 Düzeltmesi — Hedef Türe Göre İzolasyon (Scoped History):
  // Film modunda bir dizi durumunun değişmesi veya dizi modunda film durumunun değişmesi
  // diğer türün imzasını veya önbelleğini geçersizleştirmemelidir!
  if (targetType === 'movie') {
    effectiveItems = effectiveItems.filter((it) => it.media_type === 'movie' || (!it.media_type && !(it as any).name));
  } else if (targetType === 'tv') {
    effectiveItems = effectiveItems.filter((it) => it.media_type === 'tv' || (!it.media_type && (it as any).name));
  }

  const sortedItemTokens = effectiveItems
    .map((it) => {
      const key = makeMediaKey(it);
      const rating = it.personal_rating !== '' && it.personal_rating != null ? String(it.personal_rating) : '0';
      const status = it.status || 'watchlist';
      const updated = it.updatedAt || it.addedAt || '';
      const demoFlag = it.isDemo ? '1' : '0';
      return `${key}:${status}:${rating}:${updated}:${demoFlag}`;
    })
    .sort();

  // Hedef türe göre olumsuz sinyal listesini de filtrele
  let rawDisliked = preferences?.disliked || [];
  if (targetType === 'movie') {
    rawDisliked = rawDisliked.filter((k) => k.startsWith('movie:'));
  } else if (targetType === 'tv') {
    rawDisliked = rawDisliked.filter((k) => k.startsWith('tv:'));
  }

  const sortedDisliked = [...rawDisliked].sort();
  const sortedProviders = [...(preferences?.providers || [])].sort();
  const mood = preferences?.mood || '';
  const sortedFavActors = (favoriteActors || []).map((a) => a.id).sort((a, b) => a - b);

  const fullPayload = [
    `algo:${algorithmVersion}`,
    `weights:${weightsSig}`,
    `target:${targetType}`,
    `items:${sortedItemTokens.join(';')}`,
    `disliked:${sortedDisliked.join(',')}`,
    `providers:${sortedProviders.join(',')}`,
    `mood:${mood}`,
    `favActors:${sortedFavActors.join(',')}`,
  ].join('|');

  // 32-bit FNV-1a hash
  let h = 0x811c9dc5;
  for (let i = 0; i < fullPayload.length; i++) {
    h ^= fullPayload.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hash32 = (h >>> 0).toString(16).padStart(8, '0');

  const ratingsSum = effectiveItems.reduce((acc, it) => acc + (Number(it.personal_rating) || 0), 0);
  return `sig_${algorithmVersion}_${weightsSig}_${targetType}_${effectiveItems.length}_${ratingsSum}_${mood || 'nomood'}_${sortedDisliked.length}_${sortedFavActors.length}_${hash32}`;
}

export interface TasteProfileSummary {
  topGenres: Array<{ id: string; name: string; score: number }>;
  topActors: Array<{ id: string; name: string; score: number; appearances: number }>;
  topDirectors: Array<{ id: string; name: string; score: number }>;
  storyKeywords: string[];
  totalEvaluatedCandidates: number;
  archivedCandidatesCount?: number;
  ringCounts: {
    core: number;
    inner: number;
    outer: number;
    orbit: number;
    ring0?: number;
    ring1?: number;
    ring2?: number;
  };
}

export function buildTasteProfileSummary(
  tasteProfile: TasteProfileV3,
  tasteMap: PersistentTasteMapData,
  genresMap: Record<number | string, string> = {}
): TasteProfileSummary {
  const topGenres = (tasteProfile?.positiveGenres || [])
    .slice(0, 5)
    .map((gid) => ({
      id: String(gid),
      name: genresMap[gid] || `Tür ${gid}`,
      score: Math.round(((tasteProfile?.genres?.[gid] ?? 0.5) + 1) * 50),
    }));

  const topActors = Object.entries(tasteProfile?.actors || {})
    .filter(([, data]) => (data.personal || 0) > 0.05)
    .sort((a, b) => b[1].personal - a[1].personal)
    .slice(0, 6)
    .map(([id, data]) => ({
      id,
      name: data.name,
      score: Math.round((data.personal + 1) * 50),
      appearances: Math.round(data.nAppearances || 1),
    }));

  const topDirectors = Object.entries(tasteProfile?.directors || {})
    .filter(([, data]) => (data.personal || 0) > 0.05)
    .sort((a, b) => b[1].personal - a[1].personal)
    .slice(0, 4)
    .map(([id, data]) => ({
      id,
      name: data.name,
      score: Math.round((data.personal + 1) * 50),
    }));

  const storyKeywords = Array.from(tasteProfile?.lovedOverviewTokens || []).slice(0, 8);

  const ringCounts: {
    core: number;
    inner: number;
    outer: number;
    orbit: number;
    ring0?: number;
    ring1?: number;
    ring2?: number;
  } = { core: 0, inner: 0, outer: 0, orbit: 0, ring0: 0, ring1: 0, ring2: 0 };

  const entries = Object.values(tasteMap?.entries || {});
  for (const entry of entries) {
    const r = entry.ring;
    if (r === 'core' || r === 'inner' || r === 'outer' || r === 'orbit') {
      ringCounts[r]++;
    } else if (r === 'ring0') {
      ringCounts.ring0 = (ringCounts.ring0 || 0) + 1;
      ringCounts.core++;
    } else if (r === 'ring1') {
      ringCounts.ring1 = (ringCounts.ring1 || 0) + 1;
      ringCounts.inner++;
    } else if (r === 'ring2') {
      ringCounts.ring2 = (ringCounts.ring2 || 0) + 1;
      ringCounts.outer++;
    } else {
      ringCounts.orbit++;
    }
  }

  const archivedEntries = Object.values(tasteMap?.archivedEntries || {});

  return {
    topGenres,
    topActors,
    topDirectors,
    storyKeywords,
    totalEvaluatedCandidates: entries.length,
    archivedCandidatesCount: archivedEntries.length,
    ringCounts,
  };
}

export const MAX_IMPRESSION_HISTORY_PER_ENTRY = 30;

export interface TasteMapImpression {
  shownAt: string;
  targetType: string;
  rank?: number;
}

export interface TasteMapEntry {
  mediaKey: string;
  mediaType: 'movie' | 'tv';
  id: number;
  title: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  popularity?: number;
  genre_ids?: number[];
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  matchScore: number;       // Gerçek zevk uyumu (1-100, demotion cezasından etkilenmez: örn 92)
  tasteScore: number;       // Gerçek zevk uyumu (matchScore ile eşdeğer, açık sinyal ayrımı)
  priorityScore: number;    // Gösterim ve seçim önceliği puanı (demotion cezası düşülmüş hali: örn 82)
  rawScore: number;
  ring: TasteRing;
  initialRing: TasteRing;
  pillars?: TastePillarsSummary;
  parts: Record<string, number>;
  tags: string[];
  shownCount: number;
  skippedCount: number;
  ringDemotions: number;
  demotionPenalty: number;
  firstShownAt?: string | null;
  lastShownAt: string | null;
  lastScoredAt: string;
  archivedImpressionCount?: number;
  impressionHistory?: TasteMapImpression[];
  status: 'active' | 'saved' | 'disliked' | 'hidden';
  isArchived?: boolean;
  archivedAt?: string | null;
  archiveReason?: 'evicted_from_pool' | 'status_change' | 'manual';
  scoreCoverage?: 'basic' | 'enriched';
  confidenceLevel?: 'standard' | 'high';
}

export function appendBoundedImpression(
  existingHistory: TasteMapImpression[] = [],
  newImpression: TasteMapImpression,
  existingArchivedCount = 0,
  maxLimit = MAX_IMPRESSION_HISTORY_PER_ENTRY
): {
  history: TasteMapImpression[];
  archivedCount: number;
} {
  const combined = [...existingHistory, newImpression];
  if (combined.length <= maxLimit) {
    return {
      history: combined,
      archivedCount: existingArchivedCount,
    };
  }
  const overflow = combined.length - maxLimit;
  return {
    history: combined.slice(-maxLimit),
    archivedCount: existingArchivedCount + overflow,
  };
}

export function sanitizeTasteMapEntryImpressions(
  entry: TasteMapEntry,
  maxLimit = MAX_IMPRESSION_HISTORY_PER_ENTRY
): TasteMapEntry {
  if (!entry) return entry;
  const history = Array.isArray(entry.impressionHistory) ? entry.impressionHistory : [];
  const firstShownAt = entry.firstShownAt || (history.length > 0 ? history[0].shownAt : null);
  const lastShownAt = entry.lastShownAt || (history.length > 0 ? history[history.length - 1].shownAt : null);
  let archivedImpressionCount = entry.archivedImpressionCount || 0;
  let trimmedHistory = history;

  if (history.length > maxLimit) {
    const overflow = history.length - maxLimit;
    archivedImpressionCount += overflow;
    trimmedHistory = history.slice(-maxLimit);
  }

  return {
    ...entry,
    firstShownAt,
    lastShownAt,
    archivedImpressionCount,
    impressionHistory: trimmedHistory,
  };
}

export function getImpressionSummary(entry?: TasteMapEntry | null): {
  totalShown: number;
  recentCount: number;
  archivedCount: number;
  firstShownAt: string | null;
  lastShownAt: string | null;
} {
  if (!entry) {
    return { totalShown: 0, recentCount: 0, archivedCount: 0, firstShownAt: null, lastShownAt: null };
  }
  const history = Array.isArray(entry.impressionHistory) ? entry.impressionHistory : [];
  const archivedCount = entry.archivedImpressionCount || 0;
  const totalShown = Math.max(entry.shownCount || 0, history.length + archivedCount);
  const firstShownAt = entry.firstShownAt || (history.length > 0 ? history[0].shownAt : null);
  const lastShownAt = entry.lastShownAt || (history.length > 0 ? history[history.length - 1].shownAt : null);

  return {
    totalShown,
    recentCount: history.length,
    archivedCount,
    firstShownAt,
    lastShownAt,
  };
}

export interface TasteProfileSnapshot {
  savedItemCount: number;
  ratingsSum: number;
  dislikedCount: number;
  dislikedHash?: string;
  providerHash?: string;
  mood: string;
  favActorCount: number;
  favActorIds?: number[];
  targetType: string;
  hasLiveItems: boolean;
  algorithmVersion?: string;
  weightsSignature?: string;
  scopedItemCount?: number;
  scopedRatingsSum?: number;
}

export interface PersistentTasteMapData {
  profileId: string;
  profileSignature?: string;
  profileSnapshot?: TasteProfileSnapshot;
  algorithmVersion?: string;
  engineVersion?: string;
  weightsSignature?: string;
  updatedAt: string;
  entries: Record<string, TasteMapEntry>;
  archivedEntries?: Record<string, TasteMapEntry>;
  lastRecommendedKeys: string[];
  lastBatchTimestamp: string | null;
  cachedBalancedItems?: any[];
  lastTargetType?: string;
  lastExplanation?: string;
  summary?: TasteProfileSummary;
}

export function inferLifecycleRing(
  mediaKey: string,
  entry:
    | {
        shownCount?: number;
        skippedCount?: number;
        lastShownAt?: string | null;
      }
    | undefined
    | null,
  lastRecommendedKeys: string[] = []
): LifecycleRing {
  const canonicalTarget = canonicalizeMediaKey(mediaKey);
  if (
    canonicalTarget &&
    Array.isArray(lastRecommendedKeys) &&
    lastRecommendedKeys.some((k) => canonicalizeMediaKey(k) === canonicalTarget)
  ) {
    return 'ring1';
  }

  const hasBeenShown =
    (entry?.shownCount ?? 0) > 0 ||
    (entry?.skippedCount ?? 0) > 0 ||
    Boolean(entry?.lastShownAt);

  return hasBeenShown ? 'ring2' : 'ring0';
}

export function filterOutLastRecommendedCandidates<T>(
  candidates: T[],
  lastRecommendedKeys?: string[] | null
): T[] {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const excluded = new Set(canonicalizeMediaKeyList(lastRecommendedKeys || []));
  if (excluded.size === 0) return [...candidates];

  return candidates.filter((item: any) => {
    if (!item) return false;
    const cand = item.candidate && typeof item.candidate === 'object' ? item.candidate : item;
    if (cand.id == null) return false;
    const key = canonicalizeMediaKey(makeMediaKey(cand));
    return !excluded.has(key);
  });
}

export function normalizeTasteRing(
  ring?: TasteRing | null,
  entry?: { shownCount?: number; skippedCount?: number; lastShownAt?: string | null } | null,
  inLastBatch?: boolean
): LifecycleRing {
  if (inLastBatch) return 'ring1';
  if (entry != null) {
    const hasBeenShown =
      (entry.shownCount ?? 0) > 0 ||
      (entry.skippedCount ?? 0) > 0 ||
      Boolean(entry.lastShownAt);
    return hasBeenShown ? 'ring2' : 'ring0';
  }
  if (ring === 'ring1') return 'ring1';
  if (ring === 'ring2') return 'ring2';
  return 'ring0';
}

export function normalizeTasteMapEntries(
  entries: Record<string, TasteMapEntry>,
  lastRecommendedKeys: string[] = []
): Record<string, TasteMapEntry> {
  if (!entries) return {};
  const normalized: Record<string, TasteMapEntry> = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry) continue;
    const mediaKey = entry.mediaKey || key;
    normalized[key] = {
      ...entry,
      ring: inferLifecycleRing(mediaKey, entry, lastRecommendedKeys),
      initialRing: 'ring0',
    };
  }
  return normalized;
}

export function normalizeTasteMapRings(tasteMap: PersistentTasteMapData): PersistentTasteMapData {
  if (!tasteMap) return tasteMap;
  const lastKeys = Array.isArray(tasteMap.lastRecommendedKeys) ? tasteMap.lastRecommendedKeys : [];
  return {
    ...tasteMap,
    entries: tasteMap.entries ? normalizeTasteMapEntries(tasteMap.entries, lastKeys) : {},
    archivedEntries: tasteMap.archivedEntries ? normalizeTasteMapEntries(tasteMap.archivedEntries, lastKeys) : {},
  };
}

export function assignTasteRing(
  _score?: number,
  context?: { inLastBatch?: boolean; shownCount?: number; skippedCount?: number; lastShownAt?: string | null }
): LifecycleRing {
  if (context?.inLastBatch) return 'ring1';
  if (
    (context?.skippedCount || 0) > 0 ||
    (context?.shownCount || 0) > 0 ||
    Boolean(context?.lastShownAt)
  ) {
    return 'ring2';
  }
  return 'ring0';
}

export function demoteTasteRing(currentRing: TasteRing, steps: number = 1): LifecycleRing {
  if (steps <= 0) {
    if (currentRing === 'ring1') return 'ring1';
    if (currentRing === 'ring2' || currentRing === 'outer' || currentRing === 'orbit') return 'ring2';
    return 'ring0';
  }
  if (currentRing === 'ring0' || currentRing === 'core') {
    return steps >= 2 ? 'ring2' : 'ring1';
  }
  return 'ring2';
}

export function getTasteRingLabel(ring?: TasteRing | null): string {
  switch (ring) {
    case 'ring0':
      return 'Halka 0 — Yeni Eşleşme';
    case 'ring1':
      return 'Halka 1 — Yakın Zamanda Gösterildi';
    case 'ring2':
      return 'Halka 2 — Daha Önce Atlandı';
    case 'core':
      return 'Çekirdek Halka (1. Halka)';
    case 'inner':
      return 'Yakın Halka (2. Halka)';
    case 'outer':
      return 'Dış Halka (3. Halka)';
    case 'orbit':
      return 'Yörünge (4. Halka)';
    default:
      return 'Halka 0 — Yeni Eşleşme';
  }
}

export function getTasteMapStorageKey(profileId: string): string {
  return `cinetrack_taste_map_${profileId}`;
}

export function createDefaultTasteMapData(profileId: string): PersistentTasteMapData {
  return {
    profileId,
    profileSignature: '',
    algorithmVersion: ALGORITHM_VERSION,
    engineVersion: ENGINE_VERSION,
    weightsSignature: computeWeightsSignature(),
    updatedAt: new Date().toISOString(),
    entries: {},
    archivedEntries: {},
    lastRecommendedKeys: [],
    lastBatchTimestamp: null,
  };
}

const MAX_ARCHIVED_TASTE_ENTRIES = 250;
const inMemoryTasteMapFallback = new Map<string, { storageRef: Storage | null; raw: string }>();

function pruneArchivedTasteEntries(
  archived: Record<string, TasteMapEntry>,
  maxEntries = MAX_ARCHIVED_TASTE_ENTRIES
): Record<string, TasteMapEntry> {
  const keys = Object.keys(archived || {});
  if (keys.length <= maxEntries) return archived;

  const sortedKeys = keys.sort((ka, kb) => {
    const a = archived[ka];
    const b = archived[kb];
    const aImportant =
      (a?.status && a.status !== 'active' ? 4 : 0) +
      ((a?.shownCount || 0) > 0 ? 2 : 0) +
      ((a?.skippedCount || 0) > 0 ? 1 : 0);
    const bImportant =
      (b?.status && b.status !== 'active' ? 4 : 0) +
      ((b?.shownCount || 0) > 0 ? 2 : 0) +
      ((b?.skippedCount || 0) > 0 ? 1 : 0);
    if (bImportant !== aImportant) return bImportant - aImportant;
    const ta = String(a?.lastShownAt || a?.lastScoredAt || '');
    const tb = String(b?.lastShownAt || b?.lastScoredAt || '');
    return tb.localeCompare(ta);
  });

  const trimmed: Record<string, TasteMapEntry> = {};
  for (const k of sortedKeys.slice(0, maxEntries)) {
    trimmed[k] = archived[k];
  }
  return trimmed;
}

function compactTasteMapForQuota(data: PersistentTasteMapData): PersistentTasteMapData {
  const lastKeysSet = new Set(canonicalizeMediaKeyList(data.lastRecommendedKeys || []));
  const compactEntries: Record<string, TasteMapEntry> = {};
  for (const [k, v] of Object.entries(data.entries || {})) {
    if (!v) continue;
    compactEntries[k] = {
      ...v,
      overview: lastKeysSet.has(k)
        ? (v.overview || '').slice(0, 320)
        : (v.overview || '').slice(0, 120),
      impressionHistory: Array.isArray(v.impressionHistory) ? v.impressionHistory.slice(-10) : [],
    };
  }

  const prunedArchived = pruneArchivedTasteEntries(data.archivedEntries || {}, 100);
  const compactArchived: Record<string, TasteMapEntry> = {};
  for (const [k, v] of Object.entries(prunedArchived)) {
    if (!v) continue;
    if (v.status === 'active' && (v.shownCount || 0) === 0 && (v.skippedCount || 0) === 0) {
      continue;
    }
    compactArchived[k] = {
      ...v,
      overview: '',
      impressionHistory: Array.isArray(v.impressionHistory) ? v.impressionHistory.slice(-5) : [],
    };
  }

  return {
    ...data,
    entries: compactEntries,
    archivedEntries: compactArchived,
  };
}

export function loadPersistentTasteMap(profileId: string): PersistentTasteMapData {
  try {
    if (typeof localStorage !== 'undefined') {
      const key = getTasteMapStorageKey(profileId);
      const fallback = inMemoryTasteMapFallback.get(key);
      let raw = localStorage.getItem(key);
      if (fallback && fallback.storageRef === localStorage) {
        raw = fallback.raw;
      } else if (fallback && fallback.storageRef !== localStorage) {
        inMemoryTasteMapFallback.delete(key);
      }
      if (raw) {
        const rawParsed = JSON.parse(raw);
        if (rawParsed && typeof rawParsed.entries === 'object') {
          const migration = migratePersistentTasteMapData(rawParsed, MAX_IMPRESSION_HISTORY_PER_ENTRY);
          const parsed = migration.data;
          const lastRecommendedKeys: string[] = canonicalizeMediaKeyList(parsed.lastRecommendedKeys || []);
          let needsMigrationWrite = migration.changed;

          const sanitizedEntries: Record<string, TasteMapEntry> = {};
          for (const [k, v] of Object.entries(parsed.entries || {})) {
            const sanitized = sanitizeTasteMapEntryImpressions(v as TasteMapEntry);
            const mediaKey = canonicalizeMediaKey(sanitized.mediaKey || k);
            const inferredRing = inferLifecycleRing(mediaKey, sanitized, lastRecommendedKeys);
            if (sanitized.ring !== inferredRing || sanitized.initialRing !== 'ring0' || k !== mediaKey) {
              needsMigrationWrite = true;
            }
            sanitizedEntries[mediaKey] = {
              ...sanitized,
              mediaKey,
              ring: inferredRing,
              initialRing: 'ring0',
            };
          }

          const sanitizedArchived: Record<string, TasteMapEntry> = {};
          if (parsed.archivedEntries && typeof parsed.archivedEntries === 'object') {
            for (const [k, v] of Object.entries(parsed.archivedEntries)) {
              const sanitized = sanitizeTasteMapEntryImpressions(v as TasteMapEntry);
              const mediaKey = canonicalizeMediaKey(sanitized.mediaKey || k);
              if (sanitizedEntries[mediaKey]) {
                needsMigrationWrite = true;
                continue;
              }
              const inferredRing = inferLifecycleRing(mediaKey, sanitized, lastRecommendedKeys);
              if (sanitized.ring !== inferredRing || sanitized.initialRing !== 'ring0' || k !== mediaKey) {
                needsMigrationWrite = true;
              }
              sanitizedArchived[mediaKey] = {
                ...sanitized,
                mediaKey,
                ring: inferredRing,
                initialRing: 'ring0',
              };
            }
          }

          const loadedData: PersistentTasteMapData = {
            profileId,
            profileSignature: parsed.profileSignature || '',
            profileSnapshot: parsed.profileSnapshot || undefined,
            algorithmVersion: parsed.algorithmVersion || undefined,
            weightsSignature: parsed.weightsSignature || undefined,
            updatedAt: parsed.updatedAt || new Date().toISOString(),
            entries: sanitizedEntries,
            archivedEntries: sanitizedArchived,
            lastRecommendedKeys,
            lastBatchTimestamp: parsed.lastBatchTimestamp || null,
            cachedBalancedItems: Array.isArray(parsed.cachedBalancedItems) ? parsed.cachedBalancedItems : undefined,
            lastTargetType: parsed.lastTargetType || undefined,
            lastExplanation: parsed.lastExplanation || undefined,
            summary: parsed.summary || undefined,
          };

          if (needsMigrationWrite) {
            savePersistentTasteMap(profileId, loadedData);
          }

          return loadedData;
        }
      }
    }
  } catch {}
  return createDefaultTasteMapData(profileId);
}

export function savePersistentTasteMap(profileId: string, data: PersistentTasteMapData): void {
  const key = getTasteMapStorageKey(profileId);
  const normalizedData: PersistentTasteMapData = {
    ...data,
    lastRecommendedKeys: canonicalizeMediaKeyList(data.lastRecommendedKeys || []),
    archivedEntries: pruneArchivedTasteEntries(data.archivedEntries || {}),
  };

  if (typeof localStorage === 'undefined') return;

  const serialized = JSON.stringify(normalizedData);
  try {
    localStorage.setItem(key, serialized);
    inMemoryTasteMapFallback.delete(key);
    return;
  } catch {
    // Tarayıcı localStorage kotası dolduysa özetleri ve arşivi sıkıştırarak tekrar dene;
    // böylece lastRecommendedKeys ve shownCount asla kaybolmaz.
    const compacted = compactTasteMapForQuota(normalizedData);
    const compactSerialized = JSON.stringify(compacted);
    try {
      localStorage.setItem(key, compactSerialized);
      inMemoryTasteMapFallback.delete(key);
    } catch {
      inMemoryTasteMapFallback.set(key, {
        storageRef: localStorage,
        raw: compactSerialized,
      });
    }
  }
}

export function markTasteMapItemStatus(
  tasteMap: PersistentTasteMapData,
  itemOrKey: any,
  status: 'saved' | 'disliked' | 'hidden' | 'active'
): PersistentTasteMapData {
  if (!tasteMap) return tasteMap;
  const key = typeof itemOrKey === 'string' ? canonicalizeMediaKey(itemOrKey) : makeMediaKey(itemOrKey);
  let changed = false;
  if (tasteMap.entries && tasteMap.entries[key]) {
    tasteMap.entries[key].status = status;
    changed = true;
  }
  if (tasteMap.archivedEntries && tasteMap.archivedEntries[key]) {
    tasteMap.archivedEntries[key].status = status;
    changed = true;
  }
  if (changed) {
    tasteMap.updatedAt = new Date().toISOString();
  }
  return tasteMap;
}

export interface UpdateTasteMapWithBatchParams {
  tasteMap: PersistentTasteMapData;
  newRecommendedItems: any[];
  allPoolCandidates?: any[];
  savedItems: SavedItem[];
  preferences: Preferences;
  favoriteActors?: FavoriteActorInfo[];
  now?: string;
  profileSignature?: string;
  targetType?: string;
  explanation?: string;
  summary?: TasteProfileSummary;
  isFilterChange?: boolean;
  isFilteredView?: boolean;
  reason?: 'filter_change' | 'refresh' | 'navigation' | 'initial';
  normalizeLegacyRings?: boolean;
  pruneInactiveCandidates?: boolean;
  preserveImpressionsWhenEmpty?: boolean;
}

export function updateTasteMapWithBatch({
  tasteMap,
  newRecommendedItems,
  allPoolCandidates,
  savedItems,
  preferences,
  favoriteActors = [],
  now = new Date().toISOString(),
  profileSignature,
  targetType,
  explanation,
  summary,
  isFilterChange = false,
  isFilteredView = false,
  reason,
  normalizeLegacyRings = false,
  pruneInactiveCandidates = true,
  preserveImpressionsWhenEmpty = false,
}: UpdateTasteMapWithBatchParams): PersistentTasteMapData {
  const prevKeys = canonicalizeMediaKeyList(tasteMap.lastRecommendedKeys || []);
  let updatedEntries: Record<string, TasteMapEntry> = {};
  for (const [k, v] of Object.entries(tasteMap.entries || {})) {
    if (v) updatedEntries[canonicalizeMediaKey(k)] = { ...v };
  }
  let updatedArchivedEntries: Record<string, TasteMapEntry> = {};
  for (const [k, v] of Object.entries(tasteMap.archivedEntries || {})) {
    if (v) updatedArchivedEntries[canonicalizeMediaKey(k)] = { ...v };
  }

  if (normalizeLegacyRings) {
    updatedEntries = normalizeTasteMapEntries(updatedEntries, prevKeys);
    updatedArchivedEntries = normalizeTasteMapEntries(updatedArchivedEntries, prevKeys);
  }
  const newKeys = new Set<string>();

  for (const item of newRecommendedItems || []) {
    const cand = item?.candidate || item;
    if (cand && cand.id != null) {
      const key = canonicalizeMediaKey(makeMediaKey(cand));
      if (parseMediaKey(key)) {
        newKeys.add(key);
      }
    }
  }
  const shouldKeepExistingImpressions = preserveImpressionsWhenEmpty && newKeys.size === 0;
  const effectiveNewKeysArray = shouldKeepExistingImpressions ? prevKeys : Array.from(newKeys);
  const newKeysArray = effectiveNewKeysArray;

  // 1. Önceki vitrinde (lastRecommendedKeys) gösterilmiş olan yapımları değerlendir:
  // Filtre değişikliğini “atlandı” sayma kuralı:
  // - Hedef tür değişmişse (ör. 'all' -> 'tv', 'movie' -> 'tv')
  // - Açıkça isFilterChange veya reason === 'filter_change' bayrağı varsa
  // - Adayın türü mevcut targetType filtre kapsamına uymuyorsa (ör. kullanıcı sadece film filtrelediğinde önceki diziler)
  // Bu yapımlar kullanıcı tarafından "atlanmış" (skipped) sayılmaz; sayaç ve ceza artırılmaz!
  const isTargetTypeChanged = Boolean(targetType && tasteMap.lastTargetType && targetType !== tasteMap.lastTargetType);
  const isFilterTriggered = Boolean(
    shouldKeepExistingImpressions || isFilterChange || reason === 'filter_change' || isTargetTypeChanged
  );

  for (const prevKey of prevKeys) {
    const entry = updatedEntries[prevKey] || updatedArchivedEntries[prevKey];
    if (!entry) continue;

    // Durum 1,2,3: Kaydedildiyse
    const [mediaType, rawId] = prevKey.split(':');
    const isSaved = isItemSaved(savedItems, { id: rawId, media_type: mediaType }, mediaType as any);
    if (isSaved) {
      entry.status = 'saved';
      entry.ring = inferLifecycleRing(prevKey, entry, newKeysArray);
      entry.initialRing = 'ring0';
      continue;
    }

    // Durum 4,5: Beğenilmedi / gizlendiyse
    if (preferences.disliked?.includes(prevKey) || preferences.hidden?.includes(prevKey)) {
      entry.status = preferences.disliked?.includes(prevKey) ? 'disliked' : 'hidden';
      entry.ring = inferLifecycleRing(prevKey, entry, newKeysArray);
      entry.initialRing = 'ring0';
      continue;
    }

    const isTypeMismatch = (targetType === 'movie' && mediaType === 'tv') || (targetType === 'tv' && mediaType === 'movie');
    if (isFilterTriggered || isTypeMismatch) {
      // Filtre değişikliğinde veya tür uyuşmazlığında önceki içerikler atlandı sayılmaz
      entry.ring = inferLifecycleRing(prevKey, entry, newKeysArray);
      entry.initialRing = 'ring0';
      continue;
    }

    // Yeni listede yer almadıysa atlandı sayacı artır, doğrudan ring2 olarak işaretle ve ceza uygula
    if (!newKeys.has(prevKey)) {
      entry.skippedCount = (entry.skippedCount || 0) + 1;
      entry.ringDemotions = (entry.ringDemotions || 0) + 1;
      entry.ring = 'ring2';
      entry.initialRing = 'ring0';

      // Demotion ceza puanı: her atlama için 5 puan (maks 35 puan)
      entry.demotionPenalty = Math.min(35, entry.skippedCount * 5);
      // Kural: Zevk Uyumu ile Gösterim Önceliği ayrımı!
      // Gerçek zevk uyumu (tasteScore / matchScore) içeriğin profille olan sabit uyumunu gösterir (örn. %92).
      // Demotion cezası zevk uyumunu düşürmez; yalnızca seçim/gösterim öncelik puanını (priorityScore) düşürür (örn. %87).
      entry.tasteScore = Math.max(1, Math.min(100, Math.round(entry.rawScore)));
      entry.priorityScore = Math.max(1, Math.min(100, Math.round(entry.tasteScore - entry.demotionPenalty)));
      entry.matchScore = entry.tasteScore;
      entry.lastScoredAt = now;
    }
  }

  // 2. Havuz Senkronizasyonu ve Eski Adayları Arşive Taşıma (Pruning):
  // allPoolCandidates sağlandığında, aktif 500 Film + 500 Dizi havuzu kesin olarak tanımlıdır.
  // Güncel havuzda artık yer almayan eski içerikler 'entries' nesnesinden 'archivedEntries' nesnesine taşınır.
  if (Array.isArray(allPoolCandidates) && pruneInactiveCandidates) {
    const activePoolKeys = new Set<string>();
    for (const poolItem of allPoolCandidates) {
      const cand = poolItem?.candidate || poolItem;
      if (cand && cand.id) {
        activePoolKeys.add(makeMediaKey(cand));
      }
    }
    for (const k of newKeys) {
      activePoolKeys.add(k);
    }

    for (const key of Object.keys(updatedEntries)) {
      if (!activePoolKeys.has(key)) {
        const staleEntry = updatedEntries[key];
        updatedArchivedEntries[key] = {
          ...staleEntry,
          ring: inferLifecycleRing(key, staleEntry, newKeysArray),
          initialRing: 'ring0',
          isArchived: true,
          archivedAt: staleEntry.archivedAt || now,
          archiveReason: 'evicted_from_pool',
        };
        delete updatedEntries[key];
      }
    }
  }

  // 3. Havuzdaki her adayın (500 film + 500 dizi) son profil sürümüne ait puanını haritaya kaydet
  // Gösterim geçmişi (shownCount, lastShownAt, impressionHistory) AYRI TUTULUR;
  // yalnızca havuzda bulunup puanlanmış olması kullanıcıya vitrinde gösterildiği anlamına gelmez!
  if (Array.isArray(allPoolCandidates) && allPoolCandidates.length > 0) {
    for (const poolItem of allPoolCandidates) {
      const cand = poolItem.candidate || poolItem;
      if (!cand || !cand.id) continue;
      const key = makeMediaKey(cand);
      const mediaType: 'movie' | 'tv' = cand.media_type === 'tv' ? 'tv' : 'movie';
      const id = Number(cand.id);
      const title = String(cand.title || cand.name || '');

      // Daha önceden entries veya archivedEntries'de varsa geçmişini koru
      const existing = updatedEntries[key] || updatedArchivedEntries[key];
      // Eğer daha önce arşivlenmiş bir içerik havuza geri girdiyse arşivden sil
      if (updatedArchivedEntries[key]) {
        delete updatedArchivedEntries[key];
      }

      const rawScore = Number(poolItem.rawScore ?? poolItem.tasteScore ?? poolItem.score ?? cand.tasteScore ?? cand.rawScore ?? cand.score ?? existing?.rawScore ?? 75);

      const demotionPenalty = existing ? Math.max(0, Number(existing.demotionPenalty) || 0) : Math.max(0, Number(poolItem.demotionPenalty) || 0);
      const ringDemotions = existing ? Math.max(0, Number(existing.ringDemotions) || 0) : Math.max(0, Number(poolItem.ringDemotions) || 0);
      const skippedCount = existing ? Math.max(0, Number(existing.skippedCount) || 0) : Math.max(0, Number(poolItem.skippedCount) || 0);
      const shownCount = existing ? Math.max(0, Number(existing.shownCount) || 0) : 0;
      const firstShownAt = existing?.firstShownAt || existing?.impressionHistory?.[0]?.shownAt || null;
      const lastShownAt = existing?.lastShownAt || null;
      const archivedImpressionCount = existing?.archivedImpressionCount || 0;
      const impressionHistory = existing?.impressionHistory ? [...existing.impressionHistory] : [];

      const ring: LifecycleRing = inferLifecycleRing(
        key,
        { shownCount, skippedCount, lastShownAt },
        newKeysArray
      );
      const initialRing: LifecycleRing = 'ring0';

      // Puan Ayrımı: Zevk Uyumu (tasteScore) vs Gösterim/Seçim Önceliği (priorityScore)
      const tasteScore = Math.max(1, Math.min(100, Math.round(rawScore)));
      const priorityScore = Math.max(1, Math.min(100, Math.round(tasteScore - demotionPenalty)));
      const netMatchScore = tasteScore;

      // Puan Derinliği (Score Coverage): Adayın kadro kredisi var mı?
      const candHasCredits = Boolean(
        (cand.cast && cand.cast.length > 0) ||
        (cand.crew && cand.crew.length > 0) ||
        cand.director ||
        (poolItem.cast && poolItem.cast.length > 0) ||
        poolItem.director
      );
      const scoreCoverage: 'basic' | 'enriched' = (existing?.scoreCoverage === 'enriched' || poolItem.scoreCoverage === 'enriched' || candHasCredits) ? 'enriched' : 'basic';
      const confidenceLevel: 'standard' | 'high' = scoreCoverage === 'enriched' ? 'high' : 'standard';

      const parts = poolItem.parts || poolItem.signalBreakdown || existing?.parts || {};
      const pillars = calculateTastePillars(parts);
      const tags = Array.isArray(poolItem.tags) ? poolItem.tags : existing?.tags || [];

      let status: 'active' | 'saved' | 'disliked' | 'hidden' = existing?.status || 'active';
      const isSaved = isItemSaved(savedItems, { id, media_type: mediaType }, mediaType);
      if (isSaved) {
        status = 'saved';
      } else if (preferences.disliked?.includes(key)) {
        status = 'disliked';
      } else if (preferences.hidden?.includes(key)) {
        status = 'hidden';
      }

      updatedEntries[key] = {
        mediaKey: key,
        mediaType,
        id,
        title,
        poster_path: cand.poster_path || existing?.poster_path || null,
        backdrop_path: cand.backdrop_path || existing?.backdrop_path || null,
        vote_average: Number(cand.vote_average ?? existing?.vote_average ?? 0),
        popularity: Number(cand.popularity ?? existing?.popularity ?? 0),
        genre_ids: Array.isArray(cand.genre_ids) ? cand.genre_ids : existing?.genre_ids || [],
        release_date: cand.release_date || existing?.release_date,
        first_air_date: cand.first_air_date || existing?.first_air_date,
        overview: cand.overview || existing?.overview || '',
        matchScore: netMatchScore,
        tasteScore,
        priorityScore,
        rawScore,
        ring,
        initialRing,
        pillars,
        parts,
        tags,
        shownCount,
        skippedCount,
        ringDemotions,
        demotionPenalty,
        firstShownAt,
        lastShownAt,
        lastScoredAt: now,
        archivedImpressionCount,
        impressionHistory,
        status,
        isArchived: false,
        archivedAt: null,
        scoreCoverage,
        confidenceLevel,
      };
    }
  }

  // 4. Yeni vitrindeki adayı kaydet / güncelle (Vitrinde gösterilen adaylar: shownCount artar, impressionHistory eklenir ve ring1 olur)
  // Depolama güvenliği: impressionHistory dizisi sınırsız büyümez, son MAX_IMPRESSION_HISTORY_PER_ENTRY (30) gösterimle sınırlandırılır.
  for (let i = 0; i < (newRecommendedItems || []).length; i++) {
    const item = newRecommendedItems[i];
    const cand = item.candidate || item;
    if (!cand || !cand.id) continue;
    const key = makeMediaKey(cand);
    const mediaType: 'movie' | 'tv' = cand.media_type === 'tv' ? 'tv' : 'movie';
    const id = Number(cand.id);
    const title = String(cand.title || cand.name || '');
    const existing = updatedEntries[key] || updatedArchivedEntries[key];
    if (updatedArchivedEntries[key]) {
      delete updatedArchivedEntries[key];
    }
    const rawScore = Number(item.rawScore ?? item.tasteScore ?? item.score ?? cand.tasteScore ?? cand.rawScore ?? cand.score ?? existing?.rawScore ?? 75);

    const demotionPenalty = existing ? Math.max(0, Number(existing.demotionPenalty) || 0) : Math.max(0, Number(item.demotionPenalty) || 0);
    const ringDemotions = existing ? Math.max(0, Number(existing.ringDemotions) || 0) : Math.max(0, Number(item.ringDemotions) || 0);
    const skippedCount = existing ? Math.max(0, Number(existing.skippedCount) || 0) : Math.max(0, Number(item.skippedCount) || 0);
    const shownCount = (existing?.shownCount || 0) + 1;
    const firstShownAt = existing?.firstShownAt || existing?.impressionHistory?.[0]?.shownAt || now;

    const { history: impressionHistory, archivedCount: archivedImpressionCount } = appendBoundedImpression(
      existing?.impressionHistory,
      { shownAt: now, targetType: targetType || 'all', rank: i + 1 },
      existing?.archivedImpressionCount || 0,
      MAX_IMPRESSION_HISTORY_PER_ENTRY
    );

    const ring: LifecycleRing = 'ring1';
    const initialRing: LifecycleRing = 'ring0';

    const tasteScore = Math.max(1, Math.min(100, Math.round(rawScore)));
    const priorityScore = Math.max(1, Math.min(100, Math.round(tasteScore - demotionPenalty)));
    const netMatchScore = tasteScore;

    const candHasCredits = Boolean(
      (cand.cast && cand.cast.length > 0) ||
      (cand.crew && cand.crew.length > 0) ||
      cand.director ||
      (item.cast && item.cast.length > 0) ||
      item.director
    );
    const scoreCoverage: 'basic' | 'enriched' = (existing?.scoreCoverage === 'enriched' || item.scoreCoverage === 'enriched' || candHasCredits) ? 'enriched' : 'basic';
    const confidenceLevel: 'standard' | 'high' = scoreCoverage === 'enriched' ? 'high' : 'standard';

    const parts = item.parts || existing?.parts || {};
    const pillars = calculateTastePillars(parts);

    updatedEntries[key] = {
      mediaKey: key,
      mediaType,
      id,
      title,
      poster_path: cand.poster_path || existing?.poster_path || null,
      backdrop_path: cand.backdrop_path || existing?.backdrop_path || null,
      vote_average: Number(cand.vote_average ?? existing?.vote_average ?? 0),
      popularity: Number(cand.popularity ?? existing?.popularity ?? 0),
      genre_ids: Array.isArray(cand.genre_ids) ? cand.genre_ids : existing?.genre_ids || [],
      release_date: cand.release_date || existing?.release_date,
      first_air_date: cand.first_air_date || existing?.first_air_date,
      overview: cand.overview || existing?.overview || '',
      matchScore: netMatchScore,
      tasteScore,
      priorityScore,
      rawScore,
      ring,
      initialRing,
      pillars,
      parts,
      tags: Array.isArray(item.tags) ? item.tags : existing?.tags || [],
      shownCount,
      skippedCount,
      ringDemotions,
      demotionPenalty,
      firstShownAt,
      lastShownAt: now,
      lastScoredAt: now,
      archivedImpressionCount,
      impressionHistory,
      status: 'active',
      isArchived: false,
      archivedAt: null,
      scoreCoverage,
      confidenceLevel,
    };
  }

  // Tüm aktif ve arşiv kayıtlarının yaşam döngüsü halkasını güncel lastRecommendedKeys (newKeysArray) ile tutarlı tut
  for (const [k, entry] of Object.entries(updatedEntries)) {
    entry.ring = inferLifecycleRing(entry.mediaKey || k, entry, newKeysArray);
    entry.initialRing = 'ring0';
  }
  for (const [k, entry] of Object.entries(updatedArchivedEntries)) {
    entry.ring = inferLifecycleRing(entry.mediaKey || k, entry, newKeysArray);
    entry.initialRing = 'ring0';
  }

  // 5. Önemli Profil Alanları Anlık Görüntüsü (Snapshot)
  const hasLiveItems = (savedItems || []).some(
    (it) => it && it.isDemo !== true && (it.personal_rating || it.status)
  );
  const effectiveItems = hasLiveItems
    ? (savedItems || []).filter((it) => it && it.isDemo !== true)
    : (savedItems || []);
  const ratingsSum = effectiveItems.reduce((acc, it) => acc + (Number(it.personal_rating) || 0), 0);

  // P1: Hedef türe göre ayrıştırılmış (scoped) metrikler
  const scopedItems = targetType === 'movie'
    ? effectiveItems.filter((it) => it.media_type === 'movie' || (!it.media_type && !(it as any).name))
    : targetType === 'tv'
    ? effectiveItems.filter((it) => it.media_type === 'tv' || (!it.media_type && (it as any).name))
    : effectiveItems;
  const scopedRatingsSum = scopedItems.reduce((acc, it) => acc + (Number(it.personal_rating) || 0), 0);

  let rawDisliked = preferences?.disliked || [];
  if (targetType === 'movie') {
    rawDisliked = rawDisliked.filter((k) => k.startsWith('movie:'));
  } else if (targetType === 'tv') {
    rawDisliked = rawDisliked.filter((k) => k.startsWith('tv:'));
  }

  const dislikedList = [...rawDisliked].sort();
  const providersList = [...(preferences?.providers || [])].sort();
  const favActorIds = (favoriteActors || []).map((a) => a.id).sort((a, b) => a - b);
  const algorithmVersion = ALGORITHM_VERSION;
  const weightsSignature = computeWeightsSignature();

  const profileSnapshot: TasteProfileSnapshot = {
    savedItemCount: effectiveItems.length,
    ratingsSum,
    scopedItemCount: scopedItems.length,
    scopedRatingsSum,
    dislikedCount: dislikedList.length,
    dislikedHash: dislikedList.join(','),
    providerHash: providersList.join(','),
    mood: preferences?.mood || '',
    favActorCount: favActorIds.length,
    favActorIds,
    targetType: targetType || 'all',
    hasLiveItems,
    algorithmVersion,
    weightsSignature,
  };

  const shouldPreserveBalancedCache =
    shouldKeepExistingImpressions ||
    (isFilteredView && Array.isArray(tasteMap.cachedBalancedItems) && tasteMap.cachedBalancedItems.length > 0);

  const preservedBalancedItems = shouldPreserveBalancedCache
    ? tasteMap.cachedBalancedItems
    : isFilteredView
    ? undefined
    : Array.isArray(newRecommendedItems)
    ? newRecommendedItems.map((entry: any) => {
        if (!entry || typeof entry !== 'object') return entry;
        const cand = entry.candidate || entry;
        const selectionRing: 'ring0' | 'ring2' =
          entry.selectionRing === 'ring2' || entry.ring === 'ring2' || cand?.selectionRing === 'ring2'
            ? 'ring2'
            : 'ring0';
        return {
          ...entry,
          ring: selectionRing,
          selectionRing,
        };
      })
    : newRecommendedItems;

  return {
    profileId: tasteMap.profileId,
    profileSignature: isFilteredView
      ? tasteMap.profileSignature || profileSignature || ''
      : profileSignature ?? tasteMap.profileSignature ?? '',
    profileSnapshot: isFilteredView && tasteMap.profileSnapshot ? tasteMap.profileSnapshot : profileSnapshot,
    algorithmVersion,
    weightsSignature,
    updatedAt: now,
    entries: updatedEntries,
    archivedEntries: pruneArchivedTasteEntries(updatedArchivedEntries),
    lastRecommendedKeys: effectiveNewKeysArray,
    lastBatchTimestamp: shouldKeepExistingImpressions ? tasteMap.lastBatchTimestamp : now,
    cachedBalancedItems: preservedBalancedItems,
    lastTargetType: isFilteredView
      ? tasteMap.lastTargetType || targetType || 'all'
      : targetType || tasteMap.lastTargetType || 'all',
    lastExplanation: explanation || tasteMap.lastExplanation || '',
    summary: summary || tasteMap.summary,
  };
}

/**
 * UI'da bir öneri grubu gösterildiğinde (önbellekten yüklense dahi eksik gösterim kaydı varsa)
 * tüm içeriklerin mediaKey anahtarlarını lastRecommendedKeys dizisine kaydeder ve shownCount değerlerini artırır.
 * Aynı öneri grubu zaten lastRecommendedKeys olarak kayıtlıysa idempotenttir (mükerrer shownCount artışı yapmaz).
 */
export function recordDisplayedRecommendations(
  tasteMap: PersistentTasteMapData,
  displayedItems: any[],
  {
    now = new Date().toISOString(),
    targetType = 'all',
  }: { now?: string; targetType?: string } = {}
): { tasteMap: PersistentTasteMapData; changed: boolean } {
  if (!tasteMap || !Array.isArray(displayedItems) || displayedItems.length === 0) {
    return { tasteMap, changed: false };
  }

  const displayedKeys: string[] = [];
  const seen = new Set<string>();
  const itemByKey = new Map<string, any>();

  for (const item of displayedItems) {
    const cand = item?.candidate || item;
    if (!cand || cand.id == null) continue;
    const key = canonicalizeMediaKey(makeMediaKey(cand));
    if (!parseMediaKey(key) || seen.has(key)) continue;
    seen.add(key);
    displayedKeys.push(key);
    itemByKey.set(key, item);
  }

  if (displayedKeys.length === 0) {
    return { tasteMap, changed: false };
  }

  const existingLastKeys = canonicalizeMediaKeyList(tasteMap.lastRecommendedKeys || []);
  const existingLastSet = new Set(existingLastKeys);
  const sameBatch =
    existingLastKeys.length === displayedKeys.length &&
    displayedKeys.every((k) => existingLastSet.has(k));

  const allAlreadyRecorded =
    sameBatch &&
    displayedKeys.every((k) => {
      const entry = tasteMap.entries?.[k];
      return Boolean(entry && (entry.shownCount || 0) >= 1 && entry.ring === 'ring1');
    });

  if (allAlreadyRecorded) {
    return { tasteMap, changed: false };
  }

  const nextEntries: Record<string, TasteMapEntry> = {};
  for (const [k, v] of Object.entries(tasteMap.entries || {})) {
    if (v) nextEntries[canonicalizeMediaKey(k)] = { ...v };
  }
  const nextArchived: Record<string, TasteMapEntry> = {};
  for (const [k, v] of Object.entries(tasteMap.archivedEntries || {})) {
    if (v) nextArchived[canonicalizeMediaKey(k)] = { ...v };
  }

  for (let i = 0; i < displayedKeys.length; i++) {
    const key = displayedKeys[i];
    const rawItem = itemByKey.get(key);
    const cand = rawItem?.candidate || rawItem;
    const existing = nextEntries[key] || nextArchived[key];
    if (nextArchived[key]) delete nextArchived[key];

    const alreadyCountedInCurrentBatch = Boolean(
      sameBatch && existing && (existing.shownCount || 0) >= 1
    );
    const nextShownCount = alreadyCountedInCurrentBatch
      ? existing.shownCount
      : (existing?.shownCount || 0) + 1;

    const { history: impressionHistory, archivedCount: archivedImpressionCount } =
      alreadyCountedInCurrentBatch
        ? {
            history: existing?.impressionHistory || [],
            archivedCount: existing?.archivedImpressionCount || 0,
          }
        : appendBoundedImpression(
            existing?.impressionHistory,
            { shownAt: now, targetType, rank: i + 1 },
            existing?.archivedImpressionCount || 0,
            MAX_IMPRESSION_HISTORY_PER_ENTRY
          );

    const mediaType: 'movie' | 'tv' = cand?.media_type === 'tv' ? 'tv' : 'movie';
    const rawScore = Number(
      rawItem?.rawScore ?? rawItem?.tasteScore ?? rawItem?.score ?? cand?.tasteScore ?? existing?.rawScore ?? 75
    );
    const tasteScore = Math.max(1, Math.min(100, Math.round(rawScore)));
    const demotionPenalty = Math.max(0, Number(existing?.demotionPenalty) || 0);
    const priorityScore = Math.max(1, Math.min(100, Math.round(tasteScore - demotionPenalty)));

    nextEntries[key] = {
      mediaKey: key,
      mediaType,
      id: Number(cand?.id ?? existing?.id ?? 0),
      title: String(cand?.title || cand?.name || existing?.title || ''),
      poster_path: cand?.poster_path || existing?.poster_path || null,
      backdrop_path: cand?.backdrop_path || existing?.backdrop_path || null,
      vote_average: Number(cand?.vote_average ?? existing?.vote_average ?? 0),
      popularity: Number(cand?.popularity ?? existing?.popularity ?? 0),
      genre_ids: Array.isArray(cand?.genre_ids) ? cand.genre_ids : existing?.genre_ids || [],
      release_date: cand?.release_date || existing?.release_date,
      first_air_date: cand?.first_air_date || existing?.first_air_date,
      overview: cand?.overview || existing?.overview || '',
      matchScore: tasteScore,
      tasteScore,
      priorityScore,
      rawScore,
      ring: 'ring1',
      initialRing: 'ring0',
      pillars: existing?.pillars || calculateTastePillars(rawItem?.parts || existing?.parts || {}),
      parts: rawItem?.parts || existing?.parts || {},
      tags: Array.isArray(rawItem?.tags) ? rawItem.tags : existing?.tags || [],
      shownCount: nextShownCount,
      skippedCount: existing?.skippedCount || 0,
      ringDemotions: existing?.ringDemotions || 0,
      demotionPenalty,
      firstShownAt: existing?.firstShownAt || now,
      lastShownAt: alreadyCountedInCurrentBatch ? existing?.lastShownAt || now : now,
      lastScoredAt: existing?.lastScoredAt || now,
      archivedImpressionCount,
      impressionHistory,
      status: existing?.status || 'active',
      isArchived: false,
      archivedAt: null,
      scoreCoverage: existing?.scoreCoverage || 'basic',
      confidenceLevel: existing?.confidenceLevel || 'standard',
    };
  }

  for (const [k, entry] of Object.entries(nextEntries)) {
    entry.ring = inferLifecycleRing(entry.mediaKey || k, entry, displayedKeys);
    entry.initialRing = 'ring0';
  }
  for (const [k, entry] of Object.entries(nextArchived)) {
    entry.ring = inferLifecycleRing(entry.mediaKey || k, entry, displayedKeys);
    entry.initialRing = 'ring0';
  }

  return {
    changed: true,
    tasteMap: {
      ...tasteMap,
      updatedAt: now,
      entries: nextEntries,
      archivedEntries: pruneArchivedTasteEntries(nextArchived),
      lastRecommendedKeys: displayedKeys,
      lastBatchTimestamp: now,
    },
  };
}

export function getTasteMapEntries(tasteMap?: PersistentTasteMapData | null): TasteMapEntry[] {
  return Object.values(tasteMap?.entries || {});
}

export function getTasteMapArchivedEntries(tasteMap?: PersistentTasteMapData | null): TasteMapEntry[] {
  return Object.values(tasteMap?.archivedEntries || {});
}

export function getTasteMapActiveAndArchivedCounts(tasteMap?: PersistentTasteMapData | null): {
  activeCount: number;
  archivedCount: number;
  totalEvaluated: number;
} {
  const activeCount = Object.keys(tasteMap?.entries || {}).length;
  const archivedCount = Object.keys(tasteMap?.archivedEntries || {}).length;
  return {
    activeCount,
    archivedCount,
    totalEvaluated: activeCount + archivedCount,
  };
}

export function archiveTasteMapEntry(
  tasteMap: PersistentTasteMapData,
  itemOrKey: any,
  reason: 'evicted_from_pool' | 'status_change' | 'manual' = 'manual'
): PersistentTasteMapData {
  if (!tasteMap) return tasteMap;
  const key = typeof itemOrKey === 'string' ? canonicalizeMediaKey(itemOrKey) : makeMediaKey(itemOrKey);
  if (!tasteMap.entries?.[key]) return tasteMap;

  const now = new Date().toISOString();
  const entry = tasteMap.entries[key];
  const newEntries = { ...tasteMap.entries };
  delete newEntries[key];

  const newArchived = {
    ...(tasteMap.archivedEntries || {}),
    [key]: {
      ...entry,
      isArchived: true,
      archivedAt: now,
      archiveReason: reason,
    },
  };

  return {
    ...tasteMap,
    updatedAt: now,
    entries: newEntries,
    archivedEntries: newArchived,
  };
}

export function restoreTasteMapEntry(
  tasteMap: PersistentTasteMapData,
  itemOrKey: any
): PersistentTasteMapData {
  if (!tasteMap) return tasteMap;
  const key = typeof itemOrKey === 'string' ? canonicalizeMediaKey(itemOrKey) : makeMediaKey(itemOrKey);
  if (!tasteMap.archivedEntries?.[key]) return tasteMap;

  const now = new Date().toISOString();
  const entry = tasteMap.archivedEntries[key];
  const newArchived = { ...tasteMap.archivedEntries };
  delete newArchived[key];

  const newEntries = {
    ...(tasteMap.entries || {}),
    [key]: {
      ...entry,
      isArchived: false,
      archivedAt: null,
      archiveReason: undefined,
    },
  };

  return {
    ...tasteMap,
    updatedAt: now,
    entries: newEntries,
    archivedEntries: newArchived,
  };
}

export function recordTasteMapPoolScores({
  tasteMap,
  poolCandidates,
  savedItems,
  preferences,
  favoriteActors = [],
  profileSignature,
  targetType = 'all',
  now = new Date().toISOString(),
  normalizeLegacyRings = false,
}: {
  tasteMap: PersistentTasteMapData;
  poolCandidates: any[];
  savedItems: SavedItem[];
  preferences: Preferences;
  favoriteActors?: FavoriteActorInfo[];
  profileSignature?: string;
  targetType?: string;
  now?: string;
  normalizeLegacyRings?: boolean;
}): PersistentTasteMapData {
  return updateTasteMapWithBatch({
    tasteMap,
    newRecommendedItems: [],
    allPoolCandidates: poolCandidates,
    savedItems,
    preferences,
    favoriteActors,
    now,
    profileSignature,
    targetType,
    normalizeLegacyRings,
    preserveImpressionsWhenEmpty: true,
  });
}

export interface TasteMapCacheValidParams {
  tasteMap: PersistentTasteMapData | null | undefined;
  currentSig: string;
  targetType: string;
  savedItems: SavedItem[];
  preferences: Preferences;
  favoriteActors?: FavoriteActorInfo[];
  forceRefresh?: boolean;
  algorithmVersion?: string;
  weights?: RecommendationWeightsV3;
}

export function isTasteMapCacheValid({
  tasteMap,
  currentSig,
  targetType,
  savedItems,
  preferences,
  favoriteActors = [],
  forceRefresh = false,
  algorithmVersion = ALGORITHM_VERSION,
  weights,
}: TasteMapCacheValidParams): boolean {
  if (forceRefresh) return false;
  if (!tasteMap || !tasteMap.entries) return false;
  if (!Array.isArray(tasteMap.cachedBalancedItems) || tasteMap.cachedBalancedItems.length === 0) return false;
  if (tasteMap.profileSignature !== currentSig) return false;
  if (tasteMap.lastTargetType !== targetType) return false;

  // P1 Düzeltmesi: Algoritma Sürümü ve Ağırlık İmzası Doğrulaması
  // Algoritma veya ağırlıklar değiştiğinde eski puanlar yeni algoritma sonucu gibi sunulamaz!
  const currentWeightsSig = computeWeightsSignature(weights);
  if (tasteMap.algorithmVersion && tasteMap.algorithmVersion !== algorithmVersion) return false;
  if (tasteMap.weightsSignature && tasteMap.weightsSignature !== currentWeightsSig) return false;

  // Önemli Profil Alanları Derin Doğrulaması (Deep Field Validation)
  // Aynı imzaya sahip görünse bile önemli profil alanları değişmişse önbelleği kesinlikle geçersizleştir.
  const hasLiveItems = (savedItems || []).some(
    (it) => it && it.isDemo !== true && (it.personal_rating || it.status)
  );
  const effectiveItems = hasLiveItems
    ? (savedItems || []).filter((it) => it && it.isDemo !== true)
    : (savedItems || []);
  const currentRatingsSum = effectiveItems.reduce((acc, it) => acc + (Number(it.personal_rating) || 0), 0);

  // P1 Düzeltmesi: Hedef türe göre ayrıştırılmış (scoped) metrikler
  // Film modunda bir dizi değiştiğinde film haritası gereksiz geçersizleşmez!
  const scopedItems = targetType === 'movie'
    ? effectiveItems.filter((it) => it.media_type === 'movie' || (!it.media_type && !(it as any).name))
    : targetType === 'tv'
    ? effectiveItems.filter((it) => it.media_type === 'tv' || (!it.media_type && (it as any).name))
    : effectiveItems;
  const currentScopedRatingsSum = scopedItems.reduce((acc, it) => acc + (Number(it.personal_rating) || 0), 0);

  let rawDisliked = preferences?.disliked || [];
  if (targetType === 'movie') {
    rawDisliked = rawDisliked.filter((k) => k.startsWith('movie:'));
  } else if (targetType === 'tv') {
    rawDisliked = rawDisliked.filter((k) => k.startsWith('tv:'));
  }

  const currentDislikedList = [...rawDisliked].sort();
  const currentProvidersList = [...(preferences?.providers || [])].sort();
  const currentFavActorIds = (favoriteActors || []).map((a) => a.id).sort((a, b) => a - b);
  const currentMood = preferences?.mood || '';

  const snap = tasteMap.profileSnapshot;
  if (snap) {
    if (snap.algorithmVersion && snap.algorithmVersion !== algorithmVersion) return false;
    if (snap.weightsSignature && snap.weightsSignature !== currentWeightsSig) return false;
    if (snap.targetType !== targetType) return false;
    if (snap.hasLiveItems !== hasLiveItems) return false;

    // Hedef türe göre scoped alan kontrolü
    if (snap.scopedItemCount != null) {
      if (snap.scopedItemCount !== scopedItems.length) return false;
      if (snap.scopedRatingsSum != null && snap.scopedRatingsSum !== currentScopedRatingsSum) return false;
    } else {
      if (snap.savedItemCount !== effectiveItems.length) return false;
      if (snap.ratingsSum !== currentRatingsSum) return false;
    }

    if (snap.dislikedCount !== currentDislikedList.length) return false;
    if (snap.dislikedHash && snap.dislikedHash !== currentDislikedList.join(',')) return false;
    if (snap.providerHash && snap.providerHash !== currentProvidersList.join(',')) return false;
    if (snap.mood !== currentMood) return false;
    if (snap.favActorCount !== currentFavActorIds.length) return false;
    if (snap.favActorIds && JSON.stringify(snap.favActorIds) !== JSON.stringify(currentFavActorIds)) return false;
  }

  // Önbellekteki yapımlardan herhangi biri kaydedilmiş, beğenilmemiş veya gizlenmiş mi?
  for (const item of tasteMap.cachedBalancedItems) {
    const cand = item.candidate || item;
    const key = makeMediaKey(cand);
    if (preferences?.disliked?.includes(key) || preferences?.hidden?.includes(key)) {
      return false;
    }
    const [mediaType, rawId] = key.split(':');
    if (isItemSaved(savedItems, { id: rawId, media_type: mediaType }, mediaType as any)) {
      return false;
    }
  }

  return true;
}

export function syncPoolCandidatesWithTasteMap(
  poolItems: PoolCandidateItem[],
  tasteMap: PersistentTasteMapData
): PoolCandidateItem[] {
  if (!Array.isArray(poolItems) || !tasteMap) return poolItems;
  return poolItems.map((item) => {
    const key = makeMediaKey(item);
    const entry = tasteMap.entries?.[key] || tasteMap.archivedEntries?.[key];
    if (!entry) return item;
    return {
      ...item,
      matchScore: entry.matchScore,
      tasteScore: entry.tasteScore ?? entry.matchScore,
      priorityScore: entry.priorityScore ?? entry.matchScore,
      scoreCoverage: entry.scoreCoverage,
      confidenceLevel: entry.confidenceLevel,
      rawScore: entry.rawScore,
      ring: entry.ring,
      initialRing: entry.initialRing,
      demotionPenalty: entry.demotionPenalty,
      shownCount: entry.shownCount,
      skippedCount: entry.skippedCount,
      ringDemotions: entry.ringDemotions,
      lastShownAt: entry.lastShownAt,
      lastScoredAt: entry.lastScoredAt,
      tags: entry.tags,
      signalBreakdown: entry.parts,
    };
  });
}

export function scoreCandidatesV3(
  candidates: any[],
  profile: TasteProfileV3,
  {
    weights = RECOMMENDATION_WEIGHTS_V3,
    genreNames = null as Record<number | string, string> | null,
    mood = '',
    tasteMap = null as PersistentTasteMapData | null,
  }: {
    weights?: typeof RECOMMENDATION_WEIGHTS_V3;
    genreNames?: Record<number | string, string> | null;
    mood?: string;
    tasteMap?: PersistentTasteMapData | null;
  } = {}
) {
  const actorOf = (id: any) => profile.actors?.[String(id)] || null;
  const directorOf = (id: any) => profile.directors?.[String(id)] || null;
  const topGenreSet = new Set(profile.positiveGenres.slice(0, 4));
  const canonicalLastRecommendedKeys = canonicalizeMediaKeyList(tasteMap?.lastRecommendedKeys ?? []);
  const lastRecommendedKeySet = new Set(canonicalLastRecommendedKeys);

  return (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const genreIds = (Array.isArray(candidate.genre_ids) ? candidate.genre_ids : []).map(String);
    const cast = (Array.isArray(candidate.cast) ? candidate.cast : []).slice(0, 8);
    const crew = Array.isArray(candidate.crew) ? candidate.crew : [];
    const tokens = extractOverviewTokens(candidate.overview);

    // 1. Tür Profili (0.16)
    const knownGenreScores = genreIds
      .map((gid: string) => profile.genres?.[gid])
      .filter((s: unknown): s is number => typeof s === 'number');
    const genreScore = knownGenreScores.length
      ? clamp01(knownGenreScores.reduce((sum: number, s: number) => sum + (s + 1) / 2, 0) / knownGenreScores.length)
      : 0.5;

    // 2. Film/Dizi Tercihi (0.03)
    const mediaPart =
      candidate.media_type === 'movie'
        ? profile.mediaPreference.movie
        : candidate.media_type === 'tv'
        ? profile.mediaPreference.tv
        : 0.5;
    const mediaScore = clamp01(mediaPart);

    // 3. Anahtar Kelime Benzerliği (0.12)
    let keywordScore = 0.5;
    if (tokens.length > 0) {
      const tokenScores = tokens
        .map((tok) => profile.keywords?.[tok])
        .filter((s): s is number => typeof s === 'number');
      if (tokenScores.length > 0) {
        keywordScore = clamp01(
          tokenScores.reduce((sum, s) => sum + (s + 1) / 2, 0) / tokenScores.length
        );
      }
    }

    // 4. Hikaye Benzerliği (0.11)
    let storyScore = 0.5;
    if (tokens.length > 0 && profile.lovedOverviewTokens.size > 0) {
      const matchCount = tokens.filter((tok) => profile.lovedOverviewTokens.has(tok)).length;
      const ratio = matchCount / Math.max(1, Math.min(tokens.length, 12));
      storyScore = clamp01(0.3 + 0.7 * Math.min(1, ratio * 2));
    }

    // 5. Sevilen Yapımlara Benzerlik (0.09)
    let lovedSimScore = 0.5;
    if (candidate.seedSourceType === 'completed') {
      lovedSimScore = 0.95;
    } else if (candidate.seedSourceType === 'watching') {
      lovedSimScore = 0.85;
    } else if (candidate.seedSourceType === 'watchlist') {
      lovedSimScore = 0.65;
    } else if (candidate.poolSources && candidate.poolSources >= 2) {
      lovedSimScore = 0.75;
    }

    // 6. Genel Oyuncu Tercihi (0.12) & 7. Tür x Oyuncu Tercihi (0.08)
    let actorScore = 0.5;
    let genreActorScore = 0.5;
    let unknownCount = 0;
    if (cast.length > 0) {
      let aNum = 0;
      let aDen = 0;
      let gaNum = 0;
      let gaDen = 0;

      for (const [index, person] of cast.entries()) {
        if (!person || person.id == null) continue;
        const w = billingWeight(index);
        const known = actorOf(person.id);
        if (!known) {
          unknownCount += 1;
        }
        // known.personal in [-1, 1] mapped to [0, 1]
        const personal = known ? clamp01((known.personal + 1) / 2) : 0.5;
        aNum += personal * w;
        aDen += w;

        let genreBlend = personal;
        if (known) {
          const matchingGenre = genreIds.find((gid: string) => typeof known.genreScores?.[gid] === 'number');
          if (matchingGenre) {
            const gScore = clamp01((known.genreScores[matchingGenre] + 1) / 2);
            genreBlend = 0.6 * gScore + 0.4 * personal;
          }
        }
        gaNum += genreBlend * w;
        gaDen += w;
      }

      if (aDen > 0) actorScore = clamp01(aNum / aDen);
      if (gaDen > 0) genreActorScore = clamp01(gaNum / gaDen);
    }

    // 8. Oyuncu Kadrosu Uyumu (0.04) — S_kadro = 0.5 + 0.5 * (1 - e^(-sum(E(a,b))))
    let castHarmonyVal = 0.5;
    if (cast.length >= 2) {
      let pairSum = 0;
      for (let i = 0; i < cast.length; i++) {
        const pA = cast[i];
        if (!pA || pA.id == null) continue;
        const knownA = actorOf(pA.id);
        const Aa = knownA ? knownA.personal : 0;
        if (Aa <= 0) continue;

        for (let j = i + 1; j < cast.length; j++) {
          const pB = cast[j];
          if (!pB || pB.id == null) continue;
          const knownB = actorOf(pB.id);
          const Ab = knownB ? knownB.personal : 0;
          if (Ab <= 0) continue;

          let E = pairMatchScore(Aa, Ab);
          const minId = Math.min(Number(pA.id), Number(pB.id));
          const maxId = Math.max(Number(pA.id), Number(pB.id));
          if (profile.coOccurredPairs?.has(`${minId}:${maxId}`)) {
            E *= 1.25;
          }
          pairSum += E;
        }
      }
      castHarmonyVal = castHarmonyScore(pairSum);
    }

    // 9. Yönetmen / Yaratıcı Tercihi (0.04)
    const directorEntry = crew.find(
      (m: any) => m?.id != null && (m.job === 'Director' || m.job === 'Creator')
    );
    const knownDirector = directorEntry ? directorOf(directorEntry.id) : null;
    const directorScore = knownDirector ? clamp01((knownDirector.personal + 1) / 2) : 0.5;

    // 10. Kalite (0.08) - Bayesian Rating R_B / 10
    const bayes = bayesianRating(candidate.vote_average, candidate.vote_count, { prior: 6.5, minVotes: 300 });
    const qualityScore = clamp01(bayes / 10);

    // 11. Kontrollü Keşif (0.04)
    const isUnknownCast = cast.length > 0 && unknownCount === cast.length;
    const genreOverlap = genreIds.length
      ? genreIds.filter((gid: string) => topGenreSet.has(gid)).length / genreIds.length
      : 0;
    const explorationScore = isUnknownCast
      ? clamp01(0.7 + 0.3 * (1 - genreOverlap))
      : clamp01(0.5 + 0.5 * (1 - genreOverlap));

    // 12. Popülerlik (0.03)
    const pop = Number(candidate.popularity) || 0;
    const popularityScore = clamp01(Math.log10(pop + 1) / 3.5);

    // 13. Bağlam ve Yayın Zamanı (0.03)
    let contextScore = 0.5;
    if (mood) {
      contextScore = 0.75;
    }
    const releaseDate = candidate.release_date || candidate.first_air_date;
    if (releaseDate && typeof releaseDate === 'string') {
      const year = parseInt(releaseDate.slice(0, 4), 10);
      const currentYear = new Date().getFullYear();
      if (year >= currentYear - 2) {
        contextScore = clamp01(contextScore + 0.2);
      }
    }

    // 14. Franchise / Koleksiyon (0.01) — Yapım şirketi kaldırıldı
    let franchiseScore = 0.5;
    if (
      candidate.belongs_to_collection?.id &&
      profile.lovedFranchiseIds.has(Number(candidate.belongs_to_collection.id))
    ) {
      franchiseScore = 1.0;
    }

    // 15. Kaynak Sinyal Gücü (0.02)
    const sourcesCount = Number(candidate.poolSources) || 1;
    const sourceSignalScore = clamp01(Math.min(1, sourcesCount / 2));

    const parts: Record<string, number> = {
      genre: genreScore,
      mediaType: mediaScore,
      keywords: keywordScore,
      story: storyScore,
      lovedSim: lovedSimScore,
      actor: actorScore,
      genreActor: genreActorScore,
      castHarmony: castHarmonyVal,
      director: directorScore,
      quality: qualityScore,
      exploration: explorationScore,
      popularity: popularityScore,
      context: contextScore,
      franchise: franchiseScore,
      sourceSignal: sourceSignalScore,
    };

    // Raw score formula: S_ham = 100 * (sum(w_j * s_j) / sum(w_j))
    const totalWeight = Object.values(weights).reduce((sum, w) => sum + (Number(w) || 0), 0);
    const weightedSum = Object.entries(weights).reduce(
      (sum, [key, w]) => sum + (parts[key] ?? 0.5) * (Number(w) || 0),
      0
    );
    const rawScore = totalWeight > 0 ? (100 * weightedSum) / totalWeight : 50;

    // Generate explanations and tags
    const tags: string[] = [];
    if (candidate.poolReason) tags.push(candidate.poolReason);

    const bestActor = cast
      .map((person: any) => ({ person, known: actorOf(person?.id) }))
      .filter((entry: any) => entry.known && entry.known.personal >= 0.25)
      .sort((a: any, b: any) => b.known.personal - a.known.personal)[0];
    if (bestActor) tags.push(`Sevdiğin ${bestActor.known.name} oynuyor`);

    if (castHarmonyVal >= 0.7) {
      tags.push('Sevdiğin oyuncular bu kadroda buluşuyor');
    }

    const topCandidateGenre = genreIds.find((gid: string) => topGenreSet.has(gid));
    const genreLabel = topCandidateGenre && genreNames ? genreNames[topCandidateGenre] : '';
    if (genreLabel && genreLabel !== candidate.poolReason && !tags.some((t) => t.includes(genreLabel))) {
      tags.push(`${genreLabel} türünü sevdiğin için`);
    }

    if (knownDirector && knownDirector.personal >= 0.25) {
      tags.push(`Sevdiğin yönetmen ${knownDirector.name}`);
    }
    if (franchiseScore >= 0.8) {
      tags.push('Sevdiğin film serisinden');
    }
    if (qualityScore >= 0.72) {
      tags.push(`TMDB'de ${bayes.toFixed(1)} puan`);
    }
    if (explorationScore >= 0.75 && tags.length < 3) {
      tags.push('Yeni keşif için');
    }

    // Sorun D & Zevk Haritası: Yaşam Döngüsü Halkaları (ring0 / ring1 / ring2) ve Geriletme Cezası Entegrasyonu
    const key = canonicalizeMediaKey(makeMediaKey(candidate));
    const legacyKey = `${candidate.media_type === 'tv' ? 'tv' : 'movie'}-${candidate.id}`;
    const tasteEntry =
      (tasteMap?.entries ? tasteMap.entries[key] || tasteMap.entries[legacyKey] : undefined) ??
      (tasteMap?.archivedEntries
        ? tasteMap.archivedEntries[key] || tasteMap.archivedEntries[legacyKey]
        : undefined);

    const inLastBatch = lastRecommendedKeySet.has(key);
    const shownCount = tasteEntry?.shownCount || 0;
    const skippedCount = tasteEntry?.skippedCount || 0;
    const ringDemotions = tasteEntry?.ringDemotions || 0;
    const lastShownAt = tasteEntry?.lastShownAt || null;

    const ring: LifecycleRing = inLastBatch
      ? 'ring1'
      : inferLifecycleRing(key, tasteEntry, canonicalLastRecommendedKeys);
    const demotionPenalty = inLastBatch
      ? 0
      : Math.max(0, Number(tasteEntry?.demotionPenalty) || 0);

    // Puan Derinliği (Score Coverage): Adayın kadro kredisi var mı?
    const hasCredits = Boolean(
      (cast && cast.length > 0) ||
      (crew && crew.length > 0) ||
      candidate.director ||
      (candidate.cast && candidate.cast.length > 0)
    );
    const scoreCoverage: 'basic' | 'enriched' = hasCredits ? 'enriched' : 'basic';
    const confidenceLevel: 'standard' | 'high' = scoreCoverage === 'enriched' ? 'high' : 'standard';

    const tasteScore = Math.max(1, Math.min(100, Math.round(rawScore)));
    const priorityScore = Math.max(1, Math.min(100, Math.round(tasteScore - demotionPenalty)));

    // Sinyalleri ve kalıcı zevk alanlarını doğrudan aday nesnesi üzerine de yaz
    candidate.matchScore = tasteScore; // Rozet ve kartlar saf zevk uyumunu (%92) gösterir!
    candidate.tasteScore = tasteScore;
    candidate.priorityScore = priorityScore;
    candidate.scoreCoverage = scoreCoverage;
    candidate.confidenceLevel = confidenceLevel;
    candidate.rawScore = rawScore;
    candidate.ring = ring;
    candidate.demotionPenalty = demotionPenalty;
    candidate.shownCount = shownCount;
    candidate.skippedCount = skippedCount;
    candidate.ringDemotions = ringDemotions;
    candidate.lastShownAt = lastShownAt;
    candidate.tags = tags.slice(0, 4);
    candidate.signalBreakdown = parts;

    return {
      candidate,
      score: priorityScore, // Seçim algoritmaları (balance / diversify) seçim önceliği puanını (%82) kullanır!
      tasteScore,
      priorityScore,
      matchScore: tasteScore,
      scoreCoverage,
      confidenceLevel,
      rawScore,
      parts,
      tags: tags.slice(0, 4),
      ring,
      demotionPenalty,
      shownCount,
      skippedCount,
      ringDemotions,
      lastShownAt,
    };
  });
}

export interface ActorRecommendationSignalBreakdown {
  actorPresence: number; // 0-30 (temel + kadro sırası/rol puanı)
  actorRoleText: string; // örn: "1. Başrol (#1, +12)"
  multiActorBonus: number; // 0 veya 10
  genreScore: number; // 0-20
  tasteScore: number; // 0-15 (kullanıcı puanları 1-10 ve tür/oyuncu benzerliğinden)
  tasteExplanation: string; // kullanıcıya / geliştiriciye açıklama
  qualityScore: number; // 0-10 (Bayesyen TMDB puanı)
  recencyScore: number; // 0-5
  platformScore: number; // 0-10 (doğrulanmışsa 10/6/3, bilinmiyorsa 5 nötr)
  platformVerified: boolean;
  confidenceScore: number; // 0-100
  confidenceLevel: 'high' | 'medium' | 'low';
  rawTotal: number;
}

export interface ActorRecommendationItem {
  id: number;
  title: string;
  name?: string;
  media_type: 'movie' | 'tv';
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  genre_ids: number[];
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  vote_count: number;
  popularity: number;
  character?: string;
  order?: number;
  matchedActors: Array<{
    id: number;
    name: string;
    character?: string;
    order?: number;
  }>;
  matchScore: number;
  confidenceScore: number;
  confidenceLevel: 'high' | 'medium' | 'low';
  reason: string;
  signalBreakdown: ActorRecommendationSignalBreakdown;
  [key: string]: any;
}

export interface ScoreActorRecommendationsOptions {
  favoriteActors: FavoriteActorInfo[];
  actorCreditsMap: Record<number | string, any[]>;
  savedItems?: any[];
  dislikedKeys?: string[];
  genresMap?: Record<number, string>;
  providerIndex?: Record<string, any[]>;
  preferredProviders?: string[];
  sortMode?: 'best_match' | 'newest' | 'hidden_gems';
  sortBy?: string;
  mediaTypeFilter?: 'all' | 'movie' | 'tv' | string;
  genreFilter?: string;
  enableDiversity?: boolean;
  maxPerGenre?: number;
  limit?: number;
  now?: number;
}

/**
 * Kadro sırasına (TMDB order) göre rol ağırlığı ve etiketi üretir.
 */
export function calculateActorRoleBonus(order?: number): { bonus: number; label: string } {
  if (order === 0) return { bonus: 12, label: '1. Başrol (#1)' };
  if (order === 1 || order === 2) return { bonus: 10, label: `Başrol (#${order + 1})` };
  if (order === 3 || order === 4) return { bonus: 7, label: `Ana Kadro (#${order + 1})` };
  if (typeof order === 'number' && order >= 5 && order <= 9) return { bonus: 4, label: `Yardımcı Rol (#${order + 1})` };
  if (typeof order === 'number' && order >= 10) return { bonus: 1, label: `Küçük Rol / Konuk (#${order + 1})` };
  return { bonus: 3, label: 'Kadroda' };
}

/**
 * Favori oyuncu önerilerinde aynı tür yığılmasını önlemek için çeşitlilik uygular.
 */
export function diversifyActorRecommendations(
  items: ActorRecommendationItem[],
  { maxPerGenre = 3, limit = 50 }: { maxPerGenre?: number; limit?: number } = {}
): ActorRecommendationItem[] {
  if (!Array.isArray(items) || items.length <= maxPerGenre) return items;

  const picked: ActorRecommendationItem[] = [];
  const deferred: ActorRecommendationItem[] = [];
  const genreCounts: Record<number, number> = {};

  for (const item of items) {
    const dominantGenre = item.genre_ids?.[0];
    if (dominantGenre != null) {
      const count = genreCounts[dominantGenre] || 0;
      if (count >= maxPerGenre) {
        deferred.push(item);
        continue;
      }
      genreCounts[dominantGenre] = count + 1;
    }
    picked.push(item);
    if (picked.length >= limit) break;
  }

  return [...picked, ...deferred].slice(0, limit);
}

export type ActorFetchStatusCode = 'idle' | 'loading' | 'success' | 'error' | 'empty';

export interface ActorFetchStatus {
  actorId: number;
  actorName: string;
  status: ActorFetchStatusCode;
  creditsCount: number;
  error?: string;
  updatedAt: number;
}

export interface FetchActorCreditsBatchOptions {
  concurrency?: number;
  signal?: AbortSignal;
  ticketId?: number;
  isCurrentTicket?: (ticketId: number) => boolean;
  force?: boolean;
  onActorStatusChange?: (status: ActorFetchStatus) => void;
  fetchTmdbFn?: (path: string, params?: Record<string, string>, signal?: AbortSignal, ttl?: number) => Promise<any>;
}

export interface FetchActorCreditsBatchResult {
  creditsMap: Record<number, any[]>;
  statuses: Record<number, ActorFetchStatus>;
  completedCount: number;
  errorCount: number;
  emptyCount: number;
}

// In-flight istek paylaşımı haritası: Aynı oyuncu için eşzamanlı istekleri tek Promise altında birleştirir
const inFlightActorCredits = new Map<number, Promise<{ cast: any[]; error?: string }>>();

export function getInFlightActorCreditsCount(): number {
  return inFlightActorCredits.size;
}

export function clearInFlightActorCredits(): void {
  inFlightActorCredits.clear();
}

/**
 * Favori oyuncuların filmografilerini (combined_credits) sınırlı kuyruk (bounded queue),
 * oyuncu bazında durum takibi, in-flight istek paylaşımı ve eski yanıt korumasıyla çeker.
 */
export async function fetchActorCreditsBatch(
  favoriteActors: FavoriteActorInfo[],
  options: FetchActorCreditsBatchOptions = {}
): Promise<FetchActorCreditsBatchResult> {
  const {
    concurrency = 3,
    signal,
    ticketId,
    isCurrentTicket,
    force = false,
    onActorStatusChange,
    fetchTmdbFn,
  } = options;

  const creditsMap: Record<number, any[]> = {};
  const statuses: Record<number, ActorFetchStatus> = {};
  let completedCount = 0;
  let errorCount = 0;
  let emptyCount = 0;

  if (!Array.isArray(favoriteActors) || favoriteActors.length === 0) {
    return { creditsMap, statuses, completedCount: 0, errorCount: 0, emptyCount: 0 };
  }

  // 1. Oyuncu bazında başlangıç durumlarını (loading) oluştur ve bildir
  const now = Date.now();
  for (const actor of favoriteActors) {
    if (!actor || !actor.id) continue;
    statuses[actor.id] = {
      actorId: actor.id,
      actorName: actor.name || `Oyuncu #${actor.id}`,
      status: 'loading',
      creditsCount: 0,
      updatedAt: now,
    };
    onActorStatusChange?.(statuses[actor.id]);
  }

  // Eski yanıtları engelleme kontrolü (Ticket Gate)
  if (ticketId != null && isCurrentTicket && !isCurrentTicket(ticketId)) {
    return { creditsMap, statuses, completedCount: 0, errorCount: 0, emptyCount: 0 };
  }

  // 2. Sınırlı Kuyruk (Bounded Concurrency Queue): Eşzamanlı istek sayısını sınırla (varsayılan: 3)
  const validActors = favoriteActors.filter((a) => a && a.id);
  const queueLimit = Math.max(1, Math.min(concurrency, 6));
  let cursor = 0;

  const worker = async () => {
    while (cursor < validActors.length) {
      if (signal?.aborted) break;
      if (ticketId != null && isCurrentTicket && !isCurrentTicket(ticketId)) break;

      const actor = validActors[cursor++];
      const actorId = actor.id;

      // 3. In-flight istek paylaşımı: Aynı oyuncu için halihazırda süren istek varsa mükerrer tetikleme
      let creditPromise = inFlightActorCredits.get(actorId);
      if (!creditPromise) {
        creditPromise = (async () => {
          let lastError: any = null;
          try {
            // Önce Türkçe ardından İngilizce yedek (Language fallback)
            let data: any = null;
            const fetcher = fetchTmdbFn || (async (p: string, params?: Record<string, string>) => {
              const res = await fetch(`/api/tmdb?path=${encodeURIComponent(p)}&${new URLSearchParams(params || {}).toString()}`);
              return res.json();
            });

            if (!force) {
              try {
                data = await fetcher(`/person/${actorId}/combined_credits`, { language: 'tr-TR' });
              } catch (e) {
                lastError = e;
              }
            }
            if (!data || !Array.isArray(data.cast) || data.cast.length === 0) {
              try {
                data = await fetcher(`/person/${actorId}/combined_credits`, { language: 'en-US' });
              } catch (e) {
                lastError = e;
              }
            }

            if (data && Array.isArray(data.cast)) {
              return { cast: data.cast };
            }
            if (lastError && (!data || !Array.isArray(data.cast))) {
              return { cast: [], error: lastError?.message || 'Bağlantı hatası' };
            }
            return { cast: [] };
          } catch (err: any) {
            return { cast: [], error: err?.message || 'Bağlantı hatası' };
          }
        })().finally(() => {
          inFlightActorCredits.delete(actorId);
        });

        inFlightActorCredits.set(actorId, creditPromise);
      }

      const res = await creditPromise;

      // 4. Eski yanıtları engelleme: Eğer yeni bir ticket başlatıldıysa veya iptal edildiyse sonucu yut
      if (ticketId != null && isCurrentTicket && !isCurrentTicket(ticketId)) {
        return;
      }
      if (signal?.aborted) {
        return;
      }

      // 5. Oyuncu bazında durum güncellemesi
      const cast = Array.isArray(res.cast) ? res.cast : [];
      creditsMap[actorId] = cast;

      let status: ActorFetchStatusCode = 'success';
      if (res.error) {
        status = 'error';
        errorCount++;
      } else if (cast.length === 0) {
        status = 'empty';
        emptyCount++;
      } else {
        status = 'success';
        completedCount++;
      }

      statuses[actorId] = {
        actorId,
        actorName: actor.name || `Oyuncu #${actorId}`,
        status,
        creditsCount: cast.length,
        error: res.error,
        updatedAt: Date.now(),
      };

      onActorStatusChange?.(statuses[actorId]);
    }
  };

  const runners = Array.from({ length: Math.min(queueLimit, validActors.length) }, () => worker());
  await Promise.all(runners);

  return { creditsMap, statuses, completedCount, errorCount, emptyCount };
}

export interface ActorChipDisplayState {
  state: 'loading' | 'pending' | 'error' | 'empty' | 'success';
  title: string;
  creditsCount: number;
}

export function describeActorFetchChipState(
  actor: Partial<FavoriteActorInfo> | null | undefined,
  status?: ActorFetchStatus | null,
  isBatchLoading = false
): ActorChipDisplayState {
  const actorName = String(actor?.name || 'Oyuncu').trim() || 'Oyuncu';
  if (!status) {
    if (isBatchLoading) {
      return {
        state: 'loading',
        title: `${actorName}: Kuyrukta yükleniyor...`,
        creditsCount: 0,
      };
    }
    return {
      state: 'pending',
      title: `${actorName}: Filmografi verisi hazırlanıyor...`,
      creditsCount: 0,
    };
  }

  if (status.status === 'loading') {
    return {
      state: 'loading',
      title: `${actorName}: Kuyrukta yükleniyor...`,
      creditsCount: 0,
    };
  }

  if (status.status === 'error') {
    return {
      state: 'error',
      title: `${actorName}: ${status.error || 'Hata'}`,
      creditsCount: 0,
    };
  }

  if (status.status === 'empty') {
    return {
      state: 'empty',
      title: `${actorName}: Filmografide uygun içerik bulunamadı`,
      creditsCount: 0,
    };
  }

  const count = Math.max(0, Number(status.creditsCount) || 0);
  return {
    state: 'success',
    title: `${actorName}: ${count} yapım yüklendi`,
    creditsCount: count,
  };
}

/**
 * Favori oyuncuların yer aldığı, kullanıcının henüz izlemediği / listesine eklemediği
 * yapımları bir havuzda toplayıp sinyal ağırlıklarına göre puanlar.
 */
export function scoreActorRecommendations(options: ScoreActorRecommendationsOptions): ActorRecommendationItem[] {
  const {
    favoriteActors = [],
    actorCreditsMap = {},
    savedItems = [],
    dislikedKeys = [],
    genresMap = {},
    providerIndex = {},
    preferredProviders = [],
    sortMode = 'best_match',
    sortBy,
    mediaTypeFilter = 'all',
    genreFilter = '',
    enableDiversity = true,
    maxPerGenre = 3,
    limit,
    now = Date.now(),
  } = options;

  if (!Array.isArray(favoriteActors) || favoriteActors.length === 0) {
    return [];
  }

  // 1. Kullanıcının sevdiği türleri analiz et
  const userGenreWeightMap: Record<number, number> = {};
  for (const item of savedItems) {
    if (!item) continue;
    let weight = 1;
    const rating = Number(item.personal_rating);
    if (Number.isFinite(rating) && rating >= 7) weight = 2.5;
    else if (item.status === 'completed') weight = 1.8;
    else if (item.status === 'watching') weight = 1.2;
    else if (item.status === 'disliked' || item.isDisliked) weight = -2;

    const gids: number[] = Array.isArray(item.genre_ids)
      ? item.genre_ids
      : Array.isArray(item.genres)
      ? item.genres.map((g: any) => g?.id).filter(Boolean)
      : [];
    for (const gid of gids) {
      userGenreWeightMap[gid] = (userGenreWeightMap[gid] || 0) + weight;
    }
  }

  const topGenreIds = Object.entries(userGenreWeightMap)
    .filter(([, val]) => val > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => Number(id));

  // 2. Kullanıcının gerçek puan sinyallerini topla (1-10)
  const userRatings = savedItems
    .map((it) => {
      const rating = Number(it.personal_rating);
      if (!Number.isFinite(rating) || rating < 1 || rating > 10) return null;
      const gids: number[] = Array.isArray(it.genre_ids)
        ? it.genre_ids
        : Array.isArray(it.genres)
        ? it.genres.map((g: any) => g?.id).filter(Boolean)
        : [];
      const actors: number[] = Array.isArray(it.cast)
        ? it.cast.map((c: any) => c?.id).filter(Boolean)
        : [];
      return { rating, genres: gids, actors, status: it.status };
    })
    .filter(Boolean) as Array<{ rating: number; genres: number[]; actors: number[]; status: string }>;

  // Disliked set
  const dislikedSet = new Set<string>();
  for (const k of dislikedKeys || []) {
    dislikedSet.add(k);
    const parsed = parseMediaKey(k);
    if (parsed) {
      dislikedSet.add(makeMediaKey(parsed.type, parsed.id));
      dislikedSet.add(`${parsed.type}-${parsed.id}`);
    }
  }

  // 3. Havuz oluştur: her oyuncunun combined_credits listesini birleştir
  const candidatesMap = new Map<string, any>();

  for (const actor of favoriteActors) {
    if (!actor || !actor.id) continue;
    const credits = actorCreditsMap[actor.id] || [];
    if (!Array.isArray(credits)) continue;

    for (const credit of credits) {
      if (!credit || !credit.id) continue;
      const mediaType: 'movie' | 'tv' = credit.media_type === 'tv' ? 'tv' : 'movie';
      if (
        (mediaTypeFilter === 'movie' || mediaTypeFilter === 'tv') &&
        mediaType !== mediaTypeFilter
      ) {
        continue;
      }
      if (genreFilter && !matchesSelectedGenre({ ...credit, media_type: mediaType }, genreFilter)) {
        continue;
      }
      const key = makeMediaKey(mediaType, credit.id);

      const title = String(credit.title || credit.name || '').trim();
      if (!title) continue;

      // Kullanıcının kayıtlı listesinde var mı?
      if (findSavedItem(savedItems, credit)) {
        continue;
      }

      // İlgilenilmeyenlerde var mı?
      if (dislikedSet.has(key) || dislikedSet.has(`${mediaType}-${credit.id}`)) {
        continue;
      }

      const actorEntry = {
        id: actor.id,
        name: actor.name,
        character: credit.character || '',
        order: typeof credit.order === 'number' ? credit.order : undefined,
      };

      if (candidatesMap.has(key)) {
        const existing = candidatesMap.get(key);
        if (!existing.matchedActors.some((a: any) => a.id === actor.id)) {
          existing.matchedActors.push(actorEntry);
        }
      } else {
        candidatesMap.set(key, {
          ...credit,
          id: credit.id,
          media_type: mediaType,
          title,
          matchedActors: [actorEntry],
        });
      }
    }
  }

  const currentYear = new Date(now).getFullYear();

  // 4. Her adayı sinyallere göre puanla
  const results: ActorRecommendationItem[] = [];

  for (const candidate of candidatesMap.values()) {
    const matchedCount = candidate.matchedActors.length;

    // Sinyal 1: Favori oyuncu varlığı ve TMDB kadro sırası / rol verisi (30 puan)
    // En iyi role sahip favori oyuncunun kadro sırasını baz al
    let bestRole = { bonus: 3, label: 'Kadroda' };
    for (const actor of candidate.matchedActors) {
      const r = calculateActorRoleBonus(actor.order);
      if (r.bonus > bestRole.bonus) {
        bestRole = r;
      }
    }
    const actorPresenceScore = 18 + bestRole.bonus; // 19 ile 30 puan arası
    const actorRoleText = bestRole.label;

    // Sinyal 2: Birden fazla favori oyuncu (+10 bonus)
    const multiActorBonus = matchedCount > 1 ? 10 : 0;

    // Sinyal 3: Kullanıcının sevdiği türlere uyum (20 puan)
    const cGenres: number[] = Array.isArray(candidate.genre_ids)
      ? candidate.genre_ids
      : Array.isArray(candidate.genres)
      ? candidate.genres.map((g: any) => g?.id).filter(Boolean)
      : [];

    let genreScore = 10;
    let matchedGenreName = '';
    if (topGenreIds.length > 0 && cGenres.length > 0) {
      const matchCount = cGenres.filter((gid) => topGenreIds.includes(gid)).length;
      if (matchCount > 0) {
        genreScore = Math.min(20, 12 + matchCount * 4);
        const topGid = cGenres.find((gid) => topGenreIds.includes(gid));
        if (topGid && genresMap[topGid]) {
          matchedGenreName = genresMap[topGid];
        }
      } else {
        genreScore = 6;
      }
    } else if (cGenres.length > 0 && genresMap[cGenres[0]]) {
      matchedGenreName = genresMap[cGenres[0]];
    }

    // Sinyal 4: tasteScore — Gerçek kullanıcı puanlarına (1-10) ve tür/oyuncu benzerliğine bağlı (15 puan)
    let tasteScore = 7.5;
    let tasteExplanation = 'Kullanıcı puan geçmişi dengeli kabul edildi';

    const matchingGenreRatings = userRatings
      .filter((r) => r.genres.some((gid) => cGenres.includes(gid)))
      .map((r) => r.rating);

    const matchedActorIds = new Set(candidate.matchedActors.map((a: any) => a.id));
    const matchingActorRatings = userRatings
      .filter((r) => r.actors.some((aid) => matchedActorIds.has(aid)))
      .map((r) => r.rating);

    if (matchingActorRatings.length > 0 || matchingGenreRatings.length > 0) {
      let avgRating = 7;
      if (matchingActorRatings.length > 0 && matchingGenreRatings.length > 0) {
        const actorAvg = matchingActorRatings.reduce((a, b) => a + b, 0) / matchingActorRatings.length;
        const genreAvg = matchingGenreRatings.reduce((a, b) => a + b, 0) / matchingGenreRatings.length;
        avgRating = actorAvg * 0.6 + genreAvg * 0.4;
        tasteExplanation = `Oyuncunun yer aldığı filmlere verdiğin puanlar (${actorAvg.toFixed(1)}/10) ve ${matchedGenreName || 'tür'} puanlarınla (${genreAvg.toFixed(1)}/10) hesaplandı`;
      } else if (matchingActorRatings.length > 0) {
        avgRating = matchingActorRatings.reduce((a, b) => a + b, 0) / matchingActorRatings.length;
        tasteExplanation = `Favori oyuncunun diğer yapımlarına verdiğin ortalama ${avgRating.toFixed(1)}/10 puanla hesaplandı`;
      } else {
        avgRating = matchingGenreRatings.reduce((a, b) => a + b, 0) / matchingGenreRatings.length;
        tasteExplanation = `${matchedGenreName || 'Bu tür'} yapımlara verdiğin ortalama ${avgRating.toFixed(1)}/10 kullanıcı puanıyla hesaplandı`;
      }

      const normalized = Math.max(0, Math.min(1, (avgRating - 1) / 9));
      tasteScore = Math.round(normalized * 15 * 10) / 10;
    } else if (userRatings.length > 0) {
      const globalAvg = userRatings.reduce((a, b) => a + b.rating, 0) / userRatings.length;
      const normalized = Math.max(0, Math.min(1, (globalAvg - 1) / 9));
      tasteScore = Math.round(normalized * 15 * 10) / 10;
      tasteExplanation = `Genel kullanıcı puan ortalaman (${globalAvg.toFixed(1)}/10) baz alındı`;
    } else if (savedItems.length > 0) {
      if (genreScore >= 16) {
        tasteScore = 13;
        tasteExplanation = 'İzleme listendeki tür yoğunluğuna göre yüksek ilgi tahmin edildi';
      } else if (genreScore <= 6) {
        tasteScore = 6;
        tasteExplanation = 'İzleme listendeki tür yoğunluğuyla kısmi eşleşme';
      } else {
        tasteScore = 9;
        tasteExplanation = 'İzleme listendeki yapımlara göre ortalama ilgi tahmin edildi';
      }
    }

    // Sinyal 5: Genel içerik kalitesi ve oy sayısı (10 puan)
    const vAvg = Number(candidate.vote_average) || 0;
    const vCnt = Number(candidate.vote_count) || 0;
    const bayes = bayesianRating(vAvg, vCnt, { prior: 6.5, minVotes: 200 });
    const qualityScore = Math.round(clamp01((bayes - 4.5) / 4.0) * 10 * 10) / 10;

    // Sinyal 6: Yenilik / güncellik (5 puan)
    const releaseDate = candidate.release_date || candidate.first_air_date || '';
    let recencyScore = 2;
    if (releaseDate) {
      const relYear = parseInt(releaseDate.substring(0, 4), 10);
      if (Number.isFinite(relYear)) {
        if (relYear >= currentYear) recencyScore = 5;
        else if (relYear >= currentYear - 2) recencyScore = 4;
        else if (relYear >= currentYear - 5) recencyScore = 3;
        else if (relYear >= currentYear - 10) recencyScore = 2;
        else recencyScore = 1;
      }
    }

    // Sinyal 7: İzleme platformu — Doğrulanmışsa puan ver, bilinmiyorsa nötr bırak (10 puan)
    const key = makeMediaKey(candidate);
    const rawProviders = candidate.watch_providers || candidate.providers || providerIndex?.[key] || null;

    let platformScore = 5; // Nötr başlangıç
    let platformVerified = false;

    if (rawProviders && Array.isArray(rawProviders) && rawProviders.length > 0) {
      platformVerified = true;
      const userPreferredSet = new Set((preferredProviders || []).map(String));
      const candidateProviderIds = rawProviders.map((p: any) => String(p?.id || p?.provider_id));

      if (userPreferredSet.size > 0) {
        const hasPreferred = candidateProviderIds.some((id) => userPreferredSet.has(id));
        if (hasPreferred) {
          platformScore = 10; // Tercih edilen platformda mevcut
        } else {
          platformScore = 6; // Başka bir platformda izlenebilir
        }
      } else {
        platformScore = 8; // Platform tercihi belirtilmemiş ama akışta doğrulandı
      }
    } else if (rawProviders && Array.isArray(rawProviders) && rawProviders.length === 0) {
      platformVerified = true;
      platformScore = 3; // Doğrulandı fakat akışta yok (satın al / kirala)
    } else {
      // Platform verisi bilinmiyor/doğrulanmamış -> NÖTR bırak
      platformVerified = false;
      platformScore = 5;
    }

    // Gerçek toplam ham puan (0-100)
    const rawTotal = Math.round(
      (actorPresenceScore +
        multiActorBonus +
        genreScore +
        tasteScore +
        qualityScore +
        recencyScore +
        platformScore) * 10
    ) / 10;

    const matchScore = Math.min(99, Math.max(1, Math.round(rawTotal)));

    // Güven Düzeyi hesaplaması (0-100)
    const ratingsCount = userRatings.length;
    const ratingsConfidence = ratingsCount >= 5 ? 1.0 : ratingsCount >= 1 ? 0.65 : 0.3;
    const voteCountConfidence = vCnt >= 1000 ? 1.0 : vCnt >= 200 ? 0.8 : vCnt >= 30 ? 0.55 : 0.3;
    const roleConfidence =
      typeof candidate.order === 'number' && candidate.order <= 5
        ? 1.0
        : typeof candidate.order === 'number'
        ? 0.75
        : 0.45;
    const platformConfidence = platformVerified ? 1.0 : 0.5;

    const confidenceScore = Math.round(
      (ratingsConfidence * 0.35 +
        voteCountConfidence * 0.30 +
        roleConfidence * 0.20 +
        platformConfidence * 0.15) * 100
    );

    let confidenceLevel: 'high' | 'medium' | 'low' = 'low';
    if (confidenceScore >= 70) confidenceLevel = 'high';
    else if (confidenceScore >= 45) confidenceLevel = 'medium';

    // Gerekçe metni
    let reason = '';
    if (matchedCount > 1) {
      const names = candidate.matchedActors.map((a: any) => a.name).join(' ve ');
      if (matchedGenreName) {
        reason = `Favori oyuncuların ${names} kadroda ve sevdiğin ${matchedGenreName} türüyle uyuşuyor.`;
      } else {
        reason = `Birden fazla favori oyuncun (${names}) bu yapımda bir araya geliyor.`;
      }
    } else {
      const singleActor = candidate.matchedActors[0];
      const isLead = typeof singleActor.order === 'number' && singleActor.order <= 2;
      const roleText = isLead ? 'başrolde' : 'kadroda';
      if (matchedGenreName) {
        reason = `Favori oyuncun ${singleActor.name} ${roleText} ve ${matchedGenreName} tür tercihlerinle eşleşiyor.`;
      } else if (vAvg >= 7.5) {
        reason = `Favori oyuncun ${singleActor.name} ${roleText} ve yapım yüksek izleyici puanına (%${Math.round(vAvg * 10)}) sahip.`;
      } else {
        reason = `Favori oyuncun ${singleActor.name} ${roleText} yer alıyor.`;
      }
    }

    const signalBreakdown: ActorRecommendationSignalBreakdown = {
      actorPresence: actorPresenceScore,
      actorRoleText,
      multiActorBonus,
      genreScore,
      tasteScore,
      tasteExplanation,
      qualityScore,
      recencyScore,
      platformScore,
      platformVerified,
      confidenceScore,
      confidenceLevel,
      rawTotal,
    };

    results.push({
      ...candidate,
      matchScore,
      confidenceScore,
      confidenceLevel,
      reason,
      signalBreakdown,
    });
  }

  // 5. Sıralama Modları
  const effectiveSort = sortBy || sortMode;
  if (effectiveSort === 'rating') {
    results.sort((a, b) => {
      const diff = (Number(b.vote_average) || 0) - (Number(a.vote_average) || 0);
      return diff !== 0 ? diff : b.matchScore - a.matchScore;
    });
  } else if (effectiveSort === 'title') {
    results.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'tr'));
  } else if (effectiveSort === 'recent' || effectiveSort === 'newest') {
    results.sort((a, b) => {
      const dateA = a.release_date || a.first_air_date || '';
      const dateB = b.release_date || b.first_air_date || '';
      if (!dateA && !dateB) return b.matchScore - a.matchScore;
      if (!dateA) return 1;
      if (!dateB) return -1;
      const cmp = dateB.localeCompare(dateA);
      return cmp !== 0 ? cmp : b.matchScore - a.matchScore;
    });
  } else if (effectiveSort === 'gems' || effectiveSort === 'hidden_gems') {
    // Gizli Cevherler: Yüksek izleyici puanına (vote_average >= 7) sahip fakat ana akım aşırı popüler olmayan yapımlar
    results.sort((a, b) => {
      const bayesA = bayesianRating(a.vote_average, a.vote_count, { prior: 6.5, minVotes: 50 });
      const bayesB = bayesianRating(b.vote_average, b.vote_count, { prior: 6.5, minVotes: 50 });
      if (Math.abs(bayesB - bayesA) > 0.4) {
        return bayesB - bayesA;
      }
      return b.matchScore - a.matchScore;
    });
  } else {
    // 'best_match' / 'popular' (en güçlü eşleşmeler)
    results.sort((a, b) => {
      if (b.matchScore !== a.matchScore) {
        return b.matchScore - a.matchScore;
      }
      return (b.popularity || 0) - (a.popularity || 0);
    });

    // Tür çeşitliliği uygula (belirli bir tür filtresi seçilmediğinde)
    if (enableDiversity && !genreFilter) {
      const effectiveLimit = limit ?? Math.max(50, favoriteActors.length * 10);
      return diversifyActorRecommendations(results, { maxPerGenre, limit: effectiveLimit });
    }
  }

  return typeof limit === 'number' && limit > 0 ? results.slice(0, limit) : results;
}

/* ============================================================================
 * Aşama 2: 500 + 500 Yenilenebilir Aday Havuzu (Film ve Dizi için İki Bağımsız Havuz)
 * ============================================================================ */

export type PoolSourceType =
  | 'popular'
  | 'top_rated'
  | 'recent'
  | 'genre_discover'
  | 'similar'
  | 'person_credits'
  | 'exploration'
  | string;

export interface PoolCandidateItem {
  id: number;
  media_type: 'movie' | 'tv';
  title: string;
  name?: string;
  overview: string;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  vote_count: number;
  popularity: number;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids: number[];

  // Algoritma sinyalleri
  poolSource: PoolSourceType;
  poolReason?: string;
  poolSources: number;
  seedSourceType?: 'completed' | 'watching' | 'watchlist' | '';
  addedToPoolAt?: string;
  era: 'classic' | 'retro' | 'modern' | 'new';
  popularityTier: 'high' | 'medium' | 'low' | 'indie';
  cast?: { id: number; name: string; popularity?: number; profile_path?: string; character?: string }[];
  crew?: { id: number; name: string; job: string; department?: string }[];
  belongs_to_collection?: any;
  production_companies?: any[];

  // Sorun D: Kullanıcıya özel kalıcı öneri ve Zevk Haritası alanları
  matchScore?: number;
  rawScore?: number;
  ring?: TasteRing;
  initialRing?: TasteRing;
  signalBreakdown?: Record<string, number>;
  tags?: string[];
  lastShownAt?: string | null;
  lastScoredAt?: string | null;
  shownCount?: number;
  skippedCount?: number;
  ringDemotions?: number;
  demotionPenalty?: number;
}

export interface CandidatePoolCursors {
  popular: number;
  top_rated: number;
  recent: number;
  exploration: number;
  genre_discover: Record<string, number>; // genreId -> page
  similar: Record<string, number>;        // mediaKey -> page
  person_credits: Record<string, number>; // personId -> page
}

export interface PersistentCandidatePoolData {
  mediaType: 'movie' | 'tv';
  updatedAt: string;
  items: PoolCandidateItem[];
  cursors: CandidatePoolCursors;
}

export const POOL_TARGET_CAPACITY = 500;
export const POOL_LOW_WATERMARK = 250;
export const POOL_REPLENISH_MIN_NEW = 250;

export function createDefaultPoolCursors(): CandidatePoolCursors {
  return {
    popular: 1,
    top_rated: 1,
    recent: 1,
    exploration: 1,
    genre_discover: {},
    similar: {},
    person_credits: {},
  };
}

export function createDefaultPoolData(mediaType: 'movie' | 'tv'): PersistentCandidatePoolData {
  return {
    mediaType,
    updatedAt: new Date().toISOString(),
    items: [],
    cursors: createDefaultPoolCursors(),
  };
}

export function determineItemEra(dateStr?: string): 'classic' | 'retro' | 'modern' | 'new' {
  if (!dateStr || typeof dateStr !== 'string') return 'modern';
  const year = parseInt(dateStr.slice(0, 4), 10);
  if (Number.isNaN(year)) return 'modern';
  if (year >= 2021) return 'new';       // Son yıllar (2021+)
  if (year >= 2010) return 'modern';    // 2010 - 2020
  if (year >= 2000) return 'retro';     // 2000 - 2009
  return 'classic';                     // 2000 öncesi (90'lar ve klasikler)
}

export function determineItemPopularityTier(
  popularity: number,
  voteAverage: number
): 'high' | 'medium' | 'low' | 'indie' {
  const pop = Number(popularity) || 0;
  const rating = Number(voteAverage) || 0;
  if (pop >= 50) return 'high';
  if (pop >= 15) return 'medium';
  if (pop < 15 && rating >= 7.0) return 'indie'; // Yüksek puanlı az popüler keşifler / gizli cevherler
  return 'low';
}

/**
 * Normalizes an API response item into the restricted persistent candidate pool model.
 */
export function normalizePoolCandidate(
  raw: any,
  defaultType: 'movie' | 'tv',
  source: PoolSourceType,
  reason: string = '',
  seedSourceType: 'completed' | 'watching' | 'watchlist' | '' = ''
): PoolCandidateItem | null {
  if (!raw || typeof raw !== 'object' || raw.id == null) return null;
  const numericId = Number(raw.id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return null;
  const mediaType: 'movie' | 'tv' =
    raw.media_type === 'movie' || raw.media_type === 'tv'
      ? raw.media_type
      : (raw.title ? 'movie' : (raw.name ? 'tv' : defaultType));
  if (mediaType !== defaultType) return null;

  const dateStr = raw.release_date || raw.first_air_date || '';
  const voteAvg = Number(raw.vote_average) || 0;
  const pop = Number(raw.popularity) || 0;

  return {
    id: numericId,
    media_type: mediaType,
    title: String(raw.title || raw.name || '').trim(),
    name: raw.name ? String(raw.name).trim() : undefined,
    overview: typeof raw.overview === 'string' ? raw.overview.slice(0, 1000) : '',
    release_date: raw.release_date ? String(raw.release_date).slice(0, 10) : undefined,
    first_air_date: raw.first_air_date ? String(raw.first_air_date).slice(0, 10) : undefined,
    vote_average: Number(voteAvg.toFixed(1)),
    vote_count: Number(raw.vote_count) || 0,
    popularity: Number(pop.toFixed(1)),
    poster_path: typeof raw.poster_path === 'string' ? raw.poster_path : null,
    backdrop_path: typeof raw.backdrop_path === 'string' ? raw.backdrop_path : null,
    genre_ids: Array.isArray(raw.genre_ids)
      ? raw.genre_ids.map(Number).filter((n: any) => Number.isSafeInteger(n) && n > 0).slice(0, 8)
      : [],
    poolSource: source,
    poolReason: reason || '',
    poolSources: 1,
    seedSourceType: seedSourceType || '',
    addedToPoolAt: new Date().toISOString(),
    era: determineItemEra(dateStr),
    popularityTier: determineItemPopularityTier(pop, voteAvg),
    cast: Array.isArray(raw.cast) ? raw.cast.slice(0, 8) : undefined,
    crew: Array.isArray(raw.crew) ? raw.crew.slice(0, 6) : undefined,
    belongs_to_collection: raw.belongs_to_collection || null,
    production_companies: Array.isArray(raw.production_companies)
      ? raw.production_companies.slice(0, 5)
      : undefined,
    matchScore: typeof raw.matchScore === 'number' ? raw.matchScore : undefined,
    rawScore: typeof raw.rawScore === 'number' ? raw.rawScore : undefined,
    ring: raw.ring || undefined,
    initialRing: raw.initialRing || undefined,
    signalBreakdown: raw.signalBreakdown || undefined,
    tags: Array.isArray(raw.tags) ? raw.tags : undefined,
    lastShownAt: raw.lastShownAt || undefined,
    lastScoredAt: raw.lastScoredAt || undefined,
    shownCount: typeof raw.shownCount === 'number' ? raw.shownCount : undefined,
    skippedCount: typeof raw.skippedCount === 'number' ? raw.skippedCount : undefined,
    ringDemotions: typeof raw.ringDemotions === 'number' ? raw.ringDemotions : undefined,
    demotionPenalty: typeof raw.demotionPenalty === 'number' ? raw.demotionPenalty : undefined,
  };
}

/**
 * Beş durum kontrolü:
 * 1. izledim (completed)
 * 2. izleyeceğim (watchlist)
 * 3. izliyorum (watching)
 * 4. ilgilenmiyorum (disliked)
 * 5. gizle (hidden)
 */
export function isCandidateEligibleInPool(
  item: any,
  savedItems: SavedItem[] | undefined | null,
  preferences: Preferences | undefined | null
): boolean {
  if (!item || item.id == null) return false;
  const mediaType = item.media_type === 'tv' ? 'tv' : item.media_type === 'movie' ? 'movie' : item.title ? 'movie' : 'tv';
  const key = makeMediaKey(mediaType, item.id);
  const legacyKey = `${mediaType}-${item.id}`;

  // Durum 4: İlgilenmiyorum (disliked)
  if (
    preferences?.disliked &&
    (preferences.disliked.includes(key) || preferences.disliked.includes(legacyKey))
  ) {
    return false;
  }

  // Durum 5: Gizle (hidden)
  if (
    preferences?.hidden &&
    (preferences.hidden.includes(key) || preferences.hidden.includes(legacyKey))
  ) {
    return false;
  }

  // Durum 1, 2, 3: Kayıtlı yapımlar (completed, watchlist, watching)
  if (savedItems && isItemSaved(savedItems, item, mediaType)) return false;

  return true;
}

/**
 * Filter pool items against all 5 user states.
 */
export function filterEligiblePoolItems(
  items: PoolCandidateItem[],
  savedItems: SavedItem[] | undefined | null,
  preferences: Preferences | undefined | null
): PoolCandidateItem[] {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => isCandidateEligibleInPool(item, savedItems, preferences));
}

export const HIDE_LISTED_CATEGORIES = ['trending', 'top-rated', 'gems'] as const;

export interface UserRegisteredFilterContext {
  savedItems?: SavedItem[] | null;
  preferences?: Preferences | null;
  tasteMap?: PersistentTasteMapData | null;
}

/**
 * 'Listemdekileri Gizle' veri katmanı kontrolü:
 * Kullanıcının Profilinde veya Zevk Haritasında kayıtlı olan
 * (İzlendi / completed, İzlenecek / watchlist, İzliyorum / watching,
 * İlgilenmiyorum / disliked veya Gizle / hidden) içerikleri saptar.
 */
export function isMediaRegisteredInUserProfile(
  item: any,
  { savedItems, preferences, tasteMap }: UserRegisteredFilterContext
): boolean {
  const cand = item?.candidate && typeof item.candidate === 'object' ? item.candidate : item;
  if (!cand || cand.id == null) return false;

  const mediaType: 'movie' | 'tv' =
    cand.media_type === 'tv'
      ? 'tv'
      : cand.media_type === 'movie'
      ? 'movie'
      : cand.title
      ? 'movie'
      : 'tv';
  const key = canonicalizeMediaKey(makeMediaKey(mediaType, cand.id));
  const legacyKey = `${mediaType}-${cand.id}`;

  // 1, 2, 3: İzlendi (completed), İzlenecek (watchlist), İzliyorum (watching)
  if (Array.isArray(savedItems) && savedItems.length > 0) {
    if (isItemSaved(savedItems, cand, mediaType)) {
      return true;
    }
  }

  // 4: İlgilenmiyorum (disliked)
  if (Array.isArray(preferences?.disliked) && preferences.disliked.length > 0) {
    if (
      preferences.disliked.some(
        (d) => d === key || d === legacyKey || canonicalizeMediaKey(d) === key
      )
    ) {
      return true;
    }
  }

  // 5: Gizle (hidden)
  if (Array.isArray(preferences?.hidden) && preferences.hidden.length > 0) {
    if (
      preferences.hidden.some(
        (h) => h === key || h === legacyKey || canonicalizeMediaKey(h) === key
      )
    ) {
      return true;
    }
  }

  // Zevk Haritası (aktif veya arşiv kayıtlarında saved / disliked / hidden durumu)
  const mapEntry =
    tasteMap?.entries?.[key] ??
    tasteMap?.entries?.[legacyKey] ??
    tasteMap?.archivedEntries?.[key] ??
    tasteMap?.archivedEntries?.[legacyKey];
  if (
    mapEntry &&
    (mapEntry.status === 'saved' || mapEntry.status === 'disliked' || mapEntry.status === 'hidden')
  ) {
    return true;
  }

  return false;
}

export function filterHiddenUserRegisteredItems<T>(
  items: T[],
  context: UserRegisteredFilterContext & { hideListedItems?: boolean }
): T[] {
  if (!Array.isArray(items)) return [];
  if (!context.hideListedItems) return items;
  return items.filter((item) => !isMediaRegisteredInUserProfile(item, context));
}

/**
 * Dönem, popülerlik ve tür gibi çeşitlilik boyutlarını dengeli dağıtan havuz dengeleyici.
 */
export function balanceCandidatePool(
  items: PoolCandidateItem[],
  targetCapacity: number = POOL_TARGET_CAPACITY
): PoolCandidateItem[] {
  if (!Array.isArray(items)) return [];
  if (items.length <= targetCapacity) return [...items];

  const maxPerGenre = Math.ceil(targetCapacity * 0.25); // Her tür için tavan (~%25)

  // Çok kaynaklı, kaliteli ve dengeli adaylara öncelik
  const sorted = [...items].sort((a, b) => {
    const sourcesDiff = (b.poolSources || 1) - (a.poolSources || 1);
    if (sourcesDiff !== 0) return sourcesDiff;
    return (b.vote_average * 10 + b.popularity * 0.1) - (a.vote_average * 10 + a.popularity * 0.1);
  });

  const selected: PoolCandidateItem[] = [];
  const seenKeys = new Set<string>();
  const genreCounts: Record<string, number> = {};
  const eraCounts: Record<string, number> = { classic: 0, retro: 0, modern: 0, new: 0 };
  const tierCounts: Record<string, number> = { high: 0, medium: 0, low: 0, indie: 0 };

  // 1. Geçiş: Tür tavanlarını ve boyut dengesini koruyarak seç
  for (const item of sorted) {
    if (selected.length >= targetCapacity) break;
    const key = makeMediaKey(item);
    if (seenKeys.has(key)) continue;

    const dominantGenre = String(item.genre_ids?.[0] || 'none');
    if ((genreCounts[dominantGenre] || 0) >= maxPerGenre) continue;

    selected.push(item);
    seenKeys.add(key);
    genreCounts[dominantGenre] = (genreCounts[dominantGenre] || 0) + 1;
    eraCounts[item.era] = (eraCounts[item.era] || 0) + 1;
    tierCounts[item.popularityTier] = (tierCounts[item.popularityTier] || 0) + 1;
  }

  // 2. Geçiş: Hedef kapasiteye (500) ulaşılmadıysa tür kotalarını aşamalı gevşeterek dengeli tamamla
  let quotaStep = 1;
  while (selected.length < targetCapacity) {
    let addedInPass = 0;
    const currentGenreCap = Math.ceil(targetCapacity * (0.25 + 0.1 * quotaStep));
    for (const item of sorted) {
      if (selected.length >= targetCapacity) break;
      const key = makeMediaKey(item);
      if (seenKeys.has(key)) continue;

      const dominantGenre = String(item.genre_ids?.[0] || 'none');
      if ((genreCounts[dominantGenre] || 0) >= currentGenreCap) continue;

      selected.push(item);
      seenKeys.add(key);
      genreCounts[dominantGenre] = (genreCounts[dominantGenre] || 0) + 1;
      eraCounts[item.era] = (eraCounts[item.era] || 0) + 1;
      tierCounts[item.popularityTier] = (tierCounts[item.popularityTier] || 0) + 1;
      addedInPass++;
    }
    quotaStep++;
    if (addedInPass === 0) {
      // Kota gevşetmelerine rağmen kalan boşluk varsa kalan en iyi adaylarla tamamla
      for (const item of sorted) {
        if (selected.length >= targetCapacity) break;
        const key = makeMediaKey(item);
        if (seenKeys.has(key)) continue;
        selected.push(item);
        seenKeys.add(key);
      }
      break;
    }
  }

  return selected;
}

export interface MultiDimensionalDiversifyOptions {
  limit?: number;
  maxPerGenre?: number;
  maxPerEra?: number;
  maxPerTier?: number;
}

/**
 * Sonuç listesinde tür, dönem ve popülerlik boyutlarını dengeli dağıtan gelişmiş çeşitlendirme.
 */
export function multiDimensionalDiversify(
  scored: any[],
  {
    limit = 20,
    maxPerGenre = 5,
    maxPerEra = 8,
    maxPerTier = 10,
  }: MultiDimensionalDiversifyOptions = {}
): any[] {
  const ordered = [...(Array.isArray(scored) ? scored : [])].sort((a, b) => b.score - a.score);
  const picked: any[] = [];
  const seen = new Set<string>();
  const genreCounts: Record<string, number> = {};
  const eraCounts: Record<string, number> = {};
  const tierCounts: Record<string, number> = {};

  const getCandidate = (entry: any) => entry?.candidate || entry;
  const getGenre = (entry: any) => {
    const c = getCandidate(entry);
    return (c?.genre_ids || [])[0] != null ? String(c.genre_ids[0]) : '';
  };
  const getEra = (entry: any): string => {
    const c = getCandidate(entry);
    return c?.era || determineItemEra(c?.release_date || c?.first_air_date);
  };
  const getTier = (entry: any): string => {
    const c = getCandidate(entry);
    return (
      c?.popularityTier ||
      determineItemPopularityTier(c?.popularity, c?.vote_average)
    );
  };

  // 1. Geçiş: Sıkı çok boyutlu kotalar
  for (const entry of ordered) {
    if (picked.length >= limit) break;
    const cand = getCandidate(entry);
    const key = makeMediaKey(cand);
    if (seen.has(key)) continue;

    const genre = getGenre(entry);
    const era = getEra(entry);
    const tier = getTier(entry);

    if (genre && (genreCounts[genre] || 0) >= maxPerGenre) continue;
    if (era && (eraCounts[era] || 0) >= maxPerEra) continue;
    if (tier && (tierCounts[tier] || 0) >= maxPerTier) continue;

    picked.push(entry);
    seen.add(key);
    if (genre) genreCounts[genre] = (genreCounts[genre] || 0) + 1;
    if (era) eraCounts[era] = (eraCounts[era] || 0) + 1;
    if (tier) tierCounts[tier] = (tierCounts[tier] || 0) + 1;
  }

  // 2. Geçiş: Kotalar limiti doldurmadıysa dönem ve popülerlik kotalarını gevşet
  if (picked.length < limit) {
    for (const entry of ordered) {
      if (picked.length >= limit) break;
      const cand = getCandidate(entry);
      const key = makeMediaKey(cand);
      if (seen.has(key)) continue;
      const genre = getGenre(entry);
      if (genre && (genreCounts[genre] || 0) >= maxPerGenre + 2) continue;

      picked.push(entry);
      seen.add(key);
      if (genre) genreCounts[genre] = (genreCounts[genre] || 0) + 1;
    }
  }

  // 3. Geçiş: Hâlâ limitin altındaysa hedef sayıyı (20) garanti etmek için kalan adayları al
  if (picked.length < limit) {
    for (const entry of ordered) {
      if (picked.length >= limit) break;
      const cand = getCandidate(entry);
      const key = makeMediaKey(cand);
      if (seen.has(key)) continue;
      picked.push(entry);
      seen.add(key);
    }
  }

  return picked;
}

export interface SelectBalancedRecommendationsOptions {
  targetType: 'all' | 'movie' | 'tv';
  scoredMovies?: any[];
  scoredTv?: any[];
  remainingMovies?: any[];
  remainingTv?: any[];
  lastRecommendedKeys?: string[];
  tasteMap?: PersistentTasteMapData | null;
  targetTotal?: number;
  minPerTypeInAll?: number;
  maxPerGenre?: number;
  maxPerEra?: number;
  maxPerTier?: number;
}

export interface BalancedRecommendationResult {
  items: any[];
  movieCount: number;
  tvCount: number;
  totalCount: number;
  explanation: string;
  hasShortfall: boolean;
  shortfallType?: 'movie' | 'tv' | 'both' | null;
}

/**
  * Sorun B çözümü:
  * "Tüm içerikler" (all) modunda film ve dizileri bağımsız olarak puanlayıp sıralar,
  * her iki gruptan en az 10'ar aday seçerek 10 film + 10 dizi garantisi sağlar.
  * Bir türden 10 aday çıkmadığında diğer türden fazladan adaylarla sessizce doldurmaz;
  * gerçek sayıları açıklar.
  * "Yalnızca film" veya "yalnızca dizi" istendiğinde ise hedefi 20 yapar ve seçilen türü kesin koşul uygular.
  */
export function selectBalancedRecommendations({
  targetType,
  scoredMovies = [],
  scoredTv = [],
  remainingMovies = [],
  remainingTv = [],
  lastRecommendedKeys,
  tasteMap = null,
  targetTotal = TARGET_RECOMMENDATION_COUNT,
  minPerTypeInAll = 10,
  maxPerGenre,
  maxPerEra,
  maxPerTier,
}: SelectBalancedRecommendationsOptions): BalancedRecommendationResult {
  const normTarget = targetType === 'movie' || targetType === 'tv' ? targetType : 'all';
  const excludedLastRecommended = new Set(
    canonicalizeMediaKeyList(lastRecommendedKeys ?? tasteMap?.lastRecommendedKeys ?? [])
  );

  const resolveCandidateLifecycleRing = (e: any): LifecycleRing => {
    const cand = e?.candidate || e;
    const canonicalKey = canonicalizeMediaKey(makeMediaKey(cand));
    if (excludedLastRecommended.has(canonicalKey)) return 'ring1';
    const rawRing = e?.ring ?? e?.candidate?.ring;
    if (rawRing === 'ring1') return 'ring1';
    if (rawRing === 'ring2') return 'ring2';
    const shownCount = Number(e?.shownCount ?? cand?.shownCount ?? 0);
    const skippedCount = Number(e?.skippedCount ?? cand?.skippedCount ?? 0);
    const lastShownAt = e?.lastShownAt ?? cand?.lastShownAt ?? null;
    if (shownCount > 0 || skippedCount > 0 || Boolean(lastShownAt)) {
      return 'ring2';
    }
    return 'ring0';
  };

  const resolvePriorityScore = (e: any): number => {
    const cand = e?.candidate || e;
    const val = e?.priorityScore ?? e?.score ?? cand?.priorityScore ?? cand?.score ?? 0;
    return Number(val) || 0;
  };

  const selectWithLifecycleOrder = (
    primaryScored: any[],
    remainingPool: any[],
    limit: number,
    diversifyCaps: { maxPerGenre: number; maxPerEra: number; maxPerTier: number }
  ): any[] => {
    const primaryRing0: any[] = [];
    const primarySeen = new Set<string>();
    const ring2Map = new Map<string, any>();

    // 1 & 2: Ana adaylardan lastRecommendedKeys / ring1 olanları kesinlikle ele; ring0 ve ring2 adaylarını ayır
    for (const item of primaryScored || []) {
      if (!item) continue;
      const cand = item.candidate || item;
      const key = canonicalizeMediaKey(makeMediaKey(cand));
      if (excludedLastRecommended.has(key)) continue;
      const r = resolveCandidateLifecycleRing(item);
      if (r === 'ring1') continue;
      if (r === 'ring0') {
        if (!primarySeen.has(key)) {
          primarySeen.add(key);
          primaryRing0.push(item);
        }
      } else {
        if (!ring2Map.has(key)) {
          ring2Map.set(key, item);
        }
      }
    }

    // Kalan havuzdan da lastRecommendedKeys / ring1 olanları ele; ring0 ve ring2 adaylarını birbirine karıştırmadan ayır
    const remainingRing0: any[] = [];
    for (const rem of remainingPool || []) {
      if (!rem) continue;
      const cand = rem.candidate || rem;
      const key = canonicalizeMediaKey(makeMediaKey(cand));
      if (excludedLastRecommended.has(key)) continue;
      const r = resolveCandidateLifecycleRing(rem);
      if (r === 'ring1') continue;
      if (r === 'ring0') {
        if (!primarySeen.has(key)) {
          primarySeen.add(key);
          remainingRing0.push(rem);
        }
      } else {
        if (!ring2Map.has(key) && !primarySeen.has(key)) {
          ring2Map.set(key, rem);
        }
      }
    }

    // Aşama 1A: Önce zenginleştirilmiş ring0 adaylarından çok boyutlu çeşitlendirme ile seç
    const picked = multiDimensionalDiversify(primaryRing0, {
      limit,
      maxPerGenre: diversifyCaps.maxPerGenre,
      maxPerEra: diversifyCaps.maxPerEra,
      maxPerTier: diversifyCaps.maxPerTier,
    });
    const pickedKeys = new Set(picked.map((e) => makeMediaKey(e.candidate || e)));

    // Aşama 1B: Hedef dolmadıysa ring2'ye geçmeden ÖNCE kalan havuzdaki taze ring0 adaylarını kullan
    if (picked.length < limit && remainingRing0.length > 0) {
      const sortedRemainingRing0 = [...remainingRing0].sort(
        (a, b) => resolvePriorityScore(b) - resolvePriorityScore(a)
      );
      const diversifiedRemainingRing0 = multiDimensionalDiversify(sortedRemainingRing0, {
        limit: limit - picked.length,
        maxPerGenre: diversifyCaps.maxPerGenre,
        maxPerEra: diversifyCaps.maxPerEra,
        maxPerTier: diversifyCaps.maxPerTier,
      });
      for (const rem of diversifiedRemainingRing0) {
        if (picked.length >= limit) break;
        const key = makeMediaKey(rem.candidate || rem);
        if (!pickedKeys.has(key)) {
          pickedKeys.add(key);
          picked.push(rem);
        }
      }
      for (const rem of sortedRemainingRing0) {
        if (picked.length >= limit) break;
        const key = makeMediaKey(rem.candidate || rem);
        if (!pickedKeys.has(key)) {
          pickedKeys.add(key);
          picked.push(rem);
        }
      }
    }

    // Aşama 2 (Yedek): Yalnızca tüm ring0 adayları hedefi dolduramadıysa ring2 adaylarına geç
    // ring2 adayları kendi priorityScore değerine göre azalan sırada değerlendirilir
    if (picked.length < limit && ring2Map.size > 0) {
      const sortedRing2 = Array.from(ring2Map.values()).sort(
        (a, b) => resolvePriorityScore(b) - resolvePriorityScore(a)
      );
      for (const fallbackItem of sortedRing2) {
        if (picked.length >= limit) break;
        const key = makeMediaKey(fallbackItem.candidate || fallbackItem);
        if (!pickedKeys.has(key)) {
          pickedKeys.add(key);
          picked.push(fallbackItem);
        }
      }
    }

    return picked;
  };

  if (normTarget === 'all') {
    const movieLimit = Math.max(1, minPerTypeInAll);
    const tvLimit = Math.max(1, minPerTypeInAll);

    const pickedMovies = selectWithLifecycleOrder(scoredMovies, remainingMovies, movieLimit, {
      maxPerGenre: maxPerGenre ?? 3,
      maxPerEra: maxPerEra ?? 4,
      maxPerTier: maxPerTier ?? 5,
    });

    const pickedTv = selectWithLifecycleOrder(scoredTv, remainingTv, tvLimit, {
      maxPerGenre: maxPerGenre ?? 3,
      maxPerEra: maxPerEra ?? 4,
      maxPerTier: maxPerTier ?? 5,
    });

    // KESİN KURAL: Bir türden 10 uygun aday çıkmıyorsa diğer türden fazladan adaylarla sessizce doldurma!
    const movieCount = pickedMovies.length;
    const tvCount = pickedTv.length;
    const totalCount = movieCount + tvCount;

    // Her iki gruptan seçilen tüm adayları (10 film + 10 dizi) nihai listede birleştir ve öncelik puanına göre sırala
    const items = [...pickedMovies, ...pickedTv].sort(
      (a, b) => resolvePriorityScore(b) - resolvePriorityScore(a)
    );

    const movieShortfall = movieCount < movieLimit;
    const tvShortfall = tvCount < tvLimit;
    const hasShortfall = movieShortfall || tvShortfall;
    let shortfallType: 'movie' | 'tv' | 'both' | null = null;
    if (movieShortfall && tvShortfall) shortfallType = 'both';
    else if (movieShortfall) shortfallType = 'movie';
    else if (tvShortfall) shortfallType = 'tv';

    let explanation = '';
    if (!hasShortfall) {
      explanation = `500'lük yenilenebilir zevk havuzundan ${movieCount} film ve ${tvCount} dizi olmak üzere toplam ${totalCount} içerik, tür, dönem ve popülerlik dengesi gözetilerek hazırlandı.`;
    } else if (shortfallType === 'both') {
      explanation = `Listen ve tercihlerine uygun ${movieCount} film ve ${tvCount} dizi olmak üzere toplam ${totalCount} içerik bulundu. Kriterler ve havuz genişletilmesine rağmen her iki türde de uygun aday sayısı sınırlı kalmıştır.`;
    } else if (shortfallType === 'movie') {
      explanation = `Listen ve tercihlerine uygun ${movieCount} film ve ${tvCount} dizi olmak üzere toplam ${totalCount} içerik bulundu. Kriterler ve havuz genişletilmesine rağmen film havuzunda uygun aday sayısı sınırlı kalmıştır.`;
    } else {
      explanation = `Listen ve tercihlerine uygun ${movieCount} film ve ${tvCount} dizi olmak üzere toplam ${totalCount} içerik bulundu. Kriterler ve havuz genişletilmesine rağmen dizi havuzunda uygun aday sayısı sınırlı kalmıştır.`;
    }

    return {
      items,
      movieCount,
      tvCount,
      totalCount,
      explanation,
      hasShortfall,
      shortfallType,
    };
  }

  if (normTarget === 'movie') {
    const pickedMovies = selectWithLifecycleOrder(scoredMovies, remainingMovies, targetTotal, {
      maxPerGenre: maxPerGenre ?? 5,
      maxPerEra: maxPerEra ?? 8,
      maxPerTier: maxPerTier ?? 10,
    });

    const movieCount = pickedMovies.length;
    const hasShortfall = movieCount < targetTotal;
    let explanation = '';
    if (movieCount >= targetTotal) {
      explanation = `500'lük yenilenebilir zevk havuzundan tür, dönem ve popülerlik dengesi gözetilerek ${movieCount} film önerisi hazırlandı.`;
    } else if (movieCount > 0) {
      explanation = `Listen ve tercihlerine uygun ${movieCount} film bulundu. Kriterler ve havuz genişletilmesine rağmen kalan sonuç sayısı bu kadardır.`;
    } else {
      explanation = 'Henüz film önerisi üretilemedi. Listenize birkaç yapım ekleyerek havuzu zenginleştirebilirsiniz.';
    }

    return {
      items: pickedMovies,
      movieCount,
      tvCount: 0,
      totalCount: movieCount,
      explanation,
      hasShortfall,
      shortfallType: hasShortfall ? 'movie' : null,
    };
  }

  // normTarget === 'tv'
  const pickedTv = selectWithLifecycleOrder(scoredTv, remainingTv, targetTotal, {
    maxPerGenre: maxPerGenre ?? 5,
    maxPerEra: maxPerEra ?? 8,
    maxPerTier: maxPerTier ?? 10,
  });

  const tvCount = pickedTv.length;
  const hasShortfall = tvCount < targetTotal;
  let explanation = '';
  if (tvCount >= targetTotal) {
    explanation = `500'lük yenilenebilir zevk havuzundan tür, dönem ve popülerlik dengesi gözetilerek ${tvCount} dizi önerisi hazırlandı.`;
  } else if (tvCount > 0) {
    explanation = `Listen ve tercihlerine uygun ${tvCount} dizi bulundu. Kriterler ve havuz genişletilmesine rağmen kalan sonuç sayısı bu kadardır.`;
  } else {
    explanation = 'Henüz dizi önerisi üretilemedi. Listenize birkaç yapım ekleyerek havuzu zenginleştirebilirsiniz.';
  }

  return {
    items: pickedTv,
    movieCount: 0,
    tvCount,
    totalCount: tvCount,
    explanation,
    hasShortfall,
    shortfallType: hasShortfall ? 'tv' : null,
  };
}

/**
 * Havuz yenilemelerini kilitleyen, tekilleştiren ve iptal (abort) davranışını
 * arkaplan görevinden bağımsız yöneten mutex mekanizması (Sorun C çözümü).
 */
export class PoolReplenishmentLock {
  private activeLocks = new Map<string, Promise<any>>();

  public async acquire<T>(
    key: string,
    task: () => Promise<T>,
    callerSignal?: AbortSignal
  ): Promise<T> {
    if (callerSignal?.aborted) {
      throw callerSignal.reason || new DOMException('This operation was aborted', 'AbortError');
    }

    let sharedPromise = this.activeLocks.get(key) as Promise<T> | undefined;
    if (!sharedPromise) {
      sharedPromise = (async () => {
        try {
          return await task();
        } finally {
          this.activeLocks.delete(key);
        }
      })();
      this.activeLocks.set(key, sharedPromise);
    }

    // İptal ve kilit davranışını birbirinden ayır:
    // Eğer çağıran kendi signal'ini geçerse, yalnızca o çağıranın beklemesi iptal edilir.
    // Arka plandaki paylaşılan yenileme görevi diğer çağıranlar ve havuz bütünlüğü için devam eder.
    if (!callerSignal) {
      return sharedPromise;
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const onAbort = () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(callerSignal.reason || new DOMException('This operation was aborted', 'AbortError'));
        }
      };

      const cleanup = () => {
        callerSignal.removeEventListener('abort', onAbort);
      };

      callerSignal.addEventListener('abort', onAbort, { once: true });

      sharedPromise!
        .then((result) => {
          if (!settled) {
            settled = true;
            cleanup();
            resolve(result);
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(err);
          }
        });
    });
  }

  public isLocked(key: string): boolean {
    return this.activeLocks.has(key);
  }

  public clear(): void {
    this.activeLocks.clear();
  }
}

export const poolReplenishmentLock = new PoolReplenishmentLock();

const inMemoryPoolFallback = new Map<string, { storageRef: unknown; raw: string }>();

/**
 * TMDB film ve dizi tür kimlikleri arasındaki çapraz eşdeğerliği denetler.
 * Örn: Film Fantastik (14) / Bilim Kurgu (878) <-> Dizi Bilim Kurgu & Fantazi (10765),
 * Film Aksiyon (28) / Macera (12) <-> Dizi Aksiyon & Macera (10759),
 * Film Savaş (10752) <-> Dizi Savaş & Politik (10768).
 */
export function matchesSelectedGenre(
  item: any,
  selectedGenre?: string | number | null
): boolean {
  if (selectedGenre === undefined || selectedGenre === null || selectedGenre === '') {
    return true;
  }
  const gId = Number(selectedGenre);
  if (!Number.isFinite(gId) || gId <= 0) return true;

  const cand = item?.candidate && typeof item.candidate === 'object' ? item.candidate : item;
  if (!cand || typeof cand !== 'object') return false;

  const rawGenres: number[] = Array.isArray(cand.genre_ids)
    ? cand.genre_ids.map(Number).filter((n: number) => Number.isFinite(n))
    : Array.isArray(cand.genres)
    ? cand.genres
        .map((g: any) => Number(typeof g === 'object' ? g?.id : g))
        .filter((n: number) => Number.isFinite(n))
    : [];

  if (rawGenres.includes(gId)) return true;

  const mediaType =
    cand.media_type === 'tv' || cand.mediaType === 'tv'
      ? 'tv'
      : cand.media_type === 'movie' || cand.mediaType === 'movie'
      ? 'movie'
      : cand.title && !cand.first_air_date
      ? 'movie'
      : 'tv';

  if (mediaType === 'tv') {
    if ((gId === 14 || gId === 878) && rawGenres.includes(10765)) return true;
    if ((gId === 28 || gId === 12) && rawGenres.includes(10759)) return true;
    if (gId === 10752 && rawGenres.includes(10768)) return true;
  } else {
    if (gId === 10765 && (rawGenres.includes(14) || rawGenres.includes(878))) return true;
    if (gId === 10759 && (rawGenres.includes(28) || rawGenres.includes(12))) return true;
    if (gId === 10768 && rawGenres.includes(10752)) return true;
  }

  return false;
}

/**
 * TMDB /discover/{movie|tv} uç noktası için çapraz tür parametresini çözümler.
 */
export function resolveDiscoverGenreParam(
  selectedGenre: string | number | undefined | null,
  mediaType: 'movie' | 'tv'
): string {
  if (selectedGenre === undefined || selectedGenre === null || selectedGenre === '') {
    return '';
  }
  const gId = Number(selectedGenre);
  if (!Number.isFinite(gId) || gId <= 0) return '';

  if (mediaType === 'tv') {
    if (gId === 14 || gId === 878) return '10765';
    if (gId === 28 || gId === 12) return '10759';
    if (gId === 10752) return '10768';
    return String(gId);
  }

  if (gId === 10765) return '878|14';
  if (gId === 10759) return '28|12';
  if (gId === 10768) return '10752';
  return String(gId);
}

/**
 * Sunucudaki kalıcı katalog (data/catalog/movies.json & data/catalog/tv.json)
 * kayıtlarını kullanıcının 500+500 aday havuzuna aktarır (beş kullanıcı durumunu süzerek).
 */
export function hydratePoolFromCatalog(
  poolData: PersistentCandidatePoolData,
  rawCatalog: Record<string, any> | any[] | null | undefined,
  savedItems: SavedItem[] | undefined | null,
  preferences: Preferences | undefined | null
): { poolData: PersistentCandidatePoolData; addedCount: number } {
  if (!rawCatalog) return { poolData, addedCount: 0 };
  const rawList = Array.isArray(rawCatalog)
    ? rawCatalog
    : typeof rawCatalog === 'object'
    ? Object.values(rawCatalog)
    : [];
  if (rawList.length === 0) return { poolData, addedCount: 0 };

  const eligibleExisting = filterEligiblePoolItems(poolData.items || [], savedItems, preferences);
  const existingKeys = new Set(eligibleExisting.map((it) => makeMediaKey(it)));
  let addedCount = 0;

  for (const rawItem of rawList) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const normalizedInput = {
      ...rawItem,
      media_type: rawItem.media_type || rawItem.mediaType || poolData.mediaType,
    };
    if (!isCandidateEligibleInPool(normalizedInput, savedItems, preferences)) continue;
    const candidate = normalizePoolCandidate(
      normalizedInput,
      poolData.mediaType,
      'popular',
      'İndirilmiş katalog havuzundan'
    );
    if (!candidate) continue;
    const key = makeMediaKey(candidate);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    eligibleExisting.push(candidate);
    addedCount += 1;
  }

  const balanced = balanceCandidatePool(eligibleExisting, POOL_TARGET_CAPACITY);
  return {
    poolData: {
      ...poolData,
      items: balanced,
      updatedAt: addedCount > 0 ? new Date().toISOString() : poolData.updatedAt,
    },
    addedCount,
  };
}

export interface TopUpFilteredCandidatesParams {
  profileId: string;
  mediaType: 'movie' | 'tv';
  existingCandidates: PoolCandidateItem[];
  savedItems: SavedItem[];
  preferences: Preferences;
  lastRecommendedKeys?: string[];
  selectedGenre?: string;
  selectedProvider?: string;
  minFreshRequired?: number;
  maxPagesToScan?: number;
  fetchTmdbFn: (path: string, params?: Record<string, string>, signal?: AbortSignal) => Promise<any>;
  signal?: AbortSignal;
}

/**
 * Tür, medya tipi veya platform filtresi uygulandığında havuzdaki uygun taze (Ring 1 dışı) aday sayısı
 * 20'lik öneri listesini doldurmaya yetmiyorsa, TMDB /discover kaynağından çok sayfalı tarama yaparak
 * kullanıcının izlemediği adaylarla havuzu tamamlar.
 */
export async function topUpFilteredCandidates({
  profileId,
  mediaType,
  existingCandidates,
  savedItems,
  preferences,
  lastRecommendedKeys = [],
  selectedGenre = '',
  selectedProvider = '',
  minFreshRequired = 28,
  maxPagesToScan = 12,
  fetchTmdbFn,
  signal,
}: TopUpFilteredCandidatesParams): Promise<{
  filteredCandidates: PoolCandidateItem[];
  newlyDiscovered: PoolCandidateItem[];
}> {
  const matching: PoolCandidateItem[] = [];
  const seenKeys = new Set<string>();

  for (const item of existingCandidates || []) {
    if (!item || item.media_type !== mediaType) continue;
    if (!isCandidateEligibleInPool(item, savedItems, preferences)) continue;
    if (selectedGenre && !matchesSelectedGenre(item, selectedGenre)) continue;
    if (selectedProvider) {
      const rawProv = (item as any).watch_providers || (item as any).providers;
      if (!Array.isArray(rawProv)) continue;
      const hasProv = rawProv.some(
        (p: any) => String(p?.id ?? p?.provider_id ?? p) === String(selectedProvider)
      );
      if (!hasProv) continue;
    }
    const key = makeMediaKey(item);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      matching.push(item);
    }
  }

  const countFresh = (list: PoolCandidateItem[]) =>
    filterOutLastRecommendedCandidates(list, lastRecommendedKeys).length;

  if (countFresh(matching) >= minFreshRequired) {
    return { filteredCandidates: matching, newlyDiscovered: [] };
  }

  const poolData = loadPersistentPoolData(profileId, mediaType);
  const cursors = poolData.cursors || (poolData.cursors = createDefaultPoolCursors());
  cursors.genre_discover = cursors.genre_discover || {};

  const discoverGenre = resolveDiscoverGenreParam(selectedGenre, mediaType);
  const cursorKey = `filter:${discoverGenre || 'all'}:prov:${selectedProvider || 'all'}`;
  const currentPage = Math.max(1, Number(cursors.genre_discover[cursorKey]) || 1);
  const newlyDiscovered: PoolCandidateItem[] = [];
  const visitedPages = new Set<string>();

  const strategies: Array<{ sortBy: string; minVotes: string }> = [
    { sortBy: 'popularity.desc', minVotes: mediaType === 'movie' ? '25' : '15' },
    { sortBy: 'vote_average.desc', minVotes: mediaType === 'movie' ? '60' : '30' },
  ];

  let pagesScanned = 0;

  for (let stratIdx = 0; stratIdx < strategies.length; stratIdx++) {
    const strat = strategies[stratIdx];
    let page = stratIdx === 0 ? currentPage : 1;
    let wrappedAround = false;

    while (pagesScanned < maxPagesToScan && countFresh(matching) < minFreshRequired) {
      if (signal?.aborted) break;
      const visitToken = `${strat.sortBy}:${page}`;
      if (visitedPages.has(visitToken)) {
        page += 1;
        if (page > 50) break;
        continue;
      }
      visitedPages.add(visitToken);
      pagesScanned += 1;

      const params: Record<string, string> = {
        sort_by: strat.sortBy,
        'vote_count.gte': strat.minVotes,
        page: String(page),
      };
      if (discoverGenre) {
        params.with_genres = discoverGenre;
      }
      if (selectedProvider) {
        params.with_watch_providers = String(selectedProvider);
        params.watch_region = 'TR';
      }

      try {
        const data = await fetchTmdbFn(`/discover/${mediaType}`, params, signal);
        const results = Array.isArray(data?.results) ? data.results : [];
        const totalPages = Math.max(1, Math.min(50, Number(data?.total_pages) || 1));

        for (const raw of results) {
          if (!isCandidateEligibleInPool({ ...raw, media_type: mediaType }, savedItems, preferences)) {
            continue;
          }
          const cand = normalizePoolCandidate(
            raw,
            mediaType,
            'genre_discover',
            discoverGenre ? 'Seçili tür keşfinden' : 'Filtreli keşif havuzundan'
          );
          if (!cand) continue;
          if (selectedProvider) {
            (cand as any).providers = [{ id: String(selectedProvider) }];
          }
          const key = makeMediaKey(cand);
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            matching.push(cand);
            newlyDiscovered.push(cand);
          }
        }

        if (stratIdx === 0) {
          cursors.genre_discover[cursorKey] = page < totalPages ? page + 1 : 1;
        }

        if (page < totalPages) {
          page += 1;
        } else if (stratIdx === 0 && currentPage > 1 && !wrappedAround) {
          wrappedAround = true;
          page = 1;
        } else {
          break;
        }
      } catch {
        break;
      }
    }

    if (countFresh(matching) >= minFreshRequired) break;
  }

  if (newlyDiscovered.length > 0) {
    const poolKeys = new Set(poolData.items.map((it) => makeMediaKey(it)));
    for (const item of newlyDiscovered) {
      const k = makeMediaKey(item);
      if (!poolKeys.has(k)) {
        poolKeys.add(k);
        poolData.items.push(item);
      }
    }
    poolData.items = balanceCandidatePool(
      filterEligiblePoolItems(poolData.items, savedItems, preferences),
      POOL_TARGET_CAPACITY
    );
    poolData.updatedAt = new Date().toISOString();
    savePersistentPoolData(profileId, poolData);
  }

  return { filteredCandidates: matching, newlyDiscovered };
}

export function loadPersistentPoolData(
  profileId: string,
  mediaType: 'movie' | 'tv'
): PersistentCandidatePoolData {
  try {
    if (typeof localStorage !== 'undefined') {
      const key = `cinetrack_pool_${mediaType}_${profileId}`;
      const fallback = inMemoryPoolFallback.get(key);
      let raw = localStorage.getItem(key);
      if (fallback && fallback.storageRef === localStorage) {
        raw = fallback.raw;
      } else if (fallback && fallback.storageRef !== localStorage) {
        inMemoryPoolFallback.delete(key);
      }
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.mediaType === mediaType && Array.isArray(parsed.items)) {
          const tasteMap = loadPersistentTasteMap(profileId);
          const syncedItems = syncPoolCandidatesWithTasteMap(parsed.items, tasteMap);
          return {
            mediaType,
            updatedAt: parsed.updatedAt || new Date().toISOString(),
            items: syncedItems,
            cursors: {
              ...createDefaultPoolCursors(),
              ...(parsed.cursors || {}),
            },
          };
        }
      }
    }
  } catch {}
  return createDefaultPoolData(mediaType);
}

export function savePersistentPoolData(
  profileId: string,
  data: PersistentCandidatePoolData
): void {
  if (typeof localStorage === 'undefined') return;
  const key = `cinetrack_pool_${data.mediaType}_${profileId}`;
  const updatedAt = new Date().toISOString();
  const sliced = data.items.slice(0, POOL_TARGET_CAPACITY);
  const fullPayload = JSON.stringify({
    mediaType: data.mediaType,
    updatedAt,
    items: sliced,
    cursors: data.cursors,
  });
  try {
    localStorage.setItem(key, fullPayload);
    inMemoryPoolFallback.delete(key);
  } catch {
    const compactPayload = JSON.stringify({
      mediaType: data.mediaType,
      updatedAt,
      items: sliced.map((it) => ({
        ...it,
        overview: (it.overview || '').slice(0, 140),
      })),
      cursors: data.cursors,
    });
    try {
      localStorage.setItem(key, compactPayload);
      inMemoryPoolFallback.delete(key);
    } catch {
      inMemoryPoolFallback.set(key, {
        storageRef: localStorage,
        raw: compactPayload,
      });
    }
  }
}

export interface ReplenishCandidatePoolParams {
  profileId: string;
  mediaType: 'movie' | 'tv';
  savedItems: SavedItem[];
  preferences: Preferences;
  favoriteActors?: FavoriteActorInfo[];
  fetchTmdbFn: (path: string, params?: Record<string, string>, signal?: AbortSignal) => Promise<any>;
  signal?: AbortSignal;
  force?: boolean;
  concurrency?: number;
  maxTotalRequests?: number;
  onProgress?: (step: string) => void;
}

export interface PoolQueueTask {
  id: string;
  source: PoolSourceType;
  endpointKey: string;
  path: string;
  params: Record<string, string>;
  page: number;
  reason?: string;
  seedSourceType?: 'completed' | 'watching' | 'watchlist' | '';
  cursorTarget?: {
    type: 'popular' | 'top_rated' | 'recent' | 'exploration' | 'genre_discover' | 'similar' | 'person_credits';
    key?: string;
  };
  retries: number;
}

/**
 * 250 uygun adayın altına düşünce tetiklenen ve 500'e tamamlayana kadar
 * sınırlı bir iş kuyruğu (bounded work queue) ile çalışan yenileme döngüsü (Sorun C).
 */
export async function replenishCandidatePool({
  profileId,
  mediaType,
  savedItems,
  preferences,
  favoriteActors = [],
  fetchTmdbFn,
  signal,
  force = false,
  concurrency = 3,
  maxTotalRequests = 60,
  onProgress,
}: ReplenishCandidatePoolParams): Promise<PersistentCandidatePoolData> {
  const lockKey = `${profileId}:${mediaType}`;
  const labelPrefix = mediaType === 'tv' ? 'Dizi' : 'Film';

  // Kilit ve iptal davranışını birbirinden ayır:
  // Çağıranın iptal sinyali (signal) yalnızca çağıranın beklemesini iptal eder,
  // arka plandaki kuyruk ve kilit görevi havuz bütünlüğünü korumak için tamamlanır.
  return poolReplenishmentLock.acquire(
    lockKey,
    async () => {
      onProgress?.(`${labelPrefix} aday havuzu doğrulanıyor…`);
      const poolData = loadPersistentPoolData(profileId, mediaType);

      // 1. Beş durum kontrolü ile mevcut havuzu temizle
      poolData.items = filterEligiblePoolItems(poolData.items, savedItems, preferences);

      // 2. Havuz 250 uygun adaya düşünce yenileyip 500'e tamamlama kontrolü (Sorun A düzeltmesi)
      if (!force && poolData.items.length > POOL_LOW_WATERMARK) {
        savePersistentPoolData(profileId, poolData);
        return poolData;
      }

      onProgress?.(`${labelPrefix} keşif kaynaklarından yeni adaylar taranıyor…`);

      const existingItemMap = new Map<string, PoolCandidateItem>();
      for (const it of poolData.items) {
        existingItemMap.set(makeMediaKey(it), it);
      }
      let newlyAdded = 0;
      const cursors = poolData.cursors || (poolData.cursors = createDefaultPoolCursors());
      cursors.genre_discover = cursors.genre_discover || {};
      cursors.similar = cursors.similar || {};
      cursors.person_credits = cursors.person_credits || {};

      const watchedSeeds = filterHistoryByType(savedItems, mediaType)
        .filter((s) => s.status === 'completed' || s.status === 'watching' || Number(s.personal_rating) >= 7)
        .sort((a, b) => Number(b.personal_rating || 7) - Number(a.personal_rating || 7))
        .slice(0, 6);

      const tasteProfile = buildTasteProfileV3(
        filterHistoryByType(savedItems, mediaType),
        { dislikedKeys: filterDislikedByType(preferences.disliked, mediaType) }
      );
      const topGenreIds = tasteProfile.positiveGenres.slice(0, 4);

      // Sorun C: Sınırlı iş kuyruğu (bounded work queue) ile kaynak yönetimi
      const queue: PoolQueueTask[] = [];
      const failedEndpoints = new Set<string>();
      const MAX_RETRIES_PER_ENDPOINT = 2;

      // 1. Popüler kaynak (sayfalanır)
      const popPage = cursors.popular || 1;
      queue.push({
        id: `popular:p${popPage}`,
        source: 'popular',
        endpointKey: 'popular',
        path: `/${mediaType}/popular`,
        params: { page: String(popPage) },
        page: popPage,
        reason: 'Popüler yapımlar arasından',
        cursorTarget: { type: 'popular' },
        retries: 0,
      });

      // 2. Yüksek puanlı kaynak (sayfalanır)
      const topPage = cursors.top_rated || 1;
      queue.push({
        id: `top_rated:p${topPage}`,
        source: 'top_rated',
        endpointKey: 'top_rated',
        path: `/${mediaType}/top_rated`,
        params: { page: String(topPage) },
        page: topPage,
        reason: 'Yüksek puanlı seçkiler',
        cursorTarget: { type: 'top_rated' },
        retries: 0,
      });

      // 3. Yeni / Vizyonda / Yayında kaynak (sayfalanır)
      const recPage = cursors.recent || 1;
      const recentPath = mediaType === 'movie' ? '/movie/now_playing' : '/tv/on_the_air';
      queue.push({
        id: `recent:p${recPage}`,
        source: 'recent',
        endpointKey: 'recent',
        path: recentPath,
        params: { page: String(recPage) },
        page: recPage,
        reason: 'Yeni ve vizyondaki yapımlar',
        cursorTarget: { type: 'recent' },
        retries: 0,
      });

      // 4. Tür keşfi kaynakları (sayfalanır)
      for (const gid of topGenreIds) {
        const gidKey = String(gid);
        const gPage = cursors.genre_discover[gidKey] || 1;
        queue.push({
          id: `genre:${gidKey}:p${gPage}`,
          source: 'genre_discover',
          endpointKey: `genre:${gidKey}`,
          path: `/discover/${mediaType}`,
          params: { with_genres: gidKey, sort_by: 'popularity.desc', page: String(gPage) },
          page: gPage,
          reason: 'Sevdiğin türlerde keşif',
          cursorTarget: { type: 'genre_discover', key: gidKey },
          retries: 0,
        });
      }

      // 5. Benzer içerik kaynakları (sayfalanır)
      for (const seed of watchedSeeds) {
        const seedKey = makeMediaKey(seed);
        const simPage = cursors.similar[seedKey] || 1;
        queue.push({
          id: `similar:${seedKey}:p${simPage}`,
          source: 'similar',
          endpointKey: `similar:${seedKey}`,
          path: `/${mediaType}/${seed.id}/recommendations`,
          params: { page: String(simPage) },
          page: simPage,
          reason: `“${seed.title || seed.name}” yapımına benzer`,
          seedSourceType: seed.status === 'completed' ? 'completed' : 'watching',
          cursorTarget: { type: 'similar', key: seedKey },
          retries: 0,
        });
      }

      // 6. Oyuncu / Yönetmen kaynakları (sayfalanır)
      for (const actor of favoriteActors.slice(0, 3)) {
        const actorKey = String(actor.id);
        const aPage = cursors.person_credits[actorKey] || 1;
        queue.push({
          id: `actor:${actorKey}:p${aPage}`,
          source: 'person_credits',
          endpointKey: `actor:${actorKey}`,
          path: `/discover/${mediaType}`,
          params: { with_cast: actorKey, sort_by: 'popularity.desc', page: String(aPage) },
          page: aPage,
          reason: `Favori oyuncun ${actor.name} kadrosunda`,
          cursorTarget: { type: 'person_credits', key: actorKey },
          retries: 0,
        });
      }

      // 7. Keşif amaçlı kaynak (sayfalanır)
      const expPage = cursors.exploration || 1;
      queue.push({
        id: `exploration:p${expPage}`,
        source: 'exploration',
        endpointKey: 'exploration',
        path: `/discover/${mediaType}`,
        params: {
          'vote_count.gte': '100',
          'vote_count.lte': '2500',
          'vote_average.gte': '7.2',
          sort_by: 'popularity.asc',
          page: String(expPage),
        },
        page: expPage,
        reason: 'Keşfedilmeyi bekleyen yüksek puanlı yapımlar',
        cursorTarget: { type: 'exploration' },
        retries: 0,
      });

      let totalRequestsExecuted = 0;
      let activeWorkers = 0;
      const resolveWaiters: (() => void)[] = [];

      const notifyWorkAvailable = () => {
        if (resolveWaiters.length > 0) {
          const waiter = resolveWaiters.shift();
          if (waiter) waiter();
        }
      };

      const wakeAllWaiters = () => {
        while (resolveWaiters.length > 0) {
          resolveWaiters.shift()?.();
        }
      };

      const waitForWork = (): Promise<void> => {
        return new Promise((resolve) => {
          resolveWaiters.push(resolve);
        });
      };

      const worker = async (): Promise<void> => {
        while (true) {
          // Havuz hedefine (500 adet VE en az 250 yeni benzersiz aday) ulaşıldıysa dur
          const targetSatisfied =
            poolData.items.length >= POOL_TARGET_CAPACITY &&
            newlyAdded >= POOL_REPLENISH_MIN_NEW;

          if (targetSatisfied || totalRequestsExecuted >= maxTotalRequests) {
            wakeAllWaiters();
            break;
          }

          const task = queue.shift();

          if (!task) {
            if (activeWorkers === 0) {
              // Kuyrukta iş kalmadı ve çalışan başka işçi yok; kaynaklar tükendi
              wakeAllWaiters();
              break;
            }
            // Başka işçiler hâlâ çalışıyor olabilir ve yeni sayfalar ekleyebilir, bekle
            await waitForWork();
            continue;
          }

          activeWorkers++;
          try {
            totalRequestsExecuted++;
            const data = await fetchTmdbFn(task.path, task.params);
            const results = Array.isArray(data?.results) ? data.results : [];

            // KURAL 3: Sayfa imlecini YALNIZCA başarılı yanıt sonrasında kesinleştir!
            if (task.cursorTarget) {
              const { type, key } = task.cursorTarget;
              const nextPage = task.page + 1;
              if (type === 'popular') cursors.popular = nextPage;
              else if (type === 'top_rated') cursors.top_rated = nextPage;
              else if (type === 'recent') cursors.recent = nextPage;
              else if (type === 'exploration') cursors.exploration = nextPage;
              else if (type === 'genre_discover' && key) cursors.genre_discover[key] = nextPage;
              else if (type === 'similar' && key) cursors.similar[key] = nextPage;
              else if (type === 'person_credits' && key) cursors.person_credits[key] = nextPage;
            }

            // Adayları havuza ekle ve tekilleştir
            for (const rawItem of results) {
              if (!isCandidateEligibleInPool(rawItem, savedItems, preferences)) continue;
              const candidate = normalizePoolCandidate(
                rawItem,
                mediaType,
                task.source,
                task.reason,
                task.seedSourceType
              );
              if (!candidate) continue;

              const key = makeMediaKey(candidate);
              const existingItem = existingItemMap.get(key);
              if (existingItem) {
                existingItem.poolSources = (existingItem.poolSources || 1) + 1;
                if (task.seedSourceType && !existingItem.seedSourceType) {
                  existingItem.seedSourceType = task.seedSourceType;
                  if (task.reason) existingItem.poolReason = task.reason;
                }
                continue;
              }

              existingItemMap.set(key, candidate);
              poolData.items.push(candidate);
              newlyAdded += 1;
            }

            // KURAL 1: Havuz hedefine ulaşılmadıysa ve kaynakta sonraki sayfa varsa kuyruğa ekle
            const hasMorePages =
              results.length > 0 &&
              task.page < (Number(data?.total_pages) || 100) &&
              task.page < 50;

            const stillNeedsMore =
              poolData.items.length < POOL_TARGET_CAPACITY ||
              newlyAdded < POOL_REPLENISH_MIN_NEW;

            if (hasMorePages && stillNeedsMore && !failedEndpoints.has(task.endpointKey)) {
              queue.push({
                id: `${task.endpointKey}:p${task.page + 1}`,
                source: task.source,
                endpointKey: task.endpointKey,
                path: task.path,
                params: { ...task.params, page: String(task.page + 1) },
                page: task.page + 1,
                reason: task.reason,
                seedSourceType: task.seedSourceType,
                cursorTarget: task.cursorTarget,
                retries: 0,
              });
              notifyWorkAvailable();
            }
          } catch {
            // KURAL 2: Hata alan kaynağı boş saymak yerine TEKRAR DENENEBİLİR olarak kaydet.
            // Sayfa imleci İLERLETİLMEZ; böylece bu ve sonraki koşuda tekrar denenir.
            if (task.retries < MAX_RETRIES_PER_ENDPOINT) {
              queue.push({
                ...task,
                retries: task.retries + 1,
              });
              notifyWorkAvailable();
            } else {
              failedEndpoints.add(task.endpointKey);
            }
          } finally {
            activeWorkers--;
            notifyWorkAvailable();
          }
        }
      };

      const workerCount = Math.max(1, Math.min(concurrency, queue.length));
      const workers = Array.from({ length: workerCount }, () => worker());
      await Promise.all(workers);

      onProgress?.(`${labelPrefix} havuzu tür ve dönem dengesine göre optimize ediliyor…`);
      // 5. Çok boyutlu denge kur (tür, dönem, popülerlik) ve 500 hedefine kırp
      poolData.items = balanceCandidatePool(poolData.items, POOL_TARGET_CAPACITY);
      poolData.updatedAt = new Date().toISOString();

      // 6. Güncellenmiş imleçler ve havuzu kalıcı kaydet
      savePersistentPoolData(profileId, poolData);

      return poolData;
    },
    signal
  );
}


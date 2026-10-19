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
  updatedAt?: string;
  custom?: boolean;
  cast?: { id: number; name: string; popularity?: number; profile_path?: string; character?: string }[];
  crew?: { id: number; name: string; job: string; department?: string }[];
  poolSource?: string;
  poolReason?: string;
  poolSources?: number;
}

export interface Preferences {
  disliked: string[];
  providers: string[];
  mood: string;
  reminders: boolean;
  notified: string[];
}

export interface Profile {
  id: string;
  name: string;
  createdAt: string;
  preferences: Preferences;
  items: SavedItem[];
}

export interface DataDocument {
  version: 3;
  activeProfileId: string;
  profiles: Profile[];
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
    genre_ids: Array.isArray(item.genre_ids)
      ? item.genre_ids
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
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    custom: Boolean(item.custom || String(item.id).startsWith('custom-')),
  };
}

export function dedupeItems(items: SavedItem[]): SavedItem[] {
  const unique = new Map<string, SavedItem>();
  for (const item of items) {
    const key = `${item.media_type}:${item.id}`;
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
    const normalized = normalizeSavedItem({
      ...newest,
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
} {
  const backup = JSON.parse(text);
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    throw new Error('Bu dosya geçerli bir CineTrack yedeği değil.');
  }
  if (![1, 2].includes(backup.version) || !Array.isArray(backup.items)) {
    throw new Error('Bu dosya geçerli bir CineTrack yedeği değil.');
  }
  if (
    backup.items.some(
      (item: any) =>
        !item ||
        typeof item !== 'object' ||
        !validItemId(item.id) ||
        !['movie', 'tv'].includes(item.media_type)
    )
  ) {
    throw new Error('Yedekte geçersiz içerik kimliği veya türü var. Güvenlik nedeniyle içe aktarma durduruldu.');
  }
  return {
    items: dedupeItems(backup.items.map(normalizeSavedItem).filter(Boolean) as SavedItem[]),
    profileName: typeof backup.profileName === 'string' ? backup.profileName.trim().slice(0, 40) : '',
    preferences:
      backup.preferences && typeof backup.preferences === 'object' && !Array.isArray(backup.preferences)
        ? backup.preferences
        : null,
  };
}

export const PROFILE_ID_PATTERN = /^profile-[A-Za-z0-9_-]{1,60}$/;
export const DISLIKED_KEY_PATTERN = /^(?:movie|tv):(?:[1-9]\d{0,11}|custom-[A-Za-z0-9_-]{1,80})$/;

export function normalizePreferences(
  raw: any,
  { knownMoods = null }: { knownMoods?: string[] | null } = {}
): Preferences {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    disliked: Array.isArray(source.disliked)
      ? source.disliked
          .filter((key: any) => typeof key === 'string' && DISLIKED_KEY_PATTERN.test(key))
          .slice(-500)
      : [],
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
  { maxItems = 5000, knownMoods = null }: { maxItems?: number; knownMoods?: string[] | null } = {}
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
  };
}

export function normalizeDataDocument(
  raw: any,
  { maxProfiles = 20, maxItems = 5000 }: { maxProfiles?: number; maxItems?: number } = {}
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
  return {
    version: 3,
    activeProfileId: seen.has(activeCandidate) ? activeCandidate : profiles[0].id,
    profiles,
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

export const RECOMMENDATION_WEIGHTS = Object.freeze({
  genre: 0.25,
  taste: 0.2,
  actor: 0.2,
  quality: 0.15,
  crew: 0.08,
  platform: 0.07,
  exploration: 0.05,
});

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

export function tasteValue(item: any): number | null {
  if (!item || typeof item !== 'object') return null;
  const rating = Number(item.personal_rating);
  if (Number.isFinite(rating) && rating >= 1) return Math.min(1, Math.max(-1, (rating - 5) / 5));
  if (item.status === 'completed') return 0.4;
  if (item.status === 'watching') return 0.2;
  return null;
}

function incrementAccumulator(
  accumulator: Record<string, any>,
  key: string | number,
  value: number,
  weight: number
) {
  const entry = accumulator[key] || { name: '', num: 0, den: 0 };
  entry.num += value * weight;
  entry.den += weight;
  accumulator[key] = entry;
  return entry;
}

export function buildTasteProfile(
  items: any[],
  {
    includeWatchlist = false,
    completedMultiplier = 1,
    watchingMultiplier = 1,
    watchlistMultiplier = 1,
  }: {
    includeWatchlist?: boolean;
    completedMultiplier?: number;
    watchingMultiplier?: number;
    watchlistMultiplier?: number;
  } = {}
) {
  const actors: Record<string, any> = {};
  const directors: Record<string, any> = {};
  const genres: Record<string, any> = {};
  const typeCounts: Record<string, number> = { movie: 0, tv: 0 };

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    let value = tasteValue(item);
    if (value === null) {
      if (includeWatchlist && item.status === 'watchlist') {
        value = 0.2; // Gentle positive signal for items chosen in watchlist
      } else {
        continue;
      }
    }

    // Watched items have much stronger influence on taste profile than watchlist items
    let statusWeight = 1;
    if (item.status === 'completed') {
      statusWeight = completedMultiplier;
    } else if (item.status === 'watching') {
      statusWeight = watchingMultiplier;
    } else if (item.status === 'watchlist') {
      statusWeight = watchlistMultiplier;
    }

    typeCounts[item.media_type] = (typeCounts[item.media_type] || 0) + statusWeight;
    for (const genreId of Array.isArray(item.genre_ids) ? item.genre_ids : []) {
      incrementAccumulator(genres, genreId, value, statusWeight);
    }
    const cast = Array.isArray(item.cast) ? item.cast : [];
    cast.forEach((person: any, order: number) => {
      const personId = person?.id;
      if (personId == null || !person.name) return;
      const weight = billingWeight(order) * statusWeight;
      incrementAccumulator(actors, personId, value, weight).name = person.name;
      for (const genreId of Array.isArray(item.genre_ids) ? item.genre_ids : []) {
        const genreAccumulator = actors[personId].genreAccumulator || (actors[personId].genreAccumulator = {});
        incrementAccumulator(genreAccumulator, genreId, value, weight);
      }
    });
    const crew = Array.isArray(item.crew) ? item.crew : [];
    for (const member of crew) {
      if (member?.id == null || !member.name) continue;
      if (member.job !== 'Director' && member.job !== 'Creator') continue;
      incrementAccumulator(directors, member.id, value, statusWeight).name = member.name;
    }
  }

  const normalize = (accumulator: Record<string, any>) => {
    const output: Record<string, any> = {};
    for (const [key, entry] of Object.entries(accumulator)) {
      const genreAccumulator = entry.genreAccumulator;
      const genreScores: Record<string, number> = {};
      if (genreAccumulator) {
        for (const [genreKey, genreEntry] of Object.entries(genreAccumulator) as [string, any][]) {
          if (genreEntry.den <= 0) continue;
          genreScores[genreKey] = Math.min(1, Math.max(-1, genreEntry.num / genreEntry.den));
        }
      }
      output[key] = {
        name: entry.name,
        personal: entry.den > 0 ? Math.min(1, Math.max(-1, entry.num / entry.den)) : 0,
        genreScores,
      };
    }
    return output;
  };

  const genreScores: Record<string, number> = {};
  for (const [key, entry] of Object.entries(genres)) {
    if (entry.den > 0) genreScores[key] = Math.min(1, Math.max(-1, entry.num / entry.den));
  }
  const total = typeCounts.movie + typeCounts.tv;
  return {
    actors: normalize(actors),
    directors: normalize(directors),
    genres: genreScores,
    mediaPreference: total
      ? {
          movie: (typeCounts.movie || 0) / total,
          tv: (typeCounts.tv || 0) / total,
        }
      : { movie: 0.5, tv: 0.5 },
  };
}

export function scoreCandidates(
  candidates: any[],
  profile: any,
  {
    weights = RECOMMENDATION_WEIGHTS as any,
    preferredProviders = [] as string[],
    providerIndex = null as Record<string, any[]> | null,
    genreNames = null as Record<string, string> | null,
  } = {}
) {
  const preferred = new Set(preferredProviders.map(String));
  const likedGenres = Object.entries(profile.genres || {})
    .filter(([, score]: any) => score > 0)
    .sort((a: any, b: any) => b[1] - a[1]);
  const topGenreIds = new Set(likedGenres.slice(0, 3).map(([id]) => String(id)));
  const actorOf = (personId: any) => profile.actors?.[personId] || null;
  const directorOf = (personId: any) => profile.directors?.[personId] || null;

  return (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const genreIds = (Array.isArray(candidate.genre_ids) ? candidate.genre_ids : []).map(String);
    const cast = (Array.isArray(candidate.cast) ? candidate.cast : []).slice(0, 8);
    const crew = Array.isArray(candidate.crew) ? candidate.crew : [];

    const knownGenreScores = genreIds
      .map((id: string) => profile.genres?.[id])
      .filter((score: any) => typeof score === 'number');
    const genrePart = knownGenreScores.length
      ? clamp01(
          knownGenreScores.reduce((sum: number, score: number) => sum + (score + 1) / 2, 0) /
            knownGenreScores.length
        )
      : 0.5;
    const mediaPart = clamp01(profile.mediaPreference?.[candidate.media_type] ?? 0.5);
    const genreScore = 0.75 * genrePart + 0.25 * mediaPart;

    let tasteScore = genrePart;
    let actorScore = 0.5;
    let unknownCast = true;
    if (cast.length) {
      let tasteNum = 0;
      let tasteDen = 0;
      let actorNum = 0;
      let actorDen = 0;
      let unknownCount = 0;
      for (const [index, person] of cast.entries()) {
        if (person?.id == null) continue;
        const weight = billingWeight(index);
        const known = actorOf(person.id);
        if (!known) unknownCount += 1;
        const personal = known ? (known.personal + 1) / 2 : 0.5;
        tasteNum += personal * weight;
        tasteDen += weight;
        const popularity = Number(person.popularity);
        const general =
          Number.isFinite(popularity) && popularity > 0 ? clamp01(popularity / (popularity + 100)) : 0.5;
        let personalBlend = personal;
        if (known) {
          const sharedGenre = genreIds.find((genreId: string) => typeof known.genreScores?.[genreId] === 'number');
          if (sharedGenre) personalBlend = 0.6 * ((known.genreScores[sharedGenre] + 1) / 2) + 0.4 * personal;
        }
        actorNum += (0.4 * general + 0.6 * personalBlend) * weight;
        actorDen += weight;
      }
      if (tasteDen > 0) tasteScore = clamp01(tasteNum / tasteDen);
      if (actorDen > 0) {
        actorScore = clamp01(actorNum / actorDen);
        unknownCast = unknownCount === cast.length;
      }
    }

    const qualityScore = clamp01(bayesianRating(candidate.vote_average, candidate.vote_count) / 10);

    const directorEntry = crew.find(
      (member: any) => member?.id != null && (member.job === 'Director' || member.job === 'Creator')
    );
    const knownDirector = directorEntry ? directorOf(directorEntry.id) : null;
    const crewScore = knownDirector ? clamp01((knownDirector.personal + 1) / 2) : 0.5;

    const key = `${candidate.media_type}:${candidate.id}`;
    const providers = providerIndex?.[key] || null;
    let platformScore = 0.5;
    let platformTag = '';
    if (providers) {
      const providerIds = providers.map((provider: any) => String(provider.id));
      const preferredHit = providerIds
        .filter((id: string) => preferred.has(id))
        .map((id: string) => providers.find((provider: any) => String(provider.id) === id)?.name)
        .filter(Boolean);
      if (preferredHit.length) {
        platformScore = 1;
        platformTag = `Tercih ettiğin platformda izlenebilir: ${preferredHit.slice(0, 2).join(', ')}`;
      } else if (providerIds.length) {
        platformScore = 0.6;
        platformTag = `İzlenebilir: ${providers
          .slice(0, 2)
          .map((provider: any) => provider.name)
          .filter(Boolean)
          .join(', ')}`;
      } else {
        platformScore = 0.25;
      }
    }

    const overlapWithTop = genreIds.filter((id: string) => topGenreIds.has(id)).length;
    const topGenreOverlap = genreIds.length ? overlapWithTop / genreIds.length : 0;
    const explorationScore = unknownCast
      ? clamp01(0.7 + 0.3 * (1 - topGenreOverlap))
      : clamp01(
          0.5 *
            (cast.length ? cast.filter((person: any) => !actorOf(person?.id)).length / cast.length : 0.5) +
            0.5 * (1 - topGenreOverlap)
        );

    const parts: Record<string, number> = {
      genre: genreScore,
      taste: tasteScore,
      actor: actorScore,
      quality: qualityScore,
      crew: crewScore,
      platform: platformScore,
      exploration: explorationScore,
    };
    let total = Object.entries(weights).reduce(
      (sum, [name, weight]) => sum + (parts[name] ?? 0.5) * (weight as number),
      0
    );

    // Recommendations derived from watched items have higher contribution
    if (candidate.seedSourceType === 'completed' || candidate.seedSourceType === 'watching') {
      total = clamp01(total + 0.08);
    } else if (candidate.seedSourceType === 'watchlist') {
      total = clamp01(total + 0.02);
    }

    const tags: string[] = [];
    if (candidate.poolReason) tags.push(candidate.poolReason);
    const bestActor = cast
      .map((person: any) => ({ person, known: actorOf(person?.id) }))
      .filter((entry: any) => entry.known && entry.known.personal >= 0.3)
      .sort((a: any, b: any) => b.known.personal - a.known.personal)[0];
    if (bestActor) tags.push(`Sevdiğin ${bestActor.known.name} oynuyor`);
    const bestGenre = likedGenres.find(([id]) => genreIds.includes(id));
    const bestGenreTag =
      bestGenre && genreNames?.[bestGenre[0]] ? `${genreNames[bestGenre[0]]} türünü sevdiğin için` : '';
    if (bestGenreTag && bestGenreTag !== candidate.poolReason) tags.push(bestGenreTag);
    if (knownDirector && knownDirector.personal >= 0.3) tags.push(`Sevdiğin yönetmen ${knownDirector.name}`);
    if (platformTag) tags.push(platformTag);
    if (qualityScore >= 0.7)
      tags.push(`TMDB'de ${bayesianRating(candidate.vote_average, candidate.vote_count).toFixed(1)} puan`);
    if (explorationScore >= 0.75) tags.push('Yeni keşif için');

    return { candidate, score: total, parts, tags: tags.slice(0, 4) };
  });
}

export function diversifyList(scored: any[], { limit = 24, maxPerGenre = 6 } = {}) {
  const ordered = [...(Array.isArray(scored) ? scored : [])].sort((a, b) => b.score - a.score);
  const dominantGenre = (entry: any) =>
    (entry.candidate?.genre_ids || [])[0] != null ? String(entry.candidate.genre_ids[0]) : '';
  const picked: any[] = [];
  const counts: Record<string, number> = {};
  for (const entry of ordered) {
    if (picked.length >= limit) break;
    const genre = dominantGenre(entry);
    if (genre && (counts[genre] || 0) >= maxPerGenre) continue;
    picked.push(entry);
    if (genre) counts[genre] = (counts[genre] || 0) + 1;
  }
  return picked;
}

export function createCandidatePool({ maxItems = 2000 } = {}) {
  const map = new Map<string, any>();
  return {
    add(
      source: string,
      reason: string,
      mediaTypeGuess: string,
      items: any[],
      seedSourceType: 'completed' | 'watching' | 'watchlist' | '' = ''
    ) {
      for (const item of Array.isArray(items) ? items : []) {
        if (!item || typeof item !== 'object' || item.id == null) continue;
        const mediaType =
          item.media_type === 'movie' || item.media_type === 'tv' ? item.media_type : mediaTypeGuess;
        if (mediaType !== 'movie' && mediaType !== 'tv') continue;
        const key = `${mediaType}:${item.id}`;
        const existing = map.get(key);
        if (existing) {
          existing.poolSources += 1;
          if (seedSourceType === 'completed' || seedSourceType === 'watching') {
            existing.seedSourceType = seedSourceType;
            if (reason) existing.poolReason = reason;
          }
          continue;
        }
        if (map.size >= maxItems) continue;
        map.set(key, {
          ...item,
          media_type: mediaType,
          poolSource: source,
          poolReason: reason || '',
          seedSourceType: seedSourceType || '',
          poolSources: 1,
        });
      }
    },
    get size() {
      return map.size;
    },
    list() {
      return [...map.values()];
    },
  };
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
  }: {
    lambda?: number;
    now?: number;
    dislikedKeys?: string[];
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

  const rawItems: any[] = [...(Array.isArray(items) ? items : [])];

  // Incorporate explicit disliked signals if provided as keys
  for (const key of dislikedKeys) {
    if (!key || typeof key !== 'string') continue;
    const [mediaType, idStr] = key.split(':');
    if (!idStr || !['movie', 'tv'].includes(mediaType)) continue;
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
      const uKey = `${mediaType}:${id}`;
      if (seenItemKeys.has(uKey)) {
        const existingIndex = allItems.findIndex(
          (entry) => `${entry.media_type}:${entry.id}` === uKey
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
      lovedSeedIds.add(`${item.media_type}:${item.id}`);
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

export function scoreCandidatesV3(
  candidates: any[],
  profile: TasteProfileV3,
  {
    weights = RECOMMENDATION_WEIGHTS_V3,
    genreNames = null as Record<number | string, string> | null,
    mood = '',
  }: {
    weights?: typeof RECOMMENDATION_WEIGHTS_V3;
    genreNames?: Record<number | string, string> | null;
    mood?: string;
  } = {}
) {
  const actorOf = (id: any) => profile.actors?.[String(id)] || null;
  const directorOf = (id: any) => profile.directors?.[String(id)] || null;
  const topGenreSet = new Set(profile.positiveGenres.slice(0, 4));

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

    return {
      candidate,
      score: rawScore,
      parts,
      tags: tags.slice(0, 4),
    };
  });
}

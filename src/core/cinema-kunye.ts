import type { SavedItem } from './cinetrack-core.ts';

export const CINEMA_KUNYE_SCHEMA_VERSION = 1;

export interface CinemaKunyeGenre {
  id: number;
  name: string;
}

export interface CinemaKunyeActor {
  id: number;
  name: string;
  character?: string;
  profile_path?: string;
}

export interface CinemaKunyeEntry {
  contentId: string;
  title: string;
  year: number | null;
  mediaType: 'movie' | 'tv';
  tmdbId?: number;
  genreIds: number[];
  genres: CinemaKunyeGenre[];
  actors: CinemaKunyeActor[];
  updatedAt: string;
}

export interface CinemaKunyeDocument {
  schemaVersion: number;
  updatedAt: string;
  entries: Record<string, CinemaKunyeEntry>;
}

export const DEFAULT_CINEMA_KUNYE_GENRES: Record<number, string> = {
  28: 'Aksiyon',
  12: 'Macera',
  16: 'Animasyon',
  35: 'Komedi',
  80: 'Suç',
  99: 'Belgesel',
  18: 'Dram',
  10751: 'Aile',
  14: 'Fantastik',
  36: 'Tarih',
  27: 'Korku',
  10402: 'Müzik',
  9648: 'Gizem',
  10749: 'Romantik',
  878: 'Bilim Kurgu',
  10770: 'TV Filmi',
  53: 'Gerilim',
  10752: 'Savaş',
  37: 'Vahşi Batı',
  10759: 'Aksiyon & Macera',
  10762: 'Çocuk',
  10763: 'Haber',
  10764: 'Reality',
  10765: 'Bilim Kurgu & Fantazi',
  10766: 'Pembe Dizi',
  10767: 'Talk Show',
  10768: 'Savaş & Politik',
};

const GENRE_NAME_LOOKUP: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  const register = (label: string, id: number) => {
    const key = foldTurkishAscii(label).toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (key) map[key] = id;
  };
  for (const [idStr, name] of Object.entries(DEFAULT_CINEMA_KUNYE_GENRES)) {
    register(name, Number(idStr));
  }
  const englishAliases: Array<[string, number]> = [
    ['Action', 28],
    ['Adventure', 12],
    ['Animation', 16],
    ['Comedy', 35],
    ['Crime', 80],
    ['Documentary', 99],
    ['Drama', 18],
    ['Family', 10751],
    ['Fantasy', 14],
    ['History', 36],
    ['Horror', 27],
    ['Music', 10402],
    ['Mystery', 9648],
    ['Romance', 10749],
    ['Science Fiction', 878],
    ['Sci-Fi', 878],
    ['TV Movie', 10770],
    ['Thriller', 53],
    ['War', 10752],
    ['Western', 37],
    ['Action & Adventure', 10759],
    ['Sci-Fi & Fantasy', 10765],
  ];
  for (const [alias, id] of englishAliases) {
    register(alias, id);
  }
  return map;
})();

function foldTurkishAscii(input: string): string {
  return String(input || '')
    .replace(/İ/g, 'i')
    .replace(/I/g, 'i')
    .replace(/ı/g, 'i')
    .replace(/Ğ/g, 'g')
    .replace(/ğ/g, 'g')
    .replace(/Ü/g, 'u')
    .replace(/ü/g, 'u')
    .replace(/Ş/g, 's')
    .replace(/ş/g, 's')
    .replace(/Ö/g, 'o')
    .replace(/ö/g, 'o')
    .replace(/Ç/g, 'c')
    .replace(/ç/g, 'c')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function slugifyCinemaKunyeTitle(title: string): string {
  const folded = foldTurkishAscii(title).toLowerCase().trim();
  const asciiSlug = folded
    .replace(/[^a-z0-9\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
    .replace(/-+$/g, '');
  return asciiSlug || 'icerik';
}

export function normalizeReleaseYear(rawYear: unknown): number | null {
  if (typeof rawYear === 'number' && Number.isFinite(rawYear)) {
    const yr = Math.floor(rawYear);
    return yr >= 1888 && yr <= 2099 ? yr : null;
  }
  if (typeof rawYear === 'string' && rawYear.trim()) {
    const match = /(\d{4})/.exec(rawYear.trim());
    if (match) {
      const yr = Number(match[1]);
      return yr >= 1888 && yr <= 2099 ? yr : null;
    }
  }
  return null;
}

/**
 * Film/dizi adı + yıl bilgisinden deterministik içerik ID'si üretir.
 * Örn: ("Kış Uykusu", 2014) -> "kis-uykusu-2014"
 */
export function buildCinemaKunyeContentId(
  title: string,
  year?: number | string | null
): string {
  const slug = slugifyCinemaKunyeTitle(title);
  const validYear = normalizeReleaseYear(year);
  return `${slug}-${validYear ?? 'belirsiz'}`;
}

export function extractItemReleaseYear(item: Partial<SavedItem> | null | undefined): number | null {
  if (!item) return null;
  return normalizeReleaseYear(item.release_date || item.first_air_date || '');
}

export function isWatchedForCinemaKunye(item: Partial<SavedItem> | null | undefined): boolean {
  if (!item) return false;
  if (item.status === 'completed' || item.status === 'watching') return true;
  if (
    typeof item.personal_rating === 'number' &&
    Number.isFinite(item.personal_rating) &&
    item.personal_rating >= 1
  ) {
    return true;
  }
  if (typeof item.episodes_watched === 'number' && item.episodes_watched > 0) {
    return true;
  }
  return false;
}

function syntheticActorIdFromName(name: string): number {
  const clean = foldTurkishAscii(name).toLowerCase().trim();
  let hash = 2166136261;
  for (let i = 0; i < clean.length; i += 1) {
    hash ^= clean.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 900_000_000 + (Math.abs(hash) % 99_000_000);
}

export function createEmptyCinemaKunyeDocument(updatedAt = ''): CinemaKunyeDocument {
  return {
    schemaVersion: CINEMA_KUNYE_SCHEMA_VERSION,
    updatedAt,
    entries: {},
  };
}

export function normalizeCinemaKunyeActorList(rawActors: unknown, maxCount = 12): CinemaKunyeActor[] {
  if (!Array.isArray(rawActors)) return [];
  const byNameKey = new Map<string, CinemaKunyeActor>();

  for (const raw of rawActors) {
    if (!raw) continue;
    let name = '';
    let id = 0;
    let character: string | undefined;
    let profilePath: string | undefined;

    if (typeof raw === 'string') {
      name = raw.trim().slice(0, 120);
      if (!name) continue;
      id = syntheticActorIdFromName(name);
    } else if (typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      name = typeof obj.name === 'string' ? obj.name.trim().slice(0, 120) : '';
      if (!name) continue;
      const numId = Number(obj.id);
      id = Number.isSafeInteger(numId) && numId > 0 ? numId : syntheticActorIdFromName(name);
      if (typeof obj.character === 'string' && obj.character.trim()) {
        character = obj.character.trim().slice(0, 120);
      }
      if (typeof obj.profile_path === 'string' && obj.profile_path.trim()) {
        profilePath = obj.profile_path.trim().slice(0, 200);
      }
    } else {
      continue;
    }

    const dedupeKey = foldTurkishAscii(name).toLowerCase().replace(/[^a-z0-9]+/g, '') || String(id);
    const existing = byNameKey.get(dedupeKey);
    if (!existing) {
      byNameKey.set(dedupeKey, {
        id,
        name,
        ...(character ? { character } : {}),
        ...(profilePath ? { profile_path: profilePath } : {}),
      });
    } else {
      const preferNewId = existing.id >= 900_000_000 && id > 0 && id < 900_000_000;
      byNameKey.set(dedupeKey, {
        id: preferNewId ? id : existing.id,
        name: existing.name.length >= name.length ? existing.name : name,
        ...(existing.character || character ? { character: existing.character || character } : {}),
        ...(existing.profile_path || profilePath
          ? { profile_path: existing.profile_path || profilePath }
          : {}),
      });
    }

    if (byNameKey.size >= maxCount) break;
  }

  return Array.from(byNameKey.values()).slice(0, maxCount);
}

export function resolveGenresFromRaw(
  rawGenreIds: unknown,
  rawGenres: unknown,
  genreMap: Record<number, string> = {}
): { genreIds: number[]; genres: CinemaKunyeGenre[] } {
  const effectiveMap: Record<number, string> = {
    ...DEFAULT_CINEMA_KUNYE_GENRES,
    ...genreMap,
  };
  const genreById = new Map<number, string>();

  if (Array.isArray(rawGenreIds)) {
    for (const rawId of rawGenreIds) {
      const num = Number(rawId);
      if (Number.isSafeInteger(num) && num > 0) {
        genreById.set(num, effectiveMap[num] || `Tür #${num}`);
      }
    }
  }

  if (Array.isArray(rawGenres)) {
    for (const g of rawGenres) {
      if (!g) continue;
      if (typeof g === 'number' && Number.isSafeInteger(g) && g > 0) {
        genreById.set(g, genreById.get(g) || effectiveMap[g] || `Tür #${g}`);
      } else if (typeof g === 'string' && g.trim()) {
        const trimmed = g.trim();
        const lookupKey = foldTurkishAscii(trimmed).toLowerCase().replace(/[^a-z0-9]+/g, '');
        const resolvedId = GENRE_NAME_LOOKUP[lookupKey];
        if (resolvedId) {
          genreById.set(resolvedId, effectiveMap[resolvedId] || trimmed);
        }
      } else if (typeof g === 'object') {
        const obj = g as Record<string, unknown>;
        const numId = Number(obj.id);
        const rawName = typeof obj.name === 'string' ? obj.name.trim() : '';
        if (Number.isSafeInteger(numId) && numId > 0) {
          genreById.set(numId, rawName || effectiveMap[numId] || `Tür #${numId}`);
        } else if (rawName) {
          const lookupKey = foldTurkishAscii(rawName).toLowerCase().replace(/[^a-z0-9]+/g, '');
          const resolvedId = GENRE_NAME_LOOKUP[lookupKey];
          if (resolvedId) {
            genreById.set(resolvedId, effectiveMap[resolvedId] || rawName);
          }
        }
      }
    }
  }

  const sortedIds = Array.from(genreById.keys()).sort((a, b) => a - b);
  const genres: CinemaKunyeGenre[] = sortedIds.map((id) => ({
    id,
    name: genreById.get(id) || effectiveMap[id] || `Tür #${id}`,
  }));

  return { genreIds: sortedIds, genres };
}

export function normalizeCinemaKunyeEntry(
  raw: unknown,
  fallbackKey?: string,
  genreMap: Record<number, string> = {}
): CinemaKunyeEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const rawTitle = typeof obj.title === 'string' ? obj.title.trim().slice(0, 160) : '';
  if (!rawTitle) return null;

  const year = normalizeReleaseYear(obj.year);
  const mediaType: 'movie' | 'tv' = obj.mediaType === 'tv' ? 'tv' : 'movie';
  const rawTmdb = Number(obj.tmdbId);
  const tmdbId = Number.isSafeInteger(rawTmdb) && rawTmdb > 0 ? rawTmdb : undefined;

  const { genreIds, genres } = resolveGenresFromRaw(obj.genreIds, obj.genres, genreMap);
  const actors = normalizeCinemaKunyeActorList(obj.actors, 12);
  const computedId = buildCinemaKunyeContentId(rawTitle, year);
  const contentId =
    typeof obj.contentId === 'string' && obj.contentId.trim() && year !== null
      ? computedId
      : computedId || (fallbackKey ? fallbackKey.trim() : computedId);
  const updatedAt = typeof obj.updatedAt === 'string' ? obj.updatedAt.trim() : '';

  return {
    contentId,
    title: rawTitle,
    year,
    mediaType,
    ...(tmdbId ? { tmdbId } : {}),
    genreIds,
    genres,
    actors,
    updatedAt,
  };
}

function isPlaceholderTitle(title: string): boolean {
  const lower = title.trim().toLowerCase();
  return !lower || lower === 'başlıksız içerik' || lower === 'isimsiz' || lower === 'i̇simsiz';
}

function pickLatestIsoString(a?: string, b?: string): string {
  const sa = typeof a === 'string' ? a.trim() : '';
  const sb = typeof b === 'string' ? b.trim() : '';
  if (!sa) return sb;
  if (!sb) return sa;
  return sb > sa ? sb : sa;
}

export function mergeCinemaKunyeEntriesLossless(
  existing: CinemaKunyeEntry,
  incoming: CinemaKunyeEntry,
  genreMap: Record<number, string> = {}
): CinemaKunyeEntry {
  const incomingNewer =
    Boolean(incoming.updatedAt) &&
    (!existing.updatedAt || incoming.updatedAt > existing.updatedAt);

  const primary = incomingNewer ? incoming : existing;
  const secondary = primary === incoming ? existing : incoming;

  const mergedTitle = !isPlaceholderTitle(primary.title)
    ? primary.title
    : !isPlaceholderTitle(secondary.title)
    ? secondary.title
    : primary.title || secondary.title;

  const mergedYear = primary.year ?? secondary.year ?? null;
  const mergedMediaType = primary.mediaType || secondary.mediaType;
  const mergedTmdbId = primary.tmdbId ?? secondary.tmdbId;

  const { genreIds, genres } = resolveGenresFromRaw(
    [...(existing.genreIds || []), ...(incoming.genreIds || [])],
    [...(existing.genres || []), ...(incoming.genres || [])],
    genreMap
  );

  const richerActorFirst =
    incoming.actors.length > existing.actors.length
      ? [...incoming.actors, ...existing.actors]
      : [...existing.actors, ...incoming.actors];
  const actors = normalizeCinemaKunyeActorList(richerActorFirst, 12);

  const contentId = buildCinemaKunyeContentId(mergedTitle, mergedYear);
  const updatedAt = pickLatestIsoString(existing.updatedAt, incoming.updatedAt);

  return {
    contentId,
    title: mergedTitle,
    year: mergedYear,
    mediaType: mergedMediaType,
    ...(mergedTmdbId ? { tmdbId: mergedTmdbId } : {}),
    genreIds,
    genres,
    actors,
    updatedAt,
  };
}

function insertKunyeEntryIntoMap(
  target: Map<string, CinemaKunyeEntry>,
  entry: CinemaKunyeEntry,
  genreMap: Record<number, string> = {}
): void {
  // 1) Aynı mediaType + tmdbId ile eşleşen kayıt varsa birleştir (örn. belirsiz yıl -> bilinen yıl terfisi)
  if (entry.tmdbId) {
    for (const [key, prev] of target.entries()) {
      if (prev.mediaType === entry.mediaType && prev.tmdbId === entry.tmdbId) {
        const merged = mergeCinemaKunyeEntriesLossless(prev, entry, genreMap);
        if (key !== merged.contentId) {
          target.delete(key);
        }
        const destKey = resolveKeyForMediaTypeCollision(target, merged);
        target.set(destKey, { ...merged, contentId: destKey });
        return;
      }
    }
  }

  // 2) Başlık aynı olup biri "-belirsiz" diğeri gerçek yıllı ise birleştir
  const slug = slugifyCinemaKunyeTitle(entry.title);
  const unknownKey = `${slug}-belirsiz`;
  if (entry.year !== null && target.has(unknownKey)) {
    const prevUnknown = target.get(unknownKey)!;
    if (prevUnknown.mediaType === entry.mediaType) {
      target.delete(unknownKey);
      const merged = mergeCinemaKunyeEntriesLossless(prevUnknown, entry, genreMap);
      const destKey = resolveKeyForMediaTypeCollision(target, merged);
      target.set(destKey, { ...merged, contentId: destKey });
      return;
    }
  }
  if (entry.year === null) {
    for (const [key, prev] of target.entries()) {
      if (
        prev.mediaType === entry.mediaType &&
        prev.year !== null &&
        slugifyCinemaKunyeTitle(prev.title) === slug
      ) {
        const merged = mergeCinemaKunyeEntriesLossless(prev, entry, genreMap);
        target.set(key, { ...merged, contentId: key });
        return;
      }
    }
  }

  // 3) Doğrudan contentId çakışması
  const destKey = resolveKeyForMediaTypeCollision(target, entry);
  const existing = target.get(destKey);
  if (existing) {
    const merged = mergeCinemaKunyeEntriesLossless(existing, entry, genreMap);
    target.set(destKey, { ...merged, contentId: destKey });
  } else {
    target.set(destKey, { ...entry, contentId: destKey });
  }
}

function resolveKeyForMediaTypeCollision(
  target: Map<string, CinemaKunyeEntry>,
  entry: CinemaKunyeEntry
): string {
  const baseId = buildCinemaKunyeContentId(entry.title, entry.year);
  const existing = target.get(baseId);
  if (!existing || existing.mediaType === entry.mediaType) {
    return baseId;
  }
  return `${baseId}-${entry.mediaType}`;
}

export function normalizeCinemaKunyeDocument(
  raw: unknown,
  genreMap: Record<number, string> = {}
): CinemaKunyeDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return createEmptyCinemaKunyeDocument('');
  }
  const obj = raw as Record<string, unknown>;
  const rawEntries = obj.entries;
  const map = new Map<string, CinemaKunyeEntry>();
  let latestEntryTs = typeof obj.updatedAt === 'string' ? obj.updatedAt.trim() : '';

  if (Array.isArray(rawEntries)) {
    for (const item of rawEntries) {
      const normalized = normalizeCinemaKunyeEntry(item, undefined, genreMap);
      if (normalized) {
        latestEntryTs = pickLatestIsoString(latestEntryTs, normalized.updatedAt);
        insertKunyeEntryIntoMap(map, normalized, genreMap);
      }
    }
  } else if (rawEntries && typeof rawEntries === 'object') {
    for (const [key, val] of Object.entries(rawEntries as Record<string, unknown>)) {
      const normalized = normalizeCinemaKunyeEntry(val, key, genreMap);
      if (normalized) {
        latestEntryTs = pickLatestIsoString(latestEntryTs, normalized.updatedAt);
        insertKunyeEntryIntoMap(map, normalized, genreMap);
      }
    }
  }

  const sortedEntries: Record<string, CinemaKunyeEntry> = {};
  for (const key of Array.from(map.keys()).sort()) {
    sortedEntries[key] = map.get(key)!;
  }

  return {
    schemaVersion: CINEMA_KUNYE_SCHEMA_VERSION,
    updatedAt: latestEntryTs,
    entries: sortedEntries,
  };
}

export function mergeCinemaKunyeDocumentsLossless(
  localDoc: CinemaKunyeDocument | null | undefined,
  incomingDoc: CinemaKunyeDocument | null | undefined,
  genreMap: Record<number, string> = {}
): CinemaKunyeDocument {
  const normLocal = normalizeCinemaKunyeDocument(localDoc, genreMap);
  const normIncoming = normalizeCinemaKunyeDocument(incomingDoc, genreMap);
  const map = new Map<string, CinemaKunyeEntry>();

  for (const entry of Object.values(normLocal.entries)) {
    insertKunyeEntryIntoMap(map, entry, genreMap);
  }
  for (const entry of Object.values(normIncoming.entries)) {
    insertKunyeEntryIntoMap(map, entry, genreMap);
  }

  let latestTs = pickLatestIsoString(normLocal.updatedAt, normIncoming.updatedAt);
  const sortedEntries: Record<string, CinemaKunyeEntry> = {};
  for (const key of Array.from(map.keys()).sort()) {
    const entry = map.get(key)!;
    latestTs = pickLatestIsoString(latestTs, entry.updatedAt);
    sortedEntries[key] = entry;
  }

  return {
    schemaVersion: CINEMA_KUNYE_SCHEMA_VERSION,
    updatedAt: latestTs,
    entries: sortedEntries,
  };
}

export function extractCinemaKunyeEntryFromSavedItem(
  item: SavedItem,
  genreMap: Record<number, string> = {}
): CinemaKunyeEntry | null {
  const title = (item.title || item.name || '').trim();
  if (!title) return null;
  const year = extractItemReleaseYear(item);
  const numericId =
    typeof item.id === 'number'
      ? item.id
      : /^\d+$/.test(String(item.id))
      ? Number(item.id)
      : undefined;
  const tmdbId =
    numericId && Number.isSafeInteger(numericId) && numericId > 0 && !item.custom
      ? numericId
      : undefined;

  const { genreIds, genres } = resolveGenresFromRaw(item.genre_ids, item.genres, genreMap);
  const actors = normalizeCinemaKunyeActorList(item.cast, 12);
  const updatedAt =
    item.updatedAt || item.completedAt || item.ratedAt || item.addedAt || item.firstAddedAt || '';
  const contentId = buildCinemaKunyeContentId(title, year);

  return {
    contentId,
    title,
    year,
    mediaType: item.media_type === 'tv' ? 'tv' : 'movie',
    ...(tmdbId ? { tmdbId } : {}),
    genreIds,
    genres,
    actors,
    updatedAt,
  };
}

export function extractCinemaKunyeFromItems(
  items: SavedItem[],
  genreMap: Record<number, string> = {},
  options: { includeUnwatchedWithMetadata?: boolean } = {}
): CinemaKunyeDocument {
  const map = new Map<string, CinemaKunyeEntry>();
  let latestTs = '';

  for (const item of Array.isArray(items) ? items : []) {
    const watched = isWatchedForCinemaKunye(item);
    const hasRichMeta =
      Boolean(options.includeUnwatchedWithMetadata) &&
      Array.isArray(item?.cast) &&
      item.cast.length > 0;
    if (!watched && !hasRichMeta) continue;

    const entry = extractCinemaKunyeEntryFromSavedItem(item, genreMap);
    if (!entry) continue;
    latestTs = pickLatestIsoString(latestTs, entry.updatedAt);
    insertKunyeEntryIntoMap(map, entry, genreMap);
  }

  const sortedEntries: Record<string, CinemaKunyeEntry> = {};
  for (const key of Array.from(map.keys()).sort()) {
    sortedEntries[key] = map.get(key)!;
  }

  return {
    schemaVersion: CINEMA_KUNYE_SCHEMA_VERSION,
    updatedAt: latestTs,
    entries: sortedEntries,
  };
}

export function findCinemaKunyeEntryForItem(
  item: Partial<SavedItem>,
  doc: CinemaKunyeDocument | null | undefined
): CinemaKunyeEntry | null {
  if (!doc || !doc.entries) return null;
  const entries = doc.entries;
  const mediaType: 'movie' | 'tv' = item.media_type === 'tv' ? 'tv' : 'movie';
  const title = (item.title || item.name || '').trim();
  const year = extractItemReleaseYear(item);

  if (title) {
    const baseId = buildCinemaKunyeContentId(title, year);
    const typedId = `${baseId}-${mediaType}`;
    if (entries[typedId] && entries[typedId].mediaType === mediaType) {
      return entries[typedId];
    }
    if (entries[baseId] && entries[baseId].mediaType === mediaType) {
      return entries[baseId];
    }
  }

  const numId =
    typeof item.id === 'number'
      ? item.id
      : /^\d+$/.test(String(item.id || ''))
      ? Number(item.id)
      : 0;
  if (numId > 0) {
    for (const entry of Object.values(entries)) {
      if (entry.mediaType === mediaType && entry.tmdbId === numId) {
        return entry;
      }
    }
  }

  if (title) {
    const slug = slugifyCinemaKunyeTitle(title);
    for (const entry of Object.values(entries)) {
      if (entry.mediaType === mediaType && slugifyCinemaKunyeTitle(entry.title) === slug) {
        if (year === null || entry.year === null || entry.year === year) {
          return entry;
        }
      }
    }
  }

  return null;
}

export function enrichSavedItemsFromCinemaKunye(
  items: SavedItem[],
  doc: CinemaKunyeDocument | null | undefined
): SavedItem[] {
  if (!Array.isArray(items) || items.length === 0) return items || [];
  if (!doc || !doc.entries || Object.keys(doc.entries).length === 0) return items;

  let anyChanged = false;
  const enriched = items.map((item) => {
    const entry = findCinemaKunyeEntryForItem(item, doc);
    if (!entry) return item;

    const existingGenreIds = Array.isArray(item.genre_ids) ? item.genre_ids : [];
    const mergedGenreSet = new Set<number>([...existingGenreIds, ...(entry.genreIds || [])]);
    const nextGenreIds = Array.from(mergedGenreSet).sort((a, b) => a - b);
    const genresChanged =
      nextGenreIds.length !== existingGenreIds.length ||
      nextGenreIds.some((gid, idx) => gid !== existingGenreIds[idx]);

    const existingCast = Array.isArray(item.cast) ? item.cast : [];
    const mergedActors =
      entry.actors.length > 0
        ? normalizeCinemaKunyeActorList([...existingCast, ...entry.actors], 12)
        : existingCast;
    const castChanged =
      entry.actors.length > 0 && mergedActors.length > existingCast.length;

    const currentYear = extractItemReleaseYear(item);
    const needsYearFill = currentYear === null && entry.year !== null;
    const datePatch: Partial<SavedItem> = {};
    if (needsYearFill && entry.year) {
      if (item.media_type === 'tv') {
        datePatch.first_air_date = `${entry.year}-01-01`;
      } else {
        datePatch.release_date = `${entry.year}-01-01`;
      }
    }

    if (!genresChanged && !castChanged && !needsYearFill) {
      return item;
    }

    anyChanged = true;
    return {
      ...item,
      genre_ids: nextGenreIds,
      ...(entry.genres.length > 0 && (!item.genres || item.genres.length === 0)
        ? { genres: entry.genres.map((g) => g.name) }
        : {}),
      ...(mergedActors.length > 0 ? { cast: mergedActors } : {}),
      ...datePatch,
    };
  });

  return anyChanged ? enriched : items;
}

export function formatCinemaKunyeGenresCsv(
  entryOrItem: CinemaKunyeEntry | SavedItem,
  genreMap: Record<number, string> = {}
): string {
  const isEntry = 'contentId' in entryOrItem && 'genreIds' in entryOrItem;
  const { genres } = isEntry
    ? resolveGenresFromRaw(
        (entryOrItem as CinemaKunyeEntry).genreIds,
        (entryOrItem as CinemaKunyeEntry).genres,
        genreMap
      )
    : resolveGenresFromRaw(
        (entryOrItem as SavedItem).genre_ids,
        (entryOrItem as SavedItem).genres,
        genreMap
      );
  return genres.map((g) => `${g.id}:${g.name.replace(/[|:]/g, ' ').trim()}`).join('|');
}

export function parseCinemaKunyeGenresCsv(
  cell: string | undefined,
  genreMap: Record<number, string> = {}
): { genreIds: number[]; genres: CinemaKunyeGenre[] } {
  const raw = String(cell || '').trim();
  if (!raw) return { genreIds: [], genres: [] };
  const parts = raw
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
  const parsedObjects: Array<{ id?: number; name?: string } | string> = parts.map((part) => {
    const m = /^(\d+):(.*)$/.exec(part);
    if (m) {
      return { id: Number(m[1]), name: m[2].trim() };
    }
    if (/^\d+$/.test(part)) {
      return { id: Number(part) };
    }
    return part;
  });
  return resolveGenresFromRaw([], parsedObjects, genreMap);
}

export function formatCinemaKunyeActorsCsv(
  actors: CinemaKunyeActor[] | SavedItem['cast'] | undefined
): string {
  const normalized = normalizeCinemaKunyeActorList(actors, 10);
  return normalized
    .map((actor) => {
      const cleanName = actor.name.replace(/[|:]/g, ' ').trim();
      const cleanChar = (actor.character || '').replace(/[|:]/g, ' ').trim();
      const cleanProfile = (actor.profile_path || '').replace(/[|]/g, '').trim();
      if (cleanChar || cleanProfile) {
        return `${actor.id}:${cleanName}:${cleanChar}:${cleanProfile}`;
      }
      return `${actor.id}:${cleanName}`;
    })
    .join('|');
}

export function parseCinemaKunyeActorsCsv(cell: string | undefined): CinemaKunyeActor[] {
  const raw = String(cell || '').trim();
  if (!raw) return [];
  const parts = raw
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
  const rawList = parts.map((part) => {
    const segments = part.split(':');
    if (segments.length >= 2 && /^\d+$/.test(segments[0].trim())) {
      const id = Number(segments[0].trim());
      const name = (segments[1] || '').trim();
      const character = (segments[2] || '').trim();
      const profilePath = segments.slice(3).join(':').trim();
      return {
        id,
        name,
        ...(character ? { character } : {}),
        ...(profilePath ? { profile_path: profilePath } : {}),
      };
    }
    return part;
  });
  return normalizeCinemaKunyeActorList(rawList, 12);
}

export function buildCinemaKunyeCanonicalPayload(doc: CinemaKunyeDocument | null | undefined): {
  schemaVersion: number;
  entries: Array<{
    contentId: string;
    title: string;
    year: number | null;
    mediaType: 'movie' | 'tv';
    tmdbId: number | null;
    genreIds: number[];
    genres: CinemaKunyeGenre[];
    actors: CinemaKunyeActor[];
  }>;
} {
  const normalized = normalizeCinemaKunyeDocument(doc);
  const keys = Object.keys(normalized.entries).sort();
  return {
    schemaVersion: CINEMA_KUNYE_SCHEMA_VERSION,
    entries: keys.map((key) => {
      const e = normalized.entries[key];
      return {
        contentId: e.contentId,
        title: e.title,
        year: e.year,
        mediaType: e.mediaType,
        tmdbId: e.tmdbId ?? null,
        genreIds: [...e.genreIds].sort((a, b) => a - b),
        genres: [...e.genres].sort((a, b) => a.id - b.id),
        actors: e.actors.map((a) => ({
          id: a.id,
          name: a.name,
          ...(a.character ? { character: a.character } : {}),
          ...(a.profile_path ? { profile_path: a.profile_path } : {}),
        })),
      };
    }),
  };
}

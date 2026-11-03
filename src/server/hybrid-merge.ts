// Hibrit yedek birleştirme motoru
// CSV dışa aktarımı (Title,Year,Rating10,WatchedDate,Status,MediaType,tmdbID + kullanıcı verisi
// sütunları) ile mevcut uygulama verisini (GitHub ile senkron durumdaki) birleştirir ve çakışmaları temizler.
import type { DataDocument, Profile, SavedItem } from '../core/cinetrack-core.ts';
import {
  detectDuplicateSavedItems,
  normalizeWorkTitle,
} from '../core/duplicate-detector.ts';
import { parseCsvRows } from '../core/exporters.ts';
import {
  buildCinemaKunyeContentId,
  enrichSavedItemsFromCinemaKunye,
  extractCinemaKunyeFromItems,
  mergeCinemaKunyeDocumentsLossless,
  normalizeCinemaKunyeActorList,
  normalizeCinemaKunyeDocument,
  normalizeCinemaKunyeEntry,
  parseCinemaKunyeActorsCsv,
  parseCinemaKunyeGenresCsv,
  type CinemaKunyeActor,
  type CinemaKunyeDocument,
  type CinemaKunyeEntry,
  type CinemaKunyeGenre,
} from '../core/cinema-kunye.ts';

export interface CsvBackupRow {
  title: string;
  year: number | null;
  rating: number | '';
  watchedDate: string | null;
  status: SavedItem['status'];
  mediaType: 'movie' | 'tv';
  tmdbId: string;
  contentId?: string;
  genreIds?: number[];
  genres?: CinemaKunyeGenre[];
  actors?: CinemaKunyeActor[];
  addedDate?: string | null;
  firstAddedDate?: string | null;
  updatedDate?: string | null;
  completedDate?: string | null;
  ratedDate?: string | null;
  episodesWatched?: number;
  currentSeason?: number;
  nextEpisode?: number;
  totalWatchTimeMinutes?: number;
  custom?: boolean;
}

function csvDateToIso(rawDate: string | null | undefined): string | null {
  if (!rawDate) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?)?$/.exec(
    rawDate.trim()
  );
  if (!m) return null;
  const [, d, t, z] = m;
  return t ? `${d}T${t}.000${z || 'Z'}` : `${d}T12:00:00.000Z`;
}

function csvIntCell(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function csvFloatCell(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseCsvBackupRows(csvText: string): {
  rows: CsvBackupRow[];
  trailerKunyeEntries: CinemaKunyeEntry[];
  failures: string[];
  skippedNoId: number;
} {
  const raw = String(csvText || '').replace(/^\uFEFF/, '');
  const parsedRows = parseCsvRows(raw);
  const rows: CsvBackupRow[] = [];
  const trailerKunyeEntries: CinemaKunyeEntry[] = [];
  const failures: string[] = [];
  let skippedNoId = 0;

  if (parsedRows.length < 2) {
    return { rows, trailerKunyeEntries, failures, skippedNoId };
  }

  const header = parsedRows[0].map((col) => col.toLowerCase().trim());
  const findCol = (...candidates: string[]) => header.findIndex((h) => candidates.includes(h));
  const idxTitle = findCol('title', 'name', 'original title', 'film', 'başlık');
  const idxYear = findCol('year', 'yıl', 'release year');
  const idxRating10 = findCol('rating10', 'your rating', 'personal_rating', 'puan');
  const idxRating5 = findCol('rating');
  const idxDate = findCol('watcheddate', 'watched date', 'date rated', 'date', 'created');
  const idxStatus = findCol('status', 'durum');
  const idxType = findCol('mediatype', 'media_type', 'title type', 'type', 'tür');
  const idxTmdb = findCol('tmdbid', 'tmdb_id', 'tmdb');
  const idxAdded = findCol('addeddate');
  const idxFirstAdded = findCol('firstaddeddate');
  const idxUpdated = findCol('updateddate');
  const idxCompleted = findCol('completeddate');
  const idxRated = findCol('rateddate');
  const idxEpisodes = findCol('episodeswatched');
  const idxSeason = findCol('currentseason');
  const idxNextEpisode = findCol('nextepisode');
  const idxWatchMinutes = findCol('totalwatchtimeminutes');
  const idxCustom = findCol('custom');
  const idxContentId = findCol('contentid', 'content_id', 'icerik_id');
  const idxGenres = findCol('genres', 'türler', 'turler');
  const idxActors = findCol('actors', 'cast', 'oyuncular');

  for (const line of parsedRows.slice(1)) {
    if (line.length >= 2 && String(line[0] || '').trim() === '#SinemaKunyesi') {
      try {
        const entry = normalizeCinemaKunyeEntry(JSON.parse(line[1]));
        if (entry) trailerKunyeEntries.push(entry);
      } catch {
        // Bozuk #SinemaKunyesi satırı atlanır
      }
    }
  }

  if (idxTitle === -1) {
    for (const line of parsedRows.slice(1)) {
      if (line.length > 0 && !String(line[0] || '').startsWith('#')) {
        failures.push(line.join(',').slice(0, 80));
      }
    }
    return { rows, trailerKunyeEntries, failures, skippedNoId };
  }

  const cell = (row: string[], idx: number): string => (idx >= 0 ? (row[idx] || '').trim() : '');

  for (const line of parsedRows.slice(1)) {
    if (line.length === 0) continue;
    if (String(line[0] || '').startsWith('#')) continue;

    const rawTitle = cell(line, idxTitle);
    const rawTmdb = cell(line, idxTmdb);
    if (!rawTitle) {
      skippedNoId++;
      continue;
    }

    const rawType = cell(line, idxType).toLowerCase();
    const mediaType: 'movie' | 'tv' =
      rawType.includes('tv') || rawType.includes('series') || rawType.includes('mini') || rawType === 'dizi'
        ? 'tv'
        : 'movie';

    const yearStr = cell(line, idxYear).slice(0, 4);
    const yearNum = Number(yearStr);
    const year = /^\d{4}$/.test(yearStr) && yearNum >= 1880 && yearNum <= 2040 ? yearNum : null;
    const explicitContentId = cell(line, idxContentId);
    const computedContentId = explicitContentId || buildCinemaKunyeContentId(rawTitle, year);
    const isCustomRow = cell(line, idxCustom) === '1';

    let tmdbId = rawTmdb;
    if (!/^\d+$/.test(tmdbId)) {
      if (isCustomRow || explicitContentId) {
        const slugPart = computedContentId.replace(/-(?:\d{4}|belirsiz)$/, '').slice(0, 48) || 'item';
        tmdbId = `custom-csv-${mediaType}-${slugPart}${year ? `-${year}` : ''}`;
      } else {
        failures.push(line.join(',').slice(0, 80));
        continue;
      }
    }

    const rawStatus = cell(line, idxStatus).toLowerCase();
    let status: SavedItem['status'] = 'completed';
    if (rawStatus === 'watchlist' || rawStatus === 'izlenecek') {
      status = 'watchlist';
    } else if (rawStatus === 'watching' || rawStatus === 'izleniyor') {
      status = 'watching';
    }

    let rating: number | '' = '';
    const rating10Cell = cell(line, idxRating10);
    if (rating10Cell !== '') {
      const ratingNum = Number(rating10Cell);
      rating =
        Number.isInteger(ratingNum) && ratingNum >= 1 && ratingNum <= 10 ? ratingNum : '';
    } else if (idxRating5 >= 0 && cell(line, idxRating5) !== '') {
      const rating5 = Number(cell(line, idxRating5));
      const scaled = rating5 <= 5 ? Math.round(rating5 * 2) : Math.round(rating5);
      rating = Number.isInteger(scaled) && scaled >= 1 && scaled <= 10 ? scaled : '';
    }

    const watchedDate = cell(line, idxDate);
    const addedDate = cell(line, idxAdded) || null;
    const firstAddedDate = cell(line, idxFirstAdded) || null;
    const updatedDate = cell(line, idxUpdated) || null;
    const completedDate = cell(line, idxCompleted) || null;
    const ratedDate = cell(line, idxRated) || null;
    const customFlag = isCustomRow || !/^\d+$/.test(tmdbId) ? true : undefined;
    const episodesWatched = csvIntCell(cell(line, idxEpisodes));
    const currentSeason = csvIntCell(cell(line, idxSeason));
    const nextEpisode = csvIntCell(cell(line, idxNextEpisode));
    const totalWatchTimeMinutes = csvFloatCell(cell(line, idxWatchMinutes));
    const parsedGenres = idxGenres >= 0 ? parseCinemaKunyeGenresCsv(cell(line, idxGenres)) : { genreIds: [], genres: [] };
    const parsedActors = idxActors >= 0 ? parseCinemaKunyeActorsCsv(cell(line, idxActors)) : [];

    rows.push({
      title: rawTitle,
      year,
      rating,
      watchedDate: /^\d{4}-\d{2}-\d{2}/.test(watchedDate) ? watchedDate : null,
      status,
      mediaType,
      tmdbId,
      contentId: computedContentId,
      ...(parsedGenres.genreIds.length > 0 ? { genreIds: parsedGenres.genreIds, genres: parsedGenres.genres } : {}),
      ...(parsedActors.length > 0 ? { actors: parsedActors } : {}),
      ...(addedDate ? { addedDate } : {}),
      ...(firstAddedDate ? { firstAddedDate } : {}),
      ...(updatedDate ? { updatedDate } : {}),
      ...(completedDate ? { completedDate } : {}),
      ...(ratedDate ? { ratedDate } : {}),
      ...(episodesWatched !== undefined ? { episodesWatched } : {}),
      ...(currentSeason !== undefined ? { currentSeason } : {}),
      ...(nextEpisode !== undefined ? { nextEpisode } : {}),
      ...(totalWatchTimeMinutes !== undefined ? { totalWatchTimeMinutes } : {}),
      ...(customFlag !== undefined ? { custom: customFlag } : {}),
    });
  }

  return { rows, trailerKunyeEntries, failures, skippedNoId };
}

export interface HybridMergeReport {
  csvRowsParsed: number;
  csvRowsFailed: number;
  csvRowsSkippedNoId: number;
  csvDuplicateRowsRemoved: number;
  mergedByIdCount: number;
  matchedByTitleYearCount: number;
  newItemsCreated: number;
  yearEnrichedCount: number;
  conflictResolutionCount: number;
  conflictSamples: string[];
  suspiciousDuplicatePairs: { a: string; b: string; reason: string }[];
  finalItemCount: number;
}

const STATUS_PRIORITY: Record<SavedItem['status'], number> = {
  completed: 3,
  watching: 2,
  watchlist: 1,
};

function itemReleaseYear(item: SavedItem): number | null {
  const dateStr = item.release_date || item.first_air_date || '';
  const yr = Number(dateStr.slice(0, 4));
  return Number.isFinite(yr) && yr >= 1880 && yr <= 2040 ? yr : null;
}

function csvRowDateIso(row: CsvBackupRow): string | null {
  return csvDateToIso(row.watchedDate);
}

function buildItemFromRow(row: CsvBackupRow): SavedItem {
  const watchedIso = csvRowDateIso(row);
  const addedIso = csvDateToIso(row.addedDate) || watchedIso;
  const firstAddedIso = csvDateToIso(row.firstAddedDate) || addedIso;
  const updatedIso = csvDateToIso(row.updatedDate) || addedIso || new Date().toISOString();
  const completedIso =
    csvDateToIso(row.completedDate) || (watchedIso && row.status === 'completed' ? watchedIso : null);
  const ratedIso =
    csvDateToIso(row.ratedDate) || (watchedIso && row.rating !== '' ? watchedIso : null);
  return {
    id: /^\d+$/.test(row.tmdbId) ? Number(row.tmdbId) : row.tmdbId,
    media_type: row.mediaType,
    title: row.title,
    status: row.status,
    personal_rating: row.rating,
    vote_average: 0,
    vote_count: 0,
    popularity: 0,
    genre_ids: row.genreIds || [],
    ...(row.genres && row.genres.length > 0 ? { genres: row.genres.map((g) => g.name) } : {}),
    ...(row.actors && row.actors.length > 0 ? { cast: row.actors } : {}),
    ...(row.year !== null
      ? row.mediaType === 'movie'
        ? { release_date: `${row.year}-01-01` }
        : { first_air_date: `${row.year}-01-01` }
      : {}),
    ...(addedIso ? { addedAt: addedIso } : {}),
    ...(firstAddedIso ? { firstAddedAt: firstAddedIso } : {}),
    ...(updatedIso ? { updatedAt: updatedIso } : {}),
    ...(completedIso ? { completedAt: completedIso } : {}),
    ...(ratedIso ? { ratedAt: ratedIso } : {}),
    ...(row.episodesWatched !== undefined ? { episodes_watched: row.episodesWatched } : {}),
    ...(row.currentSeason !== undefined ? { current_season: row.currentSeason } : {}),
    ...(row.nextEpisode !== undefined ? { next_episode: row.nextEpisode } : {}),
    ...(row.totalWatchTimeMinutes !== undefined
      ? { totalWatchTimeMinutes: row.totalWatchTimeMinutes }
      : {}),
    ...(row.custom !== undefined ? { custom: row.custom } : {}),
  } as SavedItem;
}

/**
 * Bir CSV satırını mevcut öğeyle birleştirir (çakışma kuralları deterministik):
 * - Durum: completed > watching > watchlist
 * - Puan: boş olan dolar; ikisi de doluysa daha YENİ tarihli kaynak kazanır
 * - Yıl: mevcut öğede yoksa CSV yılı eklenir
 * - Başlık/üstveri: mevcut (zengin) kayıt korunur
 */
function mergeRowIntoItem(
  item: SavedItem,
  row: CsvBackupRow,
  conflicts: string[]
): SavedItem {
  let changed = false;
  const next = { ...item };

  const rowStatusPriority = STATUS_PRIORITY[row.status];
  const itemStatusPriority = STATUS_PRIORITY[item.status];
  if (rowStatusPriority > itemStatusPriority) {
    conflicts.push(`${row.title}: durum ${item.status} → ${row.status} (CSV)`);
    next.status = row.status;
    changed = true;
  }

  const rowRating = row.rating;
  const itemRating = item.personal_rating;
  if (typeof rowRating === 'number' && rowRating > 0) {
    if (typeof itemRating !== 'number' || itemRating <= 0) {
      conflicts.push(`${row.title}: puan boş → ${rowRating} (CSV)`);
      next.personal_rating = rowRating;
      changed = true;
    } else if (itemRating !== rowRating) {
      const csvTime = csvRowDateIso(row) || '';
      const itemTime = String(item.ratedAt || item.updatedAt || item.completedAt || '');
      if (csvTime > itemTime) {
        conflicts.push(`${row.title}: puan ${itemRating} → ${rowRating} (CSV daha yeni)`);
        next.personal_rating = rowRating;
        changed = true;
      } else {
        conflicts.push(`${row.title}: puan ${rowRating} yok sayıldı (mevcut ${itemRating} daha yeni)`);
      }
    }
  }

  if (!next.title && row.title) {
    next.title = row.title;
    changed = true;
  }

  const existingYear = itemReleaseYear(item);
  if (existingYear === null && row.year !== null) {
    if (row.mediaType === 'movie') {
      next.release_date = `${row.year}-01-01`;
    } else {
      next.first_air_date = `${row.year}-01-01`;
    }
    changed = true;
  }

  const rowDate = csvRowDateIso(row);
  const rowAddedDate = csvDateToIso(row.addedDate) || rowDate;
  if (rowAddedDate) {
    if (!next.addedAt || rowAddedDate < next.addedAt) {
      next.addedAt = rowAddedDate;
      changed = true;
    }
  }
  const rowFirstAdded = csvDateToIso(row.firstAddedDate) || rowAddedDate;
  if (rowFirstAdded && (!next.firstAddedAt || rowFirstAdded < next.firstAddedAt)) {
    next.firstAddedAt = rowFirstAdded;
    changed = true;
  }
  const rowCompletedDate =
    csvDateToIso(row.completedDate) || (row.status === 'completed' ? rowDate : null);
  if (rowCompletedDate && !next.completedAt) {
    next.completedAt = rowCompletedDate;
    changed = true;
  }
  const rowRatedDate = csvDateToIso(row.ratedDate) || (row.rating !== '' ? rowDate : null);
  if (rowRatedDate && !next.ratedAt) {
    next.ratedAt = rowRatedDate;
    changed = true;
  }

  // İlerleme alanları: CSV'deki değer mevcuttan büyükse kazanır (geriye sarma olmaz)
  if (row.episodesWatched !== undefined && (next.episodes_watched ?? 0) < row.episodesWatched) {
    next.episodes_watched = row.episodesWatched;
    changed = true;
  }
  if (row.currentSeason !== undefined && (next.current_season ?? 0) < row.currentSeason) {
    next.current_season = row.currentSeason;
    changed = true;
  }
  if (row.nextEpisode !== undefined && (next.next_episode ?? 0) < row.nextEpisode) {
    next.next_episode = row.nextEpisode;
    changed = true;
  }
  if (row.totalWatchTimeMinutes !== undefined && !next.totalWatchTimeMinutes) {
    next.totalWatchTimeMinutes = row.totalWatchTimeMinutes;
    changed = true;
  }
  if (row.genreIds && row.genreIds.length > 0) {
    const mergedGenres = Array.from(new Set<number>([...(next.genre_ids || []), ...row.genreIds])).sort(
      (a, b) => a - b
    );
    if (mergedGenres.length > (next.genre_ids || []).length) {
      next.genre_ids = mergedGenres;
      changed = true;
    }
  }
  if (row.actors && row.actors.length > 0) {
    const mergedCast = normalizeCinemaKunyeActorList([...(next.cast || []), ...row.actors], 12);
    if (mergedCast.length > (next.cast || []).length) {
      next.cast = mergedCast;
      changed = true;
    }
  }
  if (row.custom !== undefined && next.custom === undefined) {
    next.custom = row.custom;
    changed = true;
  }

  if (changed) {
    next.updatedAt = new Date().toISOString();
  }
  return next;
}

function csvRowScore(row: CsvBackupRow): number {
  let score = STATUS_PRIORITY[row.status];
  if (typeof row.rating === 'number' && row.rating > 0) score += 10;
  if (row.watchedDate) score += 1;
  if (row.actors && row.actors.length > 0) score += 2;
  if (row.genreIds && row.genreIds.length > 0) score += 1;
  return score;
}

export function runHybridMerge(
  csvText: string,
  document: DataDocument
): { document: DataDocument; cinemaKunye: CinemaKunyeDocument; report: HybridMergeReport } {
  const { rows, trailerKunyeEntries, failures, skippedNoId } = parseCsvBackupRows(csvText);

  // 1. CSV içi yinelenen satırlar → en dolu kayıt kalır, tür/oyuncu bilgileri kayıpsız birleşir
  const bestRowByKey = new Map<string, CsvBackupRow>();
  for (const row of rows) {
    const key = `${row.mediaType}:${row.tmdbId}`;
    const existing = bestRowByKey.get(key);
    if (!existing) {
      bestRowByKey.set(key, row);
    } else {
      const winner = csvRowScore(row) > csvRowScore(existing) ? row : existing;
      const other = winner === row ? existing : row;
      const unionGenreIds = Array.from(
        new Set<number>([...(winner.genreIds || []), ...(other.genreIds || [])])
      );
      const unionActors = normalizeCinemaKunyeActorList(
        [...(winner.actors || []), ...(other.actors || [])],
        12
      );
      bestRowByKey.set(key, {
        ...other,
        ...winner,
        year: winner.year ?? other.year,
        ...(unionGenreIds.length > 0 ? { genreIds: unionGenreIds } : {}),
        ...(unionActors.length > 0 ? { actors: unionActors } : {}),
      });
    }
  }
  const csvDuplicateRowsRemoved = rows.length - bestRowByKey.size;

  // 2. Hedef profil ve mevcut öğe indeksleri
  const profileIndex = document.profiles.findIndex(
    (p) => p.id === document.activeProfileId
  );
  const targetProfile: Profile =
    profileIndex >= 0
      ? document.profiles[profileIndex]
      : document.profiles[0] || {
          id: 'profile-default',
          name: 'default',
          createdAt: new Date().toISOString(),
          preferences: { disliked: [], hidden: [], providers: [], mood: '', reminders: true, notified: [] },
          items: [],
        };
  const mergedItems: SavedItem[] = targetProfile.items.map((it) => ({ ...it }));

  const itemIndexByKey = new Map<string, number>();
  const indexesByNormTitle = new Map<string, number[]>();
  mergedItems.forEach((item, idx) => {
    itemIndexByKey.set(`${item.media_type}:${String(item.id)}`, idx);
    const norm = normalizeWorkTitle(item.title || item.name || '');
    if (norm) {
      const list = indexesByNormTitle.get(norm) || [];
      list.push(idx);
      indexesByNormTitle.set(norm, list);
    }
  });

  const conflicts: string[] = [];
  let mergedByIdCount = 0;
  let matchedByTitleYearCount = 0;
  let newItemsCreated = 0;
  let yearEnrichedCount = 0;

  for (const row of bestRowByKey.values()) {
    const key = `${row.mediaType}:${row.tmdbId}`;
    const idxById = itemIndexByKey.get(key);
    if (idxById !== undefined) {
      const before = mergedItems[idxById];
      const merged = mergeRowIntoItem(before, row, conflicts);
      mergedItems[idxById] = merged;
      mergedByIdCount++;
      if (itemReleaseYear(before) === null && itemReleaseYear(merged) !== null) {
        yearEnrichedCount++;
      }
      continue;
    }

    // Aynı kimlik yoksa: normalize başlık + yıl ile eşleşme dene
    const norm = normalizeWorkTitle(row.title);
    const candidateIndexes = (indexesByNormTitle.get(norm) || []).filter(
      (i) => mergedItems[i].media_type === row.mediaType
    );
    let matchedIdx: number | null = null;
    if (candidateIndexes.length === 1) {
      matchedIdx = candidateIndexes[0];
    } else if (candidateIndexes.length > 1 && row.year !== null) {
      const yearMatches = candidateIndexes.filter((i) => {
        const y = itemReleaseYear(mergedItems[i]);
        return y === null || y === row.year;
      });
      if (yearMatches.length === 1) matchedIdx = yearMatches[0];
    }

    if (matchedIdx !== null) {
      const before = mergedItems[matchedIdx];
      const merged = mergeRowIntoItem(before, row, conflicts);
      mergedItems[matchedIdx] = merged;
      matchedByTitleYearCount++;
      if (itemReleaseYear(before) === null && itemReleaseYear(merged) !== null) {
        yearEnrichedCount++;
      }
      continue;
    }

    const added = buildItemFromRow(row);
    mergedItems.push(added);
    itemIndexByKey.set(key, mergedItems.length - 1);
    if (norm) {
      const list = indexesByNormTitle.get(norm) || [];
      list.push(mergedItems.length - 1);
      indexesByNormTitle.set(norm, list);
    }
    newItemsCreated++;
  }

  const rowKunyeEntries: CinemaKunyeEntry[] = [];
  for (const row of bestRowByKey.values()) {
    const isWatched =
      row.status === 'completed' ||
      row.status === 'watching' ||
      (typeof row.rating === 'number' && row.rating >= 1) ||
      (row.episodesWatched !== undefined && row.episodesWatched > 0);
    if (isWatched || (row.genreIds && row.genreIds.length > 0) || (row.actors && row.actors.length > 0)) {
      const numericTmdb = /^\d+$/.test(row.tmdbId) ? Number(row.tmdbId) : undefined;
      const entry = normalizeCinemaKunyeEntry({
        contentId: row.contentId || buildCinemaKunyeContentId(row.title, row.year),
        title: row.title,
        year: row.year,
        mediaType: row.mediaType,
        ...(numericTmdb ? { tmdbId: numericTmdb } : {}),
        genreIds: row.genreIds || [],
        genres: row.genres || [],
        actors: row.actors || [],
        updatedAt: csvDateToIso(row.updatedDate) || csvRowDateIso(row) || '',
      });
      if (entry) rowKunyeEntries.push(entry);
    }
  }

  const csvCinemaKunye = mergeCinemaKunyeDocumentsLossless(
    normalizeCinemaKunyeDocument({ entries: rowKunyeEntries }),
    normalizeCinemaKunyeDocument({ entries: trailerKunyeEntries })
  );
  const finalCinemaKunye = mergeCinemaKunyeDocumentsLossless(
    extractCinemaKunyeFromItems(mergedItems),
    csvCinemaKunye
  );
  const enrichedMergedItems = enrichSavedItemsFromCinemaKunye(mergedItems, finalCinemaKunye);

  // 3. Birleşme sonrası hâlâ şüpheli görünen çiftler (onay UI panelinde çözülür)
  const suspicious = detectDuplicateSavedItems(enrichedMergedItems).slice(0, 40).map((pair) => ({
    a: `${pair.primaryItem.title || pair.primaryItem.name} (${itemReleaseYear(pair.primaryItem) || '—'})`,
    b: `${pair.secondaryItem.title || pair.secondaryItem.name} (${itemReleaseYear(pair.secondaryItem) || '—'})`,
    reason: pair.reason,
  }));

  const profiles: Profile[] = document.profiles.map((p, i) =>
    i === profileIndex ? { ...p, items: enrichedMergedItems } : p
  );
  if (profileIndex < 0) {
    profiles.push({ ...targetProfile, items: enrichedMergedItems });
  }

  const nextDocument: DataDocument = {
    ...document,
    updatedAt: new Date().toISOString(),
    profiles,
  };

  return {
    document: nextDocument,
    cinemaKunye: finalCinemaKunye,
    report: {
      csvRowsParsed: rows.length,
      csvRowsFailed: failures.length,
      csvRowsSkippedNoId: skippedNoId,
      csvDuplicateRowsRemoved,
      mergedByIdCount,
      matchedByTitleYearCount,
      newItemsCreated,
      yearEnrichedCount,
      conflictResolutionCount: conflicts.length,
      conflictSamples: conflicts.slice(0, 10),
      suspiciousDuplicatePairs: suspicious,
      finalItemCount: enrichedMergedItems.length,
    },
  };
}

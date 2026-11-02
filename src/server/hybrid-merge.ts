// Hibrit yedek birleştirme motoru
// CSV dışa aktarımı (Title,Year,Rating10,WatchedDate,Status,MediaType,tmdbID) ile mevcut
// uygulama verisini (GitHub ile senkron durumdaki) birleştirir ve çakışmaları temizler.
import type { DataDocument, Profile, SavedItem } from '../core/cinetrack-core.ts';
import {
  detectDuplicateSavedItems,
  normalizeWorkTitle,
} from '../core/duplicate-detector.ts';

export interface CsvBackupRow {
  title: string;
  year: number | null;
  rating: number | '';
  watchedDate: string | null;
  status: SavedItem['status'];
  mediaType: 'movie' | 'tv';
  tmdbId: string;
}

// Başlıklar virgül içerebildiği için satırın SON 6 alanı sabittir; başlık greedy yakalanır.
const ROW_RE = /^(.*),(\d{4})?,([^,]*),([^,]*),(watching|watchlist|completed),(movie|tv),(\d+)$/;

export function parseCsvBackupRows(csvText: string): {
  rows: CsvBackupRow[];
  failures: string[];
  skippedNoId: number;
} {
  const raw = String(csvText || '').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  const rows: CsvBackupRow[] = [];
  const failures: string[] = [];
  let skippedNoId = 0;

  for (const line of lines.slice(1)) {
    const m = ROW_RE.exec(line.trim());
    if (!m) {
      failures.push(line.slice(0, 80));
      continue;
    }
    let [, rawTitle, yearStr, ratingStr, watchedDate, status, mediaType, tmdbId] = m;
    const safeStatus = status as SavedItem['status'];
    const safeMediaType = mediaType as 'movie' | 'tv';
    let title = rawTitle.trim();
    if (title.length >= 2 && title.startsWith('"') && title.endsWith('"')) {
      title = title.slice(1, -1).replace(/""/g, '"').trim();
    }
    if (!title || !tmdbId) {
      skippedNoId++;
      continue;
    }
    const year = yearStr ? Number(yearStr) : null;
    const ratingNum = Number(ratingStr);
    const personal_rating =
      ratingStr !== '' && Number.isInteger(ratingNum) && ratingNum >= 1 && ratingNum <= 10
        ? ratingNum
        : '';
    rows.push({
      title,
      year: year && Number.isFinite(year) && year >= 1880 && year <= 2040 ? year : null,
      rating: personal_rating as number | '',
      watchedDate: /^\d{4}-\d{2}-\d{2}$/.test(watchedDate) ? watchedDate : null,
      status: safeStatus,
      mediaType: safeMediaType,
      tmdbId,
    });
  }
  return { rows, failures, skippedNoId };
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
  return row.watchedDate ? `${row.watchedDate}T00:00:00.000Z` : null;
}

function buildItemFromRow(row: CsvBackupRow): SavedItem {
  const dateIso = csvRowDateIso(row);
  return {
    id: row.tmdbId,
    media_type: row.mediaType,
    title: row.title,
    status: row.status,
    personal_rating: row.rating,
    vote_average: 0,
    vote_count: 0,
    popularity: 0,
    genre_ids: [],
    ...(row.year !== null
      ? row.mediaType === 'movie'
        ? { release_date: `${row.year}-01-01` }
        : { first_air_date: `${row.year}-01-01` }
      : {}),
    ...(dateIso ? { addedAt: dateIso, firstAddedAt: dateIso, updatedAt: dateIso } : {}),
    ...(dateIso && row.status === 'completed' ? { completedAt: dateIso } : {}),
    ...(dateIso && row.rating !== '' ? { ratedAt: dateIso } : {}),
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
  if (rowDate) {
    if (!next.addedAt || rowDate < next.addedAt) {
      next.addedAt = rowDate;
      next.firstAddedAt = rowDate;
      changed = true;
    }
    if (row.status === 'completed' && !next.completedAt) {
      next.completedAt = rowDate;
      changed = true;
    }
    if (typeof row.rating === 'number' && row.rating > 0 && !next.ratedAt) {
      next.ratedAt = rowDate;
      changed = true;
    }
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
  return score;
}

export function runHybridMerge(
  csvText: string,
  document: DataDocument
): { document: DataDocument; report: HybridMergeReport } {
  const { rows, failures, skippedNoId } = parseCsvBackupRows(csvText);

  // 1. CSV içi yinelenen satırlar (aynı tmdbID + medya türü) → en dolu kayıt kalır
  const bestRowByKey = new Map<string, CsvBackupRow>();
  for (const row of rows) {
    const key = `${row.mediaType}:${row.tmdbId}`;
    const existing = bestRowByKey.get(key);
    if (!existing || csvRowScore(row) > csvRowScore(existing)) {
      bestRowByKey.set(key, row);
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

  // 3. Birleşme sonrası hâlâ şüpheli görünen çiftler (onay UI panelinde çözülür)
  const suspicious = detectDuplicateSavedItems(mergedItems).slice(0, 40).map((pair) => ({
    a: `${pair.primaryItem.title || pair.primaryItem.name} (${itemReleaseYear(pair.primaryItem) || '—'})`,
    b: `${pair.secondaryItem.title || pair.secondaryItem.name} (${itemReleaseYear(pair.secondaryItem) || '—'})`,
    reason: pair.reason,
  }));

  const profiles: Profile[] = document.profiles.map((p, i) =>
    i === profileIndex ? { ...p, items: mergedItems } : p
  );
  if (profileIndex < 0) {
    profiles.push({ ...targetProfile, items: mergedItems });
  }

  const nextDocument: DataDocument = {
    ...document,
    updatedAt: new Date().toISOString(),
    profiles,
  };

  return {
    document: nextDocument,
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
      finalItemCount: mergedItems.length,
    },
  };
}

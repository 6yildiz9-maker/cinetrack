import type { TmdbGenre, TmdbItem } from '../types/tmdb.ts';
import { loadStockIdb, saveStockIdb, type StockDepot } from './storage-idb.ts';
import { hasPosterData } from './poster-hydration-service.ts';

export type StockSourceFilter = 'all' | 'tvdb' | 'tmdb';
export type StockExportFormat = 'json' | 'csv';
export type StockImportStrategy = 'overwrite' | 'skip' | 'restore';

export interface StockExportOptions {
  source?: StockSourceFilter;
  format?: StockExportFormat;
}

export interface StockExportResult {
  blob: Blob;
  fileName: string;
  count: number;
  moviesCount: number;
  tvCount: number;
  format: StockExportFormat;
}

export interface StockImportValidationRow {
  line: number;
  title: string;
  mediaType: string;
  source: string;
  isDuplicate: boolean;
  isValid: boolean;
  errorMessage?: string;
  item?: TmdbItem;
}

export interface StockImportPreview {
  totalRead: number;
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  newCount: number;
  errors: Array<{ line: number; message: string }>;
  validItems: TmdbItem[];
  duplicates: TmdbItem[];
}

export interface StockImportResult {
  ok: boolean;
  imported: number;
  updated: number;
  skipped: number;
  totalMovies: number;
  totalTv: number;
  message: string;
}

/**
 * Exports current stock items as JSON or CSV
 */
export async function exportStockData(options: StockExportOptions = {}): Promise<StockExportResult> {
  const source = options.source || 'all';
  const format = options.format || 'json';

  const depot = await loadStockIdb();
  let movies = Array.isArray(depot.movies) ? depot.movies : [];
  let tv = Array.isArray(depot.tv) ? depot.tv : [];

  if (source === 'tvdb') {
    movies = movies.filter((m) => m.source === 'tvdb');
    tv = tv.filter((t) => t.source === 'tvdb');
  } else if (source === 'tmdb') {
    movies = movies.filter((m) => m.source !== 'tvdb');
    tv = tv.filter((t) => t.source !== 'tvdb');
  }

  const allItems = [
    ...movies.map((m) => ({ ...m, media_type: 'movie' as const })),
    ...tv.map((t) => ({ ...t, media_type: 'tv' as const })),
  ];

  const dateStr = new Date().toISOString().split('T')[0];
  const fileName = `cinetrack-stock-${source}-${dateStr}.${format}`;

  if (format === 'csv') {
    const csvContent = convertItemsToCsv(allItems);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    return {
      blob,
      fileName,
      count: allItems.length,
      moviesCount: movies.length,
      tvCount: tv.length,
      format,
    };
  }

  // JSON format
  const exportPayload = {
    exportedAt: new Date().toISOString(),
    sourceFilter: source,
    version: '1.0',
    meta: {
      total: allItems.length,
      moviesCount: movies.length,
      tvCount: tv.length,
      formatJustification:
        'JSON formatı iç içe nesneleri (bölümler, oyuncular, çok dilli özetler, TVDB/TMDB anahtarları) kayıpsız korur.',
    },
    movies,
    tv,
  };

  const jsonString = JSON.stringify(exportPayload, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8;' });

  return {
    blob,
    fileName,
    count: allItems.length,
    moviesCount: movies.length,
    tvCount: tv.length,
    format,
  };
}

function escapeCsvField(val: unknown): string {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

function convertItemsToCsv(items: TmdbItem[]): string {
  const headers = [
    'id',
    'media_type',
    'source',
    'title',
    'original_title',
    'year',
    'vote_average',
    'vote_count',
    'genres',
    'overview',
    'poster_url',
    'poster_path',
    'backdrop_path',
    'tvdb_id',
    'status',
  ];

  const lines = [
    '#CINETRACK-STOCK',
    `#ExportDate,${new Date().toISOString()}`,
    `#TotalItems,${items.length}`,
    headers.join(','),
  ];

  for (const item of items) {
    const genresStr = Array.isArray(item.genres)
      ? item.genres.map((g: any) => (typeof g === 'string' ? g : g.name)).join('|')
      : '';
    const year = (item.release_date || item.first_air_date || '').slice(0, 4);
    const title = item.title || item.name || '';
    const origTitle = item.original_title || item.original_name || title;

    const row = [
      escapeCsvField(item.id),
      escapeCsvField(item.media_type || (item.title ? 'movie' : 'tv')),
      escapeCsvField(item.source || 'tmdb'),
      escapeCsvField(title),
      escapeCsvField(origTitle),
      escapeCsvField(year),
      escapeCsvField(item.vote_average ?? ''),
      escapeCsvField(item.vote_count ?? ''),
      escapeCsvField(genresStr),
      escapeCsvField(item.overview || ''),
      escapeCsvField(item.poster_url || item.poster_path || ''),
      escapeCsvField(item.poster_path || ''),
      escapeCsvField(item.backdrop_path || ''),
      escapeCsvField(item.tvdb_id ?? ''),
      escapeCsvField(item.status || ''),
    ];

    lines.push(row.join(','));
  }

  return lines.join('\n');
}

/**
 * Validates and parses raw JSON or CSV text for Stock Import
 */
export async function validateAndParseStockImport(
  rawContent: string,
  fileNameHint = ''
): Promise<StockImportPreview> {
  const trimmed = rawContent.trimStart();
  const isCsv =
    fileNameHint.endsWith('.csv') ||
    (!trimmed.startsWith('{') && !trimmed.startsWith('[') && (trimmed.startsWith('id,') || trimmed.includes(',')));
  const depot = await loadStockIdb();
  const existingMovies = Array.isArray(depot.movies) ? depot.movies : [];
  const existingTv = Array.isArray(depot.tv) ? depot.tv : [];

  const existingKeys = new Set<string>();
  for (const m of existingMovies) {
    if (m && m.id != null) {
      existingKeys.add(`movie:${String(m.id).toLowerCase()}`);
      if (m.title) existingKeys.add(`title:${m.title.toLowerCase().trim()}`);
    }
  }
  for (const t of existingTv) {
    if (t && t.id != null) {
      existingKeys.add(`tv:${String(t.id).toLowerCase()}`);
      if (t.name) existingKeys.add(`title:${t.name.toLowerCase().trim()}`);
    }
  }

  if (isCsv) {
    return parseCsvImport(rawContent, existingKeys);
  }

  return parseJsonImport(rawContent, existingKeys);
}

function parseJsonImport(content: string, existingKeys: Set<string>): StockImportPreview {
  const errors: Array<{ line: number; message: string }> = [];
  let parsed: any;

  try {
    parsed = JSON.parse(content);
  } catch (err: any) {
    return {
      totalRead: 0,
      validCount: 0,
      invalidCount: 1,
      duplicateCount: 0,
      newCount: 0,
      errors: [{ line: 1, message: `Geçersiz JSON dosyası: ${err?.message || 'Sözdizimi hatası'}` }],
      validItems: [],
      duplicates: [],
    };
  }

  let rawList: any[] = [];
  if (Array.isArray(parsed)) {
    rawList = parsed;
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.items)) {
      rawList = parsed.items;
    } else {
      const movies = Array.isArray(parsed.movies) ? parsed.movies : [];
      const tv = Array.isArray(parsed.tv) ? parsed.tv : [];
      rawList = [
        ...movies.map((m: any) => ({ ...m, media_type: m.media_type || 'movie' })),
        ...tv.map((t: any) => ({ ...t, media_type: t.media_type || 'tv' })),
      ];
    }
  }

  const validItems: TmdbItem[] = [];
  const duplicates: TmdbItem[] = [];

  rawList.forEach((raw, idx) => {
    const line = idx + 1;
    if (!raw || typeof raw !== 'object') {
      errors.push({ line, message: 'Kayıt geçerli bir nesne değil.' });
      return;
    }

    const title = raw.title || raw.name;
    if (!title || typeof title !== 'string' || !title.trim()) {
      errors.push({ line, message: 'Başlık (title/name) eksik veya boş.' });
      return;
    }

    const mediaType = raw.media_type === 'tv' || raw.media_type === 'movie' ? raw.media_type : raw.name && !raw.title ? 'tv' : 'movie';
    const id = raw.id != null ? String(raw.id) : `custom-${Date.now()}-${idx}`;
    const source = raw.source || (String(id).startsWith('tvdb') ? 'tvdb' : 'tmdb');

    const genres: TmdbGenre[] = Array.isArray(raw.genres)
      ? raw.genres.map((g: any, gIdx: number) =>
          typeof g === 'string'
            ? { id: 1000 + gIdx, name: g }
            : { id: typeof g.id === 'number' ? g.id : 1000 + gIdx, name: g.name || 'Genel' }
        )
      : [];

    const item: TmdbItem = {
      id,
      media_type: mediaType,
      title: raw.title || title,
      name: raw.name || title,
      original_title: raw.original_title || title,
      original_name: raw.original_name || title,
      overview: raw.overview || '',
      poster_path: raw.poster_path || raw.poster_url || null,
      poster_url: raw.poster_url || raw.poster_path || undefined,
      backdrop_path: raw.backdrop_path || null,
      release_date: raw.release_date || raw.first_air_date || '',
      first_air_date: raw.first_air_date || raw.release_date || '',
      vote_average: typeof raw.vote_average === 'number' ? raw.vote_average : 7.0,
      vote_count: typeof raw.vote_count === 'number' ? raw.vote_count : 100,
      popularity: typeof raw.popularity === 'number' ? raw.popularity : 50,
      genres,
      genre_ids: genres.map((g) => g.id),
      source,
      tvdb_id: raw.tvdb_id,
      status: raw.status || '',
      _source: 'live',
    };

    const itemKey = `${mediaType}:${id}`.toLowerCase();
    const titleKey = `title:${title.toLowerCase().trim()}`;
    const isDup = existingKeys.has(itemKey) || existingKeys.has(titleKey);

    if (isDup) {
      duplicates.push(item);
    }
    validItems.push(item);
  });

  return {
    totalRead: rawList.length,
    validCount: validItems.length,
    invalidCount: errors.length,
    duplicateCount: duplicates.length,
    newCount: validItems.length - duplicates.length,
    errors,
    validItems,
    duplicates,
  };
}

function parseCsvImport(content: string, existingKeys: Set<string>): StockImportPreview {
  const errors: Array<{ line: number; message: string }> = [];
  const rawLines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const lines = rawLines.filter((l) => !l.startsWith('#'));

  if (lines.length <= 1) {
    return {
      totalRead: 0,
      validCount: 0,
      invalidCount: 1,
      duplicateCount: 0,
      newCount: 0,
      errors: [{ line: 1, message: 'CSV dosyası boş veya yalnızca başlık satırı içeriyor.' }],
      validItems: [],
      duplicates: [],
    };
  }

  // Parse header
  const headerTokens = parseCsvLine(lines[0]);
  const colIndex = (...candidates: string[]) =>
    headerTokens.findIndex((h) => candidates.some((c) => c.toLowerCase() === h.toLowerCase().trim()));

  const idxId = colIndex('id', 'contentid', 'content_id', 'tmdbid', 'tmdb_id');
  const idxMediaType = colIndex('media_type', 'mediatype', 'type', 'tür');
  const idxSource = colIndex('source', 'kaynak');
  const idxTitle = colIndex('title', 'başlık', 'film');
  const idxName = colIndex('name', 'dizi');
  const idxYear = colIndex('year', 'yıl', 'release_year');
  const idxVoteAverage = colIndex('vote_average', 'rating', 'rating10', 'puan');
  const idxGenres = colIndex('genres', 'türler', 'turler');
  const idxOverview = colIndex('overview', 'özet', 'ozet');
  const idxPoster = colIndex('poster_url', 'poster_path', 'posterpath', 'poster', 'resim');
  const idxBackdrop = colIndex('backdrop_path', 'backdroppath', 'backdrop');
  const idxTvdbId = colIndex('tvdb_id', 'tvdbid', 'tvdb');
  const idxStatus = colIndex('status', 'durum');

  const validItems: TmdbItem[] = [];
  const duplicates: TmdbItem[] = [];

  for (let i = 1; i < lines.length; i++) {
    const lineNum = i + 1;
    const tokens = parseCsvLine(lines[i]);
    if (tokens.length === 0) continue;

    const title = (idxTitle >= 0 ? tokens[idxTitle] : '') || (idxName >= 0 ? tokens[idxName] : '');
    if (!title) {
      errors.push({ line: lineNum, message: 'Başlık veya yapım adı sütunu boş.' });
      continue;
    }

    const rawId = idxId >= 0 && tokens[idxId] ? tokens[idxId].trim() : `csv-${Date.now()}-${i}`;
    const rawMediaType = (idxMediaType >= 0 ? tokens[idxMediaType] : '').toLowerCase().trim();
    const mediaType = rawMediaType === 'tv' || rawMediaType === 'dizi' || rawMediaType === 'series' ? 'tv' : 'movie';
    const source = idxSource >= 0 && tokens[idxSource] ? tokens[idxSource].trim() : (String(rawId).startsWith('tvdb') ? 'tvdb' : 'tmdb');
    const year = idxYear >= 0 ? tokens[idxYear].trim() : '';
    const voteAvg = idxVoteAverage >= 0 && !isNaN(Number(tokens[idxVoteAverage])) ? Number(tokens[idxVoteAverage]) : 7.0;
    const overview = idxOverview >= 0 ? tokens[idxOverview].trim() : '';
    const poster = idxPoster >= 0 ? tokens[idxPoster].trim() : '';
    const backdrop = idxBackdrop >= 0 ? tokens[idxBackdrop].trim() : '';
    const tvdbId = idxTvdbId >= 0 && tokens[idxTvdbId] ? tokens[idxTvdbId].trim() : undefined;
    const status = idxStatus >= 0 ? tokens[idxStatus].trim() : '';

    const genresRaw = idxGenres >= 0 ? tokens[idxGenres] : '';
    const genres: TmdbGenre[] = genresRaw
      ? genresRaw.split('|').map((gName, gIdx) => ({ id: 1000 + gIdx, name: gName.trim() }))
      : [{ id: 18, name: 'Dram' }];

    let poster_path: string | null = null;
    let poster_url: string | undefined = undefined;
    if (poster) {
      if (/^https?:\/\//i.test(poster)) {
        poster_url = poster;
        poster_path = poster;
      } else {
        poster_path = poster.startsWith('/') ? poster : `/${poster}`;
      }
    }

    const item: TmdbItem = {
      id: rawId,
      media_type: mediaType,
      title,
      name: title,
      original_title: title,
      original_name: title,
      overview,
      poster_path,
      poster_url,
      backdrop_path: backdrop || null,
      tvdb_id: tvdbId,
      status,
      release_date: year ? `${year}-01-01` : '',
      first_air_date: year ? `${year}-01-01` : '',
      vote_average: voteAvg,
      vote_count: 200,
      popularity: 70,
      genres,
      genre_ids: genres.map((g) => g.id),
      source,
      _source: 'live',
    };

    const itemKey = `${mediaType}:${rawId}`.toLowerCase();
    const titleKey = `title:${title.toLowerCase().trim()}`;
    const isDup = existingKeys.has(itemKey) || existingKeys.has(titleKey);

    if (isDup) {
      duplicates.push(item);
    }
    validItems.push(item);
  }

  return {
    totalRead: lines.length - 1,
    validCount: validItems.length,
    invalidCount: errors.length,
    duplicateCount: duplicates.length,
    newCount: validItems.length - duplicates.length,
    errors,
    validItems,
    duplicates,
  };
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

export interface StockImportOptions {
  userListItems?: ReadonlyArray<{ id?: number | string; media_type?: string; name?: string; title?: string }>;
  preferences?: { disliked?: ReadonlyArray<string>; hidden?: ReadonlyArray<string> } | null;
}

/**
 * Applies the parsed items to IndexedDB and server persistent store
 */
export async function applyStockImport(
  items: TmdbItem[],
  strategy: StockImportStrategy = 'skip',
  options: StockImportOptions = {}
): Promise<StockImportResult> {
  const depot = await loadStockIdb();
  let movies = Array.isArray(depot.movies) ? [...depot.movies] : [];
  let tv = Array.isArray(depot.tv) ? [...depot.tv] : [];

  // Exclude user-listed items from import candidates
  const userExclusionKeys = new Set<string>();
  const userTitleSet = new Set<string>();

  if (Array.isArray(options.userListItems)) {
    for (const it of options.userListItems) {
      if (!it || it.id == null) continue;
      const rawId = String(it.id).replace(/^(movie|tv)[:-]/, '').toLowerCase();
      const mType = it.media_type === 'tv' ? 'tv' : 'movie';
      userExclusionKeys.add(`${mType}:${rawId}`);
      userExclusionKeys.add(`raw:${rawId}`);
      const normTitle = (it.title || it.name || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (normTitle) userTitleSet.add(normTitle);
    }
  }

  if (options.preferences && Array.isArray(options.preferences.disliked)) {
    for (const d of options.preferences.disliked) {
      if (!d) continue;
      const cleanKey = String(d).toLowerCase().trim();
      userExclusionKeys.add(cleanKey);
    }
  }

  const isUserExcluded = (item: TmdbItem): boolean => {
    const rawId = String(item.id).replace(/^(movie|tv)[:-]/, '').toLowerCase();
    const typeKey = `${item.media_type}:${rawId}`;
    const tvdbKey = item.tvdb_id ? `${item.media_type}:${item.tvdb_id}` : '';
    const normTitle = (item.title || item.name || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (userExclusionKeys.has(typeKey) || userExclusionKeys.has(`raw:${rawId}`)) return true;
    if (tvdbKey && userExclusionKeys.has(tvdbKey)) return true;
    if (normTitle && userTitleSet.has(normTitle)) return true;
    return false;
  };

  const eligibleItems = items.filter((it) => !isUserExcluded(it));
  const userFilteredCount = items.length - eligibleItems.length;

  let imported = 0;
  let updated = 0;
  let skipped = 0;

  const mergeStockItemLossless = (existing: TmdbItem, incoming: TmdbItem): TmdbItem => {
    const existingPoster = existing.poster_path || existing.poster_url;
    const incomingPoster = incoming.poster_path || incoming.poster_url;

    let poster_path = incoming.poster_path || existing.poster_path || null;
    let poster_url = incoming.poster_url || existing.poster_url;
    if (!poster_path && existingPoster && !existingPoster.startsWith('http')) {
      poster_path = existingPoster;
    }
    if (!poster_url && incomingPoster && incomingPoster.startsWith('http')) {
      poster_url = incomingPoster;
    }

    const mergedGenresMap = new Map<string, TmdbGenre>();
    for (const g of existing.genres || []) {
      if (g && (g.name || g.id)) mergedGenresMap.set(String(g.name || g.id).toLowerCase(), g);
    }
    for (const g of incoming.genres || []) {
      if (g && (g.name || g.id)) mergedGenresMap.set(String(g.name || g.id).toLowerCase(), g);
    }
    const genres = Array.from(mergedGenresMap.values());

    return {
      ...existing,
      ...incoming,
      title: incoming.title || existing.title || incoming.name || existing.name,
      name: incoming.name || existing.name || incoming.title || existing.title,
      poster_path: poster_path || existing.poster_path || null,
      poster_url: poster_url || existing.poster_url,
      backdrop_path: incoming.backdrop_path || existing.backdrop_path || null,
      genres: genres.length > 0 ? genres : existing.genres,
      genre_ids: genres.map((g) => g.id),
      overview: incoming.overview || existing.overview || '',
      tvdb_id: incoming.tvdb_id || existing.tvdb_id,
      vote_average: incoming.vote_average ?? existing.vote_average ?? 7.0,
      vote_count: incoming.vote_count ?? existing.vote_count ?? 100,
    };
  };

  if (strategy === 'restore') {
    const isOnlyTvdb = eligibleItems.length > 0 && eligibleItems.every((i) => i.source === 'tvdb');
    if (isOnlyTvdb) {
      // TMDB stoğuna dokunmadan TVDB stoğunu yedekten geri yükle
      movies = movies.filter((m) => m.source !== 'tvdb');
      tv = tv.filter((t) => t.source !== 'tvdb');
      const newTvdbMovies = eligibleItems.filter((it) => it.media_type !== 'tv' && (it.title || !it.name));
      const newTvdbTv = eligibleItems.filter((it) => it.media_type === 'tv' || (!it.title && it.name));
      movies.push(...newTvdbMovies);
      tv.push(...newTvdbTv);
      imported = eligibleItems.length;
    } else {
      // Tam stok geri yüklemesi
      movies = eligibleItems.filter((it) => it.media_type !== 'tv' && (it.title || !it.name));
      tv = eligibleItems.filter((it) => it.media_type === 'tv' || (!it.title && it.name));
      imported = eligibleItems.length;
    }
  } else {
    for (const item of eligibleItems) {
      const isTv = item.media_type === 'tv' || (!item.title && Boolean(item.name));
      const targetList = isTv ? tv : movies;
      const title = (item.title || item.name || '').toLowerCase().trim();
      const rawId = String(item.id).toLowerCase();

      const existingIdx = targetList.findIndex((existing) => {
        if (!existing) return false;
        if (String(existing.id).toLowerCase() === rawId) return true;
        const exTitle = (existing.title || existing.name || '').toLowerCase().trim();
        return exTitle && exTitle === title;
      });

      if (existingIdx >= 0) {
        if (strategy === 'overwrite') {
          targetList[existingIdx] = mergeStockItemLossless(targetList[existingIdx], item);
          updated++;
        } else {
          // 'skip' modunda mevcudun posteri eksik ve gelende varsa kayıpsız tamamla
          if (!hasPosterData(targetList[existingIdx]) && hasPosterData(item)) {
            targetList[existingIdx] = mergeStockItemLossless(targetList[existingIdx], item);
            updated++;
          } else {
            skipped++;
          }
        }
      } else {
        targetList.push(item);
        imported++;
      }
    }
  }

  const updatedDepot: StockDepot = {
    ...depot,
    movies,
    tv,
    updatedAt: new Date().toISOString(),
  };

  await saveStockIdb(updatedDepot);

  // Arka plan stok poster hidrasyonunu tetikle
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('cinetrack:stock-hydrated', { detail: { checkNeeded: true } })
    );
  }

  // Sync to server storage
  try {
    await fetch('/api/stock/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        movies: movies.slice(-300),
        tv: tv.slice(-300),
      }),
    });
  } catch {
    // ignore server snapshot failure
  }

  const filterNotice = userFilteredCount > 0 ? ` (${userFilteredCount} kullanıcı listesindeki içerik elendi)` : '';
  const message =
    strategy === 'restore'
      ? `${imported} yapım yedekten başarıyla geri yüklendi${filterNotice} (Toplam ${movies.length} film, ${tv.length} dizi).`
      : `${imported} yeni yapım stoğa eklendi, ${updated} yapım güncellendi, ${skipped} kopya atlandı${filterNotice}.`;

  return {
    ok: true,
    imported,
    updated,
    skipped,
    totalMovies: movies.length,
    totalTv: tv.length,
    message,
  };
}

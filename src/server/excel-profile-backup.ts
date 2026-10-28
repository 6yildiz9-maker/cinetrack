import crypto from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import ExcelJS from 'exceljs';
import {
  CURRENT_SCHEMA_VERSION,
  dedupeItems,
  ENGINE_VERSION,
  makeMediaKey,
  normalizeFavoriteActors,
  normalizePreferences,
  normalizeSavedItem,
  parseMediaKey,
  type DataDocument,
  type Profile,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import { canonicalizeMediaKeyList } from '../core/keys.ts';
import type { CatalogRecord, PersistentDataStore } from './persistent-store.ts';
import { redactSecrets } from './persistent-store.ts';

export const EXCEL_SHEET_NAMES = Object.freeze([
  'Özet',
  'İzlenen',
  'İzlenecek',
  'İzleniyor',
  'İlgilenmiyorum',
] as const);

export type ExcelSheetName = (typeof EXCEL_SHEET_NAMES)[number];
export type ContentSheetName = Exclude<ExcelSheetName, 'Özet'>;

export const DEFAULT_TR_GENRES: Readonly<Record<number, string>> = Object.freeze({
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
});

export interface ExportRowItem {
  canonicalKey: string;
  mediaType: 'movie' | 'tv';
  mediaTypeLabel: 'FİLM' | 'DİZİ';
  tmdbId: number | string;
  title: string;
  year: number | null;
  tmdbRating: number | null;
  personalRating: number | null;
  genresText: string | null;
  addedAtFormatted: string | null;
  addedAtRaw: string | null;
  updatedAtFormatted: string | null;
  updatedAtRaw: string | null;
  userNote: string | null;
  progressOrRuntime: string | null;
  posterUrl: string | null;
  custom: boolean;
}

export interface SheetBreakdownCount {
  total: number;
  movie: number;
  tv: number;
}

export interface PosterFetchFailure {
  mediaKey: string;
  title: string;
  posterUrl: string;
  reason: string;
}

export interface ResolvedPosterAsset {
  buffer: Buffer;
  extension: 'jpeg' | 'png' | 'gif';
  isPlaceholder: boolean;
  fromCache: boolean;
}

export interface ProfileBackupDataset {
  profileId: string;
  profileName: string;
  schemaVersion: number;
  engineVersion: string;
  exportedAtIso: string;
  exportedAtFormatted: string;
  favoriteActorsCount: number;
  customItemsCount: number;
  dualStateKeys: string[];
  sheets: Record<ContentSheetName, ExportRowItem[]>;
  sheetCounts: Record<ContentSheetName, SheetBreakdownCount>;
  totalItemsCount: number;
  totalMovieCount: number;
  totalTvCount: number;
  personalRatingDistribution: Array<{ rating: number; count: number }>;
  averagePersonalRating: number | null;
  ratedItemsCount: number;
  decadeDistribution: Array<{ decade: string; count: number; movieCount: number; tvCount: number }>;
  topGenres: Array<{ name: string; count: number; sharePercent: number }>;
}

export interface ExcelWorkbookBuildResult {
  buffer: Buffer;
  sha256: string;
  sizeBytes: number;
  sheetNames: string[];
  dataset: ProfileBackupDataset;
  embeddedPostersCount: number;
  placeholderPostersCount: number;
  missingPosterSourceCount: number;
  posterErrorsCount: number;
  posterErrors: PosterFetchFailure[];
}

export interface SingleFileExportOutcome {
  attempted: boolean;
  ok: boolean;
  fileName?: string;
  relativePath?: string;
  absolutePath?: string;
  downloadUrl?: string;
  sizeBytes?: number;
  sha256?: string;
  error?: string;
}

export interface GitHubExcelUploadOutcome {
  attempted: boolean;
  ok: boolean;
  blockedByPublicGuard?: boolean;
  skippedNoop?: boolean;
  repoPath?: string;
  sha?: string;
  localHash?: string | null;
  readBackHash?: string | null;
  verifiedReadBack: boolean;
  repoVisibilityWarning?: string;
  error?: string;
}

export interface ProfileBackupExecutionReport {
  ok: boolean;
  partialFailure: boolean;
  exportedAt: string;
  profileId: string;
  profileName: string;
  jsonBackup: SingleFileExportOutcome;
  excelBackup: SingleFileExportOutcome & {
    sheetNames?: string[];
    sheetCounts?: Record<ContentSheetName, SheetBreakdownCount>;
    totalItemsCount?: number;
    movieCount?: number;
    tvCount?: number;
    embeddedPostersCount?: number;
    placeholderPostersCount?: number;
    missingPosterSourceCount?: number;
    posterErrorsCount?: number;
    posterErrors?: PosterFetchFailure[];
    dualStateKeys?: string[];
  };
  githubUpload: GitHubExcelUploadOutcome;
}

export type PosterFetcherFn = (
  url: string,
  timeoutMs: number
) => Promise<{ status: number; contentType?: string | null; buffer: Buffer }>;

export type TmdbItemFetcherFn = (
  mediaType: 'movie' | 'tv',
  id: number
) => Promise<Record<string, any> | null>;

function stripIllegalXmlControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isAllowedControl = code === 0x09 || code === 0x0a || code === 0x0d;
    const isPrintableXml =
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff);
    if (isAllowedControl || isPrintableXml) {
      out += ch;
    }
  }
  return out;
}

/**
 * Protects spreadsheet cells against formula injection (=, +, -, @, TAB, CR)
 * and strips invalid XML control characters while keeping full UTF-8 & Turkish text intact.
 */
export function sanitizeSpreadsheetText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = stripIllegalXmlControlChars(String(raw)).trim();
  if (!cleaned) return null;
  if (/^[=+\-@\t\r]/.test(cleaned)) {
    return `'${cleaned}`;
  }
  return cleaned;
}

/**
 * Formats an ISO timestamp cleanly as YYYY-MM-DD HH:mm (UTC or valid ISO).
 * Never invents dates for empty or malformed values.
 */
export function formatBackupDateTime(isoValue?: string | null): string | null {
  if (!isoValue || typeof isoValue !== 'string') return null;
  const trimmed = isoValue.trim();
  if (!trimmed || trimmed === '1970-01-01T00:00:00.000Z') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  const yyyy = parsed.getUTCFullYear();
  if (yyyy < 1900 || yyyy > 2100) return null;
  const mm = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(parsed.getUTCDate()).padStart(2, '0');
  const hh = String(parsed.getUTCHours()).padStart(2, '0');
  const min = String(parsed.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

/**
 * Builds the canonical timestamped filename `CineTrack_Profile_YYYY-MM-DD_HHmm.<ext>`
 * using local runtime wall-clock time.
 */
export function formatExportBaseName(now: Date = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `CineTrack_Profile_${yyyy}-${mm}-${dd}_${hh}${min}`;
}

/**
 * Ensures timestamped export files in `exportsDir` are never overwritten.
 */
export function resolveUniqueExportFileName(
  exportsDir: string,
  baseName: string,
  extension: 'xlsx' | 'json'
): { fileName: string; fullPath: string } {
  mkdirSync(exportsDir, { recursive: true });
  const primaryName = `${baseName}.${extension}`;
  const primaryPath = path.join(exportsDir, primaryName);
  if (!existsSync(primaryPath)) {
    return { fileName: primaryName, fullPath: primaryPath };
  }
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidateName = `${baseName}_${String(suffix).padStart(2, '0')}.${extension}`;
    const candidatePath = path.join(exportsDir, candidateName);
    if (!existsSync(candidatePath)) {
      return { fileName: candidateName, fullPath: candidatePath };
    }
  }
  const fallbackName = `${baseName}_${Date.now()}.${extension}`;
  return { fileName: fallbackName, fullPath: path.join(exportsDir, fallbackName) };
}

export const EXPORT_FILE_NAME_PATTERN =
  /^CineTrack_Profile_\d{4}-\d{2}-\d{2}_\d{4}(?:_\d{2,14})?\.(?:xlsx|json)$/;

/**
 * Inspects image magic bytes to ensure only valid binary JPEG/PNG/GIF images are embedded into Excel.
 */
export function detectImageExtension(buffer: Buffer): 'jpeg' | 'png' | 'gif' | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png';
  }
  // GIF87a / GIF89a: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'gif';
  }
  return null;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

let cachedPlaceholderPng: Buffer | null = null;

/**
 * Generates a crisp, neutral CineTrack 2:3 dark-slate placeholder PNG (68x102 px)
 * using pure Node.js built-ins (no native dependencies).
 */
export function getNeutralPosterPlaceholderPng(): Buffer {
  if (cachedPlaceholderPng) return cachedPlaceholderPng;
  const width = 68;
  const height = 102;
  // RGB color type (2), 8-bit depth
  const rowStride = 1 + width * 3;
  const raw = Buffer.alloc(rowStride * height);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowStride;
    raw[rowStart] = 0; // Filter type 0 (None)
    for (let x = 0; x < width; x += 1) {
      const px = rowStart + 1 + x * 3;
      const isOuterBorder = x <= 1 || x >= width - 2 || y <= 1 || y >= height - 2;
      const isInnerIconFrame =
        x >= 20 &&
        x <= 47 &&
        y >= 34 &&
        y <= 67 &&
        (x === 20 || x === 47 || y === 34 || y === 67 || y === 42 || y === 59);
      const isFilmSprocket =
        (x === 24 || x === 43) && y >= 36 && y <= 65 && y % 5 <= 1;

      let r = 0x1e;
      let g = 0x29;
      let b = 0x3b; // #1E293B CineTrack slate-navy
      if (isOuterBorder) {
        r = 0x33;
        g = 0x41;
        b = 0x55; // #334155 subtle border
      } else if (isInnerIconFrame || isFilmSprocket) {
        r = 0x64;
        g = 0x74;
        b = 0x8b; // #64748B minimalist film frame
      }
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw, { level: 9 });
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  cachedPlaceholderPng = Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
  return cachedPlaceholderPng;
}

export function resolvePosterUrlForExport(
  item: { poster_path?: string | null; poster_url?: string | null },
  tmdbPosterSize = 'w154'
): string | null {
  const rawPath = typeof item.poster_path === 'string' ? item.poster_path.trim() : '';
  if (rawPath) {
    if (rawPath.startsWith('https://')) return rawPath;
    const normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    return `https://image.tmdb.org/t/p/${tmdbPosterSize}${normalizedPath}`;
  }
  const rawUrl = typeof item.poster_url === 'string' ? item.poster_url.trim() : '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:') return parsed.href;
    } catch {
      return null;
    }
  }
  return null;
}

const defaultPosterFetcher: PosterFetcherFn = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'image/jpeg,image/png,image/gif,image/*;q=0.8',
        'User-Agent': 'CineTrack-Backup-Exporter/1.0',
      },
    });
    const arr = await res.arrayBuffer();
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      buffer: Buffer.from(arr),
    };
  } finally {
    clearTimeout(timer);
  }
};

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIdx = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: workerCount }, async () => {
    while (nextIdx < items.length) {
      const current = nextIdx;
      nextIdx += 1;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

export class PosterCacheManager {
  private cacheDir: string;
  private memoryCache = new Map<string, { buffer: Buffer; extension: 'jpeg' | 'png' | 'gif' }>();

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    mkdirSync(this.cacheDir, { recursive: true });
  }

  private getDiskPaths(urlHash: string): Array<{ ext: 'jpeg' | 'png' | 'gif'; filePath: string }> {
    return [
      { ext: 'jpeg', filePath: path.join(this.cacheDir, `${urlHash}.jpg`) },
      { ext: 'png', filePath: path.join(this.cacheDir, `${urlHash}.png`) },
      { ext: 'gif', filePath: path.join(this.cacheDir, `${urlHash}.gif`) },
    ];
  }

  public readCached(url: string): { buffer: Buffer; extension: 'jpeg' | 'png' | 'gif' } | null {
    const memHit = this.memoryCache.get(url);
    if (memHit) return memHit;

    const urlHash = crypto.createHash('sha256').update(url).digest('hex');
    for (const candidate of this.getDiskPaths(urlHash)) {
      if (!existsSync(candidate.filePath)) continue;
      try {
        const stat = statSync(candidate.filePath);
        if (stat.size < 16 || stat.size > 5 * 1024 * 1024) continue;
        const buf = readFileSync(candidate.filePath);
        const detected = detectImageExtension(buf);
        if (detected) {
          const entry = { buffer: buf, extension: detected };
          this.memoryCache.set(url, entry);
          return entry;
        }
      } catch {
        // Ignore unreadable cache entry and refetch
      }
    }
    return null;
  }

  public writeCached(url: string, buffer: Buffer, extension: 'jpeg' | 'png' | 'gif'): void {
    this.memoryCache.set(url, { buffer, extension });
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      const urlHash = crypto.createHash('sha256').update(url).digest('hex');
      const fileExt = extension === 'jpeg' ? 'jpg' : extension;
      const target = path.join(this.cacheDir, `${urlHash}.${fileExt}`);
      writeFileSync(target, buffer);
    } catch {
      // Disk cache write failure is non-fatal
    }
  }
}

function extractValidYear(rawDate?: string | null): number | null {
  if (!rawDate || typeof rawDate !== 'string') return null;
  const match = /^(\d{4})/.exec(rawDate.trim());
  if (!match) return null;
  const year = Number(match[1]);
  if (!Number.isInteger(year) || year < 1888 || year > 2100) return null;
  return year;
}

function resolveGenresText(
  rawGenres: unknown,
  genreIds: unknown,
  genresMap: Record<number, string>
): string | null {
  const names: string[] = [];
  const seen = new Set<string>();

  if (Array.isArray(rawGenres)) {
    for (const entry of rawGenres) {
      const name = typeof entry === 'string' ? entry.trim() : String(entry?.name || '').trim();
      if (name && !seen.has(name.toLocaleLowerCase('tr-TR'))) {
        seen.add(name.toLocaleLowerCase('tr-TR'));
        names.push(name);
      }
    }
  }

  if (Array.isArray(genreIds)) {
    for (const rawId of genreIds) {
      const gid = Number(rawId);
      if (!Number.isSafeInteger(gid) || gid <= 0) continue;
      const name = (genresMap[gid] || DEFAULT_TR_GENRES[gid] || '').trim();
      if (name && !seen.has(name.toLocaleLowerCase('tr-TR'))) {
        seen.add(name.toLocaleLowerCase('tr-TR'));
        names.push(name);
      }
    }
  }

  if (names.length === 0) return null;
  return sanitizeSpreadsheetText(names.join(', '));
}

function formatProgressOrRuntime(item: Partial<SavedItem> & Record<string, any>): string | null {
  if (item.media_type === 'tv') {
    const parts: string[] = [];
    const seasons = Number(item.number_of_seasons) || 0;
    const totalEps = Number(item.number_of_episodes) || 0;
    const watchedEps = Number(item.episodes_watched) || 0;
    const curSeason = Number(item.current_season) || 0;

    if (seasons > 0) parts.push(`${seasons} Sezon`);
    if (totalEps > 0) parts.push(`${totalEps} Bölüm`);
    if (watchedEps > 0) {
      parts.push(
        curSeason > 0 ? `İzlenen: ${watchedEps} blm (S${curSeason})` : `İzlenen: ${watchedEps} blm`
      );
    }
    return parts.length > 0 ? sanitizeSpreadsheetText(parts.join(' · ')) : null;
  }

  const runtime = Number(item.runtime) || 0;
  if (runtime > 0 && Number.isFinite(runtime)) {
    return `${Math.round(runtime)} dk`;
  }
  return null;
}

function mapRecordToExportRow(
  source: Partial<SavedItem> & Record<string, any>,
  catalogMatch: CatalogRecord | undefined,
  genresMap: Record<number, string>,
  tmdbPosterSize: string
): ExportRowItem {
  const mediaType: 'movie' | 'tv' = source.media_type === 'tv' ? 'tv' : 'movie';
  const id = source.id ?? catalogMatch?.id ?? '';
  const canonicalKey = makeMediaKey(mediaType, id);

  const rawTitle =
    (typeof source.title === 'string' && source.title.trim()) ||
    (typeof source.name === 'string' && source.name.trim()) ||
    (typeof catalogMatch?.title === 'string' && catalogMatch.title.trim()) ||
    canonicalKey;

  const rawDate =
    source.release_date ||
    source.first_air_date ||
    catalogMatch?.release_date ||
    catalogMatch?.first_air_date ||
    null;

  const rawVote =
    Number(source.vote_average) > 0
      ? Number(source.vote_average)
      : Number(catalogMatch?.vote_average) > 0
        ? Number(catalogMatch?.vote_average)
        : 0;
  const tmdbRating =
    Number.isFinite(rawVote) && rawVote > 0 ? Math.round(rawVote * 10) / 10 : null;

  const rawPersonal = Number(source.personal_rating);
  const personalRating =
    source.personal_rating !== '' &&
    source.personal_rating !== null &&
    source.personal_rating !== undefined &&
    Number.isFinite(rawPersonal) &&
    rawPersonal >= 1 &&
    rawPersonal <= 10
      ? Math.round(rawPersonal * 10) / 10
      : null;

  const combinedGenreIds =
    Array.isArray(source.genre_ids) && source.genre_ids.length > 0
      ? source.genre_ids
      : catalogMatch?.genre_ids || [];

  const genresText = resolveGenresText(source.genres, combinedGenreIds, genresMap);

  const addedAtRaw =
    (typeof source.addedAt === 'string' && source.addedAt.trim()) ||
    (typeof source.firstAddedAt === 'string' && source.firstAddedAt.trim()) ||
    null;
  const updatedAtRaw =
    (typeof source.updatedAt === 'string' && source.updatedAt.trim()) || null;

  const rawNote =
    typeof source.note === 'string'
      ? source.note
      : typeof source.notes === 'string'
        ? source.notes
        : typeof source.user_note === 'string'
          ? source.user_note
          : null;

  const posterUrl = resolvePosterUrlForExport(
    {
      poster_path: source.poster_path || catalogMatch?.poster_path || null,
      poster_url: source.poster_url || null,
    },
    tmdbPosterSize
  );

  const numericTmdbId =
    typeof id === 'number' && Number.isSafeInteger(id)
      ? id
      : typeof id === 'string' && /^\d+$/.test(id)
        ? Number(id)
        : String(id);

  return {
    canonicalKey,
    mediaType,
    mediaTypeLabel: mediaType === 'tv' ? 'DİZİ' : 'FİLM',
    tmdbId: numericTmdbId,
    title: sanitizeSpreadsheetText(rawTitle) || canonicalKey,
    year: extractValidYear(rawDate),
    tmdbRating,
    personalRating,
    genresText,
    addedAtFormatted: formatBackupDateTime(addedAtRaw),
    addedAtRaw,
    updatedAtFormatted: formatBackupDateTime(updatedAtRaw),
    updatedAtRaw,
    userNote: sanitizeSpreadsheetText(rawNote),
    progressOrRuntime: formatProgressOrRuntime(source),
    posterUrl,
    custom: Boolean(source.custom || String(id).startsWith('custom-')),
  };
}

function sortSavedExportRows(rows: ExportRowItem[]): ExportRowItem[] {
  return [...rows].sort((a, b) => {
    const timeA = a.addedAtRaw || a.updatedAtRaw || '';
    const timeB = b.addedAtRaw || b.updatedAtRaw || '';
    if (timeA !== timeB) {
      return timeB.localeCompare(timeA);
    }
    return a.canonicalKey.localeCompare(b.canonicalKey);
  });
}

function summarizeSheetCounts(rows: ExportRowItem[]): SheetBreakdownCount {
  let movie = 0;
  let tv = 0;
  for (const r of rows) {
    if (r.mediaType === 'tv') tv += 1;
    else movie += 1;
  }
  return { total: rows.length, movie, tv };
}

export interface BuildDatasetOptions {
  profile: Profile;
  schemaVersion?: number;
  engineVersion?: string;
  exportedAt?: Date;
  moviesCatalog?: Record<string, CatalogRecord>;
  tvCatalog?: Record<string, CatalogRecord>;
  dislikedItemsHint?: Array<Record<string, any>>;
  genresMap?: Record<number, string>;
  tmdbPosterSize?: string;
  fetchMissingTmdbItem?: TmdbItemFetcherFn;
  onNewlyFetchedCatalogItems?: (items: Array<Record<string, any>>) => void;
}

/**
 * Pure, non-mutating builder that maps a CineTrack `Profile` into the 5-sheet dataset.
 * Strictly preserves `movie:<id>` vs `tv:<id>` separation and reports any dual-state keys.
 */
export async function buildProfileBackupDataset(
  options: BuildDatasetOptions
): Promise<ProfileBackupDataset> {
  const exportedAt = options.exportedAt || new Date();
  const exportedAtIso = exportedAt.toISOString();
  const exportedAtFormatted = formatBackupDateTime(exportedAtIso) || exportedAtIso.slice(0, 16);
  const tmdbPosterSize = options.tmdbPosterSize || 'w154';
  const moviesCatalog = options.moviesCatalog || {};
  const tvCatalog = options.tvCatalog || {};
  const mergedGenresMap: Record<number, string> = {
    ...DEFAULT_TR_GENRES,
    ...(options.genresMap || {}),
  };

  // Clone & normalize without mutating caller's profile object
  const rawItemsClone = Array.isArray(options.profile.items)
    ? options.profile.items.map((it) => ({ ...it }))
    : [];
  const normalizedItems = dedupeItems(
    rawItemsClone.map((it) => normalizeSavedItem(it)).filter(Boolean) as SavedItem[]
  );
  const prefs = normalizePreferences(options.profile.preferences || {});
  const favActors = normalizeFavoriteActors(options.profile.favoriteActors || []);

  const savedByKey = new Map<string, SavedItem>();
  for (const item of normalizedItems) {
    savedByKey.set(makeMediaKey(item), item);
  }

  const hintByKey = new Map<string, Record<string, any>>();
  for (const hint of options.dislikedItemsHint || []) {
    if (!hint || typeof hint !== 'object' || hint.id == null) continue;
    const mType: 'movie' | 'tv' = hint.media_type === 'tv' ? 'tv' : 'movie';
    hintByKey.set(makeMediaKey(mType, hint.id), hint);
  }

  const izlenenRaw: ExportRowItem[] = [];
  const izlenecekRaw: ExportRowItem[] = [];
  const izleniyorRaw: ExportRowItem[] = [];

  for (const item of normalizedItems) {
    const key = makeMediaKey(item);
    const catMatch = item.media_type === 'tv' ? tvCatalog[key] : moviesCatalog[key];
    // Preserve any user note fields if present on raw input item
    const rawOriginal = rawItemsClone.find(
      (r) => r && makeMediaKey(r.media_type === 'tv' ? 'tv' : 'movie', r.id) === key
    );
    const enrichedSource = rawOriginal ? { ...rawOriginal, ...item } : item;
    const row = mapRecordToExportRow(enrichedSource, catMatch, mergedGenresMap, tmdbPosterSize);

    if (item.status === 'completed') {
      izlenenRaw.push(row);
    } else if (item.status === 'watching') {
      izleniyorRaw.push(row);
    } else {
      izlenecekRaw.push(row);
    }
  }

  // Deduplicate canonical disliked keys while preserving newest-first order
  const canonicalDisliked = canonicalizeMediaKeyList(prefs.disliked || []);
  const uniqueDislikedNewestFirst: string[] = [];
  const seenDisliked = new Set<string>();
  for (let i = canonicalDisliked.length - 1; i >= 0; i -= 1) {
    const key = canonicalDisliked[i];
    if (!seenDisliked.has(key)) {
      seenDisliked.add(key);
      uniqueDislikedNewestFirst.push(key);
    }
  }

  // Detect any item simultaneously present in `items` and `preferences.disliked`
  const dualStateKeys = uniqueDislikedNewestFirst.filter((key) => savedByKey.has(key));

  // Fetch missing disliked metadata via TMDB if available
  const fetchedDislikedMap = new Map<string, Record<string, any>>();
  const newlyFetchedForCatalog: Array<Record<string, any>> = [];
  if (options.fetchMissingTmdbItem) {
    const keysToFetch = uniqueDislikedNewestFirst.filter((key) => {
      if (savedByKey.has(key) || hintByKey.has(key)) return false;
      const parsed = parseMediaKey(key);
      if (!parsed || !/^\d+$/.test(String(parsed.id))) return false;
      const cat = parsed.type === 'tv' ? tvCatalog[key] : moviesCatalog[key];
      return !cat;
    });

    await runWithConcurrency(keysToFetch, 8, async (key) => {
      const parsed = parseMediaKey(key);
      if (!parsed) return;
      try {
        const fetched = await options.fetchMissingTmdbItem!(
          parsed.type as 'movie' | 'tv',
          Number(parsed.id)
        );
        if (fetched && typeof fetched === 'object') {
          const withType = { ...fetched, id: Number(parsed.id), media_type: parsed.type };
          fetchedDislikedMap.set(key, withType);
          newlyFetchedForCatalog.push(withType);
        }
      } catch {
        // Non-fatal: fallback to minimal ID + type row without inventing values
      }
    });
  }

  if (newlyFetchedForCatalog.length > 0 && options.onNewlyFetchedCatalogItems) {
    try {
      options.onNewlyFetchedCatalogItems(newlyFetchedForCatalog);
    } catch {
      // Ignore catalog cache callback errors
    }
  }

  const ilgilenmiyorumRows: ExportRowItem[] = [];
  for (const key of uniqueDislikedNewestFirst) {
    const parsed = parseMediaKey(key);
    if (!parsed) continue;
    const mediaType: 'movie' | 'tv' = parsed.type === 'tv' ? 'tv' : 'movie';
    const catMatch = mediaType === 'tv' ? tvCatalog[key] : moviesCatalog[key];
    const savedMatch = savedByKey.get(key);
    const hintMatch = hintByKey.get(key);
    const tmdbMatch = fetchedDislikedMap.get(key);

    const sourceRecord: Record<string, any> = {
      id: /^\d+$/.test(String(parsed.id)) ? Number(parsed.id) : parsed.id,
      media_type: mediaType,
      ...(tmdbMatch || {}),
      ...(hintMatch || {}),
      ...(savedMatch || {}),
    };
    ilgilenmiyorumRows.push(
      mapRecordToExportRow(sourceRecord, catMatch, mergedGenresMap, tmdbPosterSize)
    );
  }

  const sheets: Record<ContentSheetName, ExportRowItem[]> = {
    İzlenen: sortSavedExportRows(izlenenRaw),
    İzlenecek: sortSavedExportRows(izlenecekRaw),
    İzleniyor: sortSavedExportRows(izleniyorRaw),
    İlgilenmiyorum: ilgilenmiyorumRows,
  };

  const sheetCounts: Record<ContentSheetName, SheetBreakdownCount> = {
    İzlenen: summarizeSheetCounts(sheets.İzlenen),
    İzlenecek: summarizeSheetCounts(sheets.İzlenecek),
    İzleniyor: summarizeSheetCounts(sheets.İzleniyor),
    İlgilenmiyorum: summarizeSheetCounts(sheets.İlgilenmiyorum),
  };

  // Aggregate unique items across all 4 sheets (and total sheet rows)
  const allRowsAcrossSheets: ExportRowItem[] = [
    ...sheets.İzlenen,
    ...sheets.İzlenecek,
    ...sheets.İzleniyor,
    ...sheets.İlgilenmiyorum,
  ];

  const totalItemsCount =
    sheetCounts.İzlenen.total +
    sheetCounts.İzlenecek.total +
    sheetCounts.İzleniyor.total +
    sheetCounts.İlgilenmiyorum.total;
  const totalMovieCount =
    sheetCounts.İzlenen.movie +
    sheetCounts.İzlenecek.movie +
    sheetCounts.İzleniyor.movie +
    sheetCounts.İlgilenmiyorum.movie;
  const totalTvCount =
    sheetCounts.İzlenen.tv +
    sheetCounts.İzlenecek.tv +
    sheetCounts.İzleniyor.tv +
    sheetCounts.İlgilenmiyorum.tv;

  // Deduplicate by canonicalKey for rating/decade/genre statistics if dualStateKeys exist
  const uniqueStatRowsMap = new Map<string, ExportRowItem>();
  for (const r of allRowsAcrossSheets) {
    if (!uniqueStatRowsMap.has(r.canonicalKey)) {
      uniqueStatRowsMap.set(r.canonicalKey, r);
    }
  }
  const uniqueStatRows = Array.from(uniqueStatRowsMap.values());

  // Personal rating distribution (1..10)
  const ratingMap = new Map<number, number>();
  for (let score = 10; score >= 1; score -= 1) {
    ratingMap.set(score, 0);
  }
  let ratingSum = 0;
  let ratedItemsCount = 0;
  for (const r of uniqueStatRows) {
    if (r.personalRating !== null && r.personalRating >= 1 && r.personalRating <= 10) {
      const bucket = Math.round(r.personalRating);
      ratingMap.set(bucket, (ratingMap.get(bucket) || 0) + 1);
      ratingSum += r.personalRating;
      ratedItemsCount += 1;
    }
  }
  const personalRatingDistribution = Array.from(ratingMap.entries()).map(([rating, count]) => ({
    rating,
    count,
  }));
  const averagePersonalRating =
    ratedItemsCount > 0 ? Math.round((ratingSum / ratedItemsCount) * 100) / 100 : null;

  // Release decade distribution
  const decadeMap = new Map<number, { count: number; movieCount: number; tvCount: number }>();
  for (const r of uniqueStatRows) {
    if (r.year !== null) {
      const dec = Math.floor(r.year / 10) * 10;
      const cur = decadeMap.get(dec) || { count: 0, movieCount: 0, tvCount: 0 };
      cur.count += 1;
      if (r.mediaType === 'tv') cur.tvCount += 1;
      else cur.movieCount += 1;
      decadeMap.set(dec, cur);
    }
  }
  const decadeDistribution = Array.from(decadeMap.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([dec, counts]) => ({
      decade: `${dec}'ler`,
      ...counts,
    }));

  // Genre distribution across real exported items
  const genreCounter = new Map<string, number>();
  let totalGenreMentions = 0;
  for (const r of uniqueStatRows) {
    if (!r.genresText) continue;
    const cleanText = r.genresText.startsWith("'") ? r.genresText.slice(1) : r.genresText;
    for (const part of cleanText.split(',')) {
      const g = part.trim();
      if (!g) continue;
      genreCounter.set(g, (genreCounter.get(g) || 0) + 1);
      totalGenreMentions += 1;
    }
  }
  const topGenres = Array.from(genreCounter.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'tr'))
    .slice(0, 10)
    .map(([name, count]) => ({
      name,
      count,
      sharePercent:
        totalGenreMentions > 0 ? Math.round((count / totalGenreMentions) * 1000) / 10 : 0,
    }));

  const customItemsCount = uniqueStatRows.filter((r) => r.custom).length;

  return {
    profileId: String(options.profile.id || 'profile-default'),
    profileName: String(options.profile.name || 'Profilim'),
    schemaVersion: options.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    engineVersion: options.engineVersion ?? ENGINE_VERSION,
    exportedAtIso,
    exportedAtFormatted,
    favoriteActorsCount: favActors.length,
    customItemsCount,
    dualStateKeys,
    sheets,
    sheetCounts,
    totalItemsCount,
    totalMovieCount,
    totalTvCount,
    personalRatingDistribution,
    averagePersonalRating,
    ratedItemsCount,
    decadeDistribution,
    topGenres,
  };
}

interface SheetThemePalette {
  headerAccentHex: string;
  softBannerBgHex: string;
  softBannerTextHex: string;
  cardBorderHex: string;
  subtitle: string;
}

const CONTENT_SHEET_THEMES: Readonly<Record<ContentSheetName, SheetThemePalette>> = Object.freeze({
  İzlenen: {
    headerAccentHex: 'FF16A34A', // Green
    softBannerBgHex: 'FFF0FDF4',
    softBannerTextHex: 'FF166534',
    cardBorderHex: 'FF86EFAC',
    subtitle: 'Tamamlanan film ve diziler arşivi',
  },
  İzlenecek: {
    headerAccentHex: 'FF2563EB', // Blue
    softBannerBgHex: 'FFEFF6FF',
    softBannerTextHex: 'FF1E40AF',
    cardBorderHex: 'FF93C5FD',
    subtitle: 'Daha sonra izlenmek üzere kaydedilen içerikler',
  },
  İzleniyor: {
    headerAccentHex: 'FFEA580C', // Orange
    softBannerBgHex: 'FFFFF7ED',
    softBannerTextHex: 'FF9A3412',
    cardBorderHex: 'FFFDBA74',
    subtitle: 'Şu anda aktif olarak takip edilen içerikler',
  },
  İlgilenmiyorum: {
    headerAccentHex: 'FF9F1239', // Burgundy / Crimson
    softBannerBgHex: 'FFFFF1F2',
    softBannerTextHex: 'FF881337',
    cardBorderHex: 'FFFDA4AF',
    subtitle: 'Öneri akışından çıkarılan / ilgilenilmeyen içerikler',
  },
});

const FONT_FAMILY = 'Calibri';

export interface GenerateExcelOptions extends BuildDatasetOptions {
  posterCacheDir: string;
  posterFetcher?: PosterFetcherFn;
  posterTimeoutMs?: number;
  posterConcurrency?: number;
  embedPlaceholderOnMissingPoster?: boolean;
}

/**
 * Builds the formatted, 5-sheet, embedded-poster `.xlsx` workbook buffer.
 */
export async function generateProfileExcelBuffer(
  options: GenerateExcelOptions
): Promise<ExcelWorkbookBuildResult> {
  const dataset = await buildProfileBackupDataset(options);
  const posterCache = new PosterCacheManager(options.posterCacheDir);
  const posterFetcher = options.posterFetcher || defaultPosterFetcher;
  const posterTimeoutMs = options.posterTimeoutMs ?? 7000;
  const posterConcurrency = options.posterConcurrency ?? 16;
  const embedPlaceholder = options.embedPlaceholderOnMissingPoster ?? true;

  // Collect all rows across the 4 content sheets and deduplicate poster URL downloads
  const allSheetRows: ExportRowItem[] = [
    ...dataset.sheets.İzlenen,
    ...dataset.sheets.İzlenecek,
    ...dataset.sheets.İzleniyor,
    ...dataset.sheets.İlgilenmiyorum,
  ];

  const uniqueUrls = Array.from(
    new Set(allSheetRows.map((r) => r.posterUrl).filter((u): u is string => Boolean(u)))
  );

  const urlFetchOutcome = new Map<
    string,
    { ok: true; buffer: Buffer; extension: 'jpeg' | 'png' | 'gif' } | { ok: false; reason: string }
  >();

  await runWithConcurrency(uniqueUrls, posterConcurrency, async (url) => {
    const cached = posterCache.readCached(url);
    if (cached) {
      urlFetchOutcome.set(url, {
        ok: true,
        buffer: cached.buffer,
        extension: cached.extension,
      });
      return;
    }

    try {
      const response = await posterFetcher(url, posterTimeoutMs);
      if (response.status !== 200) {
        urlFetchOutcome.set(url, {
          ok: false,
          reason: `HTTP ${response.status}`,
        });
        return;
      }
      if (!response.buffer || response.buffer.length === 0) {
        urlFetchOutcome.set(url, {
          ok: false,
          reason: 'Boş görsel yanıtı (0 bayt)',
        });
        return;
      }
      const ext = detectImageExtension(response.buffer);
      if (!ext) {
        urlFetchOutcome.set(url, {
          ok: false,
          reason: `Desteklenmeyen veya bozuk görsel biçimi (${response.contentType || 'bilinmiyor'})`,
        });
        return;
      }
      posterCache.writeCached(url, response.buffer, ext);
      urlFetchOutcome.set(url, {
        ok: true,
        buffer: response.buffer,
        extension: ext,
      });
    } catch (err: any) {
      const msg =
        err?.name === 'AbortError'
          ? `İstek zaman aşımına uğradı (${posterTimeoutMs} ms)`
          : err?.message || 'Ağ bağlantı hatası';
      urlFetchOutcome.set(url, {
        ok: false,
        reason: msg,
      });
    }
  });

  // Compute accurate poster embedding & error metrics before rendering Özet sheet
  let embeddedPostersCount = 0;
  let placeholderPostersCount = 0;
  let missingPosterSourceCount = 0;
  const posterErrors: PosterFetchFailure[] = [];

  for (const row of allSheetRows) {
    if (!row.posterUrl) {
      missingPosterSourceCount += 1;
      if (embedPlaceholder) placeholderPostersCount += 1;
      continue;
    }
    const outcome = urlFetchOutcome.get(row.posterUrl);
    if (outcome && outcome.ok) {
      embeddedPostersCount += 1;
    } else {
      posterErrors.push({
        mediaKey: row.canonicalKey,
        title: row.title.startsWith("'") ? row.title.slice(1) : row.title,
        posterUrl: row.posterUrl,
        reason: outcome ? outcome.reason : 'Bilinmeyen görsel hatası',
      });
      if (embedPlaceholder) placeholderPostersCount += 1;
    }
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CineTrack';
  workbook.lastModifiedBy = 'CineTrack';
  workbook.created = options.exportedAt || new Date();
  workbook.modified = options.exportedAt || new Date();

  // Register unique binary images in workbook media table once per unique URL (avoids bloating .xlsx on duplicate URLs)
  const workbookImageIdByUrl = new Map<string, number>();
  for (const [url, outcome] of urlFetchOutcome.entries()) {
    if (outcome.ok) {
      const imgId = workbook.addImage({
        buffer: outcome.buffer as any,
        extension: outcome.extension,
      });
      workbookImageIdByUrl.set(url, imgId);
    }
  }

  let placeholderImageId: number | null = null;
  if (embedPlaceholder && (missingPosterSourceCount > 0 || posterErrors.length > 0)) {
    placeholderImageId = workbook.addImage({
      buffer: getNeutralPosterPlaceholderPng() as any,
      extension: 'png',
    });
  }

  // 1. Özet Sheet (Must be index 0)
  const summarySheet = workbook.addWorksheet('Özet', {
    views: [{ state: 'frozen', ySplit: 3, showGridLines: false }],
    properties: { tabColor: { argb: 'FF0F172A' } },
  });
  populateSummaryWorksheet(summarySheet, dataset, {
    embeddedPostersCount,
    posterErrorsCount: posterErrors.length,
    missingPosterSourceCount,
  });

  // 2..5. Content Sheets in exact required order
  const contentSheetOrder: ContentSheetName[] = [
    'İzlenen',
    'İzlenecek',
    'İzleniyor',
    'İlgilenmiyorum',
  ];

  for (const sheetName of contentSheetOrder) {
    const theme = CONTENT_SHEET_THEMES[sheetName];
    const ws = workbook.addWorksheet(sheetName, {
      views: [{ state: 'frozen', ySplit: 4, showGridLines: true }],
      properties: { tabColor: { argb: theme.headerAccentHex } },
    });

    populateContentWorksheet(
      ws,
      sheetName,
      dataset.sheets[sheetName],
      dataset.sheetCounts[sheetName],
      dataset,
      theme,
      workbookImageIdByUrl,
      placeholderImageId
    );
  }

  const arrayLike = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.isBuffer(arrayLike) ? arrayLike : Buffer.from(arrayLike);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  return {
    buffer,
    sha256,
    sizeBytes: buffer.length,
    sheetNames: workbook.worksheets.map((s) => s.name),
    dataset,
    embeddedPostersCount,
    placeholderPostersCount,
    missingPosterSourceCount,
    posterErrorsCount: posterErrors.length,
    posterErrors,
  };
}

function populateSummaryWorksheet(
  ws: ExcelJS.Worksheet,
  dataset: ProfileBackupDataset,
  posterStats: {
    embeddedPostersCount: number;
    posterErrorsCount: number;
    missingPosterSourceCount: number;
  }
): void {
  ws.columns = [
    { key: 'pad', width: 3 },
    { key: 'c1', width: 24 },
    { key: 'c2', width: 22 },
    { key: 'c3', width: 22 },
    { key: 'c4', width: 22 },
    { key: 'c5', width: 24 },
    { key: 'padR', width: 3 },
  ];

  // Top Header Banner (Rows 1–2)
  ws.getRow(1).height = 28;
  ws.getRow(2).height = 20;
  for (let col = 2; col <= 6; col += 1) {
    const c1 = ws.getRow(1).getCell(col);
    const c2 = ws.getRow(2).getCell(col);
    c1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    c2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  }
  const titleCell = ws.getCell('B1');
  titleCell.value = 'CineTrack — Kişisel Film & Dizi Arşivi Özeti';
  titleCell.font = { name: FONT_FAMILY, size: 15, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' };

  const subBannerCell = ws.getCell('B2');
  subBannerCell.value = sanitizeSpreadsheetText(
    `Profil: ${dataset.profileName} (${dataset.profileId})  ·  Yedek Tarihi: ${dataset.exportedAtFormatted} UTC  ·  Şema Sürümü: v${dataset.schemaVersion} (${dataset.engineVersion})`
  );
  subBannerCell.font = { name: FONT_FAMILY, size: 9.5, color: { argb: 'FFCBD5E1' } };
  subBannerCell.alignment = { vertical: 'middle', horizontal: 'left' };

  ws.getRow(3).height = 10;

  // Section 1: Genel Profil ve Yedek Bilgileri (Rows 4–8)
  const metaHeaderRow = ws.getRow(4);
  metaHeaderRow.height = 24;
  for (let col = 2; col <= 6; col += 1) {
    const cell = metaHeaderRow.getCell(col);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    cell.font = { name: FONT_FAMILY, size: 10.5, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  }
  ws.getCell('B4').value = 'GENEL PROFİL VE ARŞİV ÖZETİ';

  const topKpis: Array<Array<{ label: string; value: string | number; accent?: string }>> = [
    [
      { label: 'Profil Adı', value: sanitizeSpreadsheetText(dataset.profileName) || 'Profilim' },
      { label: 'Profil Kimliği', value: sanitizeSpreadsheetText(dataset.profileId) || 'profile-default' },
      { label: 'Oluşturma Tarihi', value: `${dataset.exportedAtFormatted} UTC` },
      { label: 'Veri Şema Sürümü', value: `v${dataset.schemaVersion} (${dataset.engineVersion})` },
      { label: 'Favori Oyuncu Sayısı', value: dataset.favoriteActorsCount },
    ],
    [
      { label: 'Toplam İçerik Kaydı', value: dataset.totalItemsCount, accent: 'FF0F172A' },
      { label: 'Toplam Film', value: dataset.totalMovieCount, accent: 'FF1D4ED8' },
      { label: 'Toplam Dizi', value: dataset.totalTvCount, accent: 'FF6D28D9' },
      {
        label: 'Gömülü Poster Sayısı',
        value: posterStats.embeddedPostersCount,
        accent: 'FF15803D',
      },
      {
        label: 'Poster İndirme Hatası',
        value: posterStats.posterErrorsCount,
        accent: posterStats.posterErrorsCount > 0 ? 'FFBE123C' : 'FF475569',
      },
    ],
  ];

  let curRow = 5;
  for (const rowGroup of topKpis) {
    const labelR = ws.getRow(curRow);
    const valR = ws.getRow(curRow + 1);
    labelR.height = 18;
    valR.height = 24;
    rowGroup.forEach((kpi, idx) => {
      const col = idx + 2;
      const lCell = labelR.getCell(col);
      const vCell = valR.getCell(col);
      lCell.value = kpi.label;
      lCell.font = { name: FONT_FAMILY, size: 8.5, bold: true, color: { argb: 'FF64748B' } };
      lCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      lCell.alignment = { vertical: 'bottom', horizontal: 'left' };
      lCell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };

      vCell.value = kpi.value;
      vCell.font = {
        name: FONT_FAMILY,
        size: typeof kpi.value === 'number' ? 12 : 10,
        bold: true,
        color: { argb: kpi.accent || 'FF0F172A' },
      };
      vCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
      vCell.alignment = { vertical: 'middle', horizontal: 'left' };
      vCell.border = {
        bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };
      if (typeof kpi.value === 'number') {
        vCell.numFmt = '#,##0';
      }
    });
    curRow += 2;
  }

  ws.getRow(curRow).height = 12;
  curRow += 1;

  // Middle Section: 4 List Summary Blocks (İzlenen, İzlenecek, İzleniyor, İlgilenmiyorum)
  const cardsHeader = ws.getRow(curRow);
  cardsHeader.height = 24;
  for (let col = 2; col <= 6; col += 1) {
    const cell = cardsHeader.getCell(col);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    cell.font = { name: FONT_FAMILY, size: 10.5, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  }
  cardsHeader.getCell(2).value = 'LİSTE DURUMLARINA GÖRE DAĞILIM KARTLARI';
  curRow += 1;

  const cardDefs: Array<{
    sheet: ContentSheetName;
    col: number;
    headerBg: string;
    bodyBg: string;
    textHex: string;
    borderHex: string;
  }> = [
    {
      sheet: 'İzlenen',
      col: 2,
      headerBg: 'FF15803D',
      bodyBg: 'FFF0FDF4',
      textHex: 'FF14532D',
      borderHex: 'FF86EFAC',
    },
    {
      sheet: 'İzlenecek',
      col: 3,
      headerBg: 'FF1D4ED8',
      bodyBg: 'FFEFF6FF',
      textHex: 'FF1E3A8A',
      borderHex: 'FF93C5FD',
    },
    {
      sheet: 'İzleniyor',
      col: 4,
      headerBg: 'FFC2410C',
      bodyBg: 'FFFFF7ED',
      textHex: 'FF7C2D12',
      borderHex: 'FFFDBA74',
    },
    {
      sheet: 'İlgilenmiyorum',
      col: 5,
      headerBg: 'FF9F1239',
      bodyBg: 'FFFFF1F2',
      textHex: 'FF881337',
      borderHex: 'FFFDA4AF',
    },
  ];

  const rCardTitle = ws.getRow(curRow);
  const rCardTotal = ws.getRow(curRow + 1);
  const rCardMovies = ws.getRow(curRow + 2);
  const rCardTv = ws.getRow(curRow + 3);
  rCardTitle.height = 24;
  rCardTotal.height = 28;
  rCardMovies.height = 20;
  rCardTv.height = 20;

  for (const card of cardDefs) {
    const counts = dataset.sheetCounts[card.sheet];
    const cTitle = rCardTitle.getCell(card.col);
    cTitle.value = card.sheet.toLocaleUpperCase('tr-TR');
    cTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: card.headerBg } };
    cTitle.font = { name: FONT_FAMILY, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cTitle.alignment = { vertical: 'middle', horizontal: 'center' };
    cTitle.border = {
      top: { style: 'thin', color: { argb: card.headerBg } },
      left: { style: 'thin', color: { argb: card.headerBg } },
      right: { style: 'thin', color: { argb: card.headerBg } },
    };

    const cTotal = rCardTotal.getCell(card.col);
    cTotal.value = counts.total;
    cTotal.numFmt = '#,##0" toplam"';
    cTotal.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: card.bodyBg } };
    cTotal.font = { name: FONT_FAMILY, size: 13, bold: true, color: { argb: card.textHex } };
    cTotal.alignment = { vertical: 'middle', horizontal: 'center' };
    cTotal.border = {
      left: { style: 'thin', color: { argb: card.borderHex } },
      right: { style: 'thin', color: { argb: card.borderHex } },
    };

    const cMov = rCardMovies.getCell(card.col);
    cMov.value = counts.movie;
    cMov.numFmt = '#,##0" film"';
    cMov.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    cMov.font = { name: FONT_FAMILY, size: 9.5, bold: false, color: { argb: 'FF334155' } };
    cMov.alignment = { vertical: 'middle', horizontal: 'center' };
    cMov.border = {
      left: { style: 'thin', color: { argb: card.borderHex } },
      right: { style: 'thin', color: { argb: card.borderHex } },
    };

    const cTv = rCardTv.getCell(card.col);
    cTv.value = counts.tv;
    cTv.numFmt = '#,##0" dizi"';
    cTv.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    cTv.font = { name: FONT_FAMILY, size: 9.5, bold: false, color: { argb: 'FF334155' } };
    cTv.alignment = { vertical: 'middle', horizontal: 'center' };
    cTv.border = {
      bottom: { style: 'medium', color: { argb: card.headerBg } },
      left: { style: 'thin', color: { argb: card.borderHex } },
      right: { style: 'thin', color: { argb: card.borderHex } },
    };
  }

  // Column 6: Genel Toplam Doğrulama Kartı (Lacivert/Açık Mavi)
  const cSumTitle = rCardTitle.getCell(6);
  cSumTitle.value = 'GENEL TOPLAM';
  cSumTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  cSumTitle.font = { name: FONT_FAMILY, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
  cSumTitle.alignment = { vertical: 'middle', horizontal: 'center' };

  const cSumTotal = rCardTotal.getCell(6);
  cSumTotal.value = dataset.totalItemsCount;
  cSumTotal.numFmt = '#,##0" kayıt"';
  cSumTotal.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
  cSumTotal.font = { name: FONT_FAMILY, size: 13, bold: true, color: { argb: 'FF0F172A' } };
  cSumTotal.alignment = { vertical: 'middle', horizontal: 'center' };

  const cSumMov = rCardMovies.getCell(6);
  cSumMov.value = dataset.totalMovieCount;
  cSumMov.numFmt = '#,##0" film"';
  cSumMov.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
  cSumMov.font = { name: FONT_FAMILY, size: 9.5, color: { argb: 'FF1E293B' } };
  cSumMov.alignment = { vertical: 'middle', horizontal: 'center' };

  const cSumTv = rCardTv.getCell(6);
  cSumTv.value = dataset.totalTvCount;
  cSumTv.numFmt = '#,##0" dizi"';
  cSumTv.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
  cSumTv.font = { name: FONT_FAMILY, size: 9.5, color: { argb: 'FF1E293B' } };
  cSumTv.alignment = { vertical: 'middle', horizontal: 'center' };
  cSumTv.border = { bottom: { style: 'medium', color: { argb: 'FF0F172A' } } };

  curRow += 4;
  ws.getRow(curRow).height = 14;
  curRow += 1;

  // Bottom Section: Real Derived Statistics (Left: Personal Rating Distribution | Middle: Release Era Distribution | Right: Top Genres)
  const statsBanner = ws.getRow(curRow);
  statsBanner.height = 24;
  for (let col = 2; col <= 6; col += 1) {
    const cell = statsBanner.getCell(col);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    cell.font = { name: FONT_FAMILY, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  }
  statsBanner.getCell(2).value =
    dataset.averagePersonalRating !== null
      ? `KİŞİSEL PUAN DAĞILIMI (Ort: ${dataset.averagePersonalRating}/10 · ${dataset.ratedItemsCount} puanlı)`
      : 'KİŞİSEL PUAN DAĞILIMI';
  statsBanner.getCell(4).value = 'YAYIN DÖNEMİ (ON YIL) DAĞILIMI';
  statsBanner.getCell(6).value = 'EN ÇOK BULUNAN TÜRLER';
  curRow += 1;

  const subHeadRow = ws.getRow(curRow);
  subHeadRow.height = 20;
  const setSubHead = (col: number, label: string, align: 'left' | 'right' = 'left') => {
    const c = subHeadRow.getCell(col);
    c.value = label;
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    c.font = { name: FONT_FAMILY, size: 9, bold: true, color: { argb: 'FF1E293B' } };
    c.alignment = { vertical: 'middle', horizontal: align };
  };
  setSubHead(2, 'Kişisel Puan');
  setSubHead(3, 'İçerik Sayısı', 'right');
  setSubHead(4, 'Dönem');
  setSubHead(5, 'Toplam (Film / Dizi)', 'right');
  setSubHead(6, 'Tür · Kayıt (%Pay)');
  curRow += 1;

  const maxStatsRows = Math.max(
    dataset.personalRatingDistribution.length,
    dataset.decadeDistribution.length,
    dataset.topGenres.length,
    1
  );

  for (let i = 0; i < maxStatsRows; i += 1) {
    const r = ws.getRow(curRow + i);
    r.height = 19;
    const zebra = i % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC';

    // Personal Rating Bucket (Cols 2 & 3)
    const ratingEntry = dataset.personalRatingDistribution[i];
    if (ratingEntry) {
      const cLabel = r.getCell(2);
      const cVal = r.getCell(3);
      cLabel.value = `${ratingEntry.rating} / 10`;
      cLabel.font = { name: FONT_FAMILY, size: 9.5, bold: true, color: { argb: 'FF1E293B' } };
      cLabel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } };
      cLabel.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };

      cVal.value = ratingEntry.count;
      cVal.numFmt = '#,##0';
      cVal.font = { name: FONT_FAMILY, size: 9.5, color: { argb: 'FF0F172A' } };
      cVal.alignment = { vertical: 'middle', horizontal: 'right' };
      cVal.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } };
      cVal.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
    }

    // Decade Bucket (Cols 4 & 5)
    const decEntry = dataset.decadeDistribution[i];
    if (decEntry) {
      const cDec = r.getCell(4);
      const cDecVal = r.getCell(5);
      cDec.value = decEntry.decade;
      cDec.font = { name: FONT_FAMILY, size: 9.5, bold: true, color: { argb: 'FF1E293B' } };
      cDec.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } };
      cDec.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };

      cDecVal.value = `${decEntry.count} (${decEntry.movieCount}F / ${decEntry.tvCount}D)`;
      cDecVal.font = { name: FONT_FAMILY, size: 9.5, color: { argb: 'FF334155' } };
      cDecVal.alignment = { vertical: 'middle', horizontal: 'right' };
      cDecVal.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } };
      cDecVal.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
    } else if (i === 0 && dataset.decadeDistribution.length === 0) {
      r.getCell(4).value = 'Yıl verisi bulunmuyor';
      r.getCell(4).font = { name: FONT_FAMILY, size: 9, italic: true, color: { argb: 'FF64748B' } };
    }

    // Top Genres (Col 6)
    const genreEntry = dataset.topGenres[i];
    if (genreEntry) {
      const cGen = r.getCell(6);
      cGen.value = sanitizeSpreadsheetText(
        `${genreEntry.name} — ${genreEntry.count} kayıt (%${genreEntry.sharePercent})`
      );
      cGen.font = { name: FONT_FAMILY, size: 9.5, color: { argb: 'FF1E293B' } };
      cGen.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } };
      cGen.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
    } else if (i === 0 && dataset.topGenres.length === 0) {
      r.getCell(6).value = 'Tür verisi bulunmuyor';
      r.getCell(6).font = { name: FONT_FAMILY, size: 9, italic: true, color: { argb: 'FF64748B' } };
    }
  }

  if (dataset.dualStateKeys.length > 0) {
    const noteRowIdx = curRow + maxStatsRows + 2;
    const noteCell = ws.getRow(noteRowIdx).getCell(2);
    noteCell.value = sanitizeSpreadsheetText(
      `Bilgi: Veri modelinde hem liste durumuna hem 'İlgilenmiyorum' işaretine sahip ${dataset.dualStateKeys.length} içerik kendi gerçek durumlarında korundu.`
    );
    noteCell.font = { name: FONT_FAMILY, size: 9, italic: true, color: { argb: 'FF475569' } };
  }
}

function populateContentWorksheet(
  ws: ExcelJS.Worksheet,
  sheetName: ContentSheetName,
  rows: ExportRowItem[],
  counts: SheetBreakdownCount,
  dataset: ProfileBackupDataset,
  theme: SheetThemePalette,
  workbookImageIdByUrl: Map<string, number>,
  placeholderImageId: number | null
): void {
  // Set column widths ONLY (do NOT set `header` here so Row 1 stays our sheet title banner without merged cells)
  ws.columns = [
    { key: 'poster', width: 10.5 }, // ~72 px
    { key: 'type', width: 9 }, // FİLM / DİZİ badge
    { key: 'title', width: 33 }, // ~30–35 visible chars, wrapText enabled
    { key: 'year', width: 8.5 },
    { key: 'tmdbRating', width: 12 },
    { key: 'personalRating', width: 13 },
    { key: 'genres', width: 26 },
    { key: 'tmdbId', width: 12 },
    { key: 'addedAt', width: 18 },
    { key: 'userNote', width: 26 },
    { key: 'updatedAt', width: 18 },
    { key: 'progress', width: 22 },
    { key: 'canonicalKey', width: 16 },
  ];

  const totalCols = 13;

  // Row 1: Top Navy Title Bar (unmerged so sorting/filtering never triggers merged-cell errors)
  const titleRow = ws.getRow(1);
  titleRow.height = 26;
  for (let c = 1; c <= totalCols; c += 1) {
    const cell = titleRow.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  }
  titleRow.getCell(1).value = `CineTrack — ${sheetName}`;
  titleRow.getCell(1).font = {
    name: FONT_FAMILY,
    size: 13,
    bold: true,
    color: { argb: 'FFFFFFFF' },
  };
  titleRow.getCell(7).value = sanitizeSpreadsheetText(
    `${theme.subtitle}  ·  Profil: ${dataset.profileName}`
  );
  titleRow.getCell(7).font = {
    name: FONT_FAMILY,
    size: 9.5,
    color: { argb: 'FFCBD5E1' },
  };

  // Row 2: Sheet Record Count Strip (themed green/blue/orange/burgundy tint)
  const infoRow = ws.getRow(2);
  infoRow.height = 20;
  for (let c = 1; c <= totalCols; c += 1) {
    const cell = infoRow.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.softBannerBgHex } };
    cell.border = {
      bottom: { style: 'thin', color: { argb: theme.cardBorderHex } },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  }
  infoRow.getCell(1).value = `Toplam Kayıt: ${counts.total}  (Film: ${counts.movie} · Dizi: ${counts.tv})`;
  infoRow.getCell(1).font = {
    name: FONT_FAMILY,
    size: 9.5,
    bold: true,
    color: { argb: theme.softBannerTextHex },
  };

  // Row 3: Compact visual spacer
  ws.getRow(3).height = 6;

  // Row 4: Frozen Filterable Table Header
  const headerLabels = [
    'Poster',
    'Tür',
    'İçerik Adı',
    'Yıl',
    'TMDB Puanı',
    'Kişisel Puan',
    'Türler / Kategoriler',
    'TMDB ID',
    'Listeye Eklenme Tarihi',
    'Kullanıcı Notu',
    'Son Güncelleme',
    'Süre / İlerleme',
    'Medya Anahtarı',
  ];

  const headerRow = ws.getRow(4);
  headerRow.height = 26;
  headerLabels.forEach((label, idx) => {
    const col = idx + 1;
    const cell = headerRow.getCell(col);
    cell.value = label;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    cell.font = { name: FONT_FAMILY, size: 9.5, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = {
      vertical: 'middle',
      horizontal: col === 3 || col === 7 || col === 10 || col === 12 ? 'left' : 'center',
      wrapText: true,
    };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF0F172A' } },
      bottom: { style: 'medium', color: { argb: theme.headerAccentHex } },
      left: { style: 'thin', color: { argb: 'FF334155' } },
      right: { style: 'thin', color: { argb: 'FF334155' } },
    };
  });

  // Enable real Excel AutoFilter across all columns starting at Row 4
  const lastTableRow = Math.max(4, 4 + rows.length);
  ws.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: lastTableRow, column: totalCols },
  };

  // Data Rows (Row 5+)
  rows.forEach((item, index) => {
    const excelRowNum = 5 + index;
    const row = ws.getRow(excelRowNum);
    // 84 pt = 112 px (~5.6–6 standard Excel rows visually, single data row per item)
    row.height = 84;

    const zebraBg = index % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC';

    // Populate values strictly using null for missing values (never 0, false, "null", or "undefined")
    row.getCell(1).value = null; // Poster image cell
    row.getCell(2).value = item.mediaTypeLabel; // FİLM | DİZİ
    row.getCell(3).value = item.title;
    row.getCell(4).value = item.year;
    row.getCell(5).value = item.tmdbRating;
    row.getCell(6).value = item.personalRating;
    row.getCell(7).value = item.genresText;
    row.getCell(8).value = item.tmdbId === '' ? null : item.tmdbId;
    row.getCell(9).value = item.addedAtFormatted;
    row.getCell(10).value = item.userNote;
    row.getCell(11).value = item.updatedAtFormatted;
    row.getCell(12).value = item.progressOrRuntime;
    row.getCell(13).value = item.canonicalKey;

    for (let col = 1; col <= totalCols; col += 1) {
      const cell = row.getCell(col);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebraBg } };
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFF1F5F9' } },
      };
    }

    // Col 2: Small 7pt colored Tür badge (FİLM vs DİZİ)
    const typeCell = row.getCell(2);
    const isTv = item.mediaType === 'tv';
    typeCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: isTv ? 'FFEDE9FE' : 'FFDBEAFE' },
    };
    typeCell.font = {
      name: FONT_FAMILY,
      size: 7,
      bold: true,
      color: { argb: isTv ? 'FF5B21B6' : 'FF1E40AF' },
    };
    typeCell.alignment = { vertical: 'middle', horizontal: 'center' };

    // Col 3: İçerik Adı — 11pt bold, wrapText: true
    const nameCell = row.getCell(3);
    nameCell.font = { name: FONT_FAMILY, size: 11, bold: true, color: { argb: 'FF0F172A' } };
    nameCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };

    // Col 4: Yıl — 9.5pt
    const yearCell = row.getCell(4);
    yearCell.font = { name: FONT_FAMILY, size: 9.5, color: { argb: 'FF334155' } };
    yearCell.alignment = { vertical: 'middle', horizontal: 'center' };
    if (item.year !== null) yearCell.numFmt = '0';

    // Col 5: TMDB Puanı — 9.5pt
    const tmdbCell = row.getCell(5);
    tmdbCell.font = { name: FONT_FAMILY, size: 9.5, bold: true, color: { argb: 'FF0F172A' } };
    tmdbCell.alignment = { vertical: 'middle', horizontal: 'center' };
    if (item.tmdbRating !== null) tmdbCell.numFmt = '0.0';

    // Col 6: Kişisel Puan — 9.5pt
    const pRatingCell = row.getCell(6);
    pRatingCell.font = {
      name: FONT_FAMILY,
      size: 10,
      bold: true,
      color: { argb: theme.softBannerTextHex },
    };
    pRatingCell.alignment = { vertical: 'middle', horizontal: 'center' };
    if (item.personalRating !== null) pRatingCell.numFmt = '0';

    // Col 7: Türler / Kategoriler — 9.5pt wrapText
    const genresCell = row.getCell(7);
    genresCell.font = { name: FONT_FAMILY, size: 9.5, color: { argb: 'FF334155' } };
    genresCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };

    // Col 8: TMDB ID — 9.5pt
    const idCell = row.getCell(8);
    idCell.font = { name: FONT_FAMILY, size: 9.5, color: { argb: 'FF475569' } };
    idCell.alignment = { vertical: 'middle', horizontal: 'center' };
    if (typeof item.tmdbId === 'number') idCell.numFmt = '0';

    // Col 9: Listeye Eklenme Tarihi — 9.5pt
    const addedCell = row.getCell(9);
    addedCell.font = { name: FONT_FAMILY, size: 9.5, color: { argb: 'FF475569' } };
    addedCell.alignment = { vertical: 'middle', horizontal: 'center' };

    // Col 10: Kullanıcı Notu — 9.5pt wrapText
    const noteCell = row.getCell(10);
    noteCell.font = { name: FONT_FAMILY, size: 9.5, color: { argb: 'FF334155' } };
    noteCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };

    // Col 11: Son Güncelleme — 9.5pt
    const updCell = row.getCell(11);
    updCell.font = { name: FONT_FAMILY, size: 9.5, color: { argb: 'FF64748B' } };
    updCell.alignment = { vertical: 'middle', horizontal: 'center' };

    // Col 12: Süre / İlerleme — 9.5pt wrapText
    const progCell = row.getCell(12);
    progCell.font = { name: FONT_FAMILY, size: 9.5, color: { argb: 'FF334155' } };
    progCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };

    // Col 13: Medya Anahtarı — 9pt
    const keyCell = row.getCell(13);
    keyCell.font = { name: FONT_FAMILY, size: 9, color: { argb: 'FF64748B' } };
    keyCell.alignment = { vertical: 'middle', horizontal: 'center' };

    // Embed Poster Image inside Col 1 (0-based row index = excelRowNum - 1)
    let targetImgId: number | undefined;
    if (item.posterUrl && workbookImageIdByUrl.has(item.posterUrl)) {
      targetImgId = workbookImageIdByUrl.get(item.posterUrl);
    } else if (placeholderImageId !== null) {
      targetImgId = placeholderImageId;
    }

    if (targetImgId !== undefined) {
      const zeroRow = excelRowNum - 1;
      // Anchor strictly within cell A<excelRowNum> with subtle padding (~65x102 px, 2:3 ratio)
      // so Excel sorting and AutoFilter move/hide posters together with their row.
      ws.addImage(targetImgId, {
        tl: { col: 0.06, row: zeroRow + 0.045 } as any,
        br: { col: 0.94, row: zeroRow + 0.955 } as any,
        editAs: 'twoCell',
      });
    }
  });
}

export interface ExecuteProfileBackupOptions {
  dataDir: string;
  document: DataDocument;
  profileId?: string;
  includeJson?: boolean;
  includeXlsx?: boolean;
  uploadToGithub?: boolean;
  allowPersonalDataInPublicRepo?: boolean;
  dislikedItemsHint?: Array<Record<string, any>>;
  genresMap?: Record<number, string>;
  persistentStore?: PersistentDataStore;
  tmdbApiKey?: string;
  githubTokenForRedaction?: string;
  now?: Date;
  posterFetcher?: PosterFetcherFn;
  posterTimeoutMs?: number;
  posterConcurrency?: number;
  forceExcelErrorForTest?: string;
}

/**
 * Orchestrates JSON backup + Embedded-Poster Excel (.xlsx) backup + optional GitHub upload
 * with strict error isolation so failure in one target never invalidates another.
 */
export async function executeProfileBackupExport(
  options: ExecuteProfileBackupOptions
): Promise<ProfileBackupExecutionReport> {
  const now = options.now || new Date();
  const exportedAt = now.toISOString();
  const includeJson = options.includeJson ?? true;
  const includeXlsx = options.includeXlsx ?? true;
  const uploadToGithub = options.uploadToGithub ?? false;
  const exportsDir = path.join(options.dataDir, 'exports');
  const posterCacheDir = path.join(options.dataDir, 'cache', 'posters');
  const baseName = formatExportBaseName(now);

  const profiles = Array.isArray(options.document?.profiles) ? options.document.profiles : [];
  const targetId = options.profileId || options.document?.activeProfileId || 'profile-default';
  const foundProfile =
    profiles.find((p) => p && p.id === targetId) ||
    profiles[0] || {
      id: targetId,
      name: 'Profilim',
      createdAt: exportedAt,
      preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
      items: [],
      favoriteActors: [],
      isDemo: false,
    };

  const jsonBackup: SingleFileExportOutcome = {
    attempted: includeJson,
    ok: false,
  };

  const excelBackup: ProfileBackupExecutionReport['excelBackup'] = {
    attempted: includeXlsx,
    ok: false,
  };

  let githubUpload: GitHubExcelUploadOutcome = {
    attempted: uploadToGithub,
    ok: false,
    verifiedReadBack: false,
  };

  // 1. JSON Backup (Primary Lossless Format — isolated try/catch)
  if (includeJson) {
    try {
      const { fileName, fullPath } = resolveUniqueExportFileName(exportsDir, baseName, 'json');
      const jsonPayload = {
        version: 3,
        schemaVersion: options.document?.schemaVersion || CURRENT_SCHEMA_VERSION,
        engineVersion: options.document?.engineVersion || ENGINE_VERSION,
        profileId: foundProfile.id,
        profileName: foundProfile.name,
        items: foundProfile.items || [],
        preferences: foundProfile.preferences || {
          disliked: [],
          providers: [],
          mood: '',
          reminders: false,
          notified: [],
        },
        favoriteActors: foundProfile.favoriteActors || [],
        isDemo: Boolean(foundProfile.isDemo),
        exportedAt,
      };
      const serialized = JSON.stringify(jsonPayload, null, 2);
      const buf = Buffer.from(serialized, 'utf8');
      writeFileSync(fullPath, buf);
      jsonBackup.ok = true;
      jsonBackup.fileName = fileName;
      jsonBackup.relativePath = `data/exports/${fileName}`;
      jsonBackup.absolutePath = fullPath;
      jsonBackup.downloadUrl = `/api/backup/exports/${encodeURIComponent(fileName)}`;
      jsonBackup.sizeBytes = buf.length;
      jsonBackup.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    } catch (err: any) {
      jsonBackup.ok = false;
      jsonBackup.error = redactSecrets(
        err?.message || 'JSON profil yedeği oluşturulamadı.',
        [options.githubTokenForRedaction]
      );
    }
  }

  // 2. Excel (.xlsx) Backup (Secondary Formatted Archive — isolated try/catch)
  let generatedExcelBuffer: Buffer | null = null;
  let generatedExcelFileName: string | null = null;

  if (includeXlsx) {
    try {
      if (options.forceExcelErrorForTest) {
        throw new Error(options.forceExcelErrorForTest);
      }

      const moviesCatalog = options.persistentStore
        ? options.persistentStore.readCatalog('movie')
        : {};
      const tvCatalog = options.persistentStore
        ? options.persistentStore.readCatalog('tv')
        : {};

      const tmdbKey = options.tmdbApiKey?.trim() || '';
      const fetchMissingTmdbItem: TmdbItemFetcherFn | undefined = tmdbKey
        ? async (mediaType, id) => {
            const url = new URL(`https://api.themoviedb.org/3/${mediaType}/${id}`);
            url.searchParams.set('language', 'tr-TR');
            if (!tmdbKey.startsWith('eyJ')) {
              url.searchParams.set('api_key', tmdbKey);
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);
            try {
              const res = await fetch(url.toString(), {
                signal: controller.signal,
                headers: tmdbKey.startsWith('eyJ')
                  ? { Authorization: `Bearer ${tmdbKey}`, Accept: 'application/json' }
                  : { Accept: 'application/json' },
              });
              if (res.status !== 200) return null;
              return (await res.json()) as Record<string, any>;
            } catch {
              return null;
            } finally {
              clearTimeout(timer);
            }
          }
        : undefined;

      const built = await generateProfileExcelBuffer({
        profile: foundProfile,
        schemaVersion: options.document?.schemaVersion || CURRENT_SCHEMA_VERSION,
        engineVersion: options.document?.engineVersion || ENGINE_VERSION,
        exportedAt: now,
        moviesCatalog,
        tvCatalog,
        dislikedItemsHint: options.dislikedItemsHint,
        genresMap: options.genresMap,
        posterCacheDir,
        posterFetcher: options.posterFetcher,
        posterTimeoutMs: options.posterTimeoutMs,
        posterConcurrency: options.posterConcurrency,
        fetchMissingTmdbItem,
        onNewlyFetchedCatalogItems: (items) => {
          if (options.persistentStore && items.length > 0) {
            options.persistentStore.upsertCatalogItems(items);
          }
        },
      });

      const { fileName, fullPath } = resolveUniqueExportFileName(exportsDir, baseName, 'xlsx');
      writeFileSync(fullPath, built.buffer);

      generatedExcelBuffer = built.buffer;
      generatedExcelFileName = fileName;

      excelBackup.ok = true;
      excelBackup.fileName = fileName;
      excelBackup.relativePath = `data/exports/${fileName}`;
      excelBackup.absolutePath = fullPath;
      excelBackup.downloadUrl = `/api/backup/exports/${encodeURIComponent(fileName)}`;
      excelBackup.sizeBytes = built.sizeBytes;
      excelBackup.sha256 = built.sha256;
      excelBackup.sheetNames = built.sheetNames;
      excelBackup.sheetCounts = built.dataset.sheetCounts;
      excelBackup.totalItemsCount = built.dataset.totalItemsCount;
      excelBackup.movieCount = built.dataset.totalMovieCount;
      excelBackup.tvCount = built.dataset.totalTvCount;
      excelBackup.embeddedPostersCount = built.embeddedPostersCount;
      excelBackup.placeholderPostersCount = built.placeholderPostersCount;
      excelBackup.missingPosterSourceCount = built.missingPosterSourceCount;
      excelBackup.posterErrorsCount = built.posterErrorsCount;
      excelBackup.posterErrors = built.posterErrors;
      excelBackup.dualStateKeys = built.dataset.dualStateKeys;
    } catch (err: any) {
      excelBackup.ok = false;
      excelBackup.error = redactSecrets(
        err?.message || 'Excel (.xlsx) profil yedeği oluşturulamadı.',
        [options.githubTokenForRedaction]
      );
    }
  }

  // 3. Optional GitHub Binary Upload & Read-Back SHA-256 Verification (isolated try/catch)
  if (uploadToGithub) {
    if (!generatedExcelBuffer || !generatedExcelFileName) {
      githubUpload = {
        attempted: true,
        ok: false,
        verifiedReadBack: false,
        error: 'Excel dosyası oluşturulamadığı için GitHub yüklemesi atlandı.',
      };
    } else if (!options.persistentStore) {
      githubUpload = {
        attempted: true,
        ok: false,
        verifiedReadBack: false,
        error: 'Kalıcı veri deposu (PersistentDataStore) bağlı değil.',
      };
    } else {
      try {
        githubUpload = await options.persistentStore.uploadBinaryBackupToGitHub({
          fileName: generatedExcelFileName,
          contentBuffer: generatedExcelBuffer,
          allowPersonalDataInPublicRepo: options.allowPersonalDataInPublicRepo,
        });
      } catch (err: any) {
        githubUpload = {
          attempted: true,
          ok: false,
          verifiedReadBack: false,
          error: redactSecrets(
            err?.message || 'Excel yedeği GitHub deposuna yüklenemedi.',
            [options.githubTokenForRedaction]
          ),
        };
      }
    }
  }

  const targetOutcomes = [
    ...(includeJson ? [jsonBackup.ok] : []),
    ...(includeXlsx ? [excelBackup.ok] : []),
    ...(uploadToGithub ? [githubUpload.ok] : []),
  ];
  const anySucceeded = targetOutcomes.some(Boolean);
  const allSucceeded = targetOutcomes.length > 0 && targetOutcomes.every(Boolean);

  return {
    ok: allSucceeded,
    partialFailure: anySucceeded && !allSucceeded,
    exportedAt,
    profileId: foundProfile.id,
    profileName: foundProfile.name,
    jsonBackup,
    excelBackup,
    githubUpload,
  };
}

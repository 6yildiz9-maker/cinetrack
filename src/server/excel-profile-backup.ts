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

export interface SourceCompletenessDiagnostics {
  rawProfileItemsCount: number;
  normalizedSavedItemsCount: number;
  rawDislikedCount: number;
  uniqueDislikedCount: number;
  sourceCountsByList: {
    completed: number;
    watchlist: number;
    watching: number;
    disliked: number;
  };
  sourceMovieCount: number;
  sourceTvCount: number;
  recordsSentToExcelCount: number;
  writtenRowsBySheet: Record<ContentSheetName, number>;
  itemsWithPosterUrlCount: number;
  uniquePosterUrlsCount: number;
  downloadedOrCachedPostersCount: number;
  embeddedPostersCount: number;
  placeholderPostersCount: number;
  skippedOrFailedPostersCount: number;
}

export interface XlsxPackageInspection {
  validZip: boolean;
  validOpenXmlStructure: boolean;
  sizeBytes: number;
  sha256: string;
  sheetNames: string[];
  worksheetDataRowCounts: Record<string, number>;
  mediaFilesCount: number;
  mediaTotalCompressedBytes: number;
  mediaTotalUncompressedBytes: number;
  minMediaSourceWidthPx: number | null;
  maxMediaSourceWidthPx: number | null;
  minMediaSourceHeightPx: number | null;
  maxMediaSourceHeightPx: number | null;
  drawingFilesCount: number;
  totalOneCellAnchors: number;
  totalTwoCellAnchors: number;
  totalImageAnchors: number;
  totalBlipEmbeds: number;
  totalDrawingRelationships: number;
  posterColumnWidthChars: number | null;
  posterColumnRenderedWidthPx: number | null;
  dataRowHeightPt: number | null;
  dataRowRenderedHeightPx: number | null;
  minRenderedWidthPx: number | null;
  maxRenderedWidthPx: number | null;
  minRenderedHeightPx: number | null;
  maxRenderedHeightPx: number | null;
  allAnchorsInPosterColumn: boolean;
  allAnchorsRowAligned: boolean;
  anyThinStripAnchor: boolean;
}

export interface ProfileBackupDataset {
  profileId: string;
  profileName: string;
  schemaVersion: number;
  engineVersion: string;
  exportedAtIso: string;
  exportedAtFormatted: string;
  rawProfileItemsCount: number;
  normalizedSavedItemsCount: number;
  rawDislikedCount: number;
  uniqueDislikedCount: number;
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
  sourceDiagnostics: SourceCompletenessDiagnostics;
  packageInspection: XlsxPackageInspection;
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
    sourceDiagnostics?: SourceCompletenessDiagnostics;
    packageInspection?: XlsxPackageInspection;
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

export interface ImageDimensions {
  width: number;
  height: number;
  format: 'jpeg' | 'png' | 'gif';
}

/**
 * Pure binary header parser for JPEG (SOF0..SOF15), PNG (IHDR), and GIF (Logical Screen Descriptor).
 * Verifies real source pixel dimensions before embedding into Excel so tiny/corrupt slivers are caught
 * and true aspect ratios are preserved without stretching.
 */
export function readImageDimensions(buffer: Buffer): ImageDimensions | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null;

  // PNG: 8-byte signature + 4-byte length + 'IHDR' + 4-byte width + 4-byte height
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width > 0 && height > 0) {
      return { width, height, format: 'png' };
    }
    return null;
  }

  // GIF87a / GIF89a: width & height at bytes 6..10 (uint16 LE)
  if (
    buffer.length >= 10 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    if (width > 0 && height > 0) {
      return { width, height, format: 'gif' };
    }
    return null;
  }

  // JPEG: walk markers from SOI (FF D8) until SOF marker (C0..C3, C5..C7, C9..CB, CD..CF)
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < buffer.length && buffer[offset] === 0xff) {
        offset += 1;
      }
      if (offset >= buffer.length) break;
      const marker = buffer[offset];
      offset += 1;

      // Standalone markers without length payload
      if (
        marker === 0xd8 ||
        marker === 0xd9 ||
        (marker >= 0xd0 && marker <= 0xd7) ||
        marker === 0x01
      ) {
        continue;
      }
      if (offset + 2 > buffer.length) break;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) break;

      const isSofMarker =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSofMarker) {
        if (offset + 7 <= buffer.length) {
          const height = buffer.readUInt16BE(offset + 3);
          const width = buffer.readUInt16BE(offset + 5);
          if (width > 0 && height > 0) {
            return { width, height, format: 'jpeg' };
          }
        }
        return null;
      }
      offset += segmentLength;
    }
  }

  return null;
}

/**
 * OpenXML / Excel 96-DPI DrawingML & SpreadsheetML measurement constants.
 * - 1 inch = 914,400 EMU = 96 pixels = 72 points
 * - 1 pixel (at 96 DPI) = 9,525 EMU = 0.75 points (matches ExcelJS ExtXform EMU_PER_PIXEL_AT_96_DPI)
 * - 1 point = 12,700 EMU = 4/3 pixels
 */
export const EMU_PER_PIXEL = 9525;
export const EMU_PER_POINT = 12700;
export const CALIBRI_11_MDW_PX = 7;
export const MIN_VALID_POSTER_DIMENSION_PX = 16;

export const POSTER_TARGET_WIDTH_PX = 72;
export const POSTER_TARGET_HEIGHT_PX = 108;
export const POSTER_CELL_PADDING_X_PX = 2;
export const POSTER_CELL_PADDING_Y_PX = 2;
export const POSTER_CELL_WIDTH_PX = POSTER_TARGET_WIDTH_PX + POSTER_CELL_PADDING_X_PX * 2; // 76 px (72 px poster + 2px left/right margin)
export const POSTER_CELL_HEIGHT_PX = POSTER_TARGET_HEIGHT_PX + POSTER_CELL_PADDING_Y_PX * 2; // 112 px (108 px poster + 2px top/bottom margin)

export function pixelsToPoints(pixels: number): number {
  return Math.round(((pixels * 72) / 96) * 100) / 100;
}

export function pointsToPixels(points: number): number {
  return Math.round((points * 96) / 72);
}

export const POSTER_ROW_HEIGHT_PT = pixelsToPoints(POSTER_CELL_HEIGHT_PX); // 84 pt (81 pt = 108 px poster + 3 pt = 4 px margin)

/**
 * Converts an OpenXML `<col width="W"/>` character-width value into Excel's rendered pixel width
 * per ECMA-376 Part 1 §18.3.1.13 (using Calibri 11pt MDW = 7 px at 96 DPI).
 */
export function excelColumnWidthToPixels(xmlWidth: number, mdw = CALIBRI_11_MDW_PX): number {
  if (!Number.isFinite(xmlWidth) || xmlWidth <= 0) return 0;
  return Math.trunc(((256 * xmlWidth + Math.trunc(128 / mdw)) / 256) * mdw);
}

/**
 * Converts a target pixel width into an OpenXML `<col width="W"/>` value that Excel renders
 * at the exact requested pixel width (ECMA-376 Part 1 §18.3.1.13).
 */
export function pixelsToExcelColumnWidth(targetPixels: number, mdw = CALIBRI_11_MDW_PX): number {
  const desiredPx = Math.max(1, Math.round(targetPixels));
  const rawUnits = Math.ceil((desiredPx / mdw) * 256 - Math.trunc(128 / mdw));
  let candidate = Math.round((rawUnits / 256) * 100) / 100;
  while (excelColumnWidthToPixels(candidate, mdw) < desiredPx) {
    candidate = Math.round((candidate + 0.01) * 100) / 100;
  }
  while (
    candidate > 0.02 &&
    excelColumnWidthToPixels(Math.round((candidate - 0.01) * 100) / 100, mdw) >= desiredPx
  ) {
    candidate = Math.round((candidate - 0.01) * 100) / 100;
  }
  return candidate;
}

export interface PosterCellPlacement {
  widthPx: number;
  heightPx: number;
  cxEmu: number;
  cyEmu: number;
  leftOffsetPx: number;
  topOffsetPx: number;
  colOffEmu: number;
  rowOffEmu: number;
  aspectRatio: number;
}

/**
 * Fits a poster with source dimensions `(srcWidth, srcHeight)` proportionally inside
 * the `72 × 108 px` target box without stretching or squishing, centered inside the poster cell.
 */
export function computePosterPlacement(
  srcWidth: number,
  srcHeight: number,
  cellWidthPx = POSTER_CELL_WIDTH_PX,
  cellHeightPx = POSTER_CELL_HEIGHT_PX,
  targetWidthPx = POSTER_TARGET_WIDTH_PX,
  targetHeightPx = POSTER_TARGET_HEIGHT_PX
): PosterCellPlacement {
  const safeSrcW =
    Number.isFinite(srcWidth) && srcWidth > 0 ? srcWidth : targetWidthPx;
  const safeSrcH =
    Number.isFinite(srcHeight) && srcHeight > 0 ? srcHeight : targetHeightPx;

  const scale = Math.min(targetWidthPx / safeSrcW, targetHeightPx / safeSrcH);
  const widthPx = Math.max(1, Math.round(safeSrcW * scale * 100) / 100);
  const heightPx = Math.max(1, Math.round(safeSrcH * scale * 100) / 100);

  const leftOffsetPx = Math.max(0, Math.round(((cellWidthPx - widthPx) / 2) * 100) / 100);
  const topOffsetPx = Math.max(0, Math.round(((cellHeightPx - heightPx) / 2) * 100) / 100);

  const cxEmu = Math.floor(widthPx * EMU_PER_PIXEL);
  const cyEmu = Math.floor(heightPx * EMU_PER_PIXEL);
  const colOffEmu = Math.round(leftOffsetPx * EMU_PER_PIXEL);
  const rowOffEmu = Math.round(topOffsetPx * EMU_PER_PIXEL);

  return {
    widthPx,
    heightPx,
    cxEmu,
    cyEmu,
    leftOffsetPx,
    topOffsetPx,
    colOffEmu,
    rowOffEmu,
    aspectRatio: Math.round((widthPx / heightPx) * 10000) / 10000,
  };
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
 * Generates a crisp, neutral CineTrack 2:3 dark-slate placeholder PNG (144x216 px — 2x retina for 72x108 px)
 * using pure Node.js built-ins (no native dependencies).
 */
export function getNeutralPosterPlaceholderPng(): Buffer {
  if (cachedPlaceholderPng) return cachedPlaceholderPng;
  const width = 144;
  const height = 216;
  // RGB color type (2), 8-bit depth
  const rowStride = 1 + width * 3;
  const raw = Buffer.alloc(rowStride * height);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowStride;
    raw[rowStart] = 0; // Filter type 0 (None)
    for (let x = 0; x < width; x += 1) {
      const px = rowStart + 1 + x * 3;
      const isOuterBorder = x <= 2 || x >= width - 3 || y <= 2 || y >= height - 3;
      const isInnerIconFrame =
        x >= 44 &&
        x <= 99 &&
        y >= 74 &&
        y <= 141 &&
        (x <= 45 || x >= 98 || y <= 75 || y >= 140 || (y >= 90 && y <= 91) || (y >= 124 && y <= 125));
      const isFilmSprocket =
        (x === 52 || x === 53 || x === 90 || x === 91) && y >= 78 && y <= 137 && y % 10 <= 3;

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
  private memoryCache = new Map<
    string,
    { buffer: Buffer; extension: 'jpeg' | 'png' | 'gif'; width: number; height: number }
  >();

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

  public readCached(
    url: string
  ): { buffer: Buffer; extension: 'jpeg' | 'png' | 'gif'; width: number; height: number } | null {
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
        const dims = readImageDimensions(buf);
        if (
          detected &&
          dims &&
          dims.width >= MIN_VALID_POSTER_DIMENSION_PX &&
          dims.height >= MIN_VALID_POSTER_DIMENSION_PX
        ) {
          const entry = {
            buffer: buf,
            extension: detected,
            width: dims.width,
            height: dims.height,
          };
          this.memoryCache.set(url, entry);
          return entry;
        }
      } catch {
        // Ignore unreadable cache entry and refetch
      }
    }
    return null;
  }

  public writeCached(
    url: string,
    buffer: Buffer,
    extension: 'jpeg' | 'png' | 'gif',
    width: number,
    height: number
  ): void {
    this.memoryCache.set(url, { buffer, extension, width, height });
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

  // Fetch missing or incomplete disliked metadata via TMDB if available
  const fetchedDislikedMap = new Map<string, Record<string, any>>();
  const newlyFetchedForCatalog: Array<Record<string, any>> = [];
  if (options.fetchMissingTmdbItem) {
    const hasRichGenres = (rec: Record<string, any> | undefined): boolean => {
      if (!rec) return false;
      if (Array.isArray(rec.genre_ids) && rec.genre_ids.length > 0) return true;
      if (Array.isArray(rec.genres) && rec.genres.length > 0) return true;
      return false;
    };
    const hasPoster = (rec: Record<string, any> | undefined): boolean =>
      Boolean(rec && (rec.poster_path || rec.poster_url));

    const keysToFetch = uniqueDislikedNewestFirst.filter((key) => {
      const saved = savedByKey.get(key);
      if (saved && hasPoster(saved) && hasRichGenres(saved)) return false;
      const hint = hintByKey.get(key);
      if (hint && hasPoster(hint) && hasRichGenres(hint)) return false;
      const parsed = parseMediaKey(key);
      if (!parsed || !/^\d+$/.test(String(parsed.id))) return false;
      const cat = parsed.type === 'tv' ? tvCatalog[key] : moviesCatalog[key];
      return !cat || !hasPoster(cat) || !hasRichGenres(cat);
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

  const rawDislikedCount = Array.isArray(options.profile.preferences?.disliked)
    ? options.profile.preferences.disliked.length
    : 0;

  return {
    profileId: String(options.profile.id || 'profile-default'),
    profileName: String(options.profile.name || 'Profilim'),
    schemaVersion: options.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    engineVersion: options.engineVersion ?? ENGINE_VERSION,
    exportedAtIso,
    exportedAtFormatted,
    rawProfileItemsCount: rawItemsClone.length,
    normalizedSavedItemsCount: normalizedItems.length,
    rawDislikedCount,
    uniqueDislikedCount: uniqueDislikedNewestFirst.length,
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

/**
 * Inspects the raw ZIP Central Directory and OpenXML entries of a `.xlsx` binary buffer
 * without trusting file extensions or high-level metadata.
 */
export function inspectXlsxPackageBuffer(buffer: Buffer): XlsxPackageInspection {
  const sha256 = Buffer.isBuffer(buffer)
    ? crypto.createHash('sha256').update(buffer).digest('hex')
    : '';
  const emptyResult: XlsxPackageInspection = {
    validZip: false,
    validOpenXmlStructure: false,
    sizeBytes: Buffer.isBuffer(buffer) ? buffer.length : 0,
    sha256,
    sheetNames: [],
    worksheetDataRowCounts: {},
    mediaFilesCount: 0,
    mediaTotalCompressedBytes: 0,
    mediaTotalUncompressedBytes: 0,
    minMediaSourceWidthPx: null,
    maxMediaSourceWidthPx: null,
    minMediaSourceHeightPx: null,
    maxMediaSourceHeightPx: null,
    drawingFilesCount: 0,
    totalOneCellAnchors: 0,
    totalTwoCellAnchors: 0,
    totalImageAnchors: 0,
    totalBlipEmbeds: 0,
    totalDrawingRelationships: 0,
    posterColumnWidthChars: null,
    posterColumnRenderedWidthPx: null,
    dataRowHeightPt: null,
    dataRowRenderedHeightPx: null,
    minRenderedWidthPx: null,
    maxRenderedWidthPx: null,
    minRenderedHeightPx: null,
    maxRenderedHeightPx: null,
    allAnchorsInPosterColumn: true,
    allAnchorsRowAligned: true,
    anyThinStripAnchor: false,
  };

  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 22 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    buffer[2] !== 0x03 ||
    buffer[3] !== 0x04
  ) {
    return emptyResult;
  }

  let eocdOffset = -1;
  const minSearchOffset = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minSearchOffset; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    return emptyResult;
  }

  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (cdOffset + cdSize > buffer.length) {
    return emptyResult;
  }

  interface ZipEntryMeta {
    name: string;
    compMethod: number;
    compSize: number;
    uncompSize: number;
    localHeaderOffset: number;
  }

  const entries = new Map<string, ZipEntryMeta>();
  let ptr = cdOffset;
  while (ptr + 46 <= cdOffset + cdSize) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) break;
    const compMethod = buffer.readUInt16LE(ptr + 10);
    const compSize = buffer.readUInt32LE(ptr + 20);
    const uncompSize = buffer.readUInt32LE(ptr + 24);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localHeaderOffset = buffer.readUInt32LE(ptr + 42);
    const name = buffer.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    entries.set(name, { name, compMethod, compSize, uncompSize, localHeaderOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }

  const extractBuffer = (entry: ZipEntryMeta | undefined): Buffer | null => {
    if (!entry) return null;
    try {
      const lh = entry.localHeaderOffset;
      if (lh + 30 > buffer.length || buffer.readUInt32LE(lh) !== 0x04034b50) return null;
      const nLen = buffer.readUInt16LE(lh + 26);
      const exLen = buffer.readUInt16LE(lh + 28);
      const start = lh + 30 + nLen + exLen;
      const raw = buffer.subarray(start, start + entry.compSize);
      return entry.compMethod === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    } catch {
      return null;
    }
  };

  const extractUtf8 = (entry: ZipEntryMeta | undefined): string | null => {
    const inflated = extractBuffer(entry);
    return inflated ? inflated.toString('utf8') : null;
  };

  const hasContentTypes = entries.has('[Content_Types].xml');
  const workbookXml = extractUtf8(entries.get('xl/workbook.xml'));
  const workbookRelsXml = extractUtf8(entries.get('xl/_rels/workbook.xml.rels'));

  const relTargetById = new Map<string, string>();
  if (workbookRelsXml) {
    const relTagRe = /<Relationship\b[^>]*>/g;
    let relMatch: RegExpExecArray | null;
    while ((relMatch = relTagRe.exec(workbookRelsXml)) !== null) {
      const tag = relMatch[0];
      const idM = /\bId="([^"]+)"/.exec(tag);
      const targetM = /\bTarget="([^"]+)"/.exec(tag);
      if (idM && targetM) {
        const normalizedTarget = targetM[1].replace(/^\/+/, '');
        const fullTarget = normalizedTarget.startsWith('xl/')
          ? normalizedTarget
          : `xl/${normalizedTarget}`;
        relTargetById.set(idM[1], fullTarget);
      }
    }
  }

  const sheetNames: string[] = [];
  const worksheetDataRowCounts: Record<string, number> = {};
  let posterColumnWidthChars: number | null = null;
  let posterColumnRenderedWidthPx: number | null = null;
  let dataRowHeightPt: number | null = null;
  let dataRowRenderedHeightPx: number | null = null;

  if (workbookXml) {
    const sheetTagRe = /<sheet\b[^>]*>/g;
    let sMatch: RegExpExecArray | null;
    while ((sMatch = sheetTagRe.exec(workbookXml)) !== null) {
      const tag = sMatch[0];
      const nameM = /\bname="([^"]+)"/.exec(tag);
      const ridM = /\br:id="([^"]+)"/.exec(tag);
      if (!nameM) continue;
      const sheetName = nameM[1];
      sheetNames.push(sheetName);
      const wsPath = ridM ? relTargetById.get(ridM[1]) : undefined;
      const wsXml = wsPath ? extractUtf8(entries.get(wsPath)) : null;
      if (wsXml) {
        let dataRows = 0;
        if (sheetName !== 'Özet') {
          if (posterColumnWidthChars === null) {
            const col1Match = /<col\b[^>]*\bmin="1"[^>]*\bwidth="([^"]+)"/.exec(wsXml);
            if (col1Match) {
              const parsedW = parseFloat(col1Match[1]);
              if (Number.isFinite(parsedW) && parsedW > 0) {
                posterColumnWidthChars = parsedW;
                posterColumnRenderedWidthPx = excelColumnWidthToPixels(parsedW);
              }
            }
          }
          const rowRe = /<row\b[^>]*\br="(\d+)"[^>]*>/g;
          let rMatch: RegExpExecArray | null;
          while ((rMatch = rowRe.exec(wsXml)) !== null) {
            const rNum = Number(rMatch[1]);
            if (rNum >= 5) {
              dataRows += 1;
              if (dataRowHeightPt === null) {
                const htM = /\bht="([^"]+)"/.exec(rMatch[0]);
                if (htM) {
                  const parsedHt = parseFloat(htM[1]);
                  if (Number.isFinite(parsedHt) && parsedHt > 0) {
                    dataRowHeightPt = parsedHt;
                    dataRowRenderedHeightPx = pointsToPixels(parsedHt);
                  }
                }
              }
            }
          }
        }
        worksheetDataRowCounts[sheetName] = dataRows;
      }
    }
  }

  let mediaFilesCount = 0;
  let mediaTotalCompressedBytes = 0;
  let mediaTotalUncompressedBytes = 0;
  let minMediaSourceWidthPx: number | null = null;
  let maxMediaSourceWidthPx: number | null = null;
  let minMediaSourceHeightPx: number | null = null;
  let maxMediaSourceHeightPx: number | null = null;
  let drawingFilesCount = 0;
  let totalOneCellAnchors = 0;
  let totalTwoCellAnchors = 0;
  let totalBlipEmbeds = 0;
  let totalDrawingRelationships = 0;
  let minRenderedWidthPx: number | null = null;
  let maxRenderedWidthPx: number | null = null;
  let minRenderedHeightPx: number | null = null;
  let maxRenderedHeightPx: number | null = null;
  let allAnchorsInPosterColumn = true;
  let allAnchorsRowAligned = true;
  let anyThinStripAnchor = false;

  const recordRenderedSize = (wPx: number, hPx: number) => {
    const roundedW = Math.round(wPx * 100) / 100;
    const roundedH = Math.round(hPx * 100) / 100;
    if (minRenderedWidthPx === null || roundedW < minRenderedWidthPx) minRenderedWidthPx = roundedW;
    if (maxRenderedWidthPx === null || roundedW > maxRenderedWidthPx) maxRenderedWidthPx = roundedW;
    if (minRenderedHeightPx === null || roundedH < minRenderedHeightPx) minRenderedHeightPx = roundedH;
    if (maxRenderedHeightPx === null || roundedH > maxRenderedHeightPx) maxRenderedHeightPx = roundedH;
    if (roundedW < 24 || roundedH < 24) {
      anyThinStripAnchor = true;
    }
  };

  for (const entry of entries.values()) {
    if (
      entry.name.startsWith('xl/media/') &&
      entry.name.length > 'xl/media/'.length &&
      !entry.name.endsWith('/')
    ) {
      mediaFilesCount += 1;
      mediaTotalCompressedBytes += entry.compSize;
      mediaTotalUncompressedBytes += entry.uncompSize;
      const mediaBuf = extractBuffer(entry);
      if (mediaBuf) {
        const dims = readImageDimensions(mediaBuf);
        if (dims) {
          if (minMediaSourceWidthPx === null || dims.width < minMediaSourceWidthPx) {
            minMediaSourceWidthPx = dims.width;
          }
          if (maxMediaSourceWidthPx === null || dims.width > maxMediaSourceWidthPx) {
            maxMediaSourceWidthPx = dims.width;
          }
          if (minMediaSourceHeightPx === null || dims.height < minMediaSourceHeightPx) {
            minMediaSourceHeightPx = dims.height;
          }
          if (maxMediaSourceHeightPx === null || dims.height > maxMediaSourceHeightPx) {
            maxMediaSourceHeightPx = dims.height;
          }
        }
      }
    } else if (/^xl\/drawings\/drawing\d+\.xml$/.test(entry.name)) {
      drawingFilesCount += 1;
      const dXml = extractUtf8(entry) || '';
      totalBlipEmbeds += (dXml.match(/\br:embed="/g) || []).length;

      const anchorRowsInDrawing: number[] = [];

      // Inspect oneCellAnchor nodes (<xdr:from> + <xdr:ext cx="..." cy="..."/>)
      const oneCellRe = /<xdr:oneCellAnchor\b[^>]*>([\s\S]*?)<\/xdr:oneCellAnchor>/g;
      let ocMatch: RegExpExecArray | null;
      while ((ocMatch = oneCellRe.exec(dXml)) !== null) {
        totalOneCellAnchors += 1;
        const body = ocMatch[1];
        const fromBlock = /<xdr:from>([\s\S]*?)<\/xdr:from>/.exec(body)?.[1] || '';
        const fromCol = Number(/<xdr:col>(\d+)<\/xdr:col>/.exec(fromBlock)?.[1] ?? -1);
        const fromColOff = Number(/<xdr:colOff>(-?\d+)<\/xdr:colOff>/.exec(fromBlock)?.[1] ?? 0);
        const fromRow = Number(/<xdr:row>(\d+)<\/xdr:row>/.exec(fromBlock)?.[1] ?? -1);
        const fromRowOff = Number(/<xdr:rowOff>(-?\d+)<\/xdr:rowOff>/.exec(fromBlock)?.[1] ?? 0);
        const extMatch = /<xdr:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(body);

        if (fromCol !== 0 || fromColOff < 0 || fromRowOff < 0) {
          allAnchorsInPosterColumn = false;
        }
        anchorRowsInDrawing.push(fromRow);

        if (extMatch) {
          const wPx = Number(extMatch[1]) / EMU_PER_PIXEL;
          const hPx = Number(extMatch[2]) / EMU_PER_PIXEL;
          recordRenderedSize(wPx, hPx);
          if (
            posterColumnRenderedWidthPx !== null &&
            fromColOff / EMU_PER_PIXEL + wPx > posterColumnRenderedWidthPx + 0.5
          ) {
            allAnchorsInPosterColumn = false;
          }
          if (
            dataRowRenderedHeightPx !== null &&
            fromRowOff / EMU_PER_PIXEL + hPx > dataRowRenderedHeightPx + 0.5
          ) {
            allAnchorsRowAligned = false;
          }
        } else {
          anyThinStripAnchor = true;
        }
      }

      // Also inspect any twoCellAnchor nodes (<xdr:from> + <xdr:to>)
      const twoCellRe = /<xdr:twoCellAnchor\b[^>]*>([\s\S]*?)<\/xdr:twoCellAnchor>/g;
      let tcMatch: RegExpExecArray | null;
      while ((tcMatch = twoCellRe.exec(dXml)) !== null) {
        totalTwoCellAnchors += 1;
        const body = tcMatch[1];
        const fromBlock = /<xdr:from>([\s\S]*?)<\/xdr:from>/.exec(body)?.[1] || '';
        const toBlock = /<xdr:to>([\s\S]*?)<\/xdr:to>/.exec(body)?.[1] || '';
        const fromCol = Number(/<xdr:col>(\d+)<\/xdr:col>/.exec(fromBlock)?.[1] ?? -1);
        const fromColOff = Number(/<xdr:colOff>(-?\d+)<\/xdr:colOff>/.exec(fromBlock)?.[1] ?? 0);
        const fromRow = Number(/<xdr:row>(\d+)<\/xdr:row>/.exec(fromBlock)?.[1] ?? -1);
        const fromRowOff = Number(/<xdr:rowOff>(-?\d+)<\/xdr:rowOff>/.exec(fromBlock)?.[1] ?? 0);
        const toCol = Number(/<xdr:col>(\d+)<\/xdr:col>/.exec(toBlock)?.[1] ?? -1);
        const toColOff = Number(/<xdr:colOff>(-?\d+)<\/xdr:colOff>/.exec(toBlock)?.[1] ?? 0);
        const toRow = Number(/<xdr:row>(\d+)<\/xdr:row>/.exec(toBlock)?.[1] ?? -1);
        const toRowOff = Number(/<xdr:rowOff>(-?\d+)<\/xdr:rowOff>/.exec(toBlock)?.[1] ?? 0);

        if (fromCol !== 0 || toCol !== 0 || fromRow !== toRow) {
          allAnchorsInPosterColumn = false;
        }
        anchorRowsInDrawing.push(fromRow);
        const wPx = (toColOff - fromColOff) / EMU_PER_PIXEL;
        const hPx = (toRowOff - fromRowOff) / EMU_PER_PIXEL;
        recordRenderedSize(wPx, hPx);
      }

      for (let i = 0; i < anchorRowsInDrawing.length; i += 1) {
        if (anchorRowsInDrawing[i] !== 4 + i) {
          allAnchorsRowAligned = false;
          break;
        }
      }
    } else if (/^xl\/drawings\/_rels\/drawing\d+\.xml\.rels$/.test(entry.name)) {
      const relXml = extractUtf8(entry) || '';
      totalDrawingRelationships += (relXml.match(/<Relationship\b/g) || []).length;
    }
  }

  const totalImageAnchors = totalOneCellAnchors + totalTwoCellAnchors;

  const validOpenXmlStructure =
    hasContentTypes &&
    Boolean(workbookXml) &&
    sheetNames.length === EXCEL_SHEET_NAMES.length &&
    EXCEL_SHEET_NAMES.every((expected, idx) => sheetNames[idx] === expected);

  return {
    validZip: true,
    validOpenXmlStructure,
    sizeBytes: buffer.length,
    sha256,
    sheetNames,
    worksheetDataRowCounts,
    mediaFilesCount,
    mediaTotalCompressedBytes,
    mediaTotalUncompressedBytes,
    minMediaSourceWidthPx,
    maxMediaSourceWidthPx,
    minMediaSourceHeightPx,
    maxMediaSourceHeightPx,
    drawingFilesCount,
    totalOneCellAnchors,
    totalTwoCellAnchors,
    totalImageAnchors,
    totalBlipEmbeds,
    totalDrawingRelationships,
    posterColumnWidthChars,
    posterColumnRenderedWidthPx,
    dataRowHeightPt,
    dataRowRenderedHeightPx,
    minRenderedWidthPx,
    maxRenderedWidthPx,
    minRenderedHeightPx,
    maxRenderedHeightPx,
    allAnchorsInPosterColumn,
    allAnchorsRowAligned,
    anyThinStripAnchor,
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
    | {
        ok: true;
        buffer: Buffer;
        extension: 'jpeg' | 'png' | 'gif';
        width: number;
        height: number;
      }
    | { ok: false; reason: string }
  >();

  await runWithConcurrency(uniqueUrls, posterConcurrency, async (url) => {
    const cached = posterCache.readCached(url);
    if (cached) {
      urlFetchOutcome.set(url, {
        ok: true,
        buffer: cached.buffer,
        extension: cached.extension,
        width: cached.width,
        height: cached.height,
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
      const dims = readImageDimensions(response.buffer);
      if (!dims) {
        urlFetchOutcome.set(url, {
          ok: false,
          reason: 'Görsel piksel boyutları okunamadı (bozuk görsel başlığı)',
        });
        return;
      }
      if (
        dims.width < MIN_VALID_POSTER_DIMENSION_PX ||
        dims.height < MIN_VALID_POSTER_DIMENSION_PX
      ) {
        urlFetchOutcome.set(url, {
          ok: false,
          reason: `Kaynak görsel boyutu çok küçük veya bozuk (${dims.width}x${dims.height} piksel)`,
        });
        return;
      }
      posterCache.writeCached(url, response.buffer, ext, dims.width, dims.height);
      urlFetchOutcome.set(url, {
        ok: true,
        buffer: response.buffer,
        extension: ext,
        width: dims.width,
        height: dims.height,
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
  const workbookImageMetaByUrl = new Map<
    string,
    { imageId: number; width: number; height: number }
  >();
  for (const [url, outcome] of urlFetchOutcome.entries()) {
    if (outcome.ok) {
      const imgId = workbook.addImage({
        buffer: outcome.buffer as any,
        extension: outcome.extension,
      });
      workbookImageMetaByUrl.set(url, {
        imageId: imgId,
        width: outcome.width,
        height: outcome.height,
      });
    }
  }

  let placeholderImageMeta: { imageId: number; width: number; height: number } | null = null;
  if (embedPlaceholder && (missingPosterSourceCount > 0 || posterErrors.length > 0)) {
    const placeholderBuf = getNeutralPosterPlaceholderPng();
    const placeholderDims = readImageDimensions(placeholderBuf) || {
      width: 144,
      height: 216,
    };
    const imgId = workbook.addImage({
      buffer: placeholderBuf as any,
      extension: 'png',
    });
    placeholderImageMeta = {
      imageId: imgId,
      width: placeholderDims.width,
      height: placeholderDims.height,
    };
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

  const writtenRowsBySheet: Record<ContentSheetName, number> = {
    İzlenen: 0,
    İzlenecek: 0,
    İzleniyor: 0,
    İlgilenmiyorum: 0,
  };

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
      workbookImageMetaByUrl,
      placeholderImageMeta
    );
    writtenRowsBySheet[sheetName] = dataset.sheets[sheetName].length;
  }

  const arrayLike = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.isBuffer(arrayLike) ? arrayLike : Buffer.from(arrayLike);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const packageInspection = inspectXlsxPackageBuffer(buffer);
  if (
    !packageInspection.validZip ||
    !packageInspection.validOpenXmlStructure ||
    packageInspection.anyThinStripAnchor ||
    !packageInspection.allAnchorsInPosterColumn ||
    !packageInspection.allAnchorsRowAligned
  ) {
    throw new Error('Üretilen XLSX paketi geçerli OpenXML ZIP veya poster yerleşim doğrulamasından geçemedi.');
  }

  let downloadedOrCachedPostersCount = 0;
  for (const outcome of urlFetchOutcome.values()) {
    if (outcome.ok) downloadedOrCachedPostersCount += 1;
  }

  const sourceDiagnostics: SourceCompletenessDiagnostics = {
    rawProfileItemsCount: dataset.rawProfileItemsCount,
    normalizedSavedItemsCount: dataset.normalizedSavedItemsCount,
    rawDislikedCount: dataset.rawDislikedCount,
    uniqueDislikedCount: dataset.uniqueDislikedCount,
    sourceCountsByList: {
      completed: dataset.sheetCounts.İzlenen.total,
      watchlist: dataset.sheetCounts.İzlenecek.total,
      watching: dataset.sheetCounts.İzleniyor.total,
      disliked: dataset.sheetCounts.İlgilenmiyorum.total,
    },
    sourceMovieCount: dataset.totalMovieCount,
    sourceTvCount: dataset.totalTvCount,
    recordsSentToExcelCount: allSheetRows.length,
    writtenRowsBySheet,
    itemsWithPosterUrlCount: allSheetRows.length - missingPosterSourceCount,
    uniquePosterUrlsCount: uniqueUrls.length,
    downloadedOrCachedPostersCount,
    embeddedPostersCount,
    placeholderPostersCount,
    skippedOrFailedPostersCount: missingPosterSourceCount + posterErrors.length,
  };

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
    sourceDiagnostics,
    packageInspection,
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
  workbookImageMetaByUrl: Map<string, { imageId: number; width: number; height: number }>,
  placeholderImageMeta: { imageId: number; width: number; height: number } | null
): void {
  const posterColumnWidthChars = pixelsToExcelColumnWidth(POSTER_CELL_WIDTH_PX);
  // Set column widths ONLY (do NOT set `header` here so Row 1 stays our sheet title banner without merged cells)
  ws.columns = [
    { key: 'poster', width: posterColumnWidthChars }, // 76 px rendered width (72 px poster + 2 px margin left/right)
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
    // 84 pt = 112 px (81 pt = 108 px poster + 3 pt = 4 px vertical margin, single row per item)
    row.height = POSTER_ROW_HEIGHT_PT;

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

    // Embed Poster Image inside Col 1 (0-based col = 0, 0-based row = excelRowNum - 1)
    let targetImg: { imageId: number; width: number; height: number } | null = null;
    if (item.posterUrl && workbookImageMetaByUrl.has(item.posterUrl)) {
      targetImg = workbookImageMetaByUrl.get(item.posterUrl) || null;
    } else if (placeholderImageMeta !== null) {
      targetImg = placeholderImageMeta;
    }

    if (targetImg !== null) {
      const zeroRow = excelRowNum - 1;
      const placement = computePosterPlacement(targetImg.width, targetImg.height);
      // Pass explicit integer EMU offsets (`nativeColOff`/`nativeRowOff`) to bypass ExcelJS's
      // broken `Anchor.colWidth` (`column.width * 10000`) conversion, and pass `ext` in pixels
      // (serialized by ExcelJS `ExtXform` at 96 DPI: `1 px = 9525 EMU` -> ~72x108 px proportional).
      ws.addImage(targetImg.imageId, {
        tl: {
          nativeCol: 0,
          nativeColOff: placement.colOffEmu,
          nativeRow: zeroRow,
          nativeRowOff: placement.rowOffEmu,
        } as any,
        ext: {
          width: placement.widthPx,
          height: placement.heightPx,
        },
        editAs: 'oneCell',
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
      excelBackup.sourceDiagnostics = built.sourceDiagnostics;
      excelBackup.packageInspection = built.packageInspection;
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

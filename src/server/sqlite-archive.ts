/**
 * SQLite Arşivi — profil, stok ve stok görsellerinin tek dosyada tam yedeği.
 *
 * Amaç: `cinetrack.sqlite` tek dosyasından tüm verilerin (profiller, izleme
 * listeleri, tercihler, favori oyuncular, zevk haritaları, film/dizi stokları ve
 * stok posterleri) kayıpsız geri yüklenebilmesi.
 *
 * SQLite erişimi `node:sqlite` üzerinden yapılır. Node 22.18'de bu modül
 * `--experimental-sqlite` bayrağı ister; bu yüzden içe aktarma tembel yapılır ve
 * modül yoksa net bir `SqliteUnavailableError` üretilir (sunucu açılışını bozmaz).
 */

import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DataDocument, Profile } from '../core/cinetrack-core.ts';

export const SQLITE_ARCHIVE_SCHEMA_VERSION = 1;
export const SQLITE_ARCHIVE_EXTENSION = 'sqlite';

/** Tek arşivde gömülecek azami poster sayısı. */
export const MAX_ARCHIVE_POSTERS = 1500;
/** Tek poster için azami bayt. */
export const MAX_ARCHIVE_POSTER_BYTES = 8 * 1024 * 1024;
/** Arşivdeki toplam poster baytı sınırı. */
export const MAX_ARCHIVE_TOTAL_POSTER_BYTES = 200 * 1024 * 1024;

export const ALLOWED_ARCHIVE_POSTER_HOSTS = Object.freeze([
  'image.tmdb.org',
  'img.tmdb.org',
]);

export class SqliteUnavailableError extends Error {
  constructor(message = "node:sqlite bu Node sürümünde kullanılamıyor (Node 23.4+ veya --experimental-sqlite gerekir).") {
    super(message);
    this.name = 'SqliteUnavailableError';
  }
}

export class SqliteArchiveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteArchiveValidationError';
  }
}

export interface ArchiveStockSnapshot {
  movies?: unknown[];
  tv?: unknown[];
  updatedAt?: string;
  cursors?: Record<string, unknown>;
}

export interface ArchiveSnapshot {
  dataDocument: DataDocument;
  /** profileId -> PersistentTasteMapData (JSON olarak saklanır). */
  tasteMaps?: Record<string, unknown>;
  /** Yerel film/dizi stok depoları. */
  stock?: ArchiveStockSnapshot;
  /** Arşive gömülecek poster/afiş URL'leri (mutlak http(s) adresleri). */
  posterUrls?: string[];
  createdAt?: string;
  appVersion?: string;
}

export interface ArchivePosterAsset {
  url: string;
  mediaKey: string;
  contentType: string;
  bytes: Buffer;
}

export interface SqliteArchiveWriteResult {
  filePath: string;
  byteLength: number;
  profiles: number;
  items: number;
  tasteMaps: number;
  stockMovies: number;
  stockTv: number;
  postersStored: number;
  postersFailed: number;
  posterBytes: number;
  createdAt: string;
}

export interface SqliteArchiveReadResult {
  schemaVersion: number;
  createdAt: string;
  appVersion: string;
  dataDocument: DataDocument;
  tasteMaps: Record<string, unknown>;
  stock: ArchiveStockSnapshot;
  posters: ArchivePosterAsset[];
  counts: {
    profiles: number;
    items: number;
    tasteMaps: number;
    stockMovies: number;
    stockTv: number;
    posters: number;
  };
}

interface SqliteModule {
  DatabaseSync: new (filePath: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
      all(...params: unknown[]): Array<Record<string, unknown>>;
      get(...params: unknown[]): Record<string, unknown> | undefined;
    };
    close(): void;
  };
}

let cachedSqliteModule: SqliteModule | null = null;

async function loadSqlite(): Promise<SqliteModule> {
  if (cachedSqliteModule) return cachedSqliteModule;
  try {
    const mod = (await import('node:sqlite')) as unknown as SqliteModule;
    if (!mod?.DatabaseSync) throw new Error('DatabaseSync bulunamadı');
    cachedSqliteModule = mod;
    return mod;
  } catch (error) {
    throw new SqliteUnavailableError(
      `node:sqlite yüklenemedi: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** SQLite arşiv desteğinin bu çalışma zamanında kullanılabilir olup olmadığı. */
export async function isSqliteArchiveAvailable(): Promise<boolean> {
  try {
    await loadSqlite();
    return true;
  } catch {
    return false;
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS archive_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  preferences_json TEXT NOT NULL,
  favorite_actors_json TEXT NOT NULL,
  deleted_keys_json TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_items (
  profile_id TEXT NOT NULL,
  media_key TEXT NOT NULL,
  media_type TEXT NOT NULL,
  media_id TEXT,
  status TEXT,
  personal_rating TEXT,
  payload_json TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (profile_id, media_key)
);
CREATE TABLE IF NOT EXISTS taste_maps (
  profile_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_items (
  kind TEXT NOT NULL,
  media_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (kind, media_key)
);
CREATE TABLE IF NOT EXISTS stock_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posters (
  url TEXT PRIMARY KEY,
  media_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  bytes BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_items_profile ON profile_items(profile_id, position);
CREATE INDEX IF NOT EXISTS idx_stock_items_kind ON stock_items(kind);
`;

function mediaKeyOf(item: Record<string, unknown>, fallbackType = 'movie'): string {
  const type = item.media_type === 'tv' || item.mediaType === 'tv' ? 'tv' : fallbackType;
  const id = item.id ?? item.tmdbId ?? '';
  return `${type}:${String(id)}`;
}

function isAllowedPosterUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    return ALLOWED_ARCHIVE_POSTER_HOSTS.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function detectImageContentType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export type ArchivePosterFetcher = (url: string) => Promise<{ bytes: Buffer; contentType: string } | null>;

async function defaultPosterFetcher(url: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'image/avif,image/webp,image/jpeg,image/png,*/*' },
    });
    if (!res.ok) return null;
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > MAX_ARCHIVE_POSTER_BYTES) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_ARCHIVE_POSTER_BYTES) return null;
    const detected = detectImageContentType(bytes);
    if (!detected) return null;
    return { bytes, contentType: detected };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verilen URL'leri doğrular, tekilleştirir ve sınırlar dahilinde indirir.
 * Hatalar arşivi düşürmez; sayaç olarak raporlanır.
 */
export async function collectArchivePosters(
  posterUrls: string[],
  options: {
    fetchPoster?: ArchivePosterFetcher;
    maxPosters?: number;
    maxTotalBytes?: number;
    concurrency?: number;
    mediaKeyLookup?: Map<string, string>;
  } = {}
): Promise<{ posters: ArchivePosterAsset[]; failed: number; bytes: number }> {
  const fetcher = options.fetchPoster || defaultPosterFetcher;
  const maxPosters = Math.max(0, options.maxPosters ?? MAX_ARCHIVE_POSTERS);
  const maxTotalBytes = Math.max(0, options.maxTotalBytes ?? MAX_ARCHIVE_TOTAL_POSTER_BYTES);
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 6));

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of posterUrls) {
    if (typeof raw !== 'string') continue;
    const url = raw.trim();
    if (!url || seen.has(url) || !isAllowedPosterUrl(url)) continue;
    seen.add(url);
    unique.push(url);
    if (unique.length >= maxPosters) break;
  }

  const posters: ArchivePosterAsset[] = [];
  let failed = 0;
  let bytes = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < unique.length) {
      const url = unique[cursor++];
      if (bytes >= maxTotalBytes) return;
      const fetched = await fetcher(url);
      if (!fetched || fetched.bytes.length === 0) {
        failed++;
        continue;
      }
      if (bytes + fetched.bytes.length > maxTotalBytes) {
        failed++;
        continue;
      }
      bytes += fetched.bytes.length;
      posters.push({
        url,
        mediaKey: options.mediaKeyLookup?.get(url) || '',
        contentType: fetched.contentType,
        bytes: fetched.bytes,
      });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));
  return { posters, failed, bytes };
}

function serialize(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Anlık görüntüyü atomik olarak `.sqlite` dosyasına yazar (tmp + fsync + rename).
 */
export async function writeSqliteArchive(
  snapshot: ArchiveSnapshot,
  filePath: string,
  options: {
    fetchPoster?: ArchivePosterFetcher;
    maxPosters?: number;
    mediaKeyLookup?: Map<string, string>;
  } = {}
): Promise<SqliteArchiveWriteResult> {
  assertSnapshot(snapshot);
  const sqlite = await loadSqlite();

  const createdAt = snapshot.createdAt || new Date().toISOString();
  const { posters, failed, bytes: posterBytes } = await collectArchivePosters(
    snapshot.posterUrls || [],
    {
      ...(options.fetchPoster ? { fetchPoster: options.fetchPoster } : {}),
      ...(options.maxPosters !== undefined ? { maxPosters: options.maxPosters } : {}),
      ...(options.mediaKeyLookup ? { mediaKeyLookup: options.mediaKeyLookup } : {}),
    }
  );

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.rm(tempPath, { force: true });

  const db = new sqlite.DatabaseSync(tempPath);
  let items = 0;
  let tasteMaps = 0;
  let stockMovies = 0;
  let stockTv = 0;

  try {
    db.exec('PRAGMA journal_mode = DELETE;');
    db.exec('PRAGMA synchronous = FULL;');
    db.exec(SCHEMA_SQL);

    const insertMeta = db.prepare('INSERT OR REPLACE INTO archive_meta (key, value) VALUES (?, ?)');
    const insertProfile = db.prepare(
      `INSERT INTO profiles (id, name, created_at, is_demo, preferences_json, favorite_actors_json, deleted_keys_json, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertItem = db.prepare(
      `INSERT OR REPLACE INTO profile_items (profile_id, media_key, media_type, media_id, status, personal_rating, payload_json, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertTasteMap = db.prepare(
      'INSERT OR REPLACE INTO taste_maps (profile_id, payload_json) VALUES (?, ?)'
    );
    const insertStockItem = db.prepare(
      'INSERT OR REPLACE INTO stock_items (kind, media_key, payload_json) VALUES (?, ?, ?)'
    );
    const insertStockState = db.prepare('INSERT OR REPLACE INTO stock_state (key, value) VALUES (?, ?)');
    const insertPoster = db.prepare(
      'INSERT OR REPLACE INTO posters (url, media_key, content_type, byte_length, bytes) VALUES (?, ?, ?, ?, ?)'
    );

    db.exec('BEGIN');
    try {
      insertMeta.run('schema_version', String(SQLITE_ARCHIVE_SCHEMA_VERSION));
      insertMeta.run('created_at', createdAt);
      insertMeta.run('app_version', snapshot.appVersion || '');
      insertMeta.run('document_version', String(snapshot.dataDocument.version ?? ''));
      insertMeta.run('document_schema_version', String(snapshot.dataDocument.schemaVersion ?? ''));
      insertMeta.run('document_engine_version', String(snapshot.dataDocument.engineVersion ?? ''));
      insertMeta.run('document_revision', String(snapshot.dataDocument.revision ?? 0));
      insertMeta.run('document_updated_at', String(snapshot.dataDocument.updatedAt ?? ''));
      insertMeta.run('active_profile_id', String(snapshot.dataDocument.activeProfileId ?? ''));

      snapshot.dataDocument.profiles.forEach((profile: Profile, profileIndex: number) => {
        insertProfile.run(
          profile.id,
          profile.name,
          profile.createdAt || '',
          profile.isDemo ? 1 : 0,
          serialize(profile.preferences ?? {}),
          serialize(profile.favoriteActors ?? []),
          serialize(profile.deleted_keys ?? {}),
          profileIndex
        );
        (profile.items || []).forEach((item, itemIndex) => {
          const record = item as unknown as Record<string, unknown>;
          const key = mediaKeyOf(record, 'movie');
          insertItem.run(
            profile.id,
            key,
            record.media_type === 'tv' ? 'tv' : 'movie',
            String(record.id ?? ''),
            String(record.status ?? ''),
            String(record.personal_rating ?? ''),
            serialize(record),
            itemIndex
          );
          items++;
        });
      });

      for (const [profileId, payload] of Object.entries(snapshot.tasteMaps || {})) {
        if (!profileId) continue;
        insertTasteMap.run(profileId, serialize(payload));
        tasteMaps++;
      }

      const stock = snapshot.stock || {};
      for (const movie of stock.movies || []) {
        const record = movie as Record<string, unknown>;
        insertStockItem.run('movie', mediaKeyOf(record, 'movie'), serialize(record));
        stockMovies++;
      }
      for (const show of stock.tv || []) {
        const record = show as Record<string, unknown>;
        insertStockItem.run('tv', mediaKeyOf(record, 'tv'), serialize(record));
        stockTv++;
      }
      if (stock.updatedAt) insertStockState.run('updated_at', String(stock.updatedAt));
      if (stock.cursors) insertStockState.run('cursors', serialize(stock.cursors));

      for (const poster of posters) {
        insertPoster.run(
          poster.url,
          poster.mediaKey,
          poster.contentType,
          poster.bytes.length,
          poster.bytes
        );
      }

      insertMeta.run('profile_count', String(snapshot.dataDocument.profiles.length));
      insertMeta.run('item_count', String(items));
      insertMeta.run('poster_count', String(posters.length));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }

  // fsync + atomik taşıma
  const handle = await fs.open(tempPath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tempPath, filePath);

  const stat = await fs.stat(filePath);
  return {
    filePath,
    byteLength: stat.size,
    profiles: snapshot.dataDocument.profiles.length,
    items,
    tasteMaps,
    stockMovies,
    stockTv,
    postersStored: posters.length,
    postersFailed: failed,
    posterBytes,
    createdAt,
  };
}

/**
 * `.sqlite` arşivini okuyup uygulamanın veri belgesini ve tüm yan verileri döndürür.
 */
export async function readSqliteArchive(filePath: string): Promise<SqliteArchiveReadResult> {
  if (!existsSync(filePath)) {
    throw new SqliteArchiveValidationError('Arşiv dosyası bulunamadı');
  }
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(filePath);

  try {
    const metaRows = db.prepare('SELECT key, value FROM archive_meta').all();
    const meta = new Map<string, string>();
    for (const row of metaRows) {
      meta.set(String(row.key), String(row.value));
    }

    const schemaVersion = Number(meta.get('schema_version') || 0);
    if (!Number.isFinite(schemaVersion) || schemaVersion < 1) {
      throw new SqliteArchiveValidationError('Geçersiz veya eksik arşiv şeması');
    }
    if (schemaVersion > SQLITE_ARCHIVE_SCHEMA_VERSION) {
      throw new SqliteArchiveValidationError(
        `Arşiv şema sürümü desteklenenden yeni: ${schemaVersion} > ${SQLITE_ARCHIVE_SCHEMA_VERSION}`
      );
    }

    const profileRows = db
      .prepare('SELECT * FROM profiles ORDER BY position ASC')
      .all();
    if (profileRows.length === 0) {
      throw new SqliteArchiveValidationError('Arşivde profil bulunamadı');
    }

    const itemRows = db
      .prepare('SELECT * FROM profile_items ORDER BY profile_id ASC, position ASC')
      .all();
    const itemsByProfile = new Map<string, unknown[]>();
    for (const row of itemRows) {
      const profileId = String(row.profile_id);
      const payload = parseJson<Record<string, unknown> | null>(row.payload_json, null);
      if (!payload) continue;
      const bucket = itemsByProfile.get(profileId) || [];
      bucket.push(payload);
      itemsByProfile.set(profileId, bucket);
    }

    const profiles: Profile[] = profileRows.map((row) => {
      const id = String(row.id);
      const deletedKeys = parseJson<Record<string, string>>(row.deleted_keys_json, {});
      return {
        id,
        name: String(row.name || 'Profilim'),
        createdAt: String(row.created_at || ''),
        isDemo: Number(row.is_demo) === 1,
        preferences: parseJson(row.preferences_json, {}),
        favoriteActors: parseJson(row.favorite_actors_json, []),
        items: (itemsByProfile.get(id) || []) as Profile['items'],
        ...(Object.keys(deletedKeys).length > 0 ? { deleted_keys: deletedKeys } : {}),
      } as unknown as Profile;
    });

    const activeProfileId = meta.get('active_profile_id') || profiles[0].id;
    const dataDocument: DataDocument = {
      version: Number(meta.get('document_version') || 3),
      schemaVersion: Number(meta.get('document_schema_version') || 3),
      engineVersion: meta.get('document_engine_version') || '',
      activeProfileId: profiles.some((p) => p.id === activeProfileId) ? activeProfileId : profiles[0].id,
      profiles,
      revision: Number(meta.get('document_revision') || 0),
      updatedAt: meta.get('document_updated_at') || new Date().toISOString(),
    } as DataDocument;

    const tasteMaps: Record<string, unknown> = {};
    for (const row of db.prepare('SELECT profile_id, payload_json FROM taste_maps').all()) {
      const parsed = parseJson<unknown>(row.payload_json, null);
      if (parsed) tasteMaps[String(row.profile_id)] = parsed;
    }

    const stock: ArchiveStockSnapshot = { movies: [], tv: [] };
    for (const row of db.prepare('SELECT kind, payload_json FROM stock_items').all()) {
      const parsed = parseJson<Record<string, unknown> | null>(row.payload_json, null);
      if (!parsed) continue;
      if (String(row.kind) === 'tv') stock.tv!.push(parsed);
      else stock.movies!.push(parsed);
    }
    for (const row of db.prepare('SELECT key, value FROM stock_state').all()) {
      if (String(row.key) === 'updated_at') stock.updatedAt = String(row.value);
      if (String(row.key) === 'cursors') stock.cursors = parseJson<Record<string, unknown>>(row.value, {});
    }

    const posters: ArchivePosterAsset[] = [];
    for (const row of db.prepare('SELECT url, media_key, content_type, bytes FROM posters').all()) {
      const raw = row.bytes as unknown;
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      posters.push({
        url: String(row.url),
        mediaKey: String(row.media_key || ''),
        contentType: String(row.content_type || 'image/jpeg'),
        bytes,
      });
    }

    return {
      schemaVersion,
      createdAt: meta.get('created_at') || '',
      appVersion: meta.get('app_version') || '',
      dataDocument,
      tasteMaps,
      stock,
      posters,
      counts: {
        profiles: profiles.length,
        items: itemRows.length,
        tasteMaps: Object.keys(tasteMaps).length,
        stockMovies: (stock.movies || []).length,
        stockTv: (stock.tv || []).length,
        posters: posters.length,
      },
    };
  } finally {
    db.close();
  }
}

/**
 * Arşivdeki poster baytlarını poster önbelleğine geri yazar; böylece çevrimdışı
 * görseller geri yükleme sonrası yeniden indirilmeden kullanılabilir.
 */
export async function restoreArchivePostersToCache(
  posters: ArchivePosterAsset[],
  cacheDir: string
): Promise<{ written: number; skipped: number }> {
  if (posters.length === 0) return { written: 0, skipped: 0 };
  await fs.mkdir(cacheDir, { recursive: true });

  let written = 0;
  let skipped = 0;
  for (const poster of posters) {
    if (!isAllowedPosterUrl(poster.url) || poster.bytes.length === 0) {
      skipped++;
      continue;
    }
    const ext = poster.contentType.includes('png')
      ? 'png'
      : poster.contentType.includes('gif')
      ? 'gif'
      : 'jpg';
    const hash = crypto.createHash('sha256').update(poster.url).digest('hex');
    const target = path.join(cacheDir, `${hash}.${ext}`);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temp, poster.bytes);
      await fs.rename(temp, target);
      written++;
    } catch {
      skipped++;
      try {
        await fs.rm(temp, { force: true });
      } catch {
        // yoksay
      }
    }
  }
  return { written, skipped };
}

/**
 * Arşiv dosyasından geri yükleme sırasında poster URL'lerini medya anahtarına
 * eşlemek için kullanılan yardımcı.
 */
export function buildPosterUrlLookup(
  entries: Array<{ url: string; mediaKey: string }>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (entry.url && entry.mediaKey) map.set(entry.url, entry.mediaKey);
  }
  return map;
}

function assertSnapshot(snapshot: ArchiveSnapshot): void {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new SqliteArchiveValidationError('Arşiv anlık görüntüsü geçersiz');
  }
  const doc = snapshot.dataDocument;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.profiles) || doc.profiles.length === 0) {
    throw new SqliteArchiveValidationError('Arşiv için en az bir profil gerekir');
  }
  for (const profile of doc.profiles) {
    if (!profile || typeof profile.id !== 'string' || !profile.id) {
      throw new SqliteArchiveValidationError('Profil kimliği eksik');
    }
    if (profile.id.includes('/') || profile.id.includes('..')) {
      throw new SqliteArchiveValidationError('Geçersiz profil kimliği');
    }
  }
}

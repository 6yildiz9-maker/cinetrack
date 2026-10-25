import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface CatalogRecord {
  key: string;
  id: number;
  media_type: 'movie' | 'tv';
  title: string;
  original_title?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids: number[];
  vote_average: number;
  vote_count?: number;
  release_date?: string;
  first_air_date?: string;
  popularity?: number;
  firstStoredAt: string;
  lastUpdatedAt: string;
  source?: 'tmdb' | 'demo';
}

export interface CatalogManifest {
  version: 1;
  updatedAt: string;
  movieCount: number;
  tvCount: number;
  contentHash: string;
}

export interface DerivedProfileItem {
  mediaKey: string;
  matchScore: number;
  lifecycleRing: 'ring0' | 'ring1' | 'ring2';
  signals?: Record<string, number>;
  reasons?: string[];
  calculatedAt: string;
}

export interface DerivedProfileDocument {
  schemaVersion: 1;
  profileId: string;
  algorithmVersion: string;
  profileFingerprint: string;
  generatedAt: string;
  items: Record<string, DerivedProfileItem>;
}

export interface PersistentStoreOptions {
  dataDir: string;
  githubToken?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubBranch?: string;
  isPublicRepo?: boolean;
}

export interface SyncStatus {
  configured: boolean;
  mode: 'github' | 'local_only';
  reason?: string;
  isPublicRepo: boolean;
  lastSyncAt: string | null;
  catalogCounts: {
    movies: number;
    tv: number;
  };
  profilesCount: number;
  remoteTarget?: {
    owner: string;
    repo: string;
    branch: string;
  };
}

export interface SyncResult {
  ok: boolean;
  filesCommitted: string[];
  filesSkipped: string[];
  filesBlockedPublic: string[];
  errors: string[];
}

/**
 * Deterministic JSON stringifier that sorts object keys alphabetically.
 */
export function stringifyDeterministic(obj: any, space = 2): string {
  const allKeys = new Set<string>();
  JSON.stringify(obj, (key, value) => {
    allKeys.add(key);
    return value;
  });
  return JSON.stringify(obj, Array.from(allKeys).sort(), space);
}

/**
 * Calculate sha256 hash of a string
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Normalize TMDB or local item to a canonical key: `movie:<id>` or `tv:<id>`
 */
export function toCanonicalKey(item: any): string | null {
  if (!item || typeof item !== 'object') return null;
  const rawId = Number(item.id);
  if (!Number.isSafeInteger(rawId) || rawId <= 0) return null;
  const rawType = item.media_type || (item.title ? 'movie' : item.name ? 'tv' : 'movie');
  const type = rawType === 'tv' ? 'tv' : 'movie';
  return `${type}:${rawId}`;
}

/**
 * Merge new partial incoming record into existing rich record without losing data.
 */
export function mergeCatalogItem(existing: CatalogRecord | undefined, incoming: any): CatalogRecord {
  const rawId = Number(incoming.id);
  const mediaType: 'movie' | 'tv' = incoming.media_type === 'tv' ? 'tv' : 'movie';
  const key = `${mediaType}:${rawId}`;
  const now = new Date().toISOString();

  const title = (incoming.title || incoming.name || existing?.title || '').trim();
  const originalTitle = (incoming.original_title || incoming.original_name || existing?.original_title || '').trim();
  const overview = (typeof incoming.overview === 'string' && incoming.overview.trim()) ? incoming.overview.trim() : (existing?.overview || '');
  const posterPath = incoming.poster_path !== undefined ? incoming.poster_path : (existing?.poster_path ?? null);
  const backdropPath = incoming.backdrop_path !== undefined ? incoming.backdrop_path : (existing?.backdrop_path ?? null);
  
  // Merge genre_ids deterministically
  const genreSet = new Set<number>();
  if (Array.isArray(existing?.genre_ids)) {
    for (const g of existing.genre_ids) if (Number.isSafeInteger(g)) genreSet.add(g);
  }
  if (Array.isArray(incoming.genre_ids)) {
    for (const g of incoming.genre_ids) if (Number.isSafeInteger(g)) genreSet.add(g);
  }
  const genreIds = Array.from(genreSet).sort((a, b) => a - b);

  const voteAverage = Number.isFinite(incoming.vote_average) && incoming.vote_average > 0
    ? Number(incoming.vote_average)
    : (existing?.vote_average ?? 0);

  const voteCount = Number.isSafeInteger(incoming.vote_count) && incoming.vote_count > 0
    ? Number(incoming.vote_count)
    : (existing?.vote_count ?? 0);

  const releaseDate = incoming.release_date || incoming.first_air_date || existing?.release_date || existing?.first_air_date || undefined;
  const firstAirDate = mediaType === 'tv' ? (incoming.first_air_date || existing?.first_air_date || releaseDate) : undefined;
  const popularity = Number.isFinite(incoming.popularity) ? Number(incoming.popularity) : (existing?.popularity ?? undefined);

  return {
    key,
    id: rawId,
    media_type: mediaType,
    title,
    original_title: originalTitle || undefined,
    overview: overview || undefined,
    poster_path: posterPath,
    backdrop_path: backdropPath,
    genre_ids: genreIds,
    vote_average: voteAverage,
    vote_count: voteCount || undefined,
    release_date: releaseDate,
    first_air_date: firstAirDate,
    popularity,
    firstStoredAt: existing?.firstStoredAt || now,
    lastUpdatedAt: now,
    source: incoming._source || existing?.source || 'tmdb',
  };
}

/**
 * Sanitize profileId for safe file naming on disk.
 */
export function sanitizeProfileId(profileId: string): string {
  const cleaned = profileId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.slice(0, 80) || 'default';
}

export class PersistentDataStore {
  private dataDir: string;
  private catalogDir: string;
  private profilesDir: string;
  private moviesFile: string;
  private tvFile: string;
  private manifestFile: string;
  private lastSyncAt: string | null = null;

  private githubToken?: string;
  private githubOwner?: string;
  private githubRepo?: string;
  private githubBranch: string;
  private isPublicRepo: boolean;

  constructor(options: PersistentStoreOptions) {
    this.dataDir = options.dataDir;
    this.catalogDir = path.join(this.dataDir, 'catalog');
    this.profilesDir = path.join(this.dataDir, 'profiles');
    this.moviesFile = path.join(this.catalogDir, 'movies.json');
    this.tvFile = path.join(this.catalogDir, 'tv.json');
    this.manifestFile = path.join(this.catalogDir, 'manifest.json');

    this.githubToken = options.githubToken?.trim();
    this.githubOwner = options.githubOwner?.trim();
    this.githubRepo = options.githubRepo?.trim();
    this.githubBranch = options.githubBranch?.trim() || 'main';
    this.isPublicRepo = Boolean(options.isPublicRepo);

    this.initDirectories();
  }

  private initDirectories() {
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
    if (!existsSync(this.catalogDir)) mkdirSync(this.catalogDir, { recursive: true });
    if (!existsSync(this.profilesDir)) mkdirSync(this.profilesDir, { recursive: true });
  }

  // --- CATALOG OPERATIONS ---

  public readCatalog(mediaType: 'movie' | 'tv'): Record<string, CatalogRecord> {
    const file = mediaType === 'movie' ? this.moviesFile : this.tvFile;
    if (!existsSync(file)) return {};
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      return typeof raw === 'object' && raw !== null ? raw : {};
    } catch {
      return {};
    }
  }

  public upsertCatalogItems(items: any[]): { inserted: number; updated: number; unchanged: number; total: number } {
    if (!Array.isArray(items) || items.length === 0) {
      return { inserted: 0, updated: 0, unchanged: 0, total: 0 };
    }

    const movies = this.readCatalog('movie');
    const tv = this.readCatalog('tv');

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let moviesChanged = false;
    let tvChanged = false;

    for (const item of items) {
      const key = toCanonicalKey(item);
      if (!key) continue;
      const isTv = key.startsWith('tv:');
      const targetMap = isTv ? tv : movies;
      const existing = targetMap[key];

      const merged = mergeCatalogItem(existing, item);

      if (!existing) {
        targetMap[key] = merged;
        inserted++;
        if (isTv) tvChanged = true;
        else moviesChanged = true;
      } else {
        // Compare content without timestamps to prevent noisy commits
        const existingCopy = { ...existing, firstStoredAt: '', lastUpdatedAt: '' };
        const mergedCopy = { ...merged, firstStoredAt: '', lastUpdatedAt: '' };

        if (stringifyDeterministic(existingCopy) !== stringifyDeterministic(mergedCopy)) {
          targetMap[key] = merged;
          updated++;
          if (isTv) tvChanged = true;
          else moviesChanged = true;
        } else {
          unchanged++;
        }
      }
    }

    if (moviesChanged) {
      writeFileSync(this.moviesFile, stringifyDeterministic(movies), 'utf8');
    }
    if (tvChanged) {
      writeFileSync(this.tvFile, stringifyDeterministic(tv), 'utf8');
    }

    if (moviesChanged || tvChanged || !existsSync(this.manifestFile)) {
      const movieCount = Object.keys(movies).length;
      const tvCount = Object.keys(tv).length;
      const combinedHash = hashContent(stringifyDeterministic(movies) + stringifyDeterministic(tv));
      const manifest: CatalogManifest = {
        version: 1,
        updatedAt: new Date().toISOString(),
        movieCount,
        tvCount,
        contentHash: combinedHash,
      };
      writeFileSync(this.manifestFile, stringifyDeterministic(manifest), 'utf8');
    }

    return {
      inserted,
      updated,
      unchanged,
      total: inserted + updated + unchanged,
    };
  }

  // --- DERIVED PROFILE OPERATIONS ---

  public getProfileFilePath(profileId: string): string {
    const safeId = sanitizeProfileId(profileId);
    return path.join(this.profilesDir, `${safeId}.json`);
  }

  public readDerivedProfile(profileId: string): DerivedProfileDocument | null {
    const filePath = this.getProfileFilePath(profileId);
    if (!existsSync(filePath)) return null;
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      if (raw && typeof raw === 'object' && raw.profileId) {
        // Migration check
        if (raw.schemaVersion !== 1) {
          raw.schemaVersion = 1;
        }
        return raw as DerivedProfileDocument;
      }
      return null;
    } catch {
      return null;
    }
  }

  public upsertDerivedProfile(
    input: Partial<DerivedProfileDocument> & {
      profileId: string;
      algorithmVersion: string;
      profileFingerprint: string;
      items: Record<string, DerivedProfileItem>;
    }
  ): { updated: boolean; count: number } {
    const { profileId, algorithmVersion, profileFingerprint, items } = input;
    const existing = this.readDerivedProfile(profileId);
    const filePath = this.getProfileFilePath(profileId);

    // No-op check: if algorithmVersion, profileFingerprint, and items didn't change, do not touch file
    if (
      existing &&
      existing.algorithmVersion === algorithmVersion &&
      existing.profileFingerprint === profileFingerprint &&
      Object.keys(existing.items || {}).length === Object.keys(items || {}).length
    ) {
      let identical = true;
      for (const [k, v] of Object.entries(items)) {
        const ev = existing.items[k];
        if (!ev || ev.matchScore !== v.matchScore || ev.lifecycleRing !== v.lifecycleRing) {
          identical = false;
          break;
        }
      }
      if (identical) {
        return { updated: false, count: Object.keys(existing.items).length };
      }
    }

    // Merge items keyed deterministically
    const mergedItems: Record<string, DerivedProfileItem> = existing ? { ...existing.items } : {};
    for (const [mediaKey, item] of Object.entries(items)) {
      mergedItems[mediaKey] = {
        mediaKey,
        matchScore: item.matchScore,
        lifecycleRing: item.lifecycleRing,
        signals: item.signals,
        reasons: item.reasons,
        calculatedAt: item.calculatedAt || new Date().toISOString(),
      };
    }

    const doc: DerivedProfileDocument = {
      schemaVersion: 1,
      profileId,
      algorithmVersion,
      profileFingerprint,
      generatedAt: new Date().toISOString(),
      items: mergedItems,
    };

    writeFileSync(filePath, stringifyDeterministic(doc), 'utf8');
    return { updated: true, count: Object.keys(mergedItems).length };
  }

  // --- SYNC & GITHUB OPERATIONS ---

  public getSyncStatus(): SyncStatus {
    const configured = Boolean(this.githubToken && this.githubOwner && this.githubRepo);
    const movies = this.readCatalog('movie');
    const tv = this.readCatalog('tv');

    let profilesCount = 0;
    try {
      const dirContents = existsSync(this.profilesDir) ? readdirSync(this.profilesDir) : [];
      profilesCount = dirContents.filter((f: string) => f.endsWith('.json')).length;
    } catch {
      profilesCount = 0;
    }

    return {
      configured,
      mode: configured ? 'github' : 'local_only',
      reason: !configured ? 'GitHub token veya hedef repository yapılandırılmadı' : undefined,
      isPublicRepo: this.isPublicRepo,
      lastSyncAt: this.lastSyncAt,
      catalogCounts: {
        movies: Object.keys(movies).length,
        tv: Object.keys(tv).length,
      },
      profilesCount,
      remoteTarget: configured
        ? {
            owner: this.githubOwner!,
            repo: this.githubRepo!,
            branch: this.githubBranch,
          }
        : undefined,
    };
  }

  /**
   * Commit a file to GitHub via Contents API with SHA conflict management.
   */
  public async commitFileToGitHub(
    repoPath: string,
    contentString: string,
    commitMessage: string
  ): Promise<{ ok: boolean; sha?: string; error?: string; skippedNoop?: boolean }> {
    if (!this.githubToken || !this.githubOwner || !this.githubRepo) {
      return { ok: false, error: 'GitHub configuration missing' };
    }

    const apiUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/contents/${repoPath}`;
    const baseHeaders = {
      Authorization: `Bearer ${this.githubToken}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'CineTrack-Sync-Agent',
    };

    let remoteSha: string | undefined;
    let remoteContent: string | undefined;

    // 1. Fetch current remote file SHA & content
    try {
      const getRes = await fetch(`${apiUrl}?ref=${this.githubBranch}`, { headers: baseHeaders });
      if (getRes.status === 200) {
        const fileData = await getRes.json();
        remoteSha = fileData.sha;
        if (fileData.content) {
          remoteContent = Buffer.from(fileData.content, 'base64').toString('utf8');
        }
      } else if (getRes.status !== 404) {
        return { ok: false, error: `GitHub API error fetching file: HTTP ${getRes.status}` };
      }
    } catch (e: any) {
      return { ok: false, error: `Network error connecting to GitHub: ${e?.message || e}` };
    }

    // 2. Prevent no-op commit if content is identical
    if (remoteContent && remoteContent.trim() === contentString.trim()) {
      return { ok: true, sha: remoteSha, skippedNoop: true };
    }

    // 3. Put content (with retry on 409 conflict)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const payload: any = {
        message: commitMessage,
        content: Buffer.from(contentString, 'utf8').toString('base64'),
        branch: this.githubBranch,
      };
      if (remoteSha) payload.sha = remoteSha;

      try {
        const putRes = await fetch(apiUrl, {
          method: 'PUT',
          headers: { ...baseHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (putRes.status === 200 || putRes.status === 201) {
          const resData = await putRes.json();
          return { ok: true, sha: resData.content?.sha };
        }

        if (putRes.status === 409) {
          // Conflict: re-fetch SHA and retry
          const refetch = await fetch(`${apiUrl}?ref=${this.githubBranch}`, { headers: baseHeaders });
          if (refetch.status === 200) {
            const refetchedData = await refetch.json();
            remoteSha = refetchedData.sha;
            continue;
          }
        }

        const errJson = await putRes.json().catch(() => ({}));
        return { ok: false, error: `GitHub commit rejected: HTTP ${putRes.status} ${errJson.message || ''}` };
      } catch (e: any) {
        if (attempt === 3) return { ok: false, error: `Commit attempt failed: ${e?.message || e}` };
      }
    }

    return { ok: false, error: 'Max commit retries exceeded' };
  }

  /**
   * Sync catalog and profile data according to security rules.
   */
  public async syncToGitHub(): Promise<SyncResult> {
    const result: SyncResult = {
      ok: true,
      filesCommitted: [],
      filesSkipped: [],
      filesBlockedPublic: [],
      errors: [],
    };

    if (!this.githubToken || !this.githubOwner || !this.githubRepo) {
      result.ok = false;
      result.errors.push('GitHub senkronizasyonu için ortam değişkenleri (token, owner, repo) eksik.');
      return result;
    }

    // Sync Catalog files (movies, tv, manifest)
    for (const [relPath, filePath] of [
      ['data/catalog/movies.json', this.moviesFile],
      ['data/catalog/tv.json', this.tvFile],
      ['data/catalog/manifest.json', this.manifestFile],
    ]) {
      if (!existsSync(filePath)) continue;
      const content = readFileSync(filePath, 'utf8');
      const commitRes = await this.commitFileToGitHub(
        relPath,
        content,
        `chore(catalog): sync ${path.basename(relPath)} [skip ci]`
      );
      if (commitRes.ok) {
        if (commitRes.skippedNoop) {
          result.filesSkipped.push(relPath);
        } else {
          result.filesCommitted.push(relPath);
        }
      } else {
        result.errors.push(`${relPath}: ${commitRes.error}`);
        result.ok = false;
      }
    }

    // Sync Derived Profiles (SECURITY RULE: NEVER sync profile data to public repo)
    if (this.isPublicRepo) {
      result.filesBlockedPublic.push('data/profiles/* (Public repo: kişisel profil verisi güvenliği için senkron engellendi)');
    } else {
      if (existsSync(this.profilesDir)) {
        const profileFiles = readdirSync(this.profilesDir);
        for (const file of profileFiles) {
          if (!file.endsWith('.json')) continue;
          const fullPath = path.join(this.profilesDir, file);
          const relPath = `data/profiles/${file}`;
          const content = readFileSync(fullPath, 'utf8');

          const commitRes = await this.commitFileToGitHub(
            relPath,
            content,
            `chore(profile): sync derived data for ${file} [skip ci]`
          );
          if (commitRes.ok) {
            if (commitRes.skippedNoop) {
              result.filesSkipped.push(relPath);
            } else {
              result.filesCommitted.push(relPath);
            }
          } else {
            result.errors.push(`${relPath}: ${commitRes.error}`);
            result.ok = false;
          }
        }
      }
    }

    if (result.ok) {
      this.lastSyncAt = new Date().toISOString();
    }

    return result;
  }
}

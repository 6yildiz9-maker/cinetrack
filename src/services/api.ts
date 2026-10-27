import { type DataDocument } from '../core/cinetrack-core';
import type { BidirectionalSyncReport, SyncOperationKind } from '../core/sync-display';

export type TmdbDataSource = 'live' | 'demo' | 'stale-cache' | 'error' | 'unknown';

export interface TmdbSourceMeta {
  source: TmdbDataSource;
  cacheStatus: 'hit' | 'miss' | 'stale' | 'none';
  staleReason?: string;
  staleAgeSeconds?: number;
  timestamp: number;
}

export interface ServerBackupMetadata {
  id: string;
  fileName: string;
  createdAt: string;
  sizeBytes: number;
  revision: number;
  profilesCount: number;
  itemsCount: number;
}

export interface ServerConflictDetail {
  code: 'revision_conflict' | 'sudden_item_drop';
  message: string;
  currentRevision?: number;
  expectedRevision?: number;
  existingItems?: number;
  incomingItems?: number;
  serverDocument?: DataDocument;
}

export interface PushServerDataResult {
  ok: boolean;
  status: number;
  revision?: number;
  updatedAt?: string;
  conflict?: ServerConflictDetail;
  errorMessage?: string;
}

let currentTmdbSourceState: TmdbSourceMeta = {
  source: 'unknown',
  cacheStatus: 'none',
  timestamp: Date.now(),
};

let lastKnownServerRevision: number | null = null;

export function getLastKnownServerRevision(): number | null {
  return lastKnownServerRevision;
}

export function setLastKnownServerRevision(rev: number | null): void {
  lastKnownServerRevision = typeof rev === 'number' && Number.isSafeInteger(rev) && rev >= 0 ? rev : null;
}

type TmdbSourceListener = (state: TmdbSourceMeta) => void;
const tmdbSourceListeners = new Set<TmdbSourceListener>();

export function getTmdbSourceState(): TmdbSourceMeta {
  return currentTmdbSourceState;
}

export function subscribeTmdbSource(listener: TmdbSourceListener): () => void {
  tmdbSourceListeners.add(listener);
  listener(currentTmdbSourceState);
  return () => {
    tmdbSourceListeners.delete(listener);
  };
}

export function setTmdbSourceState(state: Partial<TmdbSourceMeta>): void {
  currentTmdbSourceState = {
    ...currentTmdbSourceState,
    ...state,
    timestamp: Date.now(),
  };
  tmdbSourceListeners.forEach((fn) => {
    try {
      fn(currentTmdbSourceState);
    } catch (e) {
      console.warn('TmdbSource listener error:', e);
    }
  });
}

export function parseTmdbSourceFromHeaders(headers: Headers): {
  source: TmdbDataSource;
  cacheStatus: 'hit' | 'miss' | 'stale' | 'none';
  staleReason?: string;
  staleAgeSeconds?: number;
} {
  const rawSource = headers.get('X-CineTrack-Source') as TmdbDataSource | null;
  const rawCache = headers.get('X-CineTrack-Cache') as 'hit' | 'miss' | 'stale' | null;
  const staleReason = headers.get('X-CineTrack-Stale-Reason') || undefined;
  const rawAge = headers.get('X-CineTrack-Stale-Age-Seconds');
  const staleAgeSeconds = rawAge ? Number(rawAge) : undefined;

  const source: TmdbDataSource =
    rawSource === 'live' || rawSource === 'demo' || rawSource === 'stale-cache' || rawSource === 'error'
      ? rawSource
      : 'unknown';

  return {
    source,
    cacheStatus: rawCache || 'none',
    staleReason,
    staleAgeSeconds,
  };
}

/**
 * Faz 5: TMDB yanıt şeması doğrulaması (bozuk / beklenmeyen upstream JSON yapılarına karşı koruma).
 */
export function validateTmdbResponseShape(
  path: string,
  data: unknown
): { valid: boolean; reason?: string } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, reason: 'TMDB yanıtı geçerli bir JSON nesnesi değil.' };
  }

  const record = data as Record<string, any>;

  if (path === '/genre/movie/list' || path === '/genre/tv/list') {
    if (!Array.isArray(record.genres)) {
      return { valid: false, reason: 'Tür listesi yanıtında "genres" dizisi eksik.' };
    }
    return { valid: true };
  }

  if (path.endsWith('/combined_credits')) {
    if (!Array.isArray(record.cast)) {
      return { valid: false, reason: 'Oyuncu filmografisi yanıtında "cast" dizisi eksik.' };
    }
    return { valid: true };
  }

  if (path.endsWith('/watch/providers')) {
    if (record.results == null || typeof record.results !== 'object' || Array.isArray(record.results)) {
      return { valid: false, reason: 'Yayın sağlayıcıları yanıtında "results" nesnesi eksik.' };
    }
    return { valid: true };
  }

  if (/^\/tv\/\d+\/season\/\d+$/.test(path)) {
    if (!Array.isArray(record.episodes)) {
      return { valid: false, reason: 'Sezon detay yanıtında "episodes" dizisi eksik.' };
    }
    return { valid: true };
  }

  if (
    path.startsWith('/trending/') ||
    path.startsWith('/discover/') ||
    path.startsWith('/search/') ||
    /^\/(?:movie|tv)\/(?:popular|top_rated|upcoming|now_playing|on_the_air)$/.test(path) ||
    /^\/(?:movie|tv)\/\d+\/(?:recommendations|similar)$/.test(path)
  ) {
    if (!Array.isArray(record.results)) {
      return { valid: false, reason: 'Katalog listesi yanıtında "results" dizisi eksik.' };
    }
    return { valid: true };
  }

  if (/^\/(?:movie|tv|person)\/\d+$/.test(path)) {
    if (record.id == null || (typeof record.id !== 'number' && typeof record.id !== 'string')) {
      return { valid: false, reason: 'Detay yanıtında geçerli "id" alanı eksik.' };
    }
    return { valid: true };
  }

  return { valid: true };
}

export async function fetchTmdb(path: string, params: Record<string, string> = {}, signal?: AbortSignal) {
  const query = new URLSearchParams({ path, language: 'tr-TR', ...params });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  let response: globalThis.Response;
  try {
    const signals = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    response = await fetch(`/api/tmdb?${query.toString()}`, { signal: signals });
  } catch (error: any) {
    if (signal?.aborted) throw error;
    setTmdbSourceState({ source: 'error', cacheStatus: 'none', staleReason: error.message });
    if (error.name === 'AbortError') {
      throw new Error('TMDB isteği zaman aşımına uğradı. Biraz sonra tekrar deneyin.', { cause: error });
    }
    throw new Error('Yerel TMDB servisine ulaşılamadı. Sunucunun çalıştığından emin olun.', { cause: error });
  } finally {
    clearTimeout(timeout);
  }

  const { source, cacheStatus, staleReason, staleAgeSeconds } = parseTmdbSourceFromHeaders(response.headers);

  if (!response.ok) {
    setTmdbSourceState({
      source: source === 'unknown' ? 'error' : source,
      cacheStatus,
      staleReason,
    });
    let detail = '';
    try {
      detail = (await response.json()).status_message || '';
    } catch {
      // response is not json
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(detail || 'TMDB isteği reddedildi.');
    }
    if (response.status === 429) {
      throw new Error(detail || 'TMDB istek sınırına ulaşıldı. Biraz bekleyip tekrar deneyin.');
    }
    throw new Error(detail || `TMDB isteği başarısız oldu (${response.status}).`);
  }

  const data = await response.json();
  const shapeValidation = validateTmdbResponseShape(path, data);
  if (!shapeValidation.valid) {
    setTmdbSourceState({ source: 'error', cacheStatus, staleReason: shapeValidation.reason });
    throw new Error(shapeValidation.reason || 'TMDB yanıt şeması geçersiz.');
  }

  setTmdbSourceState({
    source,
    cacheStatus,
    staleReason,
    staleAgeSeconds,
  });

  if (data && typeof data === 'object') {
    data._source = source;
    data._cacheStatus = cacheStatus;
    if (staleReason) data._staleReason = staleReason;
    if (staleAgeSeconds != null) data._staleAgeSeconds = staleAgeSeconds;

    if (Array.isArray(data.results)) {
      data.results.forEach((item: any) => {
        if (item && typeof item === 'object') {
          item._source = source;
        }
      });
    }
    if (Array.isArray(data.cast)) {
      data.cast.forEach((item: any) => {
        if (item && typeof item === 'object') {
          item._source = source;
        }
      });
    }
  }

  return data;
}

export const TMDB_CACHE_TTLS = Object.freeze({
  ACTOR_CREDITS: 2 * 60 * 60_000,
  PERSON_DETAILS: 2 * 60 * 60_000,
  MEDIA_DETAILS: 60 * 60_000,
  WATCH_PROVIDERS: 60 * 60_000,
  DISCOVER_CATALOG: 15 * 60_000,
  SEARCH_RESULTS: 15 * 60_000,
  TRENDING: 10 * 60_000,
  DEFAULT: 30 * 60_000,
});

export function resolveTmdbCacheTtl(path: string): number {
  if (path.includes('/person/') && path.includes('/combined_credits')) {
    return TMDB_CACHE_TTLS.ACTOR_CREDITS;
  }
  if (path.startsWith('/person/')) {
    return TMDB_CACHE_TTLS.PERSON_DETAILS;
  }
  if (path.includes('/watch/providers')) {
    return TMDB_CACHE_TTLS.WATCH_PROVIDERS;
  }
  if (/^\/tv\/\d+\/season\/\d+$/.test(path)) {
    return TMDB_CACHE_TTLS.MEDIA_DETAILS;
  }
  if (/^\/(movie|tv)\/\d+/.test(path)) {
    return TMDB_CACHE_TTLS.MEDIA_DETAILS;
  }
  if (path.startsWith('/discover/')) {
    return TMDB_CACHE_TTLS.DISCOVER_CATALOG;
  }
  if (path.startsWith('/search/')) {
    return TMDB_CACHE_TTLS.SEARCH_RESULTS;
  }
  if (path.startsWith('/trending/')) {
    return TMDB_CACHE_TTLS.TRENDING;
  }
  return TMDB_CACHE_TTLS.DEFAULT;
}

const tmdbClientCache = new Map<string, { at: number; data: any; ttl: number }>();
const inFlightTmdbRequests = new Map<string, Promise<any>>();

export function clearTmdbClientCache(): void {
  tmdbClientCache.clear();
}

export function getInFlightTmdbRequestCount(): number {
  return inFlightTmdbRequests.size;
}

export function fetchTmdbCached(
  path: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
  ttl?: number
): Promise<any> {
  const effectiveTtl = typeof ttl === 'number' && ttl > 0 ? ttl : resolveTmdbCacheTtl(path);
  const key = new URLSearchParams({ path, language: 'tr-TR', ...params }).toString();

  const hit = tmdbClientCache.get(key);
  if (hit && Date.now() - hit.at < (hit.ttl || effectiveTtl)) {
    tmdbClientCache.delete(key);
    tmdbClientCache.set(key, hit);
    return Promise.resolve(hit.data);
  }

  const existingInFlight = inFlightTmdbRequests.get(key);
  if (existingInFlight) {
    return existingInFlight;
  }

  const requestPromise = fetchTmdb(path, params, signal)
    .then((data) => {
      tmdbClientCache.set(key, { at: Date.now(), data, ttl: effectiveTtl });
      if (tmdbClientCache.size > 500) {
        tmdbClientCache.delete(tmdbClientCache.keys().next().value!);
      }
      return data;
    })
    .finally(() => {
      inFlightTmdbRequests.delete(key);
    });

  inFlightTmdbRequests.set(key, requestPromise);
  return requestPromise;
}

export async function fetchServerData(): Promise<DataDocument | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/api/data', {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (response.ok) {
      const doc: DataDocument = await response.json();
      if (typeof doc?.revision === 'number') {
        setLastKnownServerRevision(doc.revision);
      } else {
        const etag = response.headers.get('ETag') || '';
        const revMatch = etag.replace(/"/g, '').match(/^rev-(\d+)$/);
        if (revMatch) setLastKnownServerRevision(Number(revMatch[1]));
      }
      return doc;
    }
    return null;
  } catch (error) {
    console.error('CineTrack: yerel veri dosyası okunamadı.', error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function pushServerDataDetailed(
  payload: DataDocument,
  options: { baseRevision?: number | null; confirmBulkDelete?: boolean } = {}
): Promise<PushServerDataResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const revToCheck = options.baseRevision !== undefined ? options.baseRevision : lastKnownServerRevision;
  if (typeof revToCheck === 'number' && revToCheck > 0) {
    headers['If-Match'] = `"rev-${revToCheck}"`;
  }
  if (options.confirmBulkDelete) {
    headers['X-CineTrack-Confirm-Drop'] = '1';
  }

  try {
    const response = await fetch('/api/data', {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
    });

    let bodyJson: any = null;
    try {
      bodyJson = await response.json();
    } catch {
      bodyJson = null;
    }

    if (response.ok) {
      if (typeof bodyJson?.revision === 'number') {
        setLastKnownServerRevision(bodyJson.revision);
      }
      return {
        ok: true,
        status: response.status,
        revision: bodyJson?.revision,
        updatedAt: bodyJson?.updatedAt,
      };
    }

    if (
      response.status === 409 &&
      (bodyJson?.code === 'revision_conflict' || bodyJson?.code === 'sudden_item_drop')
    ) {
      return {
        ok: false,
        status: 409,
        conflict: {
          code: bodyJson.code,
          message: bodyJson.status_message || 'Sunucu veri çakışması algılandı.',
          currentRevision: bodyJson.currentRevision,
          expectedRevision: bodyJson.expectedRevision,
          existingItems: bodyJson.existingItems,
          incomingItems: bodyJson.incomingItems,
          serverDocument: bodyJson.serverDocument,
        },
        errorMessage: bodyJson.status_message,
      };
    }

    return {
      ok: false,
      status: response.status,
      errorMessage: bodyJson?.status_message || `Sunucu kaydı başarısız (${response.status}).`,
    };
  } catch (error: any) {
    console.error('CineTrack: yerel veri dosyasına yazılamadı.', error);
    return {
      ok: false,
      status: 0,
      errorMessage: error?.message || 'Ağ bağlantı hatası.',
    };
  }
}

export async function pushServerData(payload: DataDocument): Promise<boolean> {
  const res = await pushServerDataDetailed(payload);
  return res.ok;
}

export async function fetchServerBackups(): Promise<ServerBackupMetadata[]> {
  try {
    const res = await fetch('/api/data/backups', {
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.backups) ? data.backups : [];
  } catch {
    return [];
  }
}

export async function restoreServerBackup(backupId: string): Promise<DataDocument | null> {
  try {
    const res = await fetch('/api/data/restore', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ backupId }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data?.revision === 'number') {
      setLastKnownServerRevision(data.revision);
    }
    return data?.document || null;
  } catch {
    return null;
  }
}

export async function checkServerTmdbStatus(): Promise<{
  configured: boolean;
  source: TmdbDataSource;
  cacheEntries: number;
} | null> {
  try {
    const res = await fetch('/api/tmdb-status', { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    setTmdbSourceState({ source: json.source as TmdbDataSource });
    return json;
  } catch {
    return null;
  }
}

export function getTmdbSourceLabel(source: TmdbDataSource): string {
  switch (source) {
    case 'live':
      return 'Canlı TMDB';
    case 'stale-cache':
      return 'Eski Önbellek (Offline)';
    case 'demo':
      return 'Örnek Katalog (Demo)';
    case 'error':
      return 'Bağlantı Hatası';
    default:
      return 'Bilinmiyor';
  }
}

export function getTmdbSourceDescription(source: TmdbDataSource, staleReason?: string): string {
  switch (source) {
    case 'live':
      return 'TMDB API servisine doğrudan ve canlı bağlanılıyor.';
    case 'stale-cache':
      return `TMDB canlı servisi anlık yanıt vermedi${
        staleReason ? ` (${staleReason})` : ''
      }; son kaydedilen önbellek verisi sunuluyor.`;
    case 'demo':
      return 'Sunucuda TMDB_API_KEY tanımlanmadığından örnek çevrimdışı katalog kullanılıyor.';
    case 'error':
      return 'TMDB servisine bağlanılamadı ve önbellekte veri bulunamadı.';
    default:
      return 'Veri kaynağı henüz belirlenmedi.';
  }
}

export async function fetchSyncStatus(): Promise<any> {
  try {
    const res = await fetch('/api/sync/status', { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function buildClientNetworkErrorReport(
  operation: SyncOperationKind,
  message: string
): BidirectionalSyncReport {
  const now = new Date().toISOString();
  const emptySide = {
    inspectedAt: now,
    catalogMovieCount: 0,
    catalogTvCount: 0,
    catalogRawMovieRecords: 0,
    catalogRawTvRecords: 0,
    catalogContentHash: null,
    catalogSemanticHash: null,
    manifestPresent: false,
    manifestValid: false,
    manifestMovieCount: null,
    manifestTvCount: null,
    manifestContentHash: null,
    userDataPresent: false,
    userProfilesCount: 0,
    userTotalSavedItemsCount: 0,
    userUniqueSavedItemsCount: 0,
    userDataSemanticHash: null,
    userDataRawHash: null,
    derivedProfileFilesCount: 0,
    derivedProfileTotalRecordsCount: 0,
    files: {},
  };
  return {
    ok: false,
    partialFailure: false,
    operation,
    startedAt: now,
    completedAt: now,
    isPublicRepo: false,
    localBefore: emptySide,
    remoteBefore: null,
    localAfter: emptySide,
    remoteAfter: null,
    comparison: null,
    filesDownloaded: [],
    filesUploaded: [],
    filesUnchanged: [],
    filesMerged: [],
    filesFailed: [],
    filesPending: [],
    filesBlockedPublic: [],
    recordsAdded: 0,
    recordsUpdated: 0,
    recordsConflicted: 0,
    conflicts: [],
    warnings: [],
    errors: [{ category: 'network_error', message }],
    verifiedEqual: false,
  };
}

export async function inspectGitHubSync(): Promise<BidirectionalSyncReport> {
  try {
    const res = await fetch('/api/sync/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    return (await res.json()) as BidirectionalSyncReport;
  } catch (e: any) {
    return buildClientNetworkErrorReport(
      'inspect',
      e?.message || 'GitHub durum denetimi isteği başarısız oldu.'
    );
  }
}

export async function pullGitHubSync(
  conflictStrategy: 'ask' | 'merge' | 'overwrite_with_remote' = 'ask'
): Promise<BidirectionalSyncReport> {
  try {
    const res = await fetch('/api/sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conflictStrategy }),
    });
    const report = (await res.json()) as BidirectionalSyncReport;
    if (typeof report?.serverRevision === 'number') {
      setLastKnownServerRevision(report.serverRevision);
    }
    return report;
  } catch (e: any) {
    return buildClientNetworkErrorReport(
      'pull',
      e?.message || 'GitHub indirme isteği başarısız oldu.'
    );
  }
}

export async function pushGitHubSync(): Promise<BidirectionalSyncReport> {
  try {
    const res = await fetch('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    return (await res.json()) as BidirectionalSyncReport;
  } catch (e: any) {
    return buildClientNetworkErrorReport(
      'push',
      e?.message || 'GitHub yükleme isteği başarısız oldu.'
    );
  }
}

export async function reconcileGitHubSync(): Promise<BidirectionalSyncReport> {
  try {
    const res = await fetch('/api/sync/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const report = (await res.json()) as BidirectionalSyncReport;
    if (typeof report?.serverRevision === 'number') {
      setLastKnownServerRevision(report.serverRevision);
    }
    return report;
  } catch (e: any) {
    return buildClientNetworkErrorReport(
      'reconcile',
      e?.message || 'İki yönlü eşitleme isteği başarısız oldu.'
    );
  }
}

export async function triggerGitHubSync(): Promise<any> {
  try {
    const res = await fetch('/api/sync/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    return await res.json();
  } catch (e: any) {
    return { ok: false, errors: [e?.message || 'GitHub eşitleme isteği başarısız oldu.'] };
  }
}

export async function fetchCatalogItems(type?: 'movie' | 'tv'): Promise<any> {
  try {
    const query = type ? `?type=${encodeURIComponent(type)}` : '';
    const res = await fetch(`/api/catalog${query}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function pushCatalogItems(items: any[]): Promise<any> {
  if (!Array.isArray(items) || items.length === 0) return null;
  try {
    const res = await fetch('/api/catalog/upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchDerivedProfileData(
  profileId: string,
  expected?: {
    profileFingerprint?: string;
    algorithmVersion?: string;
    sourceCatalogHash?: string;
  }
): Promise<any> {
  if (!profileId) return null;
  try {
    const params = new URLSearchParams();
    if (expected?.profileFingerprint) params.set('profileFingerprint', expected.profileFingerprint);
    if (expected?.algorithmVersion) params.set('algorithmVersion', expected.algorithmVersion);
    if (expected?.sourceCatalogHash) params.set('sourceCatalogHash', expected.sourceCatalogHash);
    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(
      `/api/profiles/derived/${encodeURIComponent(profileId)}${query}`,
      { cache: 'no-store' }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function pushDerivedProfileData(data: {
  profileId: string;
  algorithmVersion: string;
  profileFingerprint: string;
  sourceCatalogHash?: string;
  schemaVersion?: number;
  items: Record<string, any>;
}): Promise<any> {
  try {
    const res = await fetch('/api/profiles/derived/upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}


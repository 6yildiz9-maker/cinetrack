import { type DataDocument } from '../core/cinetrack-core.ts';
import type { BidirectionalSyncReport, SyncOperationKind } from '../core/sync-display.ts';

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
  code: 'revision_conflict' | 'precondition_required' | 'sudden_item_drop';
  message: string;
  currentRevision?: number;
  expectedRevision?: number;
  existingItems?: number;
  incomingItems?: number;
  serverDocument?: DataDocument;
  localPayload?: DataDocument;
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
  options: { baseRevision?: number | null; confirmBulkDelete?: boolean; forceOverwrite?: boolean } = {}
): Promise<PushServerDataResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const revToCheck = options.baseRevision !== undefined ? options.baseRevision : lastKnownServerRevision;
  if (options.forceOverwrite) {
    headers['X-CineTrack-Force-Write'] = '1';
  } else if (typeof revToCheck === 'number' && Number.isSafeInteger(revToCheck) && revToCheck >= 0) {
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
      (response.status === 409 || response.status === 412 || response.status === 428) &&
      (bodyJson?.code === 'revision_conflict' ||
        bodyJson?.code === 'precondition_required' ||
        bodyJson?.code === 'sudden_item_drop' ||
        response.status === 412 ||
        response.status === 428)
    ) {
      return {
        ok: false,
        status: response.status,
        conflict: {
          code: bodyJson?.code || 'revision_conflict',
          message: bodyJson?.status_message || 'Sunucu veri çakışması algılandı.',
          currentRevision: bodyJson?.currentRevision,
          expectedRevision: bodyJson?.expectedRevision,
          existingItems: bodyJson?.existingItems,
          incomingItems: bodyJson?.incomingItems,
          serverDocument: bodyJson?.serverDocument,
          localPayload: payload,
        },
        errorMessage: bodyJson?.status_message,
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

export async function testGitHubConnection(forceWriteProbe = true): Promise<any> {
  try {
    const res = await fetch('/api/sync/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceWriteProbe }),
    });
    return await res.json();
  } catch (e: any) {
    return {
      ok: false,
      step: 'probe_failed',
      error: e?.message || 'GitHub bağlantı testi isteği başarısız oldu.',
    };
  }
}

export async function setPublicRepoPersonalSyncConsent(
  allowPersonalDataInPublicRepo: boolean
): Promise<any> {
  try {
    const res = await fetch('/api/sync/public-consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allowPersonalDataInPublicRepo,
        confirmPublicVisibility: allowPersonalDataInPublicRepo,
      }),
    });
    return await res.json();
  } catch (e: any) {
    return {
      ok: false,
      status_message: e?.message || 'Açık depo onay tercihi güncellenemedi.',
    };
  }
}

export async function runStagedGitHubSync(forceWriteProbe = true): Promise<any> {
  try {
    const res = await fetch('/api/sync/staged', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceWriteProbe }),
    });
    const report = await res.json();
    if (typeof report?.bidirectionalReport?.serverRevision === 'number') {
      setLastKnownServerRevision(report.bidirectionalReport.serverRevision);
    }
    return report;
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message || 'Aşamalı GitHub senkronizasyon isteği başarısız oldu.',
    };
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

export interface BackupSheetBreakdown {
  total: number;
  movie: number;
  tv: number;
}

export interface SingleBackupOutcomeClient {
  attempted: boolean;
  ok: boolean;
  fileName?: string;
  relativePath?: string;
  downloadUrl?: string;
  sizeBytes?: number;
  sha256?: string;
  error?: string;
}

export interface ProfileBackupExportReportClient {
  ok: boolean;
  partialFailure: boolean;
  exportedAt: string;
  profileId: string;
  profileName: string;
  jsonBackup: SingleBackupOutcomeClient;
  excelBackup: SingleBackupOutcomeClient & {
    sheetNames?: string[];
    sheetCounts?: Record<'İzlenen' | 'İzlenecek' | 'İzleniyor' | 'İlgilenmiyorum', BackupSheetBreakdown>;
    totalItemsCount?: number;
    movieCount?: number;
    tvCount?: number;
    embeddedPostersCount?: number;
    placeholderPostersCount?: number;
    missingPosterSourceCount?: number;
    posterErrorsCount?: number;
    posterErrors?: Array<{ mediaKey: string; title: string; posterUrl: string; reason: string }>;
    dualStateKeys?: string[];
    sourceDiagnostics?: Record<string, any>;
    packageInspection?: Record<string, any>;
  };
  githubUpload: {
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
  };
  status_message?: string;
}

export async function createProfileBackupExport(params: {
  profileId: string;
  profileSnapshot?: any;
  dislikedItemsHint?: any[];
  genresMap?: Record<number, string>;
  includeJson?: boolean;
  includeXlsx?: boolean;
  uploadToGithub?: boolean;
  allowPersonalDataInPublicRepo?: boolean;
}): Promise<ProfileBackupExportReportClient> {
  try {
    const res = await fetch('/api/backup/profile-export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const json = await res.json();
    return json as ProfileBackupExportReportClient;
  } catch (e: any) {
    const msg = e?.message || 'Profil yedeği dışa aktarma isteği başarısız oldu.';
    return {
      ok: false,
      partialFailure: false,
      exportedAt: new Date().toISOString(),
      profileId: params.profileId,
      profileName: '',
      jsonBackup: { attempted: Boolean(params.includeJson), ok: false, error: msg },
      excelBackup: { attempted: Boolean(params.includeXlsx ?? true), ok: false, error: msg },
      githubUpload: {
        attempted: Boolean(params.uploadToGithub),
        ok: false,
        verifiedReadBack: false,
        error: msg,
      },
      status_message: msg,
    };
  }
}

export interface XlsxBinaryValidationResult {
  ok: boolean;
  sizeBytes: number;
  reason?: string;
}

/**
 * Validates that downloaded bytes represent a genuine OpenXML ZIP (.xlsx) binary
 * rather than an HTML fallback page (~10 KB index.html / auth gate), JSON error, or `[object Object]`.
 */
export function validateDownloadedXlsxBytes(
  bytes: ArrayBuffer | Uint8Array,
  options?: {
    contentType?: string | null;
    expectedSizeBytes?: number;
    expectedSha256?: string;
    computedSha256?: string | null;
  }
): XlsxBinaryValidationResult {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ct = String(options?.contentType || '').toLowerCase();

  if (ct.includes('text/html') || ct.includes('application/json') || ct.includes('text/plain')) {
    return {
      ok: false,
      sizeBytes: u8.byteLength,
      reason: `Sunucu ikili Excel (.xlsx) dosyası yerine '${options?.contentType}' yanıtı döndürdü.`,
    };
  }

  if (u8.byteLength < 100) {
    return {
      ok: false,
      sizeBytes: u8.byteLength,
      reason: `İndirilen dosya çok küçük (${u8.byteLength} bayt); geçerli bir .xlsx arşivi değil.`,
    };
  }

  // Must start with ZIP Local File Header signature PK\x03\x04 (0x50 0x4b 0x03 0x04)
  if (u8[0] !== 0x50 || u8[1] !== 0x4b || u8[2] !== 0x03 || u8[3] !== 0x04) {
    let preview = '';
    try {
      preview = new TextDecoder('utf-8').decode(u8.subarray(0, 64)).trim();
    } catch {
      preview = '';
    }
    if (/^<!doctype\s+html|^<html/i.test(preview)) {
      return {
        ok: false,
        sizeBytes: u8.byteLength,
        reason: `İndirme yanıtı ikili Excel (.xlsx) yerine HTML sayfası döndürdü (${u8.byteLength} bayt).`,
      };
    }
    if (preview.startsWith('{') || preview.startsWith('[')) {
      return {
        ok: false,
        sizeBytes: u8.byteLength,
        reason: `İndirme yanıtı ikili Excel (.xlsx) yerine JSON/metin verisi döndürdü (${u8.byteLength} bayt).`,
      };
    }
    return {
      ok: false,
      sizeBytes: u8.byteLength,
      reason: `İndirilen veri geçerli bir ZIP/XLSX imzasına (PK\\x03\\x04) sahip değil (${u8.byteLength} bayt).`,
    };
  }

  if (
    typeof options?.expectedSizeBytes === 'number' &&
    options.expectedSizeBytes > 0 &&
    u8.byteLength !== options.expectedSizeBytes
  ) {
    return {
      ok: false,
      sizeBytes: u8.byteLength,
      reason: `İndirilen boyut (${u8.byteLength} bayt) üretilen Excel boyutuyla (${options.expectedSizeBytes} bayt) eşleşmiyor.`,
    };
  }

  if (
    options?.expectedSha256 &&
    options?.computedSha256 &&
    options.expectedSha256.trim().toLowerCase() !== options.computedSha256.trim().toLowerCase()
  ) {
    return {
      ok: false,
      sizeBytes: u8.byteLength,
      reason: 'İndirilen dosyanın SHA-256 özeti sunucuda üretilen Excel dosyasıyla eşleşmiyor.',
    };
  }

  return { ok: true, sizeBytes: u8.byteLength };
}

export async function computeSha256HexBrowser(buffer: ArrayBuffer): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle?.digest) return null;
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i += 1) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  } catch {
    return null;
  }
}

export interface VerifiedBackupBlobDownload {
  blob: Blob;
  sizeBytes: number;
  sha256: string | null;
  fileName: string;
  usedStreamFallback: boolean;
}

/**
 * Downloads a generated `.xlsx` or `.json` backup via authenticated `fetch()` -> `ArrayBuffer`,
 * verifies binary signature, byte size, and SHA-256, and falls back to single-request
 * `POST /api/backup/profile-export/stream` if ephemeral replica storage returns 404/HTML.
 */
export async function downloadVerifiedBackupBinary(params: {
  downloadUrl: string;
  fileName: string;
  kind: 'xlsx' | 'json';
  expectedSizeBytes?: number;
  expectedSha256?: string;
  fallbackStreamPayload?: {
    profileId: string;
    profileSnapshot?: any;
    dislikedItemsHint?: any[];
    genresMap?: Record<number, string>;
  };
  customFetch?: typeof fetch;
}): Promise<VerifiedBackupBlobDownload> {
  const fetcher = params.customFetch || globalThis.fetch.bind(globalThis);
  const acceptHeader =
    params.kind === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream'
      : 'application/json';

  let res = await fetcher(params.downloadUrl, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: acceptHeader },
  });

  let effectiveExpectedSize = params.expectedSizeBytes;
  let effectiveExpectedSha = params.expectedSha256;
  let effectiveFileName = params.fileName;
  let usedStreamFallback = false;

  const initialContentType = String(res.headers.get('content-type') || '').toLowerCase();
  if (
    params.kind === 'xlsx' &&
    params.fallbackStreamPayload &&
    (res.status === 404 || initialContentType.includes('text/html'))
  ) {
    res = await fetcher('/api/backup/profile-export/stream', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: acceptHeader,
      },
      body: JSON.stringify(params.fallbackStreamPayload),
    });
    usedStreamFallback = true;
    const headerLen = Number(res.headers.get('content-length') || 0);
    const headerSha = res.headers.get('x-cinetrack-sha256') || undefined;
    const headerName = res.headers.get('x-cinetrack-filename') || undefined;
    effectiveExpectedSize = headerLen > 0 ? headerLen : undefined;
    effectiveExpectedSha = headerSha;
    if (headerName) effectiveFileName = headerName;
  }

  if (!res.ok) {
    let errDetail = `HTTP ${res.status}`;
    try {
      const errJson = await res.json();
      if (errJson?.status_message) errDetail = errJson.status_message;
    } catch {
      // ignore non-json error body
    }
    throw new Error(`Yedek dosyası indirilemedi (${errDetail}).`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const computedSha256 = await computeSha256HexBrowser(arrayBuffer);
  const responseContentType = res.headers.get('content-type');
  const headerSha = res.headers.get('x-cinetrack-sha256') || effectiveExpectedSha;

  if (params.kind === 'xlsx') {
    const check = validateDownloadedXlsxBytes(arrayBuffer, {
      contentType: responseContentType,
      expectedSizeBytes: effectiveExpectedSize,
      expectedSha256: headerSha,
      computedSha256,
    });
    if (!check.ok) {
      throw new Error(check.reason || 'İndirilen Excel (.xlsx) dosyası doğrulamadan geçemedi.');
    }
    const blob = new Blob([arrayBuffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    return {
      blob,
      sizeBytes: arrayBuffer.byteLength,
      sha256: computedSha256 || headerSha || null,
      fileName: effectiveFileName,
      usedStreamFallback,
    };
  }

  // JSON verification
  const ctLower = String(responseContentType || '').toLowerCase();
  if (ctLower.includes('text/html')) {
    throw new Error('JSON yedeği yerine HTML yanıtı döndürüldü.');
  }
  const text = new TextDecoder('utf-8').decode(arrayBuffer);
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('İndirilen JSON yedeği geçerli bir JSON belgesi değil.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('İndirilen JSON yedeği boş veya geçersiz.');
  }
  if (
    typeof effectiveExpectedSize === 'number' &&
    effectiveExpectedSize > 0 &&
    arrayBuffer.byteLength !== effectiveExpectedSize
  ) {
    throw new Error(
      `İndirilen JSON boyutu (${arrayBuffer.byteLength} bayt) beklenen boyutla (${effectiveExpectedSize} bayt) eşleşmiyor.`
    );
  }
  if (
    headerSha &&
    computedSha256 &&
    headerSha.trim().toLowerCase() !== computedSha256.trim().toLowerCase()
  ) {
    throw new Error('İndirilen JSON yedeğinin SHA-256 özeti eşleşmiyor.');
  }

  const blob = new Blob([arrayBuffer], { type: 'application/json;charset=utf-8' });
  return {
    blob,
    sizeBytes: arrayBuffer.byteLength,
    sha256: computedSha256 || headerSha || null,
    fileName: effectiveFileName,
    usedStreamFallback,
  };
}



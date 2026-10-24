import { DataDocument } from '../core/cinetrack-core';

export type TmdbDataSource = 'live' | 'demo' | 'stale-cache' | 'error' | 'unknown';

export interface TmdbSourceMeta {
  source: TmdbDataSource;
  cacheStatus: 'hit' | 'miss' | 'stale' | 'none';
  staleReason?: string;
  staleAgeSeconds?: number;
  timestamp: number;
}

let currentTmdbSourceState: TmdbSourceMeta = {
  source: 'unknown',
  cacheStatus: 'none',
  timestamp: Date.now(),
};

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
      throw new Error('TMDB istek sınırına ulaşıldı. Biraz bekleyip tekrar deneyin.');
    }
    throw new Error(detail || `TMDB isteği başarısız oldu (${response.status}).`);
  }

  setTmdbSourceState({
    source,
    cacheStatus,
    staleReason,
    staleAgeSeconds,
  });

  const data = await response.json();
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

// Cache TTL'leri veri türüne göre ayrılmıştır
export const TMDB_CACHE_TTLS = Object.freeze({
  ACTOR_CREDITS: 2 * 60 * 60_000, // 2 saat: Oyuncu filmografisi çok nadir değişir
  PERSON_DETAILS: 2 * 60 * 60_000, // 2 saat: Oyuncu biyografi ve profil bilgisi
  MEDIA_DETAILS: 60 * 60_000, // 1 saat: Film/Dizi künyesi ve oyuncu kadrosu
  WATCH_PROVIDERS: 60 * 60_000, // 1 saat: Yayın sağlayıcıları
  DISCOVER_CATALOG: 15 * 60_000, // 15 dakika: Katalog keşif sayfaları
  SEARCH_RESULTS: 15 * 60_000, // 15 dakika: Çoklu arama sonuçları
  TRENDING: 10 * 60_000, // 10 dakika: Trend sıralamaları
  DEFAULT: 30 * 60_000, // 30 dakika: Varsayılan
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

// In-memory cache for TMDB responses
const tmdbClientCache = new Map<string, { at: number; data: any; ttl: number }>();
// In-flight istek paylaşımı (In-flight request deduplication):
// Aynı uç nokta için eşzamanlı istekler tek bir aktif Promise paylaşır.
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

  // 1. Önbellek kontrolü (Veri türüne göre TTL süresi dolmamışsa derhal dön)
  const hit = tmdbClientCache.get(key);
  if (hit && Date.now() - hit.at < (hit.ttl || effectiveTtl)) {
    tmdbClientCache.delete(key);
    tmdbClientCache.set(key, hit);
    return Promise.resolve(hit.data);
  }

  // 2. In-flight istek paylaşımı: Halihazırda devam eden aynı istek varsa mükerrer istek atma
  const existingInFlight = inFlightTmdbRequests.get(key);
  if (existingInFlight) {
    return existingInFlight;
  }

  // 3. Yeni istek başlat ve in-flight haritasına kaydet
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
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch('/api/data', { cache: 'no-store', signal: controller.signal });
    if (response.ok) {
      return await response.json();
    }
    return null;
  } catch (error) {
    console.error('CineTrack: yerel veri dosyası okunamadı.', error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function pushServerData(payload: DataDocument): Promise<boolean> {
  try {
    const response = await fetch('/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch (error) {
    console.error('CineTrack: yerel veri dosyasına yazılamadı.', error);
    return false;
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


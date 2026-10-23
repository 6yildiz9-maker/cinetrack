import { DataDocument } from '../core/cinetrack-core';

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
    if (error.name === 'AbortError') {
      throw new Error('TMDB isteği zaman aşımına uğradı. Biraz sonra tekrar deneyin.');
    }
    throw new Error('Yerel TMDB servisine ulaşılamadı. Sunucunun çalıştığından emin olun.');
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
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

  return response.json();
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

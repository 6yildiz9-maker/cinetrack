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

// In-memory cache for TMDB responses
const tmdbClientCache = new Map<string, { at: number; data: any }>();

export function fetchTmdbCached(
  path: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
  ttl = 30 * 60_000
): Promise<any> {
  const key = new URLSearchParams({ path, language: 'tr-TR', ...params }).toString();
  const hit = tmdbClientCache.get(key);
  if (hit && Date.now() - hit.at < ttl) {
    tmdbClientCache.delete(key);
    tmdbClientCache.set(key, hit);
    return Promise.resolve(hit.data);
  }
  return fetchTmdb(path, params, signal).then((data) => {
    tmdbClientCache.set(key, { at: Date.now(), data });
    if (tmdbClientCache.size > 400) {
      tmdbClientCache.delete(tmdbClientCache.keys().next().value!);
    }
    return data;
  });
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

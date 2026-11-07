// ===========================================================================
// Cinethos Taste Engine — Metadata Hydrator
//
// Zevk profiline giren içerikler için TMDB'den anahtar kelime, dil, ülke ve
// format alanlarını toplar. Sonuç data/taste altında önbelleğe yazılır; böylece
// her yeniden hesaplamada ağ çağrısı tekrarlanmaz.
//
// Kurallar:
// - TMDB anahtarı yalnızca ortamdan gelir (process.env.TMDB_API_KEY / server config)
// - Ağ hatası ana akışı bloklamaz; başarısız içerik sonraki turda yeniden denenir
// - data/cinetrack-data.json'a ASLA yazılmaz
// ===========================================================================

import path from "node:path";
import {
  readJsonFileWithRecoveryAsync,
  writeJsonFileAtomicAsync,
} from "./atomic-json.ts";
import type { TasteMetadataInput } from "../core/taste/types.ts";

export type CachedTasteMetadata = TasteMetadataInput & {
  fetchedAt: string;
  source: "tmdb";
};

export interface TasteMetadataCacheFile {
  schemaVersion: 1;
  updatedAt: string;
  items: Record<string, CachedTasteMetadata>;
}

export interface HydrationBatchResult {
  inputs: TasteMetadataInput[];
  attempted: number;
  fetched: number;
  failed: number;
  remaining: number;
}

const DEFAULT_BATCH_SIZE = 240;
const DEFAULT_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 8000;

export function resolveTasteMetadataCachePath(dataDir: string = "data"): string {
  return dataDir === "data"
    ? "data/taste/cinetrack-taste-metadata-cache.json"
    : path.join(dataDir, "taste", "cinetrack-taste-metadata-cache.json");
}

export async function readTasteMetadataCache(
  dataDir: string = "data"
): Promise<TasteMetadataCacheFile> {
  const result = await readJsonFileWithRecoveryAsync<TasteMetadataCacheFile>(
    resolveTasteMetadataCachePath(dataDir)
  );
  if (
    (result.status === "ok" || result.status === "recovered") &&
    result.data &&
    typeof result.data === "object" &&
    result.data.items &&
    typeof result.data.items === "object"
  ) {
    return result.data;
  }
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), items: {} };
}

async function writeTasteMetadataCache(
  cache: TasteMetadataCacheFile,
  dataDir: string
): Promise<void> {
  cache.updatedAt = new Date().toISOString();
  await writeJsonFileAtomicAsync(
    resolveTasteMetadataCachePath(dataDir),
    JSON.stringify(cache, null, 2)
  );
}

function toKeywordList(raw: unknown): Array<{ id: number; name?: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: number; name?: string }> = [];
  for (const entry of raw) {
    const id = Number(
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>).id
        : entry
    );
    if (!Number.isFinite(id) || id <= 0) continue;
    const name =
      entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).name === "string"
        ? String((entry as Record<string, unknown>).name)
        : undefined;
    out.push(name ? { id, name } : { id });
  }
  return out;
}

function toIdList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) =>
      Number(
        entry && typeof entry === "object"
          ? (entry as Record<string, unknown>).id
          : entry
      )
    )
    .filter((id) => Number.isFinite(id) && id > 0);
}

function toCountryList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim()) {
      out.push(entry.trim().toUpperCase());
    } else if (entry && typeof entry === "object") {
      const code = (entry as Record<string, unknown>).iso_3166_1;
      if (typeof code === "string" && code.trim()) out.push(code.trim().toUpperCase());
    }
  }
  return out;
}

/** TMDB details+keywords yanıtını TasteMetadataInput'a çevirir. */
export function normalizeTmdbMetadata(
  contentId: string,
  mediaType: "movie" | "tv",
  data: Record<string, unknown>
): TasteMetadataInput | null {
  const numericId = Number(contentId.split(":")[1]);
  if (!Number.isFinite(numericId) || numericId <= 0) return null;

  const keywordContainer =
    data.keywords && typeof data.keywords === "object"
      ? (data.keywords as Record<string, unknown>)
      : {};
  const keywords = toKeywordList(
    mediaType === "tv" ? keywordContainer.results : keywordContainer.keywords
  );
  const genreIds = toIdList(data.genres);
  const productionCountries = toCountryList(data.production_countries);
  const originCountry = toCountryList(data.origin_country);
  const episodeRunTime = toIdList(data.episode_run_time);
  const runtime = Number(data.runtime);
  const numberOfSeasons = Number(data.number_of_seasons);

  return {
    contentId,
    mediaType,
    tmdbId: Math.trunc(numericId),
    ...(genreIds.length ? { genreIds } : {}),
    ...(keywords.length ? { keywords } : {}),
    ...(typeof data.original_language === "string" && data.original_language
      ? { originalLanguage: data.original_language }
      : {}),
    ...(productionCountries.length ? { productionCountries } : {}),
    ...(originCountry.length ? { originCountry } : {}),
    ...(Number.isFinite(runtime) && runtime > 0 ? { runtime } : {}),
    ...(episodeRunTime.length ? { episodeRunTime } : {}),
    ...(Number.isFinite(numberOfSeasons) && numberOfSeasons > 0 ? { numberOfSeasons } : {}),
    ...(typeof data.release_date === "string" && data.release_date
      ? { releaseDate: data.release_date }
      : {}),
    ...(typeof data.first_air_date === "string" && data.first_air_date
      ? { firstAirDate: data.first_air_date }
      : {}),
  };
}

async function fetchTmdbMetadata(
  contentId: string,
  apiKey: string
): Promise<TasteMetadataInput | null> {
  const [rawType, rawId] = contentId.split(":");
  if ((rawType !== "movie" && rawType !== "tv") || !/^\d+$/.test(rawId || "")) {
    return null;
  }

  const url = new URL(`https://api.themoviedb.org/3/${rawType}/${rawId}`);
  url.searchParams.set("append_to_response", "keywords");
  url.searchParams.set("language", "tr-TR");

  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey.startsWith("eyJ")) {
    headers.Authorization = `Bearer ${apiKey}`;
  } else {
    url.searchParams.set("api_key", apiKey);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as Record<string, unknown>;
    return normalizeTmdbMetadata(contentId, rawType, payload);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verilen içeriklerden önbellekte olmayanları TMDB'den toplar.
 * Tek çağrıda en fazla `maxItems` içerik işlenir; kalanlar sonraki tura kalır.
 */
export async function hydrateTasteMetadataBatch(options: {
  dataDir?: string;
  apiKey: string;
  contentIds: string[];
  maxItems?: number;
  concurrency?: number;
}): Promise<HydrationBatchResult> {
  const dataDir = options.dataDir ?? "data";
  const apiKey = (options.apiKey || "").trim();
  const cache = await readTasteMetadataCache(dataDir);
  const uniqueIds = Array.from(
    new Set(
      options.contentIds.filter(
        (id) => typeof id === "string" && /^(movie|tv):\d+$/.test(id)
      )
    )
  );
  const pending = uniqueIds.filter((id) => !cache.items[id]);
  const maxItems = Math.max(1, Math.floor(options.maxItems ?? DEFAULT_BATCH_SIZE));
  const batch = pending.slice(0, maxItems);

  if (!apiKey || batch.length === 0) {
    return {
      inputs: [],
      attempted: 0,
      fetched: 0,
      failed: 0,
      remaining: pending.length,
    };
  }

  const inputs: TasteMetadataInput[] = [];
  let cursor = 0;
  let failed = 0;
  const concurrency = Math.min(
    Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY)),
    batch.length
  );

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= batch.length) return;
      const contentId = batch[index];
      const meta = await fetchTmdbMetadata(contentId, apiKey);
      if (!meta) {
        failed += 1;
        continue;
      }
      inputs.push(meta);
      cache.items[contentId] = {
        ...meta,
        fetchedAt: new Date().toISOString(),
        source: "tmdb",
      };
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (inputs.length > 0) {
    await writeTasteMetadataCache(cache, dataDir);
  }

  return {
    inputs,
    attempted: batch.length,
    fetched: inputs.length,
    failed,
    remaining: pending.length - inputs.length,
  };
}

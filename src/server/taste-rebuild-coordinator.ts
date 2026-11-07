// ===========================================================================
// Cinethos Taste Engine — Server Rebuild Coordinator (v1.5)
// Olay güdümlü (event-driven) arka plan profil yeniden hesaplama koordinatörü.
//
// MUTLAK KURALLAR:
// - data/cinetrack-data.json ASLA değiştirilmez (yalnızca ilk soğuk başlatmada okunur)
// - Ağır profil hesaplaması worker_threads (taste-profile-worker.ts) üzerinde çalışır
// - Tüm data/taste/ yazımları atomiktir (taste-store üzerinden)
// ===========================================================================

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { readJsonFileWithRecoveryAsync } from "./atomic-json.ts";
import {
  readTasteEvents,
  writeTasteEvents,
  readTasteIndex,
  writeTasteIndex,
  readTasteProfile,
  writeTasteProfile,
  readTasteManifest,
  readTasteObjections,
} from "./taste-store.ts";
import {
  buildTasteIndex,
  createEmptyTasteIndex,
} from "../core/taste/taste-index-builder.ts";
import { migrateExistingData } from "../core/taste/migration.ts";
import {
  aggregateProfiles,
  type AggregatedProfiles,
} from "../core/taste/profile-aggregator.ts";
import {
  EXTRACTOR_VERSION,
  CONFIG_VERSION,
  TAXONOMY_VERSION,
  TMDB_MAPPING_VERSION,
} from "../core/taste/constants.ts";
import {
  hydrateTasteMetadataBatch,
  readTasteMetadataCache,
  type CachedTasteMetadata,
} from "./taste-metadata-hydrator.ts";
import type {
  ContentTasteItem,
  TasteEvent,
  TasteMetadataInput,
  TasteMetric,
  TasteProfile,
} from "../core/taste/types.ts";
import type { DataDocument } from "../core/cinetrack-core.ts";

export interface RebuildCoordinatorResult {
  generationId: string;
  profile: TasteProfile;
  eventsCount: number;
  indexedItemsCount: number;
}

const activeRebuildChains = new Map<string, Promise<RebuildCoordinatorResult>>();
const bootstrapPromises = new Map<string, Promise<void>>();
const bootstrapSignatures = new Map<string, string>();
const hydrationApiKeys = new Map<string, string>();
const activeHydrations = new Map<string, Promise<void>>();

/** Taste indeksine daha zengin alanları tercih ederek iki metadata kaydını birleştirir. */
function mergeTasteMetadata(
  base: TasteMetadataInput | undefined,
  incoming: TasteMetadataInput
): TasteMetadataInput {
  if (!base) return incoming;
  return {
    ...base,
    ...incoming,
    genreIds: incoming.genreIds?.length ? incoming.genreIds : base.genreIds,
    keywords: incoming.keywords?.length ? incoming.keywords : base.keywords,
    originCountry: incoming.originCountry?.length ? incoming.originCountry : base.originCountry,
    productionCountries: incoming.productionCountries?.length
      ? incoming.productionCountries
      : base.productionCountries,
    originalLanguage: incoming.originalLanguage || base.originalLanguage,
    runtime: incoming.runtime ?? base.runtime,
    episodeRunTime: incoming.episodeRunTime?.length
      ? incoming.episodeRunTime
      : base.episodeRunTime,
    numberOfSeasons: incoming.numberOfSeasons ?? base.numberOfSeasons,
    releaseDate: incoming.releaseDate || base.releaseDate,
    firstAirDate: incoming.firstAirDate || base.firstAirDate,
  };
}

/** Aynı içerik+durum için migration olayının ikinci kez yazılmasını engeller. */
function migratedEventKey(event: TasteEvent): string {
  const status =
    event.eventType === "status_changed" ? String(event.payload?.newValue ?? "") : "";
  return `${event.eventType}::${event.contentId}::${status}`;
}

function collectNewEvents(existing: TasteEvent[], migrated: TasteEvent[]): TasteEvent[] {
  const seen = new Set(existing.map(migratedEventKey));
  const additions: TasteEvent[] = [];
  for (const event of migrated) {
    const key = migratedEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push(event);
  }
  return additions;
}

/** Profil hesaplamasına kanıt sağlayan içerik kimlikleri (hidrasyon kapsamı). */
function collectEvidenceContentIds(events: TasteEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (!event?.contentId) continue;
    if (
      event.eventType === "rating_changed" ||
      event.eventType === "content_disliked" ||
      (event.eventType === "status_changed" && event.payload?.newValue === "completed")
    ) {
      ids.add(event.contentId);
    }
  }
  return Array.from(ids);
}

function tasteMetadataCacheToInput(
  cached: CachedTasteMetadata
): TasteMetadataInput | null {
  const { fetchedAt: _fetchedAt, source: _source, ...meta } = cached;
  return coerceItemToTasteMetadata(meta as unknown as Record<string, unknown>);
}

/** TMDB anahtarını bu veri dizini için kaydeder (anahtar yoksa hidrasyon çalışmaz). */
export function configureTasteHydration(
  dataDir: string = "data",
  tmdbApiKey?: string
): void {
  const key = (tmdbApiKey || "").trim();
  if (key) {
    hydrationApiKeys.set(dataDir, key);
  }
}

async function runHydrationLoop(dataDir: string, contentIds: string[]): Promise<void> {
  const apiKey = hydrationApiKeys.get(dataDir);
  if (!apiKey) return;
  // Her turda bir parti çekip indeksi büyütür; içerik bitene kadar devam eder.
  for (let round = 0; round < 24; round += 1) {
    const result = await hydrateTasteMetadataBatch({
      dataDir,
      apiKey,
      contentIds,
    });
    if (result.fetched === 0) return;
    await upsertTasteMetadataInputs(result.inputs, dataDir);
    await triggerTasteProfileRebuild(dataDir);
    if (result.remaining <= 0) return;
  }
}

/** Arka planda (istekleri bloklamadan) eksik TMDB metadata'sını toplar. */
export function scheduleTasteMetadataHydration(
  dataDir: string,
  contentIds: string[]
): void {
  if (!hydrationApiKeys.get(dataDir) || contentIds.length === 0) return;
  if (activeHydrations.has(dataDir)) return;

  const run = runHydrationLoop(dataDir, contentIds)
    .catch(() => {
      // Hidrasyon hatası profil akışını bloklamaz
    })
    .finally(() => {
      activeHydrations.delete(dataDir);
    });
  activeHydrations.set(dataDir, run);
}

async function fileSignature(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return "0";
  }
}

async function computeBootstrapSignature(dataDir: string): Promise<string> {
  const files =
    dataDir === "data"
      ? [
          "data/cinetrack-data.json",
          "data/catalog/movies.json",
          "data/catalog/tv.json",
          "data/stock.json",
          "data/taste/cinetrack-taste-events.json",
          "data/taste/cinetrack-taste-index.json",
          "data/taste/cinetrack-taste-profile.json",
          "data/taste/cinetrack-taste-metadata-cache.json",
        ]
      : [
          path.join(dataDir, "cinetrack-data.json"),
          path.join(dataDir, "catalog", "movies.json"),
          path.join(dataDir, "catalog", "tv.json"),
          path.join(dataDir, "stock.json"),
          path.join(dataDir, "taste", "cinetrack-taste-events.json"),
          path.join(dataDir, "taste", "cinetrack-taste-index.json"),
          path.join(dataDir, "taste", "cinetrack-taste-profile.json"),
          path.join(dataDir, "taste", "cinetrack-taste-metadata-cache.json"),
        ];
  const parts = await Promise.all(files.map(fileSignature));
  return [CONFIG_VERSION, EXTRACTOR_VERSION, ...parts].join("|");
}

/**
 * Herhangi bir SavedItem / TMDB kaydını güvenli şekilde TasteMetadataInput'a dönüştürür.
 */
export function coerceItemToTasteMetadata(raw: Record<string, unknown> | null | undefined): TasteMetadataInput | null {
  if (!raw || typeof raw !== "object") return null;

  const rawId = raw.tmdbId ?? raw.id;
  const numericId = Number(rawId);
  if (!Number.isFinite(numericId) || numericId <= 0) return null;

  const mediaType: "movie" | "tv" =
    raw.mediaType === "tv" ||
    raw.media_type === "tv" ||
    (!raw.mediaType && !raw.media_type && Boolean(raw.name) && !raw.title)
      ? "tv"
      : "movie";

  const contentId =
    typeof raw.contentId === "string" && /^(movie|tv):[A-Za-z0-9_-]+$/.test(raw.contentId)
      ? raw.contentId
      : `${mediaType}:${Math.trunc(numericId)}`;

  const genreIds = Array.isArray(raw.genreIds)
    ? raw.genreIds.map(Number).filter(Number.isFinite)
    : Array.isArray(raw.genre_ids)
      ? raw.genre_ids.map(Number).filter(Number.isFinite)
      : Array.isArray(raw.genres)
        ? (raw.genres as Array<{ id?: unknown }>)
            .map((g) => Number(g?.id))
            .filter(Number.isFinite)
        : undefined;

  const rawKeywords = Array.isArray(raw.keywords)
    ? raw.keywords
    : raw.keywords && typeof raw.keywords === "object"
      ? ((raw.keywords as { keywords?: unknown[]; results?: unknown[] }).keywords ??
         (raw.keywords as { keywords?: unknown[]; results?: unknown[] }).results)
      : undefined;

  const keywords = Array.isArray(rawKeywords)
    ? rawKeywords
        .map((kw) => {
          if (!kw || typeof kw !== "object") return null;
          const id = Number((kw as { id?: unknown }).id);
          if (!Number.isFinite(id) || id <= 0) return null;
          const name = typeof (kw as { name?: unknown }).name === "string"
            ? (kw as { name: string }).name
            : undefined;
          return name ? { id, name } : { id };
        })
        .filter((kw): kw is { id: number; name?: string } => kw !== null)
    : undefined;

  const originCountry = Array.isArray(raw.originCountry)
    ? raw.originCountry.filter((c): c is string => typeof c === "string")
    : Array.isArray(raw.origin_country)
      ? raw.origin_country.filter((c): c is string => typeof c === "string")
      : undefined;

  const productionCountries = Array.isArray(raw.productionCountries)
    ? raw.productionCountries.filter((c): c is string => typeof c === "string")
    : Array.isArray(raw.production_countries)
      ? raw.production_countries
          .map((c) =>
            typeof c === "string"
              ? c
              : c && typeof c === "object" && typeof (c as { iso_3166_1?: unknown }).iso_3166_1 === "string"
                ? (c as { iso_3166_1: string }).iso_3166_1
                : ""
          )
          .filter(Boolean)
      : undefined;

  const episodeRunTime = Array.isArray(raw.episodeRunTime)
    ? raw.episodeRunTime.map(Number).filter(Number.isFinite)
    : Array.isArray(raw.episode_run_time)
      ? raw.episode_run_time.map(Number).filter(Number.isFinite)
      : undefined;

  const runtimeVal = Number(raw.runtime);
  const seasonsVal = Number(raw.numberOfSeasons ?? raw.number_of_seasons);

  return {
    contentId,
    mediaType,
    tmdbId: Math.trunc(numericId),
    ...(genreIds && genreIds.length > 0 ? { genreIds } : {}),
    ...(keywords && keywords.length > 0 ? { keywords } : {}),
    ...(typeof (raw.originalLanguage ?? raw.original_language) === "string"
      ? { originalLanguage: String(raw.originalLanguage ?? raw.original_language) }
      : {}),
    ...(productionCountries && productionCountries.length > 0 ? { productionCountries } : {}),
    ...(originCountry && originCountry.length > 0 ? { originCountry } : {}),
    ...(Number.isFinite(runtimeVal) && runtimeVal > 0 ? { runtime: runtimeVal } : {}),
    ...(episodeRunTime && episodeRunTime.length > 0 ? { episodeRunTime } : {}),
    ...(Number.isFinite(seasonsVal) && seasonsVal > 0 ? { numberOfSeasons: seasonsVal } : {}),
    ...(typeof (raw.releaseDate ?? raw.release_date) === "string"
      ? { releaseDate: String(raw.releaseDate ?? raw.release_date) }
      : {}),
    ...(typeof (raw.firstAirDate ?? raw.first_air_date) === "string"
      ? { firstAirDate: String(raw.firstAirDate ?? raw.first_air_date) }
      : {}),
  };
}

/**
 * İçerik metadata girdilerini cinetrack-taste-index.json deposuna ekler/günceller.
 */
export async function upsertTasteMetadataInputs(
  inputs: TasteMetadataInput[],
  dataDir: string = "data"
): Promise<{ created: number; updated: number }> {
  if (!inputs.length) return { created: 0, updated: 0 };
  const [existingIndexRaw, objections] = await Promise.all([
    readTasteIndex(dataDir),
    readTasteObjections(dataDir),
  ]);
  const existingIndex = existingIndexRaw ?? createEmptyTasteIndex();
  const asOf = new Date().toISOString();
  const { index, stats } = buildTasteIndex(inputs, existingIndex, {
    asOf,
    extractorVersion: EXTRACTOR_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    mappingVersion: TMDB_MAPPING_VERSION,
  });

  let prunedObjections = false;
  for (const obj of objections) {
    const item = index.items[obj.contentId];
    if (item?.features && obj.metricId in item.features) {
      delete item.features[obj.metricId];
      prunedObjections = true;
    }
  }

  if (stats.created > 0 || stats.updated > 0 || prunedObjections) {
    await writeTasteIndex(index, dataDir);
  }

  return { created: stats.created, updated: stats.updated };
}

/**
 * Worker thread üzerinde profil hesaplamasını çalıştırır; worker başlatılamazsa
 * kesintisiz fallback ile aynı deterministik hesabı tamamlar.
 */
async function executeAggregationOffMainThread(
  generationId: string,
  events: TasteEvent[],
  asOf: string,
  contentIndex: Record<string, ContentTasteItem>,
  existingOverrides: Record<string, NonNullable<TasteMetric["manualOverride"]>>
): Promise<AggregatedProfiles> {
  try {
    return await new Promise<AggregatedProfiles>((resolve, reject) => {
      const workerUrl = new URL("../workers/taste-profile-worker.ts", import.meta.url);
      const worker = new Worker(workerUrl, {
        execArgv: ["--import", "tsx"],
      });

      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error("Taste worker rebuild zaman aşımı"));
      }, 6000);

      worker.on("message", (msg: { type?: string; payload?: { profiles?: AggregatedProfiles }; error?: string }) => {
        if (msg?.type === "done" && msg.payload?.profiles) {
          clearTimeout(timer);
          void worker.terminate();
          resolve(msg.payload.profiles);
        } else if (msg?.type === "error") {
          clearTimeout(timer);
          void worker.terminate();
          reject(new Error(msg.error || "Worker hatası"));
        }
      });

      worker.on("error", (err) => {
        clearTimeout(timer);
        void worker.terminate();
        reject(err);
      });

      worker.postMessage({
        type: "rebuild",
        generationId,
        payload: {
          events,
          asOf,
          contentIndex,
          existingOverrides,
        },
      });
    });
  } catch {
    // Fallback: tsx yükleyici olmadan çalışan test ortamları için deterministik aynı hesap
    const profiles = aggregateProfiles(events, asOf, contentIndex);
    for (const [metricId, override] of Object.entries(existingOverrides)) {
      if (override && profiles.unified.metrics[metricId]) {
        profiles.unified.metrics[metricId].manualOverride = override;
      }
    }
    return profiles;
  }
}

async function performRebuildOnce(dataDir: string = "data"): Promise<RebuildCoordinatorResult> {
  const [events, index, existingProfile, objections] = await Promise.all([
    readTasteEvents(dataDir),
    readTasteIndex(dataDir),
    readTasteProfile(dataDir),
    readTasteObjections(dataDir),
  ]);

  const existingOverrides: Record<string, NonNullable<TasteMetric["manualOverride"]>> = {};
  if (existingProfile?.metrics) {
    for (const [metricId, metric] of Object.entries(existingProfile.metrics)) {
      if (metric?.manualOverride) {
        existingOverrides[metricId] = metric.manualOverride;
      }
    }
  }

  const generationId = randomUUID();
  const asOf = new Date().toISOString();
  const rawItems = index?.items ?? {};
  const contentItems: Record<string, ContentTasteItem> = {};
  const objectionSet = new Set(objections.map((o) => `${o.contentId}::${o.metricId}`));

  for (const [contentId, item] of Object.entries(rawItems)) {
    if (!item?.features || objectionSet.size === 0) {
      contentItems[contentId] = item;
      continue;
    }
    const filteredFeatures: ContentTasteItem["features"] = {};
    for (const [mId, feat] of Object.entries(item.features)) {
      if (!objectionSet.has(`${contentId}::${mId}`)) {
        filteredFeatures[mId] = feat;
      }
    }
    contentItems[contentId] = {
      ...item,
      features: filteredFeatures,
    };
  }

  const profiles = await executeAggregationOffMainThread(
    generationId,
    events,
    asOf,
    contentItems,
    existingOverrides
  );

  await writeTasteProfile(profiles.unified, dataDir);
  const manifest = await readTasteManifest(dataDir);

  return {
    generationId: manifest?.generationId ?? generationId,
    profile: profiles.unified,
    eventsCount: events.length,
    indexedItemsCount: Object.keys(contentItems).length,
  };
}

/**
 * Kuyruklanmış arka plan profil yeniden hesaplamasını tetikler.
 */
export function triggerTasteProfileRebuild(
  dataDir: string = "data"
): Promise<RebuildCoordinatorResult> {
  const prevChain = activeRebuildChains.get(dataDir) ?? Promise.resolve(null);
  const nextRun = prevChain.then(
    () => performRebuildOnce(dataDir),
    () => performRebuildOnce(dataDir)
  );
  activeRebuildChains.set(dataDir, nextRun);
  void nextRun.finally(() => {
    if (activeRebuildChains.get(dataDir) === nextRun) {
      activeRebuildChains.delete(dataDir);
    }
  });
  return nextRun;
}

/**
 * Taste indeksini ve olaylarını güncel veriden artımlı olarak senkronize eder.
 *
 * - cinetrack-data.json yalnızca OKUNUR (ASLA yazılmaz — Mutlak Kural)
 * - Katalog, stok ve TMDB metadata önbelleği indeks girdilerine katılır
 * - Yeni tamamlanmış/puanlanmış kayıtlar olay olarak eklenir (idempotent)
 * - Değişiklik varsa profil yeniden hesaplanır; yoksa ağır iş atlanır
 */
export async function ensureInitialTasteBootstrap(dataDir: string = "data"): Promise<void> {
  const running = bootstrapPromises.get(dataDir);
  if (running) {
    return running;
  }

  const task = (async () => {
    try {
      const signature = await computeBootstrapSignature(dataDir);
      if (bootstrapSignatures.get(dataDir) === signature) {
        return;
      }

      const [existingEvents, existingProfile, manifest, metadataCache] = await Promise.all([
        readTasteEvents(dataDir),
        readTasteProfile(dataDir),
        readTasteManifest(dataDir),
        readTasteMetadataCache(dataDir),
      ]);

      // cinetrack-data.json SADECE OKUNUR (ASLA yazılmaz — Mutlak Kural)
      const userDataPath =
        dataDir === "data" ? "data/cinetrack-data.json" : path.join(dataDir, "cinetrack-data.json");
      const dataDocRes = await readJsonFileWithRecoveryAsync<DataDocument>(userDataPath);
      if (dataDocRes.status !== "ok" && dataDocRes.status !== "recovered") {
        return;
      }
      const doc = dataDocRes.data;
      if (!doc || !Array.isArray(doc.profiles)) {
        return;
      }

      const activeProfile =
        doc.profiles.find((p) => p && p.id === doc.activeProfileId) ?? doc.profiles[0];
      if (!activeProfile) {
        return;
      }

      const metadataMap = new Map<string, TasteMetadataInput>();

      // 1) Yerel katalog dosyaları (salt-okunur)
      const moviesCatPath =
        dataDir === "data" ? "data/catalog/movies.json" : path.join(dataDir, "catalog", "movies.json");
      const tvCatPath =
        dataDir === "data" ? "data/catalog/tv.json" : path.join(dataDir, "catalog", "tv.json");
      const [moviesCatalog, tvCatalog] = await Promise.all([
        readJsonFileWithRecoveryAsync<Record<string, Record<string, unknown>>>(moviesCatPath),
        readJsonFileWithRecoveryAsync<Record<string, Record<string, unknown>>>(tvCatPath),
      ]);
      const rawCatalogByKey = new Map<string, Record<string, unknown>>();
      for (const catalogRes of [moviesCatalog, tvCatalog]) {
        if ((catalogRes.status === "ok" || catalogRes.status === "recovered") && catalogRes.data) {
          for (const [k, entry] of Object.entries(catalogRes.data)) {
            if (entry && typeof entry === "object") {
              rawCatalogByKey.set(k, entry);
              const meta = coerceItemToTasteMetadata(entry);
              if (meta) {
                metadataMap.set(meta.contentId, mergeTasteMetadata(metadataMap.get(meta.contentId), meta));
              }
            }
          }
        }
      }

      // 2) Stok dosyasındaki dil/ülke/tür alanları (salt-okunur)
      const stockPath =
        dataDir === "data" ? "data/stock.json" : path.join(dataDir, "stock.json");
      const stockRes = await readJsonFileWithRecoveryAsync<{
        movies?: Array<Record<string, unknown>>;
        tv?: Array<Record<string, unknown>>;
      }>(stockPath);
      if ((stockRes.status === "ok" || stockRes.status === "recovered") && stockRes.data) {
        for (const entry of [...(stockRes.data.movies || []), ...(stockRes.data.tv || [])]) {
          const meta = coerceItemToTasteMetadata(entry);
          if (meta) {
            metadataMap.set(meta.contentId, mergeTasteMetadata(metadataMap.get(meta.contentId), meta));
          }
        }
      }

      // 3) Kullanıcının kayıtlı öğeleri (katalogla birleşik)
      for (const item of activeProfile.items || []) {
        const rawItem = item as unknown as Record<string, unknown>;
        const prelim = coerceItemToTasteMetadata(rawItem);
        if (!prelim) continue;
        const catEntry = rawCatalogByKey.get(prelim.contentId);
        const mergedRaw = catEntry ? { ...catEntry, ...rawItem } : rawItem;
        const mergedMeta = coerceItemToTasteMetadata(mergedRaw);
        if (mergedMeta) {
          metadataMap.set(
            mergedMeta.contentId,
            mergeTasteMetadata(metadataMap.get(mergedMeta.contentId), mergedMeta)
          );
        }
      }

      // 4) TMDB hidrasyon önbelleği (en zengin alanlar; en son uygulanır)
      for (const cached of Object.values(metadataCache.items)) {
        const meta = tasteMetadataCacheToInput(cached);
        if (meta) {
          metadataMap.set(meta.contentId, mergeTasteMetadata(metadataMap.get(meta.contentId), meta));
        }
      }

      const indexStats =
        metadataMap.size > 0
          ? await upsertTasteMetadataInputs(Array.from(metadataMap.values()), dataDir)
          : { created: 0, updated: 0 };

      // Yeni olayları mevcutlarla birleştir (idempotent)
      const asOf = new Date().toISOString();
      const migrated = migrateExistingData({ dataDocument: doc, asOf });
      const additions = collectNewEvents(existingEvents, migrated.events);
      let allEvents = existingEvents;
      if (additions.length > 0) {
        allEvents = [...existingEvents, ...additions];
        await writeTasteEvents(allEvents, dataDir);
      }

      const versionChanged =
        !manifest || manifest.configVersion !== CONFIG_VERSION;
      const needsRebuild =
        indexStats.created + indexStats.updated > 0 ||
        additions.length > 0 ||
        !existingProfile ||
        versionChanged;

      if (needsRebuild) {
        await triggerTasteProfileRebuild(dataDir);
      }

      // Eksik keyword/dil/ülke alanlarını arka planda tamamla
      scheduleTasteMetadataHydration(dataDir, collectEvidenceContentIds(allEvents));

      bootstrapSignatures.set(dataDir, await computeBootstrapSignature(dataDir));
    } catch {
      // Soğuk başlatma hatası ana uygulamayı bloklamaz
    } finally {
      bootstrapPromises.delete(dataDir);
    }
  })();

  bootstrapPromises.set(dataDir, task);
  return task;
}

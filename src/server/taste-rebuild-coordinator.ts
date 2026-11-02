// ===========================================================================
// CineTrack Taste Engine — Server Rebuild Coordinator (v1.5)
// Olay güdümlü (event-driven) arka plan profil yeniden hesaplama koordinatörü.
//
// MUTLAK KURALLAR:
// - data/cinetrack-data.json ASLA değiştirilmez (yalnızca ilk soğuk başlatmada okunur)
// - Ağır profil hesaplaması worker_threads (taste-profile-worker.ts) üzerinde çalışır
// - Tüm data/taste/ yazımları atomiktir (taste-store üzerinden)
// ===========================================================================

import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { readJsonFileWithRecoveryAsync } from "./atomic-json";
import {
  readTasteEvents,
  writeTasteEvents,
  readTasteIndex,
  writeTasteIndex,
  readTasteProfile,
  writeTasteProfile,
  readTasteManifest,
} from "./taste-store";
import {
  buildTasteIndex,
  createEmptyTasteIndex,
} from "../core/taste/taste-index-builder";
import { migrateExistingData } from "../core/taste/migration";
import {
  aggregateProfiles,
  type AggregatedProfiles,
} from "../core/taste/profile-aggregator";
import {
  EXTRACTOR_VERSION,
  TAXONOMY_VERSION,
  TMDB_MAPPING_VERSION,
} from "../core/taste/constants";
import type {
  ContentTasteItem,
  TasteEvent,
  TasteMetadataInput,
  TasteMetric,
  TasteProfile,
} from "../core/taste/types";
import type { DataDocument } from "../core/cinetrack-core";

export interface RebuildCoordinatorResult {
  generationId: string;
  profile: TasteProfile;
  eventsCount: number;
  indexedItemsCount: number;
}

let activeRebuildChain: Promise<RebuildCoordinatorResult> | null = null;
let bootstrapPromise: Promise<void> | null = null;

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
export async function upsertTasteMetadataInputs(inputs: TasteMetadataInput[]): Promise<void> {
  if (!inputs.length) return;
  const existingIndex = (await readTasteIndex()) ?? createEmptyTasteIndex();
  const asOf = new Date().toISOString();
  const { index, stats } = buildTasteIndex(inputs, existingIndex, {
    asOf,
    extractorVersion: EXTRACTOR_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    mappingVersion: TMDB_MAPPING_VERSION,
  });

  if (stats.created > 0 || stats.updated > 0) {
    await writeTasteIndex(index);
  }
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

async function performRebuildOnce(): Promise<RebuildCoordinatorResult> {
  const [events, index, existingProfile] = await Promise.all([
    readTasteEvents(),
    readTasteIndex(),
    readTasteProfile(),
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
  const contentItems = index?.items ?? {};

  const profiles = await executeAggregationOffMainThread(
    generationId,
    events,
    asOf,
    contentItems,
    existingOverrides
  );

  await writeTasteProfile(profiles.unified);
  const manifest = await readTasteManifest();

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
export function triggerTasteProfileRebuild(): Promise<RebuildCoordinatorResult> {
  const nextRun = (activeRebuildChain ?? Promise.resolve(null)).then(
    () => performRebuildOnce(),
    () => performRebuildOnce()
  );
  activeRebuildChain = nextRun;
  void nextRun.finally(() => {
    if (activeRebuildChain === nextRun) {
      activeRebuildChain = null;
    }
  });
  return nextRun;
}

/**
 * İlk açılışta taste olayları veya profil henüz boşsa data/cinetrack-data.json'dan
 * SALT-OKUNUR (read-only) olarak başlangıç indeksini ve profilini üretir.
 */
export async function ensureInitialTasteBootstrap(): Promise<void> {
  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  bootstrapPromise = (async () => {
    try {
      const [existingEvents, existingProfile] = await Promise.all([
        readTasteEvents(),
        readTasteProfile(),
      ]);

      const hasPopulatedProfile = Boolean(
        existingProfile &&
          existingProfile.metrics &&
          Object.keys(existingProfile.metrics).length > 0 &&
          Object.values(existingProfile.metrics).some((m) => m.status !== "unknown")
      );

      if (existingEvents.length > 0 && hasPopulatedProfile) {
        return;
      }

      // cinetrack-data.json SADECE OKUNUR (ASLA yazılmaz — Mutlak Kural)
      const dataDocRes = await readJsonFileWithRecoveryAsync<DataDocument>("data/cinetrack-data.json");
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

      // Önce yerel katalog dosyalarındaki zengin TMDB metadata kayıtlarını yükle (salt-okunur)
      const [moviesCatalog, tvCatalog] = await Promise.all([
        readJsonFileWithRecoveryAsync<Record<string, Record<string, unknown>>>("data/catalog/movies.json"),
        readJsonFileWithRecoveryAsync<Record<string, Record<string, unknown>>>("data/catalog/tv.json"),
      ]);
      const rawCatalogByKey = new Map<string, Record<string, unknown>>();
      for (const catalogRes of [moviesCatalog, tvCatalog]) {
        if ((catalogRes.status === "ok" || catalogRes.status === "recovered") && catalogRes.data) {
          for (const [k, entry] of Object.entries(catalogRes.data)) {
            if (entry && typeof entry === "object") {
              rawCatalogByKey.set(k, entry);
              const meta = coerceItemToTasteMetadata(entry);
              if (meta) {
                metadataMap.set(meta.contentId, meta);
              }
            }
          }
        }
      }

      // Kullanıcının kayıtlı öğelerini katalog verisiyle birleştirerek indeksle
      for (const item of activeProfile.items || []) {
        const rawItem = item as unknown as Record<string, unknown>;
        const prelim = coerceItemToTasteMetadata(rawItem);
        if (!prelim) continue;
        const catEntry = rawCatalogByKey.get(prelim.contentId);
        const mergedRaw = catEntry ? { ...catEntry, ...rawItem } : rawItem;
        const mergedMeta = coerceItemToTasteMetadata(mergedRaw);
        if (mergedMeta) {
          // Eğer savedItem'da genreIds/keywords boş ama katalogda doluysa koru
          const existingCatMeta = metadataMap.get(mergedMeta.contentId);
          metadataMap.set(mergedMeta.contentId, {
            ...existingCatMeta,
            ...mergedMeta,
            genreIds: mergedMeta.genreIds?.length ? mergedMeta.genreIds : existingCatMeta?.genreIds,
            keywords: mergedMeta.keywords?.length ? mergedMeta.keywords : existingCatMeta?.keywords,
            originCountry: mergedMeta.originCountry?.length
              ? mergedMeta.originCountry
              : existingCatMeta?.originCountry,
            productionCountries: mergedMeta.productionCountries?.length
              ? mergedMeta.productionCountries
              : existingCatMeta?.productionCountries,
            originalLanguage: mergedMeta.originalLanguage || existingCatMeta?.originalLanguage,
            runtime: mergedMeta.runtime ?? existingCatMeta?.runtime,
            episodeRunTime: mergedMeta.episodeRunTime?.length
              ? mergedMeta.episodeRunTime
              : existingCatMeta?.episodeRunTime,
            numberOfSeasons: mergedMeta.numberOfSeasons ?? existingCatMeta?.numberOfSeasons,
          });
        }
      }

      if (metadataMap.size > 0) {
        await upsertTasteMetadataInputs(Array.from(metadataMap.values()));
      }

      if (existingEvents.length === 0) {
        const asOf = new Date().toISOString();
        const migrated = migrateExistingData({ dataDocument: doc, asOf });
        if (migrated.events.length > 0) {
          await writeTasteEvents(migrated.events);
        }
      }

      await triggerTasteProfileRebuild();
    } catch {
      // Soğuk başlatma hatası ana uygulamayı bloklamaz
    } finally {
      bootstrapPromise = null;
    }
  })();

  return bootstrapPromise;
}

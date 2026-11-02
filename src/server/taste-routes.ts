// ===========================================================================
// CineTrack Taste Engine — Taste Routes (v1.5)
// HTTP uçları: GET/POST/DELETE /api/taste/*
// ===========================================================================

import path from "node:path";
import { Router } from "express";
import { readJsonFileWithRecoveryAsync } from "./atomic-json";
import {
  readTasteProfile,
  writeTasteProfile,
  readTasteEvents,
  appendTasteEvent,
  readTasteManifest,
  readTasteIndex,
  writeTasteIndex,
  readTasteObjections,
  writeTasteObjections,
} from "./taste-store";
import { explainMetric, type EvidenceItem } from "../core/taste/profile-explainer";
import type {
  ManualOverrideMode,
  TasteEvent,
  TasteMetadataInput,
} from "../core/taste/types";
import type { DataDocument } from "../core/cinetrack-core";
import {
  coerceItemToTasteMetadata,
  ensureInitialTasteBootstrap,
  triggerTasteProfileRebuild,
  upsertTasteMetadataInputs,
} from "./taste-rebuild-coordinator";

interface ResolvedContentSummary {
  title: string;
  year?: number | string;
  mediaType: "movie" | "tv";
  posterPath?: string;
  personalRating?: number;
}

/**
 * Kanıt öğelerinin başlık, yıl, poster ve kişisel puan bilgilerini
 * cinetrack-data.json ve catalog/*.json dosyalarından SALT-OKUNUR çözümler.
 */
async function buildContentSummaryLookup(
  dataDir: string = "data"
): Promise<Map<string, ResolvedContentSummary>> {
  const lookup = new Map<string, ResolvedContentSummary>();

  const moviesCatPath =
    dataDir === "data" ? "data/catalog/movies.json" : path.join(dataDir, "catalog", "movies.json");
  const tvCatPath =
    dataDir === "data" ? "data/catalog/tv.json" : path.join(dataDir, "catalog", "tv.json");
  const userDataPath =
    dataDir === "data" ? "data/cinetrack-data.json" : path.join(dataDir, "cinetrack-data.json");

  const [moviesCatRes, tvCatRes, dataDocRes] = await Promise.all([
    readJsonFileWithRecoveryAsync<Record<string, Record<string, unknown>>>(moviesCatPath),
    readJsonFileWithRecoveryAsync<Record<string, Record<string, unknown>>>(tvCatPath),
    readJsonFileWithRecoveryAsync<DataDocument>(userDataPath),
  ]);

  const registerRaw = (fallbackKey: string | null, raw: Record<string, unknown>) => {
    const rawId = raw.tmdbId ?? raw.id;
    const mediaType: "movie" | "tv" =
      raw.media_type === "tv" ||
      raw.mediaType === "tv" ||
      (!raw.media_type && !raw.mediaType && Boolean(raw.name) && !raw.title)
        ? "tv"
        : "movie";
    const key =
      fallbackKey && /^(movie|tv):/.test(fallbackKey)
        ? fallbackKey
        : rawId != null
          ? `${mediaType}:${String(rawId)}`
          : null;
    if (!key) return;

    const existing = lookup.get(key);
    const titleCandidate =
      (typeof raw.title === "string" && raw.title.trim()) ||
      (typeof raw.name === "string" && raw.name.trim()) ||
      (typeof raw.original_title === "string" && raw.original_title.trim()) ||
      (typeof raw.original_name === "string" && raw.original_name.trim()) ||
      existing?.title ||
      key;

    const dateStr =
      (typeof raw.release_date === "string" && raw.release_date) ||
      (typeof raw.first_air_date === "string" && raw.first_air_date) ||
      (typeof raw.releaseDate === "string" && raw.releaseDate) ||
      (typeof raw.firstAirDate === "string" && raw.firstAirDate) ||
      "";
    const yearMatch = dateStr.slice(0, 4);
    const year = /^\d{4}$/.test(yearMatch) ? yearMatch : existing?.year;

    const posterPath =
      typeof raw.poster_path === "string" && raw.poster_path.trim()
        ? raw.poster_path.trim()
        : existing?.posterPath;

    const ratingNum = Number(raw.personal_rating);
    const personalRating =
      raw.personal_rating !== "" && Number.isFinite(ratingNum) && ratingNum >= 1
        ? ratingNum
        : existing?.personalRating;

    lookup.set(key, {
      title: titleCandidate,
      ...(year !== undefined ? { year } : {}),
      mediaType,
      ...(posterPath ? { posterPath } : {}),
      ...(personalRating !== undefined ? { personalRating } : {}),
    });
  };

  for (const catRes of [moviesCatRes, tvCatRes]) {
    if ((catRes.status === "ok" || catRes.status === "recovered") && catRes.data) {
      for (const [key, entry] of Object.entries(catRes.data)) {
        if (entry && typeof entry === "object") {
          registerRaw(key, entry);
        }
      }
    }
  }

  if ((dataDocRes.status === "ok" || dataDocRes.status === "recovered") && dataDocRes.data?.profiles) {
    for (const prof of dataDocRes.data.profiles) {
      for (const item of prof?.items ?? []) {
        if (item && typeof item === "object") {
          registerRaw(null, item as unknown as Record<string, unknown>);
        }
      }
    }
  }

  return lookup;
}

function enrichEvidenceList(
  items: EvidenceItem[],
  lookup: Map<string, ResolvedContentSummary>
): EvidenceItem[] {
  return items.map((ev) => {
    const resolved = lookup.get(ev.contentId);
    const fallbackType: "movie" | "tv" = ev.contentId.startsWith("tv:") ? "tv" : "movie";
    if (!resolved) {
      return {
        ...ev,
        mediaType: fallbackType,
      };
    }
    return {
      ...ev,
      title: resolved.title,
      ...(resolved.year !== undefined ? { year: resolved.year } : {}),
      mediaType: resolved.mediaType,
      ...(resolved.posterPath ? { posterPath: resolved.posterPath } : {}),
      ...(resolved.personalRating !== undefined
        ? { personalRating: resolved.personalRating }
        : {}),
    };
  });
}

export function createTasteRouter(dataDir: string = "data"): Router {
  const router = Router();

  // GET /api/taste/profile
  router.get("/profile", async (_req, res) => {
    try {
      await ensureInitialTasteBootstrap(dataDir);
      const profile = await readTasteProfile(dataDir);
      if (!profile) {
        return res.status(404).json({ error: "Profil bulunamadı" });
      }
      res.json(profile);
    } catch {
      res.status(500).json({ error: "Profil okunamadı" });
    }
  });

  // GET /api/taste/metric/:id
  router.get("/metric/:id", async (req, res) => {
    try {
      await ensureInitialTasteBootstrap(dataDir);
      const profile = await readTasteProfile(dataDir);
      if (!profile) {
        return res.status(404).json({ error: "Profil bulunamadı" });
      }

      const metricId = req.params.id;
      const metric = profile.metrics[metricId];
      if (!metric) {
        return res.status(404).json({ error: "Metrik bulunamadı" });
      }

      const [index, summaryLookup] = await Promise.all([
        readTasteIndex(dataDir),
        buildContentSummaryLookup(dataDir),
      ]);
      const explanation = explainMetric(metricId, profile, index?.items ?? {});
      if (explanation) {
        explanation.positiveEvidence = enrichEvidenceList(
          explanation.positiveEvidence,
          summaryLookup
        );
        explanation.negativeEvidence = enrichEvidenceList(
          explanation.negativeEvidence,
          summaryLookup
        );
        explanation.neutralEvidence = enrichEvidenceList(
          explanation.neutralEvidence,
          summaryLookup
        );
      }

      res.json({ metric, explanation });
    } catch {
      res.status(500).json({ error: "Metrik okunamadı" });
    }
  });

  // GET /api/taste/evidence/:metricId
  router.get("/evidence/:metricId", async (req, res) => {
    try {
      const profile = await readTasteProfile(dataDir);
      if (!profile) {
        return res.status(404).json({ error: "Profil bulunamadı" });
      }

      const metricId = req.params.metricId;
      const metric = profile.metrics[metricId];
      if (!metric) {
        return res.status(404).json({ error: "Metrik bulunamadı" });
      }

      res.json({
        positiveContentIds: metric.evidence.topPositiveContentIds,
        negativeContentIds: metric.evidence.topNegativeContentIds,
        posMass: metric.evidence.posMass,
        negMass: metric.evidence.negMass,
        uncertainMass: metric.evidence.uncertainMass,
      });
    } catch {
      res.status(500).json({ error: "Kanıt okunamadı" });
    }
  });

  // GET /api/taste/manifest
  router.get("/manifest", async (_req, res) => {
    try {
      const manifest = await readTasteManifest(dataDir);
      if (!manifest) {
        return res.status(404).json({ error: "Manifest bulunamadı" });
      }
      res.json(manifest);
    } catch {
      res.status(500).json({ error: "Manifest okunamadı" });
    }
  });

  // GET /api/taste/events
  router.get("/events", async (_req, res) => {
    try {
      const events = await readTasteEvents(dataDir);
      res.json({ events, count: events.length });
    } catch {
      res.status(500).json({ error: "Olaylar okunamadı" });
    }
  });

  // POST /api/taste/override — Manuel kontrol (TP-028: replace | boost | suppress | exclude)
  router.post("/override", async (req, res) => {
    try {
      const { metricId, value, mode } = req.body as {
        metricId?: string;
        value?: number;
        mode?: string;
      };
      if (!metricId || value === undefined || !mode) {
        return res.status(400).json({ error: "Geçersiz istek" });
      }

      const validModes: ManualOverrideMode[] = ["replace", "boost", "suppress", "exclude"];
      if (!validModes.includes(mode as ManualOverrideMode)) {
        return res.status(400).json({ error: `Geçersiz mode: ${mode}` });
      }

      await ensureInitialTasteBootstrap(dataDir);
      const profile = await readTasteProfile(dataDir);
      if (!profile) {
        return res.status(404).json({ error: "Profil bulunamadı" });
      }

      const metric = profile.metrics[metricId];
      if (!metric) {
        return res.status(404).json({ error: "Metrik bulunamadı" });
      }

      const safeVal = Number.isFinite(Number(value))
        ? Math.max(-100, Math.min(100, Math.round(Number(value))))
        : 0;

      metric.manualOverride = {
        value: mode === "exclude" ? 0 : safeVal,
        mode: mode as ManualOverrideMode,
      };
      await writeTasteProfile(profile, dataDir);
      res.json({ success: true, metric });
    } catch {
      res.status(500).json({ error: "Manuel kontrol uygulanamadı" });
    }
  });

  // DELETE /api/taste/override/:metricId — Manuel kontrolü geri al (TP-028)
  router.delete("/override/:metricId", async (req, res) => {
    try {
      const metricId = req.params.metricId;
      const profile = await readTasteProfile(dataDir);
      if (!profile) {
        return res.status(404).json({ error: "Profil bulunamadı" });
      }

      const metric = profile.metrics[metricId];
      if (!metric) {
        return res.status(404).json({ error: "Metrik bulunamadı" });
      }

      delete metric.manualOverride;
      await writeTasteProfile(profile, dataDir);
      res.json({ success: true, metric });
    } catch {
      res.status(500).json({ error: "Override kaldırılamadı" });
    }
  });

  // POST /api/taste/objection — V1.5 "Bu yapımda bu özellik yok" etiket itirazı
  router.post("/objection", async (req, res) => {
    try {
      const { contentId, metricId } = req.body as {
        contentId?: string;
        metricId?: string;
      };
      if (
        !contentId ||
        !metricId ||
        !/^(movie|tv):[A-Za-z0-9_-]+$/.test(contentId)
      ) {
        return res.status(400).json({ error: "Geçersiz itiraz isteği" });
      }

      await ensureInitialTasteBootstrap(dataDir);
      const [objections, index] = await Promise.all([
        readTasteObjections(dataDir),
        readTasteIndex(dataDir),
      ]);

      const alreadyExists = objections.some(
        (o) => o.contentId === contentId && o.metricId === metricId
      );
      if (!alreadyExists) {
        objections.push({
          contentId,
          metricId,
          createdAt: new Date().toISOString(),
        });
        await writeTasteObjections(objections, dataDir);
      }

      if (index?.items?.[contentId]?.features?.[metricId]) {
        delete index.items[contentId].features[metricId];
        await writeTasteIndex(index, dataDir);
      }

      const rebuildResult = await triggerTasteProfileRebuild(dataDir);
      res.json({
        success: true,
        contentId,
        metricId,
        generationId: rebuildResult.generationId,
      });
    } catch {
      res.status(500).json({ error: "Etiket itirazı kaydedilemedi" });
    }
  });

  // DELETE /api/taste/objection — Etiket itirazını geri al
  router.delete("/objection", async (req, res) => {
    try {
      const { contentId, metricId } = req.body as {
        contentId?: string;
        metricId?: string;
      };
      if (!contentId || !metricId) {
        return res.status(400).json({ error: "Geçersiz istek" });
      }

      const objections = await readTasteObjections(dataDir);
      const filtered = objections.filter(
        (o) => !(o.contentId === contentId && o.metricId === metricId)
      );
      await writeTasteObjections(filtered, dataDir);
      const rebuildResult = await triggerTasteProfileRebuild(dataDir);
      res.json({
        success: true,
        generationId: rebuildResult.generationId,
      });
    } catch {
      res.status(500).json({ error: "Etiket itirazı geri alınamadı" });
    }
  });

  // POST /api/taste/event — Yeni olay ekle + indeksle + arka planda profili yeniden hesapla
  router.post("/event", async (req, res) => {
    try {
      const body = req.body as
        | TasteEvent
        | {
            event?: TasteEvent;
            metadata?: TasteMetadataInput | Record<string, unknown>;
          };

      const event: TasteEvent | undefined =
        body && "event" in body && body.event
          ? body.event
          : (body as TasteEvent);

      if (!event || !event.eventId || !event.contentId || !event.eventType) {
        return res.status(400).json({ error: "Geçersiz olay" });
      }

      await ensureInitialTasteBootstrap(dataDir);

      if (body && "metadata" in body && body.metadata) {
        const meta = coerceItemToTasteMetadata(body.metadata as Record<string, unknown>);
        if (meta) {
          await upsertTasteMetadataInputs([meta], dataDir);
        }
      }

      await appendTasteEvent(event, dataDir);
      const rebuildResult = await triggerTasteProfileRebuild(dataDir);

      res.json({
        success: true,
        eventId: event.eventId,
        generationId: rebuildResult.generationId,
      });
    } catch {
      res.status(500).json({ error: "Olay eklenemedi" });
    }
  });

  // POST /api/taste/rebuild — Manuel/istemci tetiklemeli arka plan profil yeniden hesaplama
  router.post("/rebuild", async (_req, res) => {
    try {
      await ensureInitialTasteBootstrap(dataDir);
      const rebuildResult = await triggerTasteProfileRebuild(dataDir);
      res.json({
        success: true,
        generationId: rebuildResult.generationId,
        eventsCount: rebuildResult.eventsCount,
        indexedItemsCount: rebuildResult.indexedItemsCount,
      });
    } catch {
      res.status(500).json({ error: "Profil yeniden hesaplanamadı" });
    }
  });

  return router;
}

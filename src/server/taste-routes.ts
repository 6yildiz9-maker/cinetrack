// ===========================================================================
// CineTrack Taste Engine — Taste Routes (v1.0)
// HTTP uçları: GET/POST /api/taste/*
// ===========================================================================

import { Router } from "express";
import {
  readTasteProfile,
  writeTasteProfile,
  readTasteEvents,
  appendTasteEvent,
  readTasteManifest,
  readTasteIndex,
} from "./taste-store";
import { explainMetric } from "../core/taste/profile-explainer";
import type { TasteEvent, TasteMetadataInput } from "../core/taste/types";
import {
  coerceItemToTasteMetadata,
  ensureInitialTasteBootstrap,
  triggerTasteProfileRebuild,
  upsertTasteMetadataInputs,
} from "./taste-rebuild-coordinator";

export function createTasteRouter(): Router {
  const router = Router();

  // GET /api/taste/profile
  router.get("/profile", async (_req, res) => {
    try {
      await ensureInitialTasteBootstrap();
      const profile = await readTasteProfile();
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
      const profile = await readTasteProfile();
      if (!profile) {
        return res.status(404).json({ error: "Profil bulunamadı" });
      }

      const metricId = req.params.id;
      const metric = profile.metrics[metricId];
      if (!metric) {
        return res.status(404).json({ error: "Metrik bulunamadı" });
      }

      const index = await readTasteIndex();
      const explanation = explainMetric(metricId, profile, index?.items ?? {});
      res.json({ metric, explanation });
    } catch {
      res.status(500).json({ error: "Metrik okunamadı" });
    }
  });

  // GET /api/taste/evidence/:metricId
  router.get("/evidence/:metricId", async (req, res) => {
    try {
      const profile = await readTasteProfile();
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
      const manifest = await readTasteManifest();
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
      const events = await readTasteEvents();
      res.json({ events, count: events.length });
    } catch {
      res.status(500).json({ error: "Olaylar okunamadı" });
    }
  });

  // POST /api/taste/override — Manuel kontrol (TP-028)
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

      const validModes = ["replace", "boost", "suppress"];
      if (!validModes.includes(mode)) {
        return res.status(400).json({ error: `Geçersiz mode: ${mode}` });
      }

      const profile = await readTasteProfile();
      if (!profile) {
        return res.status(404).json({ error: "Profil bulunamadı" });
      }

      const metric = profile.metrics[metricId];
      if (!metric) {
        return res.status(404).json({ error: "Metrik bulunamadı" });
      }

      // Manuel kontrol uygula (TP-028)
      metric.manualOverride = {
        value,
        mode: mode as "replace" | "boost" | "suppress",
      };
      await writeTasteProfile(profile);
      res.json({ success: true, metric });
    } catch {
      res.status(500).json({ error: "Manuel kontrol uygulanamadı" });
    }
  });

  // DELETE /api/taste/override/:metricId — Manuel kontrolü geri al (TP-028)
  router.delete("/override/:metricId", async (req, res) => {
    try {
      const metricId = req.params.metricId;
      const profile = await readTasteProfile();
      if (!profile) {
        return res.status(404).json({ error: "Profil bulunamadı" });
      }

      const metric = profile.metrics[metricId];
      if (!metric) {
        return res.status(404).json({ error: "Metrik bulunamadı" });
      }

      // Override'ı kaldır
      delete metric.manualOverride;
      await writeTasteProfile(profile);
      res.json({ success: true, metric });
    } catch {
      res.status(500).json({ error: "Override kaldırılamadı" });
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

      // İlk açılışta mevcut geçmiş henüz yüklenmediyse önce onu hazırla
      await ensureInitialTasteBootstrap();

      if (body && "metadata" in body && body.metadata) {
        const meta = coerceItemToTasteMetadata(body.metadata as Record<string, unknown>);
        if (meta) {
          await upsertTasteMetadataInputs([meta]);
        }
      }

      await appendTasteEvent(event);
      const rebuildResult = await triggerTasteProfileRebuild();

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
      await ensureInitialTasteBootstrap();
      const rebuildResult = await triggerTasteProfileRebuild();
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

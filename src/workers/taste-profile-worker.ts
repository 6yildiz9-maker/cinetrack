// ===========================================================================
// Cinethos Taste Engine — Taste Profile Worker (v1.0)
// Ağır hesapları main thread dışında çalıştırır (§4.2, §18.2/F)
//
// KRİTİK: Bu dosya worker_threads içinde çalışır.
// Main thread'i asla bloklamamalı.
// ===========================================================================

import { parentPort } from "worker_threads";
import { extractContentTasteItem } from "../core/taste/feature-extractor.ts";
import { aggregateProfiles } from "../core/taste/profile-aggregator.ts";
import { runTasteArchaeology } from "../core/taste/taste-archaeology.ts";
import type {
  TasteEvent,
  ContentTasteItem,
  TasteMetadataInput,
  TasteMetric,
} from "../core/taste/types.ts";

export interface WorkerRebuildPayload {
  events: TasteEvent[];
  asOf: string;
  contentIndex?: Record<string, ContentTasteItem>;
  existingOverrides?: Record<string, NonNullable<TasteMetric["manualOverride"]>>;
}

interface WorkerMessage {
  type: "rebuild" | "extract" | "archaeology";
  generationId: string;
  payload: unknown;
}

interface WorkerResponse {
  type: "progress" | "done" | "error";
  generationId: string;
  payload?: unknown;
  error?: string;
}

if (parentPort) {
  parentPort.on("message", async (message: WorkerMessage) => {
    const { type, generationId, payload } = message;

    try {
      if (type === "rebuild") {
        await handleRebuild(generationId, payload as WorkerRebuildPayload);
      } else if (type === "extract") {
        await handleExtract(
          generationId,
          payload as { items: TasteMetadataInput[]; batchSize?: number }
        );
      } else if (type === "archaeology") {
        await handleArchaeology(
          generationId,
          payload as {
            events: TasteEvent[];
            contentIndex: Record<string, ContentTasteItem>;
            asOf: string;
          }
        );
      } else {
        sendResponse({
          type: "error",
          generationId,
          error: `Bilinmeyen mesaj tipi: ${String(type)}`,
        });
      }
    } catch (error) {
      sendResponse({
        type: "error",
        generationId,
        error:
          error instanceof Error ? error.message : "Bilinmeyen hata",
      });
    }
  });
}

/** Profil yeniden oluştur */
async function handleRebuild(
  generationId: string,
  payload: WorkerRebuildPayload
) {
  const { events, asOf, contentIndex, existingOverrides } = payload;

  sendResponse({
    type: "progress",
    generationId,
    payload: { step: "aggregating" },
  });

  const profiles = aggregateProfiles(events, asOf, contentIndex);

  // TP-028: Yeniden hesaplama sırasında kullanıcının manuel override tercihlerini koru
  if (existingOverrides) {
    for (const [metricId, override] of Object.entries(existingOverrides)) {
      if (override && profiles.unified.metrics[metricId]) {
        profiles.unified.metrics[metricId].manualOverride = override;
      }
    }
  }

  sendResponse({
    type: "done",
    generationId,
    payload: { profiles },
  });
}

/** Toplu feature extraction */
async function handleExtract(
  generationId: string,
  payload: { items: TasteMetadataInput[]; batchSize?: number }
) {
  const { items, batchSize = 50 } = payload;
  const results: ContentTasteItem[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    for (const item of batch) {
      const extracted = extractContentTasteItem(item);
      results.push(extracted);
    }

    sendResponse({
      type: "progress",
      generationId,
      payload: {
        step: "extracting",
        processed: Math.min(i + batchSize, items.length),
        total: items.length,
      },
    });
  }

  sendResponse({
    type: "done",
    generationId,
    payload: { results },
  });
}

/** Archaeology çalıştır */
async function handleArchaeology(
  generationId: string,
  payload: {
    events: TasteEvent[];
    contentIndex: Record<string, ContentTasteItem>;
    asOf: string;
  }
) {
  const { events, contentIndex, asOf } = payload;

  sendResponse({
    type: "progress",
    generationId,
    payload: { step: "running_archaeology" },
  });

  const result = await runTasteArchaeology(events, contentIndex, { asOf });

  sendResponse({
    type: "done",
    generationId,
    payload: { result },
  });
}

function sendResponse(response: WorkerResponse) {
  if (parentPort) {
    parentPort.postMessage(response);
  }
}

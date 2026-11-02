// ===========================================================================
// CineTrack Taste Engine — Taste Store (v1.0)
// data/taste/ ağacının sahibi, atomik yazım, manifest (TP-008/TP-027)
// ===========================================================================

import { randomUUID } from "node:crypto";
import { writeJsonFileAtomicAsync, readJsonFileWithRecoveryAsync } from "./atomic-json";
import type {
  TasteEvent,
  TasteProfile,
  ContentTasteIndex,
  TasteManifest,
} from "../core/taste/types";
import {
  TASTE_SCHEMA_VERSION,
  ALGORITHM_VERSION,
  TAXONOMY_VERSION,
  CONFIG_VERSION,
} from "../core/taste/constants";

export const TASTE_DATA_DIR = "data/taste";
export const TASTE_ARCHIVE_DIR = "data/taste/archive/taste-events";

export interface TasteStorePaths {
  taxonomy: string;
  index: string;
  events: string;
  profile: string;
  manifest: string;
}

export const TASTE_PATHS: TasteStorePaths = {
  taxonomy: `${TASTE_DATA_DIR}/cinetrack-taste-taxonomy.json`,
  index:    `${TASTE_DATA_DIR}/cinetrack-taste-index.json`,
  events:   `${TASTE_DATA_DIR}/cinetrack-taste-events.json`,
  profile:  `${TASTE_DATA_DIR}/cinetrack-taste-profile.json`,
  manifest: `${TASTE_DATA_DIR}/cinetrack-taste-manifest.json`,
};

// === Event Store ===

/**
 * Olay ekle (append-only, idempotent — TP-005)
 */
export async function appendTasteEvent(event: TasteEvent): Promise<void> {
  const events = await readTasteEvents();
  // Idempotency: aynı eventId iki kez eklenmez
  if (events.some((e) => e.eventId === event.eventId)) {
    return;
  }
  events.push(event);
  await writeJsonFileAtomicAsync(TASTE_PATHS.events, JSON.stringify(events, null, 2));
}

/**
 * Olay listesini oku
 */
export async function readTasteEvents(): Promise<TasteEvent[]> {
  const result = await readJsonFileWithRecoveryAsync<TasteEvent[]>(TASTE_PATHS.events);
  if (result.status === "ok" || result.status === "recovered") {
    return Array.isArray(result.data) ? result.data : [];
  }
  return [];
}

/**
 * Tüm olayları toplu yaz (migration sonrası)
 */
export async function writeTasteEvents(events: TasteEvent[]): Promise<void> {
  await writeJsonFileAtomicAsync(
    TASTE_PATHS.events,
    JSON.stringify(events, null, 2)
  );
}

// === Profile Store ===

/**
 * Profili yaz (atomik, manifest güncelle)
 */
export async function writeTasteProfile(profile: TasteProfile): Promise<void> {
  await writeJsonFileAtomicAsync(
    TASTE_PATHS.profile,
    JSON.stringify(profile, null, 2)
  );
  await updateManifest();
}

/**
 * Profili oku
 */
export async function readTasteProfile(): Promise<TasteProfile | null> {
  const result = await readJsonFileWithRecoveryAsync<TasteProfile>(TASTE_PATHS.profile);
  if (result.status === "ok" || result.status === "recovered") {
    return result.data;
  }
  return null;
}

// === Index Store ===

/**
 * İndeksi yaz (atomik, manifest güncelle)
 */
export async function writeTasteIndex(index: ContentTasteIndex): Promise<void> {
  await writeJsonFileAtomicAsync(
    TASTE_PATHS.index,
    JSON.stringify(index, null, 2)
  );
  await updateManifest();
}

/**
 * İndeksi oku
 */
export async function readTasteIndex(): Promise<ContentTasteIndex | null> {
  const result = await readJsonFileWithRecoveryAsync<ContentTasteIndex>(TASTE_PATHS.index);
  if (result.status === "ok" || result.status === "recovered") {
    return result.data;
  }
  return null;
}

// === Manifest ===

/**
 * Manifest'i güncelle (TP-027)
 * Profil veya index yazıldığında otomatik çağrılır.
 */
async function updateManifest(): Promise<void> {
  const manifest: TasteManifest = {
    generationId: randomUUID(),
    taxonomyVersion: TAXONOMY_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    configVersion: CONFIG_VERSION,
    asOf: new Date().toISOString(),
    files: {
      taxonomy: TASTE_PATHS.taxonomy,
      index: TASTE_PATHS.index,
      events: TASTE_PATHS.events,
      profile: TASTE_PATHS.profile,
    },
    eventWatermark: "", // son işlenen eventId (V2'de doldurulacak)
  };
  await writeJsonFileAtomicAsync(
    TASTE_PATHS.manifest,
    JSON.stringify(manifest, null, 2)
  );
}

/**
 * Manifest'i oku
 */
export async function readTasteManifest(): Promise<TasteManifest | null> {
  const result = await readJsonFileWithRecoveryAsync<TasteManifest>(TASTE_PATHS.manifest);
  if (result.status === "ok" || result.status === "recovered") {
    return result.data;
  }
  return null;
}

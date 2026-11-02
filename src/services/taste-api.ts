// ===========================================================================
// CineTrack Taste Engine — Taste API (v1.0)
// İstemci tarafı API çağrıları — /api/taste/* uç noktaları
// ===========================================================================

import type { TasteProfile, TasteManifest, TasteEvent } from "../core/taste/types";
import type { MetricExplanation } from "../core/taste/profile-explainer";

const BASE = "/api/taste";

/** Ortak fetch yardımcısı */
async function apiFetch<T>(
  url: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `HTTP ${res.status}: ${url}`
    );
  }
  return res.json() as Promise<T>;
}

// === Profil ===

/** Taste profilini sunucudan çek */
export async function fetchTasteProfile(): Promise<TasteProfile> {
  return apiFetch<TasteProfile>(`${BASE}/profile`);
}

// === Metrik Detayı ===

export interface MetricDetailResponse {
  metric: TasteProfile["metrics"][string];
  explanation: MetricExplanation | null;
}

/** Metrik detayı + kanıt açıklamasını çek */
export async function fetchMetricDetail(
  metricId: string
): Promise<MetricDetailResponse> {
  return apiFetch<MetricDetailResponse>(`${BASE}/metric/${encodeURIComponent(metricId)}`);
}

// === Kanıt ===

export interface EvidenceResponse {
  positiveContentIds: string[];
  negativeContentIds: string[];
  posMass: number;
  negMass: number;
  uncertainMass: number;
}

/** Metrik için kanıt listesini çek */
export async function fetchEvidence(
  metricId: string
): Promise<EvidenceResponse> {
  return apiFetch<EvidenceResponse>(
    `${BASE}/evidence/${encodeURIComponent(metricId)}`
  );
}

// === Manifest ===

/** Taste manifest'ini çek */
export async function fetchTasteManifest(): Promise<TasteManifest> {
  return apiFetch<TasteManifest>(`${BASE}/manifest`);
}

// === Manuel Kontrol (TP-028) ===

export interface OverrideRequest {
  metricId: string;
  value: number;           // -100...+100
  mode: "replace" | "boost" | "suppress";
}

export interface OverrideResponse {
  success: boolean;
  metric: TasteProfile["metrics"][string];
}

/** Manuel metrik kontrolü uygula */
export async function postManualOverride(
  req: OverrideRequest
): Promise<OverrideResponse> {
  return apiFetch<OverrideResponse>(`${BASE}/override`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
}

/** Manuel metrik kontrolünü geri al */
export async function deleteManualOverride(
  metricId: string
): Promise<OverrideResponse> {
  return apiFetch<OverrideResponse>(
    `${BASE}/override/${encodeURIComponent(metricId)}`,
    { method: "DELETE" }
  );
}

// === Olay ===

export interface PostEventResponse {
  success: boolean;
  eventId: string;
}

/** Yeni taste olayı gönder */
export async function postTasteEvent(
  event: TasteEvent
): Promise<PostEventResponse> {
  return apiFetch<PostEventResponse>(`${BASE}/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
}

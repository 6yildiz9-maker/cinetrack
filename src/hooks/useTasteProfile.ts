// ===========================================================================
// CineTrack Taste Engine — useTasteProfile Hook (v1.0)
// Profil verisi + loading/error state yönetimi
// ===========================================================================

import { useState, useEffect, useCallback } from "react";
import type { TasteProfile } from "../core/taste/types";
import { fetchTasteProfile, postManualOverride, deleteManualOverride } from "../services/taste-api";
import type { OverrideRequest } from "../services/taste-api";

export type TasteProfileStatus = "idle" | "loading" | "success" | "error";

export interface UseTasteProfileResult {
  profile: TasteProfile | null;
  status: TasteProfileStatus;
  error: string | null;
  /** Profili sunucudan yeniden yükle */
  reload: () => Promise<void>;
  /** Manuel metrik kontrolü uygula (TP-028) */
  applyOverride: (req: OverrideRequest) => Promise<void>;
  /** Manuel kontrolü geri al */
  removeOverride: (metricId: string) => Promise<void>;
}

/**
 * Taste profilini yükleyen ve manuel kontrol işlemlerini yöneten React hook.
 *
 * Kullanım:
 *   const { profile, status, error, reload, applyOverride, removeOverride } = useTasteProfile();
 */
export function useTasteProfile(): UseTasteProfileResult {
  const [profile, setProfile] = useState<TasteProfile | null>(null);
  const [status, setStatus] = useState<TasteProfileStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const data = await fetchTasteProfile();
      setProfile(data);
      setStatus("success");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Profil yüklenemedi";
      setError(msg);
      setStatus("error");
    }
  }, []);

  // İlk yükleme
  useEffect(() => {
    void reload();
  }, [reload]);

  /** Manuel kontrol uygula */
  const applyOverride = useCallback(
    async (req: OverrideRequest) => {
      try {
        await postManualOverride(req);
        // Profili yenile (sunucudan güncel veriyi al)
        await reload();
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "Manuel kontrol uygulanamadı";
        setError(msg);
      }
    },
    [reload]
  );

  /** Manuel kontrolü geri al */
  const removeOverride = useCallback(
    async (metricId: string) => {
      try {
        await deleteManualOverride(metricId);
        // Profili yenile
        await reload();
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "Override kaldırılamadı";
        setError(msg);
      }
    },
    [reload]
  );

  return {
    profile,
    status,
    error,
    reload,
    applyOverride,
    removeOverride,
  };
}
